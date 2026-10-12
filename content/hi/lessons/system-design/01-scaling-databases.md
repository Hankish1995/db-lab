---
slug: scaling-databases
title: 'Databases को scale करना: 100 users से 10 million तक, एक-एक bottleneck करके'
module: Scaling
summary: 'Database वाली app एक server से multi-store architecture तक कैसे बढ़ती है, हर stage पर कौन सा bottleneck आता है, उसे कैसे measure करें, और जब तक numbers न कहें तब तक हर step जल्दबाज़ी क्यों है।'
recap: >-
  Scaling fixes की एक sequence है, और हर fix किसी measured bottleneck से शुरू होता है: पहले queries और indexes
  ठीक करें, फिर बड़ी machine लें, connections pool करें, hot reads cache करें, read replicas जोड़ें, बड़ी tables
  partition करें, और sharding तभी करें जब एक primary writes या data नहीं संभाल पाता। App servers को stateless रखें
  ताकि वे copies जोड़कर scale हों। बड़े scale पर read models अलग करें (CQRS) और हर काम के लिए सही store use करें:
  cache, search engine, warehouse। हर step से पहले p95/p99 latency, QPS, CPU, IOPS और connections measure करें,
  क्योंकि हर step ऐसी complexity जोड़ता है जिसकी कीमत आप हमेशा चुकाते हैं।
---

## 1. कहानी: एक shop जो बार-बार अपने साइज़ से बड़ी हो जाती है

Priya एक online sneaker shop खोलती है। एक Node.js server, एक PostgreSQL database, दोनों एक ही $20 की VM पर। सब चलता है।

फिर shop popular हो जाती है, और हर कुछ महीनों में **कुछ नए तरीके से टूट जाता है**। हर बार fix अलग होता है, और हर fix सिर्फ़ *उसी समय* सही होता है:

| Stage | Users | क्या दर्द दे रहा है | अगला step |
|---|---|---|---|
| 0 | 100 | कुछ नहीं | Features ship करो |
| 1 | 10k | Product pages में 2 s लगते हैं | **Queries और indexes** |
| 2 | 50k | DB CPU पूरे दिन 85% पर | **Vertical scaling** |
| 3 | 100k | "too many connections" | **Connection pooling**, stateless app |
| 4 | 500k | एक ही product 1,000×/s पढ़ा जा रहा है | **Caching** |
| 5 | 1M | Reads अब भी primary को भर देते हैं | **Read replicas** |
| 6 | 3M | `orders` table 2 TB की है, vacuum कभी ख़त्म नहीं होता | **Partitioning** + archiving |
| 7 | 10M | Writes एक primary की क्षमता से ज़्यादा | **Sharding** |
| 8 | 10M+ | Search, dashboards, reports checkout से लड़ते हैं | **CQRS** + **polyglot persistence** |

इसे एक restaurant की तरह सोचें। पहले आप chef को तेज़ बनाते हैं (बेहतर recipes = **query tuning**)। फिर बड़ी kitchen खरीदते हैं (**vertical scaling**)। फिर ज़्यादा waiters रखते हैं (**stateless app servers**) और उन्हें एक shared order rail देते हैं ताकि हर कोई chef पर अलग से न चिल्लाए (**connection pool**)। आप popular dishes पहले से तैयार रखते हैं (**cache**), एक दूसरी kitchen खोलते हैं जो सिर्फ़ dishes की copies plate करती है (**read replicas**), और आख़िर में एक दूसरा restaurant खोलते हैं (**sharding**)।

> **याद रखें:** scaling एक अकेला फ़ैसला नहीं है। यह छोटे fixes की एक sequence है, और हर fix किसी ऐसे bottleneck से शुरू होता है जिसे आपने measure किया है।

## 2. Scale करने से पहले measure करें

नीचे का हर step हमेशा के लिए cost और complexity जोड़ता है। इसलिए पहला नियम है: **असली bottleneck ढूँढें**। जो numbers मायने रखते हैं:

| Metric | यह आपको क्या बताता है |
|---|---|
| **p95 / p99 latency** | सबसे धीमी 5% / 1% requests कितनी धीमी हैं। Averages दर्द छिपा लेते हैं। |
| **QPS** (queries per second) | Load, reads और writes में बँटा हुआ |
| **CPU** | Query execution की cost (बुरे plans, missing indexes) |
| **IOPS** और disk latency | Data RAM में नहीं समाता, इसलिए reads disk पर जाते हैं |
| **Cache hit ratio** (buffer cache) | क्या आपका working set memory में है? |
| **Active connections** | Pool exhaustion, connection storms |
| **Replication lag** | Replicas कितनी stale हैं |

