---
slug: mongodb-transactions
title: 'Transactions and concerns: how sure do you need to be?'
module: Transactions
order: 70
summary: When MongoDB operations are atomic on their own, how multi-document transactions work in Node.js, and how write concern, read concern and read preference control durability and freshness.
level: advanced
tags: [mongodb, transactions, write-concern, read-concern, read-preference, sessions, consistency]
recap: >-
  A single-document write in MongoDB is always atomic, so good schema design covers most cases.
  Multi-document transactions need a replica set or sharded cluster; use session.withTransaction so
  transient errors are retried, keep them short, and remember the 60-second default lifetime. Write
  concern says how many members must confirm a write, read concern says how committed the data you read
  must be, and read preference says which member you read from. Majority plus primary plus causal
  sessions gives the strongest everyday guarantees.
---

## 1. The story

You're sending an important parcel through a courier.

- **Write concern** is the receipt you ask for. "Just tell me the counter took it" (fast, risky) or "tell me when it reached the main warehouse **and** a backup warehouse" (slower, safe).
- **Read concern** is what you accept when you check tracking. "Show me whatever the local counter wrote down, even if it isn't confirmed yet" or "only show me updates confirmed by most warehouses".
- **Read preference** is **which office you call** to check: the head office (always up to date) or a nearby branch (closer, but its information might be a few minutes old).
- A **transaction** is sending three parcels that must **all arrive or none**: an order, a stock adjustment and a payment slip.

Mapping:

| Courier | MongoDB |
|---|---|
| Head office | **Primary** (accepts all writes) |
| Branch offices | **Secondaries** (copies of the data) |
| Receipt you ask for | **Write concern** (`w`, `j`) |
| How confirmed the tracking info must be | **Read concern** (`local`, `majority`, …) |
| Which office you call | **Read preference** |
| All-or-nothing bundle | **Multi-document transaction** |

The basics of atomicity and isolation are in [ACID](/lessons/acid). This lesson is about how MongoDB applies them.

## 2. Single-document operations are already atomic

Every write to **one document** in MongoDB is atomic, including all its embedded arrays and sub-documents. Other readers never see a half-applied update.

```js
// One atomic operation: decrement stock only if enough is left
db.products.updateOne(
  { _id: 'KB-1', stock: { $gte: 2 } },
  { $inc: { stock: -2 }, $push: { reservations: { orderId: 9001, qty: 2 } } }
)
// modifiedCount: 0 means "not enough stock": nothing changed
```

This is why MongoDB schema design matters so much. If an order **embeds** its line items, shipping address and status history, then "create the order" is **one document write** and needs no transaction.

> **Remember:** in MongoDB, design so that things that must change together live in one document. Then atomicity is free.

## 3. Multi-document transactions

Sometimes the data really is spread out. A checkout touches three collections:

1. Insert into `orders`
2. Decrement stock in `products`
3. Insert into `payments`

If the server crashes after step 2, you've lost stock without an order. A **multi-document transaction** makes all three succeed or none.

Requirements and limits:

- Transactions need a **replica set** or **sharded cluster**. A standalone `mongod` has no oplog and can't run them. (Even locally, run a single-node replica set if you need them.)
- Every operation inside must use the same **session**.
- By default a transaction is aborted if it runs longer than **60 seconds** (`transactionLifetimeLimitSeconds`).
- Reads inside a transaction must use read preference **primary**.

### Node.js driver: `withTransaction`

```js
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db('shop');

async function checkout({ userId, productId, qty, amount }) {
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const stock = await db.collection('products').updateOne(
        { _id: productId, stock: { $gte: qty } },
        { $inc: { stock: -qty } },
        { session }                                // ← every op gets the session
      );
      if (stock.modifiedCount === 0) {
        throw new Error('OUT_OF_STOCK');           // throwing aborts the transaction
      }

      const { insertedId: orderId } = await db.collection('orders').insertOne(
        { userId, items: [{ productId, qty }], status: 'pending', createdAt: new Date() },
        { session }
      );

      await db.collection('payments').insertOne(
        { orderId, userId, amount, status: 'authorized' },
        { session }
      );
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary'
    });
  } finally {
    await session.endSession();
  }
}
```

