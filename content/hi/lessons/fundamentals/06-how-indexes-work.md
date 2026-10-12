---
slug: how-indexes-work
title: 'Indexes कैसे काम करते हैं: आपके data के लिए किताब वाला index'
module: Performance
summary: 'Index असल में physically क्या होता है, B-trees lookups को O(log n) क्यों बनाते हैं, composite indexes और selectivity कैसे तय करते हैं कि index use होगा या नहीं, और हर index writes पर आपको कितना महँगा पड़ता है।'
recap: >-
  Index एक अलग sorted structure होता है, आमतौर पर B+tree, जो column values को row locations से map करता है, ताकि database
  सब कुछ scan करने की जगह सीधे matching rows पर पहुँच सके। Lookups O(log n) होते हैं और भारी fan-out की वजह से tree सिर्फ़ 3 से 4
  levels गहरा रहता है। Composite indexes leftmost-prefix rule मानते हैं, low-selectivity conditions पर index छोड़ा जा सकता है,
  और functions, leading wildcards, type mismatches और कुछ OR conditions index use होने से रोक सकते हैं। हर index reads को तेज़
  करता है लेकिन हर write को धीमा करता है, इसलिए index जोड़ने से पहले और बाद में EXPLAIN या explain() से जाँच करें।
---

## 1. कहानी

आपके पास 900 पन्नों की एक cookbook है और आपको "paneer tikka" की recipe चाहिए।

- **Index के बिना:** आप सारे 900 पन्ने पलटते हैं, हर एक को पढ़ते हुए। यही है **full table scan** (MongoDB में **collection scan**)।
- **पीछे दिए index के साथ:** आप सीधे "P" पर जाते हैं, "Paneer tikka … page 412" ढूँढते हैं, और page 412 खोल लेते हैं। बस कुछ सेकंड।

किताब के पीछे वाला index:

- **sorted** होता है (वर्णमाला के क्रम में), इसलिए कोई entry जल्दी मिल जाती है,
- content से **अलग** होता है (extra पन्ने जो publisher को छापने पड़े),
- **pointers** की एक list है ("page 412"), खुद recipes नहीं।

अब इसे databases से जोड़िए:

| किताब | Database |
|---|---|
| पन्नों पर recipes | Table / collection में rows / documents |
| पीछे वाला index | **Index**: एक अलग sorted structure |
| "Paneer tikka" | **Key**: indexed column की value |
| "page 412" | Row तक का एक **pointer** (PostgreSQL: tuple id; MongoDB: record id) |
| हर पन्ना पलटना | **Seq Scan** / **COLLSCAN** |
| नए edition के लिए index दोबारा छापना | हर write पर **index maintenance** |

> **याद रखें:** index **कुछ columns की sorted copy और साथ में rows तक के pointers** होता है। यह extra storage और धीमे writes के बदले बहुत तेज़ reads देता है।

## 2. Indexes क्यों होते हैं

आपकी `orders` table में 50 million rows हैं। एक customer "My orders" खोलता है:

```sql
SELECT * FROM orders WHERE customer_id = 42;
```

Index के बिना, database match होने वाली ~20 rows ढूँढने के लिए **सारी 50 million rows** पढ़ता है। Cost table के साथ **linearly** बढ़ती है: **O(n)**। `customer_id` पर index हो तो database कुछ levels गहरा tree walk करता है और ~20 rows पढ़ता है: शुरुआत ढूँढने में **O(log n)**, और फिर matches।

| | Full scan | Index lookup |
|---|---|---|
| 20 matches के लिए जाँची गई rows | 50,000,000 | ~20 (+ कुछ index pages) |
| Data बढ़ने पर growth | Linear | Logarithmic |
| कब अच्छा है | जब आपको table का ज़्यादातर हिस्सा चाहिए | जब आपको छोटा सा हिस्सा चाहिए |

## 3. Index physically क्या है: B+tree

PostgreSQL, MySQL (InnoDB) और MongoDB (WiredTiger) में default index एक **B-tree** है, **B+tree** style में: keys sorted order में **leaf pages** में रखी जाती हैं, और **internal pages** में सिर्फ़ separator keys होती हैं जो search को रास्ता दिखाती हैं। Leaves key order में होती हैं, इसलिए scan एक leaf से अगली leaf पर **sideways** चल सकता है। PostgreSQL और InnoDB इसी काम के लिए पड़ोसी leaves के बीच direct links रखते हैं; WiredTiger अपने cursor के ज़रिए वही in-order walk हासिल करता है।

