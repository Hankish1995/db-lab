---
slug: postgres-indexes
title: 'PostgreSQL indexes: हर query के लिए सही tool चुनना'
module: Performance
summary: 'PostgreSQL का अपना index toolbox (B-tree, multicolumn, partial, expression, covering, GIN, GiST, BRIN और hash), live tables पर indexes सुरक्षित तरीक़े से कैसे बनाएँ, और unused व bloated indexes कैसे ढूँढें, असली before/after EXPLAIN output के साथ।'
recap: >-
  B-tree default है और equality, ranges, sorting और prefix LIKE (C collation या text_pattern_ops के साथ) संभालता है।
  Multicolumn indexes में equality columns पहले रखें। Partial indexes सिर्फ़ उन rows को cover करते हैं जिन्हें आप query
  करते हैं, expression indexes lower(email) जैसे functions से match करते हैं, और INCLUDE index-only scans संभव बनाता है
  जो visibility map पर निर्भर करते हैं। jsonb, arrays और full-text के लिए GIN, ranges, geometry और exclusion के लिए GiST,
  और बहुत बड़ी append-only, समय के क्रम वाली tables के लिए BRIN इस्तेमाल करें। Transaction के बाहर CREATE INDEX
  CONCURRENTLY से बनाएँ, बचे हुए INVALID indexes check करें, जिन indexes को pg_stat_user_indexes कभी इस्तेमाल होता नहीं
  दिखाता उन्हें drop करें, और bloat को REINDEX CONCURRENTLY से ठीक करें।
---

## 1. कहानी

एक बड़े hardware store में चीज़ें ढूँढने के एक से ज़्यादा तरीक़े हैं:

- हर item का एक **alphabetical catalogue**: "hammer ढूँढो" या "H से K तक सब कुछ" के लिए बढ़िया। (**B-tree**)
- एक **"सिर्फ़ clearance" leaflet** जिसमें sale वाले बस 40 items हैं। छोटा-सा, और अगर आप सिर्फ़ उन्हीं के बारे में पूछते हैं तो एकदम सही। (**Partial index**)
- एक **tag board**: "waterproof" के नीचे उस tag वाले सारे items pin किए हुए हैं। (**GIN**, एक inverted index)
- **Aisle signs** जिन पर लिखा है "Aisle 7: Jan–Mar में आए items"। आपको exact shelf नहीं पता, लेकिन यह पता है कि कौन-से aisles छोड़ने हैं। (**BRIN**)
- Zones वाला एक **floor map** जिसमें zones overlap कर सकते हैं, "entrance से 10 metres के अंदर क्या है?" जैसे सवालों के लिए। (**GiST**)

हर एक कुछ सवालों का शानदार जवाब देता है और कुछ का बिल्कुल नहीं। PostgreSQL आपको ये सब देता है; हुनर है index को query से match करना।

Fundamentals (B-tree क्या है, selectivity, leftmost-prefix rule, indexes की write cost) [How indexes work](/lessons/how-indexes-work) में हैं। यह lesson PostgreSQL-specific toolbox के बारे में है।

> **याद रखें:** कोई "best index" नहीं होता, सिर्फ़ **किसी ख़ास query के लिए** best index होता है। Query से शुरू कीजिए, फिर type, columns और options चुनिए।

## 2. Test setup

नीचे के सारे plans एक scratch PostgreSQL 17 database का असली output हैं: 500,000 rows वाली `orders`, 50,000 वाली `users`, 5,000 वाली `products`, और 3,000,000 rows वाली एक append-only `page_views` table। Width के लिए plans को छोटा किया गया है।

## 3. B-tree: default, before/after के साथ

बिना `USING` के `CREATE INDEX` एक **B-tree** बनाता है। यह indexed columns पर `=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, `IN`, `IS NULL` और `ORDER BY` support करता है।

"My orders" page:

```sql
SELECT id, status, total, created_at
FROM orders
WHERE user_id = 42
ORDER BY created_at DESC;
```

**Before** (`user_id` पर कोई index नहीं):

```text
Gather Merge (actual time=62.178..69.210 rows=14 loops=1)
  ->  Sort  Sort Key: created_at DESC
        ->  Parallel Seq Scan on orders (rows=5 loops=3)
              Filter: (user_id = 42)
              Rows Removed by Filter: 166662
              Buffers: shared hit=5362 read=2482
