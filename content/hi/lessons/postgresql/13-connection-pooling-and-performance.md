---
slug: postgres-connection-pooling
title: 'Connection pooling और performance: कम connections, समझदार queries'
module: Performance
summary: 'हर PostgreSQL connection महँगा क्यों है, client-side pools और PgBouncer इसे कैसे ठीक करते हैं, और application-level आदतें (N+1 नहीं, keyset pagination, batching, समझदार config) जो production में PostgreSQL को तेज़ रखती हैं।'
recap: >-
  हर PostgreSQL connection एक अलग server process है जिसकी अपनी memory होती है, इसलिए हज़ारों connections
  RAM और CPU बर्बाद करते हैं; max_connections बढ़ाना सिर्फ़ समस्या को छिपाता है। हर app process में एक client
  pool से connections reuse करें और, जब कई instances या serverless functions connect करते हों, तो आगे
  transaction mode में PgBouncer लगाएँ और session state से बचें। छोटे pools अक्सर बड़े pools से बेहतर होते
  हैं। फिर app ठीक करें: N+1 queries हटाएँ, keyset pagination use करें, inserts को batch करें, parameters
  use करें, shared_buffers और work_mem सावधानी से tune करें, और pg_stat_statements से सबसे बुरी queries ढूँढें।
---

## 1. कहानी

एक restaurant अंदर आने वाले **हर guest के लिए एक अलग waiter** रखता है। हर waiter को एक uniform, एक locker और kitchen corridor में जगह चाहिए।

- 20 guests: बढ़िया service।
- 2,000 guests: corridor जाम है, waiters kitchen के दरवाज़े पर एक-दूसरे से टकरा रहे हैं, और salary का बिल फट जाता है। खाना तेज़ नहीं, **और धीमा** आता है।

एक समझदार restaurant **15 waiters** और **दरवाज़े पर एक host** रखता है। Guests host stand पर एक पल इंतज़ार करते हैं, और waiter उसी को serve करता है जो *अभी* order देने को तैयार है। ज़्यादातर guests अपना ज़्यादातर समय menu पढ़ने में लगाते हैं, इसलिए 15 waiters आराम से 300 tables संभाल लेते हैं।

| Restaurant | PostgreSQL |
|---|---|
| एक waiter | एक connection को serve करने वाला **backend process** |
| हर guest के लिए waiter रखना | हर request के लिए connection खोलना |
| Uniform और locker | हर connection की memory और startup cost |
| Waiters की तय team | एक **connection pool** |
| दरवाज़े पर host | **PgBouncer** (एक server-side pooler) |
| Menu पढ़ता guest | Idle connection / queries के बीच का समय |

> **याद रखें:** throughput **कुछ busy connections** से आता है, बहुत सारे idle connections से नहीं।

## 2. Connections महँगे क्यों हैं

PostgreSQL **हर connection के लिए एक process** use करता है ([PostgreSQL architecture](/lessons/postgres-architecture) देखें)। हर नए connection का मतलब है:

- एक **backend process** fork करना, authenticate करना (TLS, password hashing) और catalog caches load करना: अक्सर milliseconds का काम।
- हर process की **memory**: आराम की हालत में कुछ MB, और query चलते समय हर sort या hash के लिए `work_mem`।
- सैकड़ों **active** processes के साथ, वे CPU cores, locks और shared memory के लिए लड़ते हैं, और throughput **गिर जाता है**।

`max_connections` (default **100**, बदलने के लिए restart चाहिए) इनकी सीमा तय करता है। "बस इसे 5,000 कर दो" ग़लत fix है: memory use और contention उसके साथ बढ़ते हैं, और 16 cores पर आप फिर भी एक साथ 5,000 queries नहीं चला सकते।

> **याद रखें:** 16 cores वाला database एक साथ लगभग 16 चीज़ें ही *execute* कर सकता है। Extra connections बस आपके pool की जगह server के अंदर queue में खड़े रहते हैं।

## 3. Node.js में client-side pools

`node-postgres` (`pg`) हर process को एक **pool** देता है: खुले connections का एक set, जिन्हें requests उधार लेती हैं और वापस करती हैं।

