---
slug: mongodb-crud-and-queries
title: 'CRUD और queries: MongoDB से fluently बात करना'
module: Basics
summary: 'mongosh में documents को insert, find, update और delete कैसे करें, जिसमें array queries, update operators, upserts और atomic find-and-modify भी शामिल हैं।'
recap: >-
  Inserts ordered (पहली error पर रुक जाते हैं) या unordered (चलते रहते हैं) हो सकते हैं। find में operators वाला एक
  filter और एक projection होता है, और server हमेशा पहले sort, फिर skip, फिर limit लगाता है। Arrays में सावधानी
  चाहिए: जब कई conditions एक ही element पर सच होनी चाहिए, तो $elemMatch इस्तेमाल करें। Updates $set, $inc, $push
  और arrayFilters जैसे operators इस्तेमाल करते हैं, हर document के लिए atomic होते हैं, और findOneAndUpdate एक ही
  atomic step में पढ़ता भी है और बदलता भी है।
---

## 1. कहानी: दुकान का stock clerk

आपकी दुकान में एक stock clerk है जिसके पास एक filing cabinet है। आप उसे जो भी request देते हैं, वो इन चार में से एक होती है:

- "ये नया product folder file कर दो।" → **Create** (`insertOne`)
- "₹500 से कम की सारी नीली shirts ले आओ।" → **Read** (`find`)
- "Folder #42 पर price बदल दो।" → **Update** (`updateOne`)
- "Discontinued folders फेंक दो।" → **Delete** (`deleteMany`)

एक अच्छा clerk *सटीक* requests भी समझता है: "सिर्फ़ price, पूरा folder नहीं" (**projection**), "सबसे सस्ते 10" (**sort + limit**), और "sheet पर stock count में 5 units जोड़ दो, पूरी sheet दोबारा मत लिखो" (**update operators**)।

> **याद रखें:** हर request के दो हिस्से होते हैं: **कौन-से documents** (filter) और उनके साथ **क्या करना है** (return, change, delete)।

## 2. Details क्यों मायने रखती हैं

CRUD आसान दिखता है, और इसीलिए bugs यहीं छिपे होते हैं:

- एक ग़लत array filter ऐसे orders लौटा देता है जो match **नहीं** करते।
- आपके Node code में read-then-write से **दो buyers आख़िरी item उठा लेते हैं**।
- Document को update करने की जगह replace करने से **fields मिट जाते हैं**।

इनमें से हर एक classic interview question है। चलिए इन्हें अपने store के साथ समझते हैं: `products`, `orders`, `users`।

## 3. Create

```js
db.products.insertOne({ sku: "MUG-01", name: "Coffee Mug", price: NumberDecimal("9.99"),
                        stock: 40, tags: ["kitchen", "ceramic"] })

db.products.insertMany([
  { sku: "TEE-01", name: "T-Shirt", price: NumberDecimal("19.99"), stock: 100 },
  { sku: "LAMP-1", name: "Desk Lamp", price: NumberDecimal("34.50"), stock: 8 }
])
```

### Ordered vs unordered `insertMany`

मान लीजिए दूसरे document का `_id` duplicate है:

```js
db.orders.insertMany([{ _id: 1 }, { _id: 1 }, { _id: 2 }])
// ordered (default): inserts _id 1, fails on the duplicate, STOPS → 1 doc

db.orders.insertMany([{ _id: 1 }, { _id: 1 }, { _id: 2 }], { ordered: false })
// unordered: skips the failure, keeps going → 2 docs, then reports the error
```

⚠️ दोनों cases में, error से पहले insert हुए documents **inserted ही रहते हैं**। `insertMany` कोई transaction नहीं है। Bulk loads के लिए unordered तेज़ भी हो सकता है, क्योंकि server को writes सख़्ती से एक के बाद एक execute नहीं करने पड़ते।

## 4. Read: filters और operators

```js
db.products.find({ stock: { $lt: 10 } })                 // low stock
db.products.find({ price: { $gte: NumberDecimal("10"), $lte: NumberDecimal("50") } })
db.orders.find({ status: { $in: ["paid", "shipped"] } })
db.orders.find({ status: { $ne: "cancelled" } })         // also matches docs with no status
db.users.find({ $or: [{ city: "Pune" }, { isPrime: true }] })
db.users.find({ phone: { $exists: false } })
db.products.find({ price: { $type: "string" } })         // find bad data
db.products.find({ name: { $regex: /^Cof/ } })           // prefix search
```

