---
slug: acid
title: 'ACID: the four promises of a transaction'
module: Transactions
order: 30
summary: What a transaction is, what each ACID property guarantees and what breaks without it, how PostgreSQL and MongoDB implement them, and when you don't need multi-statement transactions.
level: beginner
tags: [acid, transactions, atomicity, consistency, isolation, durability, mongodb, postgresql]
recap: >-
  A transaction groups several operations into one all-or-nothing unit. Atomicity means no half-done work,
  Consistency means every commit leaves the data valid under your rules, Isolation means concurrent
  transactions don't see each other's half-finished work, and Durability means a commit survives a crash.
  Databases build this with a write-ahead log, constraints, locks or MVCC, and fsync. ACID's C is about
  valid data, not CAP's C. In MongoDB a single-document write is already atomic, so good modelling often
  removes the need for multi-document transactions.
---

## 1. The story

Asha clicks **Pay ₹2,999** for a pair of running shoes. Behind that one click, the store must do four things:

1. Take ₹2,999 from Asha's wallet.
2. Reduce the shoe's stock by 1.
3. Create the order.
4. Record the payment.

Now imagine the server **crashes after step 1**. Asha's money is gone, but there's no order. She calls support, angry. Or imagine **two people** buy the last pair at the same instant, and both succeed.

A **transaction** is the database's promise to treat those four steps as **one unit**: either all of them happen, or none of them do, and nobody sees the in-between state.

Think of a **notary signing a property sale**. Buyer pays, seller hands over keys, the deed is updated. The notary doesn't let anyone walk away with half a deal (**atomicity**), refuses deals that break the law (**consistency**), handles one deal for a house at a time (**isolation**), and files the signed deed in a fireproof archive (**durability**).

| Notary | ACID property | Promise |
|---|---|---|
| No half deals | **Atomicity** | All or nothing |
| Only legal deals | **Consistency** | Rules always hold after a commit |
| One deal at a time per house | **Isolation** | Concurrent transactions don't interfere |
| Fireproof archive | **Durability** | Committed = survives crashes |

> **Remember:** a **transaction** is a group of reads and writes that the database treats as **one indivisible unit**. ACID is the list of four promises it makes about that unit.

## 2. Each letter, and what breaks without it

### A: Atomicity

All operations in the transaction succeed, or none take effect. If anything fails (an error, a constraint violation, a crash, or your code calling `ROLLBACK`), every change is undone.

❌ **Without it:** wallet debited, no order created. Money vanishes.

"Atomic" here means **indivisible**, not "concurrent-safe". That's isolation's job.

### C: Consistency

A transaction takes the database from one **valid state** to another. "Valid" means all your rules hold: `stock >= 0`, every order references an existing user, emails are unique.

❌ **Without it:** stock goes to -1, an order points to a deleted user.

Important nuance: the database only enforces the rules **you declare** (constraints, validators). A rule like "wallet debit must equal order total" lives in your code. So consistency is a **shared responsibility**: the database provides A, I and D plus constraints; your application uses them to keep the data correct.

### I: Isolation

Transactions running at the same time behave as if they ran **one after another**, or at least don't see each other's unfinished work. How strict this is depends on the **isolation level**.

❌ **Without it:** two checkouts both read `stock = 1`, both write `stock = 0`, two orders for one shoe (a **lost update**). Or a report reads a balance that a not-yet-committed transaction just changed and later rolls back (a **dirty read**).

| Anomaly | What happens |
|---|---|
| **Dirty read** | You read another transaction's uncommitted change |
| **Non-repeatable read** | You read the same row twice and get different values |
| **Phantom read** | You re-run a range query and new rows appear |
| **Lost update** | Two read-modify-write cycles overwrite each other |

### D: Durability

Once the database says **committed**, the data survives a crash, power loss or restart.

❌ **Without it:** Asha sees "Order confirmed", the server loses power, and after restart her order doesn't exist.

Durability against a **disk failure** needs more than one machine: replication and backups.

> **Remember:** **A** = all or nothing. **C** = rules always hold. **I** = concurrent transactions don't trip over each other. **D** = committed means saved.

## 3. How databases implement each promise

```text
 BEGIN
   │
   ├─ change 1 ──► log record appended (in memory)
   ├─ change 2 ──► log record appended
   ├─ change 3 ──► log record appended
   │
 COMMIT
   │
   ├─ commit record appended to the log
   ├─ log flushed to disk (fsync)   ← durability point
   └─ "OK" returned to the app
         data pages written to disk later (checkpoint)

 Crash before the fsync?  → transaction never committed, discarded
 Crash after the fsync?   → log replayed on restart, data restored
```

