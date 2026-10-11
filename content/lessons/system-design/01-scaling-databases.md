---
slug: scaling-databases
title: 'Scaling databases: from 100 users to 10 million, one bottleneck at a time'
module: Scaling
order: 10
summary: How a database-backed app grows from one server to a multi-store architecture, which bottleneck appears at each stage, how to measure it, and why each step is premature until the numbers say otherwise.
level: intermediate
tags: [scaling, system-design, connection-pooling, caching, read-replicas, partitioning, sharding, cqrs, polyglot-persistence, observability]
recap: >-
  Scaling is a sequence of fixes, each triggered by a measured bottleneck: first fix queries and indexes, then buy a
  bigger machine, pool connections, cache hot reads, add read replicas, partition big tables, and shard only when one
  primary cannot take the writes or the data. Keep app servers stateless so they scale by adding copies. At large scale
  you split read models (CQRS) and use the right store per job: cache, search engine, warehouse. Measure p95/p99 latency,
  QPS, CPU, IOPS and connections before every step, because each step adds complexity you pay for forever.
---

## 1. The story: a shop that keeps outgrowing itself

Priya opens an online sneaker shop. One Node.js server, one PostgreSQL database, both on the same $20 VM. It works.

Then the shop gets popular, and every few months **something breaks in a new way**. Each time, the fix is different, and each fix is only right *at that moment*:

| Stage | Users | What hurts | Next step |
|---|---|---|---|
| 0 | 100 | Nothing | Ship features |
| 1 | 10k | Product pages take 2 s | **Queries and indexes** |
| 2 | 50k | DB CPU at 85% all day | **Vertical scaling** |
| 3 | 100k | "too many connections" | **Connection pooling**, stateless app |
| 4 | 500k | Same product read 1,000×/s | **Caching** |
| 5 | 1M | Reads still saturate the primary | **Read replicas** |
| 6 | 3M | `orders` table is 2 TB, vacuum never ends | **Partitioning** + archiving |
| 7 | 10M | Writes exceed one primary | **Sharding** |
| 8 | 10M+ | Search, dashboards, reports fight checkout | **CQRS** + **polyglot persistence** |

Think of it like a restaurant. First you make the chef faster (better recipes = **query tuning**). Then you buy a bigger kitchen (**vertical scaling**). Then you hire more waiters (**stateless app servers**) and give them a shared order rail so they don't each shout at the chef (**connection pool**). You prepare popular dishes in advance (**cache**), open a second kitchen that only plates copies of dishes (**read replicas**), and finally open a second restaurant (**sharding**).

> **Remember:** scaling is not one decision. It is a sequence of small fixes, each triggered by a bottleneck you have measured.

## 2. Measure before you scale

Every step below adds cost and complexity forever. So the first rule is: **find the actual bottleneck**. The numbers that matter:

| Metric | What it tells you |
|---|---|
| **p95 / p99 latency** | How slow the slowest 5% / 1% of requests are. Averages hide pain. |
| **QPS** (queries per second) | Load, split into reads and writes |
| **CPU** | Query execution cost (bad plans, missing indexes) |
| **IOPS** and disk latency | Data doesn't fit in RAM, so reads go to disk |
| **Cache hit ratio** (buffer cache) | Is your working set in memory? |
| **Active connections** | Pool exhaustion, connection storms |
| **Replication lag** | How stale replicas are |

Why percentiles? If 99 requests take 20 ms and 1 takes 3 s, the **average** is ~50 ms and looks fine. The **p99** is 3 s, and that user is checking out. A page that makes 20 backend calls hits a p99-slow call much more often than 1% of the time.

In PostgreSQL, start with `pg_stat_statements` (an extension you enable once) to find the queries that cost the most in total:

```sql
SELECT query, calls,
       round(mean_exec_time::numeric, 1)  AS mean_ms,
       round(total_exec_time::numeric, 0) AS total_ms
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

A query that takes 5 ms but runs 2 million times a day often matters more than a 3-second report that runs once.

> **Remember:** optimize for p95/p99 and total time, not averages. The slowest requests are the ones customers remember.

## 3. Stages 1–3: make one database go further

### Stage 1: queries and indexes (10k users)

The product listing filters by category and sorts by price. Without an index, PostgreSQL scans every row.

```sql
EXPLAIN ANALYZE
SELECT id, name, price_cents FROM products
WHERE category_id = 42 ORDER BY price_cents LIMIT 20;

