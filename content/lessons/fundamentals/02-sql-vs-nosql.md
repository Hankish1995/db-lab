---
slug: sql-vs-nosql
title: 'SQL vs NoSQL: two ways to organise the same data'
module: Foundations
order: 20
summary: How relational and NoSQL databases differ in data model, schema, joins, scaling and consistency, and how to choose between them without falling for the myths.
level: beginner
tags: [sql, nosql, relational, mongodb, postgresql, schema, data-modeling]
recap: >-
  SQL databases store normalised tables with an enforced schema and join them at query time; NoSQL is a
  family (document, key-value, wide-column, graph) that usually stores data shaped the way it is read.
  Schema-on-write checks data when you save it; schema-on-read trusts your code. The old split (SQL scales up,
  NoSQL scales out) has blurred: MongoDB has transactions and schema validation, and SQL can shard.
  Choose by access patterns, relationships and team skills, and use more than one store when it pays off.
---

## 1. The story

Two shops sell the same things. Each keeps its records differently.

**Shop A uses filing cabinets.** One cabinet for customers, one for products, one for orders. An order card says *"customer #17 bought product #203"*, never the customer's name. To print an invoice, the clerk pulls cards from three cabinets and combines them. Every card must follow a printed template; a card with a missing field is rejected at the desk.

**Shop B uses folders.** One folder per order, containing everything needed to ship it: a copy of the customer's name and address, the items with their prices at purchase time. Printing an invoice means opening **one** folder. Folders can contain extra pages when needed.

| Story | Technical term |
|---|---|
| Separate cabinets, cards point to each other by number | **Relational model**: tables linked by **foreign keys** |
| Combining cards from several cabinets | **JOIN** |
| Printed template checked at the desk | **Schema-on-write** |
| One self-contained folder per order | **Document model**: **embedding** |
| Folders may vary in content | **Flexible schema** / schema-on-read |

Neither shop is wrong. Shop A never has two different addresses for customer #17. Shop B prints invoices faster. **That's the whole SQL vs NoSQL trade-off.**

> **Remember:** SQL stores each fact **once** and joins at read time. Document databases store data **the way it's read**, often duplicating some of it.

## 2. The two worlds

### The relational model (SQL)

Data lives in **tables** of rows and typed columns. Relationships are expressed with **primary keys** and **foreign keys**, and data is **normalised**: each fact is stored once. You query with **SQL**, and the database joins tables for you. Examples: PostgreSQL, MySQL, SQL Server, Oracle.

### NoSQL: a family, not one thing

"NoSQL" just means "not relational". It covers very different databases:

| Family | Data shape | Example |
|---|---|---|
| **Document** | JSON-like documents in collections | MongoDB |
| **Key-value** | Key → opaque value | Redis, DynamoDB |
| **Wide-column** | Rows grouped by partition key, flexible columns | Cassandra |
| **Graph** | Nodes and edges | Neo4j |

In interviews, "NoSQL" usually means **MongoDB-style document databases**, so that's the comparison below. Say that out loud; it shows you know the family is broader.

## 3. Schema-on-write vs schema-on-read

- **Schema-on-write** (PostgreSQL): the database checks every write against the table definition. Wrong type, missing `NOT NULL` column, broken foreign key → the write fails.
- **Schema-on-read** (MongoDB by default): the database accepts any document shape; your **code** decides how to interpret it when reading.

But MongoDB can enforce a schema too:

```js
db.createCollection('products', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['name', 'price'],
      properties: {
        name:  { bsonType: 'string' },
        price: { bsonType: ['int', 'long', 'double', 'decimal'], minimum: 0 }
      }
    }
  }
})
```

And PostgreSQL can be flexible: a `jsonb` column stores arbitrary JSON and can be indexed with GIN.

> **Remember:** the schema always exists. The question is only **where it's enforced**: in the database, or in your application code (Mongoose, Zod, discipline).

## 4. The e-commerce store, modelled both ways

### In PostgreSQL