Execution Time: 69.284 ms
```

Leader process और दो parallel workers ने 14 rows ढूँढने के लिए सारे ~7,800 pages पढ़े।

**After** `CREATE INDEX orders_user_id_idx ON orders (user_id);`:

```text
Sort  Sort Key: created_at DESC
  ->  Bitmap Heap Scan on orders (rows=14 loops=1)
        Recheck Cond: (user_id = 42)
        ->  Bitmap Index Scan on orders_user_id_idx
              Index Cond: (user_id = 42)
Buffers: shared hit=17 read=3
Execution Time: 0.143 ms
```

लगभग **480× तेज़**, 7,800 की जगह 20 pages। फिर भी एक `Sort` node बचा है।

## 4. Multicolumn indexes: column order मायने रखता है

इसे ऐसे index से बदलिए जो filter **और** sort दोनों से match करे:

```sql
CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC);
```

```text
Limit (actual time=0.047..0.058 rows=10 loops=1)
  ->  Index Scan using orders_user_created_idx on orders
        Index Cond: (user_id = 42)
Execution Time: 0.080 ms
```

कोई `Sort` node नहीं: index पहले से हर user के orders को `created_at DESC` order में रखता है, इसलिए PostgreSQL पहली 10 entries पढ़कर रुक जाता है।

नियम ([How indexes work](/lessons/how-indexes-work) से):

- **पहले equality columns, फिर range या sort columns।** `(user_id, created_at)` "user 42, सबसे नए पहले" और "user 42, पिछले 30 दिन" दोनों के काम आता है।
- **Leftmost prefix।** यही index अकेले `WHERE created_at >= '2025-01-01'` की मदद नहीं करता। मेरा test parallel seq scan पर चला गया।
- **Direction** सिर्फ़ `ORDER BY a ASC, b DESC` जैसे mixed sorts में मायने रखती है। B-tree को उल्टा भी पढ़ा जा सकता है, इसलिए `(user_id, created_at)` एक user के लिए `ORDER BY created_at DESC` भी serve करता है।
- `(user_id, created_at)` पर index होने से अलग `(user_id)` index बेकार हो जाता है।

## 5. Partial indexes: सिर्फ़ उन rows को index कीजिए जिनके बारे में पूछते हैं

Warehouse dashboard पुराने **pending** orders माँगता है। सिर्फ़ 3% orders pending हैं, और इस query को सिर्फ़ इसी status से मतलब है।

```sql
CREATE INDEX orders_pending_created_idx
  ON orders (created_at)
  WHERE status = 'pending';
```

```text
-- before: Parallel Seq Scan, Rows Removed by Filter: 161638 (x3)
--         Execution Time: 57.659 ms
-- after:
Limit (actual time=0.049..0.105 rows=50 loops=1)
  ->  Index Scan using orders_pending_created_idx on orders
        Index Cond: (created_at < (now() - '1 day'::interval))
