---
slug: normalization
title: 'Normalization: one fact, one place'
module: Data Modeling
order: 50
summary: Why messy tables cause insert, update and delete anomalies, how keys and functional dependencies drive 1NF to BCNF, and when denormalizing on purpose is the right call.
level: intermediate
tags: [normalization, data-modeling, 1nf, 2nf, 3nf, bcnf, denormalization, keys, functional-dependency]
recap: >-
  Normalization means storing every fact in exactly one place, so data cannot contradict itself. A messy table
  causes insert, update and delete anomalies. 1NF removes lists in cells, 2NF removes facts that depend on only part
  of a composite key, 3NF removes facts that depend on non-key columns, and BCNF requires every determinant to be a
  candidate key. Denormalize deliberately, for measured read performance, and accept that you now own keeping copies in sync.
---

## 1. The story

Your store starts with a **spreadsheet**. Every time someone orders, you add a row:

| order_id | date | customer | email | city | products | prices |
|---|---|---|---|---|---|---|
| 101 | 03-01 | Asha | asha@x.io | Pune | Mouse, Keyboard | 499, 1299 |
| 102 | 03-02 | Ravi | ravi@x.io | Delhi | Mouse | 499 |
| 103 | 03-05 | Asha | asha@x.io | Pune | USB-C Hub | 1999 |

It works for a week. Then three things go wrong:

- **Insert anomaly:** you buy a new product, "Webcam", but you **can't add it** anywhere until somebody orders it. A product only exists inside an order row.
- **Update anomaly:** Asha changes her email. She appears in 40 rows. Your script updates 39 of them. Now the database holds **two different emails** for one person, and nobody knows which is right.
- **Delete anomaly:** order 103 is cancelled and you delete the row. The **only record** that "USB-C Hub costs 1999" disappears with it.

All three have one root cause: **the same fact is stored in many places, or unrelated facts are glued into one row.**

**Normalization** is the process of splitting tables so that **every fact lives in exactly one place**.

- "Asha's email" = one row in `customers`.
- "Mouse costs 499" = one row in `products`.
- "Order 101 contains 1 Mouse" = one row in `order_items`.

> **Remember:** normalization = **one fact, one place**. Anomalies are what you get when one fact lives in many places.

## 2. Keys: the vocabulary you need first

Every normal form is defined in terms of keys, so get these straight:

| Term | Meaning | Store example |
|---|---|---|
| **Super key** | Any set of columns that uniquely identifies a row | `(customer_id, email)` |
| **Candidate key** | A *minimal* super key (remove any column and it stops being unique) | `customer_id`, or `email` |
| **Primary key** | The candidate key you *choose* as the main identifier | `customer_id` |
| **Composite key** | A key made of 2+ columns | `(order_id, product_id)` |
| **Foreign key** | A column pointing to another table's key | `orders.customer_id → customers` |
| **Natural key** | A key with real-world meaning | `email`, `sku`, a GST number |
| **Surrogate key** | A meaningless generated ID | `id bigint GENERATED ALWAYS AS IDENTITY`, MongoDB `_id` |

**Natural vs surrogate** is a classic interview question:

- Natural keys **change** (people change emails; SKUs get re-labelled) and changing a primary key means updating every foreign key that points to it.
- Surrogate keys **never change** and are small, but they don't stop duplicates on their own.
- The common practice: a **surrogate primary key** plus a **UNIQUE constraint on the natural key**.

```sql
CREATE TABLE customers (
  customer_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- surrogate
  email       text NOT NULL UNIQUE,                             -- natural, still enforced
  name        text NOT NULL,
  city        text
);
```

## 3. Functional dependency in plain English

A **functional dependency** `X → Y` means: **if you know X, there is exactly one possible Y.**

- `customer_id → email` ✅ one customer has one email.
- `product_id → product_name` ✅
- `order_id → order_date` ✅
- `city → customer_id` ❌ many customers live in Pune.