```js
// db.js — create ONE pool per process, at startup
import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                        // max connections in this pool (default 10)
  idleTimeoutMillis: 30_000,      // close connections idle this long (default 10 s)
  connectionTimeoutMillis: 5_000, // error if no connection free in 5 s (default: wait forever)
});

pool.on('error', (err) => {
  // an idle connection died (e.g. DB restart); log it instead of crashing
  console.error('pg pool error', err);
});
```

एक अकेली query के लिए `pool.query` एक connection उधार लेता है, query चलाता है और उसे लौटा देता है:

```js
const { rows } = await pool.query(
  'SELECT id, name, price FROM products WHERE id = $1', [productId]);
```

एक **transaction** को हर statement **उसी connection** पर चलाना होता है, इसलिए `pool.connect()` से एक connection check out करें और **उसे हमेशा release करें**:

```js
export async function placeOrder(customerId, productId, qty) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      'UPDATE products SET stock = stock - $2 WHERE id = $1 AND stock >= $2',
      [productId, qty]);
    if (rowCount === 0) throw new Error('Out of stock');
    const { rows: [order] } = await client.query(
      `INSERT INTO orders (customer_id, status, total, created_at)
       SELECT $1, 'pending', price * $3, now() FROM products WHERE id = $2
       RETURNING id`,
      [customerId, productId, qty]);
    await client.query('COMMIT');
    return order.id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();   // forget this and the pool slowly runs dry
  }
}
```

⚠️ दो classic bugs:

- `BEGIN` / `COMMIT` को `pool.query` से चलाना: हर call **अलग** connection पर जा सकती है, इसलिए कोई असली transaction नहीं बनता।
- Error वाले रास्ते पर `release()` call न करना: एक **connection leak**। `max` leaks के बाद हर request इंतज़ार करती है और फिर time out हो जाती है।

### Instances के पार हिसाब लगाएँ

हर process का अपना pool होता है। **20 pods × `max: 10` = 200 connections**, जो default `max_connections` का पहले ही दोगुना है। ऐसा deploy जोड़ें जिसमें पुराने और नए pods overlap करें, तो यह 400 हो जाता है।

## 4. PgBouncer: PostgreSQL के आगे एक pooler

**PgBouncer** एक हल्का proxy है। हज़ारों clients सस्ते में उससे connect करते हैं; वह उन्हें थोड़े से असली server connections पर map कर देता है।

```text
 ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
 │ pod 1  │ │ pod 2  │ │ pod …  │ │ lambda │   2,000 client
 └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘   connections
     └──────────┴────┬─────┴──────────┘
              ┌──────▼──────┐
              │  PgBouncer  │   pool_mode = transaction
              └──────┬──────┘
                     │  20 server connections
              ┌──────▼──────┐
              │ PostgreSQL  │
              └─────────────┘
```

```ini
; pgbouncer.ini
[databases]
shop = host=10.0.0.5 port=5432 dbname=shop

[pgbouncer]
listen_port = 6432
pool_mode = transaction
max_client_conn = 5000
default_pool_size = 20
```

**Pool mode** तय करता है कि server connection कब pool में वापस जाता है:

| Mode | Server connection कब लौटता है… | Reuse | किसके लिए safe |
|---|---|---|---|
| **session** (default) | जब client disconnect करता है | कम | सब कुछ |
| **transaction** | हर transaction के अंत में | ज़्यादा | ज़्यादातर web apps (सावधानी के साथ) |
| **statement** | हर statement के बाद | सबसे ज़्यादा | सिर्फ़ autocommit; multi-statement transactions reject होते हैं |

### Transaction mode में क्या टूटता है

आपका अगला transaction किसी **अलग** server connection पर चल सकता है, इसलिए जो कुछ भी **session** में रहता है उस पर भरोसा नहीं किया जा सकता:

- Session level पर `SET search_path ...` या `SET statement_timeout ...` (इसकी जगह transaction के अंदर `SET LOCAL` use करें)।
- **Session-level advisory locks** (`pg_advisory_lock`); `pg_advisory_xact_lock` use करें।
- `LISTEN` / `NOTIFY` listeners (listeners के लिए direct connection use करें)।
- Temporary tables और `WITH HOLD` cursors जो transaction के बाद भी ज़िंदा रहते हैं।
- **Prepared statements:** SQL-level `PREPARE` काम नहीं करता। Protocol-level named prepared statements भी पहले टूटते थे; नए PgBouncer versions (1.21+) `max_prepared_statements` set होने पर उन्हें track कर सकते हैं। इस पर भरोसा करने से पहले अपना version और config check करें।

> **याद रखें:** transaction pooling सबसे अच्छा reuse देता है, बशर्ते आप **session में कोई state न रखें**।

### Serverless और connection storms

AWS Lambda या Vercel पर हर concurrent instance एक अलग process है, जिसका अपना pool है। Traffic अचानक 1,000 concurrent invocations तक पहुँचे तो **seconds में हज़ारों connections** खुल सकते हैं, यानी एक **connection storm**, और database `too many clients already` पर पहुँच जाता है।

Fixes: pool को handler के **बाहर** बनाएँ ताकि warm invocations उसे reuse करें, `max` बहुत छोटा (1–2) रखें, और एक pooler के ज़रिए connect करें: PgBouncer, **RDS Proxy**, या आपके provider का built-in pooler।

## 5. Pool कितना बड़ा होना चाहिए?

जितना आप सोचते हैं उससे छोटा। जब CPU cores और disks busy हो चुके हों, उसके बाद extra connections सिर्फ़ contention बढ़ाते हैं।

एक आम **शुरुआती point** (HikariCP project से, database तक पहुँचने वाले कुल connections के लिए):

```text
connections ≈ (CPU cores × 2) + effective spindles
```

SSD वाले 8-core server के लिए यह लगभग 17–20 **active** connections है। इसे load testing का शुरुआती point मानें, कोई क़ानून नहीं: जो workloads I/O या network का इंतज़ार करते हैं वे ज़्यादा use कर सकते हैं। फिर इसे अपने app instances में बाँटें: PgBouncer के पीछे 4 pods में कुल 20 एक समझदार शुरुआत है।

## 6. Application-level performance

Pooling connection overhead ठीक करता है। ज़्यादातर असली धीमापन इसमें होता है कि **app क्या माँगती है**।

### N+1 query problem

```js
// Sequelize: 1 query for orders + 1 query PER order = N+1
const orders = await Order.findAll({ where: { status: 'paid' }, limit: 50 });
for (const order of orders) {
  order.customer = await order.getCustomer();   // 50 extra round trips
}
```

हर round trip पर 1 ms के हिसाब से यह 51 ms की शुद्ध latency है, और page size के साथ बढ़ती है। इसे **एक query** से ठीक करें (Sequelize में `include: Customer` एक JOIN बनाता है), या plain SQL में:

```sql
-- One JOIN
SELECT o.id, o.total, c.name
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'paid'
LIMIT 50;
```

```js
// Or two queries: orders, then all their customers at once
const ids = [...new Set(orders.map((o) => o.customer_id))];
const { rows } = await pool.query(
  'SELECT id, name FROM customers WHERE id = ANY($1)', [ids]);  // JS array → PG array
```

### OFFSET की जगह keyset pagination

`OFFSET 100000` सीधे jump नहीं करता: PostgreSQL 100,000 rows पढ़ता है और फेंक देता है। `(created_at DESC, id DESC)` पर index वाली 300,000 rows की `orders` table से असली नतीजे:

```sql
-- ❌ OFFSET
SELECT id, total, created_at FROM orders
ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET 100000;

-- ✅ Keyset: continue after the last row of the previous page
SELECT id, total, created_at FROM orders
WHERE (created_at, id) < ('2026-02-27 20:53:20+00', 200001)
ORDER BY created_at DESC, id DESC LIMIT 20;
```

```text
OFFSET:  Index Scan ... (actual rows=100020)
         Buffers: shared hit=1220        Execution Time: 24.895 ms
Keyset:  Index Cond: (ROW(created_at, id) < ROW(...))
         (actual rows=20)
         Buffers: shared hit=3 read=1    Execution Time: 0.608 ms
```