Execution Time: 0.121 ms
```

Size की तुलना, वही column, वही table:

| Index | Size |
|---|---|
| सारी rows पर `(created_at)` | 11 MB |
| `(created_at) WHERE status = 'pending'` | 352 kB |

छोटा, तेज़, और writes पर सस्ता: जो rows `WHERE` से match नहीं करतीं वे इसमें maintain नहीं होतीं (जब वे delivered के रूप में insert होती हैं, तो कुछ नहीं जुड़ता)। शर्त: planner इसे तभी इस्तेमाल करता है जब query का `WHERE` index predicate को **imply** करता हो। `WHERE status = 'paid'` इसे इस्तेमाल नहीं कर सकता।

**Partial unique** नियमों के लिए भी बढ़िया: "हर user का एक active cart" = `CREATE UNIQUE INDEX ON carts (user_id) WHERE status = 'active'`।

## 6. Expression indexes

Login emails को case-insensitive तरीक़े से ढूँढता है:

```sql
SELECT id FROM users WHERE lower(email) = 'user42@shop.io';
-- Seq Scan on users  Filter: (lower(email) = ...)
```

`email` पर index `email` से sorted है, `lower(email)` से नहीं। ख़ुद expression को index कीजिए:

```sql
CREATE INDEX users_lower_email_idx ON users (lower(email));
-- Index Scan using users_lower_email_idx on users
--   Index Cond: (lower(email) = 'user42@shop.io'::text)
```

Query को **बिल्कुल** वही expression इस्तेमाल करना होगा। Case-insensitive uniqueness enforce करने के लिए इसे `UNIQUE` बनाइए। Expression indexes हर write पर CPU लेते हैं (function हर row के लिए चलता है) और expression पर statistics पाने के लिए `ANALYZE` चाहिए।

### Prefix LIKE और collations

`WHERE sku LIKE 'SKU-42%'` एक B-tree को range की तरह इस्तेमाल कर सकता है (`>= 'SKU-42' AND < 'SKU-43'`), **लेकिन सिर्फ़ तब जब column का collation `C` हो**। Linguistic collation (जैसे `en-US`) में sort order सादा byte order नहीं होता, इसलिए normal index इस्तेमाल नहीं हो सकता। ICU `en-US` collation वाले column पर test किया:

```text
-- plain index:            Seq Scan  Filter: (sku ~~ 'SKU-42%'::text)
-- (sku text_pattern_ops): Bitmap Index Scan on sku_test_pattern_idx
--   Index Cond: ((sku ~>=~ 'SKU-42') AND (sku ~<~ 'SKU-43'))
```

`text_pattern_ops` index `LIKE 'abc%'` support करता है, लेकिन column के collation के तहत सामान्य `<`/`ORDER BY` नहीं, इसलिए आपको दोनों की ज़रूरत पड़ सकती है। `LIKE '%abc'` (शुरुआत में wildcard) इनमें से कोई भी इस्तेमाल नहीं कर सकता; उसके लिए trigram index (GIN के साथ `pg_trgm`) या full-text search चाहिए।

> **याद रखें:** index को query के **shape** से match करना चाहिए: वही leading columns, वही expression, ऐसा predicate जिसे query imply करे, और compatible collation।

## 7. Covering indexes और index-only scans

अगर index में वे सारे columns हैं जो query को चाहिए, तो PostgreSQL table को छोड़ सकता है: एक **Index Only Scan**। `INCLUDE` leaf entries में payload columns जोड़ देता है, उन्हें search key का हिस्सा बनाए बिना:

```sql
CREATE INDEX orders_user_created_incl_idx
  ON orders (user_id, created_at DESC) INCLUDE (status, total);

SELECT created_at, status, total FROM orders
WHERE user_id = 42 ORDER BY created_at DESC;
```

PostgreSQL का twist है **MVCC**: index को नहीं पता कि कोई row version आपके transaction को दिखता है या नहीं। इसलिए PostgreSQL **visibility map** check करता है, जिसमें हर heap page के लिए एक bit होता है जिसका मतलब है "यहाँ की हर row सबको दिखती है"। अगर bit set है, तो वह table को छोड़ देता है; अगर नहीं, तो row heap से fetch करता है। `Heap Fetches` पर नज़र रखिए:

```text
-- right after VACUUM
Index Only Scan using orders_user_created_incl_idx  rows=14
  Heap Fetches: 0
-- after updating those users' orders
Index Only Scan using orders_user_created_incl_idx  rows=14
  Heap Fetches: 28
-- after VACUUM again
Index Only Scan using orders_user_created_incl_idx  rows=14
  Heap Fetches: 0