```sql
CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text NOT NULL
);

CREATE TABLE products (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  price      numeric(10,2) NOT NULL CHECK (price >= 0),
  stock      integer NOT NULL CHECK (stock >= 0)
);

CREATE TABLE orders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  status     text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id   bigint NOT NULL REFERENCES orders(id),
  product_id bigint NOT NULL REFERENCES products(id),
  quantity   integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(10,2) NOT NULL,   -- price at time of purchase
  PRIMARY KEY (order_id, product_id)
);
```

Showing an order with its items needs a **join**:

```sql
SELECT o.id, u.name, p.name AS product, oi.quantity, oi.unit_price
FROM orders o
JOIN users u        ON u.id = o.user_id
JOIN order_items oi ON oi.order_id = o.id
JOIN products p     ON p.id = oi.product_id
WHERE o.id = 42;
```

### In MongoDB

```js
// users
{ _id: ObjectId('...u17'), email: 'asha@example.com', name: 'Asha' }

// products
{ _id: ObjectId('...p203'), name: 'Running shoe', price: Decimal128('2999.00'), stock: 40 }

// orders: items embedded, with a snapshot of name and price
{
  _id: ObjectId('...o42'),
  userId: ObjectId('...u17'),
  status: 'pending',
  createdAt: ISODate('2026-10-11T10:00:00Z'),
  shippingAddress: { line1: '12 MG Road', city: 'Bengaluru', pin: '560001' },
  items: [
    { productId: ObjectId('...p203'), name: 'Running shoe', quantity: 1, unitPrice: Decimal128('2999.00') }
  ]
}
```

Showing an order is **one read, no join**:

```js
db.orders.findOne({ _id: ObjectId('...o42') })
```

```text
 PostgreSQL: 4 tables, joined on read
 ┌───────┐   ┌────────┐   ┌─────────────┐   ┌──────────┐
 │ users │◄──┤ orders │◄──┤ order_items ├──►│ products │
 └───────┘   └────────┘   └─────────────┘   └──────────┘

 MongoDB: order document embeds what it needs
 ┌──────────────────────────────┐
 │ order                        │
 │  ├─ userId ─────────► users  │
 │  ├─ shippingAddress { … }    │
 │  └─ items [ { … }, { … } ]   │
 └──────────────────────────────┘
```

Notice: the order's items and prices are copied (a snapshot), which is what you *want* for orders: an invoice must not change when the product price changes later. MongoDB still uses **references** (`userId`) where data is shared and changes independently, and `$lookup` can join when needed.

> **Remember:** **embed** what is read together and owned by the parent (order items). **Reference** what is shared, large, or grows without bound (users, products, reviews).

## 5. Scaling: where the old split came from

```text
 Vertical scaling (scale up)      Horizontal scaling (scale out)
 ┌─────────┐                      ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐
 │         │                      │ DB  │ │ DB  │ │ DB  │ │ DB  │
 │   BIG   │                      └─────┘ └─────┘ └─────┘ └─────┘
 │   DB    │                      many machines, data split
 └─────────┘
 one bigger machine
```

Relational databases were designed in the era of single big servers. Joins and multi-row transactions are easiest when all data is on one machine, so the classic path was **scale up**.

In the late 2000s, web giants needed more than one machine could give. Systems like Dynamo, Bigtable, Cassandra and MongoDB were built to **scale out**: data partitioned across many nodes, often by giving up joins and cross-node transactions. That history created the slogan "NoSQL scales, SQL doesn't".

Today the line is blurry: a single PostgreSQL server handles a lot more than most apps need, sharding exists for SQL (Citus for PostgreSQL, Vitess for MySQL), and distributed SQL databases (CockroachDB, Google Spanner, YugabyteDB) scale out with transactions.

## 6. Consistency defaults