Percentiles क्यों? अगर 99 requests 20 ms लेती हैं और 1 request 3 s लेती है, तो **average** ~50 ms है और ठीक लगता है। **p99** 3 s है, और वह user checkout कर रहा है। जो page 20 backend calls करता है, वह किसी p99-slow call से 1% से कहीं ज़्यादा बार टकराता है।

PostgreSQL में `pg_stat_statements` से शुरू करें (एक extension जिसे आप एक बार enable करते हैं), ताकि वे queries मिलें जो कुल मिलाकर सबसे ज़्यादा cost करती हैं:

```sql
SELECT query, calls,
       round(mean_exec_time::numeric, 1)  AS mean_ms,
       round(total_exec_time::numeric, 0) AS total_ms
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

जो query 5 ms लेती है लेकिन दिन में 2 million बार चलती है, वह अक्सर एक बार चलने वाली 3-second की report से ज़्यादा मायने रखती है।

> **याद रखें:** averages के लिए नहीं, p95/p99 और total time के लिए optimize करें। Customers सबसे धीमी requests ही याद रखते हैं।

## 3. Stages 1–3: एक database से ज़्यादा काम लें

### Stage 1: queries और indexes (10k users)

Product listing category से filter करती है और price से sort करती है। Index के बिना PostgreSQL हर row scan करता है।

```sql
EXPLAIN ANALYZE
SELECT id, name, price_cents FROM products
WHERE category_id = 42 ORDER BY price_cents LIMIT 20;

CREATE INDEX CONCURRENTLY idx_products_category_price
  ON products (category_id, price_cents);
```

दूसरी सस्ती जीतें: **N+1 queries** ठीक करें (कुल एक query की जगह हर order item के लिए एक query), सिर्फ़ ज़रूरी columns select करें, और बड़े `OFFSET` की जगह **keyset pagination** use करें। यह step मुफ़्त है और अक्सर 10–100× सुधार देता है। [How indexes work](/lessons/how-indexes-work) देखें।

### Stage 2: vertical scaling (50k users)

Queries अच्छी हैं, लेकिन machine बस busy है। **Vertical scaling** (बड़ा CPU, ज़्यादा RAM, तेज़ disks) को कम आँका जाता है: इसमें code बदलने की ज़रूरत नहीं, और सैकड़ों GB RAM और तेज़ NVMe disks वाली आज की cloud machines हैरान करने वाले बड़े business को संभाल सकती हैं। साथ ही database को app से अलग, **उसकी अपनी machine** पर ले जाएँ।

सीमाएँ: ऊपरी सिरे पर कीमत capacity से तेज़ बढ़ती है, एक ceiling है, और यह फिर भी **single point of failure** है।

### Stage 3: connection pooling और stateless app servers (100k users)

Traffic संभालने के लिए आप एक load balancer के पीछे 20 Node.js instances चलाते हैं। हर एक 20 connections का pool खोलता है: 400 connections। PostgreSQL **हर connection के लिए एक process** use करता है, इसलिए सैकड़ों ज़्यादातर idle connections memory बर्बाद करते हैं और contention बढ़ाते हैं। Autoscaling इसे और बुरा बनाता है: traffic spike 30 और instances शुरू कर देता है, और database `too many connections` के साथ गिर जाता है।

Fixes:

- हर app pool का size सोच-समझकर तय करें। node-postgres में:

```ts
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                        // per instance; total = instances × max
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000, // fail fast instead of queueing forever
});
```

- Apps और database के बीच PgBouncer जैसा **connection pooler** लगाएँ, ताकि हज़ारों client connections कुछ दर्जन server connections share करें। Details [PostgreSQL connection pooling](/lessons/postgres-connection-pooling) में हैं।
- एक काम का sanity check है **Little's law**: concurrent queries ≈ QPS × average query time। 2,000 QPS × 5 ms ≈ औसतन 10 queries चल रही होती हैं, इसलिए आपको अंदाज़े से कहीं कम connections चाहिए।

साथ ही app servers को **stateless** बनाएँ: कोई sessions, carts या uploads server की memory या local disk में नहीं। Sessions Redis में रखें (या signed tokens use करें) और files object storage में। तब कोई भी instance कोई भी request serve कर सकता है, और app tier को scale करना बस "और copies जोड़ो" है।

> **याद रखें:** app servers cattle होने चाहिए, pets नहीं। अगर एक को मारने से user data खो जाता है, तो वह अभी stateless नहीं है।

## 4. Stages 4–5: reads को primary से हटाएँ

### Stage 4: caching (500k users)

ज़्यादातर e-commerce traffic **reads** है: products, categories और reviews browse करना। एक ही product page बदलावों के बीच हज़ारों बार पढ़ा जाता है। आगे एक cache लगाएँ: images और static assets के लिए CDN, product details जैसे hot objects के लिए Redis। एक अच्छा cache reads का बड़ा हिस्सा सोख सकता है। Patterns और जाल (stale data, stampedes) [Caching](/lessons/caching) में हैं।

### Stage 5: read replicas (1M users)

कुछ reads को अच्छे से cache नहीं किया जा सकता: "my orders", अनगिनत combinations वाले search filters, एक admin dashboard। **Read replicas** जोड़ें: database की copies जो primary के changes apply करती हैं और reads serve करती हैं।

```ts
// writes always go to the primary
await primary.query('UPDATE users SET address = $1 WHERE id = $2', [addr, userId]);

