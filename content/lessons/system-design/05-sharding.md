---
slug: sharding
title: 'Sharding: splitting one huge database across many machines'
module: Scaling
order: 50
summary: What sharding is, why it exists, how the shard key decides everything, and when not to shard.
level: intermediate
tags: [sharding, scaling, mongodb, shard-key, horizontal-scaling, distributed]
recap: >-
  Sharding = splitting data across machines because one isn't enough. The shard key decides where data
  goes and which queries are fast. Hashed spreads writes; ranged helps range queries. Watch out for hot
  shards and scatter-gather. It's not replication (copies) or partitioning (same machine). Shard last, not first.
---

## 1. The story

You run a library with **one building**. At first it's fine. Then you have 10 million books and 50,000 visitors a day.

- The building is **full**: no more shelf space (**storage limit**).
- The front desk has a **huge queue** (**too many reads and writes**).
- Buying a bigger building gets expensive, and eventually **no bigger building exists** (**vertical scaling hits a limit**).

So you open **4 branches** and split the books between them:

```text
Authors A–F  →  Branch 1
Authors G–M  →  Branch 2
Authors N–S  →  Branch 3
Authors T–Z  →  Branch 4
```

At the city entrance, a **receptionist** tells each visitor which branch to go to.

**That's sharding.**

- Each branch = a **shard**: a separate database server holding *part* of the data.
- "Author's first letter" = the **shard key**: the field that decides where each record lives.
- The receptionist = the **router** (`mongos` in MongoDB). It sends each query to the right shard.
- The receptionist's notebook of "which letters are in which branch" = the **config servers** (the metadata).

> **One line to remember:** sharding = **splitting the rows of one database across many machines**, so that **no single machine holds all the data or handles all the traffic.**

## 2. The main goal

Sharding solves the problem of **one machine not being enough**:

| Problem | How sharding fixes it |
|---|---|
| Data too big for one disk | Each shard stores only a part |
| Too many writes for one server | Writes are spread across shards |
| Too many reads | Reads are spread too |
| Bigger servers get very expensive | Add more cheap servers instead |

This is **horizontal scaling** (adding more machines). **Vertical scaling** means buying a bigger machine.

## 3. A real example: an e-commerce `orders` collection

You have **2 billion orders**. One server can't hold them all, so you shard by `customerId` across 3 shards:

```text
          ┌──────────── App ────────────┐
                        │
                  ┌─────▼─────┐
                  │  mongos   │  ← router: "which shard has this?"
                  └─────┬─────┘
        ┌───────────────┼───────────────┐
   ┌────▼────┐     ┌────▼────┐     ┌────▼────┐
   │ Shard 1 │     │ Shard 2 │     │ Shard 3 │
   │ cust    │     │ cust    │     │ cust    │
   │ 1–1M    │     │ 1M–2M   │     │ 2M–3M   │
   └─────────┘     └─────────┘     └─────────┘
```

**Query: "Show all orders of customer 1,500,000."**
The router knows the answer is on Shard 2 and asks **only Shard 2**. This is a **targeted query**, and it's fast. ✅

```js
db.orders.find({ customerId: 1500000 }) // includes the shard key → targeted
```

**Query: "Show all orders placed today."**
The query doesn't include `customerId`, so the router has to ask **all 3 shards** and merge the results. This is a **scatter-gather query**, and it's slow. ⚠️

```js
db.orders.find({ createdAt: { $gte: ISODate('2026-10-11') } }) // no shard key → every shard
```

> **Remember:** the shard key decides which queries are fast. If a query includes the shard key, it's targeted. If it doesn't, it goes to every shard.

## 4. Choosing the shard key (the most important decision)

A good shard key has three properties:

1. **High cardinality:** many distinct values. `country` is bad, because there are only about 200 values, so you can't split beyond about 200 pieces. `userId` is good.
2. **Even distribution:** data and traffic spread evenly across shards.
3. **Matches your common queries:** most queries should include it, so they're targeted.

### The classic mistake: the hot shard

You shard by `createdAt` (date) with **ranged sharding**:

```text
Shard 1: 2023 orders     😴 idle
Shard 2: 2024 orders     😴 idle
Shard 3: 2025+ orders    🔥 receives EVERY new order
```

Every new order has today's date, so **all writes land on the last shard**. You bought 3 servers, but only one does the work. Any key that keeps increasing (a timestamp, an auto-increment ID, a MongoDB `ObjectId`) has this problem.

### The two ways to split

| Ranged sharding | Hashed sharding |
|---|---|
| Splits by value ranges (A–F, G–M…) | Runs the key through a hash function first, which scatters values randomly |
| ✅ Range queries ("customers 100–200") are fast, because the data sits together | ✅ Writes spread evenly, so no hot shard |
| ❌ Increasing keys create a hot shard | ❌ Range queries become scatter-gather |

```js
sh.shardCollection('shop.orders', { customerId: 1 })        // ranged
sh.shardCollection('shop.orders', { customerId: 'hashed' }) // hashed
```

> **Remember:** **ranged** = good for range queries, risky for writes. **Hashed** = good for writes, bad for ranges.

## 5. Things that only happen once you shard

- **Chunks and the balancer:** MongoDB splits data into **chunks** and a background **balancer** moves chunks between shards to keep them even.
- **Jumbo chunk:** if too many documents share the *same* shard key value (e.g. one huge customer), that chunk can't be split or moved.
- **Cross-shard transactions** are possible, but slower (a two-phase commit across machines).
- **Unique indexes** can only be enforced if they include the shard key.
- **Changing the shard key later is painful**: resharding means rewriting all your data. **Choose carefully at the start.**
- **Joins and `$lookup` across shards** are expensive.

## 6. Don't confuse these three

| | What it does | Analogy |
|---|---|---|
| **Sharding** | Splits data across **many machines**, each holding **different** data | 4 library branches, different books in each |
| **Replication** | **Copies the same data** onto several machines (for safety and read scaling) | Photocopies of the *same* books in a backup building |
| **Partitioning** (e.g. in PostgreSQL) | Splits one table into pieces **on the same machine** | Separate rooms in the *same* building |

In real systems you **combine sharding and replication**: every shard is itself a replica set, so if a shard's server dies, its copy takes over.

## 7. When NOT to shard

Sharding adds a lot of complexity. **Try these first:**

1. Add the right **indexes**
2. Fix slow queries
3. Add a **cache** (e.g. Redis)
4. Add **read replicas** for read-heavy load
5. Upgrade the machine (vertical scaling)
6. **Archive** old data

Shard only when **data size or write volume** truly can't fit on one replica set.

> **Remember:** shard last, not first.
