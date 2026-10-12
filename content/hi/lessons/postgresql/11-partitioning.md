---
slug: postgres-partitioning
title: 'Partitioning: एक बड़ी table, कई छोटी drawers'
module: Scaling
summary: 'PostgreSQL का declarative partitioning एक बहुत बड़ी table को उसी server पर छोटी tables में कैसे बाँटता है, partition pruning की वजह से queries पूरे partitions को कैसे skip करती हैं, और partitioning कब फ़ायदा देता है और कब नुकसान।'
recap: >-
  Partitioning एक logical table को उसी server पर कई छोटी physical tables में बाँटता है, जिन्हें partition
  key तय करती है: समय के लिए RANGE, categories के लिए LIST, और rows को बराबर फैलाने के लिए HASH। जो queries
  key पर filter करती हैं, वे बेकार partitions को skip कर देती हैं (pruning), plan time पर या parameters के
  लिए execution time पर। सबसे बड़ा फ़ायदा maintenance है: बड़े DELETE और फिर VACUUM की जगह पुराना महीना
  तुरंत drop या detach कर दो। Unique constraints में key शामिल होनी चाहिए, बहुत ज़्यादा partitions planning
  को धीमा करते हैं, और यह sharding नहीं है।
---

## 1. कहानी

एक online shop अपना हर paper invoice **एक बहुत बड़ी filing cabinet** में रखती है। पाँच साल बाद उसमें 40 million invoices हैं।

- "पिछले मंगलवार के invoices" ढूँढने का मतलब है पूरी cabinet पलटना।
- तीन साल से पुराने invoices फेंकने के लिए उन्हें **एक-एक करके** निकालना पड़ता है।
- Cabinet को साफ़-सुथरा करने में पूरा weekend लग जाता है, क्योंकि वह एक ही विशाल चीज़ है।

तो office manager **एक filing room खरीदता है, जिसमें हर महीने की एक drawer है**। हर drawer पर label लगा है: "2026-01", "2026-02"…

- "पिछले मंगलवार के invoices?" बस **एक drawer** खोलो।
- "2022 फेंकना है?" **बारह drawers** निकालो और shredder में डाल दो। कुछ seconds में काम ख़त्म।
- सफ़ाई **drawer by drawer** होती है, और पुरानी drawers को दोबारा कभी साफ़ करने की ज़रूरत नहीं पड़ती।

**यही partitioning है।**

| Filing room | PostgreSQL |
|---|---|
| पूरा filing room | **Partitioned table** (`orders`), वह parent जिस पर आप query करते हैं |
| एक drawer | एक **partition**: असली table जिसमें rows का एक हिस्सा है |
| "Invoice का महीना" | **Partition key** (`created_at`) |
| Drawer के labels | **Partition bounds** (`FROM ... TO ...`) |
| सिर्फ़ सही drawer खोलना | **Partition pruning** |
| अजीब invoices के लिए "misc" drawer | **Default partition** |
| पूरी drawer को shred करना | `DROP` / `DETACH PARTITION` |

> **याद रखें:** partitioning = एक logical table जो **उसी server पर** कई physical tables में बँटी है, और partition key तय करती है कि row कहाँ जाएगी।

## 2. यह क्यों है: एक बहुत बड़ी table की समस्या

सोचिए `orders` में 2 billion rows हैं, और हर दिन 5 million बढ़ रही हैं। Indexes reads में मदद करते हैं ([Indexes](/lessons/postgres-indexes) देखें), लेकिन table के आसपास के **operations** सिरदर्द बन जाते हैं:

- **पुराना data delete करना बहुत भारी है।** `DELETE FROM orders WHERE created_at < '2023-01-01'` millions rows को छूता है, हर एक के लिए WAL लिखता है, और millions **dead tuples** छोड़ जाता है। हमारे scratch database में 300,000 rows की table से 107,136 rows delete करने पर ठीक `n_dead_tup = 107136` बचे, जिन्हें VACUUM को साफ़ करना था।
- **VACUUM और autovacuum** को एक विशाल table और उसके विशाल indexes को scan करना पड़ता है ([MVCC and VACUUM](/lessons/postgres-mvcc-and-vacuum) देखें)।
- **Index rebuilds और `ANALYZE`** minutes की जगह घंटों लेते हैं।
- **Hot data बिखर जाता है।** इस हफ़्ते के orders सालों की cold rows के बीच फैले होते हैं, इसलिए cache को ज़्यादा मेहनत करनी पड़ती है।

