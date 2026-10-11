---
slug: postgres-joins
title: 'Joins: stapling receipts to customer cards'
module: Querying
order: 20
summary: How every PostgreSQL join type works on a small e-commerce dataset, why a WHERE filter can silently turn a LEFT JOIN into an inner join, how to write semi- and anti-joins safely (and why NOT IN with NULLs returns nothing), how join fan-out inflates SUM, and when to reach for LATERAL.
level: beginner
tags: [postgresql, sql, joins, left-join, exists, anti-join, lateral, fan-out]
recap: >-
  A join combines rows from two tables that match a condition. INNER keeps only matches, LEFT keeps every left row,
  RIGHT and FULL keep unmatched rows from the other or both sides, CROSS pairs everything, and a self join links a
  table to itself. Filters on the right table of a LEFT JOIN belong in ON, not WHERE. Use EXISTS and NOT EXISTS for
  "has any" and "has none", never NOT IN on a nullable column. Aggregate child tables before joining to avoid fan-out,
  and use LATERAL for top-N per row.
---

## 1. The story

You run a small shop with two piles of paper on your desk:

- A box of **customer cards**, one per customer.
- A stack of **receipts**, each with a customer number written on it.

Your manager asks: "Which customer bought what?" You take each receipt and **staple it to the matching customer card**. That's a join.

But the details matter:

- Do you keep customer cards that got **no receipt**? (Meera never ordered.)
- Do you keep receipts with **no customer**? (A guest checkout.)
- If Asha has three receipts, she appears **three times** in your result.

| Desk | SQL |
|---|---|
| Customer cards | `users` table (left side) |
| Receipts | `orders` table (right side) |
| "Customer number on the receipt matches the card" | The **join condition** (`ON o.user_id = u.id`) |
| Stapled pairs | Rows of the result |
| Keeping cards without receipts | **LEFT JOIN** |
| Keeping only cards with receipts | **INNER JOIN** |

> **Remember:** a join produces **one output row per matching pair**. One customer with three orders becomes three rows.

## 2. Why joins exist

In a relational database you **normalize**: users, orders, products and order items live in separate tables, each fact stored once (see [Normalization](/lessons/normalization)). Joins put them back together at query time.

Coming from MongoDB, think of a join as a `$lookup`, except it's the **normal, everyday, well-optimized** way to query, not an exception. PostgreSQL's planner is built around choosing the fastest way to join.

## 3. The sample data

Every example below uses this tiny dataset (from a real scratch database):

```text
users                           orders
 id │ name  │ referred_by        id  │ user_id │ status    │ total
────┼───────┼────────────       ─────┼─────────┼───────────┼───────
  1 │ Asha  │ NULL               101 │       1 │ delivered │  1200
  2 │ Ravi  │ 1                  102 │       1 │ cancelled │   300
  3 │ Meera │ 1                  103 │       2 │ delivered │   450
  4 │ Kabir │ 2                  104 │       1 │ delivered │    80
                                 105 │    NULL │ pending   │    99

products                        order_items
 id │ name     │ price           order_id │ product_id │ qty
────┼──────────┼───────         ──────────┼────────────┼─────
  1 │ Keyboard │ 50                   101 │          1 │   2
  2 │ Mouse    │ 20                   101 │          3 │   1
  3 │ Monitor  │ 300                  101 │          2 │   1
                                      103 │          2 │   1
                                      104 │          2 │   4
```

Meera and Kabir have no orders. Order 105 is a guest checkout with no user.

## 4. The join types

| Join | Matched pairs | Unmatched left rows | Unmatched right rows |
|---|---|---|---|
| `INNER JOIN` | ✅ | ❌ | ❌ |
| `LEFT JOIN` | ✅ | ✅ (NULL-padded) | ❌ |
| `RIGHT JOIN` | ✅ | ❌ | ✅ (NULL-padded) |
| `FULL JOIN` | ✅ | ✅ | ✅ |
| `CROSS JOIN` | Every left row × every right row, no condition | | |

### INNER JOIN: only matching pairs

```sql
SELECT u.name, o.id AS order_id, o.total
FROM users u
JOIN orders o ON o.user_id = u.id;   -- JOIN = INNER JOIN
```

```text
 name │ order_id │ total
──────┼──────────┼───────
 Asha │      101 │  1200
 Asha │      102 │   300
 Ravi │      103 │   450
 Asha │      104 │    80
```

