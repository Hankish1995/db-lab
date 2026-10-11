---
slug: mongodb-replication
title: 'Replication: keeping copies so one failure never takes you down'
module: Scaling
order: 80
summary: How a MongoDB replica set copies data through the oplog, elects a new primary when one fails, and what that means for your writes and reads.
level: intermediate
tags: [mongodb, replication, replica-set, oplog, failover, elections, high-availability]
recap: >-
  A replica set is one primary that takes all writes and secondaries that copy its oplog, a capped
  collection of idempotent operations. Members send heartbeats every 2 seconds; if the primary is unreachable
  for about 10 seconds, the members with a majority of votes elect a new one. Writes not acknowledged by a
  majority can be rolled back after a failover, which is why w majority matters. Replication gives
  availability and read copies, not more write capacity and not backups.
---

## 1. The story

A busy restaurant has one **head chef** and two **assistant chefs**.

- Only the **head chef** decides on recipe changes: "add more salt to the curry". Every change goes into a **recipe change log**.
- The assistants keep **reading the log** and applying the same changes to their own copy of the recipe book.
- Every couple of seconds, the chefs **glance at each other** to check everyone is still there.
- If the head chef collapses, the assistants notice, and **vote** for one of them to take over. The kitchen keeps cooking.

**That's a replica set.**

| Restaurant | MongoDB |
|---|---|
| Head chef | **Primary**: the only member that accepts writes |
| Assistant chefs | **Secondaries**: copy the primary's data |
| Recipe change log | **Oplog** (operations log) |
| Glancing at each other | **Heartbeats** |
| Voting for a new head chef | **Election** |
| Taking over after a collapse | **Failover** |

> **Remember:** a replica set = one primary that accepts writes + secondaries that copy everything it does.

## 2. Why it exists

With a single server:

- If it **crashes**, your shop is offline.
- If its **disk dies**, your data might be gone.
- **Maintenance** (upgrades, OS patches) means downtime.

Replication fixes this with **redundancy** and **automatic failover**. It also lets you send some reads (analytics, reports) to secondaries.

What it does **not** give you: more **write** capacity. All writes still go to one primary. For that you need [Sharding](/lessons/sharding).

## 3. How it works

### The standard 3-member replica set

```text
                    ┌─────────────────┐
     App (driver) ─►│     PRIMARY     │◄── all writes
                    │  oplog: op1..n  │
                    └───┬─────────┬───┘
      oplog + heartbeat │         │ oplog + heartbeat
         ┌──────────────┘         └─────────────┐
         ▼                                      ▼
 ┌─────────────────┐   heartbeats   ┌─────────────────┐
 │   SECONDARY A   │◄──────────────►│   SECONDARY B   │
 │ applies oplog   │                │ applies oplog   │
 └─────────────────┘                └─────────────────┘
```

Your driver connects with a connection string listing the members (or an `mongodb+srv://` address) and figures out on its own which one is primary.

```text
mongodb://db1:27017,db2:27017,db3:27017/shop?replicaSet=rs0
```

### The oplog

The **oplog** (`local.oplog.rs`) is a **capped collection** on every member: a fixed-size log where the oldest entries are overwritten when it fills up.

When the primary handles a write, it changes the data **and** appends an entry to its oplog. Each secondary **tails** an oplog (like `tail -f` on a file), pulls new entries, applies them to its own data, and writes them to its own oplog.

Oplog entries are **idempotent**: applying one twice gives the same result. MongoDB records the *effect*, not the instruction:

```js
// You run on the primary:
db.products.updateOne({ _id: 'KB-1' }, { $inc: { stock: -2 } })   // stock 10 → 8

// The oplog stores the resulting value, not "decrement by 2" (entry simplified):
// { op: 'u', ns: 'shop.products', o2: { _id: 'KB-1' }, o: { $v: 2, diff: { u: { stock: 8 } } } }
```

Replaying "set stock to 8" twice is harmless; replaying "subtract 2" twice would corrupt data.

⚠️ If a secondary is offline longer than the oplog window (how much time the oplog covers), it **falls off the oplog** and needs a full **initial sync**. Size the oplog for your maintenance windows.

> **Remember:** the oplog is a capped, idempotent log of changes. Secondaries stay in sync by tailing it.

### Heartbeats and elections

- Members send **heartbeats** to each other **every 2 seconds**.
- If the primary doesn't respond within **`electionTimeoutMillis`** (default **10 seconds**), an eligible secondary calls an **election**.
- A candidate needs votes from a **majority of voting members** to win. The member with the most recent data and higher **priority** is favoured.
- With default settings, a new primary is usually elected **within roughly 10–12 seconds** of the old one failing.

### Why an odd number of voting members?

The winner needs a **strict majority** of *all* voting members, not just the reachable ones.

| Voting members | Majority needed | Failures tolerated |
|---|---|---|
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |

A 4th member adds cost but **no extra fault tolerance**. Worse, a network split of 2 + 2 leaves **neither side** with a majority, so there's no primary at all. The majority rule is also what prevents **split brain**: two primaries accepting writes at the same time.

A replica set can have up to 50 members, but at most **7 voting** members.

> **Remember:** elections need a majority of all voters. Use 3 or 5 voting members, never 2 or 4.

## 4. What happens to your writes during failover

```text
 t=0s    Primary db1 crashes
 t=0-10s No heartbeat answers; writes to db1 fail
 t=~10s  db2 calls an election, db3 votes yes → db2 is PRIMARY
 t=~12s  Drivers discover db2 and send writes there
```

During that window **there is no primary**, so writes fail with errors such as "not primary" or network errors.

### Retryable writes