CREATE INDEX CONCURRENTLY idx_products_category_price
  ON products (category_id, price_cents);
```

Other cheap wins: fix **N+1 queries** (one query per order item instead of one query total), select only needed columns, and use **keyset pagination** instead of large `OFFSET`s. This step is free and often gives 10–100× improvements. See [How indexes work](/lessons/how-indexes-work).

### Stage 2: vertical scaling (50k users)

Queries are good, but the box is simply busy. **Vertical scaling** (bigger CPU, more RAM, faster disks) is underrated: it needs no code changes, and modern cloud machines with hundreds of GB of RAM and fast NVMe disks can serve a surprisingly large business. Also move the database to **its own machine**, separate from the app.

The limits: price grows faster than capacity at the top end, there's a ceiling, and it's still **one point of failure**.

### Stage 3: connection pooling and stateless app servers (100k users)

To handle traffic, you run 20 Node.js instances behind a load balancer. Each opens a pool of 20 connections: 400 connections. PostgreSQL uses **a process per connection**, so hundreds of mostly idle connections waste memory and add contention. Autoscaling makes it worse: a traffic spike starts 30 more instances, and the database falls over with `too many connections`.

Fixes:

- Size each app pool deliberately. In node-postgres:

```ts
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                        // per instance; total = instances × max
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000, // fail fast instead of queueing forever
});
```

- Put a **connection pooler** such as PgBouncer between apps and the database, so thousands of client connections share a few dozen server connections. Details in [PostgreSQL connection pooling](/lessons/postgres-connection-pooling).
- A useful sanity check is **Little's law**: concurrent queries ≈ QPS × average query time. 2,000 QPS × 5 ms ≈ 10 queries in flight on average, so you need far fewer connections than you'd guess.

At the same time, make app servers **stateless**: no sessions, carts or uploads stored in a server's memory or local disk. Put sessions in Redis (or use signed tokens) and files in object storage. Then any instance can serve any request, and scaling the app tier is just "add more copies".

> **Remember:** app servers should be cattle, not pets. If killing one loses user data, it isn't stateless yet.

## 4. Stages 4–5: take reads off the primary

### Stage 4: caching (500k users)

Most e-commerce traffic is **reads**: browsing products, categories and reviews. The same product page is read thousands of times between changes. Put a cache in front: a CDN for images and static assets, Redis for hot objects like product details. A good cache can absorb the large majority of reads. The patterns and the traps (stale data, stampedes) are in [Caching](/lessons/caching).

### Stage 5: read replicas (1M users)

Some reads can't be cached well: "my orders", search filters with endless combinations, an admin dashboard. Add **read replicas**: copies of the database that apply the primary's changes and serve reads.

```ts
// writes always go to the primary
await primary.query('UPDATE users SET address = $1 WHERE id = $2', [addr, userId]);

// lag-tolerant reads go to a replica
const { rows } = await replica.query(
  'SELECT id, name, price_cents FROM products WHERE category_id = $1', [catId]);