```

बार-बार update होने वाली tables पर index-only scans तब तक कमज़ोर पड़ते जाते हैं जब तक VACUUM bits फिर से set न कर दे (देखें [MVCC and VACUUM](/lessons/postgres-mvcc-and-vacuum))। `INCLUDE` को कुछ छोटे columns के लिए इस्तेमाल कीजिए; wide includes index को बड़ा कर देते हैं।

## 8. GIN, GiST, BRIN और hash

### GIN: "किन rows में यह element है?"

**GIN** (Generalized Inverted Index) हर **element** (jsonb key/value, array item, कोई शब्द) को उन rows से map करता है जिनमें वह है। इसे `jsonb`, arrays और full-text search के लिए इस्तेमाल कीजिए।

```sql
CREATE INDEX products_attributes_gin ON products USING gin (attributes jsonb_path_ops);
CREATE INDEX products_tags_gin       ON products USING gin (tags);

SELECT id FROM products WHERE attributes @> '{"color": "red", "brand": "Brand6"}';
```

```text
Bitmap Heap Scan on products (actual rows=50 loops=1)
  Recheck Cond: (attributes @> '{"brand": "Brand6", "color": "red"}'::jsonb)
  ->  Bitmap Index Scan on products_attributes_gin
Execution Time: 0.102 ms
```

- `@>` containment के लिए `jsonb_path_ops` छोटा और तेज़ है; default `jsonb_ops` key-exists operators (`?`, `?|`, `?&`) भी support करता है।
- GIN `attributes->>'color' = 'red'` में मदद **नहीं** करता। इसे `@>` के रूप में दोबारा लिखिए, या `(attributes->>'color')` पर B-tree expression index जोड़िए।
- GIN B-tree से धीमे update होता है; एक row कई index entries को छू सकती है।

### GiST: overlap, containment, distance

**GiST** ऐसे data के लिए एक framework है जो एक लाइन में sort नहीं होता: ranges, geometric shapes, PostGIS geography। यह "overlaps", "contains" और "nearest to" वाले सवालों का जवाब देता है, और **exclusion constraints** को चलाता है:

```sql
-- the EXCLUDE (product_id WITH =, active_during WITH &&) constraint on promotions
-- is a GiST index; queries use it too:
SELECT * FROM promotions WHERE active_during @> now();
-- Bitmap Index Scan on promotions_product_id_active_during_excl
```

### BRIN: बड़ी, ordered tables के लिए छोटे summaries

**BRIN** (Block Range INdex) table pages की हर range (default रूप से 128 pages) के लिए सिर्फ़ **min और max** value रखता है। यह तब काम करता है जब column की values table के physical order के हिसाब से चलती हों, जैसे append-only log में `viewed_at`।

`page_views` (3 million rows, 149 MB, समय के क्रम में insert हुई) पर एक दिन के views गिनना:

| Plan | Index size | Execution time |
|---|---|---|
| कोई index नहीं (parallel seq scan) | 0 | 151 ms |
| `viewed_at` पर **BRIN** | **24 kB** | 6.7 ms |
| `viewed_at` पर B-tree | 64 MB | 2.1 ms |

```text
Bitmap Heap Scan on page_views (actual rows=8640 loops=1)
  Rows Removed by Index Recheck: 31552
  Heap Blocks: lossy=256
  ->  Bitmap Index Scan on page_views_viewed_brin
        Buffers: shared hit=5
