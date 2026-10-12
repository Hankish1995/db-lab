---
slug: postgres-architecture
title: 'PostgreSQL architecture: आपकी query आने पर क्या होता है'
module: Basics
summary: 'PostgreSQL एक SQL string को rows में कैसे बदलता है: process-per-connection model, parse-rewrite-plan-execute pipeline, shared buffers, 8 KB heap pages, TOAST, और write-ahead log कैसे table pages को तुरंत लिखे बिना commits को durable बनाता है।'
recap: >-
  Postmaster हर connection को accept करता है और उसके लिए एक dedicated backend process शुरू करता है, इसीलिए connections
  महँगे होते हैं और apps को pooling चाहिए। हर query parse, rewrite, plan और execute होती है। Data 8 KB heap pages में
  रहता है, जो OS page cache के ऊपर shared buffers में cache होते हैं, और बड़ी values TOAST में भेज दी जाती हैं। Commit
  को सिर्फ़ write-ahead log flush करना होता है; dirty table pages बाद में background writer और checkpointer लिखते हैं,
  और crash के बाद PostgreSQL आख़िरी checkpoint से WAL को replay करता है।
---

## 1. कहानी

एक भीड़-भाड़ वाले restaurant की कल्पना कीजिए।

- एक **doorman** हर group का स्वागत करता है और उन्हें **उनका अपना waiter** देता है। वह waiter पूरी शाम सिर्फ़ उसी table को serve करता है।
- Waiter order लिखता है, उसे house rules से मिलाता है ("*combo* का मतलब burger + fries + drink"), और **head chef** को दे देता है, जो तय करता है कि इसे सबसे तेज़ी से कैसे पकाया जाए।
- Cooks सामान **stove के पास वाले counter** से उठाते हैं। जब कोई चीज़ counter पर नहीं होती, तभी वे पीछे **warehouse** तक जाते हैं।
- कोई भी dish kitchen से निकलने से पहले cashier उसे एक **ledger** में लिखता है। अगर बिजली चली जाए, तो ledger बिल्कुल सही बताता है कि क्या-क्या बिका।
- हर कुछ मिनट में एक manager आकर counter को warehouse के inventory से **reconcile** करता है।

| Restaurant | PostgreSQL |
|---|---|
| Doorman | **postmaster**: main server process |
| आपका अपना waiter | एक **backend process**, हर connection के लिए एक |
| Order पढ़ना, house rules लगाना | **Parser** और **rewriter** |
| Head chef का तय करना कि कैसे पकाना है | **Planner / optimizer** |
| Cooks | **Executor** |
| Stove के पास वाला counter | **Shared buffers** (pages का RAM cache) |
| Warehouse | Disk पर data files |
| Ledger | **Write-ahead log (WAL)** |
| समय-समय पर reconciliation | **Checkpoint** |

> **याद रखें:** एक connection = एक dedicated server process। Changes पहले log में जाते हैं और table files में बाद में।

## 2. इसे ऐसे क्यों बनाया गया है

PostgreSQL को एक साथ तीन चीज़ें देनी होती हैं:

1. **Durability:** एक बार `COMMIT` return हो गया, तो data crash या power loss में भी बचा रहता है।
2. **Speed:** ज़्यादातर reads memory से आने चाहिए, disk से नहीं।
3. **Concurrency:** सैकड़ों clients एक ही समय पर पढ़ और लिख रहे हों।

सीधा-सादा तरीक़ा, "हर commit पर बदले हुए table pages disk पर लिख दो", धीमा है। एक अकेला order `orders`, `order_items`, `products` और पाँच indexes के pages को छू सकता है, जो disk पर इधर-उधर बिखरे हैं। हर commit पर random writes throughput को ख़त्म कर देंगे।

PostgreSQL का जवाब: **change का एक छोटा-सा description एक sequential log में append करो, सिर्फ़ उसे flush करो, और असली pages आराम से background में लिखो।**

## 3. पूरी तस्वीर

