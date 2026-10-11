---
slug: postgres-explain
title: 'EXPLAIN: reading a query plan like a detective'
module: Performance
order: 60
summary: How to read EXPLAIN and EXPLAIN ANALYZE output, what each scan, join and sort node means, why the planner picks it, and how to go from a slow query to a fix.
level: advanced
tags: [postgresql, explain, query-plan, performance, indexes, joins, statistics, pg-stat-statements]
recap: >-
  EXPLAIN shows the plan the planner intends to run; EXPLAIN ANALYZE actually runs the query and shows what
  really happened, so wrap writes in BEGIN and ROLLBACK. Read the tree from the innermost node outwards, compare
  estimated rows with actual rows, multiply per-loop numbers by loops, and use BUFFERS to see how much data was touched.
  Seq, Index, Index Only and Bitmap scans plus Nested Loop, Hash and Merge joins cover most plans. Big estimate errors
  usually mean stale statistics, so run ANALYZE; find the worst queries first with pg_stat_statements.
---

## 1. The story

The checkout page of your store got slow overnight. Nobody changed the code. You're the detective.

A detective has two kinds of evidence:

- **The suspect's plan**, written before the crime: "I'll enter through the back door, then take the stairs". That's what someone *intended* to do.
- **The CCTV footage**: what *actually* happened, minute by minute, including the moment the plan went wrong.

PostgreSQL gives you both.

| Detective | PostgreSQL |
|---|---|
| The written plan | **`EXPLAIN`**: the plan the **planner** chose, with **estimates** |
| The CCTV footage | **`EXPLAIN ANALYZE`**: the query **really runs**, with real times and row counts |
| Fingerprints on every door | **`BUFFERS`**: how many 8 kB pages each step touched |
| "He said 1 visitor, CCTV shows 199,000" | **Estimated vs actual rows**: the classic clue |
| The case file of all crimes this year | **`pg_stat_statements`**: which queries cost the most overall |

> **Remember:** `EXPLAIN` = what PostgreSQL *plans* to do. `EXPLAIN ANALYZE` = what it *actually did*. Most slow-query mysteries are solved by comparing the two.

## 2. Why the plan exists at all

SQL is **declarative**: you say *what* you want, not *how* to get it. For one query with two joins there may be hundreds of possible strategies: which table first, index or full scan, which join algorithm.

The **planner** (a cost-based optimizer) estimates the cost of many of them and picks the cheapest. Its estimates come from **statistics** about your data (row counts, common values, value distributions) collected by `ANALYZE`.

When the statistics are right, the plan is usually great. When they're wrong, or an index is missing, you get a bad plan, and `EXPLAIN` is how you see it. For the basics of what an index is, see [How indexes work](/lessons/how-indexes-work) and [PostgreSQL indexes](/lessons/postgres-indexes).

## 3. The three flavours of EXPLAIN

```sql
-- 1. Plan only. Does NOT run the query. Instant and safe.
EXPLAIN SELECT * FROM orders WHERE customer_id = 4242;

-- 2. Runs the query, shows real times and rows.
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 4242;

-- 3. Runs it and also shows pages touched (the one you want most of the time).
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE customer_id = 4242;
```

⚠️ **`EXPLAIN ANALYZE` really executes the statement.** An `EXPLAIN ANALYZE DELETE` deletes rows. For writes, wrap it in a transaction you throw away:

```sql
BEGIN;
EXPLAIN ANALYZE UPDATE products SET price = price * 1.1 WHERE category = 'toys';
ROLLBACK;  -- the update is undone, the plan output stays on your screen
```

Other useful options: `FORMAT JSON` (for visualizer tools), `VERBOSE` (output columns), `SETTINGS` (non-default planner settings). In recent versions (PostgreSQL 18+) `ANALYZE` includes buffer counts automatically; on older versions ask for `BUFFERS` explicitly.

## 4. Anatomy of a plan

All examples below are real output from a scratch database with 50,000 customers, 500,000 orders and 1,000,000 order items. Here is "the 5 most recent orders of customer 4242":

