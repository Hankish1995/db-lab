---
slug: postgres-ctes-and-window-functions
title: 'CTEs and window functions: analytics without losing your rows'
module: Querying
order: 30
summary: How to go from GROUP BY to subqueries, CTEs (including when PostgreSQL materializes them and how recursive CTEs walk trees) and window functions for rankings, month-over-month growth, running totals, moving averages and top-N per group.
level: intermediate
tags: [postgresql, sql, cte, recursive-cte, window-functions, group-by, analytics, ranking]
recap: >-
  GROUP BY collapses rows into one per group; FILTER adds conditional aggregates. CTEs name intermediate steps, and since
  PostgreSQL 12 a non-recursive CTE referenced once is inlined unless you write MATERIALIZED. Recursive CTEs walk trees
  like category hierarchies, with a guard against cycles. Window functions compute across related rows without collapsing
  them: ROW_NUMBER, RANK and DENSE_RANK for rankings, LAG and LEAD for comparisons, SUM OVER for running totals and
  frames for moving averages. For top-N per group, use ROW_NUMBER or a LATERAL subquery.
---

## 1. The story

Picture the final results of a school sports day.

- The **principal's summary** says: "Red House: 340 points, Blue House: 310." Each house is squashed into one line. That's **GROUP BY**.
- The **results board** lists every student, and next to each name shows "rank in house: 3rd", "points behind the student above: 4", "house total so far: 120". Every student keeps their own line, but each line also knows about its neighbours. That's a **window function**.
- The **clipboard notes** the organiser writes first ("step 1: drop disqualified runs, step 2: convert times to points"), then uses in the final board, are **CTEs**.

| Sports day | SQL |
|---|---|
| One line per house | `GROUP BY` |
| Each student's line + house context | Window function with `OVER (PARTITION BY house)` |
| "Rank among their house" | `RANK() OVER (PARTITION BY house ORDER BY points DESC)` |
| Named prep steps on a clipboard | CTE: `WITH step1 AS (...)` |
| House → team → sub-team chart | Recursive CTE |

> **Remember:** GROUP BY **collapses** rows into groups. A window function **keeps every row** and adds a value computed over related rows.

## 2. Why this matters

Without these tools, analytics in a MERN app usually means: fetch thousands of rows into Node.js, loop, sort, compute ranks and deltas in JavaScript. That's slow, memory-hungry and easy to get wrong.

With them, "revenue per month with growth %", "best-selling product per category" or "each customer's 3 latest orders" are single queries that run next to the data. They're also among the most common SQL interview questions.

All examples run on a scratch e-commerce database: `users`, `orders` (500,000 rows), `order_items`, `products` and `categories`.

## 3. GROUP BY, HAVING and FILTER

A quick refresher. `WHERE` filters rows **before** grouping, `HAVING` filters groups **after**.

```sql
SELECT date_trunc('month', created_at)::date AS month,
       count(*)                                       AS orders,
       count(*)   FILTER (WHERE status = 'cancelled') AS cancelled,
       sum(total) FILTER (WHERE status <> 'cancelled') AS revenue
FROM orders
WHERE created_at >= '2024-01-01' AND created_at < '2024-04-01'
GROUP BY 1
HAVING count(*) > 1000
ORDER BY 1;
```

Example output:

```text
   month    │ orders │ cancelled │   revenue
────────────┼────────┼───────────┼─────────────
 2024-01-01 │  31885 │      1625 │ 75606253.98
 2024-02-01 │  29829 │      1523 │ 70742601.12
 2024-03-01 │  31885 │      1629 │ 75459139.62
```

The **FILTER** clause gives several conditional aggregates in **one pass** over the table. It's the clean version of `sum(CASE WHEN ... THEN total END)`.

## 4. Subqueries

Three kinds you'll meet constantly:

```sql
-- Scalar subquery: returns exactly one value
SELECT id, total,
       total - (SELECT avg(total) FROM orders) AS diff_from_avg
FROM orders;

-- IN subquery: a set of values
SELECT * FROM products
WHERE id IN (SELECT product_id FROM order_items WHERE quantity >= 4);

-- Correlated subquery: references the outer row, runs per row
SELECT u.id, u.email,
       (SELECT max(o.created_at) FROM orders o WHERE o.user_id = u.id) AS last_order_at
FROM users u;
```

A correlated subquery is fine when it's an index lookup per row (here, with an index on `orders (user_id, created_at)`). On large outer tables without an index, it means one scan per outer row. For "has any / has none" checks, prefer `EXISTS` / `NOT EXISTS` (see [Joins](/lessons/postgres-joins)).

## 5. CTEs: naming your steps

