---
slug: mongodb-performance
title: 'Performance and production: finding and fixing slow MongoDB'
module: Performance
order: 100
summary: A repeatable workflow for diagnosing slow MongoDB queries, plus the memory, pagination, write, connection and data-growth practices that keep a production cluster fast.
level: advanced
tags: [mongodb, performance, explain, profiler, pagination, wiredtiger, production, monitoring]
recap: >-
  When a query is slow, reproduce it, run explain with executionStats, and compare documents examined to
  documents returned before fixing it with the right index. The profiler and slow query log find the
  culprits for you. Keep the working set in the WiredTiger cache, paginate by range instead of skip,
  project only what you need, avoid unanchored or case-insensitive regex, batch writes, share one client
  per process, and stop data and arrays from growing without bounds.
---

## 1. The story: the slow "My orders" page

Monday morning. Support says: "The **My orders** page takes 4 seconds for some customers." It was instant last year.

A bad detective guesses: "Let's add more RAM." A good detective **collects evidence**:

1. **Reproduce** the exact query that's slow.
2. **Examine** how MongoDB ran it (`explain`).
3. **Find the cause** (a scan, a sort in memory, too much data).
4. **Fix** it and **measure again**.

| Detective | MongoDB |
|---|---|
| The crime scene | The slow endpoint |
| Witness statements | Slow query log and **profiler** |
| Forensic report | `explain('executionStats')` |
| The culprit | Missing index, in-memory sort, huge documents, deep `skip` |
| Proof it's solved | Same query, new `explain`, lower latency |

> **Remember:** never tune by guessing. Reproduce, explain, fix, measure.

## 2. Why performance degrades

MongoDB rarely gets slower because the software changed. It gets slower because:

- **Data grew.** A collection scan over 5,000 orders was fine; over 50 million it isn't.
- **The working set outgrew RAM**, so reads now hit the disk.
- **New query shapes** shipped without matching indexes.
- **Documents grew** (unbounded arrays) and every read and update moves more bytes.
- **Connections or writes** multiplied with more app instances.

## 3. The workflow: explain a slow query

The query behind the page:

```js
db.orders.find({ customerId: 7, status: 'paid' }).sort({ createdAt: -1 })
```

Ask MongoDB how it ran it:

```js
db.orders.find({ customerId: 7, status: 'paid' })
  .sort({ createdAt: -1 })
  .explain('executionStats')
```

Fields that matter:

| Field | Meaning | Red flag |
|---|---|---|
| `winningPlan.stage` | How it read data | `COLLSCAN`, or a `SORT` stage (in-memory sort) |
| `nReturned` | Documents returned | — |
| `totalKeysExamined` | Index entries read | Much higher than `nReturned` |
| `totalDocsExamined` | Documents read | Much higher than `nReturned` |
| `executionTimeMillis` | Server time | Compare before/after |

On a test collection of 2,000 orders, **before** adding an index:

```text
stage: SORT (over a COLLSCAN)
nReturned: 27   totalKeysExamined: 0   totalDocsExamined: 2000
```

MongoDB read **every** order to return 27, then sorted them in memory. The **examined-to-returned ratio** is about 74:1. On 50 million orders, that ratio is the 4 seconds.

The fix follows the **ESR rule** (Equality, Sort, Range) from [MongoDB indexes](/lessons/mongodb-indexes):

```js
db.orders.createIndex({ customerId: 1, status: 1, createdAt: -1 })
```

**After:**

```text
stage: FETCH ◄ IXSCAN { customerId: 1, status: 1, createdAt: -1 }
nReturned: 27   totalKeysExamined: 27   totalDocsExamined: 27
```

A **1:1 ratio** and no `SORT` stage: the index delivers documents already in order.

> **Remember:** the health check of any query is examined ÷ returned. Close to 1 is great; hundreds or thousands means a missing or wrong index.

## 4. Finding slow queries you didn't know about

### The slow query log

Every operation slower than **`slowms`** (default **100 ms**) is written to the `mongod` diagnostic log, even with the profiler off. On Atlas, the **Query Profiler** and **Performance Advisor** show these and suggest indexes.

### The database profiler

The **profiler** records operations into the `system.profile` collection of a database.

```js
db.setProfilingLevel(1, { slowms: 100 })   // 1 = only ops slower than 100 ms
db.getProfilingStatus()                    // { was: 1, slowms: 100, sampleRate: 1, ... }

// The five most recent slow operations
db.system.profile.find().sort({ ts: -1 }).limit(5)

// Slow queries that scanned whole collections
db.system.profile.find({ planSummary: 'COLLSCAN' })

db.setProfilingLevel(0)                    // turn it off again
```

| Level | Records |
|---|---|
| `0` | Nothing (slow ops still go to the log) |
| `1` | Operations slower than `slowms` |
| `2` | **Everything**: heavy overhead, short debugging sessions only |

⚠️ The profiler adds load. Use level 1 with a sensible `slowms`, and level 2 only briefly.

