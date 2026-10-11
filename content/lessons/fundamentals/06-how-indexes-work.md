---
slug: how-indexes-work
title: 'How indexes work: the book index for your data'
module: Performance
order: 60
summary: What an index physically is, why B-trees make lookups O(log n), how composite indexes and selectivity decide whether an index is used, and what every index costs you on writes.
level: intermediate
tags: [indexes, b-tree, performance, explain, composite-index, covering-index, query-planner]
recap: >-
  An index is a separate sorted structure, usually a B+tree, that maps column values to row locations so the database
  can jump to matching rows instead of scanning everything. Lookups are O(log n) and trees stay only 3 to 4 levels deep
  thanks to huge fan-out. Composite indexes follow the leftmost-prefix rule, low-selectivity predicates may skip the index,
  and functions, leading wildcards, type mismatches and some OR conditions can prevent index use. Every index speeds reads
  but slows every write, so verify with EXPLAIN or explain() before and after adding one.
---

## 1. The story

You have a 900-page cookbook and want the recipe for "paneer tikka".

- **Without an index:** you flip through all 900 pages, reading each one. That's a **full table scan** (a **collection scan** in MongoDB).
- **With the index at the back:** you jump to "P", find "Paneer tikka … page 412", and open page 412. A few seconds.

The index at the back of the book is:

- **sorted** (alphabetical), so you can find an entry quickly,
- **separate** from the content (extra pages the publisher had to print),
- a list of **pointers** ("page 412"), not the recipes themselves.

Map it to databases:

| Book | Database |
|---|---|
| Recipes on pages | Rows / documents in the table / collection |
| Index at the back | **Index**: a separate sorted structure |
| "Paneer tikka" | The **key**: the indexed column's value |
| "page 412" | A **pointer** to the row (PostgreSQL: a tuple id; MongoDB: a record id) |
| Flipping every page | **Seq Scan** / **COLLSCAN** |
| Reprinting the index for a new edition | **Index maintenance** on every write |

> **Remember:** an index is a **sorted copy of some columns plus pointers to the rows**. It trades extra storage and slower writes for much faster reads.

## 2. Why indexes exist

Your `orders` table has 50 million rows. A customer opens "My orders":

```sql
SELECT * FROM orders WHERE customer_id = 42;
```

Without an index, the database reads **all 50 million rows** to find the ~20 that match. The cost grows **linearly** with the table: **O(n)**. With an index on `customer_id`, it walks a tree a few levels deep and reads ~20 rows: **O(log n)** to find the start, plus the matches.

| | Full scan | Index lookup |
|---|---|---|
| Rows examined for 20 matches | 50,000,000 | ~20 (+ a few index pages) |
| Growth as data grows | Linear | Logarithmic |
| Good when | You need most of the table | You need a small fraction |

## 3. What an index physically is: the B+tree

The default index in PostgreSQL, MySQL (InnoDB) and MongoDB (WiredTiger) is a **B-tree**, in the **B+tree** style: keys are stored in sorted order in **leaf pages**, and **internal pages** only hold separator keys that guide the search. Because the leaves are in key order, a scan can move **sideways** from one leaf to the next. PostgreSQL and InnoDB keep direct links between neighbouring leaves for exactly this; WiredTiger gets the same in-order walk through its cursor.

Index on `orders(customer_id)`:

```text
                     ┌─────────────────┐
         root        │   100  │  200   │
                     └──┬─────┬─────┬──┘
           ┌────────────┘     │     └────────────┐
           ▼                  ▼                  ▼
    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
    │ 42 │ 57 │ 88│───►│120│150│ 199 │───►│210│260│ 300 │ leaves
    └──┬──────────┘    └─────────────┘    └─────────────┘
       │ customer 42 → row locations
       ▼
    ┌───────────────────────────────┐
    │ table (heap): actual rows     │
    └───────────────────────────────┘
```

**Equality lookup** `customer_id = 42`: start at the root, 42 < 100 so go left, find 42 in the leaf, follow its pointers to the rows.

