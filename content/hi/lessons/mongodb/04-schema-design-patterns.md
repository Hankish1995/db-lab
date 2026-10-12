---
slug: mongodb-schema-patterns
title: 'Schema design patterns: आम समस्याओं के लिए आज़माए हुए shapes'
module: Data Modeling
summary: 'MongoDB के वो दस schema design patterns जिनके बारे में interviewers पूछते हैं, हर एक के साथ वो समस्या जो वो हल करता है, एक e-commerce उदाहरण, और कब उसे इस्तेमाल नहीं करना चाहिए।'
recap: >-
  Schema patterns बार-बार आने वाली modeling समस्याओं के reusable जवाब हैं। Attribute बहुत सारे optional fields को
  काबू में करता है, bucket छोटे time-based records को group करता है, computed महँगी values पहले से calculate कर
  लेता है, subset और extended reference related data का सिर्फ़ hot हिस्सा copy करते हैं, outlier कभी-कभार आने वाले
  बहुत बड़े document को संभालता है, polymorphic और schema versioning अलग-अलग shapes संभालते हैं, approximation
  write load घटाता है, और tree patterns hierarchies को model करते हैं। हर pattern तेज़ reads के बदले write
  complexity या duplication का सौदा करता है।
---

## 1. कहानी: एक chef की prep tricks

एक व्यस्त restaurant kitchen हर dish को order आने पर शुरू से नहीं बनाता। Chefs **prep tricks** इस्तेमाल करते हैं:

- Sauces सुबह **batches में** बनाए जाते हैं (bucket)।
- Soup of the day **पहले से पका** होता है; कोई उसे हर order पर नहीं उबालता (computed)।
- हर station पर **सबसे ज़्यादा इस्तेमाल होने वाली कुछ चीज़ें** हाथ के पास रहती हैं; बाकी walk-in fridge में रहती हैं (subset)।
- 40-course tasting menu वाली एक VIP table को **अलग से संभाला** जाता है, ताकि वो बाकी हर table को धीमा न करे (outlier)।

ये tricks recipes नहीं हैं। ये **patterns** हैं जिन्हें कोई भी kitchen कई dishes पर लगा सकता है। MongoDB के **schema design patterns** भी ऐसे ही हैं: बार-बार आने वाली समस्याओं के लिए reusable shapes, जो [Schema design](/lessons/mongodb-schema-design) के golden rule पर बने हैं।

> **याद रखें:** लगभग हर pattern **तेज़, आसान reads** के बदले **writes पर ज़्यादा काम** (या कुछ duplication) का सौदा करता है। किसी pattern को तभी इस्तेमाल करें जब आपका read pattern उस क़ीमत को justify करे।

## 2. Attribute pattern

**समस्या:** products में दर्जनों optional, type-specific fields होते हैं (`ram`, `screenSize`, `fabric`, `capacityMl`…)। इन पर filter करने के लिए आपको हर field पर एक index चाहिए होगा।

**हल:** इन्हें key–value pairs के array में ले जाइए और pair पर एक ही बार index बनाइए।

```js
{ _id: "LAPTOP-7", name: "Ultrabook 14",
  attrs: [ { k: "ram", v: "16GB" }, { k: "cpu", v: "M3" }, { k: "screen", v: 14 } ] }

db.products.createIndex({ "attrs.k": 1, "attrs.v": 1 })
db.products.find({ attrs: { $elemMatch: { k: "ram", v: "16GB" } } })
```

`$elemMatch` पर ध्यान दें: key और value को **एक ही** element में match होना चाहिए।

**कब इस्तेमाल न करें:** जब सिर्फ़ कुछ ही known fields हों (plain fields को query और validate करना आसान है)। Normal sub-document पर **wildcard index** (`{ "specs.$**": 1 }`) एक alternative है, जो natural shape बनाए रखता है।

## 3. Bucket pattern

**समस्या:** हर page view या हर price change का एक document लाखों छोटे-छोटे documents बना देता है, जिनमें से हर एक का अपना `_id` और index entries होती हैं।

**हल:** events को हर **time window** का एक document बनाकर group कीजिए (मान लीजिए, हर product का हर घंटे एक)।

```js
// productViews: one bucket per product per hour
{ productId: "TEE-01", hour: ISODate("2026-10-11T10:00:00Z"),
  count: 3, views: [ { at: ISODate("2026-10-11T10:02:11Z"), userId: 7 }, /* … */ ] }

db.productViews.updateOne(
  { productId: "TEE-01", hour: ISODate("2026-10-11T10:00:00Z"), count: { $lt: 1000 } },
  { $push: { views: { at: new Date(), userId: 7 } }, $inc: { count: 1 } },
  { upsert: true }
)
```