```text
Limit  (cost=0.42..22.33 rows=5 width=23)
       (actual time=0.058..0.077 rows=5 loops=1)
  Buffers: shared hit=10 read=1
  ->  Index Scan using orders_customer_created_idx on orders
        (cost=0.42..48.61 rows=11 width=23)
        (actual time=0.055..0.074 rows=5 loops=1)
        Index Cond: (customer_id = 4242)
        Buffers: shared hit=10 read=1
Execution Time: 0.118 ms
```

(Example output, line-wrapped for width.)

| Field | Meaning |
|---|---|
| `cost=0.42..22.33` | **Startup cost .. total cost**, in arbitrary planner units (one sequential page read = 1.0). Startup = cost before the first row comes out. A parent's cost **includes** its children |
| `rows=5` | **Estimated** rows this node returns **per loop** |
| `width=23` | Estimated average row size in bytes |
| `actual time=0.055..0.074` | Real ms to the **first** row .. to the **last** row, **per loop** |
| `rows=5 loops=1` | Real rows per loop, and how many times the node ran |
| `Buffers: shared hit=10 read=1` | Pages found in PostgreSQL's cache (**hit**) vs fetched from the OS (**read**, may still be OS cache) |

### Reading order: inside-out

A plan is a **tree**. Each `->` is a child that feeds rows to its parent. Execution starts at the **deepest, most indented** nodes and flows **up**.

```text
 Nested Loop                      ← 3. combines the two streams
 ├─► Index Scan on customers      ← 1. outer input (runs once)
 └─► Bitmap Heap Scan on orders   ← 2. inner input (per outer row)
     └─► Bitmap Index Scan        ← 2a. feeds the heap scan
```

### The loops trap

`actual time` and `rows` are **averages per loop**. When `loops=20`, multiply:

```text
->  Bitmap Heap Scan on orders o
      (actual time=0.017..0.113 rows=10 loops=20)
```

This node returned about 10 × 20 = **200 rows** and spent about 0.113 × 20 ≈ **2.3 ms**, not 0.1 ms. Parallel plans do the same: `loops=3` means the leader plus 2 workers.

> **Remember:** read the plan bottom-up, compare `rows` estimated vs actual at every node, and always multiply by `loops`.

## 5. Scan nodes: how rows are fetched from a table

| Node | What it does | Chosen when |
|---|---|---|
| **Seq Scan** | Reads every page of the table | No useful index, or a large fraction of rows match |
| **Index Scan** | Walks the index, then fetches each matching row from the table (**heap**) | Few rows match, or rows are needed in index order (`ORDER BY ... LIMIT`) |
| **Index Only Scan** | Answers from the index alone | All needed columns are in the index **and** pages are marked all-visible |
| **Bitmap Index Scan → Bitmap Heap Scan** | Collects matching row locations into a bitmap, then reads pages in physical order | A "medium" number of rows, scattered across the table |

### Why the bitmap scan exists

An Index Scan jumps around the table: row 1 on page 900, row 2 on page 12, row 3 on page 900 again. With thousands of matches that becomes thousands of random page reads.

A bitmap scan first walks the index and marks **which pages** contain matches, then reads those pages **once each, in order**. It can also combine two indexes with `BitmapAnd` / `BitmapOr`. The `Recheck Cond` line exists because if the bitmap grows beyond `work_mem` it becomes **lossy** (remembers pages, not rows), so rows are re-checked.

Same query shape, different selectivity. Orders from the last 7 days (about 1% of rows):

```text
Bitmap Heap Scan on orders  (rows=4778) (actual rows=4813 loops=1)
  Recheck Cond: (created_at >= (now() - '7 days'::interval))
  Heap Blocks: exact=3055
  ->  Bitmap Index Scan on orders_created_idx  (actual rows=4813)
```

Orders from the last 600 days (about 82% of rows), same index available:

```text
Parallel Seq Scan on orders  (actual rows=137018 loops=3)
  Filter: (created_at >= (now() - '600 days'::interval))
  Rows Removed by Filter: 29649
```

That's not the planner being dumb. Reading 82% of the table through an index is slower than just reading the table.

### Index Only Scan and Heap Fetches