`orders(customer_id)` पर index:

```text
                     ┌─────────────────┐
         root        │   100  │  200   │
                     └──┬─────┬─────┬──┘
           ┌────────────┘     │     └────────────┐
           ▼                  ▼                  ▼
    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
    │ 42 │ 57 │ 88│───►│120│150│ 199 │───►│210│260│ 300 │ leaves
    └──┬──────────┘    └─────────────┘    └─────────────┘
       │ customer 42 → row locations
       ▼
    ┌───────────────────────────────┐
    │ table (heap): actual rows     │
    └───────────────────────────────┘
```

**Equality lookup** `customer_id = 42`: root से शुरू करें, 42 < 100 है तो बाएँ जाएँ, leaf में 42 ढूँढें, और उसके pointers के सहारे rows तक पहुँचें।

**Range lookup** `customer_id BETWEEN 120 AND 260`: एक बार 120 तक नीचे उतरें, फिर **leaves के साथ-साथ दाईं ओर, क्रम से, चलते जाएँ** जब तक 260 पार न हो जाए। Tree में वापस ऊपर जाने की ज़रूरत नहीं। इसी वजह से B-trees `<`, `>`, `BETWEEN` और `ORDER BY` के लिए बढ़िया हैं।

### यह इतना कम गहरा क्यों है: fan-out

Tree का एक page एक disk block होता है (PostgreSQL में 8 KB)। एक page में **सैकड़ों** keys आती हैं, इसलिए हर level पहुँच को सैकड़ों गुना बढ़ा देता है। इसे **fan-out** कहते हैं।

| Levels | ~300 fan-out के साथ पहुँच |
|---|---|
| 1 | 300 |
| 2 | 90,000 |
| 3 | 27,000,000 |
| 4 | 8,100,000,000 |

तो एक billion rows वाली table में भी data **3–4 page reads** में मिल जाता है, और ऊपर के levels लगभग हमेशा memory में cached रहते हैं। यहाँ O(log n) का practical मतलब यही है: log का base बहुत बड़ा है।

> **याद रखें:** B+tree = sorted, कम गहरा, leaves key order में। Equality = एक बार नीचे उतरो। Range = एक बार नीचे उतरो, फिर sideways चलो।

## 4. Composite indexes और leftmost-prefix rule

एक **composite (multi-column) index** पहले column से sort करता है, फिर बराबरी होने पर दूसरे column से, और इसी तरह आगे। बिल्कुल वैसे ही जैसे *last name, फिर first name* से sorted एक **phone book**:

```text
Patel, Anil
Patel, Priya
Sharma, Asha
Sharma, Rahul     ◄── sorted by last name first,
Sharma, Zoya          then first name within it
Verma, Rahul
```

- "Sharma" ढूँढना: आसान, सब एक साथ हैं। ✅
- "Sharma, Rahul" ढूँढना: आसान। ✅
- "Rahul" नाम वाले सभी लोगों को ढूँढना: वे पूरी किताब में बिखरे हुए हैं। ❌

यही है **leftmost-prefix rule**: `(a, b, c)` पर बना index `a`, `a + b`, या `a + b + c` पर filters के लिए efficient है, लेकिन अकेले `b` या `c` के लिए नहीं।

```sql
CREATE INDEX idx_orders_cust_status_date
  ON orders (customer_id, status, created_at);

-- ✅ uses the prefix
SELECT * FROM orders WHERE customer_id = 42;
SELECT * FROM orders WHERE customer_id = 42 AND status = 'shipped';
SELECT * FROM orders
WHERE customer_id = 42 AND status = 'shipped'
ORDER BY created_at DESC;              -- even the sort comes from the index

-- ❌ no leading column: can't seek into the index efficiently
SELECT * FROM orders WHERE status = 'shipped';
```

```js
db.orders.createIndex({ customerId: 1, status: 1, createdAt: -1 })

db.orders.find({ customerId: 42, status: 'shipped' }).sort({ createdAt: -1 }) // ✅
db.orders.find({ status: 'shipped' })                                         // ❌
```

दो बातें जो interviewers को impress करती हैं:

- **Column order मायने रखता है।** **Equality** columns पहले रखें और **range** columns उनके बाद। PostgreSQL के शब्दों में, leading columns पर equality conditions और *अगले* column पर एक inequality मिलकर scan को सीमित करते हैं; पहली range condition के बाद वाले columns सिर्फ़ filter हो सकते हैं, seek के लिए use नहीं हो सकते। MongoDB यही बात **ESR rule** (Equality, Sort, Range) के नाम से सिखाता है।
- **"Skip scan" मौजूद है, लेकिन उसके भरोसे design न करें।** कुछ engines (MySQL 8, और B-trees के लिए PostgreSQL 18) कभी-कभी leading column के बिना भी index use कर लेते हैं, जब उस column में distinct values कम हों। यह एक optimization है, rule को नज़रअंदाज़ करने की वजह नहीं।

> **याद रखें:** composite index एक phone book है। अगर आपको **last name** पता है तो यह मदद करता है; अगर सिर्फ़ **first name** पता है तो बेकार है।

## 5. Selectivity: planner कभी-कभी आपका index क्यों ignore करता है

**Selectivity** = कोई condition rows के कितने हिस्से से match करती है। **Cardinality** = किसी column में कितनी distinct values हैं।

- `email = 'asha@x.io'` 10 million में से 1 row से match करता है: **highly selective**। यहाँ index साफ़ तौर पर फ़ायदेमंद है।
- `status = 'delivered'` 85% orders से match करता है: **low selectivity**।

दूसरी query के लिए index use करने का मतलब है: index entries पढ़ो, फिर 8.5 million rows में से **हर एक** के लिए table पर jump करो, random order में। पूरी table को **sequentially** पढ़ना इससे सस्ता है। इसलिए PostgreSQL का **cost-based planner** table statistics (जो `ANALYZE`/autovacuum इकट्ठा करते हैं) से row counts का अंदाज़ा लगाता है और index मौजूद होने पर भी **Seq Scan** चुन सकता है। यह सही behaviour है, bug नहीं।

PostgreSQL में एक बीच का रास्ता भी है, **Bitmap Index Scan**: index से matching row locations इकट्ठा करो, उन्हें physical position के हिसाब से sort करो, फिर table pages को क्रम से पढ़ो।

MongoDB का planner अलग तरह से काम करता है: वह query के लिए candidate indexes ढूँढता है, उन्हें थोड़ी देर **trial-run** करता है, और जीतने वाले को cache कर लेता है। Collection scan आमतौर पर तभी चुना जाता है जब कोई भी index query को serve न कर सके। इसलिए MongoDB में low-selectivity index use तो हो सकता है, फिर भी बहुत सारी keys examine करनी पड़ सकती हैं। दोनों ही cases में, **plan ज़रूर check करें**।

> **याद रखें:** index तब मदद करता है जब वह result को काफ़ी **narrow** कर दे। "Table का ज़्यादातर हिस्सा" चाहिए तो sequential scan अक्सर तेज़ होता है, और planner यह जानता है।

## 6. Covering indexes और index-only scans

आमतौर पर index lookup दो steps में होता है: index में key ढूँढो, फिर table से **row fetch करो**। अगर index में पहले से ही **query को चाहिए हर column** मौजूद है, तो दूसरा step छोड़ा जा सकता है।

```sql
CREATE INDEX idx_orders_cust_total
  ON orders (customer_id) INCLUDE (total, created_at);

SELECT created_at, total FROM orders WHERE customer_id = 42;
-- Plan: Index Only Scan
```

PostgreSQL में `INCLUDE` non-key payload columns जोड़ता है। एक PostgreSQL-specific पेच: MVCC की वजह से index-only scan फिर भी table का **visibility map** check करता है, और जिन pages पर हाल में vacuum नहीं चला उनके लिए row पर जाना ही पड़ता है। `EXPLAIN ANALYZE` इसे `Heap Fetches` के रूप में दिखाता है।

MongoDB इसे **covered query** कहता है। Projection में सिर्फ़ indexed fields होने चाहिए, और `_id` को exclude करना होगा, जब तक वह index में न हो:

```js
db.orders.createIndex({ customerId: 1, total: 1 })
db.orders.find({ customerId: 42 }, { _id: 0, total: 1 })
// explain(): PROJECTION_COVERED, totalDocsExamined: 0
```

## 7. Clustered vs heap storage, और hash indexes

**Rows खुद कहाँ रहती हैं?** हर engine में यह अलग है, और यह interview का पसंदीदा topic है।