```

BRIN **lossy** है: यह search को candidate page ranges तक सीमित करता है, फिर rows को recheck करता है। B-tree हर query पर तेज़ है लेकिन लगभग 2,700× बड़ा है। और जब order physical न हो तो BRIN fail हो जाता है: `orders.created_at` पर, जिसकी rows एक bulk update से उलट-पुलट हो चुकी थीं, वही BRIN index फिर भी 3,876 pages पढ़ गया और 448,631 rows हटाईं, यानी scan से कोई बेहतर नहीं। `pg_stats` में `correlation` check कीजिए (1 या -1 के क़रीब अच्छा है)।

### Hash: सिर्फ़ equality

**Hash index** सिर्फ़ `=` support करता है। यह crash-safe और replicated है (PostgreSQL 10 से), लेकिन यह unique नहीं हो सकता, कई columns cover नहीं कर सकता, और ranges या sorting नहीं कर सकता। `users.public_id` (uuid) पर इसका size B-tree जितना ही निकला (2,064 kB vs 2,056 kB)। इसे measure करने के बाद ही चुनिए; B-tree आमतौर पर उतना ही अच्छा होता है।

## 9. किस query के लिए कौन-सा index

| Query pattern | Index |
|---|---|
| `WHERE user_id = ?` / ranges / `ORDER BY` | B-tree |
| `WHERE user_id = ? ORDER BY created_at DESC LIMIT 10` | `(user_id, created_at DESC)` पर B-tree |
| हमेशा सिर्फ़ एक छोटा subset query होता है (`status = 'pending'`) | Partial B-tree |
| `WHERE lower(email) = ?` | Expression index |
| Table को छुए बिना कुछ columns पढ़ना | `INCLUDE` वाला B-tree |
| Non-C collation के साथ `LIKE 'abc%'` | `text_pattern_ops` वाला B-tree |
| `LIKE '%abc%'` | `pg_trgm` के साथ GIN |
| `jsonb @> '{...}'`, `tags @> ARRAY[...]` | GIN |
| Full-text `to_tsvector(...) @@ query` | GIN |
| Range overlap, geometry, nearest neighbour, EXCLUDE | GiST |
| बहुत बड़ी append-only table पर time filter | BRIN |
| सिर्फ़ equality, बहुत लंबी keys | Hash (पहले measure कीजिए) |

## 10. Unique indexes vs unique constraints

`UNIQUE` constraint एक unique B-tree index **से ही** implement होता है। फ़र्क़ इसमें है कि आप क्या express कर सकते हैं:

| | `UNIQUE` constraint | `CREATE UNIQUE INDEX` |
|---|---|---|
| Partial (`WHERE ...`) | ❌ | ✅ |
| किसी expression पर (`lower(email)`) | ❌ | ✅ |
| `DEFERRABLE` हो सकता है | ✅ | ❌ |
| `ON CONFLICT ON CONSTRAINT name` | ✅ | इसकी जगह `ON CONFLICT (cols)` इस्तेमाल कीजिए |
| Schema में constraint के रूप में दिखता है | ✅ | ❌ (बस एक index) |

दोनों uniqueness एक ही तरीक़े से enforce करते हैं, और दोनों foreign key का target बन सकते हैं, जब तक index partial न हो।

## 11. Live table पर indexes बनाना

सादा `CREATE INDEX` पूरे build के दौरान table को **writes** के लिए lock कर देता है (reads फिर भी चलते हैं)। बड़ी, busy table पर इसका मतलब है checkout requests मिनटों तक queue में खड़ी रहती हैं।

```sql
CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);
```

`CONCURRENTLY` inserts, updates और deletes को चलते रहने देता है। क़ीमत:

- **धीमा:** table पर दो passes, और यह चल रहे transactions के ख़त्म होने का इंतज़ार करता है।
- **Transaction block के अंदर नहीं चल सकता:**

```text
BEGIN;
CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);
ERROR:  CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

  कई migration tools हर migration को एक transaction में लपेट देते हैं; इस migration के लिए आपको वह बंद करना होगा।

- **Fail होने पर एक INVALID index बच जाता है।** मैंने `orders (user_id)` पर concurrently एक unique index बनाया; duplicates की वजह से वह fail हुआ, और index पीछे रह गया:

```text
ERROR:  could not create unique index "orders_user_unique_idx"
DETAIL:  Key (user_id)=(20378) is duplicated.

\d orders
    "orders_user_unique_idx" UNIQUE, btree (user_id) INVALID
```

  Planner invalid index को ignore करता है, लेकिन वह फिर भी write overhead जोड़ सकता है। इन्हें `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;` से ढूँढिए, फिर `DROP INDEX CONCURRENTLY` करके दोबारा कोशिश कीजिए (या `REINDEX INDEX CONCURRENTLY`)।

