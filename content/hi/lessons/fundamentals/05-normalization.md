---
slug: normalization
title: 'Normalization: एक fact, एक जगह'
module: Data Modeling
summary: 'गंदी tables से insert, update और delete anomalies क्यों आती हैं, keys और functional dependencies कैसे 1NF से BCNF तक ले जाती हैं, और जानबूझकर denormalize करना कब सही फ़ैसला है।'
recap: >-
  Normalization का मतलब है हर fact को ठीक एक जगह store करना, ताकि data कभी खुद से contradict न करे। एक गंदी table
  से insert, update और delete anomalies आती हैं। 1NF cells के अंदर की lists हटाता है, 2NF उन facts को हटाता है जो
  composite key के सिर्फ़ एक हिस्से पर depend करते हैं, 3NF उन facts को हटाता है जो non-key columns पर depend करते
  हैं, और BCNF कहता है कि हर determinant एक candidate key होना चाहिए। Denormalize सोच-समझकर करें, measured read
  performance के लिए, और यह मान लें कि अब copies को sync में रखना आपकी ज़िम्मेदारी है।
---

## 1. कहानी

आपका store एक **spreadsheet** से शुरू होता है। जब भी कोई order करता है, आप एक row जोड़ देते हैं:

| order_id | date | customer | email | city | products | prices |
|---|---|---|---|---|---|---|
| 101 | 03-01 | Asha | asha@x.io | Pune | Mouse, Keyboard | 499, 1299 |
| 102 | 03-02 | Ravi | ravi@x.io | Delhi | Mouse | 499 |
| 103 | 03-05 | Asha | asha@x.io | Pune | USB-C Hub | 1999 |

एक हफ़्ते तक यह चलता है। फिर तीन चीज़ें बिगड़ती हैं:

- **Insert anomaly:** आप एक नया product "Webcam" खरीदते हैं, लेकिन जब तक कोई उसे order न करे, आप उसे **कहीं जोड़ ही नहीं सकते**। Product सिर्फ़ किसी order row के अंदर ही exist करता है।
- **Update anomaly:** Asha अपना email बदलती है। वह 40 rows में है। आपकी script उनमें से 39 update करती है। अब database में एक ही इंसान के **दो अलग-अलग emails** हैं, और किसी को नहीं पता कि सही कौन-सा है।
- **Delete anomaly:** order 103 cancel होता है और आप वह row delete कर देते हैं। "USB-C Hub की कीमत 1999 है" का **इकलौता record** भी उसके साथ गायब हो जाता है।

तीनों की जड़ एक ही है: **एक ही fact कई जगहों पर store है, या आपस में असंबंधित facts एक ही row में चिपका दिए गए हैं।**

**Normalization** tables को इस तरह बाँटने की प्रक्रिया है कि **हर fact ठीक एक जगह रहे**।

- "Asha का email" = `customers` में एक row।
- "Mouse की कीमत 499 है" = `products` में एक row।
- "Order 101 में 1 Mouse है" = `order_items` में एक row।

> **याद रखें:** normalization = **एक fact, एक जगह**। Anomalies तब आती हैं जब एक fact कई जगहों पर रहता है।

## 2. Keys: पहले ये शब्द समझ लें

हर normal form keys के हिसाब से define होता है, इसलिए इन्हें पहले साफ़ कर लें:

| Term | मतलब | Store उदाहरण |
|---|---|---|
| **Super key** | Columns का कोई भी set जो एक row को uniquely पहचानता है | `(customer_id, email)` |
| **Candidate key** | एक *minimal* super key (कोई भी column हटाएँ तो वह unique नहीं रहती) | `customer_id`, या `email` |
| **Primary key** | वह candidate key जिसे आप main identifier के तौर पर *चुनते* हैं | `customer_id` |
| **Composite key** | 2 या ज़्यादा columns से बनी key | `(order_id, product_id)` |
| **Foreign key** | एक column जो किसी दूसरी table की key की तरफ़ point करता है | `orders.customer_id → customers` |
| **Natural key** | ऐसी key जिसका real-world में मतलब हो | `email`, `sku`, एक GST number |
| **Surrogate key** | एक बेमतलब generated ID | `id bigint GENERATED ALWAYS AS IDENTITY`, MongoDB `_id` |

