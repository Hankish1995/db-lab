---
slug: postgres-indexes
title: 'PostgreSQL indexes: picking the right tool for each query'
module: Performance
order: 50
summary: The PostgreSQL-specific index toolbox (B-tree, multicolumn, partial, expression, covering, GIN, GiST, BRIN and hash), how to build indexes safely on live tables, and how to find unused and bloated ones, with real before/after EXPLAIN output.
level: intermediate
tags: [postgresql, indexes, b-tree, gin, gist, brin, partial-index, covering-index, explain, performance]
recap: >-
  B-tree is the default and handles equality, ranges, sorting and prefix LIKE (with the C collation or text_pattern_ops).
  Put equality columns first in multicolumn indexes. Partial indexes cover only the rows you query, expression indexes
  match functions like lower(email), and INCLUDE enables index-only scans that rely on the visibility map. Use GIN for
  jsonb, arrays and full-text, GiST for ranges, geometry and exclusion, and BRIN for huge append-only time-ordered
  tables. Build with CREATE INDEX CONCURRENTLY outside a transaction, check for INVALID leftovers, drop indexes that
  pg_stat_user_indexes shows are never used, and fix bloat with REINDEX CONCURRENTLY.
---

## 1. The story

A big hardware store has more than one way to find things:

- An **alphabetical catalogue** of every item: great for "find hammer" or "everything from H to K". (**B-tree**)
- A **"clearance only" leaflet** listing just the 40 items on sale. Tiny, and perfect if that's all you ask about. (**Partial index**)
- A **tag board**: under "waterproof" are pinned all items with that tag. (**GIN**, an inverted index)
- **Aisle signs** saying "Aisle 7: items delivered Jan–Mar". You don't know the exact shelf, but you know which aisles to skip. (**BRIN**)
- A **floor map** with zones that can overlap, for "what's within 10 metres of the entrance?". (**GiST**)

Each one answers some questions brilliantly and others not at all. PostgreSQL gives you all of them; the skill is matching the index to the query.

The fundamentals (what a B-tree is, selectivity, the leftmost-prefix rule, the write cost of indexes) are in [How indexes work](/lessons/how-indexes-work). This lesson is the PostgreSQL-specific toolbox.

> **Remember:** there's no "best index", only the best index **for a specific query**. Start from the query, then pick the type, columns and options.

## 2. The test setup

All plans below are real output from a scratch PostgreSQL 17 database: `orders` with 500,000 rows, `users` with 50,000, `products` with 5,000, and an append-only `page_views` table with 3,000,000 rows. Plans are trimmed for width.

## 3. B-tree: the default, with a before/after

`CREATE INDEX` with no `USING` builds a **B-tree**. It supports `=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, `IN`, `IS NULL` and `ORDER BY` on the indexed columns.

The "My orders" page:

```sql
SELECT id, status, total, created_at
FROM orders
WHERE user_id = 42
ORDER BY created_at DESC;
```

**Before** (no index on `user_id`):

```text
Gather Merge (actual time=62.178..69.210 rows=14 loops=1)
  ->  Sort  Sort Key: created_at DESC
        ->  Parallel Seq Scan on orders (rows=5 loops=3)
              Filter: (user_id = 42)
              Rows Removed by Filter: 166662
              Buffers: shared hit=5362 read=2482
Execution Time: 69.284 ms
```

The leader process and two parallel workers read all ~7,800 pages to find 14 rows.

**After** `CREATE INDEX orders_user_id_idx ON orders (user_id);`:

```text
Sort  Sort Key: created_at DESC
  ->  Bitmap Heap Scan on orders (rows=14 loops=1)
        Recheck Cond: (user_id = 42)
        ->  Bitmap Index Scan on orders_user_id_idx
              Index Cond: (user_id = 42)
Buffers: shared hit=17 read=3
Execution Time: 0.143 ms
```

About **480× faster**, 20 pages instead of 7,800. There's still a `Sort` node, though.

## 4. Multicolumn indexes: column order matters

Replace it with an index that matches both the filter **and** the sort:

```sql
CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC);
```

```text
Limit (actual time=0.047..0.058 rows=10 loops=1)
  ->  Index Scan using orders_user_created_idx on orders
        Index Cond: (user_id = 42)