Meera, Kabir and guest order 105 disappear: they have no partner.

### LEFT JOIN: every left row, matched or not

```sql
SELECT u.name, o.id AS order_id, o.total
FROM users u
LEFT JOIN orders o ON o.user_id = u.id;
```

```text
 name  │ order_id │ total
───────┼──────────┼───────
 Asha  │      101 │  1200
 Asha  │      102 │   300
 Asha  │      104 │    80
 Ravi  │      103 │   450
 Meera │     NULL │  NULL
 Kabir │     NULL │  NULL
```

Unmatched users get **NULLs** for every `orders` column. This is the join for "all customers, with their orders if any".

### RIGHT JOIN: every right row

```sql
SELECT u.name, o.id AS order_id, o.total
FROM users u
RIGHT JOIN orders o ON o.user_id = u.id;
```

```text
 name │ order_id │ total
──────┼──────────┼───────
 Asha │      101 │  1200
 Asha │      102 │   300
 Ravi │      103 │   450
 Asha │      104 │    80
 NULL │      105 │    99
```

A `RIGHT JOIN` is just a `LEFT JOIN` with the tables swapped. Most teams always write `LEFT JOIN` for readability.

### FULL OUTER JOIN: everything from both sides

```sql
SELECT u.name, o.id AS order_id
FROM users u
FULL JOIN orders o ON o.user_id = u.id;
```

```text
 name  │ order_id
───────┼──────────
 Asha  │      101
 Asha  │      102
 Asha  │      104
 Ravi  │      103
 Meera │     NULL
 Kabir │     NULL
 NULL  │      105
```

Useful for **reconciliation**: "compare payments from Stripe with our orders and show what's missing on either side".

### CROSS JOIN: every combination

```sql
SELECT u.name, p.name AS product
FROM users u
CROSS JOIN products p
WHERE u.id <= 2;
```

```text
 name │ product
──────┼──────────
 Asha │ Keyboard
 Asha │ Mouse
 Asha │ Monitor
 Ravi │ Keyboard
 Ravi │ Mouse
 Ravi │ Monitor
```

No condition: 2 users × 3 products = 6 rows. Handy for generating grids (every product × every day for a report), dangerous by accident: two 100,000-row tables give 10 billion rows.

### SELF JOIN: a table joined to itself

`users.referred_by` points to another user. Join `users` to itself with two aliases:

```sql
SELECT u.name AS customer, r.name AS referred_by
FROM users u
LEFT JOIN users r ON r.id = u.referred_by;
```

```text
 customer │ referred_by
──────────┼─────────────
 Asha     │ NULL
 Ravi     │ Asha
 Meera    │ Asha
 Kabir    │ Ravi
```

> **Remember:** INNER = matches only. LEFT = all of the left side, NULLs where nothing matched. FULL = all of both. CROSS = every pair.

## 5. The classic trap: WHERE turns a LEFT JOIN into an INNER JOIN

Goal: "every customer, with their **delivered** orders (if any)".

```sql
-- ❌ looks right, isn't
SELECT u.name, o.id AS order_id, o.status
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.status = 'delivered';
```

```text
 name │ order_id │ status
──────┼──────────┼───────────
 Asha │      101 │ delivered
 Asha │      104 │ delivered
 Ravi │      103 │ delivered
```

Meera and Kabir vanished. Why? The `LEFT JOIN` produced their rows with `o.status = NULL`, then `WHERE` ran **after** the join, and `NULL = 'delivered'` is not true, so those rows were filtered out. You wrote an inner join with extra steps.

Fix: put conditions on the **right table** in the `ON` clause, so they decide *what matches*, not *what survives*:

```sql
-- ✅
SELECT u.name, o.id AS order_id, o.status
FROM users u
LEFT JOIN orders o
  ON o.user_id = u.id
 AND o.status = 'delivered';
```

```text
 name  │ order_id │ status
───────┼──────────┼───────────
 Asha  │      101 │ delivered
 Asha  │      104 │ delivered
 Ravi  │      103 │ delivered
 Meera │     NULL │ NULL
 Kabir │     NULL │ NULL
```

Rule of thumb for a LEFT JOIN:

- Condition on the **left** table (`u.is_active`) → `WHERE`.
- Condition on the **right** table (`o.status`) → `ON`.

A related counting bug: with a LEFT JOIN, `count(*)` counts the NULL-padded row too, so Meera shows **1** order. Count a column from the right table instead: `count(o.id)` ignores NULLs and gives 0.