Monthly partitions के साथ हर महीना अपनी अलग table है, अपने indexes के साथ। पुराने महीनों में दोबारा कभी write नहीं होता: VACUUM उन्हें एक बार freeze करके छोड़ देता है, और retention बस `DROP TABLE` बन जाता है।

> **याद रखें:** partitioning का सबसे बड़ा फ़ायदा आम तौर पर **maintenance और data retention** है, सीधी query speed नहीं।

## 3. यह कैसे काम करता है: declarative partitioning

आप `PARTITION BY` के साथ एक **parent** बनाते हैं, फिर `PARTITION OF` से partitions बनाते हैं। Parent ख़ुद कोई row store नहीं करता। PostgreSQL हर `INSERT` को सही partition में भेजता है, और जो `UPDATE` key बदलते हैं वे row को उसके नए partition में move कर देते हैं।

```text
            INSERT / SELECT / UPDATE / DELETE
                          │
               ┌──────────▼──────────┐
               │  orders (parent)    │  ← no rows of its own
               │  PARTITION BY RANGE │
               └──┬───────┬───────┬──┘
        ┌─────────┘       │       └─────────┐
 ┌──────▼───────┐ ┌───────▼──────┐ ┌────────▼─────┐
 │orders_2026_01│ │orders_2026_02│ │orders_2026_03│
 │ Jan rows     │ │ Feb rows     │ │ Mar rows     │
 │ own indexes  │ │ own indexes  │ │ own indexes  │
 └──────────────┘ └──────────────┘ └──────────────┘
```

### RANGE: `created_at` पर महीने के हिसाब से

Orders, events और logs जैसे time-series data के लिए यही standard choice है:

```sql
CREATE TABLE orders (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  customer_id bigint        NOT NULL,
  status      text          NOT NULL,
  total       numeric(10,2) NOT NULL,
  created_at  timestamptz   NOT NULL,
  PRIMARY KEY (id, created_at)          -- must include the partition key
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2026_01 PARTITION OF orders
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE orders_2026_02 PARTITION OF orders
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE orders_2026_03 PARTITION OF orders
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
```

Lower bound **inclusive** है और upper bound **exclusive**, इसलिए 1 February की आधी रात February वाले partition में जाती है। न कोई gap, न कोई overlap।

### LIST: तय values के हिसाब से

Region या status जैसी values के छोटे, पहले से पता set के लिए अच्छा है:

```sql
CREATE TABLE customers (
  id     bigint NOT NULL,
  region text   NOT NULL,
  email  text   NOT NULL
) PARTITION BY LIST (region);

CREATE TABLE customers_eu   PARTITION OF customers FOR VALUES IN ('DE', 'FR', 'NL');
CREATE TABLE customers_us   PARTITION OF customers FOR VALUES IN ('US');
CREATE TABLE customers_rest PARTITION OF customers DEFAULT;
```

### HASH: rows को बराबर फैलाना

जब कोई natural range नहीं है, लेकिन आपको N लगभग बराबर साइज़ के टुकड़े चाहिए, जैसे `customer_id` के हिसाब से carts:

```sql
CREATE TABLE carts (
  customer_id bigint NOT NULL,
  items       jsonb  NOT NULL DEFAULT '[]'
) PARTITION BY HASH (customer_id);

CREATE TABLE carts_p0 PARTITION OF carts FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE carts_p1 PARTITION OF carts FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE carts_p2 PARTITION OF carts FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE carts_p3 PARTITION OF carts FOR VALUES WITH (MODULUS 4, REMAINDER 3);
```

