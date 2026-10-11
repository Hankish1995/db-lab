---
slug: postgres-replication
title: 'Replication and high availability: copies, failover and backups'
module: Scaling
order: 120
summary: How PostgreSQL streams WAL to standby servers, the async vs sync trade-off, replication lag and slots, logical replication, how failover really happens, and why backups are a separate thing.
level: advanced
tags: [postgresql, replication, streaming-replication, wal, high-availability, failover, patroni, pitr, backups]
recap: >-
  A PostgreSQL primary streams its WAL to standbys that replay it and can serve read-only queries. Replication
  is asynchronous by default, so a crash can lose the last commits and replicas can lag; synchronous commit
  removes that loss at the cost of latency and availability. Slots keep the WAL a replica still needs but can
  fill the disk if abandoned. PostgreSQL does not fail over by itself: tools like Patroni or a managed service
  promote a standby and fence the old primary. Replication is not a backup; PITR needs a base backup plus archived WAL.
---

## 1. The story

A bank's head office writes every transaction in a **journal** before touching the ledgers. A courier carries each new journal page to two **branch offices**, which copy the entries into their own ledgers.

- Customers can **ask questions** at a branch ("what's my balance?"), but only the head office **accepts deposits**.
- A branch might be **a few pages behind** if the courier is slow.
- If the head office burns down, the branches **don't decide on their own** who takes over. A **manager** with a phone checks who is up to date, appoints the new head office, and makes sure the old one stays closed even if it reopens.
- None of this protects against a clerk **writing a wrong entry**: the courier copies mistakes too. For that you keep **archived journals** in a vault.

| Bank | PostgreSQL |
|---|---|
| Journal | **WAL** (write-ahead log) |
| Head office | **Primary**: the only server accepting writes |
| Branch offices | **Standbys** (replicas) |
| Answering questions at a branch | **Hot standby**: read-only queries |
| Courier | **Streaming replication** (walsender → walreceiver) |
| Pages behind | **Replication lag** |
| The manager | A failover tool like **Patroni**, or your cloud provider |
| Keeping the old office closed | **Fencing** |
| Archived journals in a vault | **Base backup + WAL archive** |

> **Remember:** a standby is a copy that keeps replaying the primary's WAL. It's for availability and reads, not for undoing mistakes.

## 2. Why it exists

A single server is a single point of failure: a dead disk, a crashed VM or an OS upgrade takes your shop offline. Replication gives you:

- **High availability (HA):** a standby that can become primary in seconds to minutes.
- **Read scaling:** reports, search pages and analytics on replicas.
- **Disaster recovery:** a copy in another zone or region.

It does **not** add write capacity: every standby replays every write. For that, see [Sharding](/lessons/sharding).

## 3. How physical streaming replication works

Every change is first written to the **WAL** (see [PostgreSQL architecture](/lessons/postgres-architecture)). WAL is the source of truth: after a crash, PostgreSQL rebuilds its data files by replaying it. A standby simply does that **forever**: it stays in recovery mode, receives WAL from the primary and replays it.

```text
  App ── writes ──►┌──────────────────┐
                   │     PRIMARY      │
                   │ WAL ... 0/5050E9 │
                   └──┬────────────┬──┘
           walsender  │            │  walsender
          ┌───────────┘            └───────────┐
 ┌────────▼────────┐                  ┌────────▼────────┐
 │    STANDBY 1    │                  │    STANDBY 2    │
 │ walreceiver     │                  │ walreceiver     │
 │ replays WAL     │                  │ replays WAL     │
 │ read-only SQL ◄─┼── App reads ────►┼─ read-only SQL  │
 └─────────────────┘                  └─────────────────┘
```

Key facts:

- It's **physical**: bytes of data pages, so the standby is an exact block-level copy of the **whole cluster** (all databases), on the **same major version**.
- A standby is created from a **base backup**, e.g. `pg_basebackup -h primary -U replicator -D /data -R`. The `-R` flag writes `standby.signal` and `primary_conninfo` so it starts as a standby.
- With **`hot_standby = on`** (the default) the standby serves **read-only** queries. Writes fail with `cannot execute INSERT in a read-only transaction`.

Monitor it on the primary:

```sql
SELECT application_name, state, sync_state, replay_lag,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS bytes_behind
FROM pg_stat_replication;
```

An **LSN** (log sequence number, like `0/5050E988`) is a position in the WAL. Comparing LSNs tells you exactly how far behind a standby is.

## 4. Asynchronous vs synchronous replication

By default replication is **asynchronous**: the primary commits, replies "OK" to the app, and ships WAL afterwards.

```text
 ASYNCHRONOUS (default)
 App          Primary                  Standby
  │── COMMIT ──►│ write + flush WAL       │
  │◄──── OK ────┤                         │
  │             ├──── WAL (soon after) ──►│ replay

 SYNCHRONOUS (synchronous_commit = on)
 App          Primary                  Standby
  │── COMMIT ──►│ write + flush WAL       │
  │             ├──── WAL ───────────────►│ flush to disk
  │             │◄─────────── ack ────────┤
  │◄──── OK ────┤                         │
```