> **Remember:** in a LEFT JOIN, filters on the right table go in `ON`. In `WHERE` they silently drop the unmatched rows.

## 6. Semi-joins and anti-joins: "has any" and "has none"

Often you don't want the orders, just the users **that have** (or **don't have**) any.

### Semi-join: EXISTS

```sql
-- users who have placed at least one order
SELECT u.name
FROM users u
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);
-- Asha, Ravi
```

Why not `JOIN orders`? Because Asha has three orders, a plain join returns her **three times**, and you'd need `DISTINCT` to undo it. `EXISTS` stops at the first match and returns each user once. `WHERE u.id IN (SELECT user_id FROM orders)` is also fine here; PostgreSQL can plan both as a semi-join.

### Anti-join: three ways to say "never ordered"

```sql
-- ✅ 1. NOT EXISTS (preferred)
SELECT u.name FROM users u
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);
-- Meera, Kabir

-- ✅ 2. LEFT JOIN ... IS NULL
SELECT u.name FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.user_id IS NULL;
-- Meera, Kabir

-- ❌ 3. NOT IN
SELECT u.name FROM users u
WHERE u.id NOT IN (SELECT user_id FROM orders);
-- (0 rows)
```

### The NOT IN + NULL trap

Version 3 returns **nothing**, because guest order 105 has `user_id = NULL`. For Meera, `NOT IN (1, 1, 2, 1, NULL)` means:

```text
 3 <> 1 AND 3 <> 1 AND 3 <> 2 AND 3 <> 1 AND 3 <> NULL
 true       true       true       true       NULL (unknown)
 └────────────────────── AND ────────────────────────┘
                    = NULL  →  row not returned
```

SQL can't say "3 is not in the list" when the list contains an unknown value. A single NULL in the subquery makes `NOT IN` return zero rows. It also tends to plan badly: PostgreSQL can't turn `NOT IN` into an anti-join, so on our 500,000-order test table it fell back to a subplan, while `NOT EXISTS` became a `Hash Anti Join`.

> **Remember:** "has none" = `NOT EXISTS`. Never use `NOT IN (subquery)` on a column that can be NULL.

## 7. Join fan-out: when SUM lies

Report: "revenue and units sold per customer, delivered orders only".

```sql
-- ❌ joins orders → order_items, then sums the order total
SELECT u.name, sum(o.total) AS revenue, sum(oi.qty) AS units
FROM users u
JOIN orders o ON o.user_id = u.id
LEFT JOIN order_items oi ON oi.order_id = o.id
WHERE o.status = 'delivered'
GROUP BY u.id, u.name;
```

```text
 name │ revenue │ units
──────┼─────────┼───────
 Asha │    3680 │     8
 Ravi │     450 │     1
```

Asha really spent 1200 + 80 = **1280**. Order 101 has **three** items, so the join turned it into three rows, and its 1200 total was summed three times. This is **fan-out**: joining a one-to-many relationship multiplies the "one" side.

```text
 order 101 (total 1200) ──┬── item Keyboard ──► 1200
                          ├── item Monitor  ──► 1200   SUM = 3600 ❌
                          └── item Mouse    ──► 1200
```

Fix: **aggregate the child table first**, so it's one row per order, then join:

```sql
-- ✅
SELECT u.name, sum(o.total) AS revenue, sum(i.units) AS units
FROM users u
JOIN orders o ON o.user_id = u.id
LEFT JOIN (
  SELECT order_id, sum(qty) AS units
  FROM order_items
  GROUP BY order_id
) i ON i.order_id = o.id
WHERE o.status = 'delivered'
GROUP BY u.id, u.name;
```

```text
 name │ revenue │ units
──────┼─────────┼───────
 Asha │    1280 │     8
 Ravi │     450 │     1
```

Joining **two** child tables (items and payments) to the same order is worse: rows multiply as items × payments. Aggregate each one separately before joining. And `SUM(DISTINCT o.total)` is not a fix: two different orders with the same total would be counted once.

> **Remember:** if the numbers look too big, you have fan-out. Aggregate each one-to-many table down to one row per key **before** you join it.

## 8. LATERAL: "latest N orders per user"

A normal subquery in `FROM` can't see the other tables in the query. A **LATERAL** subquery can: it runs once **per row** of the tables before it, like a `for` loop.