| Engine | Table storage | Secondary indexes किसकी ओर point करते हैं |
|---|---|---|
| **PostgreSQL** | एक **heap**: rows किसी खास क्रम में नहीं | Row की physical location (एक tuple id, `ctid`) |
| **MySQL InnoDB** | Primary key से **clustered**: table *खुद* PK पर बना B+tree है | **Primary key value** (फिर PK tree में दूसरा lookup) |
| **MongoDB (WiredTiger)** | Documents एक internal record id से stored | Record id; `_id` एक normal unique index है |

नतीजे:

- InnoDB में PK range scans बहुत तेज़ होते हैं (rows physically पास-पास होती हैं), और बड़ी random PK (जैसे UUIDv4) insert पर page splits और fragmentation पैदा करती है।
- PostgreSQL में कोई maintained clustered index नहीं है। `CLUSTER` command table को **एक बार** reorder करता है; नई rows वह order नहीं रखतीं।
- MongoDB optional तौर पर **clustered collections** (`_id` पर clustered) support करता है, जो मुख्य रूप से time-ordered data के लिए use होते हैं।

**Hash indexes** sorted key की जगह key का hash store करते हैं।

- ✅ सिर्फ़ equality lookups।
- ❌ न ranges, न sorting, न prefix matching।
- PostgreSQL: `CREATE INDEX ... USING hash (col)`। Practice में यह शायद ही कभी B-tree से बेहतर होता है, इसलिए B-tree ही default रहता है।
- MongoDB: `{ field: 'hashed' }` indexes मुख्य रूप से **hashed sharding** को support करने के लिए होते हैं।

## 8. Index कब use नहीं होता

हर case में मान लीजिए कि column पर index मौजूद है।

| Pattern | Index मदद क्यों नहीं कर पाता | Fix |
|---|---|---|
| `WHERE lower(email) = 'a@x.io'` | Index `email` से sorted है, `lower(email)` से नहीं | Expression index: `CREATE INDEX ON customers (lower(email))` |
| `WHERE name LIKE '%phone'` | Leading wildcard: कोई sorted starting point नहीं | Full-text search, या trigram (`pg_trgm`) GIN index |
| `WHERE id = 5.0` (int column) | Compare करने के लिए column `numeric` में cast हो जाता है | अपने driver से सही type pass करें |
| `WHERE status = 'delivered'` (85% rows) | Low selectivity: scan सस्ता है | दुर्लभ values पर partial index, या scan को स्वीकार करें |
| `WHERE customer_id = 42 OR coupon = 'X'` | हर OR branch को index चाहिए; एक भी un-indexed branch scan करवा देती है | दोनों columns को index करें (PostgreSQL उन्हें **BitmapOr** से combine कर सकता है) |
| `WHERE created_at + interval '1 day' > now()` | Column पर arithmetic | Rewrite करें: `created_at > now() - interval '1 day'` |

तीन engine-specific gotchas:

- **PostgreSQL prefix `LIKE 'abc%'`:** default B-tree index इसे सिर्फ़ `C` collation के साथ support करता है। दूसरी collations के साथ index को `text_pattern_ops` के साथ बनाएँ।
- **MongoDB regex:** `/^Sam/` जैसा case-sensitive prefix regex index को efficiently use करता है। `/sam/` या `/^sam/i` इसे range की तरह use नहीं कर सकते, इसलिए पूरा index या पूरी collection scan होती है।
- **MongoDB type mismatch** "slow" वाली समस्या नहीं, बल्कि **wrong-result** वाली समस्या है: `{ customerId: '42' }` number `42` से match नहीं करता।

> **याद रखें:** column को function में लपेट दिया, wildcard से शुरू किया, या गलत type से compare किया, तो index का sorted order काम का नहीं रहता।

## 9. हर index की कीमत

Indexes मुफ़्त नहीं होते। हर index ये चीज़ें जोड़ता है:

- **Write amplification:** हर `INSERT` को table के **हर** index में एक entry जोड़नी पड़ती है। दस indexes = एक row write और दस index writes। Updates engine के हिसाब से अलग होते हैं: PostgreSQL में `UPDATE` एक नया row version लिखता है, जिसके लिए आमतौर पर **हर** index में नई entry चाहिए, उनमें भी जिनके columns बदले ही नहीं। अपवाद है **HOT update** (heap-only tuple): अगर कोई indexed column नहीं बदला और नया version उसी page पर fit हो जाए, तो indexes को छुआ नहीं जाता।
- **Storage:** बड़ी tables पर indexes खुद table जितने बड़े हो सकते हैं।
- **Memory:** indexes तब तेज़ होते हैं जब उनके hot हिस्से RAM में हों (PostgreSQL के shared buffers और OS cache, MongoDB का WiredTiger cache)। बहुत ज़्यादा indexes उस memory के लिए आपस में होड़ करते हैं।
- **Planner का काम** और **maintenance:** bloat, rebuilds, और धीमे bulk loads।

