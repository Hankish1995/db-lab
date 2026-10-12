---
slug: postgres-explain
title: 'EXPLAIN: query plan को detective की तरह पढ़ना'
module: Performance
summary: 'EXPLAIN और EXPLAIN ANALYZE का output कैसे पढ़ें, हर scan, join और sort node का क्या मतलब है, planner उसे क्यों चुनता है, और slow query से fix तक कैसे पहुँचें।'
recap: >-
  EXPLAIN वो plan दिखाता है जो planner चलाने वाला है; EXPLAIN ANALYZE query को सच में चलाकर दिखाता है कि
  असल में क्या हुआ, इसलिए writes को BEGIN और ROLLBACK में लपेटें। Tree को सबसे अंदर वाले node से बाहर की ओर पढ़ें,
  estimated rows की तुलना actual rows से करें, per-loop numbers को loops से गुणा करें, और BUFFERS से देखें कि कितना data
  छुआ गया। Seq, Index, Index Only और Bitmap scans के साथ Nested Loop, Hash और Merge joins ज़्यादातर plans कवर कर लेते हैं।
  Estimate में बड़ी गलती का मतलब आमतौर पर stale statistics होता है, तो ANALYZE चलाएँ; सबसे बुरी queries पहले
  pg_stat_statements से ढूँढें।
---

## 1. कहानी

आपके store का checkout page रातों-रात slow हो गया। Code किसी ने नहीं बदला। अब आप detective हैं।

Detective के पास दो तरह के सबूत होते हैं:

- **Suspect का plan**, जो crime से पहले लिखा गया: "मैं पिछले दरवाज़े से घुसूँगा, फिर सीढ़ियाँ लूँगा"। यानी किसी ने क्या करने का *इरादा* किया था।
- **CCTV footage**: *असल में* क्या हुआ, मिनट-दर-मिनट, उस पल समेत जब plan गड़बड़ा गया।

PostgreSQL आपको दोनों देता है।

| Detective | PostgreSQL |
|---|---|
| लिखा हुआ plan | **`EXPLAIN`**: **planner** ने जो plan चुना, **estimates** के साथ |
| CCTV footage | **`EXPLAIN ANALYZE`**: query **सच में चलती है**, असली times और row counts के साथ |
| हर दरवाज़े पर fingerprints | **`BUFFERS`**: हर step ने कितने 8 kB pages छुए |
| "उसने कहा 1 visitor, CCTV में 199,000 दिखे" | **Estimated vs actual rows**: सबसे classic सुराग |
| इस साल के सारे crimes की case file | **`pg_stat_statements`**: कुल मिलाकर कौन सी queries सबसे महँगी हैं |

> **याद रखें:** `EXPLAIN` = PostgreSQL क्या करने का *plan* बना रहा है। `EXPLAIN ANALYZE` = उसने *असल में क्या किया*। ज़्यादातर slow-query की गुत्थियाँ इन दोनों की तुलना करके ही सुलझती हैं।

## 2. Plan होता ही क्यों है

SQL **declarative** है: आप बताते हैं कि *क्या* चाहिए, ये नहीं कि *कैसे* लाना है। दो joins वाली एक query के लिए सैकड़ों strategies हो सकती हैं: पहले कौन सी table, index या full scan, कौन सा join algorithm।

**Planner** (एक cost-based optimizer) इनमें से कई की cost का अंदाज़ा लगाता है और सबसे सस्ता चुनता है। उसके estimates आपके data के **statistics** से आते हैं (row counts, common values, values का distribution), जिन्हें `ANALYZE` इकट्ठा करता है।

जब statistics सही होते हैं, plan आमतौर पर बढ़िया होता है। जब वो गलत हों, या कोई index missing हो, तो bad plan मिलता है, और उसे देखने का तरीका `EXPLAIN` है। Index असल में क्या है, इसकी basics के लिए देखें [Indexes कैसे काम करते हैं](/lessons/how-indexes-work) और [PostgreSQL indexes](/lessons/postgres-indexes)।

## 3. EXPLAIN के तीन रूप

```sql
-- 1. Plan only. Does NOT run the query. Instant and safe.
EXPLAIN SELECT * FROM orders WHERE customer_id = 4242;

-- 2. Runs the query, shows real times and rows.
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 4242;

-- 3. Runs it and also shows pages touched (the one you want most of the time).
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE customer_id = 4242;
```