```text
Index Only Scan using orders_customer_created_idx on orders
  (actual rows=997 loops=1)
  Index Cond: ((customer_id >= 100) AND (customer_id <= 200))
  Heap Fetches: 0
```

`Heap Fetches: 0` is the dream. On a table that hadn't been vacuumed yet, a merge join's index-only scan showed `Heap Fetches: 999900`: every row still had to be checked in the table, because the **visibility map** didn't yet mark those pages all-visible. Vacuum maintains that map; see [MVCC and VACUUM](/lessons/postgres-mvcc-and-vacuum).

> **Remember:** a Seq Scan is not automatically bad. It's bad when it filters out almost everything (`Rows Removed by Filter` is huge and `rows` is tiny).

## 6. Join algorithms

| Algorithm | How it works | Best when | Join condition |
|---|---|---|---|
| **Nested Loop** | For each outer row, look up matching inner rows | Small outer input + **indexed** inner side | Any (the only one for `<`, `BETWEEN`, etc.) |
| **Hash Join** | Build a hash table from the smaller input, probe it with the larger | Big, unsorted inputs | Equality only |
| **Merge Join** | Walk two inputs **sorted on the join key** side by side | Both inputs already sorted (indexes) or large | Equality (mergeable) |

Nested Loop: 20 customers, their orders looked up through an index 20 times.

```text
Nested Loop  (actual time=0.052..2.398 rows=204 loops=1)
  ->  Index Scan using customers_pkey on customers c  (rows=20 loops=1)
        Index Cond: ((id >= 1) AND (id <= 20))
  ->  Bitmap Heap Scan on orders o  (rows=10 loops=20)
        Recheck Cond: (c.id = customer_id)
```

Hash Join: revenue per country across all 500,000 orders. The `Hash` child is the **build** side (customers, 2.8 MB in memory, 1 batch).

```text
Hash Join  (actual rows=166667 loops=3)
  Hash Cond: (o.customer_id = c.id)
  ->  Parallel Seq Scan on orders o  (actual rows=166667 loops=3)
  ->  Hash  (actual rows=50000 loops=3)
        Buckets: 65536  Batches: 1  Memory Usage: 2856kB
        ->  Seq Scan on customers c  (actual rows=50000 loops=3)
```

If `Batches` is greater than 1, the hash table didn't fit in memory (`work_mem` × `hash_mem_multiplier`) and spilled to disk.

Merge Join: every order with its items, `ORDER BY o.id`. Both primary-key indexes already return rows sorted by order id, so no sort is needed.

```text
Merge Join  (actual time=0.029..686.153 rows=999900 loops=1)
  Merge Cond: (o.id = oi.order_id)
  ->  Index Only Scan using orders_pkey on orders o
  ->  Index Only Scan using order_items_pkey on order_items oi
```

For more on join semantics, see [PostgreSQL joins](/lessons/postgres-joins).

## 7. Sort, aggregate and limit

**Sort** uses memory up to `work_mem` (default 4 MB). Beyond that it spills to temporary files:

```text
Sort  (actual time=866.682..1564.339 rows=500000 loops=1)
  Sort Key: total DESC
  Sort Method: external merge  Disk: 28376kB
  Buffers: shared hit=3538 read=1137, temp read=3547 written=3557
```

- `quicksort  Memory: …` = fit in memory.
- `external merge  Disk: …` = spilled. `temp read/written` in `BUFFERS` confirms it.
- `top-N heapsort` = a `LIMIT` lets PostgreSQL keep only the best N rows.

**Aggregates**: `Aggregate` (one result, e.g. `count(*)`), `HashAggregate` (groups in a hash table; watch `Batches`), `GroupAggregate` (groups already-sorted input). Parallel plans show `Partial` and `Finalize` steps.

**Limit** stops pulling rows from its child once it has enough. That's why `ORDER BY created_at DESC LIMIT 5` with a matching index is so cheap: the Index Scan produces rows already sorted and stops after 5.

## 8. The biggest clue: estimated vs actual rows

The planner chooses algorithms based on **estimated** row counts. If the estimate is wrong by 100×, the chosen algorithm is often wrong too.