| Operator family | Operators |
|---|---|
| Comparison | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin` |
| Logical | `$and`, `$or`, `$not`, `$nor` |
| Element | `$exists`, `$type` |
| Pattern | `$regex` |

जानने लायक बातें:

- एक filter object में कई conditions एक **implicit `$and`** होती हैं। Explicit `$and` की ज़रूरत सिर्फ़ तब है जब आप एक ही operator दोहराते हैं, जैसे दो `$or` clauses।
- `$ne` और `$nin` उन documents से भी match करते हैं **जिनमें field है ही नहीं**।
- `{ field: null }` उन documents से match करता है जिनमें field null है **या है ही नहीं**। सिर्फ़ explicit nulls के लिए `{ field: { $type: "null" } }` इस्तेमाल करें।
- Anchored, case-sensitive regex (`/^Cof/`) index को efficiently इस्तेमाल कर सकता है। Case-insensitive या unanchored regex index को efficiently इस्तेमाल नहीं कर पाता और आमतौर पर कहीं ज़्यादा data check करता है।

### Embedded fields के लिए dot notation

```js
db.users.find({ "address.city": "Pune" })     // field inside a sub-document
db.orders.find({ "items.sku": "MUG-01" })     // field inside an array of docs
```

Dotted paths के चारों ओर quotes ज़रूरी हैं।

## 5. Arrays पर query करना (जहाँ bugs रहते हैं)

```js
// product: { tags: ["red", "cotton"] }
db.products.find({ tags: "red" })                  // ✅ contains "red"
db.products.find({ tags: ["red", "cotton"] })      // ✅ exact array, same order
db.products.find({ tags: ["cotton", "red"] })      // ❌ different order, no match
db.products.find({ tags: { $all: ["cotton", "red"] } })  // ✅ contains both, any order
db.products.find({ tags: { $size: 2 } })           // exactly 2 elements
```

### Classic `$elemMatch` bug

एक order:

```js
{ _id: 1, items: [ { sku: "MUG-01", qty: 1 }, { sku: "TEE-01", qty: 5 } ] }
```

Task: "ऐसे orders ढूँढो जिनमें किसी ने **5 या उससे ज़्यादा mugs** ख़रीदे।"

```js
// ❌ WRONG: matches order 1!
db.orders.find({ "items.sku": "MUG-01", "items.qty": { $gte: 5 } })
```

क्यों? हर condition array के against **अलग-अलग (independently)** check होती है: *कोई* item mug है (item 0), और *किसी* item की qty ≥ 5 है (item 1, यानी T-shirts)। अलग-अलग elements ने अलग-अलग conditions पूरी कर दीं।

```text
items[0] { sku: MUG-01, qty: 1 } ──► sku is MUG-01  ✔
items[1] { sku: TEE-01, qty: 5 } ──► qty >= 5       ✔
                     result: order 1 matches (wrong!)
