---
slug: postgres-mvcc-and-vacuum
title: 'MVCC and VACUUM: why PostgreSQL never overwrites a row'
module: Internals
order: 80
summary: How PostgreSQL stores multiple versions of each row with xmin and xmax, how snapshots decide what you see, why that creates dead tuples, and how VACUUM, autovacuum, HOT updates and freezing keep the database healthy.
level: advanced
tags: [postgresql, mvcc, vacuum, autovacuum, bloat, hot-updates, wraparound, internals]
recap: >-
  PostgreSQL never updates a row in place: an UPDATE writes a new row version and marks the old one with xmax, and
  each transaction's snapshot decides which version it sees, so readers and writers don't block each other. Old
  versions become dead tuples that VACUUM marks as reusable space; VACUUM FULL rewrites the table but locks it
  completely. Autovacuum does this automatically and also refreshes statistics and freezes old rows to prevent
  transaction ID wraparound, so never disable it and watch out for long-running or idle-in-transaction sessions that block cleanup.
---

## 1. The story

Your store's **product catalogue** is a shared document. Imagine two ways to edit it.

- **The whiteboard**: you erase the old price and write the new one. Anyone reading during the edit must wait, or they'll see half-erased text.
- **The ledger with history**: you never erase. You **strike through** the old line with a note "replaced by edit #1879" and write a **new line** below. Someone who started reading before your edit keeps reading the old line; newcomers read the new one. Nobody waits.

The ledger has one problem: it fills up with struck-through lines. So a **clerk** comes by regularly and blanks out lines that **no reader could possibly still need**, so new entries can reuse the space.

| Ledger | PostgreSQL |
|---|---|
| A line in the ledger | A **tuple** (one physical version of a row) |
| "Written by edit #1877" | **`xmin`**: the transaction ID that created the version |
| "Struck through by edit #1879" | **`xmax`**: the transaction ID that deleted or replaced it |
| Line number on the page | **`ctid`**: physical location `(page, item)` |
| Which edits a reader is allowed to see | A **snapshot** |
| Struck-through lines nobody needs | **Dead tuples** |
| The clerk | **VACUUM** / **autovacuum** |

That's **MVCC** (multi-version concurrency control).

> **Remember:** in PostgreSQL an UPDATE is really "INSERT a new version + mark the old one as expired". Nothing is overwritten in place.

## 2. Why MVCC exists

Without versions, a reader and a writer touching the same row must take turns (locks). With versions:

- **Readers don't block writers**, and **writers don't block readers**. A long report doesn't stop checkout.
- Every statement sees a **consistent snapshot**, never a half-applied change.
- **Rollback is free**: an aborted transaction's new versions are simply never visible. No undo work needed.

Writers to the **same row** still conflict (row locks; see [PostgreSQL locking](/lessons/postgres-locking)). The price of MVCC is **garbage**: old versions pile up and must be cleaned. The basics of isolation are in [ACID](/lessons/acid); this lesson goes under the hood.

## 3. Seeing versions with your own eyes

Every table has hidden **system columns**. Real output from a scratch database:

```sql
CREATE TABLE inv (product_id int PRIMARY KEY, name text, stock int);
INSERT INTO inv VALUES (1,'Running shoes',10),(2,'Yoga mat',25),(3,'Water bottle',40);
SELECT xmin, xmax, ctid, * FROM inv;
```

```text
 xmin | xmax | ctid  | product_id |     name      | stock
------+------+-------+------------+---------------+-------
 1877 |    0 | (0,1) |          1 | Running shoes |    10
 1877 |    0 | (0,2) |          2 | Yoga mat      |    25
 1877 |    0 | (0,3) |          3 | Water bottle  |    40
```

All three rows were created by transaction **1877**. `xmax = 0` means "not deleted". `ctid (0,1)` = page 0, item 1.

```sql
UPDATE inv SET stock = stock - 1 WHERE product_id = 1;
```

```text
 xmin | xmax | ctid  | product_id |     name      | stock
------+------+-------+------------+---------------+-------
 1879 |    0 | (0,4) |          1 | Running shoes |     9
```

The shoes row has a **new `ctid` (0,4)** and a new `xmin` (1879). It's a brand new tuple. The old one at `(0,1)` still physically exists with `xmax = 1879`; you just can't see it any more.

```sql
DELETE FROM inv WHERE product_id = 3;
```

The bottle disappears from results, but its tuple at `(0,3)` is still on the page with `xmax` set. The statistics confirm it:

```text
 n_live_tup | n_dead_tup | n_tup_upd | n_tup_hot_upd | n_tup_del
------------+------------+-----------+---------------+-----------
          2 |          2 |         1 |             1 |         1
```

Two dead tuples: the old shoes version and the deleted bottle.

### An uncommitted change, seen from another session

Session A runs `BEGIN; UPDATE inv SET stock = stock - 1 WHERE product_id = 2;` (transaction 1892) and doesn't commit yet. Session B reads:

```text
 xmin | xmax | ctid  | product_id |   name   | stock
------+------+-------+------------+----------+-------
 1877 | 1892 | (0,2) |          2 | Yoga mat |    25
```

B still sees the **old** version (25), but its `xmax` already says 1892. Because 1892 hasn't committed, the version is still valid for B. After A commits, B sees `xmin 1892, ctid (0,5), stock 24`.

Note: `xmax ≠ 0` doesn't always mean deleted. It's also set by an aborted delete or by a row lock such as `SELECT ... FOR UPDATE`.

What page 0 physically holds once everything has committed (`SELECT` hides the dead tuples, so this is a sketch, with the delete running as transaction 1880):

```text
 page 0 of table inv
 ┌───────┬──────────────────────────────────────────────┐
 │ (0,1) │ shoes  10  xmin 1877  xmax 1879   ← dead     │
 │ (0,2) │ mat    25  xmin 1877  xmax 1892   ← dead     │
 │ (0,3) │ bottle 40  xmin 1877  xmax 1880   ← dead     │
 │ (0,4) │ shoes   9  xmin 1879  xmax 0      ← live     │
 │ (0,5) │ mat    24  xmin 1892  xmax 0      ← live     │
 └───────┴──────────────────────────────────────────────┘
```

## 4. Snapshots decide visibility

A **snapshot** records: the oldest transaction still running, the next transaction ID to be assigned, and the list of transactions in progress. Simplified rule for "can my snapshot see this tuple?":

