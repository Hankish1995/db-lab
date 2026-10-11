---
slug: mongodb-schema-design
title: 'Schema design: modeling data for how you read it'
module: Data Modeling
order: 30
summary: How to design MongoDB schemas from your queries, when to embed vs reference, how to model each relationship type, and which anti-patterns to avoid.
level: intermediate
tags: [mongodb, schema-design, data-modeling, embedding, references, lookup]
recap: >-
  Data that is accessed together should be stored together. Start from the queries your app runs, not from
  the entities. Embed small, bounded data that is read with its parent; reference data that is large, unbounded,
  shared or updated on its own. Duplicating data is fine when it is read often and changes rarely, or when it
  must be frozen in time, like the price on an order.
---

## 1. The story: packing for a trip

You're packing for a week-long trip.

- **Toothbrush, charger, passport:** you need them every day, together. They go **in the same bag** (**embed**).
- **Your winter coat collection:** large, and you need one at most. You **leave a note** saying "coats are in the hall closet" (**reference**).
- **A photo of your hotel booking:** you **copy** it to your phone even though the original is in your email, because you'll need it at the front desk with no Wi-Fi (**duplication**).

Nobody packs by category ("all clothes in one bag, all papers in another, all electronics in a third"). You pack by **when you'll use things together**.

> **Remember:** the golden rule: **data that is accessed together should be stored together.**

## 2. Why MongoDB modeling is different

In SQL, you **normalize first**: one table per entity, no duplication, and joins answer any question later. The schema is driven by the **data**.

In MongoDB, the schema is driven by the **workload**:

1. List the operations: "show product page", "place order", "list my orders".
2. Estimate how often each runs and how much data it touches.
3. Shape documents so the **most frequent operations hit one document**, ideally with one index lookup.

```text
SQL thinking                    MongoDB thinking
┌──────────────────────┐        ┌──────────────────────┐
│ 1. What entities?    │        │ 1. What queries?     │
│ 2. Normalize them    │        │ 2. How often? How big│
│ 3. Write any query   │        │ 3. Shape docs to fit │
│    with joins later  │        │    the hot queries   │
└──────────────────────┘        └──────────────────────┘
```

A model that's great for one app can be terrible for another with the same entities but different queries. There's no single "correct" schema.

> **Remember:** design for your queries, not for your entities. A read-heavy product page and a write-heavy event log need different shapes even for similar data.

## 3. Embed vs reference

**Embedding** puts related data inside the parent document. **Referencing** stores the related data in its own collection and keeps its `_id` in the parent (or the child).

```js
// Embedded: address lives inside the user
{ _id: 1, name: "Asha", address: { city: "Pune", pin: "411001" } }

// Referenced: the order points to the user
{ _id: 9001, userId: 1, total: NumberDecimal("59.98") }
```

| Question | Leans to **embed** | Leans to **reference** |
|---|---|---|
| Read together with the parent? | Almost always | Often read alone |
| How many? | Few, **bounded** | Many or **unbounded** |
| Changes independently? | Rarely | Often |
| Shared by many parents? | No | Yes (one category, many products) |
| Needs atomic update with parent? | Yes (single-doc atomicity) | No |
| Size | Small | Large |

Embedding gives you **one read** and **atomic updates** for free (writes to a single document are atomic). Referencing gives you **smaller documents**, **no duplication** and **independent growth**, at the cost of a second query or a `$lookup`.

## 4. Relationship types

### One-to-one: embed

A user and their profile settings. Unless the data is huge or rarely read, embed it.

```js
{ _id: 1, email: "asha@shop.in", settings: { currency: "INR", newsletter: true } }
```

### One-to-few: embed an array

A user has 1–5 saved addresses. Bounded and always shown with the user.

```js
{ _id: 1, name: "Asha",
  addresses: [ { label: "home", city: "Pune" }, { label: "work", city: "Mumbai" } ] }
```

