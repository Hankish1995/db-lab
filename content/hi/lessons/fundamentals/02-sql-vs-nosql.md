---
slug: sql-vs-nosql
title: 'SQL vs NoSQL: एक ही data को organise करने के दो तरीके'
module: Foundations
summary: 'Relational और NoSQL databases data model, schema, joins, scaling और consistency में कैसे अलग हैं, और myths में फँसे बिना इनमें से सही कैसे चुनें।'
recap: >-
  SQL databases normalised tables रखते हैं जिन पर schema enforce होता है, और query के समय उन्हें join करते हैं;
  NoSQL एक पूरी family है (document, key-value, wide-column, graph) जो आमतौर पर data को उसी shape में रखती है
  जिसमें वह पढ़ा जाता है। Schema-on-write data को save करते समय check करता है; schema-on-read आपके code पर भरोसा
  करता है। पुराना बँटवारा (SQL scale up करता है, NoSQL scale out) अब धुंधला हो गया है: MongoDB में transactions और
  schema validation हैं, और SQL भी shard हो सकता है। Access patterns, relationships और team की skills देखकर चुनें,
  और जहाँ फ़ायदा हो वहाँ एक से ज़्यादा store इस्तेमाल करें।
---

## 1. कहानी

दो दुकानें एक जैसी चीज़ें बेचती हैं। दोनों अपने records अलग-अलग तरीके से रखती हैं।

**दुकान A filing cabinets इस्तेमाल करती है।** एक cabinet customers के लिए, एक products के लिए, एक orders के लिए। Order card पर लिखा होता है *"customer #17 ने product #203 खरीदा"*, customer का नाम कभी नहीं। Invoice print करने के लिए clerk तीन cabinets से cards निकालता है और उन्हें मिलाता है। हर card को एक छपे हुए template के हिसाब से भरना ज़रूरी है; जिस card में कोई field छूटा हो, वह desk पर ही reject हो जाता है।

**दुकान B folders इस्तेमाल करती है।** हर order का एक folder, जिसमें उसे ship करने के लिए ज़रूरी सब कुछ होता है: customer के नाम और address की एक copy, और items के साथ खरीद के समय की उनकी कीमतें। Invoice print करने का मतलब है **एक** folder खोलना। ज़रूरत हो तो folders में extra pages भी रखे जा सकते हैं।

| कहानी | Technical term |
|---|---|
| अलग-अलग cabinets, cards एक-दूसरे को number से point करते हैं | **Relational model**: **foreign keys** से जुड़ी tables |
| कई cabinets के cards को मिलाना | **JOIN** |
| छपा हुआ template जो desk पर check होता है | **Schema-on-write** |
| हर order का एक self-contained folder | **Document model**: **embedding** |
| Folders का content अलग-अलग हो सकता है | **Flexible schema** / schema-on-read |

दोनों में से कोई भी दुकान गलत नहीं है। दुकान A में customer #17 के कभी दो अलग addresses नहीं होते। दुकान B invoices तेज़ी से print करती है। **SQL vs NoSQL का पूरा trade-off बस यही है।**

> **याद रखें:** SQL हर fact को **एक बार** store करता है और पढ़ते समय join करता है। Document databases data को **उसी तरह store करते हैं जैसे वह पढ़ा जाता है**, अक्सर उसका कुछ हिस्सा duplicate करके।

## 2. दो दुनियाएँ

### Relational model (SQL)

Data **tables** में रहता है, जिनमें rows और typed columns होते हैं। Relationships को **primary keys** और **foreign keys** से दिखाया जाता है, और data **normalised** होता है: हर fact एक ही बार store होता है। आप **SQL** से query करते हैं, और database आपके लिए tables को join करता है। उदाहरण: PostgreSQL, MySQL, SQL Server, Oracle।

### NoSQL: एक family, कोई एक चीज़ नहीं

"NoSQL" का मतलब बस इतना है कि "relational नहीं"। इसमें बहुत अलग-अलग तरह के databases आते हैं:

| Family | Data की shape | उदाहरण |
|---|---|---|
| **Document** | Collections में JSON जैसे documents | MongoDB |
| **Key-value** | Key → opaque value | Redis, DynamoDB |
| **Wide-column** | Partition key के हिसाब से grouped rows, flexible columns | Cassandra |
| **Graph** | Nodes और edges | Neo4j |

Interviews में "NoSQL" का मतलब आमतौर पर **MongoDB-style document databases** होता है, इसलिए नीचे की comparison उसी से है। यह बात interview में खुलकर बोलें; इससे दिखता है कि आपको पता है यह family इससे बड़ी है।

## 3. Schema-on-write vs schema-on-read

- **Schema-on-write** (PostgreSQL): database हर write को table definition से check करता है। गलत type, `NOT NULL` column छूटा हुआ, टूटी हुई foreign key → write fail हो जाता है।
- **Schema-on-read** (default रूप से MongoDB): database किसी भी shape का document accept कर लेता है; पढ़ते समय उसे कैसे समझना है, यह आपका **code** तय करता है।

लेकिन MongoDB भी schema enforce कर सकता है:

```js
db.createCollection('products', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['name', 'price'],
      properties: {
        name:  { bsonType: 'string' },
        price: { bsonType: ['int', 'long', 'double', 'decimal'], minimum: 0 }
      }
    }
  }
})
```

और PostgreSQL भी flexible हो सकता है: एक `jsonb` column कोई भी JSON store कर सकता है और उस पर GIN से index बनाया जा सकता है।

> **याद रखें:** schema हमेशा मौजूद होता है। सवाल बस इतना है कि वह **कहाँ enforce होता है**: database में, या आपके application code में (Mongoose, Zod, discipline)।

## 4. E-commerce store, दोनों तरीकों से model किया हुआ

### PostgreSQL में

```sql
CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text NOT NULL
);

CREATE TABLE products (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  price      numeric(10,2) NOT NULL CHECK (price >= 0),
  stock      integer NOT NULL CHECK (stock >= 0)
);

CREATE TABLE orders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  status     text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id   bigint NOT NULL REFERENCES orders(id),
  product_id bigint NOT NULL REFERENCES products(id),
  quantity   integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(10,2) NOT NULL,   -- price at time of purchase
  PRIMARY KEY (order_id, product_id)
);
```

किसी order को उसके items के साथ दिखाने के लिए **join** चाहिए:

```sql
SELECT o.id, u.name, p.name AS product, oi.quantity, oi.unit_price
FROM orders o
JOIN users u        ON u.id = o.user_id
JOIN order_items oi ON oi.order_id = o.id
JOIN products p     ON p.id = oi.product_id
WHERE o.id = 42;
```

### MongoDB में

```js
// users
{ _id: ObjectId('...u17'), email: 'asha@example.com', name: 'Asha' }

// products
{ _id: ObjectId('...p203'), name: 'Running shoe', price: Decimal128('2999.00'), stock: 40 }

// orders: items embedded, with a snapshot of name and price
{
  _id: ObjectId('...o42'),
  userId: ObjectId('...u17'),
  status: 'pending',
  createdAt: ISODate('2026-10-11T10:00:00Z'),
  shippingAddress: { line1: '12 MG Road', city: 'Bengaluru', pin: '560001' },
  items: [
    { productId: ObjectId('...p203'), name: 'Running shoe', quantity: 1, unitPrice: Decimal128('2999.00') }
  ]
}
```

Order दिखाना **एक read है, कोई join नहीं**:

```js
db.orders.findOne({ _id: ObjectId('...o42') })
```

```text
 PostgreSQL: 4 tables, joined on read
 ┌───────┐   ┌────────┐   ┌─────────────┐   ┌──────────┐
 │ users │◄──┤ orders │◄──┤ order_items ├──►│ products │
 └───────┘   └────────┘   └─────────────┘   └──────────┘

 MongoDB: order document embeds what it needs
 ┌──────────────────────────────┐
 │ order                        │
 │  ├─ userId ─────────► users  │
 │  ├─ shippingAddress { … }    │
 │  └─ items [ { … }, { … } ]   │
 └──────────────────────────────┘
```

