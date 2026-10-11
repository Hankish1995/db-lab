---
slug: postgres-isolation-levels
title: 'Isolation levels in PostgreSQL: what really happens under the hood'
module: Transactions
order: 70
summary: How PostgreSQL's Read Committed, Repeatable Read and Serializable actually behave with snapshots, concurrent updates and write skew, how to retry serialization failures, and which level to choose.
level: advanced
tags: [postgresql, isolation-levels, transactions, snapshot-isolation, ssi, serializable, write-skew, concurrency]
recap: >-
  Read Committed, the default, takes a fresh snapshot for every statement; when two updates hit the same row the
  second waits and then re-checks its WHERE on the new version, which can surprise you. Repeatable Read is snapshot
  isolation: one snapshot per transaction, no phantoms, and an error instead of overwriting a concurrent update, but
  write skew is still possible. Serializable adds SSI, which detects dangerous read/write patterns and aborts one
  transaction with SQLSTATE 40001, so the application must retry. Read Uncommitted behaves like Read Committed.
---

## 1. The story

Three shop managers count stock while customers keep buying.

- **Manager A (Read Committed)** looks at the live shelf **before every sentence** they write. Each line of their report is accurate for the moment it was written, but line 1 and line 5 may describe different moments.
- **Manager B (Repeatable Read)** takes **one photo** of the shelves at the start and writes the whole report from that photo. Perfectly consistent, but if they try to change an item that someone else changed since the photo, they're told "your photo is out of date, start again".
- **Manager C (Serializable)** also works from a photo, but a **referee** watches what every manager *read* and *wrote*. If the combined result couldn't have happened with managers working one at a time, the referee cancels one of them.

| Shop | PostgreSQL |
|---|---|
| Looking at the shelf | Taking a **snapshot** |
| Before every sentence | **Read Committed**: snapshot per **statement** |
| One photo for the whole report | **Repeatable Read**: snapshot per **transaction** (snapshot isolation) |
| The referee | **SSI** (Serializable Snapshot Isolation) |
| "Start again" | **Serialization failure**, SQLSTATE `40001` |

The anomalies themselves (dirty read, lost update, phantom, write skew) are covered in [Concurrency and locking](/lessons/concurrency-and-locking). This lesson is about what PostgreSQL *really does*.

> **Remember:** in PostgreSQL an isolation level is mostly a question of **when the snapshot is taken** and **what happens when you collide with a concurrent writer**.

## 2. Snapshots: the engine behind every level

PostgreSQL uses **MVCC**: an update writes a new row version instead of overwriting. A **snapshot** is a small record saying "transactions committed before this point are visible to me, those still running or started later are not". Every read uses a snapshot, so readers never see uncommitted data, at any level. How row versions work is covered in [MVCC and VACUUM](/lessons/postgres-mvcc-and-vacuum).

```text
 Level             Snapshot taken          On concurrent update of
                                           the same row
 ───────────────   ─────────────────────   ─────────────────────────
 Read Committed    at every statement      wait, re-check, continue
 Repeatable Read   at 1st statement of tx  wait, then ERROR 40001
 Serializable      at 1st statement of tx  ERROR 40001, plus SSI
                                           checks on reads
```

Note: the snapshot of a Repeatable Read transaction is taken at its **first query**, not at `BEGIN`.

## 3. Read Committed (the default)

Each **statement** sees everything committed before that statement started. Two identical `SELECT`s in one transaction can return different results.

### Two UPDATEs on the same row

When your `UPDATE` finds a row that another transaction has updated but not committed, it **waits** for the row lock. When the other transaction commits, PostgreSQL does not start over. It takes the **new version of that row**, **re-evaluates your `WHERE`** against it, and updates it only if it still matches.

That's why `UPDATE products SET stock = stock - 1 WHERE id = 1 AND stock > 0` is safe at Read Committed: the second buyer re-checks `stock > 0` on the fresh value.

### The surprising consequence

