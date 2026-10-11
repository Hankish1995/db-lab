---
slug: postgres-locking
title: 'Locking in PostgreSQL: row locks, table locks and the migration that took the site down'
module: Transactions
order: 90
summary: The four row-level lock modes, NOWAIT and SKIP LOCKED job queues, the table lock modes that matter in practice, how a harmless ALTER TABLE causes an outage, safe migration patterns, deadlocks, advisory locks and how to see who is blocking whom.
level: advanced
tags: [postgresql, locking, row-locks, skip-locked, migrations, deadlocks, advisory-locks, lock-timeout]
recap: >-
  MVCC lets reads and writes coexist, but writers to the same row and schema changes still need locks. Row locks
  come in four strengths; a plain UPDATE takes FOR NO KEY UPDATE so foreign key checks can still proceed, and SKIP
  LOCKED turns a table into a job queue. Table locks are mostly invisible until a DDL statement needs ACCESS EXCLUSIVE
  and queues behind a long query, blocking everyone behind it, so run migrations with lock_timeout, retries and
  online patterns like CREATE INDEX CONCURRENTLY and NOT VALID constraints. Find blockers with pg_blocking_pids.
---

## 1. The story

A hotel stays open during renovation.

- Each **room key** lets one guest change one room. Two guests can't redecorate the same room at once, but different rooms are fine. Those are **row locks**.
- Some work needs the **whole floor**: re-tiling the corridor. A sign goes up: "floor closed". That's a **table lock**.
- At the lift there's **one queue**. If the tiling crew is waiting for a slow guest to leave, every guest who arrives *after* the crew waits behind the crew, even though they only want to walk through. That's the **lock queue**, and it's how a 2-millisecond `ALTER TABLE` takes down a website.
- The manager's whiteboard "only one night audit at a time" isn't about any room at all. That's an **advisory lock**.

| Hotel | PostgreSQL |
|---|---|
| Room key | **Row-level lock** (`FOR UPDATE` and friends) |
| "Floor closed" sign | **Table-level lock** (e.g. `ACCESS EXCLUSIVE`) |
| One queue at the lift | **Lock wait queue** per table |
| Whiteboard rule | **Advisory lock** |
| Two guests each holding the key the other needs | **Deadlock** |

Basics such as pessimistic vs optimistic locking are in [Concurrency and locking](/lessons/concurrency-and-locking). Here we go deeper into PostgreSQL itself.

## 2. Why locks still exist with MVCC

[MVCC](/lessons/postgres-mvcc-and-vacuum) solves **read vs write**: readers see a snapshot and never wait. Locks are still needed for:

- **Write vs write on the same row**: two checkouts decrementing the same stock.
- **Schema vs everything**: you can't drop a column while a query is reading it.
- **App-level mutual exclusion**: "only one invoice job at a time".

## 3. Row-level locks: four strengths

| Lock | Taken by | Blocks |
|---|---|---|
| **`FOR UPDATE`** | `SELECT ... FOR UPDATE`, `DELETE`, an `UPDATE` that changes a key column | Every other row lock |
| **`FOR NO KEY UPDATE`** | A plain `UPDATE` that doesn't change key columns, `SELECT ... FOR NO KEY UPDATE` | All except `FOR KEY SHARE` |
| **`FOR SHARE`** | `SELECT ... FOR SHARE` | `FOR NO KEY UPDATE`, `FOR UPDATE` |
| **`FOR KEY SHARE`** | Foreign key checks on the parent row, `SELECT ... FOR KEY SHARE` | Only `FOR UPDATE` |

"Key column" here, as the docs define it today, means a column with a **unique index usable by a foreign key** (so not partial or expression indexes), and the value must **actually change**.

### Why this matters: foreign keys

When you insert an order for customer 5, PostgreSQL checks the customer exists and takes **`FOR KEY SHARE`** on that customer row so it can't be deleted mid-insert. Verified in a scratch database, with session A holding a lock on customer 5 and session B inserting an order for that customer:

| Session A (uncommitted) | Lock A holds | B's `INSERT INTO orders` |
|---|---|---|
| `UPDATE customers SET country = 'IN' WHERE id = 5` | `FOR NO KEY UPDATE` | ✅ instant |
| `UPDATE customers SET email = email WHERE id = 5` | `FOR NO KEY UPDATE` (value unchanged) | ✅ instant |
| `UPDATE customers SET email = 'new5@shop.test' WHERE id = 5` | `FOR UPDATE` (`email` has a unique index) | ⏳ waited ~2 s |
| `SELECT ... WHERE id = 5 FOR UPDATE` | `FOR UPDATE` | ⏳ waited ~2 s |
| `DELETE FROM customers WHERE id = 5` | `FOR UPDATE` | ⏳ waited ~2 s |

