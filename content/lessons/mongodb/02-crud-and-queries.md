---
slug: mongodb-crud-and-queries
title: 'CRUD and queries: talking to MongoDB fluently'
module: Basics
order: 20
summary: How to insert, find, update and delete documents in mongosh, including array queries, update operators, upserts and atomic find-and-modify.
level: beginner
tags: [mongodb, crud, queries, update-operators, arrays, elemmatch, upsert]
recap: >-
  Inserts can be ordered (stop at first error) or unordered (keep going). find takes a filter of operators
  plus a projection, and the server always applies sort, then skip, then limit. Arrays need care: use
  $elemMatch when several conditions must hold for the same element. Updates use operators like $set, $inc,
  $push and arrayFilters, are atomic per document, and findOneAndUpdate reads and changes in one atomic step.
---

## 1. The story: the shop's stock clerk

Your shop has a stock clerk with a filing cabinet. Every request you give them is one of four kinds:

- "File this new product folder." → **Create** (`insertOne`)
- "Bring me every blue shirt under ₹500." → **Read** (`find`)
- "Change the price on folder #42." → **Update** (`updateOne`)
- "Throw away discontinued folders." → **Delete** (`deleteMany`)

A good clerk also understands *precise* requests: "only the price, not the whole folder" (**projection**), "the 10 cheapest" (**sort + limit**), and "add 5 units to the stock count on the sheet, don't rewrite the sheet" (**update operators**).

> **Remember:** every request has two parts: **which documents** (the filter) and **what to do** with them (return, change, delete).

## 2. Why the details matter

CRUD looks easy, and that's why bugs hide here:

- A wrong array filter returns orders that **don't** match.
- A read-then-write in your Node code lets **two buyers grab the last item**.
- Replacing a document instead of updating it **wipes fields**.

Each of these is a classic interview question. Let's go through them with our store: `products`, `orders`, `users`.

## 3. Create

```js
db.products.insertOne({ sku: "MUG-01", name: "Coffee Mug", price: NumberDecimal("9.99"),
                        stock: 40, tags: ["kitchen", "ceramic"] })

db.products.insertMany([
  { sku: "TEE-01", name: "T-Shirt", price: NumberDecimal("19.99"), stock: 100 },
  { sku: "LAMP-1", name: "Desk Lamp", price: NumberDecimal("34.50"), stock: 8 }
])
```

### Ordered vs unordered `insertMany`

Say the second document has a duplicate `_id`:

```js
db.orders.insertMany([{ _id: 1 }, { _id: 1 }, { _id: 2 }])
// ordered (default): inserts _id 1, fails on the duplicate, STOPS → 1 doc

db.orders.insertMany([{ _id: 1 }, { _id: 1 }, { _id: 2 }], { ordered: false })
// unordered: skips the failure, keeps going → 2 docs, then reports the error
```

⚠️ In both cases, documents inserted before the error **stay inserted**. `insertMany` is not a transaction. Unordered can also be faster for bulk loads, because the server doesn't have to execute the writes strictly one after another.

## 4. Read: filters and operators

```js
db.products.find({ stock: { $lt: 10 } })                 // low stock
db.products.find({ price: { $gte: NumberDecimal("10"), $lte: NumberDecimal("50") } })
db.orders.find({ status: { $in: ["paid", "shipped"] } })
db.orders.find({ status: { $ne: "cancelled" } })         // also matches docs with no status
db.users.find({ $or: [{ city: "Pune" }, { isPrime: true }] })
db.users.find({ phone: { $exists: false } })
db.products.find({ price: { $type: "string" } })         // find bad data
db.products.find({ name: { $regex: /^Cof/ } })           // prefix search
```