With async, if the primary dies right after replying "OK", the last few commits may **never reach the standby**. Promote it, and those orders are gone.

To go synchronous, name the standbys whose confirmation commits must wait for:

```sql
-- postgresql.conf on the primary (application_name of each standby)
-- synchronous_standby_names = 'ANY 1 (standby1, standby2)'
-- synchronous_commit = on
```

`synchronous_commit` decides **how far** the standby must get before the commit returns:

| Value | Commit waits until… | Loses data if… |
|---|---|---|
| `off` | Nothing; even the local WAL flush is async | Primary crashes (last few hundred ms; no corruption) |
| `local` | Local WAL flush only | Primary is lost before WAL ships |
| `remote_write` | Standby **received and wrote** it (OS cache) | Both primary and standby OS crash |
| `on` (default) | Standby **flushed** it to disk | Both servers' disks are lost |
| `remote_apply` | Standby **replayed** it: visible to queries there | Same as `on`, plus slowest |

Without `synchronous_standby_names`, `on`, `remote_write` and `remote_apply` all behave like `local`. That's why default PostgreSQL is "durable locally, async to replicas".

The trade-off:

- **Latency:** every commit waits a network round trip (worse across regions).
- **Availability:** if the required standby is down, commits **hang**, not fail. With `FIRST 1 (standby1)` and one standby, a standby outage stops your writes. `ANY 1 (standby1, standby2)` with two standbys avoids that.
- It's settable **per transaction**: `SET LOCAL synchronous_commit = off` for low-value events, full sync for payments.

> **Remember:** async = fast, but a failover can lose the last commits. Sync = no loss, but slower commits that stall if no sync standby is available.

## 5. Replication lag and read-your-writes

With async replicas, a standby may be milliseconds (or, under load, seconds or minutes) behind. Classic bug:

1. A customer changes their shipping address (write → primary).
2. The next page reads the profile from a replica.
3. They see the **old address** and think the save failed.

Practical fixes, from simplest:

- **Read from the primary after a write**, e.g. for that user for the next few seconds, or for all "my account" pages.
- **Sticky sessions:** route a user who just wrote to the primary for a short window.
- **Check the LSN:** remember the primary's WAL position after the write, and only use a replica that has replayed past it.

```js
// After a write on the primary
const { rows } = await primary.query('SELECT pg_current_wal_lsn() AS lsn');
req.session.minLsn = rows[0].lsn;

// Before a read: is the replica caught up?
async function poolFor(minLsn) {
  if (!minLsn) return replica;
  const { rows } = await replica.query(
    'SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS ok', [minLsn]);
  return rows[0].ok ? replica : primary;
}
```

`synchronous_commit = remote_apply` also guarantees read-your-writes on the **synchronous** standbys, at a latency cost on every commit.

⚠️ Long queries on a standby can be **cancelled** with `canceling statement due to conflict with recovery`, when replay needs to remove rows the query still sees. `max_standby_streaming_delay` (default 30 s) controls how long replay waits; `hot_standby_feedback = on` prevents most cancellations but can cause **bloat on the primary**, because VACUUM must keep those old rows.

## 6. Replication slots

Normally the primary recycles old WAL files once it doesn't need them. If a standby disconnects for an hour and the WAL it needs is gone, it can't catch up and must be rebuilt from a new base backup.

A **replication slot** fixes that: the primary **keeps all WAL the slot's consumer hasn't confirmed yet**.

The danger: an **abandoned slot** (a deleted replica, a dead CDC pipeline) makes the primary keep WAL **forever**. `pg_wal` grows until the **disk fills and the primary stops**. This is one of the most common PostgreSQL outages.

```sql
SELECT slot_name, slot_type, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;

SELECT pg_drop_replication_slot('old_replica');   -- when it's truly unused
```

Safety nets: alert on `active = false` or growing `retained_wal`, and set **`max_slot_wal_keep_size`** so a slot is invalidated instead of filling the disk.

> **Remember:** a replication slot is a promise to keep WAL. An unused slot keeps that promise until your disk is full.

## 7. Logical replication

**Logical replication** sends **row changes** ("insert this row into `products`"), decoded from the WAL, instead of raw pages. It needs `wal_level = logical`.

```sql
-- On the source
CREATE PUBLICATION shop_pub FOR TABLE products, orders;

-- On the target (tables must already exist there)
CREATE SUBSCRIPTION shop_sub
  CONNECTION 'host=old-db dbname=shop user=replicator'
  PUBLICATION shop_pub;
```

Uses: **major-version upgrades** with little downtime, copying **some tables** to another database, and **change data capture (CDC)** (e.g. Debezium streaming changes to Kafka).

