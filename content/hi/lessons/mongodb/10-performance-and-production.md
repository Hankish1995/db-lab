---
slug: mongodb-performance
title: 'Performance और production: धीमे MongoDB को ढूँढना और ठीक करना'
module: Performance
summary: 'धीमी MongoDB queries diagnose करने का एक दोहराने लायक workflow, साथ में memory, pagination, writes, connections और data growth की वो practices जो production cluster को तेज़ रखती हैं।'
recap: >-
  जब कोई query धीमी हो, तो उसे reproduce करें, executionStats के साथ explain चलाएँ, और सही index से ठीक
  करने से पहले examined documents की तुलना returned documents से करें। Profiler और slow query log आपके लिए
  दोषियों को ढूँढ देते हैं। Working set को WiredTiger cache में रखें, skip के बजाय range से paginate करें,
  सिर्फ़ वही project करें जो चाहिए, unanchored या case-insensitive regex से बचें, writes को batch करें,
  हर process में एक ही client share करें, और data व arrays को बिना सीमा बढ़ने से रोकें।
---

## 1. कहानी: धीमा "My orders" page

सोमवार की सुबह। Support कहता है: "कुछ customers के लिए **My orders** page 4 seconds लेता है।" पिछले साल यह तुरंत खुलता था।

एक कमज़ोर detective अंदाज़ा लगाता है: "चलो और RAM जोड़ देते हैं।" एक अच्छा detective **सबूत इकट्ठा करता है**:

1. जो query धीमी है, ठीक उसी को **reproduce** करें।
2. **जाँचें** कि MongoDB ने उसे कैसे चलाया (`explain`)।
3. **वजह ढूँढें** (एक scan, memory में sort, बहुत ज़्यादा data)।
4. उसे **ठीक करें** और **फिर से मापें**।

| Detective | MongoDB |
|---|---|
| Crime scene | धीमा endpoint |
| गवाहों के बयान | Slow query log और **profiler** |
| Forensic report | `explain('executionStats')` |
| दोषी | Missing index, in-memory sort, विशाल documents, गहरा `skip` |
| हल होने का सबूत | वही query, नया `explain`, कम latency |

> **याद रखें:** कभी अंदाज़े से tune न करें। Reproduce, explain, fix, measure।

## 2. Performance क्यों गिरती है

MongoDB शायद ही कभी इसलिए धीमा होता है कि software बदल गया। यह धीमा होता है क्योंकि:

- **Data बढ़ गया।** 5,000 orders पर collection scan ठीक था; 5 करोड़ पर नहीं है।
- **Working set RAM से बड़ा हो गया**, इसलिए अब reads disk तक जाते हैं।
- बिना matching indexes के **नए query shapes** ship हो गए।
- **Documents बढ़ गए** (unbounded arrays) और हर read और update ज़्यादा bytes ढोता है।
- ज़्यादा app instances के साथ **connections या writes** कई गुना हो गए।

## 3. Workflow: एक धीमी query को explain करना

Page के पीछे की query:

```js
db.orders.find({ customerId: 7, status: 'paid' }).sort({ createdAt: -1 })
```

MongoDB से पूछिए कि उसने इसे कैसे चलाया:

```js
db.orders.find({ customerId: 7, status: 'paid' })
  .sort({ createdAt: -1 })
  .explain('executionStats')
```

ज़रूरी fields:

| Field | मतलब | Red flag |
|---|---|---|
| `winningPlan.stage` | Data कैसे पढ़ा | `COLLSCAN`, या एक `SORT` stage (in-memory sort) |
| `nReturned` | लौटाए गए documents | — |
| `totalKeysExamined` | पढ़ी गई index entries | `nReturned` से बहुत ज़्यादा |
| `totalDocsExamined` | पढ़े गए documents | `nReturned` से बहुत ज़्यादा |
| `executionTimeMillis` | Server का समय | पहले/बाद की तुलना करें |