| Operator family | Operators |
|---|---|
| Comparison | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin` |
| Logical | `$and`, `$or`, `$not`, `$nor` |
| Element | `$exists`, `$type` |
| Pattern | `$regex` |

Things worth knowing:

- Several conditions in one filter object are an **implicit `$and`**. You need an explicit `$and` only when you repeat the same operator, e.g. two `$or` clauses.
- `$ne` and `$nin` also match documents **where the field is missing**.
- `{ field: null }` matches documents where the field is null **or missing**. Use `{ field: { $type: "null" } }` for only explicit nulls.
- An anchored, case-sensitive regex (`/^Cof/`) can use an index efficiently. A case-insensitive or unanchored regex can't use an index efficiently and usually ends up checking far more.

### Dot notation for embedded fields

```js
db.users.find({ "address.city": "Pune" })     // field inside a sub-document
db.orders.find({ "items.sku": "MUG-01" })     // field inside an array of docs
```

Quotes are required around dotted paths.

## 5. Querying arrays (where the bugs live)

```js
// product: { tags: ["red", "cotton"] }
db.products.find({ tags: "red" })                  // ✅ contains "red"
db.products.find({ tags: ["red", "cotton"] })      // ✅ exact array, same order
db.products.find({ tags: ["cotton", "red"] })      // ❌ different order, no match
db.products.find({ tags: { $all: ["cotton", "red"] } })  // ✅ contains both, any order
db.products.find({ tags: { $size: 2 } })           // exactly 2 elements
```

### The classic `$elemMatch` bug

An order:

```js
{ _id: 1, items: [ { sku: "MUG-01", qty: 1 }, { sku: "TEE-01", qty: 5 } ] }
```

Task: "find orders where someone bought **5 or more mugs**."

```js
// ❌ WRONG: matches order 1!
db.orders.find({ "items.sku": "MUG-01", "items.qty": { $gte: 5 } })
```

Why? Each condition is checked against the array **independently**: *some* item is a mug (item 0), and *some* item has qty ≥ 5 (item 1, the T-shirts). Different elements satisfied different conditions.

```text
items[0] { sku: MUG-01, qty: 1 } ──► sku is MUG-01  ✔
items[1] { sku: TEE-01, qty: 5 } ──► qty >= 5       ✔
                     result: order 1 matches (wrong!)
```

```js
// ✅ RIGHT: both conditions on the SAME element
db.orders.find({ items: { $elemMatch: { sku: "MUG-01", qty: { $gte: 5 } } } })
```

The same trap exists for scalar arrays: `{ scores: { $gt: 5, $lt: 10 } }` matches `[2, 12]` (12 > 5, 2 < 10). Use `{ scores: { $elemMatch: { $gt: 5, $lt: 10 } } }`.

> **Remember:** when two or more conditions must be true for **the same array element**, use `$elemMatch`. Without it, each condition can be satisfied by a different element.

## 6. Projection, sort, skip, limit

```js
db.products.find(
  { stock: { $gt: 0 } },
  { name: 1, price: 1, _id: 0 }   // projection: only these fields
).sort({ price: 1 }).skip(20).limit(10)
```

- A projection is **either inclusion or exclusion**. You can't mix `{ name: 1, stock: 0 }`; the only exception is `_id: 0` inside an inclusion projection.
- Order of application is always **sort → skip → limit**, no matter the order you chain them. `.limit(10).skip(20).sort({price: 1})` does the same thing.
- Large `skip` values are slow, because the server still walks past every skipped document. For deep pages, use **range-based pagination**: `find({ price: { $gt: lastSeenPrice } }).limit(10)` (with a tie-breaker such as `_id`).

## 7. Update

`updateOne` changes the first match; `updateMany` changes all matches. The second argument uses **update operators**:

```js
db.products.updateOne({ sku: "MUG-01" }, {
  $set:   { price: NumberDecimal("8.99"), "seo.title": "Mug" }, // set (creates path)
  $unset: { legacyCode: "" },              // remove a field
  $inc:   { stock: -1, "stats.sold": 1 }   // add / subtract
})
```

| Operator | Does | Example |
|---|---|---|
| `$set` / `$unset` | Set / remove a field | `{ $set: { isActive: false } }` |
| `$inc` / `$mul` | Add / multiply | `{ $inc: { stock: 5 } }` |
| `$min` / `$max` | Update only if new value is lower / higher | `{ $min: { lowestPrice: NumberDecimal("8") } }` |
| `$push` | Append to array | `{ $push: { tags: "sale" } }` |
| `$addToSet` | Append if not already present | `{ $addToSet: { tags: "sale" } }` |
| `$pull` | Remove matching elements | `{ $pull: { tags: "sale" } }` |
| `$pop` | Remove first (`-1`) or last (`1`) | `{ $pop: { recent: -1 } }` |

### `$push` with `$each` and `$slice`: a capped "recently viewed" list

```js
db.users.updateOne({ _id: userId }, {
  $push: { recentlyViewed: { $each: [productId], $slice: -10 } }
})
// appends, then keeps only the LAST 10 elements
```

### Updating array elements

```js
// $  → the FIRST element that matched the query
db.orders.updateOne({ _id: 1, "items.sku": "MUG-01" }, { $inc: { "items.$.qty": 1 } })

// $[] → ALL elements
db.orders.updateOne({ _id: 1 }, { $set: { "items.$[].shipped": true } })