The column(s) on the left are the **determinant**. Normalization is just this: **look at each dependency and make sure its determinant is the key of the table it lives in.** If it isn't, that fact belongs in a different table.

> **Remember:** `X → Y` reads as "X decides Y". Every normal form asks the same question: is the thing deciding this column actually the table's key?

## 4. Evolving the table: 1NF → 2NF → 3NF → BCNF

We'll take the spreadsheet above and fix it one step at a time.

### First Normal Form (1NF): one value per cell

**Rule:** every cell holds a single **atomic** value, there are no repeating groups (`product1, product2, product3` columns), and each row is identifiable by a key.

`products = "Mouse, Keyboard"` breaks this. You can't index it, join on it, or ask "how many Mice did we sell?" without string parsing. So we make **one row per order line**:

| order_id | product_id | date | customer_id | cust_name | email | product_name | price | qty |
|---|---|---|---|---|---|---|---|---|
| 101 | P1 | 03-01 | C1 | Asha | asha@x.io | Mouse | 499 | 1 |
| 101 | P2 | 03-01 | C1 | Asha | asha@x.io | Keyboard | 1299 | 1 |
| 102 | P1 | 03-02 | C2 | Ravi | ravi@x.io | Mouse | 499 | 2 |

Primary key: the **composite key** `(order_id, product_id)`.

It's in 1NF, but look at the duplication: order 101's date and customer are repeated on every line.

### Second Normal Form (2NF): no partial dependencies

**Rule:** 1NF, **and** every non-key column depends on the **whole** composite key, not just part of it.

Check each column against `(order_id, product_id)`:

| Column | Depends on | Problem? |
|---|---|---|
| `qty` | `(order_id, product_id)` | ✅ whole key |
| `date`, `customer_id`, `cust_name`, `email` | `order_id` only | ❌ partial |
| `product_name`, `price` | `product_id` only | ❌ partial |

Each partial dependency moves to a table keyed by the part it depends on:

```text
┌──────────────────────┐  ┌───────────────────┐  ┌──────────────────┐
│ orders               │  │ order_items       │  │ products         │
├──────────────────────┤  ├───────────────────┤  ├──────────────────┤
│ order_id (PK)        │◄─┤ order_id   (PK,FK)│  │ product_id (PK)  │
│ order_date           │  │ product_id (PK,FK)├─►│ name             │
│ customer_id          │  │ qty               │  │ price            │
│ cust_name            │  │ unit_price        │  └──────────────────┘
│ email                │  └───────────────────┘
└──────────────────────┘
```

Now the "Webcam" can exist in `products` before anyone orders it (insert anomaly gone), and deleting an order no longer deletes product facts (delete anomaly gone).

Notice `unit_price` in `order_items`. That is **not** a duplicate of `products.price`. It's a **different fact**: "the price this customer actually paid on that day". It depends on the whole key `(order_id, product_id)`. If you only stored `products.price`, a price change tomorrow would silently rewrite every old invoice.

> **Remember:** a price snapshot on an order line is not denormalization. "Current price" and "price paid" are two different facts.

**Shortcut:** a table whose primary key is a **single column** can't have a partial dependency, so it's automatically in 2NF once it's in 1NF.

### Third Normal Form (3NF): no transitive dependencies

**Rule:** 2NF, **and** no non-key column depends on **another non-key column**.

Look at `orders`:

```text
order_id ──► customer_id ──► cust_name, email
```

`email` depends on the key only **through** `customer_id`. That's a **transitive dependency**, and it's exactly the update anomaly from the story: Asha's email is copied onto every one of her orders.

Fix it by moving customer facts to their own table:

| customers | | |
|---|---|---|
| **customer_id** | name | email |
| C1 | Asha | asha@x.io |
| C2 | Ravi | ravi@x.io |

