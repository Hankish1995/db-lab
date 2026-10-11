---
slug: concurrency-and-locking
title: 'Concurrency and locking: two buyers, one last item'
module: Transactions
order: 70
summary: The anomalies that happen when transactions run at the same time, what each isolation level prevents, and how atomic updates, pessimistic locks and optimistic versioning stop overselling in SQL and MongoDB.
level: intermediate
tags: [concurrency, locking, isolation-levels, transactions, deadlocks, optimistic-locking, pessimistic-locking, mvcc]
recap: >-
  When transactions overlap you can get lost updates, dirty reads, non-repeatable reads, phantoms and write skew.
  Isolation levels decide which of these are possible; PostgreSQL defaults to read committed, its repeatable read is
  snapshot isolation, and its serializable level prevents write skew by aborting conflicting transactions. To stop
  overselling, prefer one atomic conditional update; use SELECT FOR UPDATE for pessimistic locking under heavy contention
  and a version check for optimistic locking when conflicts are rare. Avoid deadlocks with consistent lock order and short transactions, and always be ready to retry.
---

## 1. The story

It's a flash sale. There is **1 PlayStation left**. Asha and Ravi both click "Buy" in the same second.

Your Node.js handler does the obvious thing:

```js
const product = await Product.findById(id);   // 1. read
if (product.stock < 1) throw new Error('Sold out');
product.stock -= 1;                           // 2. decide in app code
await product.save();                         // 3. write
await Order.create({ userId, productId: id });
```

Both requests read `stock = 1`. Both pass the check. Both write `stock = 0`. Both get an order confirmation. You've sold **two** PlayStations and own **one**.

That's a **race condition**: the result depends on the timing of two operations that overlap. It's like two cashiers in a shop both glancing at the same shelf, both seeing one item, and both promising it to a customer.

| Shop | Database |
|---|---|
| Two cashiers working at once | **Concurrent transactions** |
| Glancing at the shelf | A **read** |
| Promising the item | A **write** based on that read |
| Putting your hand on the item first | A **lock** |
| A sticker "checked at 10:02" on the shelf | A **version** number |
| How much each cashier can see of the other's unfinished work | **Isolation level** |

> **Remember:** "read, decide in app code, write" is a race condition whenever two requests can run at the same time. Which, in a web server, is always.

## 2. Why this is hard: the five anomalies

Databases run many transactions concurrently for throughput. Without control, these **anomalies** appear. Read each timeline top to bottom.

### Lost update

Two transactions read the same value, both modify it, and the second write **overwrites** the first.

```text
 T1 (Asha)                     T2 (Ravi)
 ────────────────────────      ────────────────────────
 read stock      → 1
                               read stock      → 1
 write stock = 0
 COMMIT
                               write stock = 0
                               COMMIT
 Result: 2 orders, stock 0. T1's decrement was lost.
```

### Dirty read

Reading data another transaction **hasn't committed yet**, which may be rolled back.

```text
 T1 (admin)                    T2 (customer)
 ────────────────────────      ────────────────────────
 set price = 0 (typo!)
                               read price      → 0
                               place order at 0
 ROLLBACK
 Result: an order at a price that never officially existed.
```

### Non-repeatable read

Reading the **same row twice** in one transaction gives **different values**, because someone committed a change in between.

```text
 T1 (checkout)                 T2 (admin)
 ────────────────────────      ────────────────────────
 read price      → 499
                               set price = 549
                               COMMIT
 read price      → 549
 Result: the cart total and the invoice disagree.
```

### Phantom read

Running the **same query twice** returns a **different set of rows**, because someone inserted or deleted matching rows.

```text
 T1 (report)                   T2 (shop)
 ────────────────────────      ────────────────────────
 count pending   → 5
                               insert pending order
                               COMMIT
 count pending   → 6
 Result: the summary says 5 but the detail lists 6.
```

### Write skew

Two transactions read the **same data**, make decisions based on it, and write **different rows**. Each write is fine alone; together they break a rule.

