---
slug: distributed-data-patterns
title: 'Distributed data patterns: keeping checkout correct across services'
module: Replication & Consistency
order: 40
summary: Why one transaction can't span services, how two-phase commit and sagas coordinate multi-step work, how the transactional outbox fixes the dual-write problem, and how idempotency keys make retries safe.
level: advanced
tags: [system-design, microservices, saga, two-phase-commit, outbox, idempotency, event-sourcing, cqrs, distributed-transactions]
recap: >-
  When checkout spans orders, payments, inventory and email in different services, no single ACID transaction covers it.
  Two-phase commit gives atomicity but blocks when the coordinator fails, so most systems use sagas: a chain of local
  transactions with compensating actions such as refunding a payment. Writing to the database and publishing an event
  cannot be atomic, so write the event to an outbox table in the same transaction and let a relay or CDC publish it.
  Delivery is at-least-once, so every consumer and payment call must be idempotent, typically via a unique idempotency key.
---

## 1. The story: planning a wedding with four vendors

You're booking a wedding: the venue, the caterer, the photographer and the band. Each vendor has its own calendar. You want **all four or none**.

You can't make all four vendors sign one contract at the same instant. So you either:

- **Ask everyone to hold the date first, then confirm everyone** (two-phase commit). If you disappear after the "hold", the vendors are stuck holding a date they can't give to anyone else.
- **Book one by one, and cancel the earlier bookings if a later one fails** (a saga). The venue is booked, the caterer says no, so you cancel the venue, perhaps losing a fee. Not invisible, but it works.

| Wedding | Distributed system |
|---|---|
| Each vendor's calendar | Each service's **own database** |
| "Hold the date?" / "Confirmed" | **Prepare** / **commit** phases of 2PC |
| You, coordinating | **Coordinator** or **orchestrator** |
| Cancelling the venue | A **compensating action** |
| Calling the band twice by mistake | A **duplicate message**, needs **idempotency** |

## 2. The problem: checkout touches four things

```text
 POST /checkout
      │
      ├──► Orders service    → orders DB    (create order)
      ├──► Payment service   → payments DB  (charge via provider)
      ├──► Inventory service → inventory DB (reserve stock)
      └──► Email service     → provider     (send confirmation)
```

Inside one database, you'd wrap this in a transaction and get [ACID](/lessons/acid). Across services, each with its own database, plus an external payment provider and email service, **there's no shared transaction**. Things that go wrong:

- Payment succeeds, inventory reservation fails → customer charged for nothing.
- Order saved, the "OrderCreated" event never published → the warehouse never ships.
- The network times out on the payment call → did it charge or not? Retrying might **charge twice**.

> **Remember:** in distributed systems the question is never "will a step fail?" but "what state is everything in when it does?"

## 3. Two-phase commit (2PC)

A **coordinator** runs the transaction in two phases:

```text
 Phase 1: PREPARE               Phase 2: COMMIT
     ┌─────────────┐                ┌─────────────┐
     │ Coordinator │                │ Coordinator │
     └──────┬──────┘                └──────┬──────┘
            │ "can you commit?"            │ "commit!" (all YES)
   ┌────────┼────────┐            ┌────────┼────────┐
   ▼        ▼        ▼            ▼        ▼        ▼
 Orders  Payments  Stock        Orders  Payments  Stock
  YES      YES      YES          done     done     done
 (work durable, locks HELD)     (locks released)
```

1. **Prepare:** each participant does the work, writes it durably, keeps its locks, and votes YES ("I promise I can commit") or NO.
2. **Commit:** if all voted YES, the coordinator records the decision and tells everyone to commit; otherwise everyone aborts.

PostgreSQL supports the participant side with `PREPARE TRANSACTION 'id'` and `COMMIT PREPARED 'id'` (disabled by default: `max_prepared_transactions = 0`). MongoDB uses a 2PC protocol internally for transactions that span shards.

**The blocking problem:** once a participant has voted YES, it **cannot decide on its own**. If the coordinator crashes before sending the decision, participants stay "in doubt", holding locks on those rows, until the coordinator recovers. Hot inventory rows locked for minutes means checkout is down.

