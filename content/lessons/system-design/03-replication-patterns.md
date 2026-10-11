---
slug: replication-patterns
title: 'Replication patterns: leaders, followers and what happens when copies disagree'
module: Replication & Consistency
order: 30
summary: The three replication architectures (single-leader, multi-leader, leaderless), synchronous vs asynchronous replication, the anomalies replication lag causes in real apps, and the failover traps of split brain and lost writes.
level: advanced
tags: [replication, system-design, consistency, quorum, replication-lag, failover, split-brain, multi-leader, leaderless]
recap: >-
  Replication keeps copies of the same data on several machines for availability, read scaling and lower latency.
  Single-leader is the default and simplest; multi-leader allows writes in several regions but needs conflict resolution;
  leaderless systems use quorums where W + R > N makes reads and writes overlap. Asynchronous replication is fast but can
  lose acknowledged writes on failover and causes lag anomalies, which you fix with read-your-writes, monotonic reads and
  consistent prefix guarantees. Failover must prevent split brain, typically with majority elections and fencing tokens.
---

## 1. The story: one head chef, many line cooks

A restaurant chain keeps its **recipe book** in sync across kitchens.

- **Single-leader:** only the **head chef** may change a recipe. She sends every change to the other kitchens, which copy it. Anyone may *read* a recipe in any kitchen.
- **Multi-leader:** each city has its own head chef who may change recipes locally, and they exchange changes. Faster for each city, but two chefs might change the same recipe differently on the same day.
- **Leaderless:** there's no head chef. You send a change to several kitchens at once and consider it done when **enough** of them confirm. To read, you ask several kitchens and take the newest version.

| Kitchen | Database |
|---|---|
| Head chef | **Leader** (primary) |
| Kitchens copying changes | **Followers** (replicas, secondaries) |
| The list of changes sent out | **Replication log** (WAL, oplog, binlog) |
| A kitchen that hasn't received yesterday's change | **Replication lag** |
| Two chefs changing the same recipe | **Write conflict** |

This lesson is engine-agnostic. For how a specific database does it, see [MongoDB replication](/lessons/mongodb-replication) and [PostgreSQL replication](/lessons/postgres-replication).

## 2. Why replicate at all

- **High availability:** if a machine dies, another copy takes over.
- **Read scaling:** spread reads across followers.
- **Latency:** put a copy near users in each region.
- **Durability:** data survives a disk or zone failure.

Replication does **not** scale writes in single-leader systems: every follower must apply every write. To scale writes you split the data, see [Sharding](/lessons/sharding).

> **Remember:** replication copies the same data; sharding splits different data. Real systems do both.

## 3. Single-leader (leader-follower)

```text
              writes + reads
  App ───────────────────────────►┌──────────┐
                                  │  Leader  │
                                  └────┬─────┘
                 replication log       │
             ┌─────────────────────────┼──────────────┐
        ┌────▼─────┐              ┌────▼─────┐   ┌────▼─────┐
        │ Follower │              │ Follower │   │ Follower │
        └──────────┘              └──────────┘   └──────────┘
             ▲  reads (possibly stale)
```

All writes go through one node, so there are **no write conflicts**: the leader decides the order. This is the default in PostgreSQL, MySQL, MongoDB replica sets and most managed databases. Its weaknesses are the single writer (a throughput ceiling) and the moment the leader fails (section 7).

## 4. Multi-leader

Each region has a leader that accepts writes and replicates asynchronously to the others. A user in Mumbai writes to the Mumbai leader with low latency, and the region keeps working if the link to Frankfurt is cut.

The price: **write conflicts**. Two leaders can accept conflicting changes to the same record before they hear about each other.

Example: the shared cart of a family account. In Mumbai, Asha sets the shoe quantity to 2. In Frankfurt, at the same time, Ravi removes the shoes. Both leaders accept. When they sync, which wins?

Conflict resolution options:

- **Last-write-wins (LWW):** attach a timestamp; the highest wins, the other is **silently discarded**. Simple, but it **loses data**, and clocks on different machines drift, so "last" may not be last at all.
- **Merge in the application:** store both versions (siblings) and let code or the user resolve them.
- **CRDTs** (Conflict-free Replicated Data Types): data structures designed so concurrent updates always merge to the same result regardless of order. A grow-only counter, an observed-remove set (for cart items), or a collaborative text document. They work well for specific shapes of data, not arbitrary business rules like "stock must not go negative".
- **Avoid conflicts:** route all writes for a given record (e.g. a user's cart) to one "home" leader.

> **Remember:** multi-leader trades conflict-free writes for local writes. If you can't name your conflict resolution strategy, you don't want multi-leader.

## 5. Leaderless (Dynamo-style)

Popularized by Amazon's 2007 Dynamo paper and used by Cassandra and Riak, among others. (Note: the managed **DynamoDB** service, despite the name, uses a leader per partition internally.)

The client (or a coordinator node) sends each write to all **N** replicas of the key and waits for **W** acknowledgements; each read asks replicas and waits for **R** responses, returning the value with the newest version.

```text
 N = 3 replicas, W = 2, R = 2

 write v2 ──► A ✅ v2    B ✅ v2    C ✗ (down, still v1)
 read     ──► A: v2      C: v1   → newest wins → v2
                                   + read repair: C ◄── v2
```

If **W + R > N**, every read set overlaps every write set in at least one node, so a read normally sees the latest successful write. Typical choice: N = 3, W = 2, R = 2. Tune for the workload: W = 1, R = N for fast writes; W = N, R = 1 for fast reads (but then one dead node blocks writes).

How replicas catch up:

- **Read repair:** when a read sees a stale replica, it writes the newer value back to it.
- **Anti-entropy:** a background process compares replicas (often with Merkle trees) and copies missing data.
- **Hinted handoff:** if a target replica is down, another node stores the write with a "hint" and forwards it when the replica returns.
- **Sloppy quorum:** during an outage, writes may be accepted by nodes that aren't among the key's normal N. This improves write availability but means **W + R > N no longer guarantees overlap** until hints are delivered.

Even with strict quorums, edge cases remain (concurrent writes, a write that succeeded on fewer than W nodes and wasn't rolled back, clock-based conflict resolution). Quorums give strong-ish consistency, not linearizability by default.

| | Single-leader | Multi-leader | Leaderless |
|---|---|---|---|
| Who accepts writes | One leader | One leader per region/DC | Any replica (quorum) |
| Write conflicts | None | Yes, must resolve | Yes, must resolve |
| Write availability on failure | Pause until failover | High | High |
| Read-your-writes | Easy (read leader) | Per region | Via quorums |
| Complexity | Low | High | Medium–high |
| Examples | PostgreSQL, MySQL, MongoDB | Multi-region active-active setups, offline-first apps | Cassandra, Riak, ScyllaDB |

## 6. Synchronous vs asynchronous

- **Synchronous:** the leader waits for a follower to confirm before acknowledging the client. The write survives the leader dying, but every write is as slow as the slowest synchronous follower, and if that follower is down, writes stall.
- **Asynchronous:** the leader acknowledges immediately and ships changes in the background. Fast and available, but if the leader dies, **writes not yet replicated are lost**.
- **Semi-synchronous / quorum:** wait for one follower, or a majority, not all. This is the common middle ground: PostgreSQL's `synchronous_standby_names` with `ANY 1 (...)`, MongoDB's `writeConcern: { w: 'majority' }`.

This is the "else latency vs consistency" half of [CAP and PACELC](/lessons/cap-and-pacelc): even with no network partition, stronger replication guarantees cost latency.

> **Remember:** "async" means the database said OK before the data was safe anywhere else. Know which of your writes can afford that.

## 7. Replication lag: three anomalies and their fixes

With asynchronous followers, a replica can be milliseconds to minutes behind. Reads from it see the past. Three guarantees help, each with an e-commerce story.

### Read-your-writes (read-after-write)

Asha updates her delivery address, the page reloads, and the read goes to a lagging replica: **she sees the old address** and thinks the save failed.

Fixes:

- Read data the user can edit **from the leader**, at least for a short window (say 10–60 s) after they wrote.
- Track the write's position (log sequence number, optime) and only read from a replica that has caught up to it. MongoDB's **causally consistent sessions** do this for you.
- Route that user's reads to the leader while a "recently wrote" flag is set.

### Monotonic reads

Asha refreshes her order page. First request hits replica 1: **"Shipped"**. Second request hits a more-lagged replica 2: **"Processing"**. Her order went back in time.

Fix: make each user read from the **same replica** (e.g. pick the replica by hashing the user ID), failing over only if it's unhealthy. She may still see slightly old data, but never older than what she already saw.

### Consistent prefix reads

On a product's Q&A, a buyer asks "Is this waterproof?" and the seller answers "Yes". In a partitioned system the question and answer may live in different partitions with different lag, so another shopper sees **"Yes"** before the question exists. Effects appear before causes.

Fix: write causally related data to the **same partition** (e.g. partition Q&A by product), or track causal dependencies so a write isn't shown before what it depends on.

| Anomaly | What the user sees | Typical fix |
|---|---|---|
| Read-your-writes | Their own change "disappears" | Read from leader / wait for replica to catch up |
| Monotonic reads | Data goes backwards in time | Sticky replica per user |
| Consistent prefix | Answer before question | Same partition for related writes |

## 8. Failover: where things really go wrong

When the leader dies, the system must **detect** it (usually a timeout), **choose** a new leader (the most up-to-date follower, by election or an orchestrator) and **reroute** clients. Each step can fail.

### Lost writes from an async leader

The old leader acknowledged order #1001, then crashed before replicating it. The new leader never saw it. When the old leader comes back, its un-replicated writes conflict with the new history and are typically **discarded or rolled back** (MongoDB writes them to rollback files). If other systems already used those IDs (a cache, an email, a payment), you now have inconsistencies across systems. Requiring majority acknowledgement for important writes avoids this.

### Split brain

A network glitch makes the followers think the leader is dead. They elect a new leader, but the old one is alive and still accepting writes from some clients. **Two leaders**, two diverging histories.

Defences:

- **Majority (quorum) elections:** a leader needs votes from a majority, and a leader that loses contact with the majority steps down. With an odd number of voters, only one side of a partition can have a majority.
- **Fencing tokens:** every new leader (or lock holder) gets a strictly increasing number: a **term** or **epoch**. Storage and downstream services remember the highest token seen and **reject writes carrying an older one**.

```text
 Old leader (token 33) pauses for a long GC ...
 New leader elected      → token 34 → write accepted, store sees 34
 Old leader wakes, writes → token 33 → rejected: 33 < 34 ✅
```

- **STONITH** ("shoot the other node in the head"): forcibly power off or isolate the old leader. Effective, but crude.

### Choosing the timeout

Too short and a slow network or GC pause triggers needless failovers (each costs a brief write outage). Too long and you're down longer when the leader really dies. There's no universal right value; it depends on your network and load.

> **Remember:** a failover is safe only if the old leader can no longer write. Majority elections plus fencing tokens are how you make sure.

## 9. Common mistakes

- Sending **all** reads to replicas and breaking "save then view" flows.
- Assuming replicas are "a few ms behind" without monitoring lag; heavy writes, long queries on replicas or network issues can push it to minutes.
- Using **LWW** in a multi-leader setup for data you can't afford to lose, like orders or payments.
- Believing **W + R > N** means linearizable. It doesn't, especially with sloppy quorums.
- Running **two** voting nodes, where no majority survives a single failure.
- Treating replication as a **backup**. A `DELETE` without `WHERE` replicates instantly to every copy.

## 10. Trade-offs: which pattern when

- **Single-leader** is the right default for almost every OLTP system, including e-commerce checkout. Add semi-sync or majority writes for data you can't lose.
- **Multi-leader** fits multi-region apps that must accept writes locally during region isolation, offline-first clients and collaborative editing, provided the data can merge (CRDTs) or rarely conflicts.
- **Leaderless** fits very high write availability and throughput where eventual consistency is acceptable: event data, activity logs, carts, IoT. Model the data so conflicts are rare or mergeable.

The deeper question is always the same: **which reads must see the latest write, and what are you willing to pay for that?**
