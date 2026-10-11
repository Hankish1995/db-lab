---
slug: postgres-partitioning
title: 'Partitioning: one big table, many smaller drawers'
module: Scaling
order: 110
summary: How PostgreSQL declarative partitioning splits one huge table into smaller tables on the same server, how partition pruning makes queries skip whole partitions, and when partitioning helps or hurts.
level: advanced
tags: [postgresql, partitioning, partition-pruning, range, list, hash, maintenance, retention]
recap: >-
  Partitioning splits one logical table into smaller physical tables on the same server, chosen by a
  partition key: RANGE for time, LIST for categories, HASH to spread rows evenly. Queries that filter on
  the key skip irrelevant partitions (pruning), at plan time or at execution time for parameters. Its biggest
  win is maintenance: drop or detach an old month instantly instead of a huge DELETE plus VACUUM. Unique
  constraints must include the key, too many partitions slow planning, and it is not sharding.
---

## 1. The story

An online shop keeps every paper invoice in **one giant filing cabinet**. After five years it holds 40 million invoices.

- Finding "invoices from last Tuesday" means flipping through the whole cabinet.
- Throwing away invoices older than three years means pulling them out **one by one**.
- Tidying the cabinet takes all weekend, because it's one enormous thing.

So the office manager buys a **filing room with one drawer per month**. Each drawer has a label: "2026-01", "2026-02"…

- "Last Tuesday's invoices?" Open **one drawer**.
- "Throw away 2022?" Pull out **twelve drawers** and put them in the shredder. Done in seconds.
- Tidying happens **drawer by drawer**, and old drawers never need tidying again.

**That's partitioning.**

| Filing room | PostgreSQL |
|---|---|
| The whole filing room | The **partitioned table** (`orders`), the parent you query |
| One drawer | A **partition**: a real table holding a slice of rows |
| "Month of the invoice" | The **partition key** (`created_at`) |
| Drawer labels | **Partition bounds** (`FROM ... TO ...`) |
| Only opening the right drawer | **Partition pruning** |
| A "misc" drawer for odd invoices | The **default partition** |
| Shredding a whole drawer | `DROP` / `DETACH PARTITION` |

> **Remember:** partitioning = one logical table split into many physical tables **on the same server**, routed by a partition key.

## 2. Why it exists: the problem with one huge table

Imagine `orders` with 2 billion rows, growing by 5 million a day. Indexes help reads (see [Indexes](/lessons/postgres-indexes)), but the **operations** around the table become the pain:

- **Deleting old data is brutal.** `DELETE FROM orders WHERE created_at < '2023-01-01'` touches millions of rows, writes WAL for each one, and leaves millions of **dead tuples**. In our scratch database, deleting 107,136 rows from a 300,000-row table left exactly `n_dead_tup = 107136` behind for VACUUM to clean.
- **VACUUM and autovacuum** must scan a giant table and its giant indexes (see [MVCC and VACUUM](/lessons/postgres-mvcc-and-vacuum)).
- **Index rebuilds and `ANALYZE`** take hours instead of minutes.
- **Hot data gets diluted.** This week's orders are scattered among years of cold rows, so the cache works harder.

With monthly partitions, each month is its own table with its own indexes. Old months are never written again: VACUUM freezes them once and leaves them alone, and retention becomes `DROP TABLE`.

> **Remember:** the biggest win of partitioning is usually **maintenance and data retention**, not raw query speed.

## 3. How it works: declarative partitioning

You create a **parent** with `PARTITION BY`, then create partitions with `PARTITION OF`. The parent stores no rows itself. PostgreSQL routes every `INSERT` to the right partition, and `UPDATE`s that change the key move the row to its new partition.

```text
            INSERT / SELECT / UPDATE / DELETE
                          │
               ┌──────────▼──────────┐
               │  orders (parent)    │  ← no rows of its own
               │  PARTITION BY RANGE │
               └──┬───────┬───────┬──┘
        ┌─────────┘       │       └─────────┐
 ┌──────▼───────┐ ┌───────▼──────┐ ┌────────▼─────┐
 │orders_2026_01│ │orders_2026_02│ │orders_2026_03│
 │ Jan rows     │ │ Feb rows     │ │ Mar rows     │
 │ own indexes  │ │ own indexes  │ │ own indexes  │
 └──────────────┘ └──────────────┘ └──────────────┘
```

### RANGE: by month on `created_at`

The standard choice for time-series data like orders, events and logs:

```sql
CREATE TABLE orders (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  customer_id bigint        NOT NULL,
  status      text          NOT NULL,
  total       numeric(10,2) NOT NULL,
  created_at  timestamptz   NOT NULL,
  PRIMARY KEY (id, created_at)          -- must include the partition key
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2026_01 PARTITION OF orders
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE orders_2026_02 PARTITION OF orders
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE orders_2026_03 PARTITION OF orders
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
```

The lower bound is **inclusive** and the upper bound **exclusive**, so midnight on 1 February goes to the February partition. No gaps, no overlaps.

### LIST: by explicit values

Good for a small, known set of values such as region or status:

```sql
CREATE TABLE customers (
  id     bigint NOT NULL,
  region text   NOT NULL,
  email  text   NOT NULL
) PARTITION BY LIST (region);

CREATE TABLE customers_eu   PARTITION OF customers FOR VALUES IN ('DE', 'FR', 'NL');
CREATE TABLE customers_us   PARTITION OF customers FOR VALUES IN ('US');
CREATE TABLE customers_rest PARTITION OF customers DEFAULT;
```

### HASH: spread rows evenly

When there's no natural range but you want N similar-sized pieces, for example carts by `customer_id`:

```sql
CREATE TABLE carts (
  customer_id bigint NOT NULL,
  items       jsonb  NOT NULL DEFAULT '[]'
) PARTITION BY HASH (customer_id);

CREATE TABLE carts_p0 PARTITION OF carts FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE carts_p1 PARTITION OF carts FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE carts_p2 PARTITION OF carts FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE carts_p3 PARTITION OF carts FOR VALUES WITH (MODULUS 4, REMAINDER 3);
```

Inserting 10,000 customers gave 2,489 / 2,527 / 2,530 / 2,454 rows. Equality lookups (`customer_id = 42`) prune to one partition; range queries can't, and you can't simply drop "old" data, because every partition holds a mix.

| Strategy | Best for | Prunes on | Easy retention? |
|---|---|---|---|
| **RANGE** | Time: orders, events, logs | Ranges and equality | ✅ drop old ranges |
| **LIST** | Region, tenant, status | Equality / `IN` | ⚠️ per value |
| **HASH** | Even spread by an ID | Equality only | ❌ |

### The default partition

A row that matches no partition raises an error:

```text
ERROR:  no partition of relation "orders" found for row
DETAIL:  Partition key of the failing row contains (created_at) = (2027-05-01 00:00:00+00).
```

A **default partition** (`CREATE TABLE orders_default PARTITION OF orders DEFAULT;`) catches those rows instead. Useful as a safety net, but with costs:

- Creating a new partition must **scan the default** to prove no rows belong to the new range. If some do, it fails: `updated partition constraint for default partition "orders_default" would be violated by some row`.
- `DETACH PARTITION ... CONCURRENTLY` is **not allowed** while a default partition exists (we hit this error in testing).

Many teams prefer **no default** plus a job that creates partitions weeks ahead, and an alert if an insert ever fails.

## 4. Partition pruning: skipping drawers

**Partition pruning** means the planner removes partitions that can't contain matching rows. It's on by default (`enable_partition_pruning = on`).

Real plans from a 300,000-row test table with three monthly partitions and an index on `created_at` (lines wrapped and trimmed to fit):

**With the partition key in `WHERE`** (one partition scanned):

```sql
EXPLAIN (COSTS OFF)
SELECT sum(total) FROM orders
WHERE created_at >= '2026-02-10' AND created_at < '2026-02-11';
```

```text
 Aggregate
   ->  Index Scan using orders_2026_02_created_at_idx
       on orders_2026_02 orders
         Index Cond: ((created_at >= '2026-02-10 00:00:00+00'::timestamptz)
                  AND (created_at < '2026-02-11 00:00:00+00'::timestamptz))
```

**Without the partition key** (every partition scanned):

```sql
EXPLAIN (COSTS OFF) SELECT sum(total) FROM orders WHERE customer_id = 42;
```

```text
 Finalize Aggregate
   ->  Gather
         Workers Planned: 2
         ->  Partial Aggregate
               ->  Parallel Append
                     ->  Parallel Seq Scan on orders_2026_01 orders_1
                     ->  Parallel Seq Scan on orders_2026_02 orders_2
                     ->  Parallel Seq Scan on orders_2026_03 orders_3
```

### Pruning at execution time

When the value isn't known at planning time (a parameter in a prepared statement with a **generic plan**, or a value from a subquery or join), PostgreSQL prunes **while executing**. EXPLAIN ANALYZE shows it as `Subplans Removed`:

```sql
PREPARE orders_since(timestamptz) AS
  SELECT count(*) FROM orders WHERE created_at >= $1;
SET plan_cache_mode = force_generic_plan;   -- only to demonstrate
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) EXECUTE orders_since('2026-03-15');
```

```text
 Aggregate (actual rows=1 loops=1)
   ->  Append (actual rows=47712 loops=1)
         Subplans Removed: 2
         ->  Index Only Scan using orders_2026_03_created_at_idx
               on orders_2026_03 orders_1
               Index Cond: (created_at >= $1)
```

This matters for Node.js apps, because drivers send parameterized queries (`$1`), and pruning still works.

⚠️ Pruning needs a condition on the **key column itself**. `WHERE date_trunc('month', created_at) = '2026-02-01'` hides the key inside a function, so it can't prune. Write plain ranges instead.

> **Remember:** pruning only happens when the query filters on the partition key. Choose the key from your most common `WHERE` clause.

## 5. Indexes and constraints

- `CREATE INDEX ON orders (customer_id)` on the parent creates a **partitioned index**, plus one real index **per partition**, and future partitions get it automatically.
- There are **no global indexes**. Each partition only knows its own rows.
- So **a unique constraint or primary key must include all partition key columns**. PostgreSQL can only check uniqueness inside one partition:

```text
ERROR:  unique constraint on partitioned table must include all partitioning columns
DETAIL:  PRIMARY KEY constraint on table "bad" lacks column "created_at" which is part of the partition key.
```

That's why our key is `PRIMARY KEY (id, created_at)`. An identity column still gives unique ids in practice, but the database no longer **guarantees** `id` alone is unique.

- `CREATE INDEX CONCURRENTLY` doesn't work on the partitioned parent. The workaround: `CREATE INDEX ... ON ONLY orders` (creates an invalid parent index), then `CREATE INDEX CONCURRENTLY` on each partition and `ALTER INDEX ... ATTACH PARTITION` each one. The parent index becomes valid once all partitions are attached.

## 6. Retention: drop, don't delete

To remove January:

```sql
-- ❌ Slow: millions of row deletions, WAL, dead tuples, VACUUM afterwards
DELETE FROM orders WHERE created_at < '2026-02-01';

-- ✅ Instant: remove the whole drawer
DROP TABLE orders_2026_01;

-- ✅ Or keep it for archiving, without blocking queries on orders
ALTER TABLE orders DETACH PARTITION orders_2026_01 CONCURRENTLY;
-- now it's a normal table: dump it to cold storage, then DROP it
```

A plain `DETACH PARTITION` (and `DROP`) takes a strong lock on the parent, so it waits for and blocks queries on `orders`. **`DETACH ... CONCURRENTLY`** uses a weaker lock in two transactions, so normal traffic continues. Its rules:

- It **can't run inside a transaction block** (`BEGIN ... COMMIT`).
- It's **not allowed when a default partition exists**.
- If it's interrupted, finish it with `ALTER TABLE orders DETACH PARTITION orders_2026_01 FINALIZE;`.

The reverse also works: build and load a table offline, add a `CHECK` constraint matching the bounds, then `ATTACH PARTITION`. The matching `CHECK` lets PostgreSQL skip the validation scan.

> **Remember:** retention on a partitioned table is a metadata operation. `DROP` or `DETACH` a partition instead of `DELETE`-ing millions of rows.

## 7. How many partitions is too many?

Each partition is a real table with its own files, indexes and catalog entries. The planner must consider partitions, and if a query can't prune, it plans and executes every one of them.

It **depends** on your version, your queries and whether they prune:

- **Dozens to a few hundred** partitions: comfortably fine for most workloads.
- **Low thousands**: can work on recent versions if nearly every query prunes, but measure planning time (`EXPLAIN (ANALYZE)` prints `Planning Time`).
- **Tens of thousands**: expect slow planning, high memory per connection and lock-table pressure. Don't.

So pick the granularity from data volume: **monthly** is the usual default, daily only for very high volume with short retention. Partitioning by `customer_id` with one partition per customer is a classic mistake.

## 8. Common mistakes and gotchas

- **Partitioning a 5 GB table.** Indexes alone handle that. Partitioning shines at hundreds of GB or with strict retention.
- **Choosing a key your queries don't filter on.** Every query becomes "scan all partitions", often slower than before.
- **Forgetting to create future partitions.** Without a default, inserts start failing at midnight on the 1st. Automate it.
- **Expecting a unique `id` across partitions** when the key doesn't include it.
- **Wrapping the key in a function** in `WHERE`, which defeats pruning.
- **Big default partitions** that make every new `CREATE TABLE ... PARTITION OF` slow.

## 9. Don't confuse these

| | Partitioning | Sharding | Table inheritance |
|---|---|---|---|
| Where data lives | One server | Many servers | One server |
| Routing | Automatic, by partition key | Router / app / Citus | Triggers you write |
| Pruning | ✅ plan + execution time | Targeted queries | Constraint exclusion (plan time) |
| Scales writes beyond one machine | ❌ | ✅ | ❌ |
| Status | ✅ Modern, recommended | Different problem | Legacy way to partition |

Sharding is covered in [Sharding](/lessons/sharding). **Table inheritance** (`INHERITS`) is how people partitioned before PostgreSQL 10: child tables, `CHECK` constraints and an insert trigger. Use declarative partitioning for new work.

Two extensions worth knowing by name:

- **pg_partman** automates creating future partitions and dropping or detaching old ones by a retention rule.
- **Citus** distributes tables across multiple machines, turning PostgreSQL into a sharded database.

## 10. When NOT to partition (trade-offs)

- **Small or medium tables.** Below roughly 100 GB with no retention need, a good index is simpler and as fast.
- **Queries that don't filter by the key.** "Orders for customer 42" on a table partitioned by month checks every partition's index: N small lookups instead of one.
- **You need global uniqueness** on a column that isn't the key.
- **You actually need more machines.** Partitioning doesn't add CPU, RAM or disk; that's [Sharding](/lessons/sharding).

The costs: more objects to manage, partition-creation jobs, constraint limitations, and planning overhead. The payoff: cheap retention, smaller VACUUMs and indexes, and fast queries on the newest data.

> **Remember:** partition when a table is **huge and time-shaped** and your queries filter on the key. Otherwise, index first.
