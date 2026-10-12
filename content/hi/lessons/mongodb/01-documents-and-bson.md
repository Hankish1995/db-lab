---
slug: mongodb-documents-and-bson
title: 'Documents और BSON: MongoDB आपका data असल में कैसे store करता है'
module: Basics
summary: 'MongoDB document क्या होता है, BSON और JSON में क्या फ़र्क है, कौन-से BSON types ज़रूरी हैं, और flexible schema को control में कैसे रखें।'
recap: >-
  MongoDB data को documents के रूप में store करता है: self-contained records, जो एक database के अंदर collections में
  group होते हैं। Disk पर और network पर ये BSON होते हैं, यानी JSON का binary, typed और तेज़ी से traverse होने वाला
  version, जिसमें ObjectId, Date, Int64 और Decimal128 जैसे extra types हैं। हर document को एक unique, immutable _id
  चाहिए और उसे 16 MB से छोटा रहना होगा। Schema flexible है, लेकिन production apps फिर भी $jsonSchema validation से
  structure enforce करते हैं।
---

## 1. कहानी: folders से भरी एक filing cabinet

एक छोटी दुकान के back office की कल्पना कीजिए। वहाँ एक **filing cabinet** है। हर drawer पर label लगा है ("Products", "Orders", "Customers")। हर drawer के अंदर **folders** हैं, हर product या order का एक।

किसी एक product का folder खोलिए, तो **उस product के बारे में सब कुछ अंदर ही है**: नाम, price, sizes की list, supplier की details वाली एक sheet। Product को समझने के लिए आपको किसी दूसरे drawer तक भागना नहीं पड़ता।

```text
┌────────────── Cabinet: "shop" ────────────────┐
│ ┌─ Drawer: products ─┐ ┌─ Drawer: orders ───┐ │
│ │ ▣ folder: Mug      │ │ ▣ folder: #1001    │ │
│ │ ▣ folder: T-shirt  │ │ ▣ folder: #1002    │ │
│ │ ▣ folder: Lamp     │ │ ▣ folder: #1003    │ │
│ └────────────────────┘ └────────────────────┘ │
└───────────────────────────────────────────────┘
```

इसे MongoDB से map करें:

| Filing cabinet | MongoDB | SQL में लगभग इसके बराबर |
|---|---|---|
| पूरी cabinet | **Database** | Database / schema |
| एक drawer | **Collection** | Table |
| एक folder | **Document** | Row (और उसकी child rows) |
| किसी sheet पर लगा label | **Field** | Column |
| Folder का number | **`_id`** | Primary key |

SQL से सबसे बड़ा फ़र्क: एक folder में **nested sheets और lists** हो सकती हैं। SQL की row flat होती है; document में arrays और sub-documents हो सकते हैं।

> **याद रखें:** document एक self-contained folder है। किसी एक "चीज़" के बारे में आपको आमतौर पर जो कुछ चाहिए, वो सब उसके अंदर रह सकता है।

## 2. Document model क्यों बना

Relational database में, 3 sizes और 2 images वाला एक product आमतौर पर 3 tables में बँटा होता है, और उसे दोबारा जोड़ने के लिए joins चाहिए। फिर आपका Node.js code उन rows को वापस एक object में बदलता है।

MongoDB object को **उसी shape में store करता है जो आपका code पहले से इस्तेमाल करता है**:

- **कम joins:** एक read में पूरा product मिल जाता है।
- **Natural mapping:** document बिल्कुल उस JS object जैसा दिखता है जिसे आप JSON बनाकर React को भेजते हैं।
- **Flexible evolution:** नए documents में एक field जोड़िए, बिना ऐसी migration के जो किसी बड़ी table को lock कर दे।

Trade-off यह है: आपको documents को **इस हिसाब से design करना होगा कि आप data पढ़ते कैसे हैं** (देखें [Schema design](/lessons/mongodb-schema-design))। बड़ी तुलना के लिए [SQL vs NoSQL](/lessons/sql-vs-nosql) पढ़ें।

## 3. JSON vs BSON

आप mongosh और Mongoose में JSON जैसे objects लिखते हैं। लेकिन MongoDB कभी text JSON store नहीं करता। वो **BSON** (Binary JSON) store करता है।

