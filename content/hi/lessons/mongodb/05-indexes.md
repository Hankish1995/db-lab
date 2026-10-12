---
slug: mongodb-indexes
title: 'MongoDB indexes: writes को मारे बिना queries को तेज़ बनाना'
module: Performance
summary: 'MongoDB कौन-से index types देता है, ESR rule से compound index के fields का order कैसे तय करें, explain() output कैसे पढ़ें, और indexes की cost क्या है।'
recap: >-
  Index कुछ fields की एक sorted copy है, जिससे MongoDB पूरी collection scan करने से बच जाता है। Compound indexes में
  fields का order मायने रखता है: पहले Equality fields, फिर Sort, फिर Range (ESR)। explain को executionStats के
  साथ पढ़ें: आपको IXSCAN चाहिए, कोई in-memory SORT नहीं, और examined keys लगभग returned documents जितनी। हर index
  कुछ reads को तेज़ करता है लेकिन हर write को धीमा करता है और RAM इस्तेमाल करता है, इसलिए जो indexes इस्तेमाल नहीं
  होते उन्हें drop कर दें।
---

## 1. कहानी: warehouse का catalogue

आपके warehouse में shelves पर 2 million parcels हैं। एक customer पूछता है: "**इस हफ़्ते** के सारे **paid** orders कहाँ हैं, सबसे नए पहले?"

Catalogue के बिना, एक worker **हर aisle** में घूमकर हर parcel check करता है। ये है **collection scan**।

*Status, फिर date* के हिसाब से sorted card catalogue के साथ, worker सीधे "paid" पर पलटता है, इस हफ़्ते के cards **पहले से date order में** पढ़ता है, और सीधे उन shelves तक चला जाता है। ये है **index scan**।

| Warehouse | MongoDB |
|---|---|
| हर aisle में घूमना | `COLLSCAN` |
| Card catalogue | **Index** (field values का एक B-tree) |
| एक card: value + shelf location | **Index key** + document का pointer |
| हर card के लिए shelf तक चलकर जाना | `FETCH` |
| ज़मीन पर cards के ढेर को sort करना | In-memory `SORT` |

B-trees की general mechanics [How indexes work](/lessons/how-indexes-work) में cover की गई है। ये lesson **MongoDB की ख़ास बातों** के बारे में है।

> **याद रखें:** index field values की एक sorted list है, जिसमें documents के pointers होते हैं। ये "सब कुछ check करो" को "सही जगह पर jump करो और क्रम से पढ़ो" में बदल देता है।

## 2. Indexes क्यों ज़रूरी हैं (और उनकी cost क्या है)

सही index के बिना, हर `find`, `update` और `delete` filter पूरी collection scan करता है। 1,000 documents पर ठीक है; 10 million पर दर्दनाक।

लेकिन indexes मुफ़्त नहीं हैं:

- **Writes:** हर insert, delete, और indexed field के हर update को **हर** relevant index update करना पड़ता है।
- **RAM:** अक्सर इस्तेमाल होने वाले indexes memory (storage engine के cache) में fit होने चाहिए। अगर नहीं होते, तो lookups disk तक जाते हैं।
- **Disk:** हर index अलग से store होता है।

एक collection में ज़्यादा से ज़्यादा **64 indexes** हो सकते हैं, लेकिन आपको उससे बहुत पहले चिंता करनी चाहिए। कुछ अच्छे से design किए compound indexes बीस single-field indexes से बेहतर हैं।

## 3. Basic index types

```js
// _id: created automatically, unique, can't be dropped
db.orders.createIndex({ userId: 1 })                    // single field
db.orders.createIndex({ status: 1, createdAt: -1 })     // compound
```

**Single-field** index के लिए direction (`1` / `-1`) मायने नहीं रखती: MongoDB उसे दोनों तरफ़ walk कर सकता है। **Compound** indexes में ये तब मायने रखती है जब आप कई fields पर sort करते हैं: `sort({ status: 1, createdAt: -1 })` ऊपर वाला index, या उसका exact reverse (`{ status: -1, createdAt: 1 }`) इस्तेमाल कर सकता है, लेकिन `{ status: 1, createdAt: 1 }` नहीं।

### Compound indexes और prefix rule

`{ status: 1, createdAt: 1, total: 1 }` पर बना index status से sorted है, फिर हर status के अंदर date से, फिर total से।

```text
status    │ createdAt  │ total
──────────┼────────────┼──────
paid      │ 2026-10-01 │  250
paid      │ 2026-10-02 │   40
paid      │ 2026-10-02 │  310
shipped   │ 2026-09-28 │   99
shipped   │ 2026-10-03 │  120
```