**Range lookup** `customer_id BETWEEN 120 AND 260`: descend to 120 once, then **walk right along the leaves, in order,** until you pass 260. No need to go back up the tree. This is why B-trees are great for `<`, `>`, `BETWEEN` and `ORDER BY`.

### Why it's so shallow: fan-out

A tree page is a disk block (8 KB in PostgreSQL). One page holds **hundreds** of keys, so each level multiplies the reach by hundreds. This is called **fan-out**.

| Levels | Reach with fan-out ~300 |
|---|---|
| 1 | 300 |
| 2 | 90,000 |
| 3 | 27,000,000 |
| 4 | 8,100,000,000 |

So even a billion-row table is found in **3–4 page reads**, and the top levels are almost always cached in memory. That's the practical meaning of O(log n) here: the log has a huge base.

> **Remember:** B+tree = sorted, shallow, leaves in key order. Equality = walk down once. Range = walk down once, then walk sideways.

## 4. Composite indexes and the leftmost-prefix rule

A **composite (multi-column) index** sorts by the first column, then by the second within ties, and so on. Exactly like a **phone book** sorted by *last name, then first name*:

```text
Patel, Anil
Patel, Priya
Sharma, Asha
Sharma, Rahul     ◄── sorted by last name first,
Sharma, Zoya          then first name within it
Verma, Rahul
```

- Find "Sharma": easy, they're together. ✅
- Find "Sharma, Rahul": easy. ✅
- Find everyone named "Rahul": they're scattered across the whole book. ❌

That's the **leftmost-prefix rule**: an index on `(a, b, c)` is efficient for filters on `a`, `a + b`, or `a + b + c`, but not for `b` or `c` alone.

```sql
CREATE INDEX idx_orders_cust_status_date
  ON orders (customer_id, status, created_at);

-- ✅ uses the prefix
SELECT * FROM orders WHERE customer_id = 42;
SELECT * FROM orders WHERE customer_id = 42 AND status = 'shipped';
SELECT * FROM orders
WHERE customer_id = 42 AND status = 'shipped'
ORDER BY created_at DESC;              -- even the sort comes from the index

-- ❌ no leading column: can't seek into the index efficiently
SELECT * FROM orders WHERE status = 'shipped';
```

```js
db.orders.createIndex({ customerId: 1, status: 1, createdAt: -1 })

db.orders.find({ customerId: 42, status: 'shipped' }).sort({ createdAt: -1 }) // ✅
db.orders.find({ status: 'shipped' })                                         // ❌
```

Two details that impress interviewers:

- **Column order matters.** Put **equality** columns first and **range** columns after them. In PostgreSQL's words, equality conditions on leading columns plus an inequality on the *next* column limit the scan; columns after the first range condition can only be filtered, not used to seek. MongoDB teaches the same idea as the **ESR rule** (Equality, Sort, Range).
- **"Skip scan" exists but don't design around it.** Some engines (MySQL 8, and PostgreSQL 18 for B-trees) can sometimes use an index without its leading column when that column has few distinct values. It's an optimization, not a reason to ignore the rule.

> **Remember:** a composite index is a phone book. It helps if you know the **last name**; it's useless if you only know the **first name**.

## 5. Selectivity: why the planner sometimes ignores your index

**Selectivity** = what fraction of rows a condition matches. **Cardinality** = how many distinct values a column has.

- `email = 'asha@x.io'` matches 1 row in 10 million: **highly selective**. Index is a clear win.
- `status = 'delivered'` matches 85% of orders: **low selectivity**.

For the second query, using the index means: read index entries, then jump to the table for **each** of 8.5 million rows, in random order. Reading the whole table **sequentially** is cheaper. So PostgreSQL's **cost-based planner** estimates row counts from table statistics (gathered by `ANALYZE`/autovacuum) and may choose a **Seq Scan** even though an index exists. That's correct behaviour, not a bug.

PostgreSQL also has a middle ground, the **Bitmap Index Scan**: collect matching row locations from the index, sort them by physical position, then read the table pages in order.

MongoDB's planner works differently: it finds the candidate indexes for a query, **trial-runs** them briefly, and caches the winner. A collection scan is generally only chosen when no index can serve the query. So in MongoDB, a low-selectivity index can be used and still examine a huge number of keys. Either way, **check the plan**.