10,000 customers insert करने पर 2,489 / 2,527 / 2,530 / 2,454 rows मिलीं। Equality lookups (`customer_id = 42`) एक partition तक prune हो जाते हैं; range queries नहीं हो पातीं, और आप "पुराना" data आसानी से drop नहीं कर सकते, क्योंकि हर partition में सब कुछ मिला-जुला है।

| Strategy | किसके लिए सबसे अच्छा | किस पर prune होता है | Retention आसान? |
|---|---|---|---|
| **RANGE** | समय: orders, events, logs | Ranges और equality | ✅ पुरानी ranges drop करो |
| **LIST** | Region, tenant, status | Equality / `IN` | ⚠️ हर value के हिसाब से |
| **HASH** | किसी ID से बराबर फैलाव | सिर्फ़ equality | ❌ |

### Default partition

जो row किसी partition से match नहीं करती, वह error देती है:

```text
ERROR:  no partition of relation "orders" found for row
DETAIL:  Partition key of the failing row contains (created_at) = (2027-05-01 00:00:00+00).
```

एक **default partition** (`CREATE TABLE orders_default PARTITION OF orders DEFAULT;`) ऐसी rows को पकड़ लेता है। Safety net के रूप में काम का है, लेकिन इसकी कीमत है:

- नया partition बनाते समय PostgreSQL को **default को scan** करके साबित करना पड़ता है कि कोई row नई range की नहीं है। अगर कुछ rows हैं, तो यह fail हो जाता है: `updated partition constraint for default partition "orders_default" would be violated by some row`।
- Default partition मौजूद हो तो `DETACH PARTITION ... CONCURRENTLY` की **अनुमति नहीं** है (testing में हमें यही error मिला)।

कई teams **कोई default नहीं** रखना पसंद करती हैं, साथ में एक job जो हफ़्तों पहले partitions बना दे, और एक alert अगर कभी कोई insert fail हो।

## 4. Partition pruning: drawers को skip करना

**Partition pruning** का मतलब है कि planner उन partitions को हटा देता है जिनमें matching rows हो ही नहीं सकतीं। यह default रूप से on है (`enable_partition_pruning = on`)।

300,000 rows की एक test table से असली plans, जिसमें तीन monthly partitions और `created_at` पर index है (lines को fit करने के लिए wrap और trim किया गया है):

**`WHERE` में partition key के साथ** (एक partition scan हुआ):

```sql
EXPLAIN (COSTS OFF)
SELECT sum(total) FROM orders
WHERE created_at >= '2026-02-10' AND created_at < '2026-02-11';
```

```text
 Aggregate
   ->  Index Scan using orders_2026_02_created_at_idx
       on orders_2026_02 orders
         Index Cond: ((created_at >= '2026-02-10 00:00:00+00'::timestamptz)
                  AND (created_at < '2026-02-11 00:00:00+00'::timestamptz))
```

**Partition key के बिना** (हर partition scan हुआ):

```sql
EXPLAIN (COSTS OFF) SELECT sum(total) FROM orders WHERE customer_id = 42;
```

```text
 Finalize Aggregate
   ->  Gather
         Workers Planned: 2
         ->  Partial Aggregate
               ->  Parallel Append
                     ->  Parallel Seq Scan on orders_2026_01 orders_1
                     ->  Parallel Seq Scan on orders_2026_02 orders_2
                     ->  Parallel Seq Scan on orders_2026_03 orders_3
```

### Execution time पर pruning

जब value planning time पर पता नहीं होती (**generic plan** वाले prepared statement में parameter, या subquery या join से आई value), तब PostgreSQL **execute करते समय** prune करता है। EXPLAIN ANALYZE इसे `Subplans Removed` के रूप में दिखाता है:

```sql
PREPARE orders_since(timestamptz) AS
  SELECT count(*) FROM orders WHERE created_at >= $1;
SET plan_cache_mode = force_generic_plan;   -- only to demonstrate
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) EXECUTE orders_since('2026-03-15');
```

```text
 Aggregate (actual rows=1 loops=1)
   ->  Append (actual rows=47712 loops=1)
         Subplans Removed: 2
         ->  Index Only Scan using orders_2026_03_created_at_idx
               on orders_2026_03 orders_1
               Index Cond: (created_at >= $1)
```