```

The catch is **replication lag**: replicas are usually milliseconds behind, sometimes seconds. A user who just changed their address and immediately reads from a replica may see the old one. Route "read your own recent writes" to the primary. Replicas also **do not scale writes**: every replica must apply every write. See [Replication patterns](/lessons/replication-patterns).

> **Remember:** caches and replicas scale reads. Nothing in this section helps if your problem is writes.

## 5. Stages 6–7: split the data

### Stage 6: partitioning and archiving (3M users)

The `orders` table has billions of rows. Indexes no longer fit in RAM, maintenance (vacuum, index rebuilds) takes hours, and almost every query asks about the last 90 days.

**Partitioning** splits one table into pieces on the **same server**, for example one partition per month. Queries with a date filter touch only the relevant partitions (**partition pruning**), and dropping a whole old month is instant compared with `DELETE`-ing millions of rows. Old orders can move to cheaper storage. See [PostgreSQL partitioning](/lessons/postgres-partitioning).

### Stage 7: sharding (10M users)

Sharding splits data across **many servers**, each a full primary (with its own replicas) for part of the keys. It's the only step that scales **writes and storage** horizontally. It also brings shard-key choice, cross-shard queries and resharding pain, covered in [Sharding](/lessons/sharding).

A reality check worth saying in interviews: order writes are rarely the reason a shop shards. 50,000 orders a day is less than one write per second on average. High-volume writes usually come from carts, clickstream events, inventory reservations or logs, and those often move to a different store instead of forcing you to shard the main database.

## 6. Stage 8: CQRS and polyglot persistence

At this size, one database is being asked to do everything: checkout transactions, full-text search with typo tolerance, "revenue by region per week" reports, and recommendation features. These workloads fight over the same CPU and cache.

**CQRS** (Command Query Responsibility Segregation) separates the **write model** (normalized tables that enforce rules at checkout) from one or more **read models** shaped for specific queries: a denormalized product document for the storefront, a search index, a pre-aggregated sales table. Read models are updated asynchronously from the write side, usually through events or **change data capture** (CDC), so they are eventually consistent.

**Polyglot persistence** means using the right store per job:

| Job | Typical store |
|---|---|
| Orders, payments, inventory | Relational DB (or MongoDB with transactions) |
| Hot reads, sessions, rate limits | Redis |
| Product search, facets, typo tolerance | Search engine (Elasticsearch / OpenSearch) |
| Analytics, BI reports | Columnar warehouse (BigQuery, Snowflake, Redshift…) |
| Images, invoices | Object storage (S3-compatible) |

The final architecture:

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

> **Remember:** the primary database is the source of truth. Caches, replicas, search indexes and the warehouse are all derived copies, and every copy can be stale.

## 7. Symptom → likely fix

| Symptom | Likely cause | Likely fix |
|---|---|---|
| One endpoint slow, DB CPU high | Missing index, bad plan | `EXPLAIN ANALYZE`, add index, rewrite query |
| p99 spikes, high disk reads | Working set > RAM | More RAM, smaller indexes, archive old data |
| `too many connections` on deploy/spike | Pool per instance × instances | Smaller pools, PgBouncer |
| Same rows read thousands of times | Read-heavy hot data | Cache (Redis, CDN) |
| Primary CPU high, mostly reads | Read volume | Read replicas |
| Users see old data after saving | Reading from a lagging replica or stale cache | Read-your-writes routing, cache invalidation |
| Huge table, slow maintenance | Table size | Partitioning, archiving |
| Write throughput or storage beyond one primary | Single-writer limit | Sharding, or move that workload to another store |
| Reports slow down checkout | Mixed OLTP and analytics | Replica for reports, then a warehouse |
| Search queries with `LIKE '%term%'` | Wrong tool | Search engine |

## 8. Common mistakes

- **Scaling the wrong thing.** Adding replicas when the problem is one unindexed query just copies the slowness.
- **Sharding at 50k users** "because we'll be big". You pay the complexity every day for a problem you don't have.
- **Unbounded connection pools** with autoscaling app servers.
- **Caching without an invalidation plan**, then debugging "wrong price" bugs for weeks.
- **Reading from replicas everywhere** and breaking flows that need fresh data (checkout, "my profile").
- **Trusting averages.** p50 looks great while p99 is on fire.
- **Ignoring the write path.** Reads scale easily with copies; writes need splitting.

## 9. When each step is premature

| Step | Premature when… |
|---|---|
| Vertical scaling | Queries are unindexed; you'd be buying hardware to run bad SQL |
| Connection pooler | Few app instances, connections well below the server limit |
| Cache | DB is comfortable; data changes constantly; you can't tolerate staleness |
| Read replicas | Load is writes, or the slow part is one query an index would fix |
| Partitioning | Tables are millions of rows, not billions; queries don't filter by the partition key |
| Sharding | One primary handles writes and data fits; you haven't tried the steps above |
| CQRS / extra stores | One database serves all queries fine; the team can't operate more systems |

Every new component is another thing to monitor, back up, secure and keep consistent. The best architecture is the **simplest one that meets your measured needs, with a plan for the next step**.

> **Remember:** in an interview, walk the ladder in order and justify each step with a number. "We shard because writes hit X per second" beats "we shard because it scales".