| | JSON | BSON |
|---|---|---|
| Format | Text | Binary |
| Types | string, number, boolean, null, array, object | ये सब **और साथ में** ObjectId, Date, Int32, Int64, Double, Decimal128, binary data… |
| Numbers | सिर्फ़ एक "number" type | Integer, double और decimal के अलग-अलग types |
| Traversal | पूरा text parse करना पड़ता है | हर element अपना **type और length** store करता है, इसलिए server उन fields को skip कर सकता है जिनकी उसे ज़रूरत नहीं |
| Size | छोटे docs के लिए अक्सर छोटा | थोड़ा बड़ा (length prefixes की वजह से), लेकिन scan करने में कहीं ज़्यादा तेज़ |

यह क्यों मायने रखता है:

1. **Typed:** Double के रूप में store किया गया `19.99`, `Decimal128("19.99")` से अलग है। String `"5"` के लिए query, number `5` से match नहीं करेगी।
2. **Traversable:** क्योंकि हर element अपनी length साथ रखता है, server `description` को parse किए बिना सीधे `price` पर jump कर सकता है।
3. **Richer:** JSON में कोई date type नहीं है। BSON में है।

> **याद रखें:** JSON वो है जो आप type करते हैं; BSON वो है जो MongoDB store करता है। BSON binary, typed और length-prefixed है, इसलिए उसे scan करना तेज़ है।

## 4. BSON types जो आपको पता होने चाहिए

### ObjectId: default `_id`

**ObjectId** एक 12-byte value है, जो आमतौर पर insert के server तक पहुँचने से पहले ही **driver** (आपकी Node app में) generate कर देता है:

```text
┌──────────────┬──────────────────┬────────────┐
│  4 bytes     │  5 bytes         │  3 bytes   │
│  timestamp   │  random value    │  counter   │
│  (seconds)   │  (per process)   │  (+1 each) │
└──────────────┴──────────────────┴────────────┘
   6acb4626      a672d45373          fdcb35
```

- **Timestamp:** Unix epoch से अब तक के seconds, इसलिए आप creation time वापस पढ़ सकते हैं।
- **Random value:** हर process में एक बार generate होती है, ताकि दो app servers की IDs आपस में न टकराएँ।
- **Counter:** एक random value से शुरू होकर बढ़ता है, ताकि एक process हर second कई IDs बना सके।

```js
const id = new ObjectId()
id.getTimestamp() // ISODate('2026-10-11T08:17:42.000Z')
```

क्योंकि timestamp सबसे पहले आता है, ObjectIds **लगभग time-ordered** होते हैं: `_id` से sort करने पर लगभग insertion order मिल जाता है। ये सिर्फ़ *लगभग* ordered हैं: एक ही second में अलग-अलग machines से बनी IDs, या जिन machines की clocks आगे-पीछे हों उनकी IDs, आपस में मिल-जुल सकती हैं।

⚠️ इसी वजह से ObjectId एक ख़राब **ranged** shard key है: हर नई value पिछली से बड़ी होती है, इसलिए सारे inserts एक ही shard पर पड़ते हैं (देखें [Sharding](/lessons/sharding))।

### Numbers: Int32, Int64, Double, Decimal128

| Type | किसके लिए इस्तेमाल करें | mongosh |
|---|---|---|
| **Int32** | छोटी गिनतियाँ, quantities | `NumberInt(3)` (या `3` जैसा सीधा integer literal) |
| **Int64** | बड़े counters, IDs, millisecond values | `NumberLong("9007199254740993")` |
| **Double** | Measurements, ratings, scientific values | `4.5` |
| **Decimal128** | **पैसा** और हर वो चीज़ जिसमें exact decimals चाहिए | `NumberDecimal("19.99")` |

पैसे को Double में क्यों न रखें? क्योंकि binary floating point ज़्यादातर decimal fractions को बिल्कुल सही represent नहीं कर पाता:

```js
0.1 + 0.2 // 0.30000000000000004
```

ऐसी दस लाख order lines का sum कीजिए और आपकी revenue report कुछ पैसों से ग़लत हो जाएगी। **Decimal128** 34 तक exact decimal digits store करता है। (दूसरा आम तरीका है integer **cents** (पैसे) को Int64 में store करना।)

⚠️ Int64 और Decimal128 values को **strings** के रूप में pass करें: `NumberLong(9007199254740993)` पहले JS number से होकर गुज़रता है और precision खो देता है।