Real case: a `coupons` table was analyzed when it had 1,000 unused coupons. Then 199,000 used coupons were bulk-loaded and autovacuum (disabled on this table for the demo) never re-analyzed it.

```sql
SELECT c.code, o.id FROM coupons c JOIN orders o ON o.id = c.id WHERE c.used;
```

Before (stale statistics):

```text
Nested Loop  (cost=0.42..3145.77 rows=1) (actual rows=199000 loops=1)
  ->  Seq Scan on coupons c  (rows=1) (actual rows=199000 loops=1)
        Filter: used
  ->  Index Only Scan using orders_pkey on orders o
        (actual time=0.001..0.001 rows=1 loops=199000)
Execution Time: 284.403 ms
```

The planner expected **1** used coupon, so "one index lookup per coupon" looked perfect. It actually did **199,000** lookups. After `ANALYZE coupons;`:

```text
Merge Join  (rows=199087) (actual rows=199000 loops=1)
  Merge Cond: (c.id = o.id)
  ->  Index Scan using coupons_pkey on coupons c
  ->  Index Only Scan using orders_pkey on orders o
Execution Time: 77.415 ms
```

Same query, same indexes, **3.7× faster**, just from fresh statistics.

Causes of bad estimates and fixes:

- **Stale statistics** after bulk loads → `ANALYZE table;` (autovacuum normally does it, but bulk loads outrun it).
- **Correlated columns** (`city = 'Pune' AND pincode = '411001'`) → the planner multiplies selectivities as if independent → `CREATE STATISTICS ... (dependencies) ON city, pincode FROM addresses;`
- **Skewed columns** with many values → raise the sample: `ALTER TABLE orders ALTER COLUMN status SET STATISTICS 1000;` then `ANALYZE`.
- **Functions or JSON expressions** in `WHERE` → no statistics at all, a default guess is used; an expression index gives them statistics.

> **Remember:** when estimated and actual rows differ by an order of magnitude, suspect statistics before you suspect PostgreSQL.

## 9. Three more case files (before → after)

**Case 1: customer order history.** `WHERE customer_id = 4242 ORDER BY created_at DESC`, no index:

```text
Gather Merge  (actual time=68.988..76.318 rows=10 loops=1)
  ->  Sort  (Sort Method: quicksort  Memory: 25kB)
        ->  Parallel Seq Scan on orders (actual rows=3 loops=3)
              Filter: (customer_id = 4242)
              Rows Removed by Filter: 166663
              Buffers: shared hit=259 read=4413
Execution Time: 76.794 ms
```

Fix: `CREATE INDEX ON orders (customer_id, created_at DESC);`. The same query now uses a Bitmap Index Scan on it: **1.1 ms**, 16 pages instead of 4,786. Add the `LIMIT 5` the page really needs and it becomes the Index Scan from section 4: **0.118 ms**, 11 pages.

**Case 2: the missing foreign key index.** PostgreSQL does **not** index foreign key columns automatically. "Which orders contain product 42?":

```text
Before: Parallel Seq Scan on order_items
          Rows Removed by Filter: 333267   (loops=3)
          Execution Time: 81.132 ms
After:  Bitmap Index Scan on order_items_product_idx
          Execution Time: 2.129 ms
```

**Case 3: a sort that spills.** Sorting all 500,000 orders by `total` spilled 28 MB to disk (1,659 ms). Raising `work_mem` to 64 MB for that session switched it to an in-memory quicksort (1,006 ms). But the real fix was asking for what the page needs: `LIMIT 10` turned it into a `top-N heapsort` using 26 kB (**163 ms**), and an index on `total` would make it near-instant.

⚠️ Don't raise `work_mem` globally to fix one query: it applies **per sort/hash node, per connection**. Set it for the session or the role that runs the report.

## 10. Finding the guilty queries: pg_stat_statements

`EXPLAIN` explains **one** query. First you need to know **which** query to look at. The `pg_stat_statements` extension aggregates statistics for every normalized query (`WHERE id = $1`).