A **CTE** (Common Table Expression) is a named subquery defined with `WITH`, readable top to bottom like a pipeline:

```sql
WITH delivered AS (
  SELECT user_id, total
  FROM orders
  WHERE status = 'delivered'
),
per_user AS (
  SELECT user_id, sum(total) AS lifetime_value, count(*) AS orders
  FROM delivered
  GROUP BY user_id
)
SELECT u.email, p.lifetime_value, p.orders
FROM per_user p
JOIN users u ON u.id = p.user_id
ORDER BY p.lifetime_value DESC
LIMIT 10;
```

If you know MongoDB's aggregation pipeline, each CTE is like a stage with a name.

### Are CTEs materialized? It depends

Old advice says "CTEs are an optimization fence". That was true **before PostgreSQL 12**. Now:

- A **non-recursive**, side-effect-free CTE referenced **once** is **inlined** into the main query, so the planner can push filters into it.
- A CTE referenced **more than once** is, by default, **materialized**: computed once and stored as a temporary result.
- You can override either way with `AS MATERIALIZED` or `AS NOT MATERIALIZED`.

Real plans from the scratch database:

```sql
WITH big_orders AS (SELECT * FROM orders WHERE total > 500)
SELECT * FROM big_orders WHERE id = 4242;
```

```text
Index Scan using orders_pkey on orders   -- inlined
  Index Cond: (id = 4242)
  Filter: (total > '500'::numeric)
```

```sql
WITH big_orders AS MATERIALIZED (SELECT * FROM orders WHERE total > 500)
SELECT * FROM big_orders WHERE id = 4242;
```

```text
CTE Scan on big_orders                   -- materialized
  Filter: (id = 4242)
  CTE big_orders
    ->  Seq Scan on orders
          Filter: (total > '500'::numeric)
```

The materialized version scans the whole table to build the CTE, then searches it. Use `MATERIALIZED` deliberately: when an expensive CTE is used several times, or to stop the planner from inlining something it estimates badly.

> **Remember:** since PostgreSQL 12, a CTE used once is inlined, so it's free readability. Used twice, it's computed once and stored, unless you say `NOT MATERIALIZED`.

## 6. Recursive CTEs: walking a category tree

`categories` has a `parent_id` pointing to itself:

```text
 Electronics (1)
 ├── Computers (2)
 │   ├── Laptops (3)
 │   └── Accessories (4)
 └── Phones (5)
 Home (6)
 └── Kitchen (7)
```

A **recursive CTE** has two parts joined by `UNION ALL`: an **anchor** (the starting rows) and a **recursive term** that references the CTE itself. PostgreSQL repeats the recursive term on the newest rows until it produces nothing.

```sql
WITH RECURSIVE tree AS (
  -- anchor: top-level categories
  SELECT id, name, 1 AS depth, name AS path
  FROM categories
  WHERE parent_id IS NULL
  UNION ALL
  -- recursive term: children of the rows found so far
  SELECT c.id, c.name, t.depth + 1, t.path || ' > ' || c.name
  FROM categories c
  JOIN tree t ON c.parent_id = t.id
)
SELECT id, depth, path FROM tree ORDER BY path;
```

```text
 id │ depth │ path
────┼───────┼───────────────────────────────────────
  1 │     1 │ Electronics
  2 │     2 │ Electronics > Computers
  4 │     3 │ Electronics > Computers > Accessories
  3 │     3 │ Electronics > Computers > Laptops
  5 │     2 │ Electronics > Phones
  6 │     1 │ Home
  7 │     2 │ Home > Kitchen
```

The classic use: "all products under Computers, including subcategories" = start the anchor at `name = 'Computers'` and join `products` on the resulting ids.

### Cycle safety

If bad data makes Electronics a child of Laptops, the recursion loops forever. Guards:

- Use `UNION` instead of `UNION ALL` when whole rows repeat (it discards duplicates, which stops simple loops).
- Track the visited path and stop when an id reappears, or add a depth limit (`WHERE t.depth < 20`).
- Since PostgreSQL 14, the built-in `CYCLE` clause does it for you:

```sql
WITH RECURSIVE tree AS (
  SELECT id, name, parent_id FROM categories WHERE id = 1
  UNION ALL
  SELECT c.id, c.name, c.parent_id
  FROM categories c JOIN tree t ON c.parent_id = t.id
) CYCLE id SET is_cycle USING path
SELECT id, name, is_cycle FROM tree;
```

With a cycle in the data, I got Electronics → Computers → Laptops → Electronics (`is_cycle = true`) and the query stopped.

## 7. Window functions: the basics

A **window function** computes a value over a set of rows related to the current row (its **window**) and attaches it to that row. The `OVER` clause defines the window:

```text
 function() OVER (
   PARTITION BY ...   ← groups, like GROUP BY but not collapsed
   ORDER BY ...       ← order inside each group
   ROWS BETWEEN ...   ← optional frame: which neighbours count
 )
```

```sql
-- each order of user 42, with the user's first order id and % of their spend
SELECT id, total,
       FIRST_VALUE(id) OVER (PARTITION BY user_id ORDER BY created_at) AS first_order_id,
       round(100.0 * total / sum(total) OVER (PARTITION BY user_id), 1) AS pct_of_spend
FROM orders
WHERE user_id = 42;
```

Every order row is still there; each one also knows about its siblings. Window functions run **after** `WHERE`, `GROUP BY` and `HAVING`, so you can't filter on them in the same `WHERE`. Wrap the query in a subquery or CTE and filter outside.

## 8. Ranking: ROW_NUMBER vs RANK vs DENSE_RANK

Units sold per product, with a tie at the top and in the middle:

```sql
SELECT product, units_sold,
       ROW_NUMBER() OVER (ORDER BY units_sold DESC) AS row_number,
       RANK()       OVER (ORDER BY units_sold DESC) AS rank,
       DENSE_RANK() OVER (ORDER BY units_sold DESC) AS dense_rank,
       NTILE(3)     OVER (ORDER BY units_sold DESC) AS ntile_3
FROM product_sales;
```

| product | units_sold | ROW_NUMBER | RANK | DENSE_RANK | NTILE(3) |
|---|---|---|---|---|---|
| Keyboard | 120 | 1 | 1 | 1 | 1 |
| Mouse | 120 | 2 | 1 | 1 | 1 |
| Monitor | 90 | 3 | 3 | 2 | 2 |
| Webcam | 75 | 4 | 4 | 3 | 2 |
| Cable | 75 | 5 | 4 | 3 | 3 |
| Stand | 40 | 6 | 6 | 4 | 3 |

- **ROW_NUMBER**: always unique, 1, 2, 3… Ties get an **arbitrary** order unless you add a tie-breaker (`ORDER BY units_sold DESC, product_id`).
- **RANK**: ties share a rank, then **gaps** (1, 1, 3). Like Olympic medals.
- **DENSE_RANK**: ties share a rank, **no gaps** (1, 1, 2).
- **NTILE(n)**: splits rows into n roughly equal buckets (top third, middle, bottom), useful for customer segmentation.

> **Remember:** ROW_NUMBER = unique positions, RANK = ties then gaps, DENSE_RANK = ties without gaps. Add a tie-breaker if you need deterministic results.

## 9. LAG, LEAD and running totals

Month-over-month revenue growth plus a running total, in one query:

```sql
WITH monthly AS (
  SELECT date_trunc('month', created_at)::date AS month,
         sum(total) AS revenue
  FROM orders
  WHERE status <> 'cancelled'
  GROUP BY 1
)
SELECT month, revenue,
       LAG(revenue) OVER w AS prev_month,
       round(100.0 * (revenue - LAG(revenue) OVER w) / LAG(revenue) OVER w, 1) AS growth_pct,
       SUM(revenue) OVER w AS running_total
FROM monthly
WINDOW w AS (ORDER BY month)
ORDER BY month;
```

Example output (first four months):

```text
   month    │   revenue   │ prev_month  │ growth_pct │ running_total
────────────┼─────────────┼─────────────┼────────────┼───────────────
 2024-01-01 │ 75606253.98 │        NULL │       NULL │   75606253.98
 2024-02-01 │ 70742601.12 │ 75606253.98 │       -6.4 │  146348855.10
 2024-03-01 │ 75459139.62 │ 70742601.12 │        6.7 │  221807994.72
 2024-04-01 │ 73170219.90 │ 75459139.62 │       -3.0 │  294978214.62
```

- **LAG(x)** reads the previous row's value; **LEAD(x)** reads the next. Both take an offset and a default: `LAG(revenue, 1, 0)`.
- **SUM() OVER (ORDER BY ...)** gives a running total.
- The **WINDOW** clause names a window once so you don't repeat it.

Note the pattern: aggregate in a CTE first (one row per month), then apply window functions. Window functions also work directly on aggregates in the same query: `SUM(sum(total)) OVER (ORDER BY ...)`.

## 10. Frames: moving averages, and ROWS vs RANGE

A **frame** limits the window to nearby rows. A 7-day moving average of daily revenue:

```sql
WITH daily AS (
  SELECT created_at::date AS day, sum(total) AS revenue
  FROM orders
  WHERE status <> 'cancelled'
  GROUP BY 1
)
SELECT day, revenue,
       avg(revenue) OVER (
         ORDER BY day
         ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
       ) AS avg_7d
FROM daily;
```