Execution Time: 0.080 ms
```

No `Sort` node: the index already stores each user's orders in `created_at DESC` order, so PostgreSQL reads the first 10 entries and stops.

The rules (from [How indexes work](/lessons/how-indexes-work)):

- **Equality columns first, then range or sort columns.** `(user_id, created_at)` serves "user 42, newest first" and "user 42, last 30 days".
- **Leftmost prefix.** The same index doesn't help `WHERE created_at >= '2025-01-01'` alone. My test fell back to a parallel seq scan.
- **Direction** only matters for mixed sorts like `ORDER BY a ASC, b DESC`. A B-tree can be read backwards, so `(user_id, created_at)` also serves `ORDER BY created_at DESC` for one user.
- An index on `(user_id, created_at)` makes a separate `(user_id)` index redundant.

## 5. Partial indexes: index only the rows you ask about

The warehouse dashboard asks for old **pending** orders. Only 3% of orders are pending, and that's the only status this query cares about.

```sql
CREATE INDEX orders_pending_created_idx
  ON orders (created_at)
  WHERE status = 'pending';
```

```text
-- before: Parallel Seq Scan, Rows Removed by Filter: 161638 (x3)
--         Execution Time: 57.659 ms
-- after:
Limit (actual time=0.049..0.105 rows=50 loops=1)
  ->  Index Scan using orders_pending_created_idx on orders
        Index Cond: (created_at < (now() - '1 day'::interval))
Execution Time: 0.121 ms
```

Size comparison, same column, same table:

| Index | Size |
|---|---|
| `(created_at)` on all rows | 11 MB |
| `(created_at) WHERE status = 'pending'` | 352 kB |

Smaller, faster, and cheaper on writes: rows that don't match the `WHERE` aren't maintained in it (when they're inserted as delivered, nothing is added). The catch: the planner only uses it when the query's `WHERE` **implies** the index predicate. `WHERE status = 'paid'` can't use it.

Also great for **partial unique** rules: "one active cart per user" = `CREATE UNIQUE INDEX ON carts (user_id) WHERE status = 'active'`.

## 6. Expression indexes

Login looks up emails case-insensitively:

```sql
SELECT id FROM users WHERE lower(email) = 'user42@shop.io';
-- Seq Scan on users  Filter: (lower(email) = ...)
```

An index on `email` is sorted by `email`, not by `lower(email)`. Index the expression itself:

```sql
CREATE INDEX users_lower_email_idx ON users (lower(email));
-- Index Scan using users_lower_email_idx on users
--   Index Cond: (lower(email) = 'user42@shop.io'::text)
```

The query must use **exactly** the same expression. Make it `UNIQUE` to enforce case-insensitive uniqueness. Expression indexes cost CPU on every write (the function runs per row) and need `ANALYZE` to get statistics on the expression.

### Prefix LIKE and collations

`WHERE sku LIKE 'SKU-42%'` can use a B-tree as a range (`>= 'SKU-42' AND < 'SKU-43'`), **but only if the column's collation is `C`**. With a linguistic collation (e.g. `en-US`), sort order isn't plain byte order, so a normal index can't be used. Tested on a column with an ICU `en-US` collation:

```text
-- plain index:            Seq Scan  Filter: (sku ~~ 'SKU-42%'::text)
-- (sku text_pattern_ops): Bitmap Index Scan on sku_test_pattern_idx
--   Index Cond: ((sku ~>=~ 'SKU-42') AND (sku ~<~ 'SKU-43'))
```

A `text_pattern_ops` index supports `LIKE 'abc%'` but not ordinary `<`/`ORDER BY` under the column's collation, so you may need both. `LIKE '%abc'` (leading wildcard) can't use either; that needs a trigram index (`pg_trgm` with GIN) or full-text search.

> **Remember:** the index must match the query's **shape**: same leading columns, same expression, a predicate the query implies, and a compatible collation.

## 7. Covering indexes and index-only scans

If the index contains every column the query needs, PostgreSQL can skip the table: an **Index Only Scan**. `INCLUDE` adds payload columns to the leaf entries without making them part of the search key:

```sql
CREATE INDEX orders_user_created_incl_idx
  ON orders (user_id, created_at DESC) INCLUDE (status, total);

SELECT created_at, status, total FROM orders
WHERE user_id = 42 ORDER BY created_at DESC;
```

The PostgreSQL twist is **MVCC**: the index doesn't know whether a row version is visible to your transaction. So PostgreSQL checks the **visibility map**, one bit per heap page meaning "every row here is visible to everyone". If the bit is set, it skips the table; if not, it fetches the row from the heap. Watch `Heap Fetches`:

```text
-- right after VACUUM
Index Only Scan using orders_user_created_incl_idx  rows=14
  Heap Fetches: 0
-- after updating those users' orders
Index Only Scan using orders_user_created_incl_idx  rows=14
  Heap Fetches: 28
-- after VACUUM again
Index Only Scan using orders_user_created_incl_idx  rows=14
  Heap Fetches: 0