### बाकी types

- **String:** UTF-8 text।
- **Date:** **Unix epoch से milliseconds का, UTC में**, एक 64-bit integer। असली dates store करें, `"11/10/2026"` जैसी strings कभी नहीं, वरना range queries और sorting टूट जाते हैं।
- **Boolean:** `true` / `false`।
- **Array:** एक ordered list; elements किसी भी type के हो सकते हैं, documents भी।
- **Embedded document:** किसी field के अंदर एक document (`address: { city: "Pune" }`)।
- **Null:** एक explicit "कोई value नहीं"। ध्यान दें कि query में `{ field: null }` उन documents से match करता है जिनमें field null है **या है ही नहीं**।

> **याद रखें:** dates के लिए Date और पैसे के लिए Decimal128 (या integer cents) इस्तेमाल करें। Types आपके data का हिस्सा हैं, कोई छोटी-मोटी detail नहीं।

## 5. `_id` field के नियम

हर document में एक `_id` होता है, और वो चार नियम मानता है:

1. **Required:** अगर आप नहीं देते, तो आपके लिए एक (ObjectId) generate हो जाता है।
2. Collection के अंदर **Unique:** `_id` पर हमेशा एक unique index होता है, और आप उसे drop नहीं कर सकते।
3. **Immutable:** एक बार insert होने के बाद इसे बदला नहीं जा सकता।
4. **Array को छोड़कर कोई भी type** (regex और undefined भी allowed नहीं हैं)। Strings, numbers और compound documents सब ठीक हैं।

```js
db.products.updateOne({ sku: "MUG-01" }, { $set: { _id: 5 } })
// MongoServerError: Performing an update on the path '_id'
// would modify the immutable field '_id'
```

किसी `_id` को "बदलने" के लिए, आप एक नया document insert करते हैं और पुराना delete कर देते हैं।

## 6. एक असली उदाहरण: e-commerce product

```js
db.products.insertOne({
  // _id is generated: ObjectId('...')
  sku: "TSHIRT-BLU-01",
  name: "Classic Cotton T-Shirt",
  price: NumberDecimal("19.99"),          // exact money
  currency: "INR",
  stock: 120,                              // Int32
  isActive: true,
  tags: ["clothing", "cotton", "summer"],  // array of strings
  sizes: [                                 // array of documents
    { size: "M", stock: 50 },
    { size: "L", stock: 70 }
  ],
  supplier: {                              // embedded document
    name: "Acme Textiles",
    country: "IN"
  },
  discontinuedAt: null,
  createdAt: new Date()                    // BSON Date (UTC)
})
```

एक read में पूरा product page मिल जाता है: sizes, tags और supplier सब शामिल।

## 7. Limits जिनके हिसाब से design करना होगा

- **हर document पर 16 MB** (BSON size)। ये एक guard rail है, target नहीं। जो document हमेशा बढ़ता रहता है (किसी product के सारे reviews, किसी user का हर event) वो आख़िरकार इस limit से टकराएगा। बड़ी files के लिए **GridFS** इस्तेमाल करें, जो file को chunks में बाँट देता है।
- **Nesting depth:** MongoDB officially nested documents के **100 levels** तक support करता है। अगर आप इसके आसपास भी हैं, तो model ग़लत है।
- बड़े documents limit तक पहुँचने से पहले भी आपको महँगे पड़ते हैं: हर read पूरा document memory में खींचता है, चाहे आप सिर्फ़ एक field दिखा रहे हों।

> **याद रखें:** 16 MB hard ceiling है, लेकिन असली समस्या उससे काफ़ी पहले शुरू हो जाती है। आमतौर पर इसके पीछे unbounded arrays होते हैं।

## 8. Flexible schema, "no schema" नहीं

MongoDB collection के हर document पर एक जैसे fields रखने की ज़बरदस्ती नहीं करता। ये इनके लिए बढ़िया है:

- अलग-अलग attributes वाले products (laptop में `ram` है, shirt में `size`)।
- बिना downtime के एक नया field roll out करना।

लेकिन आपकी **application** का schema हमेशा होता है: आपका code उम्मीद करता है कि `price` मौजूद हो और number हो। Discipline के बिना, एक ही collection में `price`, `Price` और `price: "19.99"` (एक string) पहुँच जाते हैं, और queries चुपचाप documents miss कर देती हैं।

