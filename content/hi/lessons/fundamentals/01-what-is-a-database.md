---
slug: what-is-a-database
title: 'Database क्या है: data रखने की जगह से कहीं ज़्यादा'
module: Foundations
summary: 'Database और DBMS असल में क्या हैं, files काफ़ी क्यों नहीं हैं, अंदर data कैसे store होता है, और कौन-सा database किस काम के लिए सही है।'
recap: >-
  Data यानी facts, database उन facts का एक व्यवस्थित collection है, और DBMS वह software है जो उसे store,
  query और protect करता है। JSON files की जगह DBMS इसलिए इस्तेमाल करते हैं क्योंकि वह concurrent users,
  तेज़ queries, integrity के नियम और crash safety आपके लिए संभालता है। अंदर से वह data को fixed-size pages में
  रखता है, hot pages को memory में cache करता है और pages बदलने से पहले log लिखता है ताकि crash के बाद recover
  कर सके। OLTP app को serve करता है, OLAP analysts को, और हर database type (relational, document, key-value,
  graph वगैरह) किसी ख़ास काम के लिए बना है।
---

## 1. कहानी

सोचिए एक छोटी दुकान अपने orders एक **notebook** में लिखती है। एक दुकानदार, एक pen, दिन में कुछ orders। सब ठीक चलता है।

फिर दुकान online हो जाती है:

- **पाँच staff** एक ही समय पर notebook में लिखना चाहते हैं। उनमें से दो एक-दूसरे की lines के ऊपर लिख देते हैं।
- मालिक पूछता है: *"पिछले हफ़्ते Mumbai के customers ने कितने orders दिए?"* किसी को **हर page** पढ़ना पड़ता है।
- एक staff member ऐसे product का order लिख देता है जो **है ही नहीं**। किसी का ध्यान नहीं जाता।
- Order लिखते-लिखते किसी के हाथ से coffee गिर जाती है। Order record हुआ या नहीं?

तो दुकान एक **librarian** रख लेती है। अब staff notebook को हाथ नहीं लगाता। वे librarian को एक request देते हैं, और librarian:

- लोगों को बारी-बारी से सुरक्षित तरीक़े से काम करने देता है,
- पीछे एक **index** रखता है ताकि कुछ भी ढूँढना तुरंत हो जाए,
- नियम तोड़ने वाली entries को मना कर देता है,
- हर बदलाव की एक **diary** रखता है ताकि गिरी हुई coffee की वजह से कभी कोई order न खोए।

**यही है database.**

