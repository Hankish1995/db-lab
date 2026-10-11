---
slug: postgres-connection-pooling
title: 'Connection pooling and performance: fewer connections, smarter queries'
module: Performance
order: 130
summary: Why every PostgreSQL connection is expensive, how client-side pools and PgBouncer fix it, and the application-level habits (no N+1, keyset pagination, batching, sane config) that keep PostgreSQL fast in production.
level: advanced
tags: [postgresql, connection-pooling, pgbouncer, node-postgres, performance, pagination, configuration, monitoring]
recap: >-
  Every PostgreSQL connection is a separate server process with its own memory, so thousands of connections
  waste RAM and CPU; raising max_connections only hides the problem. Reuse connections with a client pool in
  each app process and, when many instances or serverless functions connect, put PgBouncer in transaction mode
  in front, avoiding session state. Small pools often beat big ones. Then fix the app: kill N+1 queries, use
  keyset pagination, batch inserts, use parameters, tune shared_buffers and work_mem carefully, and find the
  worst queries with pg_stat_statements.
---

## 1. The story

A restaurant hires a **dedicated waiter for every guest** who walks in. Each waiter needs a uniform, a locker and a spot in the kitchen corridor.

- 20 guests: lovely service.
- 2,000 guests: the corridor is jammed, waiters bump into each other at the kitchen door, and the payroll explodes. Food comes out **slower**, not faster.

A smarter restaurant keeps **15 waiters** and a **host at the door**. Guests wait a moment at the host stand, and a waiter serves whoever is ready to order *right now*. Most guests spend most of their time reading the menu, so 15 waiters easily handle 300 tables.

| Restaurant | PostgreSQL |
|---|---|
| A waiter | A **backend process** serving one connection |
| Hiring a waiter for each guest | Opening a connection per request |
| Uniform and locker | Per-connection memory and startup cost |
| Fixed team of waiters | A **connection pool** |
| Host at the door | **PgBouncer** (a server-side pooler) |
| Guest reading the menu | An idle connection / time between queries |

> **Remember:** throughput comes from a **few busy connections**, not from many idle ones.

## 2. Why connections are expensive

PostgreSQL uses a **process per connection** (see [PostgreSQL architecture](/lessons/postgres-architecture)). Each new connection means:

- Forking a **backend process**, authenticating (TLS, password hashing) and loading catalog caches: often milliseconds of work.
- **Memory** per process: a few MB at rest, plus `work_mem` for every sort or hash while a query runs.
- With hundreds of **active** processes, they fight for CPU cores, locks and shared memory, and throughput **drops**.

`max_connections` (default **100**, change needs a restart) caps them. "Just raise it to 5,000" is the wrong fix: memory use and contention grow with it, and you still can't run 5,000 queries at once on 16 cores.

> **Remember:** a database with 16 cores can only *execute* about 16 things at once. Extra connections just queue inside the server instead of in your pool.

## 3. Client-side pools in Node.js

`node-postgres` (`pg`) gives each process a **pool**: a set of open connections that requests borrow and return.

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

For a single query, `pool.query` borrows a connection, runs the query and returns it:

```js
const { rows } = await pool.query(
  'SELECT id, name, price FROM products WHERE id = $1', [productId]);
```

A **transaction** must run every statement on **the same connection**, so check one out with `pool.connect()` and **always release it**:

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

⚠️ Two classic bugs:

- Running `BEGIN` / `COMMIT` through `pool.query`: each call can land on a **different** connection, so there's no real transaction.
- Not calling `release()` on an error path: a **connection leak**. After `max` leaks, every request waits and then times out.

### Do the math across instances

Each process has its own pool. **20 pods × `max: 10` = 200 connections**, already double the default `max_connections`. Add a deploy where old and new pods overlap and it's 400.

## 4. PgBouncer: a pooler in front of PostgreSQL

**PgBouncer** is a lightweight proxy. Thousands of clients connect to it cheaply; it maps them onto a small number of real server connections.

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

The **pool mode** decides when a server connection goes back to the pool:

| Mode | Server connection returned… | Reuse | Safe for |
|---|---|---|---|
| **session** (default) | When the client disconnects | Low | Everything |
| **transaction** | At the end of each transaction | High | Most web apps (with care) |
| **statement** | After every statement | Highest | Autocommit only; multi-statement transactions are rejected |