**Natural vs surrogate** एक classic interview सवाल है:

- Natural keys **बदलती हैं** (लोग email बदलते हैं; SKUs को नया label मिलता है), और primary key बदलने का मतलब है उसकी तरफ़ point करने वाली हर foreign key को update करना।
- Surrogate keys **कभी नहीं बदलतीं** और छोटी होती हैं, लेकिन वे अपने आप duplicates को नहीं रोकतीं।
- आम practice: एक **surrogate primary key** और साथ में **natural key पर UNIQUE constraint**।

```sql
CREATE TABLE customers (
  customer_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- surrogate
  email       text NOT NULL UNIQUE,                             -- natural, still enforced
  name        text NOT NULL,
  city        text
);
```

## 3. Functional dependency आसान भाषा में

एक **functional dependency** `X → Y` का मतलब है: **अगर आपको X पता है, तो Y की सिर्फ़ एक ही संभावित value है।**

- `customer_id → email` ✅ एक customer का एक email होता है।
- `product_id → product_name` ✅
- `order_id → order_date` ✅
- `city → customer_id` ❌ Pune में बहुत सारे customers रहते हैं।

बाईं तरफ़ वाले column(s) **determinant** कहलाते हैं। Normalization बस इतना ही है: **हर dependency को देखें और पक्का करें कि उसका determinant उसी table की key है जिसमें वह रहती है।** अगर नहीं है, तो वह fact किसी दूसरी table में होना चाहिए।

> **याद रखें:** `X → Y` को ऐसे पढ़ें: "X, Y को तय करता है"। हर normal form एक ही सवाल पूछता है: इस column को तय करने वाली चीज़ क्या सच में table की key है?

## 4. Table को आगे बढ़ाना: 1NF → 2NF → 3NF → BCNF

ऊपर वाली spreadsheet को लेकर हम उसे एक-एक step में ठीक करेंगे।

### First Normal Form (1NF): हर cell में एक value

**नियम:** हर cell में एक ही **atomic** value हो, कोई repeating groups न हों (`product1, product2, product3` जैसे columns), और हर row को किसी key से पहचाना जा सके।

`products = "Mouse, Keyboard"` यह नियम तोड़ता है। String parsing के बिना आप न इस पर index बना सकते हैं, न join कर सकते हैं, न पूछ सकते हैं कि "हमने कितने Mouse बेचे?"। इसलिए हम **हर order line के लिए एक row** बनाते हैं:

| order_id | product_id | date | customer_id | cust_name | email | product_name | price | qty |
|---|---|---|---|---|---|---|---|---|
| 101 | P1 | 03-01 | C1 | Asha | asha@x.io | Mouse | 499 | 1 |
| 101 | P2 | 03-01 | C1 | Asha | asha@x.io | Keyboard | 1299 | 1 |
| 102 | P1 | 03-02 | C2 | Ravi | ravi@x.io | Mouse | 499 | 2 |

Primary key: **composite key** `(order_id, product_id)`।

यह 1NF में है, लेकिन duplication देखिए: order 101 की date और customer हर line पर दोहराए गए हैं।

### Second Normal Form (2NF): कोई partial dependency नहीं

**नियम:** 1NF, **और** हर non-key column **पूरी** composite key पर depend करे, सिर्फ़ उसके एक हिस्से पर नहीं।

हर column को `(order_id, product_id)` के सामने check करें:

| Column | किस पर depend करता है | समस्या? |
|---|---|---|
| `qty` | `(order_id, product_id)` | ✅ पूरी key |
| `date`, `customer_id`, `cust_name`, `email` | सिर्फ़ `order_id` | ❌ partial |
| `product_name`, `price` | सिर्फ़ `product_id` | ❌ partial |

हर partial dependency एक ऐसी table में चली जाती है जिसकी key वही हिस्सा है जिस पर वह depend करती है:

```text
┌──────────────────────┐  ┌───────────────────┐  ┌──────────────────┐
│ orders               │  │ order_items       │  │ products         │
├──────────────────────┤  ├───────────────────┤  ├──────────────────┤
│ order_id (PK)        │◄─┤ order_id   (PK,FK)│  │ product_id (PK)  │
│ order_date           │  │ product_id (PK,FK)├─►│ name             │
│ customer_id          │  │ qty               │  │ price            │
│ cust_name            │  │ unit_price        │  └──────────────────┘
│ email                │  └───────────────────┘
└──────────────────────┘
```