`count: { $lt: 1000 }` वाला cap buckets को bounded रखता है: भरा हुआ bucket अब match नहीं करता, इसलिए upsert एक नया bucket शुरू कर देता है।

**आधुनिक alternative:** समय के साथ आने वाले measurements के लिए built-in **time series collection** इस्तेमाल करें। MongoDB data को आपके लिए अंदर ही अंदर bucket करता है, compression और time-based queries के साथ:

```js
db.createCollection("productViews", {
  timeseries: { timeField: "at", metaField: "productId", granularity: "minutes" }
})
```

**कब इस्तेमाल न करें:** जब आप ज़्यादातर **individual events** को ID से access करते हों या उन्हें अक्सर update करते हों। सीधे-सादे time-series data के लिए हाथ से बनाए buckets की जगह time series collections को तरजीह दें।

## 4. Computed pattern

**समस्या:** product page पर "4.3 ★ (1,284 reviews)" दिखता है। इसे हर page view पर सारे reviews पर aggregation चलाकर calculate करना बर्बादी है: reads की गिनती नए reviews से हज़ारों गुना ज़्यादा है।

**हल:** write पर compute करें, नतीजा store करें।

```js
// when a review is added
db.products.updateOne({ _id: "TEE-01" }, { $inc: { ratingCount: 1, ratingSum: 5 } })
// ratingAvg = ratingSum / ratingCount (store it too, or compute when reading)
```

Order का `total`, `itemCount` और किसी user का `lifetimeSpend` भी यही idea है।

**कब इस्तेमाल न करें:** जब value कम ही पढ़ी जाती हो, या inputs इतनी बार बदलते हों कि दोबारा compute करना पढ़ने से ज़्यादा महँगा पड़े। Drift से भी सावधान रहें: अगर कोई write path computed field update करना भूल जाए, तो वो चुपचाप ग़लत हो जाता है। एक periodic job रखें जो source से दोबारा compute करे।

> **याद रखें:** data बदलने पर एक बार compute करें, हर बार किसी के पढ़ने पर नहीं, बशर्ते reads की गिनती writes से बहुत ज़्यादा हो।

## 5. Subset pattern

**समस्या:** सारे reviews embed करने से product document बहुत बड़ा हो जाता है, लेकिन page सिर्फ़ **latest 10** दिखाता है।

**हल:** hot subset embed करें, पूरा set उसकी अपनी collection में रखें।

```js
// products
{ _id: "TEE-01", name: "T-Shirt", ratingAvg: 4.3,
  recentReviews: [ { user: "Asha", rating: 5, text: "Great fit" } /* max 10 */ ] }

// on new review: insert into reviews AND keep the newest 10 in the product
db.reviews.insertOne({ productId: "TEE-01", user: "Asha", rating: 5, text: "Great fit" })
db.products.updateOne({ _id: "TEE-01" }, {
  $push: { recentReviews: { $each: [{ user: "Asha", rating: 5, text: "Great fit" }],
                            $position: 0, $slice: 10 } }
})
```

**कब इस्तेमाल न करें:** जब UI को आमतौर पर वैसे भी पूरा set चाहिए, या जब subset को sync में रखना मुश्किल हो (जैसे reviews अक्सर edit या delete होते हों)।

## 6. Extended reference pattern

**समस्या:** order list में customer का नाम और shipping address दिखता है। हर order view पर `users` से `$lookup` महँगा है, और user का *current* address तो सही address भी नहीं है।

**हल:** referenced document से **सिर्फ़ ज़रूरी कुछ fields** reference के साथ copy कर लें।

```js
{ _id: 9001,
  customer: { _id: 1, name: "Asha Rao" },          // extended reference
  shipTo: { line1: "12 MG Road", city: "Pune", pin: "411001" },
  items: [ /* … */ ] }
```

**कब इस्तेमाल न करें:** जब copy किए गए fields अक्सर बदलते हों और उन्हें हर जगह sync में रहना हो। सिर्फ़ वो fields copy करें जो stable हैं या जिन्हें snapshot की तरह freeze रहना चाहिए।

## 7. Outlier pattern