### What `withTransaction` retries for you

| Error label | Meaning | What the helper does |
|---|---|---|
| `TransientTransactionError` | Something temporary broke the transaction (a write conflict with another transaction, a primary election, a network blip) | **Re-runs your whole callback** |
| `UnknownTransactionCommitResult` | The commit was sent but the driver doesn't know if it succeeded | **Retries the commit** (commit is safe to retry) |
| Anything else (your `OUT_OF_STOCK`) | Your logic failed | **Aborts** and rethrows to you |

The driver keeps retrying until a time limit is reached. Because your callback **may run more than once**, it must not do non-repeatable side effects such as sending an email or charging a card through an external API. Do those **after** the transaction commits.

> **Remember:** use `withTransaction`, pass `{ session }` to every operation, and keep side effects outside the callback because it can be retried.

### Mongoose equivalent

```ts
import mongoose from 'mongoose';

await mongoose.connection.transaction(async (session) => {
  const res = await Product.updateOne(
    { _id: productId, stock: { $gte: qty } },
    { $inc: { stock: -qty } },
    { session }
  );
  if (res.modifiedCount === 0) throw new Error('OUT_OF_STOCK');

  // create() needs an ARRAY when you pass options
  const [order] = await Order.create(
    [{ user: userId, items: [{ product: productId, qty }], status: 'pending' }],
    { session }
  );
  await Payment.create([{ order: order._id, amount, status: 'authorized' }], { session });
});
```

`connection.transaction()` wraps the driver's `withTransaction` (so it gets the same retries) and also resets Mongoose document state if the transaction aborts. You can also use `const session = await mongoose.startSession()` and `session.withTransaction(...)` directly.

### The cost of transactions

Transactions are not free:

- They hold **locks and a snapshot** for their whole duration. Long transactions put pressure on the WiredTiger cache and cause **write conflicts** with other operations.
- A conflicting write makes one side fail with a `TransientTransactionError` and retry: more latency under contention.
- In sharded clusters, a transaction touching several shards needs a **two-phase commit** across them.

Keep them **short**: do validation, price calculation and external API calls *before* starting, and touch as few documents as possible inside.

## 4. Write concern: how many confirmations?

**Write concern** decides when the server says "OK" to your write.

```text
                 ┌─────────┐            ┌─────────────┐
 App ──insert──► │ PRIMARY │ ──oplog──► │ SECONDARY 1 │
                 │         │            └─────────────┘
                 │         │            ┌─────────────┐
                 │         │ ──oplog──► │ SECONDARY 2 │
                 └─────────┘            └─────────────┘
   w: 1         ──► ack after the primary applies it
   w: majority  ──► ack after 2 of 3 members have it
   j: true      ──► ack only after it's in the on-disk journal
```

| Option | Meaning | Trade-off |
|---|---|---|
| `w: 0` | Don't wait at all | Fire-and-forget; you won't even see errors |
| `w: 1` | Primary applied it | Fast, but lost if the primary dies before replicating |
| `w: 'majority'` | A majority of voting members have it | **Survives failover**; slightly slower |
| `j: true` | Written to the on-disk journal | Survives a crash of the acknowledging node(s) |
| `wtimeout: 5000` | Stop waiting after 5 s | The write is **not undone**; it may still succeed later |

Since MongoDB 5.0 the default write concern is `w: 'majority'` for most deployments. (Deployments with an arbiter can end up with `w: 1`; see [Replication](/lessons/mongodb-replication).)

```js
db.orders.insertOne(
  { userId: 7, total: 120 },
  { writeConcern: { w: 'majority', j: true, wtimeout: 5000 } }
)
```

⚠️ A `wtimeout` error means "I stopped waiting", **not** "it failed". Your code must handle the possibility that the write actually happened.

> **Remember:** `w: 'majority'` means the write survives a primary failover. `w: 1` can be rolled back.

## 5. Read concern: how committed must the data be?

**Read concern** controls which version of the data a read may return.