⚠️ **`EXPLAIN ANALYZE` statement को सच में execute करता है।** `EXPLAIN ANALYZE DELETE` सच में rows delete कर देगा। Writes के लिए उसे एक ऐसे transaction में लपेटें जिसे आप फेंक देंगे:

```sql
BEGIN;
EXPLAIN ANALYZE UPDATE products SET price = price * 1.1 WHERE category = 'toys';
ROLLBACK;  -- the update is undone, the plan output stays on your screen
```

कुछ और काम के options: `FORMAT JSON` (visualizer tools के लिए), `VERBOSE` (output columns), `SETTINGS` (non-default planner settings)। नए versions (PostgreSQL 18+) में `ANALYZE` अपने-आप buffer counts दिखाता है; पुराने versions में `BUFFERS` अलग से माँगना पड़ता है।

## 4. Plan की बनावट

नीचे के सारे उदाहरण एक scratch database का असली output हैं, जिसमें 50,000 customers, 500,000 orders और 1,000,000 order items हैं। ये रहा "customer 4242 के सबसे नए 5 orders":

```text
Limit  (cost=0.42..22.33 rows=5 width=23)
       (actual time=0.058..0.077 rows=5 loops=1)
  Buffers: shared hit=10 read=1
  ->  Index Scan using orders_customer_created_idx on orders
        (cost=0.42..48.61 rows=11 width=23)
        (actual time=0.055..0.074 rows=5 loops=1)
        Index Cond: (customer_id = 4242)
        Buffers: shared hit=10 read=1
Execution Time: 0.118 ms
```

(उदाहरण output, चौड़ाई के लिए lines तोड़ी गई हैं।)

| Field | मतलब |
|---|---|
| `cost=0.42..22.33` | **Startup cost .. total cost**, planner की arbitrary units में (एक sequential page read = 1.0)। Startup = पहली row निकलने से पहले की cost। Parent की cost में उसके children की cost **शामिल** होती है |
| `rows=5` | ये node **per loop** कितनी rows लौटाएगा, उसका **estimate** |
| `width=23` | Bytes में row का estimated औसत size |
| `actual time=0.055..0.074` | **पहली** row तक .. **आख़िरी** row तक असली ms, **per loop** |
| `rows=5 loops=1` | Per loop असली rows, और node कितनी बार चला |
| `Buffers: shared hit=10 read=1` | PostgreSQL के cache में मिले pages (**hit**) vs OS से लाए गए (**read**, जो फिर भी OS cache से हो सकते हैं) |

### पढ़ने का क्रम: अंदर से बाहर

Plan एक **tree** है। हर `->` एक child है जो अपने parent को rows देता है। Execution सबसे **गहरे, सबसे ज़्यादा indented** nodes से शुरू होकर **ऊपर** की ओर बहता है।

```text
 Nested Loop                      ← 3. combines the two streams
 ├─► Index Scan on customers      ← 1. outer input (runs once)
 └─► Bitmap Heap Scan on orders   ← 2. inner input (per outer row)
     └─► Bitmap Index Scan        ← 2a. feeds the heap scan
```

### Loops वाला जाल

`actual time` और `rows` **per loop औसत** होते हैं। जब `loops=20` हो, तो गुणा करें:

```text
->  Bitmap Heap Scan on orders o
      (actual time=0.017..0.113 rows=10 loops=20)
```

इस node ने लगभग 10 × 20 = **200 rows** लौटाईं और लगभग 0.113 × 20 ≈ **2.3 ms** लगाए, 0.1 ms नहीं। Parallel plans में भी यही है: `loops=3` का मतलब leader plus 2 workers।

> **याद रखें:** plan को नीचे से ऊपर पढ़ें, हर node पर estimated vs actual `rows` की तुलना करें, और हमेशा `loops` से गुणा करें।

## 5. Scan nodes: table से rows कैसे लाई जाती हैं

| Node | क्या करता है | कब चुना जाता है |
|---|---|---|
| **Seq Scan** | Table का हर page पढ़ता है | कोई काम का index नहीं, या rows का बड़ा हिस्सा match करता है |
| **Index Scan** | Index पर चलता है, फिर हर matching row table (**heap**) से लाता है | कम rows match करती हैं, या rows index order में चाहिए (`ORDER BY ... LIMIT`) |
| **Index Only Scan** | सिर्फ़ index से जवाब देता है | सारे ज़रूरी columns index में हैं **और** pages all-visible marked हैं |
| **Bitmap Index Scan → Bitmap Heap Scan** | Matching row locations को एक bitmap में इकट्ठा करता है, फिर pages को physical order में पढ़ता है | Rows की "मध्यम" संख्या, जो table में बिखरी हुई हो |