ये अपने **prefixes** पर queries support करता है: `{status}`, `{status, createdAt}`, `{status, createdAt, total}`। सिर्फ़ `createdAt` पर query इसमें jump नहीं कर सकती, क्योंकि dates हर status में बिखरी हुई हैं। इसीलिए **field order** सबसे ज़रूरी फ़ैसला है।

## 4. ESR rule: Equality, Sort, Range

Compound index में fields का order ऐसे रखें:

1. **E**quality fields पहले (`status: "paid"`)
2. **S**ort fields उसके बाद (`createdAt`)
3. **R**ange fields आख़िर में (`total: { $gte: 100 }`)

Query (हमारी test collection में 50,000 orders, हर page पर 20 results):

```js
db.orders.find({ status: "paid", total: { $gte: 100 } })
         .sort({ createdAt: -1 }).limit(20)
```

**❌ ख़राब: E-R-S** `{ status: 1, total: 1, createdAt: 1 }`

"paid" के अंदर, entries `total` से ordered हैं, date से नहीं। MongoDB total ≥ 100 वाला हर paid order पढ़ता है और फिर सबसे नए 20 ढूँढने के लिए उन्हें **memory में sort** करता है।

```text
IXSCAN → SORT → FETCH          ⚠️ in-memory sort
totalKeysExamined: 8000   totalDocsExamined: 20   nReturned: 20
```

**✅ अच्छा: E-S-R** `{ status: 1, createdAt: 1, total: 1 }`

"paid" के अंदर, entries पहले से date order में हैं। MongoDB सबसे नए से पीछे की ओर walk करता है, total < 100 वाली entries को सिर्फ़ index key से skip करता है, और 20 matches के बाद रुक जाता है।

```text
IXSCAN (backward) → FETCH → LIMIT     ✅ no sort stage
totalKeysExamined: 23     totalDocsExamined: 20   nReturned: 20
```

वही data, वही query: **8,000 keys + एक sort** vs **23 keys**। (ये numbers 50,000-document वाली test collection पर query चलाकर निकले हैं।)

Range field आख़िर में क्यों जाता है? Sort field से पहले रखा गया `total` पर range, index के date order को कई टुकड़ों में तोड़ देता है, जिससे sort करना पड़ता है। बाद में रखने पर, ये बस उन entries को filter करता है जो index पहले से सही order में दे रहा है।

> **याद रखें:** **E**quality → **S**ort → **R**ange। Equality एक sorted हिस्से तक सीमित करती है, sort उसे क्रम से पढ़ता है, range उसके अंदर filter करती है।

## 5. Specialized index types

### Multikey (arrays)

किसी ऐसे field को index कीजिए जिसमें array है, और MongoDB अपने-आप **हर element की एक index entry** बनाता है।

```js
db.products.createIndex({ categoryIds: 1 })      // multikey
db.products.find({ categoryIds: "summer" })
```

⚠️ Limitation: compound index में, किसी भी document में **ज़्यादा से ज़्यादा एक indexed field array हो सकता है**। जब दोनों arrays हों तो `{ tags: 1, skus: 1 }` index करना "cannot index parallel arrays" error के साथ fail होता है (entries की गिनती cross product की तरह फट जाएगी)।

### Text

```js
db.products.createIndex({ name: "text", description: "text" }, { weights: { name: 10 } })
db.products.find({ $text: { $search: "cotton shirt" } }, { score: { $meta: "textScore" } })
           .sort({ score: { $meta: "textScore" } })
```

Stemming और relevance scoring मिलती है, लेकिन एक collection में **सिर्फ़ एक text index** हो सकता है। Serious search (autocomplete, typo tolerance, facets) के लिए Atlas Search या Elasticsearch जैसा dedicated search engine इस्तेमाल करें।

### 2dsphere (geo)

```js
db.stores.createIndex({ location: "2dsphere" })   // GeoJSON: [longitude, latitude]
db.stores.find({ location: { $near: {
  $geometry: { type: "Point", coordinates: [77.60, 12.97] }, $maxDistance: 5000 } } })
```

"5 km के अंदर के stores।" ध्यान दें कि GeoJSON में **longitude पहले** आता है।

### Hashed

```js
db.orders.createIndex({ customerId: "hashed" })
```

Value का hash store करता है। **सिर्फ़ equality** support करता है (कोई ranges नहीं, कोई sorting नहीं) और arrays index नहीं कर सकता। इसका मुख्य इस्तेमाल **hashed sharding** है (देखें [Sharding](/lessons/sharding))।

### TTL (auto-expiry)