// lag-tolerant reads go to a replica
const { rows } = await replica.query(
  'SELECT id, name, price_cents FROM products WHERE category_id = $1', [catId]);
```

पेच है **replication lag**: replicas आम तौर पर milliseconds पीछे होती हैं, कभी-कभी seconds। जिस user ने अभी अपना address बदला और तुरंत replica से पढ़ा, उसे पुराना address दिख सकता है। "अपने हाल के writes पढ़ना" वाले reads को primary पर भेजें। Replicas **writes को scale नहीं करतीं**: हर replica को हर write apply करना पड़ता है। [Replication patterns](/lessons/replication-patterns) देखें।

> **याद रखें:** caches और replicas reads को scale करते हैं। अगर आपकी समस्या writes है, तो इस section की कोई चीज़ मदद नहीं करती।

## 5. Stages 6–7: data को बाँटें

### Stage 6: partitioning और archiving (3M users)

`orders` table में billions rows हैं। Indexes अब RAM में नहीं समाते, maintenance (vacuum, index rebuilds) में घंटों लगते हैं, और लगभग हर query पिछले 90 दिनों के बारे में पूछती है।

**Partitioning** एक table को **उसी server** पर टुकड़ों में बाँटता है, जैसे हर महीने का एक partition। Date filter वाली queries सिर्फ़ relevant partitions को छूती हैं (**partition pruning**), और एक पूरा पुराना महीना drop करना millions rows को `DELETE` करने की तुलना में तुरंत हो जाता है। पुराने orders सस्ते storage पर जा सकते हैं। [PostgreSQL partitioning](/lessons/postgres-partitioning) देखें।

### Stage 7: sharding (10M users)

Sharding data को **कई servers** पर बाँटता है, और हर server keys के एक हिस्से के लिए एक पूरा primary (अपनी replicas के साथ) होता है। यही अकेला step है जो **writes और storage** को horizontally scale करता है। साथ में shard-key चुनने, cross-shard queries और resharding का दर्द भी आता है, जो [Sharding](/lessons/sharding) में cover किया गया है।

Interviews में कहने लायक एक reality check: shop के shard करने की वजह शायद ही कभी order writes होते हैं। दिन में 50,000 orders औसतन एक write per second से भी कम है। ज़्यादा volume वाले writes आम तौर पर carts, clickstream events, inventory reservations या logs से आते हैं, और ये अक्सर main database को shard करवाने की जगह किसी दूसरे store में चले जाते हैं।

## 6. Stage 8: CQRS और polyglot persistence

इस साइज़ पर एक database से सब कुछ करवाया जा रहा है: checkout transactions, typo tolerance वाला full-text search, "हर हफ़्ते region के हिसाब से revenue" reports, और recommendation features। ये workloads एक ही CPU और cache के लिए लड़ते हैं।

**CQRS** (Command Query Responsibility Segregation) **write model** (normalized tables जो checkout पर नियम लागू करती हैं) को एक या ज़्यादा **read models** से अलग करता है, जो ख़ास queries के हिसाब से बने होते हैं: storefront के लिए एक denormalized product document, एक search index, एक pre-aggregated sales table। Read models write side से asynchronously update होते हैं, आम तौर पर events या **change data capture** (CDC) के ज़रिए, इसलिए वे eventually consistent होते हैं।

**Polyglot persistence** का मतलब है हर काम के लिए सही store use करना:

| काम | आम store |
|---|---|
| Orders, payments, inventory | Relational DB (या transactions के साथ MongoDB) |
| Hot reads, sessions, rate limits | Redis |
| Product search, facets, typo tolerance | Search engine (Elasticsearch / OpenSearch) |
| Analytics, BI reports | Columnar warehouse (BigQuery, Snowflake, Redshift…) |
| Images, invoices | Object storage (S3-compatible) |

आख़िरी architecture:

```text
 Users ──► CDN ──► Load balancer
                        │
          ┌─────────────┼─────────────┐
      ┌───▼───┐     ┌───▼───┐     ┌───▼───┐
      │ App 1 │     │ App 2 │     │ App N │   stateless
      └───┬───┘     └───┬───┘     └───┬───┘
          └─────────────┼─────────────┘
    ┌─────────┐         │         ┌──────────────┐
    │  Redis  │◄────────┼────────►│ Search index │
    │  cache  │         │         └──────▲───────┘
    └─────────┘         ▼                │
                ┌───────────────┐        │
                │   PgBouncer   │        │
                └───────┬───────┘        │
                        ▼                │
           ┌─────────────────────────┐   │ CDC /
           │ Primary (shards if any) ├───┤ events
           └────────────┬────────────┘   │
                        │ async          ▼
                ┌───────▼───────┐ ┌─────────────┐
                │ Read replicas │ │  Warehouse  │
                └───────────────┘ └─────────────┘