| | Physical (streaming) | Logical |
|---|---|---|
| Unit | WAL bytes / pages | Row changes per table |
| Scope | Whole cluster | Chosen tables |
| Versions | Same major version | Can differ (upgrades) |
| Target | Read-only standby | Normal writable database |
| DDL (schema changes) | Replicated | ❌ Not replicated, apply yourself |
| Typical use | HA, read replicas | Upgrades, partial copies, CDC |

Gotchas: tables need a **primary key** (or a replica identity) for `UPDATE`/`DELETE`, and sequences need separate handling.

## 8. Failover: who picks the new primary?

**PostgreSQL itself never elects a new primary.** A standby becomes primary only when told: `pg_ctl promote` or `SELECT pg_promote();`. Deciding **when** and **which** standby is the job of external tooling:

- **Patroni** runs next to each node and uses a consensus store (**etcd**, **Consul**, ZooKeeper or Kubernetes) to hold a **leader lock**. The primary must keep renewing it; if it can't, a healthy, up-to-date standby takes the lock and is promoted.
- **Managed services** (Amazon RDS / Aurora, Google Cloud SQL, Azure) do this for you and move a DNS endpoint.

### Split-brain and fencing

**Split-brain** is when two servers both believe they are primary and accept writes: orders land in two diverging databases that can't be merged cleanly. It happens when the old primary was only **cut off**, not dead, and comes back.

**Fencing** makes sure the old primary can't accept writes: Patroni demotes a primary that loses its leader lock, and can use a watchdog to reboot it; other setups cut its power or network ("STONITH: shoot the other node in the head"). The old primary later rejoins as a standby, often using **`pg_rewind`** to discard its divergent WAL.

Your app needs a **stable endpoint** that follows the primary: a DNS name, a virtual IP, HAProxy driven by Patroni's health checks, or the provider's endpoint. Expect a few seconds to a minute of errors, and **retry** idempotent operations.

> **Remember:** promotion is a single command; *safe* failover (choosing the right standby and fencing the old one) needs Patroni or a managed service.

## 9. Backups are not replication

Run `DELETE FROM orders;` by mistake and every standby deletes them too, within milliseconds.

| | `pg_dump` (logical) | Base backup + WAL archiving |
|---|---|---|
| What | SQL / custom-format dump of one database | Copy of data files + every WAL segment since |
| Restore to | The moment the dump started | **Any point in time** (PITR) |
| Speed on big DBs | Slow to dump and restore | Fast restore of files, then replay |
| Good for | Small DBs, migrations, copying a schema | Production disaster recovery |

**Point-in-time recovery (PITR):** restore the last base backup, then replay archived WAL up to `recovery_target_time = '2026-10-11 14:29:00'`, one minute before the bad `DELETE`. WAL is shipped with `archive_mode = on` plus an `archive_command`; tools like **pgBackRest**, **Barman** or **WAL-G** handle this properly.

Two numbers frame every HA/backup design:

- **RPO** (Recovery Point Objective): how much data you can afford to **lose**, measured in time. Async replica: seconds. Sync: zero. Nightly `pg_dump`: up to 24 hours.
- **RTO** (Recovery Time Objective): how long you can afford to be **down**. Automatic failover: under a minute or so. Restoring 2 TB from backup: hours.

> **Remember:** replication protects against losing a **server**; backups protect against losing **data**. Test restores, or you don't have backups.

## 10. PostgreSQL vs MongoDB replica sets

Compare with [MongoDB replication](/lessons/mongodb-replication):

| | PostgreSQL | MongoDB replica set |
|---|---|---|
| Log shipped | WAL (physical) | Oplog (logical, idempotent ops) |
| Default ack | Local commit; async to replicas | `w: 'majority'` |
| Electing a new primary | ❌ External (Patroni, cloud) | ✅ Built-in elections |
| Split-brain protection | External consensus + fencing | Majority vote in the protocol |
| Driver follows failover | Via a stable endpoint | ✅ Driver discovers new primary |
| Replica reads | Hot standby | `readPreference` |

## 11. Common mistakes and gotchas

- **Treating a replica as a backup.** Mistakes replicate instantly.
- **Abandoned replication slots** filling `pg_wal`.
- **One synchronous standby** with `FIRST 1`: when it dies, all commits hang.
- **Reading from replicas right after writes**, causing "my change didn't save" bugs.
- **Promoting a standby by hand without fencing** the old primary: split-brain.
- **Cancelling a waiting synchronous commit:** the transaction is already committed locally, just maybe not replicated.
- **Never testing failover or restores** until the real outage.

## 12. Trade-offs

- **More copies cost more:** each standby is a full copy of the cluster.
- **Sync vs async** is a direct trade of commit latency and write availability against RPO.
- **Replica reads** scale reads but bring staleness and query cancellations.
- **Self-managed HA** (Patroni, etcd, HAProxy, pgBackRest) is real operational work; a managed service trades money and some control for not doing it yourself.