```text
  Node.js app (pg pool)
          │ TCP :5432
          ▼
 ┌──────────────────────────────────────────────────────────┐
 │ postmaster: listens, starts one backend per connection   │
 └───────────────────────────┬──────────────────────────────┘
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
 ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
 │ backend conn 1 │  │ backend conn 2 │  │ backend conn 3 │
 │ parse→rewrite  │  │ private memory │  │ private memory │
 │ →plan→execute  │  │ (work_mem)     │  │ (work_mem)     │
 └───────┬────────┘  └───────┬────────┘  └───────┬────────┘
         └───────────────────┼───────────────────┘
                             ▼
 ┌──────────────────────────────────────────────────────────┐
 │ SHARED MEMORY                                            │
 │ ┌─────────────────────────────┐ ┌──────────────────────┐ │
 │ │ shared_buffers (8 KB pages) │ │ WAL buffers          │ │
 │ └──────────────┬──────────────┘ └──────────┬───────────┘ │
 └────────────────┼───────────────────────────┼─────────────┘
   bgwriter,      │                           │ walwriter,
   checkpointer   ▼                           ▼ COMMIT flush
 ┌─────────────────────────────┐ ┌──────────────────────────┐
 │ data files: tables, indexes │ │ WAL segments in pg_wal/  │
 │ base/<db oid>/<file>        │ │ 16 MB files, append-only │
 └─────────────────────────────┘ └──────────────────────────┘
          (both go through the OS page cache)
```

## 4. एक query का सफ़र

आपका "My orders" page यह चलाता है:

```sql
SELECT id, status, total
FROM orders
WHERE user_id = 42
ORDER BY created_at DESC;
```

1. **Connection.** **postmaster** TCP connection accept करता है और उसके लिए एक नया **backend process** शुरू करता है। वह backend client को authenticate करता है (`pg_hba.conf` rules और password या certificate से), और अब से यह client सिर्फ़ उसी process से बात करता है।
2. **Parser.** Syntax check करता है और text को एक **parse tree** में बदलता है। फिर names resolve करता है: क्या `orders` मौजूद है, `user_id` का type क्या है? `SELCT` जैसी typo या कोई अनजान column यहीं fail होता है।
3. **Rewriter.** **Rules** लगाता है। सबसे ज़रूरी वाला: **views** rewrite rules के रूप में implement होते हैं, इसलिए `SELECT * FROM active_orders` को view की underlying query से बदल दिया जाता है। Row-level security policies भी इसी stage पर जुड़ती हैं।
4. **Planner / optimizer.** Candidate plans बनाता है (seq scan या index scan? hash join या nested loop?) और table statistics की मदद से हर एक की **cost** का अंदाज़ा लगाता है। सबसे सस्ता plan चुनता है। यही `EXPLAIN` आपको दिखाता है (देखें [Reading EXPLAIN](/lessons/postgres-explain))।
5. **Executor.** Plan को nodes के एक tree की तरह चलाता है। हर node अपने children से rows खींचता है, page दर page, shared buffers के ज़रिए, और results client को stream करता है।

साबित कीजिए कि हर connection अपना अलग process है:

```sql
SELECT pg_backend_pid();   -- e.g. 22836, a real OS process id
```

दूसरा `psql` खोलिए, आपको अलग PID मिलेगा। पर्याप्त privileges हों तो `SELECT pid, backend_type FROM pg_stat_activity;` हर process की list देता है, section 8 वाले background processes समेत।

> **याद रखें:** parse (क्या यह valid है?) → rewrite (views को expand करो) → plan (सबसे सस्ता तरीक़ा?) → execute (कर दो)। Planning में ही तय होता है कि indexes चुने जाएँगे या ignore होंगे।

## 5. Process per connection, और connections महँगे क्यों हैं

ज़्यादातर databases हर connection के लिए **threads** इस्तेमाल करते हैं। PostgreSQL हर connection के लिए एक पूरा **OS process** इस्तेमाल करता है। इसके असली नतीजे हैं:

- **Connection शुरू करना धीमा है।** नया process, authentication, अक्सर TLS handshake, फिर catalog caches load करना। Milliseconds, microseconds नहीं।
- **हर connection memory लेता है।** हर backend के अपने caches और per-operation memory होती है। एक अकेली query **हर sort या hash node के लिए** `work_mem` (default 4 MB) ले सकती है, इसलिए एक complex query इसका कई गुना इस्तेमाल कर सकती है।
- **बहुत ज़्यादा active processes thrash करते हैं।** 16 CPU cores पर 500 backends अपना समय context-switching और locks के लिए आपसी खींचतान में बिताते हैं।
- इन्हीं कारणों से **`max_connections` की एक सीमा है** (default 100)।

MERN वाला जाल: हर Node.js instance एक pool बनाता है, `new Pool({ max: 20 })`। Load balancer के पीछे 10 pods चलाइए, ऊपर से serverless functions, और आप 100 के लिए configured server से 200+ connections माँग रहे हैं।

```text
 10 pods × pool max 20 = 200 connections  ──►  max_connections = 100
                                               FATAL: sorry, too many
                                               clients already
```