| Property | Main mechanism |
|---|---|
| **Atomicity** | Undo information (old row versions or an undo log) + the commit record in the log |
| **Consistency** | Constraints (`NOT NULL`, `UNIQUE`, `CHECK`, foreign keys), triggers, MongoDB schema validation + atomicity |
| **Isolation** | **Locks** and **MVCC** (multi-version concurrency control) |
| **Durability** | **Write-ahead log** / journal flushed with `fsync` before acknowledging the commit |

A few details worth knowing:

- **Undo and redo.** *Redo* means replaying logged changes after a crash (the WAL). *Undo* means discarding uncommitted changes. PostgreSQL doesn't need a separate undo log: because of MVCC it writes **new row versions** and an aborted transaction's versions simply never become visible. MySQL InnoDB uses an explicit undo log.
- **MVCC.** Instead of making readers wait for writers, the database keeps **multiple versions** of a row. Each transaction reads from a **snapshot**, so readers don't block writers and writers don't block readers. Writers to the **same** row still conflict. PostgreSQL and MongoDB (WiredTiger) both use MVCC.
- **fsync.** Writing to a file usually lands in the OS cache first. `fsync` forces it to the physical disk. A commit is only durable after the log is fsync'd.
- **The knobs.** PostgreSQL `synchronous_commit = off` returns before the WAL flush: faster, but a crash can lose the last fraction of a second of commits (without corrupting data). In MongoDB, write concern `j: true` or `w: 'majority'` waits for the journal; `w: 1` without journaling waits less.

### Isolation levels in PostgreSQL

| Level | Prevents | Notes |
|---|---|---|
| Read Uncommitted | Dirty reads | Behaves exactly like Read Committed in PostgreSQL |
| **Read Committed** (default) | Dirty reads | Each **statement** sees a fresh snapshot |
| Repeatable Read | + non-repeatable and phantom reads | One snapshot for the **whole transaction** |
| Serializable | All anomalies | May abort with a serialization error: retry it |

MongoDB multi-document transactions use **snapshot isolation**: the transaction reads from one consistent snapshot, and if two transactions write the same document, one gets a **write conflict** and is aborted (the driver retries it inside `withTransaction`).

> **Remember:** durability comes from **logging + fsync before saying OK**. Isolation comes from **locks or MVCC**. Atomicity comes from being able to **discard** everything that wasn't committed.

## 4. A real example: checkout as a transaction

### PostgreSQL

The constraints do part of the consistency work:

```sql
CREATE TABLE wallets (
  user_id bigint PRIMARY KEY REFERENCES users(id),
  balance numeric(12,2) NOT NULL CHECK (balance >= 0)
);
-- products.stock already has CHECK (stock >= 0)
```

The checkout:

```sql
BEGIN;

UPDATE wallets  SET balance = balance - 2999 WHERE user_id = 17;
UPDATE products SET stock   = stock - 1      WHERE id = 203;

INSERT INTO orders (user_id, status)
VALUES (17, 'paid')
RETURNING id;

COMMIT;
```

- If Asha has less than ₹2,999, the `CHECK (balance >= 0)` fails, the statement errors and the transaction is **aborted**. Every later statement fails with *"current transaction is aborted"* and `COMMIT` performs a rollback. Nothing was changed.
- If the app decides to cancel (for example the payment gateway declines), it runs `ROLLBACK;` instead of `COMMIT;`.
- Two concurrent checkouts on product 203: the second `UPDATE` **waits for the row lock** held by the first, then re-reads the latest stock. If it would go below zero, the `CHECK` stops it.

### MongoDB (Node.js driver)

Multi-document transactions need a **replica set** or sharded cluster (Atlas always is). Every operation must receive the `session`:

```js
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    const shop = client.db('shop');

    const wallet = await shop.collection('wallets').updateOne(
      { userId, balance: { $gte: 2999 } },
      { $inc: { balance: -2999 } },
      { session }
    );
    if (wallet.modifiedCount !== 1) throw new Error('Insufficient balance');

    const product = await shop.collection('products').updateOne(
      { _id: productId, stock: { $gte: 1 } },
      { $inc: { stock: -1 } },
      { session }
    );
    if (product.modifiedCount !== 1) throw new Error('Out of stock');

    await shop.collection('orders').insertOne(
      { userId, status: 'paid', items: [{ productId, quantity: 1 }], createdAt: new Date() },
      { session }
    );
  }, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' }
  });
} finally {
  await session.endSession();
}
```