**समस्या:** 99.9% products के 500 से कम reviews हैं, लेकिन एक viral product के **2 million** हैं। सब कुछ outlier के हिसाब से design करने की सज़ा सारे normal products को मिलती है।

**हल:** common case के लिए design करें, और outliers को **flag** करें ताकि वो extra documents में overflow हो जाएँ।

```js
// normal product
{ _id: "MUG-01", reviewIds: [/* up to 500 */] }

// outlier: flagged, extra reviews live in overflow docs
{ _id: "VIRAL-1", reviewIds: [/* first 500 */], hasOverflow: true }
{ productId: "VIRAL-1", page: 2, reviewIds: [/* next 500 */] }
```

App `hasOverflow` check करती है और सिर्फ़ उन गिने-चुने products के लिए overflow documents fetch करती है।

**कब इस्तेमाल न करें:** जब outliers दुर्लभ न हों; तब आपका "normal" design ही ग़लत है। App को दो code paths भी संभालने पड़ते हैं।

## 8. Polymorphic pattern

**समस्या:** books, laptops और T-shirts सब "products" हैं, लेकिन इनके fields अलग-अलग हैं। अलग collections बनाने से "सारे products में search" करना सिरदर्द बन जाएगा।

**हल:** एक collection, एक common core, और एक **type discriminator**।

```js
{ type: "book",   name: "DDIA",   price: NumberDecimal("45.00"), author: "Kleppmann", pages: 616 }
{ type: "laptop", name: "Air 14", price: NumberDecimal("999.00"), ramGb: 16, cpu: "M3" }
{ type: "tshirt", name: "Tee",    price: NumberDecimal("19.99"), sizes: ["M", "L"] }
```

Shared fields (`name`, `price`) पर shared indexes बनते हैं; type-specific queries filter में `type` जोड़ देती हैं। Mongoose के **discriminators** ठीक यही implement करते हैं।

**कब इस्तेमाल न करें:** जब types में लगभग कुछ भी common न हो और वो कभी साथ में query न होते हों; तब अलग collections ज़्यादा साफ़ हैं।

## 9. Schema versioning pattern

**समस्या:** आप `address` (एक string) को एक structured sub-document में बदल रहे हैं। 50 million users को एक साथ migrate करने का मतलब है एक लंबा, risky job या downtime।

**हल:** एक `schemaVersion` field जोड़ें। App दोनों versions पढ़ती है, नया version लिखती है, और documents **धीरे-धीरे** migrate होते हैं (read पर, write पर या किसी background job से)।

```js
{ _id: 1, schemaVersion: 1, address: "12 MG Road, Pune 411001" }
{ _id: 2, schemaVersion: 2, address: { line1: "12 MG Road", city: "Pune", pin: "411001" } }
```

**कब इस्तेमाल न करें:** छोटी collections के लिए, जहाँ एक तेज़ one-time migration आसान है। और पुराने versions को हमेशा के लिए ज़िंदा न रहने दें: migration पूरा करें और पुराना code path हटा दें।

> **याद रखें:** schema versioning pattern एक risky big-bang migration को एक gradual, zero-downtime migration में बदल देता है।

## 10. Approximation pattern

**समस्या:** किसी व्यस्त product पर "1.2M बार देखा गया" counter का मतलब है उसी hot document पर हर view पर एक write।

**हल:** जब exact number ज़रूरी न हो, तो **कम बार update करें**: लगभग हर 100 views में एक बार 100 से increment करें।

```js
// in the app
if (Math.random() < 0.01) {
  db.products.updateOne({ _id: "TEE-01" }, { $inc: { viewCount: 100 } })
}
```

Writes लगभग 100× घट जाते हैं; count statistically क़रीब रहता है।

**कब इस्तेमाल न करें:** हर उस चीज़ के लिए जो exact होनी चाहिए: stock, पैसा, order counts, billing।

## 11. Tree patterns: category hierarchy

```text
Electronics
├── Computers
│   ├── Laptops
│   └── Desktops
└── Phones
```

| Pattern | हर category क्या store करती है | किसमें अच्छा | किसमें कमज़ोर |
|---|---|---|---|
| **Parent references** | `parent: "Computers"` | Parent ढूँढना; subtree move करना | सारे descendants (`$graphLookup` चाहिए) |
| **Child references** | `children: ["Laptops", "Desktops"]` | Children ढूँढना | Parent/ancestors ढूँढना |
| **Array of ancestors** | `ancestors: ["Electronics", "Computers"]`, `parent` | Breadcrumbs; "X के नीचे सब कुछ" | Subtrees move करना (कई docs दोबारा लिखने पड़ते हैं) |
| **Materialized path** | `path: ",Electronics,Computers,"` | Prefix regex से subtree | Subtrees move करना; string discipline |