इसका इलाज है **connection pooling**: कुछ गिने-चुने असली database connections, जिन्हें कई clients share करते हैं, आमतौर पर सामने PgBouncer लगाकर। इस पर अलग lesson है: [Connection pooling](/lessons/postgres-connection-pooling)।

Processes का फ़ायदा: **isolation**। एक backend का bug दूसरे backend की private memory को गड़बड़ नहीं कर सकता। (अगर कोई backend बुरी तरह crash हो जाए, तब भी postmaster सारे backends reset करता है और crash recovery चलाता है, क्योंकि shared memory ख़राब हो सकती है।)

> **याद रखें:** PostgreSQL का एक connection एक पूरा OS process है। Connections कम रखिए और pool के ज़रिए उन्हें reuse कीजिए।

## 6. Memory: shared buffers और OS page cache

Table और index का data 8 KB के **pages** में पढ़ा जाता है। कोई page पढ़ने से पहले backend **shared buffers** check करता है, जो shared memory में एक cache है और सारे backends इसे इस्तेमाल करते हैं।

- **Hit:** page पहले से वहाँ है। कोई I/O नहीं।
- **Miss (read):** PostgreSQL operating system से page माँगता है। OS उसे अब भी RAM में मौजूद **अपने page cache** से दे सकता है, इसलिए हर "read" disk को नहीं छूता।

PostgreSQL जान-बूझकर **दोनों caches** पर भरोसा करता है (इसे अक्सर **double buffering** कहते हैं)। इसीलिए `shared_buffers` आमतौर पर RAM का लगभग 25% रखा जाता है, 80% नहीं: बाक़ी का बड़ा हिस्सा OS cache इस्तेमाल करता है। `effective_cache_size` कुछ allocate नहीं करता; यह बस planner को बताता है कि कितनी caching की उम्मीद रखे।

Hits और reads आप `EXPLAIN (ANALYZE, BUFFERS)` से देख सकते हैं। 500,000 rows वाली `orders` table पर एक ही lookup दो बार चलाने का output:

```text
-- first run: some pages had to come from the OS
Index Scan using orders_pkey on orders (actual time=0.510..0.511 rows=1 loops=1)
  Index Cond: (id = 300001)
  Buffers: shared hit=1 read=3

-- second run: everything from shared buffers
Index Scan using orders_pkey on orders (actual time=0.007..0.008 rows=1 loops=1)
  Index Cond: (id = 300001)
  Buffers: shared hit=4
```

चार pages: root से leaf तक के B-tree pages, और एक heap page। दूसरा run लगभग 60 गुना तेज़ था।

## 7. Storage: heap files, pages, tuples और TOAST

हर table एक **heap** है: 8 KB pages की एक file जिसमें rows किसी ख़ास order में नहीं होतीं। हर index एक अलग file है। Files data directory के अंदर रहती हैं, 1 GB segments में बँटी हुई:

```sql
SELECT pg_relation_filepath('orders');   -- base/24583/24722
```

Page के अंदर एक row को **tuple** कहते हैं। Page header के बाद छोटे-छोटे **line pointers** का एक array होता है; tuples page के आख़िर से पीछे की ओर भरे जाते हैं।

```text
 ┌───────────────────── 8 KB page ─────────────────────┐
 │ header │ lp1 │ lp2 │ lp3 │ ──► grows forward        │
 ├─────────────────────────────────────────────────────┤
 │                    free space                       │
 ├─────────────────────────────────────────────────────┤
 │ grows backward ◄── │ tuple 3 │ tuple 2 │ tuple 1    │
 └─────────────────────────────────────────────────────┘
   lp = line pointer. ctid (0,2) = page 0, pointer 2
```

हर tuple का एक physical address होता है, **ctid** `(page, item)`। Indexes ctids की ओर point करते हैं:

```sql
SELECT ctid, id, email FROM users ORDER BY id LIMIT 2;
--  ctid  | id |     email
-- (0,1)  |  1 | user1@shop.io
-- (0,2)  |  2 | user2@shop.io
```

हर tuple में कुछ hidden header fields (`xmin`, `xmax`) भी होते हैं जो दर्ज करते हैं कि किस transaction ने उसे बनाया और delete किया। `UPDATE` किसी row को उसी जगह overwrite नहीं करता; वह एक **new tuple version** लिखता है। यही **MVCC** है, जिसे [MVCC and VACUUM](/lessons/postgres-mvcc-and-vacuum) में cover किया गया है।

### TOAST: जब कोई value fit न हो

एक tuple कई pages में फैल नहीं सकता। तो 50 KB के product description या बड़े `jsonb` blob का क्या? **TOAST** (The Oversized-Attribute Storage Technique):