| | PostgreSQL (single primary) | MongoDB (replica set) |
|---|---|---|
| Transactions | Every statement runs in a transaction | Single-document writes are atomic; multi-document transactions available |
| Default isolation | **Read Committed** | Reads use read concern `local` by default |
| Default writes | Committed and flushed to the WAL before success (`synchronous_commit = on`) | Write concern `majority` is the default in modern versions (most deployments) |
| Reads from replicas | Replicas lag if replication is asynchronous (the default) | Secondary reads may be stale; default read preference is `primary` |

The honest summary: both can be configured from "fast and loose" to "strict". Know the knobs (isolation levels, write concern, read concern, read preference); that's what impresses interviewers.

## 7. How to choose

| If your situation is… | Lean towards |
|---|---|
| Many relationships, ad-hoc queries, reporting | **SQL** |
| Money, inventory, strict integrity across many entities | **SQL** (MongoDB transactions work, but it's SQL's home ground) |
| Data naturally read as one aggregate (order, product page, CMS entry) | **Document** |
| Shape varies a lot per record (product attributes per category) | **Document** (or `jsonb` in PostgreSQL) |
| Very high write volume that must scale out from day one | **Document / wide-column**, or distributed SQL |
| Caching, sessions, counters | **Key-value** |
| Team knows one database very well | **That one**, usually |

For a typical e-commerce app, both PostgreSQL and MongoDB work. The deciding factors are usually **access patterns** and **team experience**, not raw capability.

## 8. Myths, debunked

| Myth | Reality |
|---|---|
| "NoSQL has no schema" | The schema is implicit in your code. MongoDB supports `$jsonSchema` validation; most teams also use Mongoose. |
| "MongoDB has no transactions" | Single-document writes are always atomic, and multi-document ACID transactions have been available since 4.0 (replica sets) and 4.2 (sharded clusters). |
| "SQL can't scale" | Read replicas, partitioning, Citus/Vitess sharding and distributed SQL all scale. Most apps never outgrow one well-tuned server. |
| "NoSQL is faster" | Faster for the access pattern it was modelled for (one document read vs a 4-table join). Model it badly and it's slower. Speed comes from the **data model and indexes**, not the label. |
| "MongoDB can't join" | `$lookup` performs left outer joins in aggregation. It's just not the primary design tool. |

> **Remember:** in interviews, never say "X is better". Say "for **this access pattern** I'd pick X, because…, and the trade-off is…".

## 9. Polyglot persistence

Real systems often use **several databases**, each for what it does best. This is **polyglot persistence**:

```text
            ┌──────────────┐
            │  Node.js API │
            └──────┬───────┘
     ┌─────────────┼──────────────┬────────────────┐
┌────▼─────┐  ┌────▼────┐  ┌──────▼───────┐  ┌─────▼─────┐
│PostgreSQL│  │  Redis  │  │Elasticsearch │  │ Warehouse │
│ orders,  │  │sessions,│  │product search│  │  reports  │
│ payments │  │  cache  │  │              │  │           │
└──────────┘  └─────────┘  └──────────────┘  └───────────┘
```

The cost: every extra store must be kept in sync (change streams, CDC, queues), monitored, backed up and understood by the team.

## 10. Common mistakes and trade-offs

- **Modelling MongoDB like SQL.** One collection per table, then `$lookup` everywhere. You get the costs of both and the benefits of neither.
- **Embedding unbounded arrays.** All reviews inside the product document grows forever and hits the **16 MB document limit**. Reference reviews in their own collection.
- **Duplicating data without a plan.** If you copy the user's name into every order, decide whether old orders should update when the name changes (usually: no, it's a snapshot).
- **Picking NoSQL to "avoid migrations".** Your data still changes shape; now the migration lives in application code that must handle old and new documents.
- **Picking SQL and storing everything in one `jsonb` blob.** You lose constraints and the planner's statistics.

**When not to go document-first:** heavy reporting, many-to-many relationships queried in many directions, or strict cross-entity integrity. **When not to go relational-first:** highly variable shapes, aggregate-at-a-time access, or a team that ships fastest with MongoDB and has no relational needs.