Modern drivers enable **retryable writes** by default (`retryWrites=true`). If a write fails with a network error or "not primary", the driver **retries it once**, after finding the new primary. The server uses a transaction ID to make sure the retry doesn't apply the write twice. Most failovers are therefore invisible to the app, apart from a few seconds of latency.

### Rollback: the write that disappears

Suppose you use `w: 1`:

1. db1 (primary) accepts an order and replies "OK".
2. db1 crashes **before** db2 and db3 copied it.
3. db2 becomes primary and takes new writes. The order isn't there.
4. db1 comes back as a secondary. Its data has diverged, so it **rolls back** the unreplicated order, saving it to a rollback file on disk for manual inspection.

Your customer saw "Order confirmed", but the order is gone from the database.

With **`w: 'majority'`**, the write is acknowledged only after a majority has it. Any member that can win the next election must have that write, so **majority-acknowledged writes are never rolled back**. That's why `w: 'majority'` is the default for most deployments since MongoDB 5.0 (see [Transactions and concerns](/lessons/mongodb-transactions)).

> **Remember:** `w: 1` writes can be rolled back after a failover. `w: 'majority'` writes cannot.

## 5. Replication lag and reading from secondaries

Replication is **asynchronous**. A secondary may be milliseconds (or, under heavy load, seconds or more) behind the primary. That delay is **replication lag**.

```js
// In mongosh: how far behind is each secondary?
rs.printSecondaryReplicationInfo()
rs.status()   // member states, optimes, health
```

If you read from secondaries (`readPreference: 'secondaryPreferred'`), you may get **stale reads**:

1. A customer updates their shipping address (write → primary).
2. The next page reads the profile from a lagging secondary.
3. They see the **old address** and think the save failed.

Use secondary reads for **analytics, reports and search pages** that can tolerate slightly old data. For read-after-write, read from the primary or use a causally consistent session.

## 6. Member types

| Member | Votes? | Can become primary? | Visible to app reads? | Use case |
|---|---|---|---|---|
| Regular secondary | ✅ | ✅ | ✅ | Default |
| **Priority 0** | ✅ | ❌ | ✅ | Weaker machine or a member in a far-away data centre |
| **Hidden** | ✅ (can vote) | ❌ (priority 0) | ❌ | Dedicated reporting or backup node |
| **Delayed** | ✅ (can vote) | ❌ (hidden, priority 0) | ❌ | Applies changes e.g. 1 hour late, a safety net against "oops, I dropped a collection" |
| **Arbiter** | ✅ | ❌ | ❌ (holds no data) | Tie-breaker vote only |

```js
// Make member 2 a delayed, hidden copy one hour behind
cfg = rs.conf()
cfg.members[2].priority = 0
cfg.members[2].hidden = true
cfg.members[2].secondaryDelaySecs = 3600
rs.reconfig(cfg)
```

### Why arbiters are discouraged

An **arbiter** votes but stores no data. A Primary-Secondary-Arbiter (PSA) set looks like a cheap 3-member set, but it only has **two copies** of the data:

- If the secondary goes down, only one data-bearing member is left, so **`w: 'majority'` writes can't be acknowledged**. They block until `wtimeout`.
- Because of this, the default write concern for some arbiter setups falls back to `w: 1`, which brings back rollback risk.
- While the secondary is down, majority-committed data can't advance, which can build up **cache pressure** on the primary.

Prefer a **third data-bearing member** whenever you can afford it.

> **Remember:** an arbiter gives you a vote, not a copy. Three real data-bearing members beat two plus an arbiter.

## 7. A practical note: MongoDB Atlas

Even the **free Atlas cluster** is a **3-member replica set**. That's why transactions, change streams and `w: 'majority'` work out of the box on Atlas but not on a plain local `mongod`. To get the same locally, start `mongod` with `--replSet rs0` and run `rs.initiate()` once.

## 8. Common mistakes and gotchas

- **Thinking replication is a backup.** If you run `db.orders.deleteMany({})`, every secondary faithfully deletes everything too. You still need real backups (snapshots, point-in-time restore). A delayed member helps, but isn't a backup strategy.
- **Using `w: 1` for important data** and being surprised by rollbacks after a failover.
- **Reading from secondaries** for read-after-write pages, causing "my change didn't save" bugs.
- **Connecting to a single host** instead of the replica set connection string, so the driver can't follow a failover.
- **Two data centres with an even split** of voters: if the link between them breaks, neither side has a majority.
- **An oplog that's too small** for heavy write bursts, so lagging secondaries fall off and need a full resync.
- **Expecting secondaries to scale writes.** They apply every write too, so they're just as busy.

## 9. Don't confuse these

| | Replication | Sharding | Backup |
|---|---|---|---|
| What it does | **Same data** on several machines | **Different data** on each machine | **Point-in-time copy** stored elsewhere |
| Protects against | Server or disk failure | Running out of capacity | Bad deletes, corruption, ransomware |
| Scales writes | ❌ | ✅ | ❌ |
| Scales reads | ⚠️ with stale reads | ✅ | ❌ |
| Undo a mistake | ❌ (mistakes replicate) | ❌ | ✅ |

In production you use **all three**: every shard is a replica set, and the whole cluster is backed up.

## 10. Trade-offs

- **Cost:** three data-bearing members means three times the storage and servers.
- **Write latency:** `w: 'majority'` waits for at least one secondary to confirm, adding a network round trip.
- **Stale reads** if you route reads to secondaries.
- **Failover isn't instant:** expect a few seconds without a primary. Retryable writes hide most of it, but timeouts and error handling in your app still matter.

For almost every production MongoDB deployment, those costs are worth it. A standalone server is fine for local development and nothing else.