## 5. Memory: the working set and the WiredTiger cache

The **working set** is the data and indexes your app touches regularly: today's orders, popular products, and the indexes used to find them.

**WiredTiger**, MongoDB's storage engine, keeps hot data in its own **cache**. By default the cache is the larger of **50% of (RAM − 1 GB)** or **256 MB**. On a 16 GB server: 0.5 × 15 = **7.5 GB**. The rest of RAM is used by the OS file cache, connections and other memory needs.

```text
 Request ──► ┌──────────────────┐  hit  ──► fast (microseconds)
             │ WiredTiger cache │
             └────────┬─────────┘
                      │ miss
                      ▼
             ┌──────────────────┐
             │   OS file cache  │──► disk ──► slow (milliseconds)
             └──────────────────┘
```

If the working set **fits in the cache**, most reads are memory reads. If it doesn't, MongoDB keeps evicting and reloading pages, and latency jumps. This is why **indexes should fit in RAM** and why a full collection scan hurts twice: it's slow itself **and** it pushes useful data out of the cache.

```js
const c = db.serverStatus().wiredTiger.cache
c['bytes currently in the cache']
c['maximum bytes configured']
c['pages read into cache']       // rising fast = lots of cache misses
```

> **Remember:** fast MongoDB = working set (hot documents + indexes) fits in the WiredTiger cache.

## 6. Pagination: skip is a trap

Page 1,000 of "all orders, newest first", 20 per page:

```js
// ❌ Offset pagination
db.orders.find().sort({ createdAt: -1, _id: -1 }).skip(19980).limit(20)
```

`skip` doesn't jump. The server still **walks past every skipped entry**. In our test, `skip(1500).limit(3)` examined **1,503** index keys to return 3. Deep pages get slower and slower.

**Keyset (range-based) pagination** remembers where the last page ended and continues from there using the index:

```js
// mongosh (in Node.js, add `await` before .toArray())
// Index that matches the sort
db.orders.createIndex({ createdAt: -1, _id: -1 })

// Page 1
const page = db.orders.find({}, { total: 1, status: 1, createdAt: 1 })
  .sort({ createdAt: -1, _id: -1 })
  .limit(20)
  .toArray()
const last = page[page.length - 1]   // send this cursor to the client

// Next page: everything strictly "after" the last item
db.orders.find({
  $or: [
    { createdAt: { $lt: last.createdAt } },
    { createdAt: last.createdAt, _id: { $lt: last._id } }   // tie-breaker
  ]
}, { total: 1, status: 1, createdAt: 1 })
  .sort({ createdAt: -1, _id: -1 })
  .limit(20)
```

In our test the next page examined **3 keys for 3 results**, no matter how deep it was.

| | `skip` / `limit` | Keyset (range) |
|---|---|---|
| Cost of page N | Grows with N | Constant |
| Jump to page 500 | ✅ | ❌ (next/previous only) |
| Stable when new rows arrive | ❌ Items shift between pages | ✅ |
| Best for | Small collections, admin tables | Feeds, infinite scroll, APIs |

The `_id` tie-breaker matters: many orders can share the same `createdAt`, and without it you'd skip or repeat items.

> **Remember:** `skip` cost grows with the page number. Range-based pagination on an indexed field stays constant.

## 7. Read less: projection and regex

### Projection

An order list page needs `status`, `total` and `createdAt`, not the full items, addresses and status history.

```js
db.orders.find({ customerId: 7 }, { status: 1, total: 1, createdAt: 1 })
```

Less data means less network, less memory in Node.js and less BSON decoding. If every projected and filtered field is in the index, the query can be **covered**: `totalDocsExamined: 0`.

### Regex

| Query | Index use |
|---|---|
| `{ name: /^Key/ }` | ✅ Efficient: a case-sensitive prefix becomes an index range |
| `{ name: /board/ }` | ⚠️ Must check every index key or document |
| `{ name: /^key/i }` | ⚠️ Case-insensitive: can't use a tight range |

Fixes for search boxes:

- Store a normalized field (`nameLower`) and query it with an anchored, case-sensitive prefix.
- Use a **case-insensitive collation index** for exact matches:

```js
db.products.createIndex({ name: 1 }, { collation: { locale: 'en', strength: 2 } })
db.products.find({ name: 'keyboard' }).collation({ locale: 'en', strength: 2 })
```

- For real full-text search, use a text index or Atlas Search instead of regex.

## 8. Writes: batch them

Inserting 10,000 products one `insertOne` at a time means 10,000 network round trips.

```js
db.products.bulkWrite([
  { insertOne: { document: { sku: 'KB-2', name: 'Keyboard Pro', price: 80, stock: 50 } } },
  { updateOne: { filter: { sku: 'KB-1' }, update: { $inc: { stock: -2 } } } },
  { deleteOne: { filter: { sku: 'OLD-9' } } }
], { ordered: false })
```