1. The creator (`xmin`) **committed** and was already committed when my snapshot was taken (or it's my own transaction), **and**
2. The deleter (`xmax`) is empty, **or aborted**, **or not yet visible** to my snapshot.

Commit status lives in a small structure called the commit log (`pg_xact`); PostgreSQL caches the answer in **hint bits** on the tuple so later readers don't have to look it up.

When the snapshot is taken depends on the isolation level: per statement at Read Committed, per transaction at Repeatable Read and Serializable. See [Isolation levels](/lessons/postgres-isolation-levels).

> **Remember:** every tuple carries "born in xmin, died in xmax". Your snapshot compares those IDs with the list of transactions it considers committed. That's the whole trick.

## 5. Dead tuples and bloat

A **dead tuple** is a version no running or future snapshot can see. Until it's cleaned, it still takes disk space and gets read by Seq Scans. **Bloat** is a table (or index) much bigger than its live data.

Real demo: 100,000 products, then two full-table stock updates, autovacuum disabled on this table to see the effect:

```text
 step                     size     n_live_tup  n_dead_tup
 ──────────────────────   ──────   ──────────  ──────────
 after INSERT             13 MB       100000           0
 after 2 x UPDATE all     40 MB       100000      200000
 after VACUUM             40 MB       100000           0
 after VACUUM FULL        13 MB       100000           0
```

Two things to notice:

- Every UPDATE of every row **tripled** the table, because each wrote 100,000 new versions.
- **Plain VACUUM did not shrink the file.** It made the space **reusable** for future inserts and updates. Only VACUUM FULL gave the space back to the operating system.

## 6. VACUUM vs VACUUM FULL vs autovacuum

| | `VACUUM` | `VACUUM FULL` | Autovacuum |
|---|---|---|---|
| What it does | Removes dead tuples, records free space, updates visibility map, freezes old rows | **Rewrites** the whole table and indexes compactly | Runs `VACUUM` / `ANALYZE` automatically per table |
| Shrinks the file? | Usually no (only trailing empty pages) | Yes | Like VACUUM |
| Lock | `SHARE UPDATE EXCLUSIVE`: reads and writes continue | **`ACCESS EXCLUSIVE`**: nothing else can even read | Like VACUUM, and it **yields** if it blocks someone (except anti-wraparound runs) |
| Disk needed | None extra | A full copy of the table | None extra |
| When | Manually after big batch changes | Rarely, in a maintenance window | Always on |

For shrinking a bloated table without a long lock, teams use the `pg_repack` extension instead of VACUUM FULL.

### Autovacuum thresholds

Autovacuum vacuums a table when:

```text
dead tuples > autovacuum_vacuum_threshold
              + autovacuum_vacuum_scale_factor × table rows
            = 50 + 0.2 × rows                  (defaults)
```

It also runs `ANALYZE` when changed rows exceed `50 + 0.1 × rows`, and since PostgreSQL 13 it vacuums insert-only tables too (so they get frozen and their visibility map updated).

On a 100-million-row `orders` table, 20% means waiting for **20 million** dead tuples. Tune big, busy tables individually:

```sql
ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.01,
                        autovacuum_analyze_scale_factor = 0.02);
```

Why you must **never disable autovacuum**: bloat grows forever, statistics go stale (bad plans), index-only scans stop working, and eventually transaction ID wraparound forces an emergency vacuum anyway (section 10). If autovacuum is "too expensive", it's usually running too *rarely*, so each run has too much to do. Make it run more often and give it more I/O budget (`autovacuum_vacuum_cost_limit`).

> **Remember:** VACUUM = make dead space reusable, no blocking. VACUUM FULL = shrink, but locks the table completely. Autovacuum = the default you tune, never turn off.

## 7. HOT updates and fillfactor

Normally an UPDATE must also add an entry to **every index** pointing to the new tuple, even if no indexed column changed. That's expensive.

A **HOT (heap-only tuple) update** skips the indexes. Conditions:

1. **No indexed column** changes, and
2. The new version **fits on the same page** as the old one.

The index keeps pointing to the old tuple, which links to the new one inside the page. Old HOT versions can also be cleaned up by **page pruning** during normal reads and writes, without waiting for VACUUM.

Tables are filled to 100% by default, leaving no room for condition 2. `fillfactor` reserves space:

```sql
CREATE TABLE inv_hot (product_id int PRIMARY KEY, stock int, note text)
WITH (fillfactor = 80);
```

Real result: updating `stock` on 5,000 of 10,000 freshly inserted rows gave `n_tup_upd = 5000`, `n_tup_hot_upd = 1308`. The first updates on each page fit in the reserved 20%; once a page was full, the rest became normal updates. On a real update-heavy table, pruning and VACUUM keep freeing in-page space, so the HOT ratio is usually much higher.

Practical tips: don't index columns that change constantly (like `stock` or `last_seen_at`) unless you query by them, and consider `fillfactor` 70–90 for update-heavy tables. Watch `n_tup_hot_upd / n_tup_upd` in `pg_stat_user_tables`.

## 8. The visibility map and free space map

Each table has two small helper files:

- **Visibility map (VM)**: two bits per page: **all-visible** (every tuple visible to everyone) and **all-frozen**. **Index-only scans** use it to skip the table for all-visible pages, and VACUUM uses it to skip pages that need no work. In the [EXPLAIN lesson](/lessons/postgres-explain), an un-vacuumed `order_items` table showed `Heap Fetches: 999900` on an Index Only Scan for exactly this reason.
- **Free space map (FSM)**: how much free space each page has, so inserts and non-HOT updates can reuse space that VACUUM freed instead of growing the file.

Both are maintained by VACUUM, which is one more reason autovacuum matters even for tables that rarely see deletes.

## 9. Long transactions: the clerk can't clean what someone might read

VACUUM can only remove a dead tuple if **no snapshot anywhere** might still need it. One old snapshot holds back cleanup for the **whole database**, not just the tables it touched.

Real demo: a Repeatable Read transaction sat idle with its snapshot while another session updated 1,000 rows and ran VACUUM:

```text
tuples: 3988 removed, 11000 remain, 1000 are dead but not yet removable
```

Those 1,000 versions must stay because the old snapshot could still read them. Typical culprits:

- A session **`idle in transaction`**: the app ran `BEGIN`, a query, then waited on an HTTP call or forgot to commit.
- A multi-hour analytics query or `pg_dump` on the primary.
- An abandoned **replication slot**, or `hot_standby_feedback` from a replica running long queries.
- A forgotten prepared transaction (`PREPARE TRANSACTION`).

Find them:

```sql
SELECT pid, state, now() - xact_start AS xact_age, backend_xmin, left(query, 50)
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY xact_start;
```

Defend with `idle_in_transaction_session_timeout` (e.g. `'60s'`), which terminates sessions that sit idle inside a transaction.

> **Remember:** a single forgotten open transaction makes every table in the database bloat. Watch `idle in transaction` and the oldest `xact_start`.

## 10. Transaction ID wraparound and freezing

Transaction IDs are **32-bit**: about 4.2 billion values. PostgreSQL compares them **in a circle**: for any transaction, roughly 2 billion IDs are "in the past" and 2 billion "in the future". A busy store can burn through billions of IDs in a few years.

The danger: a row written by transaction 100 would, after about 2 billion more transactions, suddenly look like it was written **in the future**, so it would become invisible. Data wouldn't be deleted, but it would vanish from queries.

The fix is **freezing**: VACUUM marks tuples old enough to be visible to everyone as **frozen**, meaning "older than any transaction, always visible", so their `xmin` no longer matters.

- Each table tracks `relfrozenxid`, the oldest unfrozen XID it may contain. `age(relfrozenxid)` says how far behind it is.
- When that age passes **`autovacuum_freeze_max_age`** (default 200 million), autovacuum launches an **anti-wraparound vacuum** on that table, **even if autovacuum is disabled**, and it doesn't yield to other lock requests.
- If freezing still can't keep up, PostgreSQL starts **warning**, and close to the limit it **refuses to assign new transaction IDs** (no more writes) until a vacuum completes. That's a real outage.

```sql
SELECT datname, age(datfrozenxid) FROM pg_database;
SELECT relname, age(relfrozenxid) FROM pg_class
WHERE relkind = 'r' ORDER BY 2 DESC LIMIT 10;
```

Alert well before the age approaches 2 billion. What blocks freezing is the same as section 9: long transactions, stuck replication slots, and autovacuum that's disabled or too throttled.

## 11. Monitoring checklist

```sql
SELECT relname,
       n_live_tup,
       n_dead_tup,
       round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       n_tup_hot_upd,
       last_vacuum,
       last_autovacuum,
       last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;
```

| Symptom | Likely cause |
|---|---|
| `n_dead_tup` keeps growing, `last_autovacuum` old | Thresholds too high for a big table, or autovacuum throttled |
| VACUUM runs but "dead but not yet removable" | Long or idle-in-transaction session, replication slot |
| Table size grows while row count is flat | Bloat: updates outpace vacuum |
| `age(datfrozenxid)` climbing toward hundreds of millions | Freezing blocked; investigate now |
| Index-only scans with many heap fetches | Visibility map not maintained |

## 12. Gotchas

- **"VACUUM will shrink my table."** It won't, usually. It makes space reusable.
- **Running VACUUM FULL on a live production table.** It takes an `ACCESS EXCLUSIVE` lock for the whole rewrite: even `SELECT`s wait.
- **Updating every row "just to touch it"** (e.g. `UPDATE orders SET updated_at = now()`) doubles the table. Batch big backfills and let vacuum keep up between batches.
- **`count(*)` is slow** partly because of MVCC: visibility is per snapshot, so PostgreSQL can't keep a single global row counter. Use `reltuples` for an estimate.
- **Disabling autovacuum for a bulk load** and forgetting to re-enable it.
- **Thinking deletes free space immediately.** A `DELETE` of 10 million rows creates 10 million dead tuples; space is reusable only after vacuum.

## 13. Don't confuse: three ways to keep old versions

| | PostgreSQL | MySQL InnoDB | MongoDB (WiredTiger) |
|---|---|---|---|
| Where old versions live | In the **table itself** (heap) | In a separate **undo log** | In-memory update chains; older versions spill to a history store file |
| UPDATE writes | A new full row version | The row **in place** + an undo record | A new version in the cache |
| Cleanup | **VACUUM** / autovacuum | **Purge** threads trim the undo log | Automatic as old snapshots end |
| Long transactions cause | Table and index **bloat** | Undo log ("history list") growth, slower reads | Cache pressure; transactions are limited to 60 s by default |
| Rollback cost | Free (versions just stay invisible) | Must apply the undo log | Discard the uncommitted updates |

## 14. Trade-offs

- **MVCC's win** is concurrency and cheap rollback. **Its cost** is write amplification on updates and the need for vacuum.
- **Update-heavy tables** (counters, sessions, carts) bloat fastest. Consider HOT-friendly design (fewer indexes on hot columns, fillfactor), or move very hot counters out (e.g. Redis, or batch increments).
- **Append-only data** (orders, events) is MVCC-friendly: few dead tuples; freezing is the main maintenance. Time-based [partitioning](/lessons/postgres-partitioning) lets you drop old data with no bloat at all.
- **Vacuum is I/O**. Throttling it too much is as dangerous as not running it: the backlog just grows.