### `$jsonSchema` के साथ schema validation

आप server से ग़लत documents reject करवा सकते हैं:

```js
db.createCollection("products", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["sku", "name", "price"],
      properties: {
        sku:   { bsonType: "string" },
        name:  { bsonType: "string", minLength: 1 },
        price: { bsonType: "decimal", minimum: 0 },
        tags:  { bsonType: "array", items: { bsonType: "string" } }
      }
    }
  },
  validationLevel: "strict",  // which documents are checked
  validationAction: "error"   // what happens on failure
})

db.products.insertOne({ sku: "MUG-01", name: "Mug", price: 10 })
// MongoServerError: Document failed validation
// (errInfo says price: "type did not match", consideredType: 'int')
```

| Option | Values | मतलब |
|---|---|---|
| `validationLevel` | `strict` (default) | **सभी** inserts और updates check करें |
| | `moderate` | Inserts check करें, और उन documents के updates जो **पहले से valid** हैं; पुराने invalid documents अब भी update हो सकते हैं |
| | `off` | कोई validation नहीं |
| `validationAction` | `error` (default) | Write reject करें |
| | `warn` | Write होने दें, लेकिन एक warning log करें |

किसी existing collection में validator `collMod` से जोड़ें। जोड़ते समय existing documents दोबारा check **नहीं** होते; सिर्फ़ आगे के writes check होते हैं।

```js
db.runCommand({ collMod: "products", validator: { $jsonSchema: { /* ... */ } },
                validationLevel: "moderate" })
```

Practical rollout: live collection पर `warn` (या `moderate`) से शुरू करें, logs में जो data दिखे उसे ठीक करें, फिर `strict` + `error` पर switch करें।

> **याद रखें:** flexible schema का मतलब है कि database अलग-अलग shapes store *कर सकता* है, ये नहीं कि उसे *करना चाहिए*। Structure को Mongoose और/या `$jsonSchema` से enforce करें।

## 9. आम ग़लतियाँ

- ❌ **पैसा Double में** → totals में rounding errors। Decimal128 या integer cents इस्तेमाल करें।
- ❌ **Dates strings में** → strings के रूप में `"2026-9-1" > "2026-10-1"`, इसलिए sorting और ranges टूट जाते हैं।
- ❌ **एक field में mixed types** (`"5"` और `5`) → `find({ qty: 5 })` आधा data miss कर देता है।
- ❌ **ये मान लेना कि `_id` का order बिल्कुल insertion order है** → ये सिर्फ़ लगभग time-ordered है। जब order मायने रखता हो तो `createdAt` field इस्तेमाल करें।
- ❌ **Validation के लिए सिर्फ़ Mongoose पर भरोसा करना** → scripts, दूसरी services और shell इसे bypass कर देते हैं। Server-side `$jsonSchema` सब कुछ पकड़ता है।
- ❌ एक document के अंदर **arrays को हमेशा बढ़ने देना** → धीमे reads, फिर 16 MB की दीवार।

## 10. इनमें confuse न हों

| | Document (MongoDB) | Row (SQL) |
|---|---|---|
| Shape | Nested: arrays, sub-documents | Flat columns |
| Schema | हर document के लिए flexible (चाहें तो validated) | हर table के लिए fixed (बदलने के लिए `ALTER TABLE`) |
| Related data | अक्सर उसी document में embedded | आमतौर पर दूसरी tables में, join करके |
| Identity | `_id` (default में ObjectId) | Primary key (अक्सर auto-increment) |
| Max size | 16 MB | Engine और column types पर निर्भर |

## 11. जब document model ठीक नहीं बैठता

- जो data **बहुत ज़्यादा relational** है और कई unpredictable तरीकों से query होता है (कई entities पर भारी ad-hoc reporting), वो अक्सर SQL में आसान रहता है।
- ऐसा data जहाँ **एक ही fact कई records में shared है और लगातार update होता है** (copies embed करने का मतलब होगा हज़ारों documents update करना)।
- ऐसी teams जो कोई schema discipline enforce नहीं करेंगी: वहाँ flexibility गड़बड़ बन जाती है।

MongoDB relationships और multi-document [transactions](/lessons/mongodb-transactions) अच्छे से संभाल लेता है; असली बात है ऐसा model चुनना जिसकी **natural shape आपके access patterns से match करे**।