- Throwing inside the callback **aborts** the transaction and the error propagates to your code.
- `withTransaction` **automatically retries** on transient errors (like write conflicts) and on an unknown commit result, so the callback must be safe to run more than once (no sending emails inside it).
- Forgetting `{ session }` on one operation is a classic bug: that write runs **outside** the transaction and won't roll back.

## 5. MongoDB: single-document atomicity first

In MongoDB, **every write to a single document is atomic**, including all its embedded arrays and subdocuments. So if your data is modelled well, many "transactions" are just one update:

```js
// Add an item and update the total in one atomic operation
db.orders.updateOne(
  { _id: orderId, status: 'pending' },
  {
    $push: { items: { productId, quantity: 2, unitPrice: 499 } },
    $inc:  { total: 998 }
  }
)
```

Either both the `$push` and the `$inc` apply, or neither does. No session needed.

Multi-document transactions are fully ACID, but they cost more: extra coordination, locks held longer, a default **60-second** runtime limit, and more work on sharded clusters. MongoDB's own guidance: prefer **schema design** (embedding) over transactions where it fits.

> **Remember:** in MongoDB, design so that things that must change together **live in one document**. Reach for a multi-document transaction when they genuinely can't.

## 6. Don't confuse ACID's C with CAP's C

| | **ACID Consistency** | **CAP Consistency** |
|---|---|---|
| About | Data obeys your **rules** | All nodes return the **latest** value |
| Scope | One database, one transaction | A **distributed** system with replicas |
| Violated when | Stock becomes -1 | A replica returns an old stock value |
| Formal name | Integrity / invariants | **Linearizability** |

Same word, completely different meanings. Saying this unprompted in an interview is a strong signal.

## 7. ACID vs BASE

**BASE** describes the style many early distributed NoSQL systems chose:

| | **ACID** | **BASE** |
|---|---|---|
| Stands for | Atomicity, Consistency, Isolation, Durability | **B**asically **A**vailable, **S**oft state, **E**ventually consistent |
| Priority | Correctness | Availability and scale |
| After a write | Everyone sees the committed value | Replicas converge **eventually** |
| Typical fit | Payments, inventory, orders | Likes counters, feeds, analytics events |

It's a spectrum, not two camps: MongoDB, for example, is ACID within a replica set when configured with `majority` concerns, and can be tuned toward faster, weaker guarantees.

## 8. Common mistakes and gotchas

- **Long transactions.** Calling a payment API or waiting for user input inside a transaction holds locks and (in PostgreSQL) prevents cleanup of old row versions. Do slow external work **before or after**, not inside.
- **Assuming Read Committed prevents lost updates.** In PostgreSQL's default level, `SELECT stock` → compute in JS → `UPDATE stock = 5` can still lose an update. Use `UPDATE … SET stock = stock - 1`, `SELECT … FOR UPDATE`, or a stricter level.
- **Not retrying.** Serializable transactions in PostgreSQL and write conflicts in MongoDB **will** abort sometimes. That's by design; your code must retry.
- **Side effects inside retried callbacks.** Emails or webhooks inside `withTransaction` may fire twice.
- **Believing durability means "can't lose data".** One server's durability doesn't survive a dead disk. You also need replication and backups.
- **Running MongoDB transactions on a standalone server.** They fail: transactions need a replica set (a single-node replica set works for local dev).

## 9. When you don't need a multi-statement transaction

- **One row or one document.** A single `UPDATE` or `updateOne` is already atomic.
- **Atomic operators do the job.** `$inc`, `stock = stock - 1`, conditional updates (`WHERE stock > 0`, `{ stock: { $gte: 1 } }`) solve most counter and inventory races.
- **Embedded data.** Order + items in one MongoDB document.
- **Idempotent, retryable steps across services.** Across microservices or a payment gateway, a database transaction can't span them anyway; use an **outbox** pattern or a **saga** with compensating actions.
- **Append-only events** (page views, logs) where losing ordering or a rare duplicate is acceptable.

The trade-off: transactions buy correctness with **latency, contention and complexity**. Use them where the money and the stock are; skip them where a single atomic write does the job.