> **Remember:** an index helps when it **narrows** the result a lot. For "most of the table", a sequential scan is often faster, and the planner knows it.

## 6. Covering indexes and index-only scans

Normally an index lookup is two steps: find the key in the index, then **fetch the row** from the table. If the index already contains **every column the query needs**, step two can be skipped.

```sql
CREATE INDEX idx_orders_cust_total
  ON orders (customer_id) INCLUDE (total, created_at);

SELECT created_at, total FROM orders WHERE customer_id = 42;
-- Plan: Index Only Scan
```

In PostgreSQL, `INCLUDE` adds non-key payload columns. One PostgreSQL-specific catch: because of MVCC, an index-only scan still checks the table's **visibility map**, and must visit the row for pages not recently vacuumed. `EXPLAIN ANALYZE` shows this as `Heap Fetches`.

MongoDB calls this a **covered query**. The projection must include only indexed fields, and you must exclude `_id` unless it's in the index:

```js
db.orders.createIndex({ customerId: 1, total: 1 })
db.orders.find({ customerId: 42 }, { _id: 0, total: 1 })
// explain(): PROJECTION_COVERED, totalDocsExamined: 0
```

## 7. Clustered vs heap storage, and hash indexes

**Where do the rows themselves live?** Engines differ, and this is a favourite interview topic.

| Engine | Table storage | What secondary indexes point to |
|---|---|---|
| **PostgreSQL** | A **heap**: rows in no particular order | The row's physical location (a tuple id, `ctid`) |
| **MySQL InnoDB** | **Clustered** by primary key: the table *is* a B+tree on the PK | The **primary key value** (then a second lookup in the PK tree) |
| **MongoDB (WiredTiger)** | Documents stored by an internal record id | The record id; `_id` is a normal unique index |

Consequences:

- In InnoDB, PK range scans are very fast (rows are physically adjacent), and a large random PK (like a UUIDv4) causes page splits and fragmentation on insert.
- PostgreSQL has no maintained clustered index. The `CLUSTER` command reorders a table **once**; new rows don't keep that order.
- MongoDB optionally supports **clustered collections** (clustered on `_id`), mainly used for time-ordered data.

**Hash indexes** store a hash of the key instead of the sorted key.

- ✅ Equality lookups only.
- ❌ No ranges, no sorting, no prefix matching.
- PostgreSQL: `CREATE INDEX ... USING hash (col)`. It's rarely better than a B-tree in practice, so B-tree stays the default.
- MongoDB: `{ field: 'hashed' }` indexes exist mainly to support **hashed sharding**.

## 8. When an index is NOT used

Assume an index exists on the column in each case.

| Pattern | Why the index can't help | Fix |
|---|---|---|
| `WHERE lower(email) = 'a@x.io'` | The index is sorted by `email`, not `lower(email)` | Expression index: `CREATE INDEX ON customers (lower(email))` |
| `WHERE name LIKE '%phone'` | Leading wildcard: no sorted starting point | Full-text search, or a trigram (`pg_trgm`) GIN index |
| `WHERE id = 5.0` (int column) | The column gets cast to `numeric` to compare | Pass the right type from your driver |
| `WHERE status = 'delivered'` (85% of rows) | Low selectivity: a scan is cheaper | Partial index on the rare values, or accept the scan |
| `WHERE customer_id = 42 OR coupon = 'X'` | Every OR branch needs an index; one un-indexed branch forces a scan | Index both columns (PostgreSQL can combine them with a **BitmapOr**) |
| `WHERE created_at + interval '1 day' > now()` | Arithmetic on the column | Rewrite: `created_at > now() - interval '1 day'` |

Two engine-specific gotchas:

- **PostgreSQL prefix `LIKE 'abc%'`:** a default B-tree index supports it only with the `C` collation. With other collations, create the index with `text_pattern_ops`.
- **MongoDB regex:** a case-sensitive prefix regex like `/^Sam/` uses the index efficiently. `/sam/` or `/^sam/i` can't use it as a range, so it scans the whole index or the collection.
- **MongoDB type mismatch** isn't a "slow" problem, it's a **wrong-result** problem: `{ customerId: '42' }` doesn't match the number `42`.

