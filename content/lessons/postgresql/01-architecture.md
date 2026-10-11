---
slug: postgres-architecture
title: 'PostgreSQL architecture: what happens when your query arrives'
module: Basics
order: 10
summary: 'How PostgreSQL turns a SQL string into rows: the process-per-connection model, the parse-rewrite-plan-execute pipeline, shared buffers, 8 KB heap pages, TOAST, and how the write-ahead log makes commits durable without writing table pages immediately.'
level: intermediate
tags: [postgresql, architecture, processes, shared-buffers, wal, checkpoints, toast, heap]
recap: >-
  The postmaster accepts each connection and starts a dedicated backend process for it, which is why connections are
  expensive and apps need pooling. Each query is parsed, rewritten, planned and executed. Data lives in 8 KB heap pages,
  cached in shared buffers on top of the OS page cache, and large values are moved to TOAST. A commit only has to flush
  the write-ahead log; dirty table pages are written later by the background writer and checkpointer, and after a crash
  PostgreSQL replays the WAL from the last checkpoint.
---

## 1. The story

Picture a busy restaurant.

- A **doorman** greets every party and assigns them **their own waiter**. That waiter serves only that table for the whole evening.
- The waiter writes the order down, checks it against house rules ("the *combo* means burger + fries + drink"), and hands it to the **head chef**, who decides the fastest way to cook it.
- Cooks grab ingredients from a **counter next to the stove**. Only when something isn't on the counter do they walk to the **warehouse** out back.
- Before any dish leaves the kitchen, the cashier writes it in a **ledger**. If the power goes out, the ledger tells you exactly what was sold.
- Every few minutes, a manager walks through and **reconciles** the counter with the warehouse inventory.

| Restaurant | PostgreSQL |
|---|---|
| Doorman | **postmaster**: the main server process |
| Your own waiter | A **backend process**, one per connection |
| Reading the order, applying house rules | **Parser** and **rewriter** |
| Head chef choosing how to cook | **Planner / optimizer** |
| Cooks | **Executor** |
| Counter next to the stove | **Shared buffers** (RAM cache of pages) |
| Warehouse | Data files on disk |
| The ledger | **Write-ahead log (WAL)** |
| Periodic reconciliation | **Checkpoint** |

> **Remember:** one connection = one dedicated server process. Changes go to a log first and to the table files later.

## 2. Why it's built this way

PostgreSQL has to deliver three things at once:

1. **Durability:** once `COMMIT` returns, the data survives a crash or power loss.
2. **Speed:** most reads should come from memory, not disk.
3. **Concurrency:** hundreds of clients reading and writing at the same time.

The naive approach, "on every commit, write the changed table pages to disk", is slow. A single order might touch pages in `orders`, `order_items`, `products` and five indexes, scattered across the disk. Random writes on every commit would kill throughput.

PostgreSQL's answer: **append a compact description of the change to one sequential log, flush only that, and write the real pages lazily in the background.**

## 3. The big picture

```text
  Node.js app (pg pool)
          │ TCP :5432
          ▼
 ┌──────────────────────────────────────────────────────────┐
 │ postmaster: listens, starts one backend per connection   │
 └───────────────────────────┬──────────────────────────────┘
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
 ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
 │ backend conn 1 │  │ backend conn 2 │  │ backend conn 3 │
 │ parse→rewrite  │  │ private memory │  │ private memory │
 │ →plan→execute  │  │ (work_mem)     │  │ (work_mem)     │
 └───────┬────────┘  └───────┬────────┘  └───────┬────────┘
         └───────────────────┼───────────────────┘
                             ▼
 ┌──────────────────────────────────────────────────────────┐
 │ SHARED MEMORY                                            │
 │ ┌─────────────────────────────┐ ┌──────────────────────┐ │
 │ │ shared_buffers (8 KB pages) │ │ WAL buffers          │ │
 │ └──────────────┬──────────────┘ └──────────┬───────────┘ │
 └────────────────┼───────────────────────────┼─────────────┘
   bgwriter,      │                           │ walwriter,
   checkpointer   ▼                           ▼ COMMIT flush
 ┌─────────────────────────────┐ ┌──────────────────────────┐
 │ data files: tables, indexes │ │ WAL segments in pg_wal/  │
 │ base/<db oid>/<file>        │ │ 16 MB files, append-only │
 └─────────────────────────────┘ └──────────────────────────┘
          (both go through the OS page cache)
```