ध्यान दें: order के items और कीमतें copy की गई हैं (एक snapshot), और orders के लिए आप *यही चाहते* हैं: बाद में product की कीमत बदलने पर invoice नहीं बदलना चाहिए। जहाँ data shared हो और अपने-आप अलग से बदलता हो, वहाँ MongoDB अब भी **references** (`userId`) इस्तेमाल करता है, और ज़रूरत पड़ने पर `$lookup` join कर सकता है।

> **याद रखें:** जो data साथ में पढ़ा जाता है और parent का हिस्सा है (order items), उसे **embed** करें। जो shared है, बड़ा है, या बिना किसी सीमा के बढ़ता है (users, products, reviews), उसे **reference** करें।

## 5. Scaling: पुराना बँटवारा कहाँ से आया

```text
 Vertical scaling (scale up)      Horizontal scaling (scale out)
 ┌─────────┐                      ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐
 │         │                      │ DB  │ │ DB  │ │ DB  │ │ DB  │
 │   BIG   │                      └─────┘ └─────┘ └─────┘ └─────┘
 │   DB    │                      many machines, data split
 └─────────┘
 one bigger machine
```

Relational databases उस दौर में design हुए थे जब एक बड़ा server ही सब कुछ होता था। Joins और multi-row transactions सबसे आसान तब होते हैं जब पूरा data एक ही machine पर हो, इसलिए classic रास्ता था **scale up**।

2000s के आखिर में बड़ी web companies को एक machine की क्षमता से ज़्यादा चाहिए था। Dynamo, Bigtable, Cassandra और MongoDB जैसे systems **scale out** करने के लिए बनाए गए: data कई nodes में partition किया जाता है, और अक्सर इसके बदले joins और cross-node transactions छोड़ दिए जाते हैं। इसी इतिहास से यह नारा निकला: "NoSQL scale करता है, SQL नहीं"।

आज यह रेखा धुंधली है: एक अकेला PostgreSQL server ज़्यादातर apps की ज़रूरत से कहीं ज़्यादा load संभाल लेता है, SQL के लिए भी sharding मौजूद है (PostgreSQL के लिए Citus, MySQL के लिए Vitess), और distributed SQL databases (CockroachDB, Google Spanner, YugabyteDB) transactions के साथ scale out करते हैं।

## 6. Consistency के defaults

| | PostgreSQL (single primary) | MongoDB (replica set) |
|---|---|---|
| Transactions | हर statement एक transaction में चलता है | Single-document writes atomic होते हैं; multi-document transactions भी available हैं |
| Default isolation | **Read Committed** | Reads default रूप से read concern `local` इस्तेमाल करते हैं |
| Default writes | Success से पहले commit होकर WAL में flush होते हैं (`synchronous_commit = on`) | Modern versions में write concern `majority` default है (ज़्यादातर deployments में) |
| Replicas से reads | Replication asynchronous हो (जो default है) तो replicas पीछे रहते हैं (lag) | Secondary reads stale हो सकते हैं; default read preference `primary` है |

ईमानदार निचोड़: दोनों को "तेज़ और ढीला" से लेकर "strict" तक configure किया जा सकता है। Knobs जानिए (isolation levels, write concern, read concern, read preference); interviewers इसी से impress होते हैं।

## 7. कैसे चुनें

| अगर आपकी स्थिति ऐसी है… | किस तरफ़ झुकें |
|---|---|
| बहुत सारे relationships, ad-hoc queries, reporting | **SQL** |
| पैसा, inventory, कई entities में strict integrity | **SQL** (MongoDB transactions काम करते हैं, लेकिन यह SQL का home ground है) |
| Data जो स्वाभाविक रूप से एक aggregate की तरह पढ़ा जाता है (order, product page, CMS entry) | **Document** |
| हर record की shape बहुत अलग होती है (हर category के अलग product attributes) | **Document** (या PostgreSQL में `jsonb`) |
| बहुत ज़्यादा write volume जिसे पहले दिन से scale out करना हो | **Document / wide-column**, या distributed SQL |
| Caching, sessions, counters | **Key-value** |
| Team किसी एक database को बहुत अच्छे से जानती है | आमतौर पर **वही वाला** |