वही 20 rows, लगभग **40× तेज़** और **300× कम pages**, और page जितना गहरा, अंतर उतना बढ़ता जाता है। **Row comparison** `(created_at, id) < (...)` सीधे index use करता है, और `id` बराबर timestamps के बीच tie तोड़ता है। Trade-off: "page 500 पर jump करो" नहीं हो सकता। ये plans पढ़ने के लिए [EXPLAIN](/lessons/postgres-explain) देखें।

### अपने writes को batch करें

1,000 order items को एक-एक statement से insert करने में 1,000 round trips और 1,000 commits लगते हैं।

```sql
-- Multi-row INSERT
INSERT INTO order_items (order_id, product_id, qty)
VALUES (1, 10, 2), (1, 11, 1), (1, 12, 5);
```

```js
// Arrays + unnest: one statement, one parameter per column, any number of rows
await pool.query(
  `INSERT INTO order_items (order_id, product_id, qty)
   SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::int[])`,
  [orderIds, productIds, qtys]);
```

Bulk loads (millions rows) के लिए **`COPY`** use करें, जो PostgreSQL में data डालने का सबसे तेज़ रास्ता है (Node से `pg-copy-streams` package के ज़रिए)। कई छोटे writes को एक transaction में लपेटना भी मदद करता है, क्योंकि हर commit एक WAL flush का इंतज़ार करता है।

### Parameterized queries

```js
// ❌ SQL injection: email = "x' OR '1'='1"
pool.query(`SELECT * FROM users WHERE email = '${email}'`);

// ✅ Value sent separately from the SQL text
pool.query('SELECT * FROM users WHERE email = $1', [email]);
```

Parameters कभी SQL के रूप में parse नहीं होते, इसलिए वे **SQL injection** से बचाव हैं। वे सिर्फ़ **values** की जगह ले सकते हैं, table या column names की नहीं; उनके लिए allowlist रखें। Query config में `name` देने पर (`{ name: 'get-user', text, values }`) `pg` हर connection पर एक **named prepared statement** बनाता है, जिससे बार-बार parsing बचती है।

> **याद रखें:** ज़्यादातर "slow database" incidents N+1 queries, गहरे `OFFSET`, row-by-row writes या missing index की वजह से होते हैं, PostgreSQL ख़ुद की वजह से नहीं।

## 7. Config knobs जो पता होने चाहिए

| Setting | Default | समझदार शुरुआती value | क्यों |
|---|---|---|---|
| `shared_buffers` | 128 MB | RAM का ~25% | PostgreSQL का अपना page cache; OS cache और ज़्यादा रखता है |
| `work_mem` | 4 MB | 16–64 MB, सावधानी से | **हर sort/hash node** के लिए memory, हर query, हर connection |
| `effective_cache_size` | 4 GB | RAM का ~50–75% | सिर्फ़ planner के लिए **hint**, कुछ allocate नहीं करता |
| `maintenance_work_mem` | 64 MB | 512 MB – 1 GB+ | VACUUM, `CREATE INDEX` |
| `random_page_cost` | 4 | SSD पर ~1.1 | Planner को बताता है कि random reads ज़्यादा धीमे नहीं हैं |

⚠️ **`work_mem` गुणा होता है।** एक query में कई sorts और hashes हो सकते हैं (hashes `work_mem × hash_mem_multiplier` use कर सकते हैं, default 2), हर parallel worker को अपना हिस्सा मिलता है, और हर connection यह एक साथ कर सकता है: 200 connections × 3 nodes × 64 MB ≈ **38 GB**। भारी reports के लिए इसे globally बढ़ाने की जगह per query या per role (`SET LOCAL work_mem = '256MB'`) बढ़ाएँ।

**`idle_in_transaction_session_timeout`** (जैसे 60 s) भी set करें: "idle in transaction" में अटका connection locks पकड़े रहता है और VACUUM को block करता है ([MVCC and VACUUM](/lessons/postgres-mvcc-and-vacuum) देखें)।

## 8. Production में diagnose करना