| Level | Returns | Use it for |
|---|---|---|
| `local` | The node's latest data, even if not yet replicated to a majority (default) | Most reads |
| `available` | Like `local`; in sharded clusters it can also return **orphaned** documents, but is fastest | Rarely needed |
| `majority` | Only data acknowledged by a majority, so it **can't be rolled back** | Reads that must never "disappear" |
| `snapshot` | A consistent point-in-time view across documents | Multi-document transactions |
| `linearizable` | Reflects every majority-acknowledged write that finished before the read started; primary only, single document | The rare "must be the absolute latest" read; slow |

Simple picture: `local` = "what this server has right now", `majority` = "what's guaranteed to stick", `linearizable` = "what's guaranteed to stick **and** is the newest, double-checked with the other members".

## 6. Read preference: which member do you ask?

| Read preference | Reads go to | Risk |
|---|---|---|
| `primary` (default) | Primary only | None for freshness; fails if no primary |
| `primaryPreferred` | Primary, secondary if no primary | Stale reads during failover |
| `secondary` | Secondaries only | Stale reads |
| `secondaryPreferred` | Secondaries, primary if none available | Stale reads |
| `nearest` | Lowest network latency member | Stale reads |

Secondaries replicate **asynchronously**, so they can lag behind. A user who just placed an order, then reads "my orders" from a secondary, might **not see it**. You can cap staleness with `maxStalenessSeconds` (minimum 90 seconds), but stale reads are never fully eliminated.

> **Remember:** reading from secondaries scales reads but trades away freshness. Default to `primary` for anything a user just changed.

## 7. Causal consistency: "read your own writes"

A **causally consistent session** guarantees that operations in that session respect their order, even across different members:

- **Read your writes:** you see the order you just inserted.
- **Monotonic reads:** you never see data go backwards in time.
- **Monotonic writes** and **writes follow reads.**

```js
const session = client.startSession({ causalConsistency: true });
const orders = db.collection('orders');

await orders.insertOne(
  { userId: 7, total: 120 },
  { session, writeConcern: { w: 'majority' } }
);
const mine = await orders
  .find({ userId: 7 }, { session, readConcern: { level: 'majority' }, readPreference: 'secondary' })
  .toArray();   // waits until the secondary has caught up to our insert
await session.endSession();
```

The guarantees only fully hold when you use **`w: 'majority'`** writes and **`majority`** read concern in that session.

### The strongest combination

| Goal | Settings |
|---|---|
| Never lose acknowledged writes | `w: 'majority'` (+ `j: true`) |
| Never read data that can be rolled back | read concern `majority` |
| Always read the latest | read preference `primary` (or `linearizable` for single docs) |
| Read your own writes on any member | causally consistent session + majority/majority |
| All-or-nothing across documents | transaction with `snapshot` + `w: 'majority'` |

## 8. Common mistakes and gotchas

- **Forgetting `{ session }`** on one operation. It runs **outside** the transaction and isn't rolled back.
- **Trying transactions on a standalone** server. You get an error about transaction numbers only being allowed on a replica set member or mongos.
- **External side effects in the callback.** The callback can be retried, so an email can be sent twice.
- **Long transactions:** looping over thousands of documents, or awaiting a slow API inside. They hit the 60-second limit and cause conflicts.
- **Reading from secondaries** right after a write and wondering where the data went.
- **Treating `wtimeout` as failure** and retrying a non-idempotent insert, creating a duplicate.
- **Using transactions to fix a relational schema** ported 1:1 to MongoDB instead of embedding.

## 9. When NOT to use transactions

Reach for a transaction only when an operation **must** touch several documents atomically. First try:

1. **Embedding:** put the order, its items and its status history in one document.
2. **Atomic operators:** `$inc`, `$push`, `$pull`, `$set` with a conditional filter like `{ stock: { $gte: qty } }`.
3. **`findOneAndUpdate`** to read and modify in one atomic step.
4. **Idempotent, retryable steps** with a status field (`pending` → `paid`) when eventual consistency is acceptable, for example across services.

| | Single-document atomic update | Multi-document transaction |
|---|---|---|
| Needs a replica set | ❌ | ✅ |
| Cost | Cheapest possible | Locks, snapshot, retries, possible 2PC |
| Scope | One document | Many documents / collections |
| Typical use | Stock decrement, counters, status change | Order + stock + payment in separate collections |

> **Remember:** transactions are a safety net, not a design pattern. If most of your writes need one, revisit the schema.