Rule: "each customer may redeem the WELCOME coupon once".

```text
 T1 (tab 1)                    T2 (tab 2)
 ────────────────────────      ────────────────────────
 count redemptions → 0
                               count redemptions → 0
 insert redemption
                               insert redemption
 COMMIT                        COMMIT
 Result: coupon used twice. No row was written by both.
```

Write skew is the sneaky one: no two transactions touched the same row, so row locks alone don't catch it.

> **Remember:** lost update = overwrite. Dirty = uncommitted. Non-repeatable = same row changed. Phantom = new rows appeared. Write skew = different rows, broken rule.

## 3. Isolation levels

An **isolation level** is the "I" of ACID: how much one transaction is protected from others running at the same time. The SQL standard defines four, by which of its three classic phenomena they allow:

| Level | Dirty read | Non-repeatable read | Phantom read |
|---|---|---|---|
| Read uncommitted | possible | possible | possible |
| Read committed | ❌ prevented | possible | possible |
| Repeatable read | ❌ | ❌ | possible |
| Serializable | ❌ | ❌ | ❌ |

**Serializable** means: the result is the same as if the transactions had run **one at a time** in some order. Lower levels trade safety for concurrency.

### What PostgreSQL actually does

The standard sets **minimums**; databases may be stricter. PostgreSQL uses **MVCC** (each transaction reads a consistent **snapshot** instead of blocking writers), and its levels behave like this:

| PostgreSQL level | Dirty | Non-repeatable | Phantom | Lost update | Write skew |
|---|---|---|---|---|---|
| Read uncommitted | ❌ | possible | possible | possible | possible |
| **Read committed** (default) | ❌ | possible | possible | possible | possible |
| Repeatable read | ❌ | ❌ | ❌ | ❌ (error) | possible |
| Serializable | ❌ | ❌ | ❌ | ❌ (error) | ❌ (error) |

- **Read uncommitted behaves exactly like read committed.** PostgreSQL never shows uncommitted data.
- **Read committed** takes a new snapshot for **each statement**. The "lost update" here means the read-in-app-then-write pattern from the story.
- **Repeatable read** is **snapshot isolation**: one snapshot for the whole transaction, so it also prevents phantoms. If you try to update a row someone else changed after your snapshot, you get `could not serialize access due to concurrent update`.
- **Serializable** uses **Serializable Snapshot Isolation (SSI)**: it tracks read/write dependencies and aborts one transaction when a dangerous pattern like write skew appears.
- At repeatable read and serializable, your code **must retry** on serialization failures (SQLSTATE `40001`).

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT count(*) FROM coupon_redemptions
WHERE customer_id = 7 AND code = 'WELCOME';
INSERT INTO coupon_redemptions (customer_id, code) VALUES (7, 'WELCOME');
COMMIT;  -- one of two concurrent runs fails with 40001; retry it
```

For other databases: MySQL InnoDB defaults to **repeatable read**. MongoDB multi-document transactions read from a **snapshot** and abort on write conflicts. How MVCC works internally is covered in depth in the PostgreSQL track.

> **Remember:** know the standard table, then say "but PostgreSQL never allows dirty reads, its repeatable read is snapshot isolation, and serializable is SSI that aborts and expects a retry."

## 4. The solutions

### Solution 1: one atomic, conditional statement

Don't read-then-write in app code. Let the database **check and change in one statement**:

```sql
UPDATE products
SET stock = stock - 1
WHERE product_id = 1 AND stock > 0
RETURNING stock;
-- 1 row updated  → you got it
-- 0 rows updated → sold out
```

Why this is safe even at read committed: the first `UPDATE` **locks the row**. The second one **waits**; when the first commits, PostgreSQL **re-checks the `WHERE` against the new row version**, sees `stock > 0` is now false, and updates 0 rows.

MongoDB: every single-document write is **atomic**, so filter on stock and use `$inc`:

```js
const res = db.products.updateOne(
  { _id: 1, stock: { $gte: 1 } },
  { $inc: { stock: -1 } }
)
// res.modifiedCount === 1 → reserved; 0 → sold out
```

### Solution 2: pessimistic locking

**Lock first, then think.** Assume conflicts will happen and block others while you work.

```sql
BEGIN;
SELECT stock FROM products WHERE product_id = 1 FOR UPDATE;
-- other transactions trying to lock or update this row now WAIT
-- app checks stock, applies business rules, calls services...
UPDATE products SET stock = stock - 1 WHERE product_id = 1;
INSERT INTO orders (customer_id, product_id) VALUES (7, 1);
COMMIT;  -- lock released
```

Useful variants: `FOR UPDATE NOWAIT` (error immediately instead of waiting) and `FOR UPDATE SKIP LOCKED` (skip rows someone else holds; great for job queues).

### Solution 3: optimistic locking

**Don't lock; detect.** Assume conflicts are rare. Read a **version**, and only write if the version is unchanged.

```sql
SELECT stock, version FROM products WHERE product_id = 1;
-- stock = 5, version = 7

