---
slug: mongodb-schema-design
title: 'Schema design: data को उस तरह model करना जैसे आप उसे पढ़ते हैं'
module: Data Modeling
summary: 'अपनी queries से शुरू करके MongoDB schemas कैसे design करें, embed vs reference कब चुनें, हर तरह के relationship को कैसे model करें, और किन anti-patterns से बचें।'
recap: >-
  जो data साथ में access होता है, उसे साथ में store करना चाहिए। Entities से नहीं, बल्कि उन queries से शुरू करें
  जो आपकी app चलाती है। छोटा, bounded data जो parent के साथ पढ़ा जाता है, उसे embed करें; जो data बड़ा,
  unbounded, shared है या अपने-आप में update होता है, उसे reference करें। Data duplicate करना ठीक है जब वो अक्सर
  पढ़ा जाता हो और कभी-कभार बदलता हो, या जब उसे समय में freeze रहना हो, जैसे किसी order पर लिखा price।
---

## 1. कहानी: सफ़र के लिए packing

आप एक हफ़्ते के सफ़र के लिए packing कर रहे हैं।

- **Toothbrush, charger, passport:** ये आपको हर दिन, एक साथ चाहिए। ये **एक ही bag में** जाते हैं (**embed**)।
- **आपके winter coats का पूरा collection:** बड़ा है, और आपको ज़्यादा से ज़्यादा एक चाहिए। आप **एक note छोड़ देते हैं** कि "coats hall की अलमारी में हैं" (**reference**)।
- **Hotel booking की एक photo:** आप इसे अपने phone में **copy** कर लेते हैं, जबकि original आपके email में है, क्योंकि front desk पर बिना Wi-Fi के इसकी ज़रूरत पड़ेगी (**duplication**)।

कोई भी category के हिसाब से pack नहीं करता ("सारे कपड़े एक bag में, सारे papers दूसरे में, सारे electronics तीसरे में")। आप इस हिसाब से pack करते हैं कि **कौन-सी चीज़ें साथ में इस्तेमाल होंगी**।

> **याद रखें:** golden rule: **जो data साथ में access होता है, उसे साथ में store करना चाहिए।**

## 2. MongoDB में modeling अलग क्यों है

SQL में, आप **पहले normalize करते हैं**: हर entity की एक table, कोई duplication नहीं, और बाद में joins से कोई भी सवाल हल हो जाता है। Schema **data** से तय होता है।

MongoDB में, schema **workload** से तय होता है:

1. Operations की list बनाइए: "product page दिखाओ", "order place करो", "मेरे orders की list दिखाओ"।
2. अंदाज़ा लगाइए कि हर operation कितनी बार चलता है और कितना data छूता है।
3. Documents को ऐसा shape दीजिए कि **सबसे ज़्यादा चलने वाले operations एक ही document पर पहुँचें**, और अच्छा हो कि एक ही index lookup में।

```text
SQL thinking                    MongoDB thinking
┌──────────────────────┐        ┌──────────────────────┐
│ 1. What entities?    │        │ 1. What queries?     │
│ 2. Normalize them    │        │ 2. How often? How big│
│ 3. Write any query   │        │ 3. Shape docs to fit │
│    with joins later  │        │    the hot queries   │
└──────────────────────┘        └──────────────────────┘
```

जो model एक app के लिए शानदार है, वो दूसरी app के लिए बहुत ख़राब हो सकता है, भले ही entities वही हों पर queries अलग हों। कोई एक "सही" schema नहीं होता।

> **याद रखें:** अपनी queries के लिए design करें, entities के लिए नहीं। Read-heavy product page और write-heavy event log को अलग-अलग shapes चाहिए, भले ही data मिलता-जुलता हो।

## 3. Embed vs reference

**Embedding** related data को parent document के अंदर रखता है। **Referencing** related data को उसकी अपनी collection में store करता है और उसका `_id` parent (या child) में रखता है।

```js
// Embedded: address lives inside the user
{ _id: 1, name: "Asha", address: { city: "Pune", pin: "411001" } }

// Referenced: the order points to the user
{ _id: 9001, userId: 1, total: NumberDecimal("59.98") }
```