The first six days average over fewer rows (there's nothing before them). If some days have no orders, "6 preceding rows" isn't "6 preceding days"; generate a full calendar with `generate_series` and `LEFT JOIN` it, or use a `RANGE` frame with an interval (`RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW`).

### ROWS vs RANGE

When you write `ORDER BY` in `OVER` without a frame, the default frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. **RANGE** treats rows with equal sort values (**peers**) as one step; **ROWS** counts physical rows:

```text
  x  │ sum OVER (ORDER BY x)  │ ... ROWS UNBOUNDED PRECEDING
 ────┼────────────────────────┼──────────────────────────────
  10 │                     10 │                           10
  20 │                     50 │                           30
  20 │                     50 │                           50
  30 │                     80 │                           80
```

With ties, the default running total jumps by both 20s at once. If you want strictly row-by-row, write `ROWS`.

A related trap: `LAST_VALUE(x) OVER (ORDER BY ...)` returns the **current** row's value with the default frame, because the frame ends at the current row. Use `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`, or `FIRST_VALUE` with the opposite order.

> **Remember:** with ORDER BY and no frame, the window is "start up to the current row and its ties". Spell out `ROWS BETWEEN ...` when the exact frame matters.

## 11. Top-N per group: two good answers

"The 3 latest orders of every user." The window function way:

```sql
SELECT *
FROM (
  SELECT o.*,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
  FROM orders o
) ranked
WHERE rn <= 3;
```

The LATERAL way:

```sql
SELECT u.id, o.*
FROM users u
CROSS JOIN LATERAL (
  SELECT id, total, created_at
  FROM orders
  WHERE orders.user_id = u.id
  ORDER BY created_at DESC
  LIMIT 3
) o;
```

Which is faster depends on the shape of the data, with an index on `orders (user_id, created_at DESC)`:

| | ROW_NUMBER | LATERAL + LIMIT |
|---|---|---|
| How it works | Reads **all** matching orders, numbers them, keeps rn ≤ 3 | Per user, an index scan that stops after 3 rows |
| Scratch DB, all 50k users (500k orders, warm cache) | ~620 ms, reads all 500k orders | ~240 ms, reads ~150k |
| Scratch DB, 100 users | ~11 ms | ~6 ms |
| Best for | No matching index, ties/complex ranking, or N close to the group size | Many rows per group, index on (group, sort) |

The more rows each group has compared to N, the bigger LATERAL's advantage. Without the index, LATERAL degrades badly (one scan per user), while the window version just sorts.

PostgreSQL 15+ helps the window version: it shows `Run Condition: (row_number() OVER (?) <= 3)` in the plan and stops computing row numbers per partition once the limit is passed.

## 12. Common mistakes and gotchas

- **Filtering on a window function in `WHERE`.** Not allowed; wrap it in a subquery or CTE.
- **ROW_NUMBER without a tie-breaker** gives different winners on each run when values tie.
- **Default frame surprises** with `LAST_VALUE` and running totals over tied values.
- **Assuming CTEs are always materialized** (pre-12 advice) or never materialized. Check the plan.
- **Recursive CTE without a cycle guard** on user-editable hierarchies.
- **Dividing by `LAG()`** when the previous value is 0 or NULL. Use `NULLIF(LAG(x) OVER w, 0)`.
- **Integer division:** `count_a / count_b` on integers truncates. Multiply by `100.0` first.

## 13. Window functions vs GROUP BY

| | GROUP BY | Window function |
|---|---|---|
| Output rows | One per group | One per input row |
| Access to row details | Only grouped columns and aggregates | Every column, plus the computed value |
| Typical question | "Revenue per month" | "Each month's revenue and its growth vs last month" |
| Ranking, previous/next row | ❌ | ✅ |
| Runs | Before `HAVING` | After `GROUP BY`/`HAVING`, before `ORDER BY`/`LIMIT` |
| Combine? | ✅ Aggregate first, then window over the groups | |

## 14. Trade-offs: when not to use them

- **Huge window sorts.** `PARTITION BY user_id ORDER BY created_at` over 500k rows needed a 22 MB on-disk sort in my test without an index. An index matching the partition and order removes the sort.
- **Dashboards over large history** recomputed on every page load: precompute into a summary table or materialized view.
- **Deep recursive queries** on very large graphs: PostgreSQL can do it, but a dedicated model (closure table, `ltree`, or a graph database) may fit better.
- **Readability over cleverness.** Three named CTEs beat one nested query nobody can review.

> **Remember:** GROUP BY answers "how much per group". Window functions answer "how does this row compare to its group". CTEs make both readable.