2,000 orders की एक test collection पर, index जोड़ने से **पहले**:

```text
stage: SORT (over a COLLSCAN)
nReturned: 27   totalKeysExamined: 0   totalDocsExamined: 2000
```

MongoDB ने 27 लौटाने के लिए **हर** order पढ़ा, फिर उन्हें memory में sort किया। **Examined-to-returned ratio** लगभग 74:1 है। 5 करोड़ orders पर यही ratio वो 4 seconds है।

Fix [MongoDB indexes](/lessons/mongodb-indexes) वाले **ESR rule** (Equality, Sort, Range) को follow करता है:

```js
db.orders.createIndex({ customerId: 1, status: 1, createdAt: -1 })
```

**बाद में:**

```text
stage: FETCH ◄ IXSCAN { customerId: 1, status: 1, createdAt: -1 }
nReturned: 27   totalKeysExamined: 27   totalDocsExamined: 27
```

**1:1 ratio** और कोई `SORT` stage नहीं: index documents पहले से order में देता है।

> **याद रखें:** किसी भी query का health check है examined ÷ returned। 1 के करीब हो तो बढ़िया; सैकड़ों या हज़ारों का मतलब है index missing है या गलत है।

## 4. वो धीमी queries ढूँढना जिनके बारे में आपको पता नहीं था

### Slow query log

**`slowms`** (default **100 ms**) से धीमा हर operation `mongod` diagnostic log में लिखा जाता है, profiler बंद होने पर भी। Atlas पर **Query Profiler** और **Performance Advisor** इन्हें दिखाते हैं और indexes suggest करते हैं।

### Database profiler

**Profiler** operations को एक database की `system.profile` collection में record करता है।

```js
db.setProfilingLevel(1, { slowms: 100 })   // 1 = only ops slower than 100 ms
db.getProfilingStatus()                    // { was: 1, slowms: 100, sampleRate: 1, ... }

// The five most recent slow operations
db.system.profile.find().sort({ ts: -1 }).limit(5)

// Slow queries that scanned whole collections
db.system.profile.find({ planSummary: 'COLLSCAN' })

db.setProfilingLevel(0)                    // turn it off again
```

| Level | क्या record करता है |
|---|---|
| `0` | कुछ नहीं (slow ops फिर भी log में जाते हैं) |
| `1` | `slowms` से धीमे operations |
| `2` | **सब कुछ**: भारी overhead, सिर्फ़ छोटे debugging sessions के लिए |

⚠️ Profiler load बढ़ाता है। Level 1 को समझदारी वाले `slowms` के साथ इस्तेमाल करें, और level 2 सिर्फ़ थोड़ी देर के लिए।

## 5. Memory: working set और WiredTiger cache

**Working set** वो data और indexes हैं जिन्हें आपका app नियमित रूप से छूता है: आज के orders, popular products, और उन्हें ढूँढने में इस्तेमाल होने वाले indexes।

**WiredTiger**, MongoDB का storage engine, hot data को अपने **cache** में रखता है। Default रूप से cache का size **50% of (RAM − 1 GB)** या **256 MB** में से जो बड़ा हो, वो होता है। 16 GB server पर: 0.5 × 15 = **7.5 GB**। बाकी RAM OS file cache, connections और दूसरी memory ज़रूरतों में जाती है।

```text
 Request ──► ┌──────────────────┐  hit  ──► fast (microseconds)
             │ WiredTiger cache │
             └────────┬─────────┘
                      │ miss
                      ▼
             ┌──────────────────┐
             │   OS file cache  │──► disk ──► slow (milliseconds)
             └──────────────────┘
```

अगर working set **cache में fit होता है**, तो ज़्यादातर reads memory से होते हैं। अगर नहीं, तो MongoDB लगातार pages evict और reload करता रहता है, और latency उछल जाती है। इसीलिए **indexes RAM में fit होने चाहिए**, और इसीलिए full collection scan दोहरी चोट करता है: वो खुद धीमा है **और** उपयोगी data को cache से बाहर धकेल देता है।