| सवाल | **Embed** की ओर झुकाव | **Reference** की ओर झुकाव |
|---|---|---|
| Parent के साथ पढ़ा जाता है? | लगभग हमेशा | अक्सर अकेले पढ़ा जाता है |
| कितने? | कुछ ही, **bounded** | बहुत सारे या **unbounded** |
| अपने-आप में बदलता है? | कभी-कभार | अक्सर |
| कई parents में shared? | नहीं | हाँ (एक category, कई products) |
| Parent के साथ atomic update चाहिए? | हाँ (single-doc atomicity) | नहीं |
| Size | छोटा | बड़ा |

Embedding से आपको **एक read** और **atomic updates** मुफ़्त में मिलते हैं (single document पर writes atomic होते हैं)। Referencing से आपको **छोटे documents**, **कोई duplication नहीं** और **independent growth** मिलती है, बदले में एक दूसरी query या `$lookup` की cost देनी पड़ती है।

## 4. Relationship types

### One-to-one: embed करें

एक user और उसकी profile settings। जब तक data बहुत बड़ा न हो या बहुत कम पढ़ा जाता हो, इसे embed करें।

```js
{ _id: 1, email: "asha@shop.in", settings: { currency: "INR", newsletter: true } }
```

### One-to-few: एक array embed करें

एक user के 1–5 saved addresses हैं। Bounded है और हमेशा user के साथ दिखता है।

```js
{ _id: 1, name: "Asha",
  addresses: [ { label: "home", city: "Pune" }, { label: "work", city: "Mumbai" } ] }
```

### One-to-many: parent में references का array

एक product के कुछ दर्जन से लेकर कुछ सौ parts या variants हैं, जो अपने-आप में भी query होते हैं। उनकी IDs parent में रखें:

```js
// products
{ _id: "BUNDLE-1", name: "Desk setup", partIds: ["LAMP-1", "MAT-2", "CHAIR-7"] }
```

ये तब तक काम करता है जब तक list **bounded** रहे (सैकड़ों में, लाखों में नहीं)।

### One-to-squillions: child से parent की ओर reference

एक product के **लाखों page-view logs** हैं, या किसी popular product पर **सैकड़ों हज़ार reviews** आते हैं। Product के अंदर array हमेशा बढ़ता रहेगा और आख़िरकार 16 MB limit तोड़ देगा। इसे उलट दीजिए: हर child parent की ID store करता है।

```js
// reviews: each review points to its product
{ _id: ObjectId("..."), productId: "TEE-01", userId: 1, rating: 5, text: "Great fit" }

db.reviews.createIndex({ productId: 1, createdAt: -1 })
db.reviews.find({ productId: "TEE-01" }).sort({ createdAt: -1 }).limit(20)
```

### Many-to-many: references के arrays (एक या दोनों तरफ़)

Products ↔ categories। एक product कुछ categories में होता है; एक category में बहुत सारे products होते हैं। छोटी तरफ़ को array के रूप में store करें:

```js
// products
{ _id: "TEE-01", name: "T-Shirt", categoryIds: ["men", "summer", "cotton"] }

db.products.createIndex({ categoryIds: 1 })   // multikey index
db.products.find({ categoryIds: "summer" })   // all products in a category
```

हर category के अंदर भी `productIds` store करने से category document unbounded हो जाएगा। Array को उस तरफ़ रखें जो छोटी रहती है।

```text
Relationship        Typical size       Model
───────────────────────────────────────────────────────
One-to-one          1                  embed
One-to-few          few, bounded       embed array
One-to-many         hundreds           array of refs
One-to-squillions   unbounded          child → parent ref
Many-to-many        both sides many    refs on small side
```

> **याद रखें:** सवाल सिर्फ़ "one-to-many?" नहीं है, बल्कि "one-to-**कितने**?" है। Bounded और छोटा: embed करें। Unbounded: child, parent की ओर point करे।

## 5. Duplication एक tool है, पाप नहीं