> **याद रखें:** production tables पर हमेशा `CREATE INDEX CONCURRENTLY`, transaction के बाहर, और fail हो तो `INVALID` indexes check कीजिए।

## 12. Unused indexes ढूँढना और bloat ठीक करना

हर index हर insert और ज़्यादातर updates को धीमा करता है। PostgreSQL गिनता है कि हर index कितनी बार इस्तेमाल हुआ:

```sql
SELECT s.relname AS table_name,
       s.indexrelname AS index_name,
       s.idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique          -- unique/PK indexes enforce rules, keep them
ORDER BY pg_relation_size(s.indexrelid) DESC;
```

कुछ भी drop करने से पहले:

- Counters **पिछले stats reset से** गिने जाते हैं, और ये **हर server के अलग** होते हैं: primary पर unused index किसी read replica पर busy हो सकता है।
- Monthly jobs किसी index को महीने में एक बार इस्तेमाल कर सकते हैं। काफ़ी लंबी window देखिए।

**Bloat:** deletes और updates से ख़ाली हुए B-tree pages सिर्फ़ आंशिक रूप से reuse होते हैं, इसलिए indexes समय के साथ बढ़ते जाते हैं। मेरे test में `orders` की हर row को एक बार update करने से (फिर VACUUM चलाने पर) एक covering index **24 MB से 47 MB** हो गया। Writes को block किए बिना इसे rebuild करना:

```sql
REINDEX INDEX CONCURRENTLY orders_user_created_incl_idx;   -- back to 24 MB
```

`CREATE INDEX CONCURRENTLY` की तरह, यह transaction के अंदर नहीं चल सकता और जब तक दोनों copies मौजूद हैं, extra disk space चाहिए।

## 13. आम ग़लतियाँ और gotchas

- **Plan पढ़े बिना index जोड़ना।** पहले और बाद में `EXPLAIN (ANALYZE, BUFFERS)` से check कीजिए ([Reading EXPLAIN](/lessons/postgres-explain))।
- Multicolumn indexes में **ग़लत column order** (range column पहले)।
- **Expression mismatch:** `lower(email)` पर index `WHERE email ILIKE ...` की मदद नहीं करता।
- **यह उम्मीद करना कि GIN `->>` comparisons तेज़ करेगा।** यह `@>`, `?` और उनके साथियों के काम आता है।
- **ऐसे column पर BRIN जो physically ordered नहीं है।** छोटा-सा index, कोई फ़ायदा नहीं।
- **Business hours में hot table पर सादा `CREATE INDEX`।** Writes block हो जाते हैं।
- **FK indexes भूल जाना** (`orders.user_id`, `order_items.product_id`): PostgreSQL इन्हें नहीं बनाता।
- **"Just in case" indexes रखना।** हर एक की क़ीमत हर write पर चुकानी पड़ती है और वह cache के लिए होड़ करता है।

## 14. Trade-offs

| Index type | ताक़त | क़ीमत |
|---|---|---|
| B-tree | Versatile: equality, ranges, sorts | Rows के साथ size बढ़ता है; समय के साथ bloat |
| Partial | Hot subset के लिए छोटा और तेज़ | सिर्फ़ तब इस्तेमाल होता है जब query predicate को imply करे |
| Covering (`INCLUDE`) | Table को छोड़ देता है | बड़ा index; VACUUM पर निर्भर |
| GIN | Containment, full-text, arrays | धीमे writes, बड़ा |
| GiST | Overlaps, distance, exclusion | Lossy, सादी equality के लिए B-tree से धीमे lookups |
| BRIN | बहुत छोटा, append-only logs के लिए बढ़िया | Lossy; physical ordering के बिना बेकार |
| Hash | लंबी keys पर equality | कोई ranges, sorting, uniqueness या multicolumn नहीं |

> **याद रखें:** हर index एक दाँव है कि उससे reads में होने वाली बचत उसकी write और storage cost से ज़्यादा होगी। EXPLAIN से measure कीजिए, `pg_stat_user_indexes` पर नज़र रखिए, और हारने वालों को drop कर दीजिए।