Two deal products: Headphones at 900 and Speaker at 1100. An admin swaps their prices in one transaction. At the same moment, a job flags every product under 1000.

```text
 T1 (admin)                       T2 (flag job, Read Committed)
 ──────────────────────────────   ──────────────────────────────
 BEGIN;
 UPDATE: Headphones → 1100,
         Speaker    → 900
                                  UPDATE deal_products
                                  SET flagged = true
                                  WHERE price < 1000;
                                  -- snapshot sees Headphones=900
                                  -- tries to lock it ... WAITS
 COMMIT;
                                  -- re-checks Headphones: 1100
                                  -- no longer < 1000, skip
                                  UPDATE 0
```

Real result (verified, the second session waited about 2 seconds):

```text
UPDATE 0
 id |    name    | price | flagged
----+------------+-------+---------
  1 | Headphones |  1100 | f
  2 | Speaker    |   900 | f
```

At every committed moment **exactly one** product cost less than 1000, yet nothing was flagged. T2 only re-checks the rows **its own snapshot** found; the Speaker didn't match in that snapshot, so it was never considered. The statement saw a mix of "before" and "after".

For simple single-row updates this is fine. For multi-row, condition-based updates on rows that others are changing, it can produce results that match neither the old nor the new state.

> **Remember:** at Read Committed a blocked UPDATE re-checks its WHERE on the **newest version of the rows it already found**; it does not re-run the search. Rows that start matching only after the other commit are missed.

## 4. Repeatable Read = snapshot isolation

The whole transaction reads from **one snapshot**. Re-reading gives identical results, and new rows inserted by others never appear. PostgreSQL's Repeatable Read therefore prevents **phantoms** too, which is stricter than the SQL standard requires.

### Concurrent update of the same row: an error, not a wait-and-continue

```sql
-- T2
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT qty FROM stock WHERE product_id = 1;          -- 10 (snapshot taken)
-- meanwhile T1 updated this row and is about to commit
UPDATE stock SET qty = qty - 1 WHERE product_id = 1; -- waits for T1...
```

Real output after T1 committed:

```text
ERROR:  40001: could not serialize access due to concurrent update
```

T2 can't apply its change to a row version its snapshot can't see, and it can't silently overwrite T1 either, so it fails. If T1 had **rolled back**, T2's update would have gone through. The same error applies to `DELETE` and `SELECT ... FOR UPDATE`. So **lost updates are impossible** at this level; the price is that your code must retry.

### Write skew still gets through

Rule: **one coupon per cart**. Each transaction checks the cart, sees no coupon, inserts its own. They write **different rows**, so there's no row conflict to detect.

```text
 T1 (tab 1, RR)                   T2 (tab 2, RR)
 ──────────────────────────────   ──────────────────────────────
 BEGIN ISOLATION LEVEL
   REPEATABLE READ;
 SELECT count(*) ... cart 7 → 0
                                  BEGIN ISOLATION LEVEL
                                    REPEATABLE READ;
                                  SELECT count(*) ... cart 7 → 0
                                  INSERT (7, 'FESTIVE20');
                                  COMMIT;  ✓
 INSERT (7, 'WELCOME10');
 COMMIT;  ✓
 Result: cart 7 has TWO coupons
```

Verified: both commits succeeded and `cart_discounts` ended up with both rows. Fixes at this level: a constraint that encodes the rule (for "one per cart", a unique index on `cart_id` alone), locking a common parent row (`SELECT ... FROM carts WHERE id = 7 FOR UPDATE`) so the two transactions really collide, or Serializable.

> **Remember:** Repeatable Read stops lost updates with error 40001 but **not write skew**: two transactions that read the same data and write different rows can both commit.

## 5. Serializable = Serializable Snapshot Isolation (SSI)

Serializable promises: the result equals **some one-at-a-time order** of the committed transactions. PostgreSQL implements it as snapshot isolation plus **conflict tracking**:

- Reads take **predicate locks** (shown as `SIReadLock` in `pg_locks`). They **don't block** anybody; they're just notes saying "T1 read this range".
- When another transaction writes into a range someone read, PostgreSQL records a **read/write dependency**.
- When dependencies form a **dangerous structure** (a transaction that both has an incoming and an outgoing rw-dependency with concurrent transactions, the "pivot"), one transaction is aborted.

Same coupon race, both at `SERIALIZABLE`. T2 commits first; T1 fails on its `INSERT`:

```text
ERROR:  40001: could not serialize access due to read/write
        dependencies among transactions
DETAIL:  Reason code: Canceled on identification as a pivot,
         during write.
HINT:  The transaction might succeed if retried.
```

Only `FESTIVE20` remains. When T1 retries, its fresh snapshot sees `count = 1` and it rejects the second coupon properly.

Things to know about SSI:

- **No extra blocking**: Serializable doesn't make readers wait. The cost is CPU/memory for tracking and **aborted transactions**.
- **False positives** happen. Tracking can be coarse (page or whole-relation level, e.g. when a query does a Seq Scan), so a transaction can be aborted even if no real anomaly occurred. Good indexes make tracking more precise.
- The error can be raised on a read, a write or at `COMMIT`.
- **All** transactions involved should run at Serializable; a Read Committed transaction mixed in isn't protected.
- `BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE` is useful for long reports: it waits for a safe snapshot and then can never fail with a serialization error.

## 6. You must retry: a Node.js retry loop

At Repeatable Read and Serializable, `40001` is **normal, expected behaviour**, not a bug. Retry the **whole transaction**, including its reads. This code (with the `pg` library) was run against the coupon table: two concurrent calls, one got `40001`, retried, and then correctly saw the coupon already applied.

```js
const { Pool } = require('pg');
const pool = new Pool();

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withSerializableRetry(work, { maxAttempts = 5 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (!RETRYABLE.has(err.code) || attempt === maxAttempts) throw err;
      await sleep(2 ** attempt * 10 + Math.random() * 50); // backoff + jitter
    } finally {
      client.release();
    }
  }
}

async function applyCoupon(cartId, coupon) {
  return withSerializableRetry(async (client) => {
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM cart_discounts WHERE cart_id = $1',
      [cartId]
    );
    if (rows[0].n > 0) throw new Error('Only one coupon per cart');
    await client.query(
      'INSERT INTO cart_discounts (cart_id, coupon) VALUES ($1, $2)',
      [cartId, coupon]
    );
    return coupon;
  });
}
```

Rules for the callback: **no side effects** (emails, HTTP calls, Kafka messages) inside it, because it may run several times; always use the same `client` for every query; cap the attempts.

> **Remember:** Serializable is only correct **with** a retry loop. Without one, it just turns race conditions into random 500 errors.

## 7. Read Uncommitted, and how to set the level

PostgreSQL accepts `READ UNCOMMITTED` but **treats it as Read Committed**. Dirty reads are impossible in PostgreSQL at any level.

```sql
-- For one transaction (most common)
BEGIN ISOLATION LEVEL REPEATABLE READ;

-- Or as the FIRST statement inside the transaction
BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- after any query it fails with:
-- ERROR: SET TRANSACTION ISOLATION LEVEL must be called before any query

-- Default for this session
SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- (equivalent: SET default_transaction_isolation = 'repeatable read';)

-- Default for every connection to a database or for a role
ALTER DATABASE shop SET default_transaction_isolation = 'serializable';
ALTER ROLE reporting SET default_transaction_isolation = 'repeatable read';

SHOW transaction_isolation;   -- check what you're actually running
```

## 8. Performance trade-offs