अब "Webcam" किसी के order करने से पहले ही `products` में exist कर सकता है (insert anomaly ख़त्म), और order delete करने से अब product के facts delete नहीं होते (delete anomaly ख़त्म)।

`order_items` में `unit_price` पर ध्यान दें। यह `products.price` का duplicate **नहीं** है। यह एक **अलग fact** है: "इस customer ने उस दिन असल में कितनी कीमत चुकाई"। यह पूरी key `(order_id, product_id)` पर depend करता है। अगर आप सिर्फ़ `products.price` store करते, तो कल price बदलते ही हर पुराना invoice चुपचाप बदल जाता।

> **याद रखें:** order line पर price का snapshot denormalization नहीं है। "Current price" और "चुकाई गई price" दो अलग facts हैं।

**Shortcut:** जिस table की primary key **एक ही column** की हो, उसमें partial dependency हो ही नहीं सकती, इसलिए 1NF में आते ही वह अपने आप 2NF में होती है।

### Third Normal Form (3NF): कोई transitive dependency नहीं

**नियम:** 2NF, **और** कोई भी non-key column **किसी दूसरे non-key column** पर depend न करे।

`orders` को देखिए:

```text
order_id ──► customer_id ──► cust_name, email
```

`email` key पर सिर्फ़ `customer_id` के **ज़रिए** depend करता है। यह एक **transitive dependency** है, और यही ठीक कहानी वाली update anomaly है: Asha का email उसके हर order पर copy हुआ है।

इसे ठीक करने के लिए customer के facts को उनकी अपनी table में ले जाएँ:

| customers | | |
|---|---|---|
| **customer_id** | name | email |
| C1 | Asha | asha@x.io |
| C2 | Ravi | ravi@x.io |

| orders | | |
|---|---|---|
| **order_id** | order_date | customer_id (FK) |
| 101 | 03-01 | C1 |
| 102 | 03-02 | C2 |

अब Asha का email **एक row** में रहता है। उसे बदलना एक `UPDATE` है, और वह कभी खुद से असहमत नहीं हो सकता।

Classic one-liner: **हर non-key column को "the key, the whole key, and nothing but the key" पर depend करना चाहिए।** "The key" यानी 1NF, "the whole key" यानी 2NF, "nothing but the key" यानी 3NF।

```sql
CREATE TABLE products (
  product_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  price      numeric(10,2) NOT NULL CHECK (price >= 0)
);

CREATE TABLE orders (
  order_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers (customer_id),
  order_date  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id   bigint NOT NULL REFERENCES orders (order_id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products (product_id),
  qty        int NOT NULL CHECK (qty > 0),
  unit_price numeric(10,2) NOT NULL,         -- price paid, a historical fact
  PRIMARY KEY (order_id, product_id)
);
```

### Boyce-Codd Normal Form (BCNF): हर determinant एक candidate key है

**नियम:** table की हर functional dependency `X → Y` के लिए `X` एक **candidate key** होना चाहिए (सख़्ती से कहें तो एक super key)।

3NF में एक loophole है: वह `X → Y` की इजाज़त देता है जब `Y` खुद किसी candidate key का हिस्सा हो। ऊपर की हमारी चारों tables में ऐसा कोई case नहीं है, इसलिए वे पहले से BCNF में हैं। ज़्यादातर असली 3NF tables BCNF में ही होती हैं। यह रही store की एक table जहाँ यह loophole चुभता है।

Marketplace sellers को **हर category के लिए एक account manager** मिलता है। Business rules:

- एक seller का हर category में ठीक एक manager होता है: `(seller_id, category) → manager`।
- हर manager ठीक एक category संभालता है: `manager → category`।

| seller_id | category | manager |
|---|---|---|
| S1 | Electronics | Meera |
| S2 | Electronics | Meera |
| S3 | Electronics | Karan |
| S1 | Books | Tara |

Candidate keys: `(seller_id, category)` और `(seller_id, manager)`। हर column किसी न किसी key का हिस्सा है, इसलिए table 3NF में है। लेकिन `manager → category` है, और अकेला `manager` candidate key **नहीं** है, इसलिए यह **BCNF नहीं** है।