SQL में, data duplicate करना normalization की नाकामी है। MongoDB में, ये एक सोचा-समझा trade-off है: **मुश्किल updates के बदले तेज़ reads**।

सबसे अच्छा उदाहरण: **order line items**।

```js
// orders
{
  _id: 9001,
  userId: 1,
  items: [
    { productId: "TEE-01", name: "T-Shirt", price: NumberDecimal("19.99"), qty: 2 }
  ],
  total: NumberDecimal("39.98"),
  createdAt: ISODate("2026-10-11T10:00:00Z")
}
```

Order में `name` और `price` copy करना सिर्फ़ "तेज़" नहीं है; ये **सही** है। अगर अगले महीने T-shirt ₹24.99 की हो जाए, तब भी इस order पर ₹19.99 ही लिखा होना चाहिए: customer ने यही pay किया था, और invoice व refund logic को यही चाहिए। Current product से join करने पर **ग़लत** price दिखेगा।

Duplicate करने से पहले पूछिए:

- **Copy किया गया field कितनी बार बदलता है?** Product name: कभी-कभार। Stock level: लगातार। Stock copy न करें।
- **क्या copy को sync में रहना है, या ये एक snapshot है?** Order prices snapshots हैं: उन्हें कभी update न करें।
- **अगर sync करना है, तो कितनी copies हैं?** 50,000 products में एक category name update करना एक background job है, जिसकी ज़िम्मेदारी आपको लेनी होगी।

> **याद रखें:** वो data duplicate करें जो **अक्सर पढ़ा जाता है और कभी-कभार बदलता है**, या जिसे **समय में freeze** रहना है (order पर prices)। Stock counts जैसा तेज़ी से बदलने वाला data कभी duplicate न करें।

## 6. जब सच में join चाहिए: `$lookup`

MongoDB [aggregation pipeline](/lessons/mongodb-aggregation) में `$lookup` से join कर सकता है:

```js
db.orders.aggregate([
  { $match: { userId: 1 } },
  { $lookup: { from: "users", localField: "userId",
               foreignField: "_id", as: "user" } },
  { $unwind: "$user" }
])
```

इसकी cost:

- हर input document के लिए, MongoDB को दूसरी collection में matches ढूँढने पड़ते हैं। **`foreignField` पर index बनाइए**; index के बिना, server को foreign collection scan करनी पड़ती है (नए query engines इसकी जगह उससे hash table बना सकते हैं), जो data बढ़ने के साथ महँगा होता जाता है।
- ये हर read पर एक extra stage है, इसलिए **admin screens और reports** के लिए ठीक है, लेकिन आपके सबसे hot path पर ये एक smell है।
- [Sharded](/lessons/sharding) cluster में shards के पार joins और भी महँगे होते हैं।

अगर आपके सबसे ज़्यादा खुलने वाले page को हर request पर `$lookup` चाहिए, तो शायद आपके schema ने उस data को अलग कर दिया है जो साथ में access होता है।

## 7. पूरा e-commerce model

```text
┌───────────┐  userId   ┌──────────────────────────┐
│  users    │◄──────────│ orders                   │
│ addresses │           │ items[] = copies of      │
│ (embedded)│           │ name, price, qty         │
└─────▲─────┘           │ shipping address (copy)  │
      │ userId          └──────────────────────────┘
┌─────┴─────┐ productId ┌──────────────────────────┐
│  reviews  │──────────►│ products                 │
│ (own coll)│           │ variants[], categoryIds[]│
└───────────┘           │ ratingAvg, ratingCount   │
                        └────────────▲─────────────┘
┌───────────┐ productId              │
│ inventory │────────────────────────┘
│ per store │
└───────────┘
```

| Collection | मुख्य फ़ैसले | क्यों |
|---|---|---|
| `users` | Addresses embed करें (bounded) | हमेशा user के साथ दिखते हैं; 1–5 items |
| `products` | Variants और specs embed करें; `categoryIds` array; पहले से calculate किए `ratingAvg`/`ratingCount` | Product page = एक read; categories many-to-many हैं |
| `orders` | `userId` reference करें; product name/price और shipping address order में **copy** करें | Order एक historical snapshot है; products या addresses बदलने पर इसे नहीं बदलना चाहिए |
| `reviews` | अलग collection, हर review पर `productId` | Unbounded (one-to-squillions); अलग से page होते हैं |
| `inventory` | अलग collection, हर store/warehouse में हर product का एक doc | कई writers इसे लगातार update करते हैं; product docs stable रहते हैं और write contention से बचते हैं |