## 10. Check कैसे करें: EXPLAIN और explain()

**PostgreSQL:**

```sql
EXPLAIN ANALYZE
SELECT * FROM orders WHERE customer_id = 42;
```

| Plan node | मतलब |
|---|---|
| `Seq Scan` | पूरी table पढ़ो |
| `Index Scan` | Index walk करो, हर row fetch करो |
| `Index Only Scan` | जवाब index से ही मिल गया (covering) |
| `Bitmap Heap Scan` | Index से matches इकट्ठा करो, table pages क्रम से पढ़ो |

`EXPLAIN` plan और **estimates** दिखाता है। `EXPLAIN ANALYZE` query को सच में **run** करता है और असली times और row counts दिखाता है (`UPDATE`/`DELETE` के साथ सावधान रहें: वे सच में execute हो जाते हैं)।

**MongoDB:**

```js
db.orders.find({ customerId: 42 }).explain('executionStats')
```

इन चीज़ों पर ध्यान दें:

- `COLLSCAN` (बड़ी collections पर बुरा) vs `IXSCAN` (index use हुआ), और `FETCH` (documents तक जाना)।
- `totalKeysExamined`, `totalDocsExamined` vs `nReturned`। आदर्श रूप से तीनों करीब होने चाहिए। 20 return करने के लिए 1,000,000 docs examine करना मतलब index missing है या गलत है।

Live table पर index बनाना:

```sql
CREATE INDEX CONCURRENTLY idx_orders_customer ON orders (customer_id);
-- doesn't block writes while building (slower, can't run inside a transaction)
```

```js
db.orders.createIndex({ customerId: 1 })
```

## 11. आम गलतियाँ और gotchas

- **"शायद काम आए" सोचकर हर column को index करना।** हर index writes को धीमा करता है और memory लेता है। **असली queries** के लिए index बनाएँ।
- **एक composite की जगह अलग-अलग single-column indexes।** दोनों columns use करने वाली query के लिए `(customer_id)` और `(status)` अलग-अलग, `(customer_id, status)` से काफ़ी कमज़ोर हैं।
- Composite indexes में **गलत column order** (range column पहले)।
- **Foreign keys भूल जाना।** PostgreSQL foreign key columns को अपने आप index **नहीं** करता। `order_items.order_id` पर joins और `ON DELETE CASCADE` के लिए index चाहिए।
- **Duplicate indexes।** अगर `(customer_id, status)` मौजूद है तो `(customer_id)` पर index आमतौर पर redundant है: composite पहले से ही prefix को serve करता है। (Single-column वाला छोटा होता है, इसलिए वह extra write cost शायद ही कभी लायक होता है।)
- **Index मौजूद है = use हो रहा है, ऐसा मान लेना।** हमेशा plan check करें।

## 12. Index vs no index: trade-offs

| | Index जोड़ें | न जोड़ें |
|---|---|---|
| उस filter/sort पर reads | बहुत तेज़ | Full scan |
| Writes | धीमे (update करने को ज़्यादा structures) | तेज़ |
| Storage और RAM | ज़्यादा | कम |
| सबसे अच्छा किसके लिए | Selective, बार-बार चलने वाली queries; sorts; joins | छोटी tables, write-heavy logs, low-selectivity columns |

**कब index नहीं बनाना चाहिए:**

- **छोटी tables** (कुछ हज़ार rows): scan पहले से ही तुरंत हो जाता है।
- **Write-heavy, कम query होने वाला** data (raw event logs, audit trails)।
- अकेले **low-cardinality columns** (`is_active`, `gender`)। इसकी जगह दुर्लभ value के लिए **partial index** पर विचार करें: `CREATE INDEX ON orders (created_at) WHERE status = 'pending'`।
- **ऐसे columns जिन्हें आप हमेशा functions के ज़रिए ही पढ़ते हैं** और जिनके लिए आपने expression index नहीं बनाया।

> **याद रखें:** index अपनी **queries** के लिए बनाएँ, अपने columns के लिए नहीं। पहले और बाद में EXPLAIN से measure करें।