| orders | | |
|---|---|---|
| **order_id** | order_date | customer_id (FK) |
| 101 | 03-01 | C1 |
| 102 | 03-02 | C2 |

Asha's email now lives in **one row**. Changing it is one `UPDATE`, and it can never disagree with itself.

The classic one-liner: **every non-key column must depend on "the key, the whole key, and nothing but the key."** "The key" is 1NF, "the whole key" is 2NF, "nothing but the key" is 3NF.

```sql
CREATE TABLE products (
  product_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  price      numeric(10,2) NOT NULL CHECK (price >= 0)
);

CREATE TABLE orders (
  order_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers (customer_id),
  order_date  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id   bigint NOT NULL REFERENCES orders (order_id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products (product_id),
  qty        int NOT NULL CHECK (qty > 0),
  unit_price numeric(10,2) NOT NULL,         -- price paid, a historical fact
  PRIMARY KEY (order_id, product_id)
);
```

### Boyce-Codd Normal Form (BCNF): every determinant is a candidate key

**Rule:** for every functional dependency `X → Y` in the table, `X` must be a **candidate key** (a super key, strictly).

3NF has a loophole: it allows `X → Y` when `Y` is itself part of some candidate key. Our four tables above have no such case, so they're already in BCNF. Most real 3NF tables are. Here's a store table where the loophole bites.

Marketplace sellers get an **account manager per category**. Business rules:

- A seller has exactly one manager in each category: `(seller_id, category) → manager`.
- Each manager covers exactly one category: `manager → category`.

| seller_id | category | manager |
|---|---|---|
| S1 | Electronics | Meera |
| S2 | Electronics | Meera |
| S3 | Electronics | Karan |
| S1 | Books | Tara |

Candidate keys: `(seller_id, category)` and `(seller_id, manager)`. Every column is part of some key, so the table is in 3NF. But `manager → category`, and `manager` alone is **not** a candidate key, so it is **not BCNF**.

The anomaly: "Meera handles Electronics" is stored once **per seller**. Move Meera to Fashion and you must update many rows. And a new manager can't be recorded until they have a seller.

BCNF split:

| managers | |
|---|---|
| **manager** | category |
| Meera | Electronics |
| Karan | Electronics |
| Tara | Books |

| seller_managers | |
|---|---|
| **seller_id** | **manager** |
| S1 | Meera |
| S2 | Meera |
| S1 | Tara |

⚠️ The interview-level nuance: this split is lossless, but the rule "one manager per seller per category" now spans two tables and **can't be enforced with a simple UNIQUE constraint** any more. BCNF can cost you **dependency preservation**. That's why 3NF is the usual practical target, and BCNF is applied where the anomaly actually hurts.

> **Remember:** 1NF = atomic values. 2NF = no partial dependency on a composite key. 3NF = no non-key → non-key dependency. BCNF = every determinant is a candidate key.

## 5. Denormalization: breaking the rules on purpose

A fully normalized schema answers "show order 101 with customer name and product names" with a **4-table join**. That's usually fine: joins on indexed keys are fast. But sometimes reads dominate so heavily that you **copy data on purpose** to avoid the work. That's **denormalization**.

Common, legitimate reasons:

- **Read performance:** store `review_count` and `avg_rating` on `products` so the product listing page doesn't run `COUNT`/`AVG` over millions of reviews on every request.
- **Reporting / analytics:** data warehouses use wide **star schemas** (a fact table plus flat dimension tables) because analysts scan billions of rows and joins are expensive at that scale. PostgreSQL **materialized views** are a controlled version of this inside one database.
- **NoSQL embedding:** in MongoDB, reading "an order" should be one document fetch, so you embed the line items and a **snapshot** of what you need:

```js
db.orders.insertOne({
  _id: 101,
  customerId: ObjectId('6650a1f2c3d4e5f6a7b8c9d0'),
  customerName: 'Asha',            // copied: shown on the order page
  createdAt: new Date(),
  items: [
    { productId: 1, name: 'Mouse',    unitPrice: 499,  qty: 1 },
    { productId: 2, name: 'Keyboard', unitPrice: 1299, qty: 1 }
  ],
  total: 1798                      // derived value, stored
})
```

Embedding `items` here isn't even a compromise: line items belong to exactly one order and are read with it. Copying `customerName` **is** a compromise: if Asha renames herself, old orders keep the old name. For invoices that's often what you *want*. For a "current profile" display it's a bug.

### The costs

- **Update anomalies come back.** Every copy must be updated when the source changes.
- **Writes get heavier.** One business change becomes several writes (ideally in one transaction).
- **Consistency becomes your job:** application code, triggers, background jobs, or change streams must keep copies in sync.
- **More storage**, and bigger rows or documents.

```sql
-- Denormalized counter: must be kept in sync on every review insert
BEGIN;
INSERT INTO reviews (product_id, customer_id, rating) VALUES (1, 7, 5);
UPDATE products
SET review_count = review_count + 1
WHERE product_id = 1;
COMMIT;
```

> **Remember:** denormalization trades **write complexity and consistency risk** for **faster reads**. Do it for a measured read problem, and decide who keeps the copies in sync.

## 6. Common mistakes and gotchas

- **Normalizing "price" out of order lines.** Historical facts (price paid, shipping address used) belong on the order. Joining to the current `products.price` rewrites history.
- **Comma-separated IDs in a column** (`tag_ids = '3,7,9'`). Breaks 1NF, can't have foreign keys, can't be indexed properly. Use a junction table (or a real array/`jsonb` only when you understand the trade-off).
- **Thinking surrogate keys remove duplicates.** Two rows for `asha@x.io` with different `customer_id`s is still a duplicate. Keep a UNIQUE constraint on the natural key.
- **Forgetting indexes on foreign keys.** PostgreSQL indexes primary keys and UNIQUE columns automatically, but **not** foreign key columns. A normalized schema with un-indexed `order_items.product_id` joins slowly.
- **"MongoDB means no normalization."** Wrong. You still decide what to embed and what to reference. Unbounded arrays (every review inside the product document) are a denormalization mistake that hits the 16 MB document limit.
- **Denormalizing before measuring.** Most "joins are slow" problems are missing indexes.

## 7. Normalized vs denormalized

| | Normalized | Denormalized |
|---|---|---|
| Each fact stored | Once | Possibly many times |
| Anomalies | Prevented by design | Possible, you prevent them in code |
| Writes | Simple, small | Heavier, must update copies |
| Reads | May need joins | Fewer joins / one fetch |
| Storage | Smaller | Larger |
| Typical home | OLTP: orders, payments, users | Reporting, caches, read-heavy views, document models |
| Best when | Data changes often, correctness matters | Data is read far more than written, or rarely changes |

## 8. Rule of thumb and trade-offs

The famous line is **"normalize until it hurts, denormalize until it works."** Read it responsibly:

1. **Start at 3NF** for transactional data. It's the default that keeps your data honest.
2. **"Until it hurts"** means a **measured** problem: a slow query in `EXPLAIN`, a page that's over its latency budget. Not a hunch.
3. Before denormalizing, try **indexes**, a better query, or a **cache**.
4. When you do denormalize, denormalize **one specific thing**, write down the source of truth, and build the sync mechanism (transaction, trigger, job) at the same time.

When *not* to go further with normalization:

- **Data that never changes** after it's written (an order snapshot, an audit log) can't suffer update anomalies, so copying is safe.
- **BCNF splits** that lose an important constraint may be worse than the small anomaly they remove.
- **Analytics stores** are deliberately denormalized. Normal forms are a tool for transactional systems, not a moral law.

> **Remember:** the normalized schema is the **source of truth**. Every denormalized copy is a **cache of it** that you've promised to keep in sync.