```

On frequently updated tables, index-only scans degrade until VACUUM sets the bits again (see [MVCC and VACUUM](/lessons/postgres-mvcc-and-vacuum)). Use `INCLUDE` for a few small columns; wide includes make the index big.

## 8. GIN, GiST, BRIN and hash

### GIN: "which rows contain this element?"

A **GIN** (Generalized Inverted Index) maps each **element** (a jsonb key/value, an array item, a word) to the rows that contain it. Use it for `jsonb`, arrays and full-text search.

```sql
CREATE INDEX products_attributes_gin ON products USING gin (attributes jsonb_path_ops);
CREATE INDEX products_tags_gin       ON products USING gin (tags);

SELECT id FROM products WHERE attributes @> '{"color": "red", "brand": "Brand6"}';
```

```text
Bitmap Heap Scan on products (actual rows=50 loops=1)
  Recheck Cond: (attributes @> '{"brand": "Brand6", "color": "red"}'::jsonb)
  ->  Bitmap Index Scan on products_attributes_gin
Execution Time: 0.102 ms
```

- `jsonb_path_ops` is smaller and faster for `@>` containment; the default `jsonb_ops` also supports key-exists operators (`?`, `?|`, `?&`).
- GIN does **not** help `attributes->>'color' = 'red'`. Rewrite as `@>`, or add a B-tree expression index on `(attributes->>'color')`.
- GIN is slower to update than a B-tree; one row can touch many index entries.

### GiST: overlap, containment, distance

**GiST** is a framework for data that doesn't sort in one line: ranges, geometric shapes, PostGIS geography. It answers "overlaps", "contains" and "nearest to" questions, and it powers **exclusion constraints**:

```sql
-- the EXCLUDE (product_id WITH =, active_during WITH &&) constraint on promotions
-- is a GiST index; queries use it too:
SELECT * FROM promotions WHERE active_during @> now();
-- Bitmap Index Scan on promotions_product_id_active_during_excl
```

### BRIN: tiny summaries for huge, ordered tables

A **BRIN** (Block Range INdex) stores only the **min and max** value per range of table pages (128 pages by default). It works when the column's values follow the physical order of the table, like `viewed_at` in an append-only log.

On `page_views` (3 million rows, 149 MB, inserted in time order), counting one day of views:

| Plan | Index size | Execution time |
|---|---|---|
| No index (parallel seq scan) | 0 | 151 ms |
| **BRIN** on `viewed_at` | **24 kB** | 6.7 ms |
| B-tree on `viewed_at` | 64 MB | 2.1 ms |

```text
Bitmap Heap Scan on page_views (actual rows=8640 loops=1)
  Rows Removed by Index Recheck: 31552
  Heap Blocks: lossy=256
  ->  Bitmap Index Scan on page_views_viewed_brin
        Buffers: shared hit=5
```

BRIN is **lossy**: it narrows the search to candidate page ranges, then rechecks rows. A B-tree is faster per query but about 2,700× bigger. And BRIN fails when the order isn't physical: on `orders.created_at`, whose rows had been shuffled by a bulk update, the same BRIN index still read 3,876 pages and removed 448,631 rows, no better than a scan. Check `correlation` in `pg_stats` (close to 1 or -1 is good).

### Hash: equality only

A **hash index** supports only `=`. It's crash-safe and replicated (since PostgreSQL 10), but it can't be unique, can't cover multiple columns, and can't do ranges or sorting. On `users.public_id` (uuid) it came out the same size as the B-tree (2,064 kB vs 2,056 kB). Reach for it only after measuring; the B-tree is usually just as good.

## 9. Which index for which query

| Query pattern | Index |
|---|---|
| `WHERE user_id = ?` / ranges / `ORDER BY` | B-tree |
| `WHERE user_id = ? ORDER BY created_at DESC LIMIT 10` | B-tree on `(user_id, created_at DESC)` |
| Only a small subset is ever queried (`status = 'pending'`) | Partial B-tree |
| `WHERE lower(email) = ?` | Expression index |
| Read a few columns without touching the table | B-tree with `INCLUDE` |
| `LIKE 'abc%'` with a non-C collation | B-tree with `text_pattern_ops` |
| `LIKE '%abc%'` | GIN with `pg_trgm` |
| `jsonb @> '{...}'`, `tags @> ARRAY[...]` | GIN |
| Full-text `to_tsvector(...) @@ query` | GIN |
| Range overlap, geometry, nearest neighbour, EXCLUDE | GiST |
| Time filter on a huge append-only table | BRIN |
| Equality only, very long keys | Hash (measure first) |

## 10. Unique indexes vs unique constraints

A `UNIQUE` constraint is implemented **with** a unique B-tree index. The differences are in what you can express:

| | `UNIQUE` constraint | `CREATE UNIQUE INDEX` |
|---|---|---|
| Partial (`WHERE ...`) | ❌ | ✅ |
| On an expression (`lower(email)`) | ❌ | ✅ |
| Can be `DEFERRABLE` | ✅ | ❌ |
| `ON CONFLICT ON CONSTRAINT name` | ✅ | Use `ON CONFLICT (cols)` instead |
| Shows up as a constraint in the schema | ✅ | ❌ (just an index) |

Both enforce uniqueness the same way, and both can be the target of a foreign key, unless the index is partial.

## 11. Building indexes on a live table

A plain `CREATE INDEX` locks the table against **writes** (reads still work) for the whole build. On a big, busy table that means checkout requests queue up for minutes.

```sql
CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);
```

`CONCURRENTLY` lets inserts, updates and deletes continue. The price:

- **Slower:** two passes over the table, and it waits for running transactions to finish.
- **Can't run inside a transaction block:**

```text
BEGIN;
CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);
ERROR:  CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

  Many migration tools wrap each migration in a transaction; you have to turn that off for this migration.