## 4. The journey of one query

Your "My orders" page runs:

```sql
SELECT id, status, total
FROM orders
WHERE user_id = 42
ORDER BY created_at DESC;
```

1. **Connection.** The **postmaster** accepts the TCP connection and starts a new **backend process** for it. That backend authenticates the client (using `pg_hba.conf` rules and the password or certificate) and from now on, this client talks only to that process.
2. **Parser.** Checks the syntax and turns the text into a **parse tree**. Then it resolves names: does `orders` exist, what type is `user_id`? A typo like `SELCT` or an unknown column fails here.
3. **Rewriter.** Applies **rules**. The important one: **views** are implemented as rewrite rules, so `SELECT * FROM active_orders` is replaced by the view's underlying query. Row-level security policies are also added at this stage.
4. **Planner / optimizer.** Generates candidate plans (seq scan or index scan? hash join or nested loop?) and estimates the **cost** of each using table statistics. It picks the cheapest. This is what `EXPLAIN` shows you (see [Reading EXPLAIN](/lessons/postgres-explain)).
5. **Executor.** Runs the plan as a tree of nodes. Each node pulls rows from its children, page by page, through shared buffers, and streams results back to the client.

Prove that each connection is its own process:

```sql
SELECT pg_backend_pid();   -- e.g. 22836, a real OS process id
```

Open a second `psql` and you'll get a different PID. With enough privileges, `SELECT pid, backend_type FROM pg_stat_activity;` lists every process, including the background ones in section 8.

> **Remember:** parse (is it valid?) → rewrite (expand views) → plan (cheapest way?) → execute (do it). Planning is where indexes are chosen or ignored.

## 5. Process per connection, and why connections are expensive

Most databases use **threads** per connection. PostgreSQL uses a full **OS process** per connection. That has real consequences:

- **Starting a connection is slow.** A new process, authentication, often a TLS handshake, then loading catalog caches. Milliseconds, not microseconds.
- **Each connection costs memory.** Every backend has its own caches and per-operation memory. A single query can use `work_mem` (default 4 MB) **per sort or hash node**, so a complex query can use several multiples of it.
- **Too many active processes thrash.** 500 backends on 16 CPU cores spend time context-switching and contending for locks.
- **`max_connections` is capped** (default 100) for these reasons.

The MERN trap: each Node.js instance creates a pool, `new Pool({ max: 20 })`. Run 10 pods behind a load balancer, plus serverless functions, and you are asking for 200+ connections from a server configured for 100.

```text
 10 pods × pool max 20 = 200 connections  ──►  max_connections = 100
                                               FATAL: sorry, too many
                                               clients already
```

The fix is **connection pooling**: a small number of real database connections shared by many clients, usually with PgBouncer in front. That's its own lesson: [Connection pooling](/lessons/postgres-connection-pooling).

The upside of processes: **isolation**. A bug in one backend can't scribble over another backend's private memory. (If a backend crashes hard, the postmaster still resets all backends and runs crash recovery, because shared memory might be damaged.)

> **Remember:** a PostgreSQL connection is a whole OS process. Keep connections few and reuse them through a pool.

## 6. Memory: shared buffers and the OS page cache

Table and index data is read in **pages** of 8 KB. Before a backend reads a page, it checks **shared buffers**, a cache in shared memory used by all backends.

- **Hit:** the page is already there. No I/O.
- **Miss (read):** PostgreSQL asks the operating system for the page. The OS may still serve it from **its own page cache** in RAM, so not every "read" touches the disk.

PostgreSQL deliberately relies on **both caches** (often called **double buffering**). That's why `shared_buffers` is typically set to around 25% of RAM rather than 80%: the OS cache uses much of the rest. `effective_cache_size` doesn't allocate anything; it just tells the planner how much caching to expect.

You can see hits and reads with `EXPLAIN (ANALYZE, BUFFERS)`. Example output from a 500,000-row `orders` table, running the same lookup twice:

```text
-- first run: some pages had to come from the OS
Index Scan using orders_pkey on orders (actual time=0.510..0.511 rows=1 loops=1)
  Index Cond: (id = 300001)
  Buffers: shared hit=1 read=3

-- second run: everything from shared buffers
Index Scan using orders_pkey on orders (actual time=0.007..0.008 rows=1 loops=1)
  Index Cond: (id = 300001)
  Buffers: shared hit=4
```