Node.js apps के लिए यह ज़रूरी है, क्योंकि drivers parameterized queries (`$1`) भेजते हैं, और फिर भी pruning काम करता है।

⚠️ Pruning के लिए **key column पर ही** condition चाहिए। `WHERE date_trunc('month', created_at) = '2026-02-01'` key को एक function के अंदर छिपा देता है, इसलिए prune नहीं हो सकता। इसकी जगह सीधी ranges लिखें।

> **याद रखें:** pruning तभी होता है जब query partition key पर filter करती है। Key को अपने सबसे आम `WHERE` clause से चुनें।

## 5. Indexes और constraints

- Parent पर `CREATE INDEX ON orders (customer_id)` एक **partitioned index** बनाता है, साथ में **हर partition पर** एक असली index, और आने वाले partitions को यह अपने-आप मिल जाता है।
- **कोई global index नहीं** होता। हर partition सिर्फ़ अपनी rows जानता है।
- इसलिए **unique constraint या primary key में partition key के सभी columns शामिल होने चाहिए**। PostgreSQL uniqueness सिर्फ़ एक partition के अंदर check कर सकता है:

```text
ERROR:  unique constraint on partitioned table must include all partitioning columns
DETAIL:  PRIMARY KEY constraint on table "bad" lacks column "created_at" which is part of the partition key.
```

इसीलिए हमारी key `PRIMARY KEY (id, created_at)` है। Identity column व्यवहार में फिर भी unique ids देता है, लेकिन database अब यह **guarantee** नहीं करता कि अकेला `id` unique है।

- `CREATE INDEX CONCURRENTLY` partitioned parent पर काम नहीं करता। इसका workaround: `CREATE INDEX ... ON ONLY orders` (एक invalid parent index बनाता है), फिर हर partition पर `CREATE INDEX CONCURRENTLY` और हर एक को `ALTER INDEX ... ATTACH PARTITION`। सभी partitions attach होते ही parent index valid हो जाता है।

## 6. Retention: delete नहीं, drop करें

January हटाने के लिए:

```sql
-- ❌ Slow: millions of row deletions, WAL, dead tuples, VACUUM afterwards
DELETE FROM orders WHERE created_at < '2026-02-01';

-- ✅ Instant: remove the whole drawer
DROP TABLE orders_2026_01;

-- ✅ Or keep it for archiving, without blocking queries on orders
ALTER TABLE orders DETACH PARTITION orders_2026_01 CONCURRENTLY;
-- now it's a normal table: dump it to cold storage, then DROP it
```

सादा `DETACH PARTITION` (और `DROP`) parent पर एक strong lock लेता है, इसलिए यह `orders` पर चल रही queries का इंतज़ार करता है और उन्हें block करता है। **`DETACH ... CONCURRENTLY`** दो transactions में एक कमज़ोर lock लेता है, इसलिए normal traffic चलता रहता है। इसके नियम:

- यह **transaction block के अंदर नहीं चल सकता** (`BEGIN ... COMMIT`)।
- **Default partition मौजूद होने पर इसकी अनुमति नहीं** है।
- अगर यह बीच में रुक जाए, तो `ALTER TABLE orders DETACH PARTITION orders_2026_01 FINALIZE;` से इसे पूरा करें।

उल्टा भी काम करता है: एक table offline बनाकर load करें, bounds से match करता `CHECK` constraint जोड़ें, फिर `ATTACH PARTITION` करें। Matching `CHECK` की वजह से PostgreSQL validation scan skip कर देता है।

> **याद रखें:** partitioned table पर retention एक metadata operation है। Millions rows को `DELETE` करने की जगह partition को `DROP` या `DETACH` करें।

## 7. कितने partitions बहुत ज़्यादा हैं?

हर partition एक असली table है, अपनी files, indexes और catalog entries के साथ। Planner को partitions पर विचार करना पड़ता है, और अगर query prune नहीं हो पाती, तो वह हर एक को plan और execute करता है।

