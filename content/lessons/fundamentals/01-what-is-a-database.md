---
slug: what-is-a-database
title: 'What is a database: more than a place to keep data'
module: Foundations
order: 10
summary: What a database and a DBMS actually are, why files are not enough, how data is stored under the hood, and which type of database fits which job.
level: beginner
tags: [database, dbms, fundamentals, oltp, olap, storage, wal]
recap: >-
  Data is facts, a database is an organised collection of them, and a DBMS is the software that stores,
  queries and protects it. You use a DBMS instead of JSON files because it handles concurrent users,
  fast queries, integrity rules and crash safety for you. Under the hood it stores data in fixed-size pages,
  caches hot pages in memory and writes a log before changing pages so it can recover. OLTP serves the app,
  OLAP serves analysts, and each database type (relational, document, key-value, graph and more) fits a job.
---

## 1. The story

Picture a small shop that keeps its orders in a **notebook**. One shopkeeper, one pen, a few orders a day. It works.

Then the shop goes online:

- **Five staff** want to write in the notebook at the same time. Two of them write over each other's lines.
- The owner asks: *"How many orders did Mumbai customers place last week?"* Someone has to read **every page**.
- A staff member writes an order for a product that **doesn't exist**. Nobody notices.
- Someone spills coffee halfway through writing an order. Was it recorded or not?

So the shop hires a **librarian**. Staff no longer touch the notebook. They hand the librarian a request, and the librarian:

- lets people take turns safely,
- keeps an **index** at the back so lookups are instant,
- refuses entries that break the rules,
- keeps a **diary** of every change so a spilled coffee never loses an order.

**That's a database.**