UPDATE products
SET stock = 4, version = version + 1
WHERE product_id = 1 AND version = 7;
-- 0 rows → someone else changed it: re-read and retry
```

```js
const p = db.products.findOne({ _id: 1 })
const res = db.products.updateOne(
  { _id: 1, version: p.version },
  { $set: { stock: p.stock - 1 }, $inc: { version: 1 } }
)
// res.matchedCount === 0 → conflict, retry
```

**Mongoose** has this built in. With the schema option `optimisticConcurrency: true`, `doc.save()` adds the version key (`__v`) to the update filter and increments it, throwing a `VersionError` if the document changed since you loaded it. Note it applies to **`save()`**; `updateOne()` and `findOneAndUpdate()` bypass it.

```js
const productSchema = new mongoose.Schema(
  { name: String, stock: Number },
  { optimisticConcurrency: true }
);
```

> **Remember:** atomic statement first. Pessimistic = lock, others wait. Optimistic = version check, loser retries.

## 5. Inventory overselling solved three ways

Real checkout: decrement stock **and** create the order, all or nothing.

**SQL, atomic (recommended):**

```sql
BEGIN;
UPDATE products SET stock = stock - 2
WHERE product_id = 1 AND stock >= 2;
-- app: if 0 rows updated → ROLLBACK, "out of stock"
INSERT INTO orders (customer_id, product_id, qty) VALUES (7, 1, 2);
COMMIT;
```

**SQL, pessimistic:** `SELECT ... FOR UPDATE` as in Solution 2, then check `stock >= 2` in the app. Choose it when the decision needs logic you can't fit in a `WHERE` (stock across warehouses, reservations, fraud checks).

**SQL, optimistic:** the version check from Solution 3 inside the transaction; if 0 rows, `ROLLBACK` and retry the whole thing.

**MongoDB, atomic + transaction (Node.js driver):**

```js
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    const res = await db.collection('products').updateOne(
      { _id: productId, stock: { $gte: qty } },
      { $inc: { stock: -qty } },
      { session }
    );
    if (res.modifiedCount === 0) throw new Error('OUT_OF_STOCK');
    await db.collection('orders').insertOne(
      { userId, productId, qty, createdAt: new Date() },
      { session }
    );
  });
} finally {
  await session.endSession();
}
```

`withTransaction` automatically retries on transient errors such as write conflicts.

**MongoDB, pessimistic-style:** there is no `SELECT ... FOR UPDATE`. The usual pattern is to **write to the document first** inside the transaction (for example a `findOneAndUpdate` that sets a `lockedAt` field), which claims it. Another transaction writing the same document gets a **write conflict** and is retried, rather than reading stale data and acting on it.

**MongoDB, optimistic:** the `version` filter shown above, or Mongoose's `optimisticConcurrency` with `save()`, wrapped in a retry loop.

## 6. Deadlocks

A **deadlock** is two transactions each holding a lock the other needs. Neither can continue.

Asha's cart: Mouse, then Keyboard. Ravi's cart: Keyboard, then Mouse.

```text
 T1 (Asha)                     T2 (Ravi)
 ────────────────────────      ────────────────────────
 lock Mouse     ✓
                               lock Keyboard  ✓
 lock Keyboard  ... waits
                               lock Mouse     ... waits

         ┌──────────────────────────────────┐
         │ T1 waits for T2, T2 waits for T1 │
         │ cycle: nobody can ever finish    │
         └──────────────────────────────────┘