यह आपके version, आपकी queries और उनके prune होने पर **निर्भर करता है**:

- **दर्जनों से कुछ सौ** partitions: ज़्यादातर workloads के लिए आराम से ठीक।
- **कुछ हज़ार**: नए versions पर चल सकता है अगर लगभग हर query prune होती है, लेकिन planning time measure करें (`EXPLAIN (ANALYZE)` में `Planning Time` दिखता है)।
- **दसियों हज़ार**: धीमी planning, हर connection पर ज़्यादा memory और lock-table pressure की उम्मीद रखें। ऐसा न करें।

तो granularity data volume से तय करें: **monthly** आम default है, daily सिर्फ़ बहुत ज़्यादा volume और छोटे retention के लिए। `customer_id` से partition करना, यानी हर customer का एक partition, एक classic गलती है।

## 8. आम गलतियाँ और gotchas

- **5 GB की table को partition करना।** इसके लिए अकेले indexes काफ़ी हैं। Partitioning सैकड़ों GB पर या सख़्त retention के साथ चमकता है।
- **ऐसी key चुनना जिस पर आपकी queries filter नहीं करतीं।** हर query "सारे partitions scan करो" बन जाती है, अक्सर पहले से भी धीमी।
- **आने वाले partitions बनाना भूल जाना।** Default के बिना, 1 तारीख़ की आधी रात को inserts fail होने लगते हैं। इसे automate करें।
- **Partitions के पार unique `id` की उम्मीद करना**, जब key में वह शामिल नहीं है।
- `WHERE` में **key को function में लपेटना**, जो pruning को बेकार कर देता है।
- **बड़े default partitions**, जो हर नए `CREATE TABLE ... PARTITION OF` को धीमा कर देते हैं।

## 9. इन्हें आपस में confuse न करें

| | Partitioning | Sharding | Table inheritance |
|---|---|---|---|
| Data कहाँ रहता है | एक server | कई servers | एक server |
| Routing | अपने-आप, partition key से | Router / app / Citus | आपके लिखे triggers |
| Pruning | ✅ plan + execution time | Targeted queries | Constraint exclusion (plan time) |
| एक machine से आगे writes scale करता है | ❌ | ✅ | ❌ |
| Status | ✅ Modern, recommended | अलग समस्या | Partition करने का पुराना (legacy) तरीका |

Sharding को [Sharding](/lessons/sharding) में cover किया गया है। **Table inheritance** (`INHERITS`) वह तरीका है जिससे लोग PostgreSQL 10 से पहले partition करते थे: child tables, `CHECK` constraints और एक insert trigger। नए काम के लिए declarative partitioning use करें।

दो extensions जिनका नाम पता होना चाहिए:

- **pg_partman** आने वाले partitions बनाना और retention rule के हिसाब से पुराने partitions drop या detach करना automate करता है।
- **Citus** tables को कई machines पर distribute करता है, जिससे PostgreSQL एक sharded database बन जाता है।

## 10. कब partition NOT करें (trade-offs)

- **छोटी या मध्यम tables।** लगभग 100 GB से नीचे, और retention की ज़रूरत न हो, तो एक अच्छा index ज़्यादा simple है और उतना ही तेज़।
- **ऐसी queries जो key से filter नहीं करतीं।** महीने के हिसाब से partitioned table पर "customer 42 के orders" हर partition का index check करता है: एक lookup की जगह N छोटे lookups।
- **आपको किसी ऐसे column पर global uniqueness चाहिए** जो key नहीं है।
- **आपको असल में ज़्यादा machines चाहिए।** Partitioning CPU, RAM या disk नहीं जोड़ता; वह [Sharding](/lessons/sharding) का काम है।

कीमत: manage करने के लिए ज़्यादा objects, partition बनाने वाली jobs, constraint की सीमाएँ, और planning overhead। फ़ायदा: सस्ता retention, छोटे VACUUMs और indexes, और नए data पर तेज़ queries।

> **याद रखें:** partition तब करें जब table **बहुत बड़ी और time-shaped** हो और आपकी queries key पर filter करती हों। वरना पहले index करें।