// $[elem] + arrayFilters → all elements matching a condition
db.orders.updateOne(
  { _id: 1 },
  { $set: { "items.$[it].qty": 0 } },
  { arrayFilters: [{ "it.sku": "TEE-01" }] }
)
```

### Upsert: update or insert

```js
db.carts.updateOne(
  { userId: 7 },
  { $inc: { itemCount: 1 }, $setOnInsert: { createdAt: new Date() } },
  { upsert: true }
)
```

If no cart exists, MongoDB inserts one built from the filter (`userId: 7`) plus the update. `$setOnInsert` fields are written **only** on insert.

⚠️ Two concurrent upserts with the same filter can both insert, creating duplicates, unless a **unique index** exists on the filter field (`userId`). With the index, only one insert can win. The server automatically retries the loser as an update when the filter is an **equality match on the unique index's fields** and the update doesn't change those fields (as here); otherwise the loser gets an `E11000` duplicate-key error and your code should retry it.

### `replaceOne` vs `updateOne`

```js
db.products.replaceOne({ sku: "MUG-01" }, { sku: "MUG-01", name: "Mug" })
// the whole document is now { _id, sku, name }: price, stock, tags are GONE
```

| | `updateOne` | `replaceOne` |
|---|---|---|
| Second argument | Update operators (`$set`…) | A plain document |
| Other fields | Kept | Removed (only `_id` is kept) |
| Mixing them up | "Update document requires atomic operators" | "Replacement document must not contain atomic operators" |

> **Remember:** `updateOne` edits fields; `replaceOne` swaps the whole document. Mongoose's `findByIdAndUpdate` wraps plain objects in `$set` for you, which is why many developers never notice the difference.

## 8. `findOneAndUpdate`: read and write in one atomic step

Selling the last lamp, the wrong way:

```js
const p = await products.findOne({ sku: "LAMP-1" })     // stock: 1
if (p.stock > 0) await products.updateOne({ sku: "LAMP-1" }, { $inc: { stock: -1 } })
```

Two requests can both read `stock: 1` before either writes, so you sell 2 lamps you don't have.

The right way puts the condition **inside** the update:

```js
db.products.findOneAndUpdate(
  { sku: "LAMP-1", stock: { $gt: 0 } },   // condition
  { $inc: { stock: -1 } },                // change
  { returnDocument: "after" }             // return the new version
)
// returns null if out of stock
```

Every single-document write in MongoDB is **atomic**: the match and the modification happen together, so no other write can slip in between. `findOneAndUpdate` also **returns** the document (by default the version *before* the update; `returnDocument: "after"` gives the new one).

> **Remember:** never check-then-write from application code. Put the condition in the filter and let one atomic operation decide. For changes across several documents, use a [transaction](/lessons/mongodb-transactions).

## 9. Delete, count, bulk

```js
db.carts.deleteMany({ updatedAt: { $lt: ISODate("2026-01-01") } })
db.products.deleteOne({ sku: "OLD-01" })
db.products.deleteMany({})   // ⚠️ deletes everything (indexes stay)
```

| | `countDocuments(filter)` | `estimatedDocumentCount()` |
|---|---|---|
| How | Runs a real query (an aggregation) | Reads collection metadata |
| Filter | Yes | No |
| Accuracy | Exact | Can be off (e.g. after an unclean shutdown, or orphaned docs in a sharded cluster) |
| Speed | Proportional to matched data | Near-instant |

Use `estimatedDocumentCount()` for "≈ 1.2M products" in an admin header, `countDocuments` for "3 items in your cart".

`bulkWrite` sends many different operations in one round trip:

```js
db.products.bulkWrite([
  { updateOne: { filter: { sku: "MUG-01" }, update: { $inc: { stock: 50 } } } },
  { updateOne: { filter: { sku: "TEE-01" }, update: { $inc: { stock: 20 } } } },
  { deleteOne: { filter: { sku: "OLD-01" } } }
], { ordered: false })
```

Like `insertMany`, it's **not** all-or-nothing; `ordered` only controls whether it stops at the first error.

## 10. Common mistakes

- ❌ Multiple conditions on array elements without `$elemMatch`.
- ❌ Read-then-write in Node instead of a conditional atomic update → overselling, double-spending.
- ❌ `replaceOne` (or an update without operators) when you meant `$set`.
- ❌ Expecting `$ne: "cancelled"` to skip documents without a `status`.
- ❌ Deep pagination with huge `skip` values.
- ❌ Assuming `insertMany`/`bulkWrite` roll back on error.
- ❌ Upserting on a field without a unique index → duplicates under concurrency.

## 11. Trade-offs to keep in mind

- **Atomic only per document.** A single update can't atomically change an order *and* the inventory document. Either model them together, or use a transaction (which costs more).
- **Rich updates vs readability.** `arrayFilters` and positional operators are powerful but easy to get wrong; test them on sample data first.
- **Counting is not free.** Exact counts over large filters scan data; cache or estimate when exactness doesn't matter.
- Complex reshaping, grouping and joins belong in the [aggregation pipeline](/lessons/mongodb-aggregation), not in chains of `find` calls in your code.