### What breaks in transaction mode

Your next transaction may run on a **different** server connection, so anything that lives in the **session** is unreliable:

- `SET search_path ...` or `SET statement_timeout ...` at session level (use `SET LOCAL` inside the transaction instead).
- **Session-level advisory locks** (`pg_advisory_lock`); use `pg_advisory_xact_lock`.
- `LISTEN` / `NOTIFY` listeners (use a direct connection for listeners).
- Temporary tables and `WITH HOLD` cursors that outlive a transaction.
- **Prepared statements:** SQL-level `PREPARE` doesn't work. Protocol-level named prepared statements historically broke too; newer PgBouncer versions (1.21+) can track them when `max_prepared_statements` is set. Check your version and config before relying on it.

> **Remember:** transaction pooling gives the best reuse, as long as you keep **no state in the session**.

### Serverless and connection storms

On AWS Lambda or Vercel, each concurrent instance is a separate process with its own pool. A traffic spike to 1,000 concurrent invocations can open **thousands of connections in seconds**, a **connection storm**, and the database hits `too many clients already`.

Fixes: create the pool **outside** the handler so warm invocations reuse it, keep `max` tiny (1–2), and connect through a pooler: PgBouncer, **RDS Proxy**, or your provider's built-in pooler.

## 5. How big should a pool be?

Smaller than you think. Past the point where CPU cores and disks are busy, extra connections only add contention.

A common **starting point** (from the HikariCP project, for the total connections hitting the database):

```text
connections ≈ (CPU cores × 2) + effective spindles
```

For an 8-core server on SSD, that's roughly 17–20 **active** connections. Treat it as a starting point for load testing, not a law: workloads that wait on I/O or network can use more. Then divide by your app instances: 20 total across 4 pods behind PgBouncer is a sensible start.

## 6. Application-level performance

Pooling fixes connection overhead. Most real slowness is in **what the app asks for**.

### The N+1 query problem

```js
// Sequelize: 1 query for orders + 1 query PER order = N+1
const orders = await Order.findAll({ where: { status: 'paid' }, limit: 50 });
for (const order of orders) {
  order.customer = await order.getCustomer();   // 50 extra round trips
}
```

At 1 ms per round trip that's 51 ms of pure latency, and it grows with page size. Fix it with **one query** (`include: Customer` in Sequelize produces a JOIN), or in plain SQL:

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

### Keyset pagination instead of OFFSET

`OFFSET 100000` doesn't jump: PostgreSQL reads and throws away 100,000 rows. Real results from a 300,000-row `orders` table with an index on `(created_at DESC, id DESC)`:

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

Same 20 rows, about **40× faster** and **300× fewer pages**, and the gap keeps growing with page depth. The **row comparison** `(created_at, id) < (...)` uses the index directly, and `id` breaks ties between equal timestamps. Trade-off: no "jump to page 500". See [EXPLAIN](/lessons/postgres-explain) for reading these plans.

### Batch your writes

Inserting 1,000 order items one statement at a time costs 1,000 round trips and 1,000 commits.

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

For bulk loads (millions of rows) use **`COPY`**, the fastest path into PostgreSQL (from Node via the `pg-copy-streams` package). Wrapping many small writes in one transaction also helps, because each commit waits for a WAL flush.

### Parameterized queries

```js
// ❌ SQL injection: email = "x' OR '1'='1"
pool.query(`SELECT * FROM users WHERE email = '${email}'`);

// ✅ Value sent separately from the SQL text
pool.query('SELECT * FROM users WHERE email = $1', [email]);
```

Parameters are never parsed as SQL, so they're the defence against **SQL injection**. They can only replace **values**, not table or column names; allowlist those. Passing a `name` in the query config (`{ name: 'get-user', text, values }`) makes `pg` create a **named prepared statement** per connection, skipping re-parsing.

> **Remember:** most "slow database" incidents are N+1 queries, deep `OFFSET`, row-by-row writes or a missing index, not PostgreSQL itself.

## 7. Config knobs worth knowing