### Bitmap scan क्यों है

Index Scan table में इधर-उधर कूदता है: row 1 page 900 पर, row 2 page 12 पर, row 3 फिर page 900 पर। हज़ारों matches हों तो ये हज़ारों random page reads बन जाते हैं।

Bitmap scan पहले index पर चलकर mark करता है कि **किन pages** में matches हैं, फिर उन pages को **एक-एक बार, क्रम से** पढ़ता है। ये `BitmapAnd` / `BitmapOr` से दो indexes को combine भी कर सकता है। `Recheck Cond` वाली line इसलिए होती है क्योंकि अगर bitmap `work_mem` से बड़ा हो जाए तो वो **lossy** हो जाता है (rows नहीं, pages याद रखता है), इसलिए rows दोबारा check की जाती हैं।

Query का shape वही, selectivity अलग। पिछले 7 दिनों के orders (लगभग 1% rows):

```text
Bitmap Heap Scan on orders  (rows=4778) (actual rows=4813 loops=1)
  Recheck Cond: (created_at >= (now() - '7 days'::interval))
  Heap Blocks: exact=3055
  ->  Bitmap Index Scan on orders_created_idx  (actual rows=4813)
```

पिछले 600 दिनों के orders (लगभग 82% rows), वही index उपलब्ध होने पर भी:

```text
Parallel Seq Scan on orders  (actual rows=137018 loops=3)
  Filter: (created_at >= (now() - '600 days'::interval))
  Rows Removed by Filter: 29649
```

ये planner की बेवकूफ़ी नहीं है। Table का 82% हिस्सा index से पढ़ना, सीधे table पढ़ने से धीमा है।

### Index Only Scan और Heap Fetches

```text
Index Only Scan using orders_customer_created_idx on orders
  (actual rows=997 loops=1)
  Index Cond: ((customer_id >= 100) AND (customer_id <= 200))
  Heap Fetches: 0
```

`Heap Fetches: 0` सपना है। एक ऐसी table पर जिसे अभी vacuum नहीं किया गया था, merge join के index-only scan ने `Heap Fetches: 999900` दिखाया: हर row को फिर भी table में check करना पड़ा, क्योंकि **visibility map** ने उन pages को अभी all-visible mark नहीं किया था। ये map vacuum maintain करता है; देखें [MVCC और VACUUM](/lessons/postgres-mvcc-and-vacuum)।

> **याद रखें:** Seq Scan अपने-आप में बुरा नहीं है। वो तब बुरा है जब लगभग सब कुछ filter करके फेंक दे (`Rows Removed by Filter` बहुत बड़ा और `rows` बहुत छोटा)।

## 6. Join algorithms

| Algorithm | कैसे काम करता है | कब सबसे अच्छा | Join condition |
|---|---|---|---|
| **Nested Loop** | हर outer row के लिए matching inner rows ढूँढता है | छोटा outer input + **indexed** inner side | कोई भी (`<`, `BETWEEN` वग़ैरह के लिए अकेला यही) |
| **Hash Join** | छोटे input से hash table बनाता है, बड़े input से उसे probe करता है | बड़े, unsorted inputs | सिर्फ़ equality |
| **Merge Join** | **Join key पर sorted** दो inputs पर साथ-साथ चलता है | दोनों inputs पहले से sorted (indexes) या बड़े | Equality (mergeable) |

Nested Loop: 20 customers, उनके orders index से 20 बार ढूँढे गए।

```text
Nested Loop  (actual time=0.052..2.398 rows=204 loops=1)
  ->  Index Scan using customers_pkey on customers c  (rows=20 loops=1)
        Index Cond: ((id >= 1) AND (id <= 20))
  ->  Bitmap Heap Scan on orders o  (rows=10 loops=20)
        Recheck Cond: (c.id = customer_id)
```

Hash Join: सारे 500,000 orders पर हर country का revenue। `Hash` child **build** side है (customers, memory में 2.8 MB, 1 batch)।