```js
// carts abandoned for 7 days are deleted
db.carts.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 604800 })

// or: expire exactly at a per-document time
db.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

- एक background task expired documents को delete करता है, लगभग **हर 60 seconds** में, इसलिए deletion तुरंत नहीं होता।
- Field में **Date** (या dates का array) होना चाहिए। जिन documents में ये field नहीं है, वो कभी expire नहीं होते।
- TTL **single-field** indexes पर काम करता है।

### Unique, और unique + partial

```js
db.users.createIndex({ email: 1 }, { unique: true })
```

⚠️ **Missing** field `null` के रूप में index होता है, इसलिए plain unique index के साथ, बिना email वाला **दूसरा** user duplicate-key error के साथ fail हो जाता है। इसे सिर्फ़ वहीं unique बनाइए जहाँ field मौजूद है:

```js
db.users.createIndex({ email: 1 },
  { unique: true, partialFilterExpression: { email: { $exists: true } } })
```

### Partial vs sparse

```js
// index only pending orders: smaller, cheaper
db.orders.createIndex({ createdAt: 1 }, { partialFilterExpression: { status: "pending" } })
```

| | Sparse | Partial |
|---|---|---|
| किसे index करता है | वो docs जिनमें field मौजूद है | वो docs जो आपके चुने **किसी भी filter expression** से match करते हैं |
| Flexibility | एक fixed नियम | `$exists`, equality, `$gt`, `$type`, `$and`… |
| सुझाव | Legacy | ✅ Partial को तरजीह दें |

Partial index सिर्फ़ तब इस्तेमाल होता है जब query का filter partial filter से match की **guarantee** देता हो, जैसे query में `status: "pending"` शामिल हो।

### Wildcard

```js
db.products.createIndex({ "specs.$**": 1 })   // every field under specs
db.products.find({ "specs.ram": "16GB" })      // can use it
```

Unpredictable, user-defined attributes के लिए बढ़िया। Known query patterns पर सोच-समझकर बनाए compound indexes की जगह नहीं ले सकता।

> **याद रखें:** index type को query से match करें: arrays → multikey, text search → text, location → 2dsphere, expiry → TTL, "मौजूद हो तो unique" → unique + partial।

## 6. `explain("executionStats")` पढ़ना

```js
db.orders.find({ status: "paid", total: { $gte: 100 } })
         .sort({ createdAt: -1 }).limit(20)
         .explain("executionStats")