- **`bulkWrite` / `insertMany`** send many operations per round trip. Drivers split very large batches automatically.
- **`ordered: false`** keeps going after an individual error (like a duplicate key) and allows operations to run in parallel, for example across shards. `ordered: true` (default) stops at the first error.
- **Batch sizes** of a few hundred to a few thousand documents are a good starting point for imports. Measure.
- **Write concern trade-off:** `w: 'majority'` waits for replication and is the safe default. `w: 1` is faster but can lose writes on failover. Never use `w: 0` for data you care about.
- Every **index** slows down every write a little. Drop indexes nothing uses (`$indexStats` shows usage).

## 9. Connections from Node.js

Each `MongoClient` owns a **connection pool** (driver default `maxPoolSize: 100`). Create **one client per process** at startup and reuse it everywhere.

```js
// db.js
import { MongoClient } from 'mongodb';
export const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 50 });
await client.connect();
```

Watch the multiplication: **30 pods × 100 connections = 3,000 connections**. Each one uses memory on the server, and clusters have connection limits. Creating a new client per request is worse: you pay connection setup and authentication every time, and connections pile up.

## 10. Data growth: large documents and unbounded arrays

- Documents are capped at **16 MB**, but you'll feel pain long before that. Reading a product loads the **whole document** into the cache.
- Big documents also make writes heavier: more bytes to cache, write to disk and replicate, even when you only change one field.
- **Unbounded arrays** are the usual culprit: pushing every review into `product.reviews` or every event into `order.history` forever.

Fix: keep **recent or summary data embedded** (e.g. the latest 10 reviews and `reviewCount`), and move the full history to its own collection (see [MongoDB schema design](/lessons/mongodb-schema-design)).

### Capping growth

Data you don't need forever should **expire**.

```js
// Delete abandoned carts 7 days after their last update
db.carts.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 })
```

A **TTL index** is a single-field index on a date. A background task checks it about **every 60 seconds**, so deletion isn't instant. Data you must keep but rarely read (orders older than 2 years) can be **archived**: copy it to an archive collection or cheaper storage with `$merge`, then delete it from the hot collection in batches.

> **Remember:** a collection that only grows will eventually outgrow your RAM. Plan expiry or archiving on day one.

## 11. What to monitor

| Metric | Where | What it tells you |
|---|---|---|
| **opcounters** | `db.serverStatus().opcounters` | Inserts/queries/updates/deletes per second: your load |
| **Query targeting** (scanned ÷ returned) | Atlas metric, `metrics.queryExecutor` | High = missing indexes |
| **Cache usage & pages read** | `serverStatus().wiredTiger.cache` | Working set no longer fits in RAM |
| **Replication lag** | `rs.printSecondaryReplicationInfo()` | Secondaries falling behind; stale reads, failover risk |
| **Connections** | `serverStatus().connections` | Pool misconfiguration, connection leaks |
| **Slow queries** | Log, profiler, Atlas Query Profiler | Exactly which queries to fix first |
| **Disk IOPS / latency** | OS / cloud metrics | Disk is the bottleneck |

## 12. Common mistakes

- **Adding RAM or a bigger tier** before running `explain`.
- **Indexes that don't match the sort**, causing an in-memory `SORT` stage.
- **Deep `skip` pagination** on public APIs.
- **`find()` without projection**, returning 200 KB documents to list pages.
- **Unanchored `$regex`** in a search box on a large collection.
- **A new `MongoClient` per request** or per Lambda invocation.
- **Profiler level 2** left on in production.
- **Unbounded arrays** and collections with no retention plan.

## 13. Production checklist

| Area | Check |
|---|---|
| Deployment | Replica set (3 data-bearing members), not a standalone |
| Indexes | Every frequent query has an index; ratio ≈ 1; unused indexes removed |
| Index builds | Created deliberately at deploy time, not by app startup (`autoIndex` off) |
| Memory | Working set and indexes fit in the WiredTiger cache |
| Queries | Projections on list endpoints; no unanchored regex on big collections |
| Pagination | Keyset pagination for feeds and APIs |
| Writes | Batched with `bulkWrite`; `w: 'majority'` for important data |
| Connections | One client per process; `maxPoolSize` sized for total app instances |
| Growth | TTL indexes or archiving; no unbounded arrays |
| Observability | Slow query log/profiler reviewed; alerts on lag, cache, connections, targeting |
| Safety | Backups tested by actually restoring them |

## 14. Trade-offs: when not to optimize

- **Don't index everything.** Each index costs RAM and slows writes. Index for your real, frequent queries.
- **Don't shard to fix a missing index.** Sharding multiplies complexity; fix queries first (see [Sharding](/lessons/sharding)).
- **Don't use keyset pagination** where users truly need "jump to page 37" on small datasets; `skip` is fine there.
- **Don't drop to `w: 1`** to make benchmarks look good if losing an order is unacceptable.
- **Don't micro-optimize** a query that runs twice a day. Optimize what the profiler says is slow and frequent.