```text
Hash Join  (actual rows=166667 loops=3)
  Hash Cond: (o.customer_id = c.id)
  ->  Parallel Seq Scan on orders o  (actual rows=166667 loops=3)
  ->  Hash  (actual rows=50000 loops=3)
        Buckets: 65536  Batches: 1  Memory Usage: 2856kB
        ->  Seq Scan on customers c  (actual rows=50000 loops=3)
```

अगर `Batches` 1 से ज़्यादा है, तो hash table memory (`work_mem` × `hash_mem_multiplier`) में नहीं समाई और disk पर spill हो गई।

Merge Join: हर order उसके items के साथ, `ORDER BY o.id`। दोनों primary-key indexes पहले से ही order id के हिसाब से sorted rows लौटाते हैं, इसलिए कोई sort नहीं चाहिए।

```text
Merge Join  (actual time=0.029..686.153 rows=999900 loops=1)
  Merge Cond: (o.id = oi.order_id)
  ->  Index Only Scan using orders_pkey on orders o
  ->  Index Only Scan using order_items_pkey on order_items oi
```

Join semantics के बारे में और जानने के लिए देखें [PostgreSQL joins](/lessons/postgres-joins)।

## 7. Sort, aggregate और limit

**Sort** `work_mem` (default 4 MB) तक memory इस्तेमाल करता है। उससे ज़्यादा हो तो temporary files में spill होता है:

```text
Sort  (actual time=866.682..1564.339 rows=500000 loops=1)
  Sort Key: total DESC
  Sort Method: external merge  Disk: 28376kB
  Buffers: shared hit=3538 read=1137, temp read=3547 written=3557
```

- `quicksort  Memory: …` = memory में समा गया।
- `external merge  Disk: …` = spill हुआ। `BUFFERS` में `temp read/written` इसकी पुष्टि करता है।
- `top-N heapsort` = एक `LIMIT` की वजह से PostgreSQL सिर्फ़ सबसे अच्छी N rows रखता है।

**Aggregates**: `Aggregate` (एक result, जैसे `count(*)`), `HashAggregate` (hash table में groups बनाता है; `Batches` पर नज़र रखें), `GroupAggregate` (पहले से sorted input को group करता है)। Parallel plans में `Partial` और `Finalize` steps दिखते हैं।

**Limit** जैसे ही ज़रूरत भर rows मिल जाएँ, अपने child से rows खींचना बंद कर देता है। इसीलिए matching index के साथ `ORDER BY created_at DESC LIMIT 5` इतना सस्ता है: Index Scan पहले से sorted rows देता है और 5 के बाद रुक जाता है।

## 8. सबसे बड़ा सुराग: estimated vs actual rows

Planner algorithms को **estimated** row counts के आधार पर चुनता है। अगर estimate 100× गलत है, तो चुना गया algorithm भी अक्सर गलत होता है।

असली case: एक `coupons` table को तब analyze किया गया था जब उसमें 1,000 unused coupons थे। फिर 199,000 used coupons bulk-load किए गए और autovacuum (demo के लिए इस table पर disabled) ने उसे दोबारा कभी analyze नहीं किया।

```sql
SELECT c.code, o.id FROM coupons c JOIN orders o ON o.id = c.id WHERE c.used;
```

पहले (stale statistics):

```text
Nested Loop  (cost=0.42..3145.77 rows=1) (actual rows=199000 loops=1)
  ->  Seq Scan on coupons c  (rows=1) (actual rows=199000 loops=1)
        Filter: used
  ->  Index Only Scan using orders_pkey on orders o
        (actual time=0.001..0.001 rows=1 loops=199000)
Execution Time: 284.403 ms
```

Planner ने **1** used coupon की उम्मीद की थी, इसलिए "हर coupon के लिए एक index lookup" perfect लगा। असल में उसने **199,000** lookups किए। `ANALYZE coupons;` के बाद:

```text
Merge Join  (rows=199087) (actual rows=199000 loops=1)
  Merge Cond: (c.id = o.id)
  ->  Index Scan using coupons_pkey on coupons c
  ->  Index Only Scan using orders_pkey on orders o
Execution Time: 77.415 ms
```

वही query, वही indexes, **3.7× तेज़**, सिर्फ़ fresh statistics से।

Bad estimates की वजहें और उनके fixes:

- Bulk loads के बाद **stale statistics** → `ANALYZE table;` (आमतौर पर autovacuum ये कर देता है, पर bulk loads उससे आगे निकल जाते हैं)।
- **Correlated columns** (`city = 'Pune' AND pincode = '411001'`) → planner selectivities को ऐसे गुणा करता है जैसे वो independent हों → `CREATE STATISTICS ... (dependencies) ON city, pincode FROM addresses;`
- बहुत सारी values वाले **skewed columns** → sample बढ़ाएँ: `ALTER TABLE orders ALTER COLUMN status SET STATISTICS 1000;` फिर `ANALYZE`।
- `WHERE` में **functions या JSON expressions** → कोई statistics ही नहीं, एक default अंदाज़ा इस्तेमाल होता है; expression index उन्हें statistics दे देता है।

> **याद रखें:** जब estimated और actual rows में order of magnitude का फ़र्क हो, तो PostgreSQL पर शक करने से पहले statistics पर शक करें।

## 9. तीन और case files (पहले → बाद में)

**Case 1: customer की order history।** `WHERE customer_id = 4242 ORDER BY created_at DESC`, कोई index नहीं:

```text
Gather Merge  (actual time=68.988..76.318 rows=10 loops=1)
  ->  Sort  (Sort Method: quicksort  Memory: 25kB)
        ->  Parallel Seq Scan on orders (actual rows=3 loops=3)
              Filter: (customer_id = 4242)
              Rows Removed by Filter: 166663
              Buffers: shared hit=259 read=4413
Execution Time: 76.794 ms
```

Fix: `CREATE INDEX ON orders (customer_id, created_at DESC);`। अब वही query इस पर Bitmap Index Scan इस्तेमाल करती है: **1.1 ms**, 4,786 की जगह 16 pages। Page को असल में जो `LIMIT 5` चाहिए वो जोड़ दें, तो ये section 4 वाला Index Scan बन जाता है: **0.118 ms**, 11 pages।

**Case 2: missing foreign key index।** PostgreSQL foreign key columns को अपने-आप index **नहीं** करता। "किन orders में product 42 है?":

```text
Before: Parallel Seq Scan on order_items
          Rows Removed by Filter: 333267   (loops=3)
          Execution Time: 81.132 ms
After:  Bitmap Index Scan on order_items_product_idx
          Execution Time: 2.129 ms
```

**Case 3: spill होने वाला sort।** सारे 500,000 orders को `total` से sort करने पर 28 MB disk पर spill हुआ (1,659 ms)। उस session के लिए `work_mem` को 64 MB करने से ये in-memory quicksort बन गया (1,006 ms)। पर असली fix था वही माँगना जो page को चाहिए: `LIMIT 10` ने इसे 26 kB वाला `top-N heapsort` बना दिया (**163 ms**), और `total` पर एक index इसे लगभग instant बना देगा।

⚠️ एक query ठीक करने के लिए `work_mem` को globally न बढ़ाएँ: ये **हर sort/hash node, हर connection** पर लागू होता है। इसे उस session या role के लिए set करें जो report चलाता है।

## 10. दोषी queries ढूँढना: pg_stat_statements

`EXPLAIN` **एक** query को explain करता है। पहले आपको पता होना चाहिए कि **कौन सी** query देखनी है। `pg_stat_statements` extension हर normalized query (`WHERE id = $1`) के statistics जोड़कर रखता है।