Inventory को products में embed क्यों न करें? Stock हर sale पर बदलता है, जबकि product details कभी-कभार बदलती हैं। इन्हें अलग रखने का मतलब है कि hot stock updates बड़े product documents को दोबारा नहीं लिखते, और read-heavy product page cache हो सकता है।

> **याद रखें:** हर फ़ैसला किसी query से आता है: "product page दिखाओ" → variants embed करो; "reviews की list दिखाओ" → अलग collection; "2024 का invoice print करो" → prices को order में copy करो।

## 8. Anti-patterns

- **बहुत बड़े या unbounded arrays.** हर review, log line या follower एक ही document के अंदर। हर update एक बढ़ते हुए document को दोबारा लिखता है, array पर बने indexes फूलते जाते हैं, और आख़िरकार आप 16 MB से टकराते हैं।
- **बहुत सारी collections.** हर customer या हर दिन की एक collection ("orders_2026_10_11")। हर collection और index का storage-engine overhead होता है, और उनके पार queries करना सिरदर्द बन जाता है। इसकी जगह एक field और एक index इस्तेमाल करें।
- **ग़ैर-ज़रूरी indexes.** हर index हर write को धीमा करता है और RAM इस्तेमाल करता है। सिर्फ़ असली queries के लिए index बनाइए (देखें [MongoDB indexes](/lessons/mongodb-indexes))।
- **हमेशा साथ पढ़े जाने वाले data को अलग करना.** "Normalize करने के लिए" product के variants को उनकी अपनी collection में रखने से हर product view पर दूसरी query या `$lookup` करना पड़ता है।
- **फूले हुए documents.** बड़ा, कम पढ़ा जाने वाला data (किसी product की पूरी change history) ऐसे document में embed करना जो लगातार पढ़ा जाता है। हर read उसे साथ घसीटता है।
- **तेज़ी से बदलने वाला data copy करना.** Stock levels को category pages में duplicate करने का मतलब है हर sale पर writes का तूफ़ान।

## 9. Embedding vs referencing एक नज़र में

| | Embedding | Referencing |
|---|---|---|
| Reads | ✅ एक query | ❌ Extra query या `$lookup` |
| Parent के साथ atomic update | ✅ Single-document atomic | ❌ Transaction चाहिए |
| Document size | ❌ Children के साथ बढ़ता है | ✅ छोटा रहता है |
| Duplication | ⚠️ अक्सर duplicate होता है | ✅ एक ही बार store होता है |
| Children की अलग से query | ❌ अटपटा | ✅ स्वाभाविक |
| Unbounded children | ❌ 16 MB पर टूट जाता है | ✅ ठीक है |

## 10. Trade-offs और कब ये approach नुकसान करता है

- **बदलते access patterns.** आज की queries के लिए tune किया गया schema product बदलने पर ठीक से fit नहीं बैठ सकता। [Schema versioning pattern](/lessons/mongodb-schema-patterns) इस्तेमाल करें और धीरे-धीरे migrate करें।
- **Duplication को एक owner चाहिए.** हर copy के लिए एक नियम चाहिए: snapshot (कभी update नहीं) या sync (कौन update करेगा, और कितनी जल्दी?)।
- **बहुत ज़्यादा relational, ad-hoc analytics.** अगर मुख्य काम कई entities के पार मनचाहे joins करना है, तो relational database या एक अलग analytics store बेहतर fit हो सकता है (देखें [SQL vs NoSQL](/lessons/sql-vs-nosql))।
- **Multi-document consistency.** अगर आपको बार-बार कई अलग documents को atomically update करना पड़ता है, तो या तो उन्हें embed करें, या [transactions](/lessons/mongodb-transactions) की cost स्वीकार करें।