```

> **याद रखें:** primary database source of truth है। Caches, replicas, search indexes और warehouse सब derived copies हैं, और हर copy stale हो सकती है।

## 7. लक्षण → संभावित fix

| लक्षण | संभावित वजह | संभावित fix |
|---|---|---|
| एक endpoint धीमा, DB CPU ज़्यादा | Missing index, बुरा plan | `EXPLAIN ANALYZE`, index जोड़ें, query दोबारा लिखें |
| p99 spikes, ज़्यादा disk reads | Working set > RAM | ज़्यादा RAM, छोटे indexes, पुराना data archive करें |
| Deploy/spike पर `too many connections` | हर instance का pool × instances | छोटे pools, PgBouncer |
| वही rows हज़ारों बार पढ़ी जाती हैं | Read-heavy hot data | Cache (Redis, CDN) |
| Primary CPU ज़्यादा, ज़्यादातर reads | Read volume | Read replicas |
| Save करने के बाद users को पुराना data दिखता है | Lag वाली replica या stale cache से पढ़ना | Read-your-writes routing, cache invalidation |
| बहुत बड़ी table, धीमा maintenance | Table का साइज़ | Partitioning, archiving |
| Write throughput या storage एक primary से ज़्यादा | Single-writer limit | Sharding, या उस workload को दूसरे store में ले जाएँ |
| Reports checkout को धीमा करते हैं | OLTP और analytics मिले-जुले | Reports के लिए replica, फिर एक warehouse |
| `LIKE '%term%'` वाली search queries | ग़लत tool | Search engine |

## 8. आम गलतियाँ

- **ग़लत चीज़ को scale करना।** जब समस्या एक unindexed query है, तब replicas जोड़ना बस धीमेपन को copy करता है।
- **50k users पर sharding** "क्योंकि हम बड़े होंगे"। जो समस्या आपके पास है ही नहीं, उसके लिए आप हर दिन complexity की कीमत चुकाते हैं।
- Autoscaling app servers के साथ **बेलगाम (unbounded) connection pools**।
- **Invalidation plan के बिना caching**, फिर हफ़्तों तक "ग़लत price" वाले bugs debug करना।
- **हर जगह replicas से पढ़ना** और उन flows को तोड़ देना जिन्हें fresh data चाहिए (checkout, "my profile")।
- **Averages पर भरोसा करना।** p50 शानदार दिखता है जबकि p99 में आग लगी है।
- **Write path को नज़रअंदाज़ करना।** Reads copies से आसानी से scale होते हैं; writes को बाँटना पड़ता है।

## 9. हर step कब जल्दबाज़ी है

| Step | जल्दबाज़ी है जब… |
|---|---|
| Vertical scaling | Queries unindexed हैं; आप बुरा SQL चलाने के लिए hardware खरीद रहे होंगे |
| Connection pooler | कुछ ही app instances हैं, connections server limit से काफ़ी नीचे हैं |
| Cache | DB आराम में है; data लगातार बदलता है; आप staleness बर्दाश्त नहीं कर सकते |
| Read replicas | Load writes का है, या धीमा हिस्सा एक query है जिसे index ठीक कर देगा |
| Partitioning | Tables में millions rows हैं, billions नहीं; queries partition key से filter नहीं करतीं |
| Sharding | एक primary writes संभाल लेता है और data समा जाता है; आपने ऊपर के steps आज़माए नहीं हैं |
| CQRS / extra stores | एक database सारी queries ठीक से serve करता है; team और systems operate नहीं कर सकती |

हर नया component monitor, back up, secure और consistent रखने के लिए एक और चीज़ है। सबसे अच्छा architecture **वह सबसे simple architecture है जो आपकी measured ज़रूरतें पूरी करे, और जिसके पास अगले step का plan हो**।

> **याद रखें:** interview में सीढ़ी को क्रम से चढ़ें और हर step को एक number से justify करें। "हम shard करते हैं क्योंकि writes X per second तक पहुँचते हैं" "हम shard करते हैं क्योंकि यह scale होता है" से बेहतर है।