```js
const c = db.serverStatus().wiredTiger.cache
c['bytes currently in the cache']
c['maximum bytes configured']
c['pages read into cache']       // rising fast = lots of cache misses
```

> **याद रखें:** तेज़ MongoDB = working set (hot documents + indexes) WiredTiger cache में fit होता है।

## 6. Pagination: skip एक जाल है

"सारे orders, सबसे नए पहले" का page 1,000, हर page पर 20:

```js
// ❌ Offset pagination
db.orders.find().sort({ createdAt: -1, _id: -1 }).skip(19980).limit(20)
```

`skip` छलाँग नहीं लगाता। Server फिर भी **हर skipped entry से होकर गुज़रता है**। हमारे test में, `skip(1500).limit(3)` ने 3 लौटाने के लिए **1,503** index keys examine कीं। गहरे pages धीमे और धीमे होते जाते हैं।

**Keyset (range-based) pagination** याद रखता है कि पिछला page कहाँ खत्म हुआ था और index की मदद से वहीं से आगे बढ़ता है:

```js
// mongosh (in Node.js, add `await` before .toArray())
// Index that matches the sort
db.orders.createIndex({ createdAt: -1, _id: -1 })

// Page 1
const page = db.orders.find({}, { total: 1, status: 1, createdAt: 1 })
  .sort({ createdAt: -1, _id: -1 })
  .limit(20)
  .toArray()
const last = page[page.length - 1]   // send this cursor to the client

// Next page: everything strictly "after" the last item
db.orders.find({
  $or: [
    { createdAt: { $lt: last.createdAt } },
    { createdAt: last.createdAt, _id: { $lt: last._id } }   // tie-breaker
  ]
}, { total: 1, status: 1, createdAt: 1 })
  .sort({ createdAt: -1, _id: -1 })
  .limit(20)
```

हमारे test में अगले page ने **3 results के लिए 3 keys** examine कीं, चाहे page कितना भी गहरा हो।

| | `skip` / `limit` | Keyset (range) |
|---|---|---|
| Page N की कीमत | N के साथ बढ़ती है | Constant |
| Page 500 पर jump | ✅ | ❌ (सिर्फ़ next/previous) |
| नई rows आने पर stable | ❌ Items pages के बीच खिसकते हैं | ✅ |
| किसके लिए सबसे अच्छा | छोटी collections, admin tables | Feeds, infinite scroll, APIs |

`_id` tie-breaker ज़रूरी है: कई orders का `createdAt` एक ही हो सकता है, और इसके बिना आप items skip या repeat कर देंगे।

> **याद रखें:** `skip` की कीमत page number के साथ बढ़ती है। Indexed field पर range-based pagination constant रहता है।

## 7. कम पढ़ें: projection और regex

### Projection

Order list page को `status`, `total` और `createdAt` चाहिए, पूरे items, addresses और status history नहीं।

```js
db.orders.find({ customerId: 7 }, { status: 1, total: 1, createdAt: 1 })
```

कम data का मतलब है कम network, Node.js में कम memory और कम BSON decoding। अगर हर projected और filtered field index में है, तो query **covered** हो सकती है: `totalDocsExamined: 0`।

### Regex

| Query | Index का इस्तेमाल |
|---|---|
| `{ name: /^Key/ }` | ✅ Efficient: case-sensitive prefix एक index range बन जाता है |
| `{ name: /board/ }` | ⚠️ हर index key या document check करना पड़ता है |
| `{ name: /^key/i }` | ⚠️ Case-insensitive: tight range इस्तेमाल नहीं कर सकता |

Search boxes के लिए fixes:

- एक normalized field (`nameLower`) store करें और उस पर anchored, case-sensitive prefix से query करें।
- Exact matches के लिए **case-insensitive collation index** इस्तेमाल करें:

```js
db.products.createIndex({ name: 1 }, { collation: { locale: 'en', strength: 2 } })
db.products.find({ name: 'keyboard' }).collation({ locale: 'en', strength: 2 })
```

- असली full-text search के लिए regex के बजाय text index या Atlas Search इस्तेमाल करें।

## 8. Writes: इन्हें batch करें

10,000 products को एक-एक `insertOne` से insert करने का मतलब है 10,000 network round trips।

```js
db.products.bulkWrite([
  { insertOne: { document: { sku: 'KB-2', name: 'Keyboard Pro', price: 80, stock: 50 } } },
  { updateOne: { filter: { sku: 'KB-1' }, update: { $inc: { stock: -2 } } } },
  { deleteOne: { filter: { sku: 'OLD-9' } } }
], { ordered: false })
```

- **`bulkWrite` / `insertMany`** एक round trip में कई operations भेजते हैं। Drivers बहुत बड़े batches को अपने-आप बाँट देते हैं।
- **`ordered: false`** किसी एक error (जैसे duplicate key) के बाद भी चलता रहता है और operations को parallel में चलने देता है, जैसे shards के पार। `ordered: true` (default) पहले error पर रुक जाता है।
- Imports के लिए कुछ सौ से कुछ हज़ार documents के **batch sizes** अच्छी शुरुआत हैं। मापें।
- **Write concern trade-off:** `w: 'majority'` replication का इंतज़ार करता है और सुरक्षित default है। `w: 1` तेज़ है लेकिन failover पर writes खो सकता है। जिस data की आपको परवाह है उसके लिए कभी `w: 0` इस्तेमाल न करें।
- हर **index** हर write को थोड़ा धीमा करता है। जिन indexes का कोई इस्तेमाल नहीं करता उन्हें drop करें (`$indexStats` usage दिखाता है)।

## 9. Node.js से connections

हर `MongoClient` का अपना **connection pool** होता है (driver default `maxPoolSize: 100`)। Startup पर **हर process में एक client** बनाएँ और हर जगह उसे reuse करें।

```js
// db.js
import { MongoClient } from 'mongodb';
export const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 50 });
await client.connect();
```

गुणा पर नज़र रखें: **30 pods × 100 connections = 3,000 connections**। हर connection server पर memory लेता है, और clusters की connection limits होती हैं। हर request पर नया client बनाना और भी बुरा है: हर बार आप connection setup और authentication की कीमत चुकाते हैं, और connections जमा होते जाते हैं।

## 10. Data growth: बड़े documents और unbounded arrays

- Documents की सीमा **16 MB** है, लेकिन दर्द आपको उससे बहुत पहले महसूस होगा। एक product पढ़ने पर **पूरा document** cache में load होता है।
- बड़े documents writes को भी भारी बनाते हैं: cache करने, disk पर लिखने और replicate करने के लिए ज़्यादा bytes, भले आप सिर्फ़ एक field बदलें।
- **Unbounded arrays** आम दोषी हैं: हर review को हमेशा के लिए `product.reviews` में, या हर event को `order.history` में push करते रहना।

Fix: **recent या summary data embedded रखें** (जैसे latest 10 reviews और `reviewCount`), और पूरी history को उसकी अपनी collection में ले जाएँ (देखें [MongoDB schema design](/lessons/mongodb-schema-design))।

### Growth पर सीमा लगाना

जिस data की आपको हमेशा ज़रूरत नहीं, उसे **expire** होना चाहिए।

```js
// Delete abandoned carts 7 days after their last update
db.carts.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 })
```

**TTL index** किसी date पर single-field index है। एक background task इसे लगभग **हर 60 seconds** में check करता है, इसलिए deletion तुरंत नहीं होता। जो data रखना ज़रूरी है लेकिन कम पढ़ा जाता है (2 साल से पुराने orders), उसे **archive** किया जा सकता है: `$merge` से उसे archive collection या सस्ते storage में copy करें, फिर hot collection से batches में delete करें।