Four pages: the B-tree pages from root to leaf, plus one heap page. The second run was about 60 times faster.

## 7. Storage: heap files, pages, tuples and TOAST

Each table is a **heap**: a file of 8 KB pages with rows in no particular order. Each index is a separate file. Files live under the data directory, split into 1 GB segments:

```sql
SELECT pg_relation_filepath('orders');   -- base/24583/24722
```

Inside a page, a row is called a **tuple**. The page header is followed by an array of small **line pointers**; tuples are packed from the end of the page backwards.

```text
 ┌───────────────────── 8 KB page ─────────────────────┐
 │ header │ lp1 │ lp2 │ lp3 │ ──► grows forward        │
 ├─────────────────────────────────────────────────────┤
 │                    free space                       │
 ├─────────────────────────────────────────────────────┤
 │ grows backward ◄── │ tuple 3 │ tuple 2 │ tuple 1    │
 └─────────────────────────────────────────────────────┘
   lp = line pointer. ctid (0,2) = page 0, pointer 2
```

Every tuple has a physical address, the **ctid** `(page, item)`. Indexes point to ctids:

```sql
SELECT ctid, id, email FROM users ORDER BY id LIMIT 2;
--  ctid  | id |     email
-- (0,1)  |  1 | user1@shop.io
-- (0,2)  |  2 | user2@shop.io
```

Each tuple also carries hidden header fields (`xmin`, `xmax`) that record which transaction created and deleted it. An `UPDATE` doesn't overwrite a row in place; it writes a **new tuple version**. That's **MVCC**, covered in [MVCC and VACUUM](/lessons/postgres-mvcc-and-vacuum).

### TOAST: when a value doesn't fit

A tuple can't span pages. So what about a 50 KB product description or a big `jsonb` blob? **TOAST** (The Oversized-Attribute Storage Technique):

- When a row is larger than about **2 KB**, PostgreSQL first tries to **compress** large values.
- If it's still too big, it moves them **out of line** into the table's separate **TOAST table**, cut into chunks. The main tuple keeps a small pointer.
- A single field can hold up to 1 GB.

In my scratch database, giving 1,000 products a 9.6 KB description left the main heap at 952 kB and put 10 MB into the TOAST table. Consequences:

- ✅ Queries that don't select the big column stay fast: the heap pages stay dense.
- ⚠️ `SELECT *` on a table with big text or `jsonb` columns pays to fetch and decompress every TOASTed value. Select only the columns you need.

> **Remember:** tables are heaps of 8 KB pages. Rows have a physical address (ctid), and big values live out of line in TOAST.

## 8. The write-ahead log and checkpoints

The rule is in the name: **write the log ahead of the data.**

What happens when a checkout runs `UPDATE products SET stock = stock - 1 WHERE id = 7; COMMIT;`:

```text
 1. Load page of product 7 into shared buffers (if not there)
 2. Write the new tuple version in the buffer   → page is "dirty"
 3. Append a WAL record describing the change   → WAL buffers
 4. COMMIT: flush WAL up to the commit record   → fsync to disk
 5. Tell the client "COMMIT" ✅
    ... seconds or minutes later ...
 6. bgwriter / checkpointer write the dirty page to the data file
```

Only step 4 waits for the disk, and it's a **sequential append** to one file, which is cheap. The scattered page writes happen later, in the background, and many changes to the same page get combined into one write.

**What if the server crashes between 5 and 6?** The data file has the old page, but the WAL has the change. On restart, PostgreSQL runs **crash recovery**: it starts at the last checkpoint and **replays** the WAL, redoing every change. Nothing committed is lost.

A **checkpoint** is the moment PostgreSQL guarantees "every dirty page up to this point is on disk". After it, older WAL is no longer needed for crash recovery and can be recycled. Checkpoints happen every `checkpoint_timeout` (default 5 minutes) or when `max_wal_size` (default 1 GB) of WAL has accumulated, whichever comes first, and their writes are spread out over the interval to avoid I/O spikes.

| Checkpoints more often | Checkpoints less often |
|---|---|
| Faster crash recovery (less WAL to replay) | Slower crash recovery |
| More total I/O | Less I/O, more combining of writes |
| More **full-page images** in WAL | Smaller WAL volume |