```

**How databases handle it:** PostgreSQL, after a lock wait exceeds `deadlock_timeout` (1 second by default), checks the **wait-for graph** for a cycle. If it finds one, it aborts one transaction with `ERROR: deadlock detected` (SQLSTATE `40P01`). The other proceeds. The victim must retry.

In MongoDB, transactions that hit a write conflict abort rather than wait for each other, so the same situation shows up as **write-conflict retries** instead of a classic deadlock.

**How to avoid them:**

- **Consistent lock order:** sort the cart's product IDs and always lock/update in that order. Both transactions now want Mouse first, so one simply waits.
- **Short transactions:** never hold locks during HTTP calls, payment gateway calls or user think time.
- **Lock less:** atomic single statements hold locks for microseconds.
- **Retry:** deadlocks can still happen; treat `40P01` like `40001` and retry.

> **Remember:** deadlock = circular waiting. Lock in a consistent order, keep transactions short, and retry the victim.

## 7. Common mistakes and gotchas

- **Checking stock in app code, then writing.** The classic race. Put the condition in the `WHERE` / filter.
- **Thinking a transaction alone fixes it.** At PostgreSQL's default read committed, read-then-write inside `BEGIN ... COMMIT` can **still** lose updates. You need a conditional update, a lock or a stricter level.
- **Raising the isolation level without retry logic.** Repeatable read and serializable **abort** transactions on conflict. No retry = random 500 errors under load.
- **Holding `FOR UPDATE` across slow work.** Every other buyer queues behind that payment API call.
- **Fixing write skew with row locks only.** The rows don't exist yet. Use a **unique constraint** (`UNIQUE (customer_id, code)`) or serializable.
- **Assuming Mongoose's default `__v` protects everything.** Without `optimisticConcurrency`, Mongoose's versioning only guards certain array changes.

## 8. Pessimistic vs optimistic locking

| | Pessimistic | Optimistic |
|---|---|---|
| Idea | Lock before reading | Check version when writing |
| On conflict | Others **wait** | Loser **fails and retries** |
| Best when | Conflicts are **frequent** (hot items, flash sales) | Conflicts are **rare** (profile edits, admin forms) |
| Cost | Lock waits, deadlock risk | Wasted work on retry |
| Long user "think time" | ❌ can't hold locks for minutes | ✅ works across HTTP requests |
| SQL | `SELECT ... FOR UPDATE` | `WHERE version = ?` |
| MongoDB | Write-first in a transaction | Version field filter / `optimisticConcurrency` |

## 9. Trade-offs: when not to reach for each tool

- **Don't use serializable everywhere** by default "to be safe". It's correct but costs retries and throughput; use it for the transactions with real cross-row rules.
- **Don't use pessimistic locks for low-contention data.** You pay waiting and deadlock risk for conflicts that rarely happen.
- **Don't use optimistic locking on a hot row.** In a flash sale, most attempts fail and retry, a **retry storm**. A single atomic update is better.
- **Don't build locking at all** when one atomic statement or a constraint (`CHECK (stock >= 0)`, `UNIQUE`) can enforce the rule. The database enforces constraints for every code path, including the ones you forget.

> **Remember:** the best lock is the one you don't need. Prefer atomic statements and constraints; reach for locks and stricter isolation only when the rule spans more than one row.
