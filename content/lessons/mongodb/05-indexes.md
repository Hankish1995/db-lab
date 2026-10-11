---
slug: mongodb-indexes
title: 'MongoDB indexes: making queries fast without killing writes'
module: Performance
order: 50
summary: Which index types MongoDB offers, how to order compound index fields with the ESR rule, how to read explain() output, and what indexes cost.
level: intermediate
tags: [mongodb, indexes, performance, esr, explain, compound-index, ttl]
recap: >-
  An index is a sorted copy of some fields that lets MongoDB skip scanning the whole collection. In compound
  indexes, field order matters: put Equality fields first, then Sort, then Range (ESR). Read explain with
  executionStats: you want IXSCAN, no in-memory SORT, and keys examined close to documents returned.
  Every index speeds up some reads but slows every write and uses RAM, so drop the ones you don't use.
---

## 1. The story: the warehouse catalogue

Your warehouse has 2 million parcels on shelves. A customer asks: "Where are all the **paid** orders from **this week**, newest first?"

Without a catalogue, a worker walks **every aisle** checking every parcel. That's a **collection scan**.

With a card catalogue sorted by *status, then date*, the worker flips to "paid", reads the cards for this week **already in date order**, and walks straight to those shelves. That's an **index scan**.

| Warehouse | MongoDB |
|---|---|
| Walking every aisle | `COLLSCAN` |
| The card catalogue | **Index** (a B-tree of field values) |
| A card: value + shelf location | **Index key** + pointer to the document |
| Walking to the shelf for each card | `FETCH` |
| Sorting a pile of cards on the floor | In-memory `SORT` |

The general mechanics of B-trees are covered in [How indexes work](/lessons/how-indexes-work). This lesson is about **MongoDB specifics**.

> **Remember:** an index is a sorted list of field values with pointers to documents. It turns "check everything" into "jump to the right place and read in order".

## 2. Why indexes matter (and what they cost)

Without a suitable index, every `find`, `update` and `delete` filter scans the whole collection. Fine at 1,000 documents; painful at 10 million.

But indexes aren't free:

- **Writes:** every insert, delete, and update of an indexed field must update **every** relevant index.
- **RAM:** frequently used indexes should fit in memory (the storage engine's cache). If they don't, lookups hit disk.
- **Disk:** each index is stored separately.

A collection can have at most **64 indexes**, but you should be worried long before that. A handful of well-designed compound indexes beats twenty single-field ones.

## 3. The basic index types

```js
// _id: created automatically, unique, can't be dropped
db.orders.createIndex({ userId: 1 })                    // single field
db.orders.createIndex({ status: 1, createdAt: -1 })     // compound
```

For a **single-field** index, direction (`1` / `-1`) doesn't matter: MongoDB can walk it either way. For **compound** indexes it matters when you sort on several fields: `sort({ status: 1, createdAt: -1 })` can use the index above, or its exact reverse (`{ status: -1, createdAt: 1 }`), but not `{ status: 1, createdAt: 1 }`.

### Compound indexes and the prefix rule

An index on `{ status: 1, createdAt: 1, total: 1 }` is sorted by status, then by date within each status, then by total.

```text
status    │ createdAt  │ total
──────────┼────────────┼──────
paid      │ 2026-10-01 │  250
paid      │ 2026-10-02 │   40
paid      │ 2026-10-02 │  310
shipped   │ 2026-09-28 │   99
shipped   │ 2026-10-03 │  120
```

It supports queries on its **prefixes**: `{status}`, `{status, createdAt}`, `{status, createdAt, total}`. A query on only `createdAt` can't jump into it, because dates are scattered across every status. That's why **field order** is the most important decision.

## 4. The ESR rule: Equality, Sort, Range

For a compound index, order fields as:

1. **E**quality fields first (`status: "paid"`)
2. **S**ort fields next (`createdAt`)
3. **R**ange fields last (`total: { $gte: 100 }`)

The query (50,000 orders in our test collection, 20 results per page):

```js
db.orders.find({ status: "paid", total: { $gte: 100 } })
         .sort({ createdAt: -1 }).limit(20)
```

**❌ Bad: E-R-S** `{ status: 1, total: 1, createdAt: 1 }`

Inside "paid", entries are ordered by `total`, not by date. MongoDB reads every paid order with total ≥ 100 and then **sorts them in memory** to find the newest 20.

```text
IXSCAN → SORT → FETCH          ⚠️ in-memory sort
totalKeysExamined: 8000   totalDocsExamined: 20   nReturned: 20
```

**✅ Good: E-S-R** `{ status: 1, createdAt: 1, total: 1 }`

Inside "paid", entries are already in date order. MongoDB walks backward from the newest, skips entries with total < 100 using the index key alone, and stops after 20 matches.

```text
IXSCAN (backward) → FETCH → LIMIT     ✅ no sort stage
totalKeysExamined: 23     totalDocsExamined: 20   nReturned: 20
```

Same data, same query: **8,000 keys + a sort** vs **23 keys**. (These numbers come from running the query against a 50,000-document test collection.)

Why does the Range field go last? A range on `total` placed before the sort field breaks the index's date order into many pieces, forcing a sort. Placed after, it just filters entries the index already delivers in the right order.

> **Remember:** **E**quality → **S**ort → **R**ange. Equality narrows to one sorted slice, sort reads it in order, range filters inside it.

## 5. Specialized index types

### Multikey (arrays)

Index a field that holds an array and MongoDB creates **one index entry per element**, automatically.

```js
db.products.createIndex({ categoryIds: 1 })      // multikey
db.products.find({ categoryIds: "summer" })
```

⚠️ Limitation: in a compound index, **at most one indexed field can be an array** in any given document. Indexing `{ tags: 1, skus: 1 }` when both are arrays fails with "cannot index parallel arrays" (the number of entries would explode as a cross product).

### Text

```js
db.products.createIndex({ name: "text", description: "text" }, { weights: { name: 10 } })
db.products.find({ $text: { $search: "cotton shirt" } }, { score: { $meta: "textScore" } })
           .sort({ score: { $meta: "textScore" } })
```

Stemming and relevance scoring, but a collection can have **only one text index**. For serious search (autocomplete, typo tolerance, facets), use a dedicated search engine such as Atlas Search or Elasticsearch.

### 2dsphere (geo)

```js
db.stores.createIndex({ location: "2dsphere" })   // GeoJSON: [longitude, latitude]
db.stores.find({ location: { $near: {
  $geometry: { type: "Point", coordinates: [77.60, 12.97] }, $maxDistance: 5000 } } })
```

"Stores within 5 km." Note that GeoJSON puts **longitude first**.

### Hashed

```js
db.orders.createIndex({ customerId: "hashed" })
```

Stores a hash of the value. Supports **equality only** (no ranges, no sorting) and can't index arrays. Its main use is **hashed sharding** (see [Sharding](/lessons/sharding)).

### TTL (auto-expiry)

```js
// carts abandoned for 7 days are deleted
db.carts.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 604800 })

// or: expire exactly at a per-document time
db.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

- A background task deletes expired documents, roughly **every 60 seconds**, so deletion isn't instant.
- The field must hold a **Date** (or an array of dates). Documents without it never expire.
- TTL works on **single-field** indexes.

### Unique, and unique + partial

```js
db.users.createIndex({ email: 1 }, { unique: true })
```

⚠️ A **missing** field is indexed as `null`, so with a plain unique index, a **second** user without an email fails with a duplicate-key error. Make it unique only where the field exists:

```js
db.users.createIndex({ email: 1 },
  { unique: true, partialFilterExpression: { email: { $exists: true } } })
```

### Partial vs sparse

```js
// index only pending orders: smaller, cheaper
db.orders.createIndex({ createdAt: 1 }, { partialFilterExpression: { status: "pending" } })
```

| | Sparse | Partial |
|---|---|---|
| Indexes | Docs where the field exists | Docs matching **any filter expression** you choose |
| Flexibility | One fixed rule | `$exists`, equality, `$gt`, `$type`, `$and`… |
| Recommendation | Legacy | ✅ Prefer partial |

A partial index is used only when the query's filter **guarantees** a match with the partial filter, e.g. the query includes `status: "pending"`.

### Wildcard

```js
db.products.createIndex({ "specs.$**": 1 })   // every field under specs
db.products.find({ "specs.ram": "16GB" })      // can use it
```

Great for unpredictable, user-defined attributes. Not a replacement for designed compound indexes on known query patterns.

> **Remember:** match the index type to the query: arrays → multikey, text search → text, location → 2dsphere, expiry → TTL, "unique if present" → unique + partial.

## 6. Reading `explain("executionStats")`

```js
db.orders.find({ status: "paid", total: { $gte: 100 } })
         .sort({ createdAt: -1 }).limit(20)
         .explain("executionStats")
```

Look at `queryPlanner.winningPlan` (in some versions the stages are nested under `winningPlan.queryPlan`). Read the stages from the innermost `inputStage` outward:

| Stage | Meaning | Verdict |
|---|---|---|
| `COLLSCAN` | Scanned the whole collection | ❌ on large collections |
| `IXSCAN` | Walked an index (`indexName`, `indexBounds` show which and how) | ✅ |
| `FETCH` | Loaded full documents from the index pointers | Normal, unless the query could be covered |
| `SORT` | Sorted results in memory (blocking) | ⚠️ red flag on big result sets |
| `PROJECTION_COVERED` | Answered from the index alone | ✅✅ |

Then compare three numbers in `executionStats`:

```text
totalKeysExamined   index entries read
totalDocsExamined   documents loaded
nReturned           documents sent back
ideal:  keys ≈ docs ≈ nReturned   (1 : 1 : 1)
```

- **docs ≫ nReturned:** MongoDB loads many documents and throws most away. The index doesn't cover the filter well.
- **keys ≫ nReturned:** the index is walked inefficiently (often a range field placed before the sort or equality fields).
- **SORT present:** results are sorted in memory. A blocking sort is limited to 100 MB of RAM; beyond that it must spill to disk (allowed by default in recent versions) or the query fails.

> **Remember:** in explain, look for `IXSCAN` and no `SORT`, then check that keys examined, docs examined and nReturned are close to each other.

## 7. Covered queries

If every field in the filter **and** the projection is in the index, MongoDB never loads the documents.

```js
db.orders.find({ status: "paid" }, { _id: 0, status: 1, createdAt: 1 })
// winningPlan: PROJECTION_COVERED ← IXSCAN,  totalDocsExamined: 0
```

The trap: `_id` is returned by default. If you forget `_id: 0` (and `_id` isn't in the index), MongoDB must FETCH every document just to get `_id`. Multikey (array) fields generally can't be covered either.

## 8. Index builds on a live collection

Modern MongoDB builds indexes **without blocking reads and writes for the whole build**: it takes an exclusive lock only briefly at the **start and end**, and lets normal traffic continue in between. That doesn't make it free:

- The build scans the whole collection, using CPU, disk I/O and memory.
- On a replica set, the build runs on the data-bearing members and commits once enough of them have finished (see [Replication](/lessons/mongodb-replication)).
- Big builds on busy clusters are best scheduled for low-traffic periods.

## 9. How many indexes? Finding the useless ones

There's no magic number. Every index should be justified by a **real, frequent query**. Usual suspects for removal:

- **Redundant prefixes:** `{ status: 1 }` is redundant if `{ status: 1, createdAt: 1 }` exists.
- **Unused indexes:** created for a feature that no longer exists.

```js
db.orders.aggregate([{ $indexStats: {} }, { $project: { name: 1, "accesses.ops": 1, "accesses.since": 1 } }])
```

`accesses.ops` counts how many operations used each index **since the server started (or the index was created)**, on **that member only**. Check every replica set member, over a long enough period (month-end reports!), before deciding.

Then drop safely with a **hidden index**:

```js
db.orders.hideIndex("status_1")    // planner ignores it, but it's still maintained
// watch performance for a few days…
db.orders.unhideIndex("status_1")  // instant rollback, no rebuild
db.orders.dropIndex("status_1")    // or drop it for real
```

A hidden index still costs writes and still enforces `unique`, but the planner won't use it, so you can test "what if it were gone?" without a slow rebuild if you're wrong.

## 10. Common mistakes

- ❌ One single-field index per field instead of one compound index that matches the query.
- ❌ Range field before the sort field (E-R-S) → in-memory sort.
- ❌ Plain unique index on an optional field → second missing value fails.
- ❌ Forgetting `_id: 0` and wondering why the query isn't covered.
- ❌ Indexing low-selectivity fields alone (`isActive: true` on 99% of docs) → the index barely narrows anything.
- ❌ Case-insensitive or unanchored `$regex` expecting index-speed results.
- ❌ Dropping an index because `$indexStats` showed 0 ops on one secondary for one day.

## 11. Index type cheat sheet

| Type | Use for | Watch out |
|---|---|---|
| Single / compound | Most queries; ESR order | Field order, prefix rule |
| Multikey | Array fields | One array field per compound index |
| Text | Simple keyword search | One per collection |
| 2dsphere | Geo queries | Longitude first |
| Hashed | Equality, hashed sharding | No ranges or sorts |
| TTL | Auto-expire carts, sessions | ~60 s delay, Date field only |
| Unique (+ partial) | Business keys like email | Missing counts as null |
| Partial | Index a hot subset | Query must match the filter |
| Wildcard | Unknown/dynamic fields | Not a substitute for compound indexes |

## 12. When NOT to add an index

- **Write-heavy collections** (logs, events) where reads are rare: each index taxes every insert.
- **Small collections** (a few hundred documents): a collection scan is already fast.
- **Low-selectivity fields** on their own: they don't narrow the search enough.
- **Queries that run once** (a one-off migration): run them on a secondary or accept the scan.

> **Remember:** an index is a trade: faster reads for slower writes and more RAM. Add it for a real query, verify it with explain, and remove it when nothing uses it.