| कहानी | Technical term |
|---|---|
| लिखे गए facts (order #42, ₹999) | **Data** |
| व्यवस्थित notebook | **Database** |
| Librarian | **DBMS** (Database Management System) |
| Request की पर्ची ("Mumbai के orders ढूँढो") | **Query**, जो एक **query language** में लिखी जाती है |
| पीछे वाला index | **Index** |
| नियम ("product का होना ज़रूरी है") | **Constraints** / **schema** |
| बदलावों की diary | **Write-ahead log** (WAL) / **journal** |

> **याद रखें:** **data** = facts, **database** = व्यवस्थित collection, **DBMS** = वह software (PostgreSQL, MongoDB) जो उसे store, query और protect करता है। लोग तीनों के लिए "database" ही बोल देते हैं।

## 2. सीधे files या JSON क्यों नहीं?

हर MERN developer ने यह सोचा है: *"मैं बस `fs.writeFile` से `orders.json` save कर लूँ।"* देखिए क्या-क्या टूटता है:

| समस्या | JSON file के साथ | DBMS के साथ |
|---|---|---|
| **Concurrency** | दो requests read, modify, write करती हैं: एक update चुपचाप खो जाता है | Locks / MVCC से कई users सुरक्षित तरीक़े से read और write कर पाते हैं |
| **Querying** | पूरी file load करो, JS में loop चलाओ | Declarative queries + indexes rows को तेज़ी से ढूँढते हैं |
| **Integrity** | `price: "abc"` या missing `userId` को कोई नहीं रोकता | Types, `NOT NULL`, `UNIQUE`, foreign keys, validators |
| **Crash safety** | Write के बीच में crash = आधी लिखी, corrupt file | Log + recovery: बदलाव या तो पूरा होगा या बिल्कुल नहीं |
| **Size** | Parse करने के लिए file memory में fit होनी चाहिए | Data RAM से कहीं ज़्यादा बड़ा हो सकता है |
| **Security** | सिर्फ़ file permissions | Users, roles, per-table permissions |

**Lost update** सबसे classic उदाहरण है। दो customers एक ही पल में किसी product की आख़िरी unit ख़रीदते हैं:

```text
Request A: read stock = 1   ─┐
Request B: read stock = 1   ─┤  both see 1
Request A: write stock = 0  ─┤
Request B: write stock = 0  ─┘  two orders, one item ❌
```

Database आपको इसे रोकने के tools देता है, जैसे condition (`stock > 0`) के साथ एक atomic update, या एक transaction।

> **याद रखें:** database सिर्फ़ storage नहीं है। यह **concurrency control + तेज़ querying + integrity + crash recovery** है, जो वरना आपको ख़ुद बनाना पड़ता (और वह भी ख़राब तरीक़े से)।

## 3. Data कैसे organise होता है: tables बनाम documents

दो models जिनसे आपका सबसे ज़्यादा सामना होगा:

**Relational (SQL):** data **tables** में रहता है। हर **row** एक record है; हर **column** एक attribute है जिसका type fixed होता है।

```text
products
┌────┬──────────────┬────────┬───────┐
│ id │ name         │ price  │ stock │
├────┼──────────────┼────────┼───────┤
│ 1  │ Running shoe │ 2999   │ 40    │
│ 2  │ Water bottle │ 499    │ 120   │
└────┴──────────────┴────────┴───────┘
```

**Document (NoSQL, जैसे MongoDB):** data **documents** के **collections** में रहता है (JSON जैसे objects, जो BSON के रूप में store होते हैं)। Documents के अंदर nested objects और arrays हो सकते हैं।

```js
// collection: products
{
  _id: ObjectId('66f1c0a2e4b0a1b2c3d4e5f6'),
  name: 'Running shoe',
  price: 2999,
  stock: 40,
  sizes: [7, 8, 9, 10],
  specs: { weightGrams: 280, color: 'black' }
}
```

| Relational | Document |
|---|---|
| Database → **table** → **row** → **column** | Database → **collection** → **document** → **field** |
| हर table में fixed columns | हर document का अपना अलग shape हो सकता है |
| Related data दूसरी tables में, keys से जुड़ा हुआ | Related data अक्सर document के अंदर ही **embedded** |

**Schema** data के shape का description है: कौन-से fields हैं, उनके types क्या हैं, और नियम क्या हैं। PostgreSQL write करते समय schema enforce करता है (`CREATE TABLE`)। MongoDB default रूप से flexible है, लेकिन आप collection पर **JSON Schema validation** से schema enforce कर सकते हैं (और Mongoose आपके app में एक schema जोड़ देता है)।

### Query languages

आप database को यह नहीं बताते कि data *कैसे* ढूँढना है; आप बताते हैं कि आपको *क्या* चाहिए, और उसका **query planner** "कैसे" ख़ुद चुनता है।

```sql
-- PostgreSQL (SQL)
SELECT name, price FROM products WHERE price < 1000 ORDER BY price;
```

```js
// MongoDB (MQL in mongosh)
db.products.find({ price: { $lt: 1000 } }, { name: 1, price: 1 }).sort({ price: 1 })
```

> **याद रखें:** **SQL** एक declarative language है: आप बताते हैं *क्या*, planner तय करता है *कैसे*। इसीलिए index जोड़ने के बाद वही query 5 s से 5 ms की हो सकती है, app code की एक भी line बदले बिना।

## 4. Database data कैसे store करता है (high level)

अंदर से लगभग हर disk-based database एक ही pattern follow करता है:

```text
   App query
       │
┌──────▼───────────────────────────┐
│  Query planner / executor        │
└──────┬───────────────────────────┘
       │
┌──────▼───────────────────────────┐
│  Memory cache (buffer pool)      │  ← hot pages live here
└──────┬──────────────────┬────────┘
       │                  │ 1. log first
       │           ┌──────▼────────┐
       │           │ Write-ahead   │  append-only, fsync'd
       │           │ log / journal │
       │           └───────────────┘
┌──────▼───────────────────────────┐
│  Data files on disk (pages)      │  ← written later, in batches
└──────────────────────────────────┘
```

- **Pages:** disk पर data fixed-size blocks में store होता है जिन्हें **pages** कहते हैं (PostgreSQL में default 8 KB)। Database हमेशा पूरे pages read और write करता है, कभी अकेली rows नहीं।
- **Memory cache:** हाल ही में इस्तेमाल हुए pages RAM में रखे जाते हैं (PostgreSQL के **shared buffers**, MongoDB WiredTiger का **cache**)। RAM से पढ़ना disk से कई गुना (orders of magnitude) तेज़ है, इसीलिए "क्या मेरा working set memory में fit होता है?" इतना ज़्यादा मायने रखता है।
- **Indexes:** अलग structures (आमतौर पर **B-trees**) जो किसी value को उस जगह से map करते हैं जहाँ उसकी row रहती है, ताकि database को हर page scan न करना पड़े।

**Write-ahead log** एक paragraph में: जब आप data बदलते हैं, तो database तुरंत data page को दोबारा नहीं लिखता (यह धीमा, random disk I/O है)। वह पहले **बदलाव का description एक log में append करता है** और उस log को disk पर flush करता है (`fsync`)। यह append sequential और तेज़ होता है। बदला हुआ page memory में रहता है और बाद में batches में अपनी data file में लिखा जाता है (इसे **checkpoint** कहते हैं)। अगर server crash हो जाए, तो restart पर database **log को replay करता है** ताकि जो committed changes data files तक नहीं पहुँचे थे, उन्हें फिर से apply (redo) कर सके। PostgreSQL इसे **WAL** कहता है; MongoDB का WiredTiger engine इसे **journal** कहता है।

> **याद रखें:** **पहले log, data files बाद में।** Write-ahead log की वजह से ही database एक साथ तेज़ (sequential appends) और crash-safe (restart पर replay) दोनों होता है।

## 5. OLTP बनाम OLAP: दो बिल्कुल अलग workloads

| | **OLTP** (Online Transaction Processing) | **OLAP** (Online Analytical Processing) |
|---|---|---|
| कौन इस्तेमाल करता है | आपका app, real time में | Analysts, dashboards, reports |
| Typical query | "Order #42 लाओ", "एक payment insert करो" | "3 साल का हर महीने, हर category का revenue" |
| कितनी rows छूती हैं | कुछ ही, key से | लाखों-करोड़ों (millions), aggregate करके |
| Writes | बहुत सारे छोटे, लगातार | Bulk loads (batch / streaming) |
| Storage layout | Row-oriented | आमतौर पर **column-oriented** |
| उदाहरण | PostgreSQL, MySQL, MongoDB | Snowflake, BigQuery, ClickHouse, Redshift |

E-commerce store में checkout orders को एक **OLTP** database में लिखता है। हर रात (या लगातार) data एक **OLAP** warehouse में copy होता है, जहाँ business checkout को धीमा किए बिना बड़े सवाल पूछ सकता है।

**Column-oriented** storage एक column की सारी values को एक साथ रखता है। तब `SUM(amount)` हर पूरी row की जगह सिर्फ़ `amount` column पढ़ता है, और मिलती-जुलती values बहुत अच्छे से compress होती हैं।

## 6. Databases के types

| Type | एक line में मक़सद | उदाहरण product |
|---|---|---|
| **Relational** | Relationships, joins और मज़बूत transactions वाला structured data | PostgreSQL, MySQL |
| **Document** | JSON जैसे records जो पूरे के पूरे read और write होते हैं, flexible shape | MongoDB |
| **Key-value** | Key से value get/set करना, बेहद तेज़; caching और sessions | Redis, DynamoDB |
| **Wide-column** | कई nodes पर फैले भारी write volumes, partition key से query | Apache Cassandra |
| **Graph** | ऐसा data जिसमें relationships ही असली बात हैं (friends, recommendations) | Neo4j |
| **Time-series** | समय से indexed metrics और events, retention और downsampling के साथ | TimescaleDB, InfluxDB |
| **Search** | Full-text search, relevance ranking, fuzzy matching | Elasticsearch, OpenSearch |
| **Vector** | Embeddings पर similarity search (semantic search, AI features) | Pinecone, pgvector |

Practice में ये सीमाएँ धुंधली हो जाती हैं: PostgreSQL JSON (`jsonb`) और vectors (`pgvector` extension के ज़रिए) store करता है; MongoDB में time-series collections हैं, और Atlas full-text और vector search जोड़ देता है। DynamoDB को अक्सर key-value और document दोनों कहा जाता है।

E-commerce store में आप orders के लिए **PostgreSQL या MongoDB**, sessions और cart cache के लिए **Redis**, product search box के लिए **Elasticsearch**, और reports के लिए एक **warehouse** इस्तेमाल कर सकते हैं।

> **याद रखें:** type को **access pattern** से चुनिए, hype से नहीं। "मैं यह data कैसे read और write करूँगा?" यही तय करता है कि database कौन-सा होगा।

## 7. आम गलतियाँ और gotchas

- **Database को सिर्फ़ एक dumb store समझना।** सब कुछ fetch करके Node में filtering, sorting और counting करना। काम database पर डालिए; उसके पास indexes और planner हैं।
- **App code में read-modify-write.** `find` → JS में बदलाव → `save` वही section 2 वाला lost-update bug है। Atomic operators (`$inc`, `UPDATE … SET stock = stock - 1 WHERE stock > 0`) या transaction इस्तेमाल कीजिए।
- **Interviews में "database" और "DBMS" को मिला देना।** साफ़ बोलिए: PostgreSQL एक DBMS है; `shop` उसके अंदर एक database है।
- **यह मान लेना कि call return होते ही write सुरक्षित है।** यह durability settings पर निर्भर करता है (PostgreSQL `synchronous_commit`, MongoDB write concern और journaling)।
- **Production OLTP database पर भारी analytics चलाना।** 3 साल की revenue report पूरी `orders` table scan कर सकती है और checkout धीमा कर सकती है। Read replica या warehouse इस्तेमाल कीजिए।
- **"Schemaless" का मतलब कोई schema नहीं।** Schema फिर भी होता है; बस वह database की जगह आपके code में रहता है, जहाँ उसे enforce करना ज़्यादा मुश्किल है।

## 8. Trade-offs: कब पूरा database ज़रूरत से ज़्यादा है

DBMS मुफ़्त नहीं आता: चलाने के लिए server, connections, backups, upgrades, monitoring। आपको इसकी ज़रूरत शायद न हो जब:

- Data **read-only config** है जो app के साथ ship होता है (JSON file ठीक है)।
- यह एक **single-user local tool** है। **SQLite** पर विचार कीजिए: एक ही file में असली SQL database, कोई server नहीं।
- ये **बड़ी binary files** हैं (product images, PDF invoices)। इन्हें **object storage** (S3) में रखिए और database में सिर्फ़ URL रखिए।
- यह **temporary data** है जिसकी durability की कोई ज़रूरत नहीं (in-memory cache से काम चल सकता है)।

जैसे ही आपके पास **कई concurrent users, ऐसा data जिसे आप खो नहीं सकते, या "सब कुछ load करो" से आगे की queries** हों, असली database इस्तेमाल कीजिए।