**`pg_stat_statements`** हर query shape को aggregate करता है: calls, total और mean time। इसके लिए `shared_preload_libraries = 'pg_stat_statements'` (restart) और `CREATE EXTENSION pg_stat_statements;` चाहिए।

```sql
-- Where is the database spending its time?
SELECT calls, round(total_exec_time) AS total_ms,
       round(mean_exec_time::numeric, 2) AS mean_ms, rows,
       left(query, 60) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

पहले **total** time से sort करें: 5 million बार call होने वाली 2 ms की query, दिन में दो बार चलने वाली 3 s की query से ज़्यादा मायने रखती है। N+1 एक सस्ती query के रूप में दिखता है जिसका `calls` count बहुत बड़ा होता है।

**`pg_stat_activity`** अभी के हर connection को दिखाता है:

```sql
-- Connection usage by state
SELECT state, count(*) FROM pg_stat_activity
WHERE backend_type = 'client backend' GROUP BY state;

-- Transactions left open by the app
SELECT pid, now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY xact_age DESC;
```

बहुत सारे `idle` = pools बहुत बड़े हैं; बहुत सारे `idle in transaction` = leaked clients या transactions के अंदर धीमा app code; `wait_event_type = 'Lock'` के साथ बहुत सारे `active` = contention ([Locking](/lessons/postgres-locking) देखें)।

## 9. इन्हें आपस में confuse न करें

| | Client pool (`pg.Pool`) | PgBouncer | `max_connections` बढ़ाना |
|---|---|---|---|
| कहाँ रहता है | हर app process में | अलग proxy | PostgreSQL |
| Instances के पार connections share करता है | ❌ | ✅ | — |
| Connection setup बचाता है | ✅ | ✅ | ❌ |
| Server processes सीमित करता है | सिर्फ़ per process | ✅ globally | ❌ और जोड़ता है |
| Gotchas | Leaks, गुणा होना | Transaction mode में session state | Memory, contention |

MongoDB से तुलना करें, जहाँ drivers अंदर ही connections pool करते हैं और server processes की जगह threads use करता है ([MongoDB performance](/lessons/mongodb-performance))। आदत वही है: हर process में एक pool, सोच-समझकर तय किया गया size।

## 10. Production checklist

| Area | Check |
|---|---|
| Pools | हर process में एक `pg.Pool`; हर `connect()` के `finally` में `release()` |
| Totals | instances × `max`, `max_connections` से काफ़ी नीचे रहे |
| Pooler | कई instances या serverless के लिए PgBouncer / RDS Proxy; transaction mode, कोई session state नहीं |
| Timeouts | `connectionTimeoutMillis`, `statement_timeout`, `idle_in_transaction_session_timeout` |
| Queries | कोई N+1 नहीं; JOIN या `= ANY($1)`; सिर्फ़ ज़रूरी columns |
| Pagination | Feeds और APIs के लिए keyset |
| Writes | Multi-row INSERT / `unnest` / `COPY`; transactions में batched |
| Security | सिर्फ़ parameters, कभी string जोड़कर बना SQL नहीं |
| Config | `shared_buffers` RAM का ~25%, सावधानी से `work_mem`, SSD के लिए `random_page_cost` |
| Observability | `pg_stat_statements` की समीक्षा; connections और लंबे transactions पर alerts |

## 11. Trade-offs: कब परेशान न हों

- **एक छोटी अकेली app**, जिसमें एक process और `max: 10` हो, उसे PgBouncer की ज़रूरत नहीं। इसे तब जोड़ें जब instances की गिनती या serverless की वजह से connections गुणा होने लगें।
- अगर आपकी app `LISTEN`, session advisory locks या session `SET` पर निर्भर है, तो **session pooling** ज़्यादा safe है, लेकिन reuse बहुत कम मिलता है।
- छोटी admin tables के लिए, जहाँ users को page numbers चाहिए, **OFFSET ठीक है**।
- **Queries से पहले config tune न करें।** एक missing index या एक N+1 किसी भी `postgresql.conf` बदलाव से कहीं बड़ा असर डालता है।

> **याद रखें:** पहले connections pool करें, फिर query patterns ठीक करें, फिर config tune करें, इसी क्रम में, और हर step को measure करें।