> **Remember:** wrap the column in a function, start with a wildcard, or compare with the wrong type, and the sorted order of the index stops being useful.

## 9. The cost of every index

Indexes aren't free. Each one adds:

- **Write amplification:** every `INSERT` must add an entry to **every** index on the table. Ten indexes = one row write plus ten index writes. Updates vary by engine: in PostgreSQL an `UPDATE` writes a new row version, which normally needs a new entry in **every** index, even ones whose columns didn't change. The exception is a **HOT update** (heap-only tuple): if no indexed column changed and the new version fits on the same page, the indexes are left alone.
- **Storage:** indexes on big tables can be as large as the table itself.
- **Memory:** indexes are fast when their hot parts are in RAM (PostgreSQL's shared buffers and the OS cache, MongoDB's WiredTiger cache). Too many indexes compete for that memory.
- **Planner work** and **maintenance:** bloat, rebuilds, and slower bulk loads.

## 10. How to check: EXPLAIN and explain()

**PostgreSQL:**

```sql
EXPLAIN ANALYZE
SELECT * FROM orders WHERE customer_id = 42;
```

| Plan node | Meaning |
|---|---|
| `Seq Scan` | Read the whole table |
| `Index Scan` | Walk the index, fetch each row |
| `Index Only Scan` | Answered from the index (covering) |
| `Bitmap Heap Scan` | Collect matches from the index, read table pages in order |

`EXPLAIN` shows the plan and **estimates**. `EXPLAIN ANALYZE` actually **runs** the query and shows real times and row counts (careful with `UPDATE`/`DELETE`: they really execute).

**MongoDB:**

```js
db.orders.find({ customerId: 42 }).explain('executionStats')
```

Look for:

- `COLLSCAN` (bad on big collections) vs `IXSCAN` (index used), and `FETCH` (going to the documents).
- `totalKeysExamined`, `totalDocsExamined` vs `nReturned`. Ideally all three are close. Examining 1,000,000 docs to return 20 means a missing or wrong index.

Creating an index on a live table:

```sql
CREATE INDEX CONCURRENTLY idx_orders_customer ON orders (customer_id);
-- doesn't block writes while building (slower, can't run inside a transaction)
```

```js
db.orders.createIndex({ customerId: 1 })
```

## 11. Common mistakes and gotchas

- **Indexing every column "just in case".** Each one slows writes and uses memory. Index for **real queries**.
- **Separate single-column indexes instead of one composite.** `(customer_id)` and `(status)` separately are much weaker than `(customer_id, status)` for a query using both.
- **Wrong column order** in composite indexes (range column first).
- **Forgetting foreign keys.** PostgreSQL does **not** auto-index foreign key columns. Joins and `ON DELETE CASCADE` on `order_items.order_id` need one.
- **Duplicate indexes.** An index on `(customer_id)` is usually redundant if `(customer_id, status)` exists: the composite already serves the prefix. (The single-column one is smaller, so it's rarely worth the extra write cost.)
- **Trusting the index exists = it's used.** Always check the plan.

## 12. Index vs no index: trade-offs

| | Add the index | Skip it |
|---|---|---|
| Reads on that filter/sort | Much faster | Full scan |
| Writes | Slower (more structures to update) | Faster |
| Storage and RAM | More | Less |
| Best for | Selective, frequent queries; sorts; joins | Tiny tables, write-heavy logs, low-selectivity columns |

**When NOT to index:**

- **Small tables** (a few thousand rows): a scan is already instant.
- **Write-heavy, rarely-queried** data (raw event logs, audit trails).
- **Low-cardinality columns** on their own (`is_active`, `gender`). Consider a **partial index** for the rare value instead: `CREATE INDEX ON orders (created_at) WHERE status = 'pending'`.
- **Columns you only ever read through functions** you haven't built an expression index for.

> **Remember:** index for your **queries**, not your columns. Measure with EXPLAIN before and after.