That last row: after each checkpoint, the first change to a page writes the **whole page** into WAL (`full_page_writes`), so a page torn by a crash mid-write can still be restored.

The same WAL stream powers **replication** and **point-in-time recovery**: replicas just replay it (see [Replication](/lessons/postgres-replication)).

One knob to know: `synchronous_commit = off` lets `COMMIT` return before the WAL flush. A crash can lose the last fraction of a second of committed transactions, but **never corrupts** the database. Fine for page-view counters, not for payments.

> **Remember:** a commit is durable once its WAL is flushed. Table pages are written later. After a crash, PostgreSQL replays WAL from the last checkpoint.

## 9. The background processes

Besides one backend per client, a running server has helper processes:

| Process | One-line job |
|---|---|
| **checkpointer** | Performs checkpoints: writes all dirty pages and marks a safe recovery start point |
| **background writer** | Trickles dirty pages to disk early so backends rarely have to write pages themselves |
| **WAL writer** | Flushes WAL buffers to disk regularly, mainly for asynchronous commits |
| **autovacuum launcher** | Starts autovacuum workers that clean up dead row versions and refresh statistics |

You'll also see others depending on configuration: WAL senders (replication), the archiver (WAL archiving), the logical replication launcher.

## 10. Cluster → database → schema → table

```text
 Cluster (one server, one data directory, one port)
 ├── roles (users) ← shared by the whole cluster
 ├── database: shop
 │   ├── schema: public
 │   │   ├── table: users
 │   │   └── table: orders
 │   └── schema: analytics
 │       └── table: daily_revenue
 └── database: shop_test
```

- A **cluster** in PostgreSQL vocabulary is one running server instance, not a group of machines.
- A **connection is bound to one database.** You can't join `shop.orders` with `shop_test.orders` in one query (without extensions like `postgres_fdw`).
- **Schemas** are namespaces inside a database. Cross-schema queries are normal: `SELECT * FROM analytics.daily_revenue`.
- Unqualified names are resolved through `search_path` (default `"$user", public`).
- Since PostgreSQL 15, ordinary users can no longer create objects in the `public` schema by default.

## 11. Common mistakes and gotchas

- **Opening a connection per request.** Process startup on every HTTP request adds latency and can exhaust `max_connections`. Use a pool.
- **Setting `shared_buffers` to most of the RAM.** It starves the OS cache and per-backend memory. Start around 25%.
- **Thinking `COMMIT` writes the table.** It writes WAL. If someone asks "why is commit fast?", that's the answer.
- **Turning off `fsync` for speed.** Unlike `synchronous_commit = off`, this can **corrupt** the database on a crash. Never in production.
- **Ignoring checkpoint warnings.** "Checkpoints are occurring too frequently" in the logs means `max_wal_size` is too small for your write load.
- **`SELECT *` on wide tables.** It drags TOASTed columns along for no reason.

## 12. Don't confuse these

| | PostgreSQL | MongoDB (WiredTiger) |
|---|---|---|
| Per connection | An OS **process** | A **thread** (cheaper) |
| Main data cache | `shared_buffers` + OS page cache | WiredTiger cache + OS page cache |
| Durability log | **WAL**, flushed on commit | **Journal**, a write-ahead log |
| Checkpoints | Every 5 min or `max_wal_size` | About every 60 seconds |
| Old row versions | Stored in the table, cleaned by VACUUM | Kept by the storage engine, no VACUUM |

| Pair | Difference |
|---|---|
| WAL vs data files | WAL = sequential journal of changes; data files = the actual pages |
| Commit vs checkpoint | Commit flushes **WAL**; checkpoint flushes **dirty pages** |
| shared_buffers vs work_mem | Shared page cache for everyone vs private memory per sort/hash |

## 13. Trade-offs of this design

- **Process per connection:** robust and simple, but connections are expensive. Pooling is mandatory at scale.
- **Double buffering:** simple and portable, but the same page can sit in RAM twice.
- **WAL + lazy page writes:** fast, durable commits, at the cost of write amplification (WAL plus pages, plus full-page images) and recovery time after a crash.
- **New tuple version on every update:** readers never block writers, but dead tuples pile up and need VACUUM.

> **Remember:** when an interviewer asks "how does PostgreSQL guarantee durability?", answer: WAL is flushed on commit, pages are written later, and crash recovery replays WAL from the last checkpoint.