```

```js
// ✅ RIGHT: both conditions on the SAME element
db.orders.find({ items: { $elemMatch: { sku: "MUG-01", qty: { $gte: 5 } } } })
```

यही जाल scalar arrays में भी है: `{ scores: { $gt: 5, $lt: 10 } }`, `[2, 12]` से match कर जाता है (12 > 5, 2 < 10)। `{ scores: { $elemMatch: { $gt: 5, $lt: 10 } } }` इस्तेमाल करें।

> **याद रखें:** जब दो या ज़्यादा conditions **एक ही array element** पर सच होनी चाहिए, तो `$elemMatch` इस्तेमाल करें। इसके बिना, हर condition किसी अलग element से पूरी हो सकती है।

## 6. Projection, sort, skip, limit

```js
db.products.find(
  { stock: { $gt: 0 } },
  { name: 1, price: 1, _id: 0 }   // projection: only these fields
).sort({ price: 1 }).skip(20).limit(10)
```

- Projection **या तो inclusion होता है या exclusion**। आप `{ name: 1, stock: 0 }` mix नहीं कर सकते; एकमात्र exception inclusion projection के अंदर `_id: 0` है।
- Apply होने का order हमेशा **sort → skip → limit** होता है, चाहे आप उन्हें किसी भी order में chain करें। `.limit(10).skip(20).sort({price: 1})` भी वही काम करता है।
- बड़ी `skip` values धीमी होती हैं, क्योंकि server फिर भी हर skipped document से होकर गुज़रता है। गहरे pages के लिए **range-based pagination** इस्तेमाल करें: `find({ price: { $gt: lastSeenPrice } }).limit(10)` (साथ में `_id` जैसा कोई tie-breaker)।

## 7. Update

`updateOne` पहला match बदलता है; `updateMany` सारे matches बदलता है। दूसरा argument **update operators** इस्तेमाल करता है:

```js
db.products.updateOne({ sku: "MUG-01" }, {
  $set:   { price: NumberDecimal("8.99"), "seo.title": "Mug" }, // set (creates path)
  $unset: { legacyCode: "" },              // remove a field
  $inc:   { stock: -1, "stats.sold": 1 }   // add / subtract
})
```

| Operator | क्या करता है | उदाहरण |
|---|---|---|
| `$set` / `$unset` | Field set / remove करना | `{ $set: { isActive: false } }` |
| `$inc` / `$mul` | जोड़ना / गुणा करना | `{ $inc: { stock: 5 } }` |
| `$min` / `$max` | सिर्फ़ तब update जब नई value कम / ज़्यादा हो | `{ $min: { lowestPrice: NumberDecimal("8") } }` |
| `$push` | Array में append करना | `{ $push: { tags: "sale" } }` |
| `$addToSet` | Append, अगर पहले से मौजूद न हो | `{ $addToSet: { tags: "sale" } }` |
| `$pull` | Matching elements हटाना | `{ $pull: { tags: "sale" } }` |
| `$pop` | पहला (`-1`) या आख़िरी (`1`) हटाना | `{ $pop: { recent: -1 } }` |

### `$each` और `$slice` के साथ `$push`: एक capped "recently viewed" list

```js
db.users.updateOne({ _id: userId }, {
  $push: { recentlyViewed: { $each: [productId], $slice: -10 } }
})
// appends, then keeps only the LAST 10 elements
```

### Array elements को update करना

```js
// $  → the FIRST element that matched the query
db.orders.updateOne({ _id: 1, "items.sku": "MUG-01" }, { $inc: { "items.$.qty": 1 } })

// $[] → ALL elements
db.orders.updateOne({ _id: 1 }, { $set: { "items.$[].shipped": true } })