Two lessons: use `FOR NO KEY UPDATE` instead of `FOR UPDATE` when you lock a parent row only to modify non-key columns; and changing a uniquely-indexed column (like an email) blocks inserts of child rows even if the foreign key points at `id`.

Row locks are stored **in the tuple itself** (in `xmax`), not in shared memory, so locking a million rows doesn't exhaust anything. A waiting session shows up in `pg_locks` as waiting on the other **transaction ID**, which is why deadlock messages say "waits for ShareLock on transaction 1999".

> **Remember:** a plain UPDATE takes `FOR NO KEY UPDATE`, so it doesn't block foreign key checks. `FOR UPDATE` does. Lock only as strongly as you need.

## 4. NOWAIT and SKIP LOCKED: build a job queue

By default, a row lock request **waits**. Two modifiers change that:

- **`NOWAIT`**: fail immediately: `ERROR: could not obtain lock on row in relation "jobs"`.
- **`SKIP LOCKED`**: silently skip rows someone else has locked.

`SKIP LOCKED` makes a plain table a safe, concurrent **job queue** (sending invoices, resizing product images):

```sql
CREATE TABLE jobs (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind     text NOT NULL,
  payload  jsonb NOT NULL,
  status   text NOT NULL DEFAULT 'queued',
  run_at   timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0
);
CREATE INDEX jobs_queued_idx ON jobs (run_at) WHERE status = 'queued';

-- Each worker claims one job atomically
UPDATE jobs
SET status = 'running', attempts = attempts + 1
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'queued' AND run_at <= now()
  ORDER BY run_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, kind, payload;
```

Verified with two workers: worker 1 locked job 1 and held it; worker 2's identical query returned **job 2 instantly** instead of waiting.

```text
 Worker 1                      Worker 2
 ───────────────────────────   ───────────────────────────
 lock job 1 ✓
                               job 1 locked → skip
                               lock job 2 ✓
 process, mark done            process, mark done
```