### One-to-many: array of references in the parent

A product has a few dozen to a few hundred parts or variants that are also queried on their own. Keep their IDs in the parent:

```js
// products
{ _id: "BUNDLE-1", name: "Desk setup", partIds: ["LAMP-1", "MAT-2", "CHAIR-7"] }
```

This works while the list stays **bounded** (hundreds, not millions).

### One-to-squillions: reference from the child to the parent

A product has **millions of page-view logs**, or a popular product gets **hundreds of thousands of reviews**. An array in the product would grow forever and eventually break the 16 MB limit. Flip it: each child stores the parent's ID.

```js
// reviews: each review points to its product
{ _id: ObjectId("..."), productId: "TEE-01", userId: 1, rating: 5, text: "Great fit" }

db.reviews.createIndex({ productId: 1, createdAt: -1 })
db.reviews.find({ productId: "TEE-01" }).sort({ createdAt: -1 }).limit(20)
```

### Many-to-many: arrays of references (on one or both sides)

Products ↔ categories. A product is in a few categories; a category has many products. Store the small side as an array:

```js
// products
{ _id: "TEE-01", name: "T-Shirt", categoryIds: ["men", "summer", "cotton"] }

db.products.createIndex({ categoryIds: 1 })   // multikey index
db.products.find({ categoryIds: "summer" })   // all products in a category
```

Storing `productIds` inside each category too would make the category document unbounded. Keep the array on the side that stays small.

```text
Relationship        Typical size       Model
───────────────────────────────────────────────────────
One-to-one          1                  embed
One-to-few          few, bounded       embed array
One-to-many         hundreds           array of refs
One-to-squillions   unbounded          child → parent ref
Many-to-many        both sides many    refs on small side
```

> **Remember:** the question isn't just "one-to-many?" but "one-to-**how many**?" Bounded and small: embed. Unbounded: the child points to the parent.

## 5. Duplication is a tool, not a sin

In SQL, duplicating data is a normalization failure. In MongoDB, it's a deliberate trade-off: **faster reads in exchange for harder updates**.

The best example: **order line items**.

```js
// orders
{
  _id: 9001,
  userId: 1,
  items: [
    { productId: "TEE-01", name: "T-Shirt", price: NumberDecimal("19.99"), qty: 2 }
  ],
  total: NumberDecimal("39.98"),
  createdAt: ISODate("2026-10-11T10:00:00Z")
}
```

Copying `name` and `price` into the order isn't just "faster"; it's **correct**. If the T-shirt costs ₹24.99 next month, this order must still say ₹19.99: that's what the customer paid, and it's what the invoice and refund logic need. A join to the current product would show the **wrong** price.

Before you duplicate, ask:

- **How often does the copied field change?** Product name: rarely. Stock level: constantly. Don't copy stock.
- **Must the copy stay in sync, or is it a snapshot?** Order prices are snapshots: never update them.
- **If it must sync, how many copies?** Updating a category name in 50,000 products is a background job you need to own.

> **Remember:** duplicate data that is **read often and changes rarely**, or that must be **frozen in time** (prices on an order). Never duplicate fast-changing data like stock counts.

## 6. When you do need a join: `$lookup`

MongoDB can join with `$lookup` in the [aggregation pipeline](/lessons/mongodb-aggregation):

```js
db.orders.aggregate([
  { $match: { userId: 1 } },
  { $lookup: { from: "users", localField: "userId",
               foreignField: "_id", as: "user" } },
  { $unwind: "$user" }
])
```

Its cost:

- For each input document, MongoDB has to find the matches in the other collection. **Index the `foreignField`**; without an index, the server must scan the foreign collection (newer query engines may build a hash table from it instead), which gets expensive as data grows.
- It's an extra stage on every read, so it's fine for **admin screens and reports**, but a smell on your hottest path.
- Joins across shards in a [sharded](/lessons/sharding) cluster are more expensive still.