```

`queryPlanner.winningPlan` देखें (कुछ versions में stages `winningPlan.queryPlan` के अंदर nested होती हैं)। Stages को सबसे अंदर वाले `inputStage` से बाहर की ओर पढ़ें:

| Stage | मतलब | फ़ैसला |
|---|---|---|
| `COLLSCAN` | पूरी collection scan की | ❌ बड़ी collections पर |
| `IXSCAN` | एक index walk किया (`indexName`, `indexBounds` बताते हैं कौन-सा और कैसे) | ✅ |
| `FETCH` | Index pointers से पूरे documents load किए | Normal, जब तक query covered न हो सकती हो |
| `SORT` | Results को memory में sort किया (blocking) | ⚠️ बड़े result sets पर red flag |
| `PROJECTION_COVERED` | सिर्फ़ index से जवाब दिया | ✅✅ |

फिर `executionStats` में तीन numbers की तुलना करें:

```text
totalKeysExamined   index entries read
totalDocsExamined   documents loaded
nReturned           documents sent back
ideal:  keys ≈ docs ≈ nReturned   (1 : 1 : 1)
```

- **docs ≫ nReturned:** MongoDB बहुत सारे documents load करता है और ज़्यादातर फेंक देता है। Index filter को अच्छे से cover नहीं करता।
- **keys ≫ nReturned:** index को inefficiently walk किया जा रहा है (अक्सर range field, sort या equality fields से पहले रखा होता है)।
- **SORT मौजूद है:** results memory में sort होते हैं। Blocking sort 100 MB RAM तक limited है; उससे ज़्यादा होने पर उसे disk पर spill करना पड़ता है (हाल के versions में default में allowed) या query fail हो जाती है।

> **याद रखें:** explain में `IXSCAN` ढूँढें और ये देखें कि `SORT` न हो, फिर check करें कि examined keys, examined docs और nReturned एक-दूसरे के क़रीब हों।

## 7. Covered queries

अगर filter **और** projection का हर field index में है, तो MongoDB documents को कभी load ही नहीं करता।

```js
db.orders.find({ status: "paid" }, { _id: 0, status: 1, createdAt: 1 })
// winningPlan: PROJECTION_COVERED ← IXSCAN,  totalDocsExamined: 0
```

जाल: `_id` default में return होता है। अगर आप `_id: 0` भूल जाते हैं (और `_id` index में नहीं है), तो MongoDB को सिर्फ़ `_id` पाने के लिए हर document FETCH करना पड़ता है। Multikey (array) fields भी आमतौर पर covered नहीं हो सकते।

## 8. Live collection पर index builds

Modern MongoDB indexes **पूरे build के दौरान reads और writes को block किए बिना** बनाता है: ये सिर्फ़ **शुरुआत और अंत में** थोड़ी देर के लिए exclusive lock लेता है, और बीच में normal traffic चलने देता है। इससे ये मुफ़्त नहीं हो जाता:

- Build पूरी collection scan करता है, CPU, disk I/O और memory इस्तेमाल करते हुए।
- Replica set पर, build data-bearing members पर चलता है और जब उनमें से काफ़ी members पूरा कर लेते हैं तब commit होता है (देखें [Replication](/lessons/mongodb-replication))।
- व्यस्त clusters पर बड़े builds को कम traffic वाले समय में schedule करना सबसे अच्छा है।

## 9. कितने indexes? बेकार indexes ढूँढना

कोई जादुई number नहीं है। हर index किसी **असली, frequent query** से justify होना चाहिए। हटाने के आम उम्मीदवार:

- **Redundant prefixes:** अगर `{ status: 1, createdAt: 1 }` मौजूद है तो `{ status: 1 }` redundant है।
- **Unused indexes:** किसी ऐसे feature के लिए बनाए गए जो अब है ही नहीं।

```js
db.orders.aggregate([{ $indexStats: {} }, { $project: { name: 1, "accesses.ops": 1, "accesses.since": 1 } }])
```

`accesses.ops` गिनता है कि हर index को कितने operations ने इस्तेमाल किया, **server start होने (या index बनने) के बाद से**, और **सिर्फ़ उसी member पर**। फ़ैसला करने से पहले हर replica set member को, काफ़ी लंबे समय तक (month-end reports!), check करें।

फिर **hidden index** के साथ safely drop करें:

```js
db.orders.hideIndex("status_1")    // planner ignores it, but it's still maintained
// watch performance for a few days…
db.orders.unhideIndex("status_1")  // instant rollback, no rebuild
db.orders.dropIndex("status_1")    // or drop it for real
```

Hidden index की writes पर cost फिर भी लगती है और वो `unique` भी enforce करता रहता है, लेकिन planner उसे इस्तेमाल नहीं करता, इसलिए आप "अगर ये न होता तो?" test कर सकते हैं, और ग़लत निकलने पर धीमा rebuild नहीं करना पड़ता।

## 10. आम ग़लतियाँ

- ❌ Query से match करने वाले एक compound index की जगह हर field पर एक single-field index।
- ❌ Range field को sort field से पहले रखना (E-R-S) → in-memory sort।
- ❌ Optional field पर plain unique index → दूसरी missing value fail हो जाती है।
- ❌ `_id: 0` भूल जाना और फिर हैरान होना कि query covered क्यों नहीं है।
- ❌ Low-selectivity fields को अकेले index करना (99% docs पर `isActive: true`) → index मुश्किल से कुछ narrow करता है।
- ❌ Case-insensitive या unanchored `$regex` से index जैसी speed की उम्मीद करना।
- ❌ किसी index को सिर्फ़ इसलिए drop कर देना क्योंकि `$indexStats` ने एक secondary पर एक दिन के लिए 0 ops दिखाए।

## 11. Index type cheat sheet

| Type | किसके लिए इस्तेमाल करें | ध्यान रखें |
|---|---|---|
| Single / compound | ज़्यादातर queries; ESR order | Field order, prefix rule |
| Multikey | Array fields | हर compound index में एक ही array field |
| Text | Simple keyword search | हर collection में एक |
| 2dsphere | Geo queries | Longitude पहले |
| Hashed | Equality, hashed sharding | कोई ranges या sorts नहीं |
| TTL | Carts, sessions को auto-expire करना | ~60 s की देरी, सिर्फ़ Date field |
| Unique (+ partial) | Email जैसी business keys | Missing को null गिना जाता है |
| Partial | एक hot subset को index करना | Query का filter से match होना ज़रूरी |
| Wildcard | Unknown/dynamic fields | Compound indexes का substitute नहीं |

## 12. Index कब नहीं जोड़ना चाहिए

- **Write-heavy collections** (logs, events) जहाँ reads कम होते हैं: हर index हर insert पर टैक्स लगाता है।
- **छोटी collections** (कुछ सौ documents): collection scan पहले से ही तेज़ है।
- अकेले **low-selectivity fields**: ये search को काफ़ी narrow नहीं करते।
- **एक बार चलने वाली queries** (one-off migration): इन्हें secondary पर चलाएँ या scan स्वीकार कर लें।

> **याद रखें:** index एक सौदा है: धीमे writes और ज़्यादा RAM के बदले तेज़ reads। इसे किसी असली query के लिए जोड़ें, explain से verify करें, और जब कोई इसे इस्तेमाल न करे तो हटा दें।