```sql
SELECT u.name, o.id AS order_id, o.created_at
FROM users u
LEFT JOIN LATERAL (
  SELECT id, created_at
  FROM orders
  WHERE orders.user_id = u.id        -- refers to the outer row
  ORDER BY created_at DESC
  LIMIT 2
) o ON true;
```

```text
 name  │ order_id │ created_at
───────┼──────────┼────────────
 Asha  │      104 │ 2026-10-02
 Asha  │      102 │ 2026-09-15
 Ravi  │      103 │ 2026-09-20
 Meera │     NULL │ NULL
 Kabir │     NULL │ NULL
```

- `LEFT JOIN LATERAL ... ON true` keeps users with no orders; `CROSS JOIN LATERAL` drops them.
- With an index on `orders (user_id, created_at DESC)`, each iteration is a tiny index scan that stops after N rows. On a 500,000-order table, fetching the latest 3 orders for 100 users took about 6 ms.
- The other common approach, `ROW_NUMBER()` per user, is covered in [CTEs and window functions](/lessons/postgres-ctes-and-window-functions).

## 9. USING vs ON

When the join columns have **the same name** in both tables, `USING` is shorter:

```sql
-- shipments(id, order_id, carrier) and order_items(order_id, ...)
-- both have a column called order_id, so these are equivalent:
SELECT * FROM shipments s JOIN order_items i ON i.order_id = s.order_id;
SELECT * FROM shipments   JOIN order_items   USING (order_id);
```

Differences:

| | `ON` | `USING (col)` |
|---|---|---|
| Column names | Can differ (`o.user_id = u.id`) | Must be identical |
| Extra conditions | Any expression (`AND o.status = 'paid'`) | Equality on listed columns only |
| `SELECT *` output | Both copies of the column | One merged column |

Avoid `NATURAL JOIN`: it joins on **every** column with the same name, so adding `created_at` to both tables later silently changes your query.

## 10. How PostgreSQL actually runs a join

You write *what* to join; the planner decides *how*. It picks one of three algorithms per join based on table sizes, indexes and statistics:

| Algorithm | How it works | Good when |
|---|---|---|
| **Nested Loop** | For each outer row, look up matches (often via an index) | Outer side is small, inner side indexed |
| **Hash Join** | Build a hash table on the smaller side, probe it with the other | Large unsorted inputs, equality joins |
| **Merge Join** | Sort both sides on the key, walk them together | Both inputs already sorted (e.g. by index) |

You'll see these as nodes in `EXPLAIN` output: [Reading EXPLAIN](/lessons/postgres-explain). One practical rule: **index your foreign key columns** (`orders.user_id`, `order_items.product_id`). PostgreSQL doesn't create those automatically, and nested-loop joins depend on them.

## 11. Common mistakes and gotchas

- **Filtering the right table in `WHERE`** after a LEFT JOIN (section 5).
- **`count(*)` with a LEFT JOIN** counts the NULL row. Use `count(right_table.id)`.
- **`NOT IN` with a nullable subquery** returns nothing (section 6).
- **Fixing duplicates with `DISTINCT`** instead of understanding them. Duplicates usually mean fan-out or a missing join condition.
- **Forgetting a join condition** in an old-style `FROM a, b` query creates an accidental cross join. Always use explicit `JOIN ... ON`.
- **Joining on mismatched types** (`text` vs `bigint`) forces casts and can block index use.

## 12. Choosing the right tool

| You want | Use | Why |
|---|---|---|
| Rows from both tables | `JOIN` / `LEFT JOIN` | You need columns from both |
| Left rows that **have** a match | `EXISTS` (or `IN`) | No duplicates, stops at first match |
| Left rows with **no** match | `NOT EXISTS` | NULL-safe, plans as anti-join |
| Top-N children per parent | `LATERAL` + `LIMIT` | Uses an index per parent |
| Totals across one-to-many tables | Aggregate first, then join | Avoids fan-out |

## 13. Trade-offs: when a join isn't the answer

- **Very hot read paths** that always join the same 5 tables may deserve a **denormalized** column or a materialized view, kept in sync deliberately.
- **Huge analytics joins** across billions of rows belong in a warehouse, not your OLTP database.
- **A join in a loop in app code** (the N+1 problem in ORMs) is worse than one SQL join. Let the database do it in one round trip.

> **Remember:** joins are cheap when they're indexed and the result is what you meant. Check the row counts, not just the query's syntax.