```sql
-- postgresql.conf: shared_preload_libraries = 'pg_stat_statements' (restart needed)
CREATE EXTENSION pg_stat_statements;

SELECT left(query, 60)                    AS query,
       calls,
       round(total_exec_time)             AS total_ms,
       round(mean_exec_time::numeric, 2)  AS mean_ms,
       rows,
       shared_blks_read
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

Sort by **`total_exec_time`**, not mean: a 2 ms query called 5 million times a day hurts more than a 3-second report run once. Pair it with the `auto_explain` module, which logs the plans of queries slower than a threshold, so you can see the plan that ran in production with production data.

> **Remember:** find the worst queries by **total** time with `pg_stat_statements`, then explain them one by one.

## 11. The slow-query checklist

| Look for | It usually means | Try |
|---|---|---|
| Seq Scan with huge `Rows Removed by Filter` | Missing or unusable index | Add an index matching the `WHERE` (and `ORDER BY`) |
| Estimated rows ≪ or ≫ actual | Stale or missing statistics | `ANALYZE`, extended statistics, higher statistics target |
| Nested Loop with a huge `loops` count | Underestimated outer side | Fix the estimate; the planner will switch to hash/merge |
| `external merge  Disk:` / `Batches: > 1` | `work_mem` too small for this query | Reduce rows first; then raise `work_mem` per session |
| `Heap Fetches` high on Index Only Scan | Visibility map not up to date | `VACUUM` the table; check autovacuum |
| High `shared read`, low `hit` | Cold cache or data larger than RAM | Fewer pages: narrower index, covering index, less data |
| Function on a column: `WHERE lower(email) = …` | Plain index can't be used | Expression index on `lower(email)` |
| Fast in `psql`, slow from the app | Different parameters or a generic plan | `EXPLAIN` with the app's real values |

## 12. Gotchas

- **Running `EXPLAIN ANALYZE` on writes in production** without `BEGIN … ROLLBACK`. It really writes.
- **Trusting `cost` as milliseconds.** It's an abstract unit for comparing plans of the same query, not a time.
- **Ignoring `loops`.** A node that looks like 0.1 ms can be your entire runtime.
- **Testing on a tiny dev database.** With 100 rows the planner picks a Seq Scan for everything. Plans depend on data size and statistics; test with realistic volume.
- **Measuring once.** The first run reads from disk (`read=`), the second from cache (`hit=`). Compare like with like.
- **Timing overhead.** `EXPLAIN ANALYZE` measures every node, which adds overhead on very fast nodes run millions of times. Use `(ANALYZE, TIMING OFF)` if you only need row counts.
- **Forcing plans.** `SET enable_seqscan = off` is fine for an experiment, never for production code. Fix the cause (index, statistics, query) instead.

## 13. Don't confuse: PostgreSQL vs MongoDB explain

You already know MongoDB's `explain()`. The ideas map almost one to one:

| PostgreSQL | MongoDB |
|---|---|
| `EXPLAIN` | `explain("queryPlanner")` |
| `EXPLAIN ANALYZE` | `explain("executionStats")` |
| Seq Scan | `COLLSCAN` |
| Index Scan | `IXSCAN` + `FETCH` |
| Index Only Scan | Covered query (`IXSCAN` with no `FETCH`) |
| `Rows Removed by Filter` | `totalDocsExamined` ≫ `nReturned` |
| Statistics + cost model | Plan candidates raced against each other, winner cached |

The big difference: PostgreSQL chooses by **estimated cost from statistics**, MongoDB by **trial runs** of candidate plans.

## 14. Trade-offs and limits

- **EXPLAIN shows one execution.** Production has many parameter values; one customer with 50,000 orders may need a different plan than one with 5.
- **Prepared statements** may switch to a **generic plan** after several executions, which ignores the specific values. If a parameterized query is slow only from the app, compare with `plan_cache_mode`.
- **Every index you add to fix a read slows writes** and uses disk. Fix the top queries from `pg_stat_statements`, not every query you see.
- **Sometimes the plan is fine and the query is wrong**: fetching 500,000 rows to show 20 on a page is a product problem, not a planner problem.