- जब कोई row लगभग **2 KB** से बड़ी होती है, PostgreSQL पहले बड़ी values को **compress** करने की कोशिश करता है।
- अगर फिर भी बहुत बड़ी है, तो वह उन्हें chunks में काटकर table की अलग **TOAST table** में **out of line** भेज देता है। Main tuple में बस एक छोटा pointer रहता है।
- एक अकेला field 1 GB तक रख सकता है।

मेरे scratch database में 1,000 products को 9.6 KB का description देने पर main heap 952 kB रहा और 10 MB TOAST table में चला गया। नतीजे:

- ✅ जो queries बड़ा column select नहीं करतीं, वे तेज़ रहती हैं: heap pages घने (dense) रहते हैं।
- ⚠️ बड़े text या `jsonb` columns वाली table पर `SELECT *` हर TOASTed value को fetch और decompress करने की क़ीमत चुकाता है। सिर्फ़ ज़रूरी columns select कीजिए।

> **याद रखें:** tables 8 KB pages के heaps हैं। Rows का एक physical address (ctid) होता है, और बड़ी values TOAST में out of line रहती हैं।

## 8. Write-ahead log और checkpoints

नियम नाम में ही है: **data से पहले log लिखो।**

जब checkout `UPDATE products SET stock = stock - 1 WHERE id = 7; COMMIT;` चलाता है, तब क्या होता है:

```text
 1. Load page of product 7 into shared buffers (if not there)
 2. Write the new tuple version in the buffer   → page is "dirty"
 3. Append a WAL record describing the change   → WAL buffers
 4. COMMIT: flush WAL up to the commit record   → fsync to disk
 5. Tell the client "COMMIT" ✅
    ... seconds or minutes later ...
 6. bgwriter / checkpointer write the dirty page to the data file
```

सिर्फ़ step 4 disk का इंतज़ार करता है, और वह एक file में **sequential append** है, जो सस्ता है। बिखरे हुए page writes बाद में background में होते हैं, और एक ही page के कई changes मिलकर एक write बन जाते हैं।

**अगर server step 5 और 6 के बीच crash हो जाए तो?** Data file में पुराना page है, लेकिन WAL में change मौजूद है। Restart पर PostgreSQL **crash recovery** चलाता है: वह आख़िरी checkpoint से शुरू करके WAL को **replay** करता है और हर change दोबारा करता है। Commit हुआ कुछ भी नहीं खोता।

**Checkpoint** वह पल है जब PostgreSQL guarantee देता है कि "इस point तक का हर dirty page disk पर है"। उसके बाद पुराना WAL crash recovery के लिए ज़रूरी नहीं रहता और recycle हो सकता है। Checkpoints हर `checkpoint_timeout` (default 5 minutes) पर होते हैं या तब जब `max_wal_size` (default 1 GB) जितना WAL जमा हो जाए, जो भी पहले हो, और उनके writes I/O spikes से बचने के लिए पूरे interval में फैला दिए जाते हैं।

| Checkpoints ज़्यादा बार | Checkpoints कम बार |
|---|---|
| तेज़ crash recovery (replay करने को कम WAL) | धीमी crash recovery |
| कुल I/O ज़्यादा | I/O कम, writes का ज़्यादा combining |
| WAL में ज़्यादा **full-page images** | कम WAL volume |

वह आख़िरी row: हर checkpoint के बाद किसी page का पहला change **पूरा page** WAL में लिखता है (`full_page_writes`), ताकि write के बीच crash से फटा (torn) page भी restore हो सके।

यही WAL stream **replication** और **point-in-time recovery** को चलाता है: replicas बस इसे replay करते हैं (देखें [Replication](/lessons/postgres-replication))।

एक knob जो पता होना चाहिए: `synchronous_commit = off` से `COMMIT` WAL flush से पहले return हो जाता है। Crash होने पर committed transactions का आख़िरी एक सेकंड से भी कम हिस्सा खो सकता है, लेकिन database **कभी corrupt नहीं होता**। Page-view counters के लिए ठीक है, payments के लिए नहीं।

> **याद रखें:** commit तब durable है जब उसका WAL flush हो गया। Table pages बाद में लिखे जाते हैं। Crash के बाद PostgreSQL आख़िरी checkpoint से WAL replay करता है।

## 9. Background processes

हर client के लिए एक backend के अलावा, चलते हुए server में helper processes भी होते हैं:

| Process | एक लाइन में काम |
|---|---|
| **checkpointer** | Checkpoints करता है: सारे dirty pages लिखता है और recovery के लिए एक safe start point mark करता है |
| **background writer** | Dirty pages को पहले से थोड़ा-थोड़ा disk पर लिखता रहता है ताकि backends को ख़ुद pages कम ही लिखने पड़ें |
| **WAL writer** | WAL buffers को नियमित रूप से disk पर flush करता है, ख़ासकर asynchronous commits के लिए |
| **autovacuum launcher** | Autovacuum workers शुरू करता है जो dead row versions साफ़ करते हैं और statistics refresh करते हैं |

Configuration के हिसाब से आपको और भी दिखेंगे: WAL senders (replication), archiver (WAL archiving), logical replication launcher।

## 10. Cluster → database → schema → table

```text
 Cluster (one server, one data directory, one port)
 ├── roles (users) ← shared by the whole cluster
 ├── database: shop
 │   ├── schema: public
 │   │   ├── table: users
 │   │   └── table: orders
 │   └── schema: analytics
 │       └── table: daily_revenue
 └── database: shop_test
```

- PostgreSQL की भाषा में **cluster** एक चलता हुआ server instance है, machines का group नहीं।
- **एक connection एक database से बँधा होता है।** आप एक query में `shop.orders` को `shop_test.orders` से join नहीं कर सकते (`postgres_fdw` जैसे extensions के बिना)।
- **Schemas** एक database के अंदर namespaces हैं। Cross-schema queries आम बात हैं: `SELECT * FROM analytics.daily_revenue`।
- बिना qualifier वाले names `search_path` (default `"$user", public`) के ज़रिए resolve होते हैं।
- PostgreSQL 15 से, ordinary users default रूप से `public` schema में objects नहीं बना सकते।

## 11. आम ग़लतियाँ और gotchas

- **हर request पर नया connection खोलना।** हर HTTP request पर process startup latency बढ़ाता है और `max_connections` ख़त्म कर सकता है। Pool इस्तेमाल कीजिए।
- **`shared_buffers` को RAM का ज़्यादातर हिस्सा दे देना।** इससे OS cache और per-backend memory भूखे रह जाते हैं। लगभग 25% से शुरू कीजिए।
- **यह सोचना कि `COMMIT` table लिखता है।** वह WAL लिखता है। अगर कोई पूछे "commit तेज़ क्यों है?", तो यही जवाब है।
- **Speed के लिए `fsync` बंद करना।** `synchronous_commit = off` के उलट, यह crash पर database को **corrupt** कर सकता है। Production में कभी नहीं।
- **Checkpoint warnings को ignore करना।** Logs में "Checkpoints are occurring too frequently" का मतलब है कि `max_wal_size` आपके write load के लिए बहुत छोटा है।
- **Wide tables पर `SELECT *`।** यह TOASTed columns को बेवजह साथ घसीट लाता है।

## 12. इन्हें आपस में confuse मत कीजिए

| | PostgreSQL | MongoDB (WiredTiger) |
|---|---|---|
| हर connection पर | एक OS **process** | एक **thread** (सस्ता) |
| Main data cache | `shared_buffers` + OS page cache | WiredTiger cache + OS page cache |
| Durability log | **WAL**, commit पर flush होता है | **Journal**, एक write-ahead log |
| Checkpoints | हर 5 min या `max_wal_size` पर | लगभग हर 60 seconds |
| पुराने row versions | Table में ही रहते हैं, VACUUM साफ़ करता है | Storage engine रखता है, कोई VACUUM नहीं |

| जोड़ी | अंतर |
|---|---|
| WAL vs data files | WAL = changes का sequential journal; data files = असली pages |
| Commit vs checkpoint | Commit **WAL** flush करता है; checkpoint **dirty pages** flush करता है |
| shared_buffers vs work_mem | सबके लिए shared page cache vs हर sort/hash के लिए private memory |

## 13. इस design के trade-offs

- **Process per connection:** मज़बूत और simple, लेकिन connections महँगे हैं। Scale पर pooling ज़रूरी है।
- **Double buffering:** simple और portable, लेकिन एक ही page RAM में दो बार बैठ सकता है।
- **WAL + lazy page writes:** तेज़, durable commits, लेकिन क़ीमत है write amplification (WAL और pages, ऊपर से full-page images) और crash के बाद recovery time।
- **हर update पर new tuple version:** readers कभी writers को block नहीं करते, लेकिन dead tuples जमा होते जाते हैं और उन्हें VACUUM चाहिए।

> **याद रखें:** जब interviewer पूछे "PostgreSQL durability की guarantee कैसे देता है?", तो जवाब दीजिए: commit पर WAL flush होता है, pages बाद में लिखे जाते हैं, और crash recovery आख़िरी checkpoint से WAL replay करती है।