Design choice: either **hold the lock while processing** (`SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction that also marks it done; a crash releases the lock automatically, but the transaction stays open during processing), or **claim and commit** as above, then process and mark done in a second transaction (short transactions, but you need a timeout to re-queue jobs from crashed workers).

> **Remember:** `FOR UPDATE SKIP LOCKED LIMIT 1` = "give me any job nobody else is working on". It's the standard PostgreSQL job-queue pattern.

## 5. Table-level locks: the ones that matter

Every statement takes a table lock, mostly harmless ones. Verified in `pg_locks`:

| Mode | Taken by | Conflicts with (practically) |
|---|---|---|
| **`ACCESS SHARE`** | `SELECT` | Only `ACCESS EXCLUSIVE` |
| `ROW SHARE` | `SELECT ... FOR UPDATE/SHARE` | `EXCLUSIVE`, `ACCESS EXCLUSIVE` |
| **`ROW EXCLUSIVE`** | `INSERT`, `UPDATE`, `DELETE`, `MERGE` | `SHARE` and stronger |
| `SHARE UPDATE EXCLUSIVE` | `VACUUM`, `ANALYZE`, `CREATE INDEX CONCURRENTLY`, `VALIDATE CONSTRAINT` | Itself and stronger (not reads or writes) |
| **`SHARE`** | `CREATE INDEX` (non-concurrent) | Writes (`ROW EXCLUSIVE`); reads continue |
| **`ACCESS EXCLUSIVE`** | Most `ALTER TABLE`, `DROP`, `TRUNCATE`, `VACUUM FULL`, `CLUSTER`, `REFRESH MATERIALIZED VIEW` (non-concurrent) | **Everything**, including plain `SELECT` |

```text
          SELECT   UPDATE   CREATE INDEX   ALTER TABLE
 SELECT     ✓        ✓          ✓              ✗
 UPDATE     ✓        ✓*         ✗              ✗
 CREATE IDX ✓        ✗          ✓              ✗
 ALTER      ✗        ✗          ✗              ✗
 (* table level is fine; same ROW still waits)
```

## 6. The outage pattern: ALTER TABLE in the lock queue

A developer runs a migration that should take milliseconds: `ALTER TABLE products ADD COLUMN badge text`. Meanwhile a reporting query has been reading `products` for minutes.

Reproduced in a scratch database: a "report" transaction holds `ACCESS SHARE` on `products`, a "migration" runs `ALTER TABLE`, and then a "checkout" runs a trivial `SELECT`. A fourth session looked at the locks:

```sql
SELECT a.pid, a.application_name AS app, l.mode, l.granted,
       pg_blocking_pids(a.pid) AS blocked_by
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = 'products'::regclass;
```

```text
  pid  |    app    |        mode         | granted | blocked_by
-------+-----------+---------------------+---------+------------
 22804 | report    | AccessShareLock     | t       | {}
 21052 | checkout  | AccessShareLock     | f       | {22884}
 22884 | migration | AccessExclusiveLock | f       | {22804}
```

The checkout `SELECT` doesn't conflict with the report at all. It's blocked **by the waiting migration**: a new lock request queues behind an already-waiting conflicting request. Every checkout request now piles up, connections run out, the site is down, and the ALTER itself hasn't even started.

```text
 report (ACCESS SHARE, granted, running for minutes)
   ▲
   └── migration waits (ACCESS EXCLUSIVE)
          ▲
          ├── checkout SELECT waits
          ├── checkout SELECT waits
          └── ... every query on products waits
```

**The fix: never let DDL wait for long.**

```sql
SET lock_timeout = '2s';
ALTER TABLE products ADD COLUMN badge text;
-- ERROR:  canceling statement due to lock timeout   (verified)
```

If the lock can't be acquired within 2 seconds, the migration gives up, the queue drains, and your migration tool **retries** a little later. Also check `pg_stat_activity` for long transactions before deploying.

> **Remember:** any statement waiting for `ACCESS EXCLUSIVE` blocks every later query on that table. Always run migrations with `lock_timeout` and a retry.

## 7. Safe migration patterns

| Change | Dangerous way | Safe way |
|---|---|---|
| Add an index | `CREATE INDEX` (blocks writes for the whole build) | `CREATE INDEX CONCURRENTLY` (can't run inside a transaction; slower; if it fails it leaves an `INVALID` index to drop and retry) |
| Add a column with a default | Volatile default like `gen_random_uuid()` rewrites the table | A **constant** default is a metadata-only change since PostgreSQL 11 |
| Add `NOT NULL` | `SET NOT NULL` scans the table under `ACCESS EXCLUSIVE` | `ADD CONSTRAINT ... CHECK (col IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT`, then `SET NOT NULL` (skips the scan) |
| Add a foreign key / check | `ADD CONSTRAINT` validates every row under a strong lock | Add it `NOT VALID` (new rows checked immediately), then `VALIDATE CONSTRAINT` separately |
| Change a column type | `ALTER COLUMN TYPE` often rewrites the table | Add a new column, backfill in batches, switch reads, drop the old one |

Real timings on a 500,000-row `orders` table:

```text
ADD COLUMN channel text NOT NULL DEFAULT 'web'      5 ms
ADD COLUMN ref uuid DEFAULT gen_random_uuid()    2973 ms (rewrite)
SET NOT NULL after a validated CHECK constraint     3 ms
```

```sql
ALTER TABLE orders ADD CONSTRAINT orders_coupon_nn
  CHECK (coupon_code IS NOT NULL) NOT VALID;           -- instant, brief lock
ALTER TABLE orders VALIDATE CONSTRAINT orders_coupon_nn; -- scans, but only
                                                         -- SHARE UPDATE EXCLUSIVE
ALTER TABLE orders ALTER COLUMN coupon_code SET NOT NULL; -- uses the check, no scan
ALTER TABLE orders DROP CONSTRAINT orders_coupon_nn;
```

`VALIDATE CONSTRAINT` took only `ShareUpdateExclusiveLock` on the table in `pg_locks`, so reads and writes kept flowing while it scanned.

## 8. Deadlocks

Asha's cart locks product 10 then 20; Ravi's locks 20 then 10. Real error from a scratch database:

```text
ERROR:  deadlock detected
DETAIL:  Process 6404 waits for ShareLock on transaction 1999;
         blocked by process 22316.
         Process 22316 waits for ShareLock on transaction 1998;
         blocked by process 6404.
HINT:  See server log for query details.
CONTEXT:  while updating tuple (0,20) in relation "products"
```

- A session that has waited **`deadlock_timeout`** (default 1 s) runs the deadlock check. If it finds a cycle, one transaction is aborted with SQLSTATE `40P01`; the other continues.
- Prevention: **lock in a consistent order**. For a cart, lock all products in one statement sorted by id:

```sql
SELECT id FROM products
WHERE id = ANY($1)
ORDER BY id
FOR UPDATE;
```

- Keep transactions short and **retry** `40P01` like a serialization failure.

## 9. Advisory locks: mutual exclusion for your app

Sometimes you need a lock on an **idea**, not a row: "only one instance of the nightly invoice job", "only one process rebuilds the search index". With three Node.js replicas running the same cron, an **advisory lock** picks one winner.

```sql
BEGIN;
SELECT pg_try_advisory_xact_lock(hashtext('nightly-invoice-job')) AS got_it;
-- got_it = false → another instance is running, just COMMIT and exit
-- got_it = true  → do the work
COMMIT;  -- xact-level lock released automatically
```

Verified with two sessions: the first got `true`, the second got `false` while the first was still open.

| Function | Scope | Waits? |
|---|---|---|
| `pg_advisory_xact_lock(key)` | Until transaction end | Yes |
| `pg_try_advisory_xact_lock(key)` | Until transaction end | No, returns boolean |
| `pg_advisory_lock(key)` / `pg_advisory_unlock(key)` | Until unlocked or session ends | Yes |

Prefer the **transaction-level** versions: they can't leak. Session-level locks are dangerous behind a transaction-mode pooler such as PgBouncer, because your next query may run on a different server connection; see [Connection pooling](/lessons/postgres-connection-pooling). The key is a `bigint` (or two `int`s); `hashtext()` is a convenient way to derive one from a name, with a tiny risk of collisions.

> **Remember:** advisory locks are named mutexes inside PostgreSQL. Use `pg_try_advisory_xact_lock` so a crashed worker can never leave the lock behind.

## 10. Who is blocking whom?

```sql
SELECT a.pid,
       a.application_name,
       a.state,
       now() - a.xact_start      AS xact_age,
       pg_blocking_pids(a.pid)   AS blocked_by,
       left(a.query, 60)         AS query
FROM pg_stat_activity a
WHERE cardinality(pg_blocking_pids(a.pid)) > 0
   OR a.pid IN (SELECT unnest(pg_blocking_pids(pid)) FROM pg_stat_activity);
```

Then decide: `SELECT pg_cancel_backend(pid)` cancels the current query; `SELECT pg_terminate_backend(pid)` kills the whole session (needed for `idle in transaction`).

### Timeouts that prevent lock pile-ups

| Setting | What it stops | Typical value |
|---|---|---|
| `lock_timeout` | Waiting too long for any lock | `2s`–`5s` for migrations |
| `statement_timeout` | Any statement running too long | `5s`–`30s` for the web app role |
| `idle_in_transaction_session_timeout` | Sessions that `BEGIN` and then do nothing, holding locks | `30s`–`60s` |
| `transaction_timeout` (PostgreSQL 17+) | Whole transactions running too long | Use carefully |

```sql
ALTER ROLE shop_web SET statement_timeout = '10s';
ALTER ROLE shop_web SET idle_in_transaction_session_timeout = '30s';
```

## 11. Gotchas

- **Running DDL without `lock_timeout`.** The classic self-inflicted outage.
- **`CREATE INDEX CONCURRENTLY` inside a migration transaction.** It errors (`cannot run inside a transaction block`). Many migration tools wrap every file in a transaction; disable that for this file.
- **Ignoring an `INVALID` index** after a failed concurrent build. It slows writes and isn't used for reads. Drop and retry.
- **`FOR UPDATE` where `FOR NO KEY UPDATE` would do**, causing foreign-key inserts on child tables to wait.
- **Holding row locks during HTTP calls.** Every other buyer of that product waits for the payment gateway.
- **Session advisory locks with PgBouncer** in transaction mode.
- **Unindexed foreign keys.** Deleting a customer must find child orders; without an index on `orders.customer_id` that check scans the whole table while holding locks.

## 12. Don't confuse: three kinds of locks

| | Row locks | Table locks | Advisory locks |
|---|---|---|---|
| Protects | Individual rows | Table structure / whole-table operations | Whatever your app decides |
| Taken | Automatically by writes, or `FOR UPDATE` etc. | Automatically by every statement | Only when you call the functions |
| Stored | In the tuple (`xmax`) | Shared memory lock table | Shared memory lock table |
| Typical pain | Hot-row contention, deadlocks | DDL queues blocking everything | Leaked session locks |
| Seen in | `pg_locks` as transaction waits | `pg_locks` (`relation`) | `pg_locks` (`locktype = 'advisory'`) |

## 13. Trade-offs

- **Pessimistic row locks** are simple and correct, but every waiter adds latency; on very hot rows a single atomic `UPDATE ... WHERE stock >= n` holds the lock for microseconds instead of milliseconds.
- **SKIP LOCKED queues** are great up to thousands of jobs per second. Beyond that, or when you need fan-out and replay, a dedicated broker (SQS, RabbitMQ, Kafka) fits better.
- **Online migrations** (concurrent indexes, NOT VALID + VALIDATE, batched backfills) take more steps and more time, but your users never notice. That's the trade worth making.

> **Remember:** most PostgreSQL locking incidents aren't about rows. They're a DDL statement waiting in a queue, or a transaction left open. Timeouts fix both.