- **Failure leaves an INVALID index.** I built a unique index on `orders (user_id)` concurrently; duplicates made it fail, and the index stayed behind:

```text
ERROR:  could not create unique index "orders_user_unique_idx"
DETAIL:  Key (user_id)=(20378) is duplicated.

\d orders
    "orders_user_unique_idx" UNIQUE, btree (user_id) INVALID
```

  The planner ignores an invalid index, but it can still add write overhead. Find them with `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`, then `DROP INDEX CONCURRENTLY` and retry (or `REINDEX INDEX CONCURRENTLY`).

> **Remember:** on production tables, always `CREATE INDEX CONCURRENTLY`, outside a transaction, and check for `INVALID` indexes if it fails.

## 12. Finding unused indexes and fixing bloat

Every index slows every insert and most updates. PostgreSQL counts how often each index is used:

```sql
SELECT s.relname AS table_name,
       s.indexrelname AS index_name,
       s.idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique          -- unique/PK indexes enforce rules, keep them
ORDER BY pg_relation_size(s.indexrelid) DESC;
```

Before dropping anything:

- Counters are **since the last stats reset**, and they're **per server**: an index unused on the primary may be busy on a read replica.
- Monthly jobs may use an index once a month. Look at a long enough window.

**Bloat:** B-tree pages emptied by deletes and updates are reused only partially, so indexes grow over time. In my test, updating every row of `orders` once (then running VACUUM) grew a covering index from **24 MB to 47 MB**. Rebuilding it without blocking writes:

```sql
REINDEX INDEX CONCURRENTLY orders_user_created_incl_idx;   -- back to 24 MB
```

Like `CREATE INDEX CONCURRENTLY`, it can't run inside a transaction and needs extra disk space while both copies exist.

## 13. Common mistakes and gotchas

- **Adding an index without reading the plan.** Check with `EXPLAIN (ANALYZE, BUFFERS)` before and after ([Reading EXPLAIN](/lessons/postgres-explain)).
- **Wrong column order** in multicolumn indexes (range column first).
- **Expression mismatch:** an index on `lower(email)` doesn't help `WHERE email ILIKE ...`.
- **Expecting GIN to speed up `->>` comparisons.** It serves `@>`, `?` and friends.
- **BRIN on a column that isn't physically ordered.** Tiny index, no benefit.
- **Plain `CREATE INDEX` on a hot table during business hours.** Writes block.
- **Forgetting FK indexes** (`orders.user_id`, `order_items.product_id`): PostgreSQL doesn't create them.
- **Keeping "just in case" indexes.** Each one is paid for on every write and competes for cache.

## 14. Trade-offs

| Index type | Strength | Cost |
|---|---|---|
| B-tree | Versatile: equality, ranges, sorts | Size grows with rows; bloat over time |
| Partial | Tiny and fast for a hot subset | Only used when the query implies the predicate |
| Covering (`INCLUDE`) | Skips the table | Bigger index; depends on VACUUM |
| GIN | Containment, full-text, arrays | Slower writes, larger |
| GiST | Overlaps, distance, exclusion | Lossy, slower lookups than B-tree for plain equality |
| BRIN | Minuscule, great for append-only logs | Lossy; useless without physical ordering |
| Hash | Equality on long keys | No ranges, sorting, uniqueness or multicolumn |

> **Remember:** every index is a bet that its read savings outweigh its write and storage cost. Measure with EXPLAIN, watch `pg_stat_user_indexes`, and drop the losers.