| Setting | Default | Sane starting point | Why |
|---|---|---|---|
| `shared_buffers` | 128 MB | ~25% of RAM | PostgreSQL's own page cache; the OS cache holds more |
| `work_mem` | 4 MB | 16–64 MB, carefully | Memory **per sort/hash node**, per query, per connection |
| `effective_cache_size` | 4 GB | ~50–75% of RAM | Planner **hint** only, allocates nothing |
| `maintenance_work_mem` | 64 MB | 512 MB – 1 GB+ | VACUUM, `CREATE INDEX` |
| `random_page_cost` | 4 | ~1.1 on SSD | Tells the planner random reads aren't much slower |

⚠️ **`work_mem` multiplies.** One query can have several sorts and hashes (hashes may use `work_mem × hash_mem_multiplier`, default 2), parallel workers each get their own, and every connection can do it at once: 200 connections × 3 nodes × 64 MB ≈ **38 GB**. Raise it per query or per role (`SET LOCAL work_mem = '256MB'`) for heavy reports instead of globally.

Also set **`idle_in_transaction_session_timeout`** (e.g. 60 s): a connection stuck "idle in transaction" holds locks and blocks VACUUM (see [MVCC and VACUUM](/lessons/postgres-mvcc-and-vacuum)).

## 8. Diagnosing in production

**`pg_stat_statements`** aggregates every query shape: calls, total and mean time. It needs `shared_preload_libraries = 'pg_stat_statements'` (restart) and `CREATE EXTENSION pg_stat_statements;`.

```sql
-- Where is the database spending its time?
SELECT calls, round(total_exec_time) AS total_ms,
       round(mean_exec_time::numeric, 2) AS mean_ms, rows,
       left(query, 60) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

Sort by **total** time first: a 2 ms query called 5 million times matters more than a 3 s query run twice a day. An N+1 shows up as a cheap query with a gigantic `calls` count.

**`pg_stat_activity`** shows every connection right now:

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

Lots of `idle` = pools too big; lots of `idle in transaction` = leaked clients or slow app code inside transactions; lots of `active` with `wait_event_type = 'Lock'` = contention (see [Locking](/lessons/postgres-locking)).

## 9. Don't confuse these

| | Client pool (`pg.Pool`) | PgBouncer | Raising `max_connections` |
|---|---|---|---|
| Lives in | Each app process | Separate proxy | PostgreSQL |
| Shares connections across instances | ❌ | ✅ | — |
| Saves connection setup | ✅ | ✅ | ❌ |
| Limits server processes | Per process only | ✅ globally | ❌ adds more |
| Gotchas | Leaks, multiplication | Session state in transaction mode | Memory, contention |

Compare with MongoDB, where drivers pool connections internally and the server uses threads, not processes ([MongoDB performance](/lessons/mongodb-performance)). The habit is the same: one pool per process, sized deliberately.

## 10. Production checklist

| Area | Check |
|---|---|
| Pools | One `pg.Pool` per process; every `connect()` has `release()` in `finally` |
| Totals | instances × `max` stays well below `max_connections` |
| Pooler | PgBouncer / RDS Proxy for many instances or serverless; transaction mode, no session state |
| Timeouts | `connectionTimeoutMillis`, `statement_timeout`, `idle_in_transaction_session_timeout` |
| Queries | No N+1; JOIN or `= ANY($1)`; only needed columns |
| Pagination | Keyset for feeds and APIs |
| Writes | Multi-row INSERT / `unnest` / `COPY`; batched in transactions |
| Security | Parameters only, never string-concatenated SQL |
| Config | `shared_buffers` ~25% RAM, careful `work_mem`, SSD `random_page_cost` |
| Observability | `pg_stat_statements` reviewed; alerts on connections and long transactions |

## 11. Trade-offs: when not to bother

- **A single small app** with one process and `max: 10` doesn't need PgBouncer. Add it when instance count or serverless makes connections multiply.
- **Session pooling** is safer if your app relies on `LISTEN`, session advisory locks or session `SET`, at the cost of far less reuse.
- **OFFSET is fine** for small admin tables where users need page numbers.
- **Don't tune config before queries.** A missing index or an N+1 dwarfs any `postgresql.conf` change.

> **Remember:** pool connections, then fix query patterns, then tune config, in that order, and measure each step.
