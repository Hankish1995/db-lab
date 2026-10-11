---
slug: cap-and-pacelc
title: 'CAP and PACELC: the trade-offs every distributed database makes'
module: Distributed Basics
order: 40
summary: What CAP actually says, why PACELC is the more useful model day to day, the main consistency models, and where MongoDB and PostgreSQL fit.
level: intermediate
tags: [cap, pacelc, consistency, availability, partition, distributed, replication, mongodb, postgresql]
recap: >-
  Once data lives on more than one machine, the network can split them apart. CAP says that during such a
  partition a system must choose between consistency (every read sees the latest write) and availability
  (every working node answers). PACELC adds that even without a partition you trade latency against
  consistency. Consistency comes in levels, from linearizable down to eventual. MongoDB and replicated
  PostgreSQL are tunable: write concern, read concern, read preference and synchronous replication pick
  where each operation sits.
---

## 1. Why distributed at all?

One database server is simple and consistent. But it's also:

- a **single point of failure**: it dies, the store is down,
- **far away** from some users: a Mumbai server is slow for New York,
- **limited**: one machine's CPU, RAM and disk.

So we add copies (**replication**) and splits (**sharding**). The moment data lives on **more than one machine**, those machines must talk over a **network**, and networks fail.

## 2. The story: two warehouses and a cut phone line

Your store has **two warehouses**, Delhi and Mumbai. Both take orders. They keep a shared stock count in sync by phone: every sale is phoned through to the other side.

There's **one** limited-edition sneaker left.

Then a construction crew **cuts the phone line**. Both warehouses are fine, staff are working, customers are walking in, but they **can't talk to each other**. That's a **network partition**.

A customer walks into Delhi and asks to buy the sneaker. The Delhi manager has two choices:

1. **Refuse to sell** until the line is back, because Mumbai might have sold it already. Customers wait or leave. ➜ **Consistency over availability (CP).**
2. **Sell it anyway** and sort out conflicts later. Mumbai might sell it too, and one customer gets an apology email. ➜ **Availability over consistency (AP).**

There's no third option. You can't both answer every customer *and* guarantee nobody sees stale stock while you can't communicate.

```text
     ┌──────────────┐              ┌──────────────┐
     │    Delhi     │              │    Mumbai    │
     │ stock = 1    │─────/  /─────│ stock = 1    │
     └──────▲───────┘   partition  └──────▲───────┘
            │                             │
      "Buy sneaker"                 "Buy sneaker"

  CP: Delhi refuses (or errors) until it can reach Mumbai
  AP: both sell → stock = -1 across the system, fix later
```

| Story | Technical term |
|---|---|
| Warehouse | **Node** (replica) |
| Phone line | **Network** |
| Line cut, both sides alive | **Network partition** |
| Refuse to sell | Choose **Consistency** |
| Sell anyway | Choose **Availability** |

> **Remember:** a partition doesn't mean a server crashed. It means **servers are alive but can't reach each other**, and each side has to decide what to do on its own.

## 3. CAP, stated correctly