// $[elem] + arrayFilters → all elements matching a condition
db.orders.updateOne(
  { _id: 1 },
  { $set: { "items.$[it].qty": 0 } },
  { arrayFilters: [{ "it.sku": "TEE-01" }] }
)
```

### Upsert: update या insert

```js
db.carts.updateOne(
  { userId: 7 },
  { $inc: { itemCount: 1 }, $setOnInsert: { createdAt: new Date() } },
  { upsert: true }
)
```

अगर कोई cart नहीं है, तो MongoDB filter (`userId: 7`) और update से बना एक नया document insert करता है। `$setOnInsert` वाले fields **सिर्फ़** insert पर लिखे जाते हैं।

⚠️ एक ही filter वाले दो concurrent upserts दोनों insert कर सकते हैं, जिससे duplicates बनते हैं, जब तक filter field (`userId`) पर **unique index** न हो। Index होने पर, सिर्फ़ एक insert जीत सकता है। Server हारने वाले को अपने-आप update के रूप में retry करता है, जब filter **unique index के fields पर equality match** हो और update उन fields को न बदले (जैसा यहाँ है); वरना हारने वाले को `E11000` duplicate-key error मिलती है और आपके code को उसे retry करना चाहिए।

### `replaceOne` vs `updateOne`

```js
db.products.replaceOne({ sku: "MUG-01" }, { sku: "MUG-01", name: "Mug" })
// the whole document is now { _id, sku, name }: price, stock, tags are GONE
```

| | `updateOne` | `replaceOne` |
|---|---|---|
| दूसरा argument | Update operators (`$set`…) | एक plain document |
| बाकी fields | बने रहते हैं | हट जाते हैं (सिर्फ़ `_id` बचता है) |
| दोनों को mix करने पर | "Update document requires atomic operators" | "Replacement document must not contain atomic operators" |

> **याद रखें:** `updateOne` fields edit करता है; `replaceOne` पूरा document बदल देता है। Mongoose का `findByIdAndUpdate` plain objects को आपके लिए `$set` में wrap कर देता है, इसीलिए कई developers को ये फ़र्क कभी पता ही नहीं चलता।

## 8. `findOneAndUpdate`: एक atomic step में read और write

आख़िरी lamp बेचना, ग़लत तरीके से:

```js
const p = await products.findOne({ sku: "LAMP-1" })     // stock: 1
if (p.stock > 0) await products.updateOne({ sku: "LAMP-1" }, { $inc: { stock: -1 } })
```

दो requests, किसी के भी write करने से पहले, दोनों `stock: 1` पढ़ सकती हैं, और आप 2 ऐसे lamps बेच देते हैं जो आपके पास हैं ही नहीं।

सही तरीका condition को update के **अंदर** रखता है:

```js
db.products.findOneAndUpdate(
  { sku: "LAMP-1", stock: { $gt: 0 } },   // condition
  { $inc: { stock: -1 } },                // change
  { returnDocument: "after" }             // return the new version
)
// returns null if out of stock
```

MongoDB में हर single-document write **atomic** होता है: match और modification एक साथ होते हैं, इसलिए बीच में कोई दूसरा write नहीं घुस सकता। `findOneAndUpdate` document को **return** भी करता है (default में update से *पहले* वाला version; `returnDocument: "after"` नया version देता है)।

> **याद रखें:** application code से कभी check-then-write न करें। Condition को filter में रखें और एक atomic operation को फ़ैसला करने दें। कई documents में बदलाव के लिए [transaction](/lessons/mongodb-transactions) इस्तेमाल करें।

## 9. Delete, count, bulk

```js
db.carts.deleteMany({ updatedAt: { $lt: ISODate("2026-01-01") } })
db.products.deleteOne({ sku: "OLD-01" })
db.products.deleteMany({})   // ⚠️ deletes everything (indexes stay)
```

| | `countDocuments(filter)` | `estimatedDocumentCount()` |
|---|---|---|
| कैसे | एक असली query (एक aggregation) चलाता है | Collection metadata पढ़ता है |
| Filter | हाँ | नहीं |
| Accuracy | Exact | ग़लत हो सकता है (जैसे unclean shutdown के बाद, या sharded cluster में orphaned docs) |
| Speed | Matched data के अनुपात में | लगभग तुरंत |

Admin header में "≈ 1.2M products" जैसी चीज़ के लिए `estimatedDocumentCount()`, और "आपकी cart में 3 items" के लिए `countDocuments` इस्तेमाल करें।

`bulkWrite` कई अलग-अलग operations एक ही round trip में भेजता है:

```js
db.products.bulkWrite([
  { updateOne: { filter: { sku: "MUG-01" }, update: { $inc: { stock: 50 } } } },
  { updateOne: { filter: { sku: "TEE-01" }, update: { $inc: { stock: 20 } } } },
  { deleteOne: { filter: { sku: "OLD-01" } } }
], { ordered: false })
```

`insertMany` की तरह, ये भी all-or-nothing **नहीं** है; `ordered` सिर्फ़ ये control करता है कि पहली error पर रुकना है या नहीं।

## 10. आम ग़लतियाँ

- ❌ `$elemMatch` के बिना array elements पर कई conditions।
- ❌ Conditional atomic update की जगह Node में read-then-write → overselling, double-spending।
- ❌ जब आपका मतलब `$set` था, तब `replaceOne` (या बिना operators वाला update)।
- ❌ ये उम्मीद करना कि `$ne: "cancelled"` बिना `status` वाले documents को छोड़ देगा।
- ❌ बहुत बड़ी `skip` values के साथ deep pagination।
- ❌ ये मान लेना कि `insertMany`/`bulkWrite` error पर roll back हो जाते हैं।
- ❌ बिना unique index वाले field पर upsert → concurrency में duplicates।

## 11. ध्यान रखने लायक trade-offs

- **Atomic सिर्फ़ हर document के लिए।** एक single update किसी order *और* inventory document को atomically नहीं बदल सकता। या तो उन्हें साथ में model करें, या transaction इस्तेमाल करें (जो ज़्यादा महँगा है)।
- **Rich updates vs readability.** `arrayFilters` और positional operators powerful हैं, लेकिन इनमें ग़लती करना आसान है; पहले sample data पर test करें।
- **Counting मुफ़्त नहीं है।** बड़े filters पर exact counts data scan करते हैं; जब exactness ज़रूरी न हो तो cache करें या estimate करें।
- Complex reshaping, grouping और joins की जगह [aggregation pipeline](/lessons/mongodb-aggregation) है, आपके code में `find` calls की chains नहीं।