| | Read Committed | Repeatable Read | Serializable |
|---|---|---|---|
| Extra blocking | None | None | None (predicate locks don't block) |
| Errors to retry | Deadlocks only | + `40001` on same-row update | + `40001` on rw-dependency patterns, incl. false positives |
| Overhead | Lowest | Low | Tracking CPU/memory + retried work |
| Under high contention | Waits | Many aborts on hot rows | Most aborts |
| Long transactions | Hold back vacuum | Hold back vacuum (one old snapshot) | Same + more tracking state |

A long Repeatable Read or Serializable transaction keeps one old snapshot alive for its whole duration, which stops VACUUM from cleaning newer dead rows. Keep them short.

## 9. Which level for which job

| Use case | Level | Why |
|---|---|---|
| Typical CRUD, single-row atomic updates (`stock = stock - 1 WHERE stock > 0`) | Read Committed | Atomic statements are already safe; least overhead |
| Read-modify-write on one row in app code | Read Committed + `SELECT ... FOR UPDATE`, or Repeatable Read + retry | Prevents lost updates |
| Reports, exports, totals that must add up | Repeatable Read (read only) | One consistent snapshot across many queries |
| Rules spanning rows: one coupon per cart, no double-booking a delivery slot, balance across accounts | Serializable + retry (or a constraint / parent-row lock) | Only level that stops write skew automatically |
| Long-running report that must be serializable | `SERIALIZABLE, READ ONLY, DEFERRABLE` | Never aborted |
| Bulk ETL / batch jobs | Read Committed | Avoid huge aborted batches |

## 10. Gotchas

- **"I raised the level, so I'm safe."** Not without a retry loop. And Repeatable Read still allows write skew.
- **Assuming Read Committed reruns your query after waiting.** It only re-checks rows it already found (section 3).
- **Different behaviour from MySQL.** In MySQL InnoDB (default Repeatable Read), plain `SELECT`s read a snapshot but `UPDATE` and locking reads act on the **latest committed** row instead of raising an error, so the lost-update protection you get in PostgreSQL's Repeatable Read isn't there by default.
- **Mixing levels**: SSI only protects transactions that are themselves Serializable.
- **Retrying only the failed statement.** After `40001` the transaction is aborted; you must `ROLLBACK` and redo everything, including the reads that led to your decision.
- **Sequences aren't transactional.** A rolled-back or retried transaction still consumes `nextval()` numbers, so expect gaps in order ids.

## 11. Don't confuse: standard vs PostgreSQL vs others

| Level | SQL standard allows | PostgreSQL actually | MySQL InnoDB | MongoDB transactions |
|---|---|---|---|---|
| Read Uncommitted | Dirty reads | Same as Read Committed | Real dirty reads | n/a |
| Read Committed | Non-repeatable, phantoms | Snapshot per statement | Snapshot per statement | n/a |
| Repeatable Read | Phantoms | Snapshot isolation, no phantoms, error on same-row conflict | Default; snapshot reads, locking "current reads" | n/a |
| Serializable | Nothing | SSI, aborts with 40001 | Plain reads become shared-locking reads | n/a |
| Snapshot | n/a | (= Repeatable Read) | n/a | Snapshot reads, write conflict aborts (retry) |

See [MongoDB transactions](/lessons/mongodb-transactions) for MongoDB's side.

## 12. When not to reach for a higher level

- **One statement can do it.** A conditional `UPDATE ... WHERE stock >= 2` or an `INSERT ... ON CONFLICT DO NOTHING` beats any isolation level.
- **A constraint can encode the rule.** `UNIQUE`, `CHECK`, exclusion constraints (`EXCLUDE USING gist` for overlapping time slots) are enforced for every code path and never need retries.
- **The hot path is extremely contended.** Thousands of Serializable transactions on the same flash-sale product will mostly abort and retry. Use a single atomic statement there.
- **You can't make the work idempotent.** If a retry would charge a card twice, restructure: do the database transaction first and the external call afterwards (outbox pattern).

> **Remember:** Read Committed + atomic statements + constraints handle most of an e-commerce app. Use Serializable deliberately, for the few transactions with cross-row rules, and always with retries.