> **याद रखें:** जो collection सिर्फ़ बढ़ती रहती है, वो आखिरकार आपकी RAM से बड़ी हो जाएगी। Expiry या archiving की planning पहले दिन से करें।

## 11. क्या monitor करें

| Metric | कहाँ | यह आपको क्या बताता है |
|---|---|---|
| **opcounters** | `db.serverStatus().opcounters` | हर second inserts/queries/updates/deletes: आपका load |
| **Query targeting** (scanned ÷ returned) | Atlas metric, `metrics.queryExecutor` | ज़्यादा = missing indexes |
| **Cache usage & pages read** | `serverStatus().wiredTiger.cache` | Working set अब RAM में fit नहीं होता |
| **Replication lag** | `rs.printSecondaryReplicationInfo()` | Secondaries पीछे रह रहे हैं; stale reads, failover का जोखिम |
| **Connections** | `serverStatus().connections` | Pool की गलत configuration, connection leaks |
| **Slow queries** | Log, profiler, Atlas Query Profiler | ठीक-ठीक कौन सी queries पहले ठीक करनी हैं |
| **Disk IOPS / latency** | OS / cloud metrics | Disk bottleneck है |

## 12. आम गलतियाँ

- `explain` चलाने से पहले ही **RAM या बड़ा tier जोड़ देना**।
- **ऐसे indexes जो sort से match नहीं करते**, जिससे in-memory `SORT` stage बनता है।
- Public APIs पर **गहरा `skip` pagination**।
- **Projection के बिना `find()`**, list pages को 200 KB के documents लौटाना।
- बड़ी collection पर search box में **unanchored `$regex`**।
- हर request या हर Lambda invocation पर **नया `MongoClient`**।
- Production में **profiler level 2** चालू छोड़ देना।
- **Unbounded arrays** और बिना retention plan वाली collections।

## 13. Production checklist

| क्षेत्र | Check |
|---|---|
| Deployment | Replica set (3 data-bearing members), standalone नहीं |
| Indexes | हर frequent query का index है; ratio ≈ 1; unused indexes हटा दिए गए |
| Index builds | Deploy के समय सोच-समझकर बनाए गए, app startup से नहीं (`autoIndex` बंद) |
| Memory | Working set और indexes WiredTiger cache में fit होते हैं |
| Queries | List endpoints पर projections; बड़ी collections पर unanchored regex नहीं |
| Pagination | Feeds और APIs के लिए keyset pagination |
| Writes | `bulkWrite` से batched; ज़रूरी data के लिए `w: 'majority'` |
| Connections | हर process में एक client; `maxPoolSize` कुल app instances के हिसाब से |
| Growth | TTL indexes या archiving; कोई unbounded arrays नहीं |
| Observability | Slow query log/profiler की समीक्षा; lag, cache, connections, targeting पर alerts |
| Safety | Backups को सच में restore करके test किया गया |

## 14. Trade-offs: कब optimize न करें

- **हर चीज़ पर index न लगाएँ।** हर index RAM लेता है और writes धीमे करता है। अपनी असली, frequent queries के लिए index बनाएँ।
- **Missing index ठीक करने के लिए shard न करें।** Sharding complexity कई गुना बढ़ा देता है; पहले queries ठीक करें (देखें [Sharding](/lessons/sharding))।
- जहाँ छोटे datasets पर users को सच में "page 37 पर jump" चाहिए, वहाँ **keyset pagination इस्तेमाल न करें**; वहाँ `skip` ठीक है।
- अगर एक order खोना मंज़ूर नहीं, तो benchmarks अच्छे दिखाने के लिए **`w: 1` पर न उतरें**।
- दिन में दो बार चलने वाली query को **micro-optimize न करें**। वो optimize करें जिसे profiler धीमा और frequent बताता है।