Other costs: extra round trips on every transaction, every participant must support 2PC (Stripe and email providers don't), and availability is the product of all participants' availability.

> **Remember:** 2PC gives atomicity at the price of blocking. It works inside one database cluster; across microservices and third-party APIs it rarely fits.

## 4. The Saga pattern

A **saga** is a sequence of **local transactions**, one per service. Each step commits on its own. If a later step fails, the saga runs **compensating actions** that semantically undo the earlier steps.

```text
 Happy path:
 ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
 │ Create     ├──►│ Charge     ├──►│ Reserve    ├──►│ Confirm    │
 │ order      │   │ payment    │   │ inventory  │   │ order      │
 │ (PENDING)  │   │            │   │            │   │ + email    │
 └────────────┘   └────────────┘   └─────┬──────┘   └────────────┘
                                         │ fails: out of stock
 Compensation:                           ▼
 ┌────────────┐   ┌────────────┐   ┌────────────┐
 │ Cancel     │◄──┤ Refund     │◄──┤ Failure    │
 │ order      │   │ payment    │   │ detected   │
 └────────────┘   └────────────┘   └────────────┘
```

Compensation is **not** a rollback. The charge really happened; the refund is a new, visible transaction. The customer may see both on their statement.

### Choreography vs orchestration

- **Choreography:** no central brain. Each service reacts to events: Orders emits `OrderCreated`, Payments hears it and emits `PaymentCaptured`, Inventory hears that and emits `StockReserved` or `StockReservationFailed`, and Payments hears the failure and refunds.
- **Orchestration:** an **orchestrator** (a service, or a workflow engine such as Temporal or AWS Step Functions) tells each service what to do and tracks the saga's state.

| | Choreography | Orchestration |
|---|---|---|
| Control | Distributed, event-driven | Central orchestrator |
| Coupling | Services know each other's events | Services know only the orchestrator's commands |
| Visibility | Flow is implicit, hard to trace | Flow is explicit in one place |
| Best for | 2–4 simple steps | Longer flows, timeouts, complex compensation |
| Risk | Cyclic event spaghetti | Orchestrator becomes a "god service" |

### Saga design tips

- **Order steps wisely.** Put steps that are likely to fail or easy to undo first. Many shops **reserve inventory first** and **authorize** (not capture) the payment, capturing only after the order is confirmed. Releasing a reservation is cheaper and less visible than a refund.
- **No isolation between steps.** Other requests can see the half-done saga. Use **semantic locks**: the order sits in status `PENDING` and the UI and other flows respect that.
- **Compensations must be retryable and idempotent**, because they can fail too.

> **Remember:** a saga trades atomicity for availability: every step commits locally, and failures are fixed forward with compensations.

## 5. The dual-write problem and the Transactional Outbox

The Orders service saves the order and publishes an event:

```ts
await db.query('INSERT INTO orders ...');   // 1. commit to DB
await broker.publish('OrderCreated', evt);  // 2. publish
```

If the process crashes between 1 and 2, the order exists but **no event is ever sent**. Swap the order and a crash leaves an event for an order that doesn't exist. Two different systems can't be written atomically: this is the **dual-write problem**.

**Transactional Outbox:** write the event into an `outbox` table **in the same local transaction** as the business change. A separate **relay** publishes outbox rows to the broker.

```sql
CREATE TABLE outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id  text        NOT NULL,
  event_type    text        NOT NULL,
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

BEGIN;
INSERT INTO orders (id, user_id, total_cents, status)
VALUES ('ord_1001', 42, 12999, 'PENDING');
INSERT INTO outbox (aggregate_id, event_type, payload)
VALUES ('ord_1001', 'OrderCreated',
        '{"orderId":"ord_1001","userId":42,"totalCents":12999}');
COMMIT;
```

Both rows commit or neither does. The relay either **polls**:

```sql
BEGIN;
SELECT id, event_type, payload FROM outbox
WHERE published_at IS NULL
ORDER BY created_at
LIMIT 100
FOR UPDATE SKIP LOCKED;   -- several relays can run without double-claiming
-- publish each row to the broker, then:
UPDATE outbox SET published_at = now() WHERE id = ANY($1);
COMMIT;
```

…or uses **change data capture** (CDC): a tool such as Debezium reads the database's log (PostgreSQL WAL) and publishes outbox inserts, with no polling.

In MongoDB, use a multi-document transaction (requires a replica set or sharded cluster):

```ts
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    await orders.insertOne(
      { _id: 'ord_1001', userId: 42, totalCents: 12999, status: 'PENDING' },
      { session });
    await outbox.insertOne(
      { type: 'OrderCreated', orderId: 'ord_1001', createdAt: new Date(), publishedAt: null },
      { session });
  });
} finally {
  await session.endSession();
}
```

A **change stream** on the `outbox` collection (resumable with resume tokens) is a natural relay. Since single-document writes are atomic in MongoDB, you can also embed pending events inside the order document itself. See [MongoDB transactions](/lessons/mongodb-transactions).

Note the relay can publish a row and crash before marking it published, so it will **publish it again**. The outbox gives you **at-least-once** delivery, never exactly-once.

> **Remember:** never write to the DB and the broker separately. Write to the DB once (business row + outbox row), and let the log drive the broker.

## 6. Idempotency: making retries safe

Networks time out. Clients retry. Brokers redeliver. The fix is to make operations **idempotent**: doing them twice has the same effect as once.

### Idempotency keys for payments

The client generates a unique key per checkout attempt (a UUID) and sends it with every retry. The server records the key under a **unique constraint**, so the second attempt can't create a second payment.

```sql
CREATE TABLE payments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key  text        NOT NULL UNIQUE,
  order_id         text        NOT NULL,
  amount_cents     integer     NOT NULL,
  status           text        NOT NULL,   -- PENDING | SUCCEEDED | FAILED
  provider_ref     text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
```

```ts
export async function pay(idemKey: string, orderId: string, amountCents: number) {
  const inserted = await pool.query(
    `INSERT INTO payments (idempotency_key, order_id, amount_cents, status)
     VALUES ($1, $2, $3, 'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [idemKey, orderId, amountCents]);

  if (inserted.rowCount === 0) {
    // Duplicate: return the stored outcome instead of charging again.
    const { rows } = await pool.query(
      'SELECT status, provider_ref FROM payments WHERE idempotency_key = $1', [idemKey]);
    return rows[0]; // if still PENDING, tell the client to retry later (e.g. 409)
  }

  // Pass the same key to the provider, so its side is idempotent too
  // (payment APIs such as Stripe accept an idempotency key per request).
  const charge = await paymentProvider.charge(
    { orderId, amountCents }, { idempotencyKey: idemKey });

  await pool.query(
    `UPDATE payments SET status = 'SUCCEEDED', provider_ref = $2
     WHERE idempotency_key = $1`, [idemKey, charge.id]);
  return { status: 'SUCCEEDED', provider_ref: charge.id };
}
```

Details that matter: generate the key on the **client** (per attempt, not per click), keep keys long enough to cover retries (e.g. 24 hours), and reject a reused key with **different parameters**.

### Idempotent consumers

With at-least-once delivery, every consumer must handle duplicates. Record processed message IDs in the **same transaction** as the side effect:

```sql
BEGIN;
INSERT INTO processed_messages (message_id) VALUES ($1);  -- PK: fails on duplicate
UPDATE inventory SET reserved = reserved + 1 WHERE product_id = $2;
COMMIT;
```

On a duplicate, the insert violates the primary key, the transaction rolls back, and the consumer acknowledges the message without doing anything. Alternatively, make the operation naturally idempotent: `SET status = 'SHIPPED'` is safe to repeat; `reserved = reserved + 1` is not.

> **Remember:** at-least-once delivery + idempotent consumers = effectively-once processing. That's the realistic goal.

## 7. Event sourcing

**What:** instead of storing current state, store the **sequence of events** that happened (`OrderPlaced`, `ItemAdded`, `PaymentCaptured`, `OrderShipped`). Current state is computed by replaying them, usually with periodic **snapshots** to avoid replaying from the beginning.

**When:** you need a full audit trail (finance, ledgers), want to answer "what did this look like last Tuesday?", or the domain is naturally a stream of events.

**Cost:** event schemas live forever and must be versioned; queries need separate read models (projections); fixing bad data means writing corrective events; and the team must think in events. Overkill for a typical product catalog.

## 8. CQRS

**What:** **Command Query Responsibility Segregation** splits the **write model** (validates commands, enforces invariants) from **read models** (denormalized views built for specific queries), updated asynchronously from events or CDC.

**When:** reads and writes have very different shapes or scale, e.g. checkout writes to normalized tables while the storefront reads a pre-joined product document and a search index. It pairs naturally with event sourcing, but doesn't require it.

**Cost:** read models are **eventually consistent** (a user may not see their order in "My orders" for a moment), more moving parts, and you must be able to rebuild projections. See [Scaling databases](/lessons/scaling-databases) for where this fits in a growing system.

## 9. Common mistakes

- Calling another service **inside** an open database transaction, holding locks while waiting on the network.
- Publishing events with a plain dual write "because it almost never fails".
- Retrying payments without an idempotency key.
- Assuming the broker guarantees exactly-once end to end.
- Writing compensations that aren't idempotent, then running them twice.
- Splitting into microservices so early that checkout needs a saga for what one database transaction could do.

## 10. Decision table

| Situation | Use |
|---|---|
| All data in one database | A local ACID transaction. Don't distribute what you don't need to. |
| Few participants, all support XA, short transactions, same data centre | 2PC (accept blocking risk) |
| Multi-step business flow across services or external APIs | Saga (orchestration once it has more than a few steps) |
| Must update DB and notify other services | Transactional outbox + relay/CDC |
| Any retried request with side effects (payments, orders) | Idempotency key + unique constraint |
| Consuming events | Idempotent consumer (dedup table or natural idempotency) |
| Audit trail / temporal queries are core requirements | Event sourcing |
| Read and write workloads very different | CQRS with read models |

The best distributed transaction is the one you avoid: keep data that must change atomically **in the same service and database** whenever the domain allows it.