The **CAP theorem** (Brewer's conjecture, proved by Gilbert and Lynch in 2002) is about three properties:

- **C — Consistency:** specifically **linearizability**. Every read returns the **most recent write** (or an error), as if there were a single copy of the data.
- **A — Availability:** **every request to a non-failed node gets a non-error response**. Not "99.9% uptime"; it's a much stricter, specific definition.
- **P — Partition tolerance:** the system keeps working even when the network drops or delays messages between nodes.

The correct statement:

> **When a network partition happens, a distributed system must choose between consistency and availability.**

The popular "pick 2 of 3" is misleading. In a distributed system you **can't choose to skip P**: partitions happen whether you like it or not (switch failures, cloud zone issues, long GC pauses that look like network loss). So the real choice only exists **during a partition**: **CP** or **AP**. A "CA" system is just a single-node system, or one that pretends partitions don't happen.

> **Remember:** CAP isn't "pick 2 of 3". It's "**when the network splits, pick C or A**". When the network is fine, you can have both.

## 4. CP vs AP behaviour

| | **CP** during a partition | **AP** during a partition |
|---|---|---|
| Nodes that can't reach the majority | Reject writes (and maybe reads) | Keep accepting reads and writes |
| What the user sees | Errors or timeouts | Success, possibly stale or conflicting data |
| After the partition heals | Nothing to reconcile | Conflicts must be merged (last-write-wins, CRDTs, app logic) |
| Good for | Payments, inventory, unique usernames | Shopping carts, likes, view counts, sessions |
| Examples (default-ish behaviour) | Single-primary MongoDB writes, etcd, ZooKeeper | Cassandra, DynamoDB-style systems with weak settings |

In the e-commerce store: the **checkout** should be CP (never sell the same item twice, never double-charge). The **"recently viewed" list** or a **review's like count** can be AP: slightly stale is fine, being down is not.

Many systems let you choose **per operation**, which is why labels like "MongoDB is CP" are oversimplified.

## 5. PACELC: the model you'll actually use

Partitions are rare. Most of the time the network is fine. But even then, **keeping replicas in sync costs time**: a write must reach other nodes before you can promise consistency.

**PACELC** (Daniel Abadi) extends CAP:

```text
  if Partition:            choose  Availability  or  Consistency
  Else (normal operation): choose  Latency       or  Consistency
```

| System behaviour | PACELC class | Meaning |
|---|---|---|
| Wait for replicas always | **PC/EC** | Correct first, even if slower |
| Fast and available always | **PA/EL** | Low latency, eventual consistency |
| Mixed | **PA/EC** or **PC/EL** | Depends on configuration |

Example: a write in a 3-node replica set.

- **Acknowledge after the primary only** → fast (EL), but if the primary dies before replicating, the write can be lost.
- **Acknowledge after a majority** → slower by a network round trip (EC), but the write survives a failover.

That's a decision you make **every day**, not only during rare partitions. That's why PACELC is the more practical model.

> **Remember:** CAP is about the bad day. **PACELC adds the normal day**: even without failures, stronger consistency costs latency.

## 6. Consistency models, strongest to weakest

"Consistent" isn't yes/no. Here's the ladder, with e-commerce examples:

| Model | Guarantee | E-commerce example |
|---|---|---|
| **Linearizable** (strong) | Every read sees the latest write, in real-time order, as if one copy | Stock for the last sneaker: anyone who reads after a sale sees 0 |
| **Sequential** | Everyone sees operations in the **same order**, consistent with each client's order, but not necessarily real time | Rarely chosen directly; mostly theory |
| **Causal** | If A caused B, everyone sees A before B; unrelated writes can appear in any order | A reply to a review never appears before the review itself |
| **Read-your-writes** | You always see **your own** writes | After updating her address, Asha sees the new one on refresh |
| **Monotonic reads** | You never see data go **backwards in time** | Order status never flips from "shipped" back to "packed" on refresh |
| **Eventual** | If writes stop, replicas **eventually** agree; no ordering promise | Product's review count shows 41 on one request and 42 on the next |

Read-your-writes and monotonic reads are **session guarantees**: they're about what **one user** sees, and they're often all a user-facing app needs.

```text
  stronger, slower, less available
  ▲  Linearizable
  │  Sequential
  │  Causal
  │  Read-your-writes / Monotonic reads
  ▼  Eventual
  weaker, faster, more available
```

> **Remember:** most bugs users notice are **session** bugs ("I saved it and it disappeared"). Read-your-writes often fixes them without paying for full linearizability.

## 7. Where MongoDB fits

A MongoDB **replica set** has one **primary** that takes writes and **secondaries** that replicate from it asynchronously via the oplog. You tune consistency with three knobs:

| Knob | Controls | Common values |
|---|---|---|
| **Write concern** | How many nodes must acknowledge a write | `w: 1`, `w: 'majority'` (default in modern versions for most deployments) |
| **Read concern** | How "committed" the data you read must be | `local` (default), `majority`, `linearizable`, `snapshot` |
| **Read preference** | Which node serves the read | `primary` (default), `primaryPreferred`, `secondary`, `nearest` |

```js
// Checkout: durable write, survives failover
db.orders.insertOne(
  { userId, items, status: 'paid' },
  { writeConcern: { w: 'majority' } }
)

// Stock check that must not be stale (primary only, single document;
// linearizable reads wait for a majority, so always set a timeout)
db.products.find({ _id: productId }).readConcern('linearizable').maxTimeMS(5000)

// Analytics page: fine to be a bit behind, offload the primary
db.orders.find({ status: 'shipped' }).readPref('secondaryPreferred')
```

How it behaves during a **partition**:

- The side **with a majority** of voting members keeps (or elects) a primary and accepts writes.
- A primary that **loses contact with the majority steps down**. The minority side has no primary, so **writes fail there**. That's CP behaviour for writes.
- But reads with `secondary` or `nearest` read preference can still be served on the minority side, possibly **stale**. That's AP-ish behaviour for those reads.
- Writes acknowledged with `w: 1` that never reached a majority can be **rolled back** after the old primary rejoins.

Within a session, **causal consistency** (`client.startSession({ causalConsistency: true })`, the default for sessions) gives read-your-writes and monotonic reads, but only when you use **`majority`** read and write concerns.

So the accurate interview answer: *"MongoDB is single-primary, so by default writes go through a majority-elected primary and behave like CP. But consistency is tunable per operation: secondary reads, `w: 1` and `local` read concern trade consistency for latency and availability."*

## 8. Where PostgreSQL fits

**Single node:** there are no replicas to disagree, so CAP doesn't really apply. Reads see committed data (ACID). If the server is down, it's simply unavailable.

**With streaming replication:**

```text
           writes
             │
       ┌─────▼─────┐   WAL stream    ┌───────────┐
       │  Primary  │────────────────►│  Standby  │
       └───────────┘                 └───────────┘
   async (default): commit returns before standby has it
   sync: commit waits for the standby to confirm
```

| Mode | Behaviour | PACELC flavour |
|---|---|---|
| **Asynchronous** (default) | Commit returns immediately; standby lags slightly. Failover can **lose** the last commits. Standby reads can be stale. | Leans EL |
| **Synchronous** (`synchronous_standby_names`) | Commit waits for the standby. If no synchronous standby responds, **commits on the primary block**. | PC/EC |
| Sync + `synchronous_commit = remote_apply` | Commit waits until the standby has **applied** the change, so reads there see it | Strongest read-after-write on replicas |

Note that PostgreSQL itself doesn't do automatic failover; tools like **Patroni** or managed services (RDS, Cloud SQL) handle it, and their configuration decides how much data loss is possible.

> **Remember:** "SQL is CP, NoSQL is AP" is wrong. **Configuration decides**: async PostgreSQL replicas serve stale reads, and MongoDB with `majority` concerns is strongly consistent.

## 9. Common misconceptions

| Misconception | Reality |
|---|---|
| "Pick any 2 of C, A, P" | P isn't optional in a distributed system; the choice is C vs A **during** a partition |
| "Our system is CA" | Only true for a single node. Multi-node systems will see partitions |
| "Available means high uptime" | CAP availability = **every** non-failed node answers. A CP system can still have great uptime |
| "Consistency in CAP = ACID's C" | CAP C is linearizability; ACID C is about rules/invariants |
| "MongoDB is CP, Cassandra is AP" (full stop) | Both are tunable; behaviour depends on concerns, read preference and consistency levels |
| "Eventual consistency means data might be wrong forever" | It means replicas converge once writes stop; the window is usually milliseconds |

## 10. Trade-offs: choosing per feature

| Feature | Need | Settings that fit |
|---|---|---|
| Payment, stock decrement | Never lose, never double-sell | Primary, `w: 'majority'`, transactions / sync replication |
| Order history page | Read-your-writes | Primary reads, or causal session with `majority` |
| Product catalogue browse | Fast, can be seconds stale | Secondary / replica reads, cache |
| Review counts, view counts | Fast and available | Eventual, async counters |

**When not to push for strong consistency:** high-volume, low-value data where latency matters more than freshness. **When not to relax it:** money, stock, uniqueness (usernames, coupon redemptions). Most real systems mix both, feature by feature.