```js
// array of ancestors: breadcrumbs in one read, subtree via index
{ _id: "Laptops", parent: "Computers", ancestors: ["Electronics", "Computers"] }
db.categories.createIndex({ ancestors: 1 })
db.categories.find({ ancestors: "Computers" })      // everything under Computers

// materialized path: anchored, case-sensitive prefix regex can use an index
{ _id: "Laptops", path: ",Electronics,Computers," }
db.categories.createIndex({ path: 1 })
db.categories.find({ path: /^,Electronics,Computers,/ })

// parent references: walk the tree on the server
db.categories.aggregate([
  { $match: { _id: "Electronics" } },
  { $graphLookup: { from: "categories", startWith: "$_id",
                    connectFromField: "_id", connectToField: "parent",
                    as: "descendants" } }
])
```

E-commerce के लिए **array of ancestors** एक मज़बूत default है: category trees लगातार पढ़े जाते हैं (breadcrumbs, "Computers के नीचे सारे laptops") और कभी-कभार ही restructure होते हैं।

## 12. आम ग़लतियाँ

- ❌ Patterns को इसलिए लगाना क्योंकि वो मौजूद हैं, इसलिए नहीं कि किसी measured query को उनकी ज़रूरत है।
- ❌ Computed या subset fields, बिना किसी plan के कि उन्हें सही कैसे रखा जाएगा (छूटे हुए write paths, edits, deletes)।
- ❌ हाथ से बनाए buckets **बिना size cap के**, जो unbounded array वाली समस्या फिर से पैदा कर देते हैं।
- ❌ ऐसी values के लिए approximation इस्तेमाल करना जो exact होनी चाहिए।
- ❌ Extended references जो तेज़ी से बदलने वाले fields copy करते हैं।

## 13. Summary: pattern → वो समस्या जो वो हल करता है

| Pattern | कौन-सी समस्या हल करता है | E-commerce उदाहरण |
|---|---|---|
| Attribute | Search करने के लिए बहुत सारे sparse fields | Product specs |
| Bucket | बहुत सारे छोटे time-based documents | Hourly page views, price history |
| Computed | महँगी value जो बदलने से कहीं ज़्यादा पढ़ी जाती है | Rating average, order total |
| Subset | बहुत बड़ा related set, जिसका सिर्फ़ एक हिस्सा दिखता है | Product में latest 10 reviews |
| Extended reference | कुछ fields के लिए बार-बार `$lookup` | Order में customer का नाम और address |
| Outlier | कुछ documents बाकियों से कहीं ज़्यादा बड़े | लाखों reviews वाला viral product |
| Polymorphic | मिलती-जुलती entities, अलग-अलग fields | `products` में books, laptops, T-shirts |
| Schema versioning | बिना downtime के shape बदलना | Address string → sub-document |
| Approximation | Hot counters जहाँ exactness मायने नहीं रखती | View counts |
| Tree patterns | Hierarchies | Category tree, breadcrumbs |

> **याद रखें:** interview में **पहले समस्या** बताइए, फिर pattern, फिर उसकी **cost**। "Product page हर view पर average rating calculate करता है, इसलिए मैं computed pattern इस्तेमाल करूँगा और हर नए review पर extra write की cost स्वीकार करूँगा।"

## 14. Trade-offs

- **Write complexity:** ज़्यादातर patterns writes में काम जोड़ते हैं या एक background job माँगते हैं। उस code की ज़िम्मेदारी किसी को लेनी होगी।
- **Consistency windows:** duplicated या computed data थोड़ी देर के लिए stale हो सकता है। हर field के लिए तय करें कि ये स्वीकार्य है या नहीं।
- **Multi-document updates:** किसी subset या computed field को दूसरी collection के साथ sync में रखने के लिए [transaction](/lessons/mongodb-transactions) की ज़रूरत पड़ सकती है, अगर उनमें कभी भी असहमति नहीं होनी चाहिए।
- **जहाँ built-ins मौजूद हों, उन्हें तरजीह दें:** manual buckets की जगह time series collections, जहाँ fit हो वहाँ attribute pattern की जगह wildcard indexes, और कभी-कभार के deep tree walks के लिए `$graphLookup`।