| Story | Technical term |
|---|---|
| The facts written down (order #42, ₹999) | **Data** |
| The organised notebook | **Database** |
| The librarian | **DBMS** (Database Management System) |
| The request slip ("find Mumbai orders") | **Query**, written in a **query language** |
| The index at the back | **Index** |
| The rules ("product must exist") | **Constraints** / **schema** |
| The diary of changes | **Write-ahead log** (WAL) / **journal** |

> **Remember:** **data** = facts, **database** = the organised collection, **DBMS** = the software (PostgreSQL, MongoDB) that stores, queries and protects it. People say "database" for all three.

## 2. Why not just use files or JSON?

Every MERN developer has thought it: *"I could just save `orders.json` with `fs.writeFile`."* Here is what breaks:

| Problem | With a JSON file | With a DBMS |
|---|---|---|
| **Concurrency** | Two requests read, modify, write: one update is silently lost | Locks / MVCC let many users read and write safely |
| **Querying** | Load the whole file, loop in JS | Declarative queries + indexes find rows fast |
| **Integrity** | Nothing stops `price: "abc"` or a missing `userId` | Types, `NOT NULL`, `UNIQUE`, foreign keys, validators |
| **Crash safety** | Crash mid-write = half-written, corrupt file | Log + recovery: a change is fully there or not at all |
| **Size** | File must fit in memory to parse | Data can be far larger than RAM |
| **Security** | File permissions only | Users, roles, per-table permissions |

The **lost update** is the classic one. Two customers buy the last unit of a product at the same moment:

```text
Request A: read stock = 1   ─┐
Request B: read stock = 1   ─┤  both see 1
Request A: write stock = 0  ─┤
Request B: write stock = 0  ─┘  two orders, one item ❌
```

A database gives you tools to prevent this, such as an atomic update with a condition (`stock > 0`) or a transaction.

> **Remember:** a database isn't just storage. It's **concurrency control + fast querying + integrity + crash recovery** that you'd otherwise have to build yourself (badly).

## 3. How data is organised: tables vs documents

The two models you'll meet most:

**Relational (SQL):** data lives in **tables**. Each **row** is one record; each **column** is one attribute with a fixed type.

```text
products
┌────┬──────────────┬────────┬───────┐
│ id │ name         │ price  │ stock │
├────┼──────────────┼────────┼───────┤
│ 1  │ Running shoe │ 2999   │ 40    │
│ 2  │ Water bottle │ 499    │ 120   │
└────┴──────────────┴────────┴───────┘
```

**Document (NoSQL, e.g. MongoDB):** data lives in **collections** of **documents** (JSON-like objects, stored as BSON). Documents can nest objects and arrays.

```js
// collection: products
{
  _id: ObjectId('66f1c0a2e4b0a1b2c3d4e5f6'),
  name: 'Running shoe',
  price: 2999,
  stock: 40,
  sizes: [7, 8, 9, 10],
  specs: { weightGrams: 280, color: 'black' }
}
```

| Relational | Document |
|---|---|
| Database → **table** → **row** → **column** | Database → **collection** → **document** → **field** |
| Fixed columns per table | Each document can have its own shape |
| Related data in other tables, linked by keys | Related data often **embedded** inside the document |

A **schema** is the description of the data's shape: which fields exist, their types, and the rules. PostgreSQL enforces the schema when you write (`CREATE TABLE`). MongoDB is flexible by default, but you can enforce a schema with **JSON Schema validation** on the collection (and Mongoose adds one in your app).

### Query languages

You don't tell the database *how* to find data; you describe *what* you want and its **query planner** picks the how.

```sql
-- PostgreSQL (SQL)
SELECT name, price FROM products WHERE price < 1000 ORDER BY price;
```

```js
// MongoDB (MQL in mongosh)
db.products.find({ price: { $lt: 1000 } }, { name: 1, price: 1 }).sort({ price: 1 })
```

> **Remember:** **SQL** is a declarative language: you say *what*, the planner decides *how*. That's why the same query can go from 5 s to 5 ms after you add an index, without changing a line of app code.

## 4. How a database stores data (high level)

Under the hood, almost every disk-based database follows the same pattern:

```text
   App query
       │
┌──────▼───────────────────────────┐
│  Query planner / executor        │
└──────┬───────────────────────────┘
       │
┌──────▼───────────────────────────┐
│  Memory cache (buffer pool)      │  ← hot pages live here
└──────┬──────────────────┬────────┘
       │                  │ 1. log first
       │           ┌──────▼────────┐
       │           │ Write-ahead   │  append-only, fsync'd
       │           │ log / journal │
       │           └───────────────┘
┌──────▼───────────────────────────┐
│  Data files on disk (pages)      │  ← written later, in batches
└──────────────────────────────────┘
```

- **Pages:** data on disk is stored in fixed-size blocks called **pages** (8 KB by default in PostgreSQL). The database reads and writes whole pages, never single rows.
- **Memory cache:** recently used pages are kept in RAM (PostgreSQL's **shared buffers**, MongoDB WiredTiger's **cache**). Reading from RAM is orders of magnitude faster than disk, which is why "does my working set fit in memory?" matters so much.
- **Indexes:** separate structures (usually **B-trees**) that map a value to where its row lives, so the database doesn't scan every page.

The **write-ahead log** in one paragraph: when you change data, the database doesn't immediately rewrite the data page (slow, random disk I/O). It first **appends a description of the change to a log** and flushes that log to disk (`fsync`). That append is sequential and fast. The changed page stays in memory and is written to its data file later, in batches (a **checkpoint**). If the server crashes, on restart the database **replays the log** to redo any committed changes that never reached the data files. PostgreSQL calls this the **WAL**; MongoDB's WiredTiger engine calls it the **journal**.

> **Remember:** **log first, data files later.** The write-ahead log is how a database is both fast (sequential appends) and crash-safe (replay on restart).

## 5. OLTP vs OLAP: two very different workloads

| | **OLTP** (Online Transaction Processing) | **OLAP** (Online Analytical Processing) |
|---|---|---|
| Who uses it | Your app, in real time | Analysts, dashboards, reports |
| Typical query | "Get order #42", "insert a payment" | "Revenue per category per month for 3 years" |
| Rows touched | A few, by key | Millions, aggregated |
| Writes | Many small, constant | Bulk loads (batch / streaming) |
| Storage layout | Row-oriented | Usually **column-oriented** |
| Examples | PostgreSQL, MySQL, MongoDB | Snowflake, BigQuery, ClickHouse, Redshift |

In the e-commerce store, the checkout writes orders to an **OLTP** database. Every night (or continuously), data is copied into an **OLAP** warehouse, where the business asks big questions without slowing down checkout.

**Column-oriented** storage keeps all values of one column together. `SUM(amount)` then reads only the `amount` column instead of every full row, and similar values compress very well.

## 6. Types of databases

| Type | Purpose in one line | Example product |
|---|---|---|
| **Relational** | Structured data with relationships, joins and strong transactions | PostgreSQL, MySQL |
| **Document** | JSON-like records read and written as a whole, flexible shape | MongoDB |
| **Key-value** | Get/set a value by key, extremely fast; caching and sessions | Redis, DynamoDB |
| **Wide-column** | Huge write volumes spread over many nodes, queried by partition key | Apache Cassandra |
| **Graph** | Data where the relationships are the point (friends, recommendations) | Neo4j |
| **Time-series** | Metrics and events indexed by time, with retention and downsampling | TimescaleDB, InfluxDB |
| **Search** | Full-text search, relevance ranking, fuzzy matching | Elasticsearch, OpenSearch |
| **Vector** | Similarity search over embeddings (semantic search, AI features) | Pinecone, pgvector |

Lines blur in practice: PostgreSQL stores JSON (`jsonb`) and vectors (via the `pgvector` extension); MongoDB has time-series collections, and Atlas adds full-text and vector search. DynamoDB is often described as both key-value and document.

In the e-commerce store you might use **PostgreSQL or MongoDB** for orders, **Redis** for sessions and the cart cache, **Elasticsearch** for the product search box, and a **warehouse** for reports.

> **Remember:** pick the type by **access pattern**, not hype. "How will I read and write this data?" decides the database.

## 7. Common mistakes and gotchas

- **Treating the database as a dumb store.** Doing filtering, sorting and counting in Node after fetching everything. Push the work to the database; it has indexes and a planner.
- **Read-modify-write in app code.** `find` → change in JS → `save` is the lost-update bug from section 2. Use atomic operators (`$inc`, `UPDATE … SET stock = stock - 1 WHERE stock > 0`) or a transaction.
- **Confusing "database" and "DBMS" in interviews.** Say clearly: PostgreSQL is a DBMS; `shop` is a database inside it.
- **Assuming a write is safe the moment the call returns.** It depends on durability settings (PostgreSQL `synchronous_commit`, MongoDB write concern and journaling).
- **Running heavy analytics on the production OLTP database.** A 3-year revenue report can scan the whole `orders` table and slow down checkout. Use a read replica or a warehouse.
- **"Schemaless" means no schema.** The schema still exists; it just lives in your code instead of the database, which is harder to enforce.

## 8. Trade-offs: when a full database is overkill

A DBMS is not free: a server to run, connections, backups, upgrades, monitoring. You may not need one when:

- The data is **read-only config** that ships with the app (a JSON file is fine).
- It's a **single-user local tool**. Consider **SQLite**: a real SQL database in a single file, no server.
- It's **large binary files** (product images, invoices as PDF). Store them in **object storage** (S3) and keep only the URL in the database.
- It's **temporary data** with no durability needs (an in-memory cache may do).

As soon as you have **multiple concurrent users, data you can't lose, or queries beyond "load everything"**, use a real database.