If your most frequent page needs `$lookup` on every request, your schema probably separated data that's accessed together.

## 7. The full e-commerce model

```text
┌───────────┐  userId   ┌──────────────────────────┐
│  users    │◄──────────│ orders                   │
│ addresses │           │ items[] = copies of      │
│ (embedded)│           │ name, price, qty         │
└─────▲─────┘           │ shipping address (copy)  │
      │ userId          └──────────────────────────┘
┌─────┴─────┐ productId ┌──────────────────────────┐
│  reviews  │──────────►│ products                 │
│ (own coll)│           │ variants[], categoryIds[]│
└───────────┘           │ ratingAvg, ratingCount   │
                        └────────────▲─────────────┘
┌───────────┐ productId              │
│ inventory │────────────────────────┘
│ per store │
└───────────┘
```

| Collection | Key decisions | Why |
|---|---|---|
| `users` | Embed addresses (bounded) | Always shown with the user; 1–5 items |
| `products` | Embed variants and specs; `categoryIds` array; pre-computed `ratingAvg`/`ratingCount` | Product page = one read; categories are many-to-many |
| `orders` | Reference `userId`; **copy** product name/price and the shipping address into the order | Order is a historical snapshot; must not change when products or addresses change |
| `reviews` | Separate collection, `productId` on each review | Unbounded (one-to-squillions); paged independently |
| `inventory` | Separate collection, one doc per product per store/warehouse | Updated constantly by many writers; keeps product docs stable and avoids write contention |

Why not embed inventory in products? Stock changes on every sale, while product details change rarely. Keeping them apart means hot stock updates don't rewrite large product documents, and the read-heavy product page can be cached.

> **Remember:** each decision comes from a query: "show product page" → embed variants; "list reviews" → separate collection; "print an invoice from 2024" → copy prices into the order.

## 8. Anti-patterns

- **Massive or unbounded arrays.** Every review, log line or follower inside one document. Each update rewrites a growing document, indexes on the array balloon, and eventually you hit 16 MB.
- **Too many collections.** One collection per customer or per day ("orders_2026_10_11"). Each collection and index has storage-engine overhead, and queries across them get painful. Use a field plus an index instead.
- **Unnecessary indexes.** Each index slows every write and uses RAM. Index for real queries only (see [MongoDB indexes](/lessons/mongodb-indexes)).
- **Separating data that's always read together.** Putting a product's variants in their own collection "to normalize" forces a second query or `$lookup` on every product view.
- **Bloated documents.** Embedding large, rarely read data (a product's full change history) in a document that's read constantly. Every read drags it along.
- **Copying fast-changing data.** Duplicating stock levels into category pages means a write storm on every sale.

## 9. Embedding vs referencing at a glance

| | Embedding | Referencing |
|---|---|---|
| Reads | ✅ One query | ❌ Extra query or `$lookup` |
| Atomic update with parent | ✅ Single-document atomic | ❌ Needs a transaction |
| Document size | ❌ Grows with children | ✅ Stays small |
| Duplication | ⚠️ Often duplicated | ✅ Stored once |
| Children queried alone | ❌ Awkward | ✅ Natural |
| Unbounded children | ❌ Breaks at 16 MB | ✅ Fine |

## 10. Trade-offs and when this approach hurts

- **Changing access patterns.** A schema tuned for today's queries can fit poorly when the product changes. Use the [schema versioning pattern](/lessons/mongodb-schema-patterns) and migrate gradually.
- **Duplication needs ownership.** Every copy needs a rule: snapshot (never update) or sync (who updates it, and how fast?).
- **Highly relational, ad-hoc analytics.** If the main job is arbitrary joins across many entities, a relational database or a separate analytics store may fit better (see [SQL vs NoSQL](/lessons/sql-vs-nosql)).
- **Multi-document consistency.** If you need to update many separate documents atomically all the time, either embed them, or accept the cost of [transactions](/lessons/mongodb-transactions).