```sql
-- postgresql.conf: shared_preload_libraries = 'pg_stat_statements' (restart needed)
CREATE EXTENSION pg_stat_statements;

SELECT left(query, 60)                    AS query,
       calls,
       round(total_exec_time)             AS total_ms,
       round(mean_exec_time::numeric, 2)  AS mean_ms,
       rows,
       shared_blks_read
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

**`total_exec_time`** से sort करें, mean से नहीं: दिन में 5 million बार चलने वाली 2 ms की query, एक बार चलने वाली 3-second की report से ज़्यादा नुकसान करती है। इसके साथ `auto_explain` module जोड़ें, जो threshold से धीमी queries के plans log करता है, ताकि आप वो plan देख सकें जो production में production data के साथ चला।

> **याद रखें:** `pg_stat_statements` से **total** time के हिसाब से सबसे बुरी queries ढूँढें, फिर उन्हें एक-एक करके explain करें।

## 11. Slow-query checklist

| क्या दिखे | आमतौर पर मतलब | क्या आज़माएँ |
|---|---|---|
| बहुत बड़े `Rows Removed by Filter` वाला Seq Scan | Index missing है या इस्तेमाल नहीं हो सकता | `WHERE` (और `ORDER BY`) से match करता index जोड़ें |
| Estimated rows ≪ या ≫ actual | Stale या missing statistics | `ANALYZE`, extended statistics, ऊँचा statistics target |
| बहुत बड़े `loops` count वाला Nested Loop | Outer side का underestimate | Estimate ठीक करें; planner hash/merge पर switch कर लेगा |
| `external merge  Disk:` / `Batches: > 1` | इस query के लिए `work_mem` बहुत छोटा | पहले rows कम करें; फिर per session `work_mem` बढ़ाएँ |
| Index Only Scan पर `Heap Fetches` ज़्यादा | Visibility map up to date नहीं | Table को `VACUUM` करें; autovacuum check करें |
| `shared read` ज़्यादा, `hit` कम | Cold cache या RAM से बड़ा data | कम pages: पतला index, covering index, कम data |
| Column पर function: `WHERE lower(email) = …` | Plain index इस्तेमाल नहीं हो सकता | `lower(email)` पर expression index |
| `psql` में तेज़, app से धीमा | अलग parameters या generic plan | App की असली values के साथ `EXPLAIN` |

## 12. Gotchas

- **Production में writes पर `EXPLAIN ANALYZE` चलाना** बिना `BEGIN … ROLLBACK` के। ये सच में write करता है।
- **`cost` को milliseconds समझना।** ये एक ही query के plans की तुलना के लिए abstract unit है, समय नहीं।
- **`loops` को नज़रअंदाज़ करना।** 0.1 ms जैसा दिखने वाला node आपका पूरा runtime हो सकता है।
- **छोटे dev database पर testing।** 100 rows के साथ planner हर चीज़ के लिए Seq Scan चुनता है। Plans data size और statistics पर निर्भर करते हैं; realistic volume के साथ test करें।
- **एक ही बार मापना।** पहला run disk से पढ़ता है (`read=`), दूसरा cache से (`hit=`)। बराबर की चीज़ों की तुलना करें।
- **Timing overhead।** `EXPLAIN ANALYZE` हर node को मापता है, जिससे लाखों बार चलने वाले बहुत तेज़ nodes पर overhead जुड़ता है। अगर सिर्फ़ row counts चाहिए तो `(ANALYZE, TIMING OFF)` इस्तेमाल करें।
- **Plans को force करना।** `SET enable_seqscan = off` experiment के लिए ठीक है, production code के लिए कभी नहीं। इसकी जगह वजह (index, statistics, query) ठीक करें।

## 13. Confuse न हों: PostgreSQL vs MongoDB explain

MongoDB का `explain()` आप पहले से जानते हैं। Ideas लगभग एक-से-एक map होते हैं:

| PostgreSQL | MongoDB |
|---|---|
| `EXPLAIN` | `explain("queryPlanner")` |
| `EXPLAIN ANALYZE` | `explain("executionStats")` |
| Seq Scan | `COLLSCAN` |
| Index Scan | `IXSCAN` + `FETCH` |
| Index Only Scan | Covered query (`IXSCAN` बिना `FETCH` के) |
| `Rows Removed by Filter` | `totalDocsExamined` ≫ `nReturned` |
| Statistics + cost model | Candidate plans की आपस में race, winner cache होता है |

बड़ा फ़र्क: PostgreSQL **statistics से estimated cost** के आधार पर चुनता है, MongoDB candidate plans के **trial runs** से।

## 14. Trade-offs और सीमाएँ

- **EXPLAIN एक execution दिखाता है।** Production में parameter values बहुत सारी होती हैं; 50,000 orders वाले customer को 5 orders वाले से अलग plan चाहिए हो सकता है।
- **Prepared statements** कुछ executions के बाद **generic plan** पर switch कर सकते हैं, जो specific values को नज़रअंदाज़ करता है। अगर कोई parameterized query सिर्फ़ app से slow है, तो `plan_cache_mode` के साथ तुलना करें।
- **Read ठीक करने के लिए जोड़ा गया हर index writes को धीमा करता है** और disk लेता है। `pg_stat_statements` की top queries ठीक करें, हर दिखने वाली query नहीं।
- **कभी-कभी plan ठीक होता है और query गलत**: page पर 20 दिखाने के लिए 500,000 rows लाना product की समस्या है, planner की नहीं।