Anomaly: "Meera Electronics संभालती है" यह बात **हर seller के लिए** एक बार store होती है। Meera को Fashion में भेजें तो आपको कई rows update करनी पड़ेंगी। और जब तक किसी नए manager के पास कोई seller न हो, उसे record ही नहीं किया जा सकता।

BCNF split:

| managers | |
|---|---|
| **manager** | category |
| Meera | Electronics |
| Karan | Electronics |
| Tara | Books |

| seller_managers | |
|---|---|
| **seller_id** | **manager** |
| S1 | Meera |
| S2 | Meera |
| S1 | Tara |

⚠️ Interview-level बारीकी: यह split lossless है, लेकिन "हर seller के लिए हर category में एक manager" वाला नियम अब दो tables में फैल गया है और उसे **अब एक simple UNIQUE constraint से enforce नहीं किया जा सकता**। BCNF की कीमत **dependency preservation** हो सकती है। इसीलिए practical target आमतौर पर 3NF होता है, और BCNF वहीं लगाया जाता है जहाँ anomaly सच में नुकसान करती हो।

> **याद रखें:** 1NF = atomic values। 2NF = composite key पर कोई partial dependency नहीं। 3NF = कोई non-key → non-key dependency नहीं। BCNF = हर determinant एक candidate key है।

## 5. Denormalization: जानबूझकर नियम तोड़ना

एक पूरी तरह normalized schema "order 101 को customer name और product names के साथ दिखाओ" का जवाब एक **4-table join** से देता है। आमतौर पर यह ठीक है: indexed keys पर joins तेज़ होते हैं। लेकिन कभी-कभी reads इतने ज़्यादा होते हैं कि वह काम बचाने के लिए आप **जानबूझकर data copy करते हैं**। इसे **denormalization** कहते हैं।

आम और जायज़ वजहें:

- **Read performance:** `products` पर `review_count` और `avg_rating` store करें, ताकि product listing page हर request पर लाखों reviews पर `COUNT`/`AVG` न चलाए।
- **Reporting / analytics:** data warehouses चौड़े **star schemas** (एक fact table और साथ में flat dimension tables) इस्तेमाल करते हैं, क्योंकि analysts अरबों rows scan करते हैं और उस scale पर joins महँगे होते हैं। PostgreSQL के **materialized views** एक database के अंदर इसी का controlled version हैं।
- **NoSQL embedding:** MongoDB में "एक order" पढ़ना एक ही document fetch होना चाहिए, इसलिए आप line items और जो चाहिए उसका एक **snapshot** embed कर देते हैं:

```js
db.orders.insertOne({
  _id: 101,
  customerId: ObjectId('6650a1f2c3d4e5f6a7b8c9d0'),
  customerName: 'Asha',            // copied: shown on the order page
  createdAt: new Date(),
  items: [
    { productId: 1, name: 'Mouse',    unitPrice: 499,  qty: 1 },
    { productId: 2, name: 'Keyboard', unitPrice: 1299, qty: 1 }
  ],
  total: 1798                      // derived value, stored
})
```

यहाँ `items` को embed करना कोई समझौता भी नहीं है: line items ठीक एक order के होते हैं और उसी के साथ पढ़े जाते हैं। `customerName` को copy करना **ज़रूर** एक समझौता है: अगर Asha अपना नाम बदलती है, तो पुराने orders में पुराना नाम ही रहेगा। Invoices के लिए अक्सर आप *यही चाहते हैं*। "Current profile" दिखाने के लिए यह एक bug है।

### कीमत क्या चुकानी पड़ती है

- **Update anomalies वापस आ जाती हैं।** Source बदलने पर हर copy को update करना पड़ता है।
- **Writes भारी हो जाते हैं।** एक business बदलाव कई writes बन जाता है (बेहतर है कि एक transaction में)।
- **Consistency आपकी ज़िम्मेदारी बन जाती है:** application code, triggers, background jobs या change streams को copies sync में रखनी होंगी।
- **ज़्यादा storage**, और बड़ी rows या documents।

```sql
-- Denormalized counter: must be kept in sync on every review insert
BEGIN;
INSERT INTO reviews (product_id, customer_id, rating) VALUES (1, 7, 5);
UPDATE products
SET review_count = review_count + 1
WHERE product_id = 1;
COMMIT;
```