एक typical e-commerce app के लिए PostgreSQL और MongoDB दोनों काम करते हैं। फ़ैसला आमतौर पर **access patterns** और **team के experience** से होता है, raw capability से नहीं।

## 8. Myths और उनकी सच्चाई

| Myth | सच्चाई |
|---|---|
| "NoSQL में कोई schema नहीं होता" | Schema आपके code में छुपा होता है। MongoDB `$jsonSchema` validation support करता है; ज़्यादातर teams Mongoose भी इस्तेमाल करती हैं। |
| "MongoDB में transactions नहीं होते" | Single-document writes हमेशा atomic होते हैं, और multi-document ACID transactions 4.0 (replica sets) और 4.2 (sharded clusters) से available हैं। |
| "SQL scale नहीं कर सकता" | Read replicas, partitioning, Citus/Vitess sharding और distributed SQL, सब scale करते हैं। ज़्यादातर apps कभी एक अच्छे से tuned server से आगे नहीं बढ़तीं। |
| "NoSQL ज़्यादा तेज़ है" | उस access pattern के लिए तेज़ है जिसके लिए उसे model किया गया था (एक document read बनाम 4-table join)। Model खराब बनाया तो यह धीमा होगा। Speed **data model और indexes** से आती है, label से नहीं। |
| "MongoDB join नहीं कर सकता" | `$lookup` aggregation में left outer joins करता है। बस यह design का मुख्य tool नहीं है। |

> **याद रखें:** interviews में कभी मत कहिए "X बेहतर है"। कहिए "**इस access pattern** के लिए मैं X चुनूँगा, क्योंकि…, और trade-off यह है कि…"।

## 9. Polyglot persistence

असली systems अक्सर **कई databases** इस्तेमाल करते हैं, हर एक उस काम के लिए जिसमें वह सबसे अच्छा है। इसे **polyglot persistence** कहते हैं:

```text
            ┌──────────────┐
            │  Node.js API │
            └──────┬───────┘
     ┌─────────────┼──────────────┬────────────────┐
┌────▼─────┐  ┌────▼────┐  ┌──────▼───────┐  ┌─────▼─────┐
│PostgreSQL│  │  Redis  │  │Elasticsearch │  │ Warehouse │
│ orders,  │  │sessions,│  │product search│  │  reports  │
│ payments │  │  cache  │  │              │  │           │
└──────────┘  └─────────┘  └──────────────┘  └───────────┘
```

कीमत: हर extra store को sync में रखना पड़ता है (change streams, CDC, queues), उसे monitor करना, उसका backup लेना और team को उसे समझना पड़ता है।

## 10. आम गलतियाँ और trade-offs

- **MongoDB को SQL की तरह model करना।** हर table के लिए एक collection, फिर हर जगह `$lookup`। आपको दोनों की कीमतें मिलती हैं और किसी का फ़ायदा नहीं।
- **Unbounded arrays embed करना।** Product document के अंदर सारे reviews रखने से वह हमेशा बढ़ता रहता है और **16 MB document limit** से टकरा जाता है। Reviews को उनके अपने collection में रखकर reference करें।
- **बिना plan के data duplicate करना।** अगर आप user का नाम हर order में copy करते हैं, तो तय करें कि नाम बदलने पर पुराने orders update होने चाहिए या नहीं (आमतौर पर: नहीं, वह एक snapshot है)।
- **"Migrations से बचने" के लिए NoSQL चुनना।** आपके data की shape फिर भी बदलती है; बस अब migration application code में रहता है, जिसे पुराने और नए दोनों documents संभालने पड़ते हैं।
- **SQL चुनकर सब कुछ एक `jsonb` blob में रख देना।** आप constraints और planner की statistics दोनों खो देते हैं।

**Document-first कब न जाएँ:** heavy reporting, many-to-many relationships जिन्हें कई दिशाओं से query किया जाता है, या entities के बीच strict integrity। **Relational-first कब न जाएँ:** बहुत ज़्यादा बदलती shapes, एक बार में पूरे aggregate वाला access, या ऐसी team जो MongoDB के साथ सबसे तेज़ ship करती है और जिसकी कोई relational ज़रूरतें नहीं हैं।