> **याद रखें:** denormalization **तेज़ reads** के बदले **write complexity और consistency risk** लेता है। इसे किसी measured read समस्या के लिए करें, और तय करें कि copies को sync में कौन रखेगा।

## 6. आम गलतियाँ और gotchas

- **Order lines से "price" को normalize करके हटा देना।** Historical facts (चुकाई गई price, इस्तेमाल हुआ shipping address) order पर ही रहने चाहिए। Current `products.price` से join करना इतिहास को बदल देता है।
- **एक column में comma-separated IDs** (`tag_ids = '3,7,9'`)। यह 1NF तोड़ता है, इस पर foreign keys नहीं लग सकतीं, और इसे ठीक से index नहीं किया जा सकता। Junction table इस्तेमाल करें (या असली array/`jsonb` सिर्फ़ तब, जब आप trade-off समझते हों)।
- **यह सोचना कि surrogate keys duplicates हटा देती हैं।** `asha@x.io` की दो rows अलग-अलग `customer_id` के साथ फिर भी duplicate ही हैं। Natural key पर UNIQUE constraint रखें।
- **Foreign keys पर indexes भूल जाना।** PostgreSQL primary keys और UNIQUE columns को अपने आप index करता है, लेकिन foreign key columns को **नहीं**। जिस normalized schema में `order_items.product_id` पर index नहीं है, उसके joins धीमे होते हैं।
- **"MongoDB का मतलब है कोई normalization नहीं।"** गलत। आपको फिर भी तय करना है कि क्या embed करना है और क्या reference। Unbounded arrays (product document के अंदर हर review) एक denormalization गलती है जो 16 MB document limit से टकराती है।
- **Measure किए बिना denormalize करना।** ज़्यादातर "joins धीमे हैं" वाली समस्याएँ असल में missing indexes होती हैं।

## 7. Normalized vs denormalized

| | Normalized | Denormalized |
|---|---|---|
| हर fact कितनी बार store होता है | एक बार | शायद कई बार |
| Anomalies | Design से ही रुक जाती हैं | हो सकती हैं, आपको code में रोकनी होंगी |
| Writes | आसान, छोटे | भारी, copies update करनी पड़ती हैं |
| Reads | Joins की ज़रूरत पड़ सकती है | कम joins / एक fetch |
| Storage | कम | ज़्यादा |
| आमतौर पर कहाँ | OLTP: orders, payments, users | Reporting, caches, read-heavy views, document models |
| सबसे अच्छा कब | Data अक्सर बदलता है, correctness ज़रूरी है | Data लिखे जाने से कहीं ज़्यादा पढ़ा जाता है, या कम ही बदलता है |

## 8. Rule of thumb और trade-offs

मशहूर लाइन है **"normalize until it hurts, denormalize until it works."** इसे ज़िम्मेदारी से पढ़ें:

1. Transactional data के लिए **3NF से शुरू करें**। यही default है जो आपके data को ईमानदार रखता है।
2. **"Until it hurts"** का मतलब है एक **measured** समस्या: `EXPLAIN` में दिखती धीमी query, या कोई page जो अपने latency budget से बाहर है। कोई अंदाज़ा नहीं।
3. Denormalize करने से पहले **indexes**, बेहतर query, या एक **cache** आज़माएँ।
4. जब denormalize करें, तो **एक खास चीज़** को denormalize करें, source of truth लिखकर रखें, और उसी समय sync mechanism (transaction, trigger, job) भी बनाएँ।

Normalization में और आगे कब *न* जाएँ:

- **ऐसा data जो लिखे जाने के बाद कभी नहीं बदलता** (order snapshot, audit log), उसमें update anomalies हो ही नहीं सकतीं, इसलिए copy करना सुरक्षित है।
- **BCNF splits** जो कोई ज़रूरी constraint खो देते हैं, वे उस छोटी anomaly से भी बदतर हो सकते हैं जिसे वे हटाते हैं।
- **Analytics stores** जानबूझकर denormalized होते हैं। Normal forms transactional systems के लिए एक tool हैं, कोई नैतिक कानून नहीं।

> **याद रखें:** normalized schema ही **source of truth** है। हर denormalized copy **उसी का एक cache** है, जिसे sync में रखने का वादा आपने किया है।
