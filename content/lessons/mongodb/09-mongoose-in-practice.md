---
slug: mongoose-in-practice
title: 'Mongoose in practice: what it does for you and what it hides'
module: Node.js
order: 90
summary: How Mongoose schemas, models, validation, middleware, lean, populate and versioning really behave, and the production pitfalls that trip up experienced Node.js developers.
level: intermediate
tags: [mongoose, nodejs, mongodb, odm, validation, middleware, populate, typescript]
recap: >-
  A Schema describes the shape and rules, a Model is the class bound to a collection, and a Document is
  one hydrated instance. Validation and save hooks run on save and create, but update queries skip save
  hooks and only validate with runValidators. Use lean for read-only data, remember populate is extra
  queries rather than a join, and don't rely on autoIndex in production. Connect once, reuse the pool,
  and always await your queries.
---

## 1. The story

Think of a **passport office**.

- The **official form template** says which fields exist, which are mandatory and what format they need. That's the **Schema**.
- The **passport office** takes filled forms and files them in the right cabinet. That's the **Model**, bound to one collection.
- **One filled, stamped passport** you can hold, check and update. That's a **Document**.
- The **clerk** checks your form before filing it (**validation**), and there are standard steps before and after filing, like photocopying or sending an SMS (**middleware hooks**).

| Passport office | Mongoose |
|---|---|
| Form template | `new Schema({...})` |
| The office / cabinet | `model('Order', orderSchema)` → `orders` collection |
| One passport | `new Order({...})` or a query result |
| Clerk checking the form | Validators |
| Standard steps around filing | `pre` / `post` middleware |

Mongoose is an **ODM** (Object Document Mapper): it sits on top of the official MongoDB Node.js driver and adds structure, casting, validation and hooks.

> **Remember:** Schema = rules, Model = the collection's class, Document = one instance with methods and change tracking.

## 2. Why it exists

MongoDB itself doesn't force a shape on documents. In a team, that freedom quickly turns into `price` being a string in some orders and a number in others. Mongoose gives you:

- **Casting:** `'49.99'` becomes `49.99` if the path is a `Number`.
- **Validation** before data reaches the database.
- **Defaults**, **timestamps**, **virtuals** and **hooks**.
- **populate** to fetch referenced documents.
- **TypeScript types** inferred from your schema.

The price is a layer of magic. Knowing exactly what that magic does, and when it **doesn't** run, is what interviewers test.

## 3. E-commerce schemas

```ts
import { Schema, model, InferSchemaType, Types } from 'mongoose';

const productSchema = new Schema(
  {
    name:     { type: String, required: true, trim: true, maxlength: 200 },
    sku:      { type: String, required: true, unique: true, uppercase: true },
    price:    { type: Number, required: true, min: 0 },
    stock:    { type: Number, default: 0, min: 0 },
    category: { type: String, enum: ['electronics', 'kitchen', 'books'], index: true },
    specs:    { type: Schema.Types.Mixed },   // free-form; see markModified below
  },
  { timestamps: true }                        // adds createdAt + updatedAt
);

export type Product = InferSchemaType<typeof productSchema>;
export const ProductModel = model('Product', productSchema);
```

```ts
const orderItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name:    { type: String, required: true },   // snapshot at purchase time
    price:   { type: Number, required: true, min: 0 },
    qty:     { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const orderSchema = new Schema(
  {
    user:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
    items:  {
      type: [orderItemSchema],
      validate: {
        validator: (items: unknown[]) => items.length > 0,
        message: 'An order needs at least one item',
      },
    },
    status: { type: String, enum: ['pending', 'paid', 'shipped', 'cancelled'], default: 'pending' },
    total:  { type: Number, min: 0 },
  },
  { timestamps: true, optimisticConcurrency: true }
);

orderSchema.index({ user: 1, createdAt: -1 });   // "my orders, newest first"

orderSchema.virtual('itemCount').get(function () {
  return this.items.reduce((n, i) => n + i.qty, 0);
});

export type Order = InferSchemaType<typeof orderSchema>;
export const OrderModel = model('Order', orderSchema);
```

⚠️ `unique: true` is **not a validator**. It only asks Mongoose to create a **unique index**. Duplicates are rejected by MongoDB with an `E11000 duplicate key` error, and only if that index actually exists.

## 4. Validation: when it runs and when it doesn't

| Operation | Validators run? | `save` hooks run? |
|---|---|---|
| `doc.save()`, `Model.create()` | ✅ Always | ✅ |
| `Model.insertMany()` | ✅ | ❌ (`insertMany` hooks instead) |
| `updateOne`, `updateMany`, `findOneAndUpdate`, `findByIdAndUpdate` | ❌ Only with `runValidators: true` | ❌ |
| `Model.collection.*` (raw driver) | ❌ Never | ❌ |

```ts
// ❌ Silently stores a negative price
await ProductModel.updateOne({ sku: 'KB-1' }, { $set: { price: -5 } });

// ✅ Rejected with a ValidationError
await ProductModel.updateOne(
  { sku: 'KB-1' },
  { $set: { price: -5 } },
  { runValidators: true }
);
```

Even with `runValidators: true`, **update validators are limited**:

- They only check the **paths in the update**, not the whole document.
- `required` only fails if the update **unsets** the field or sets it to `null`.
- Inside a custom validator, `this` is **not the document** (the document isn't loaded), so validators that compare two fields don't work the same way.
- They only run for certain operators, such as `$set`, `$unset`, `$push` and `$addToSet`. `$inc` is not validated, so `$inc: { stock: -100 }` can push stock below `min: 0`. Protect it in the filter instead: `{ stock: { $gte: 100 } }`.

> **Remember:** schema validation is guaranteed on `save`/`create`. Update queries skip it unless you pass `runValidators: true`, and even then only partly.

## 5. Middleware: `this` changes meaning

```ts
// DOCUMENT middleware: `this` is the order document
orderSchema.pre('save', function () {
  this.total = this.items.reduce((sum, i) => sum + i.price * i.qty, 0);
});

// QUERY middleware: `this` is the Query, NOT a document
orderSchema.pre('findOneAndUpdate', function () {
  this.setOptions({ runValidators: true });
  const update = this.getUpdate();   // inspect or modify the update
  console.log('updating order with', update);
});
```

| | Document middleware | Query middleware |
|---|---|---|
| Hooks | `save`, `validate`, `deleteOne` / `updateOne` with `{ document: true }` | `find`, `findOne`, `findOneAndUpdate`, `updateOne`, `deleteMany`… |
| `this` | The document | The `Query` object |
| Can read field values? | ✅ `this.total` | ❌ use `this.getFilter()` / `this.getUpdate()` |

The classic bug: you compute `total` in `pre('save')`, then an admin endpoint uses `findByIdAndUpdate` to change items. The save hook never runs, so `total` is now wrong.

## 6. lean(): plain objects, much less work

A normal query **hydrates** each result into a full Mongoose document with change tracking, getters, setters, virtuals and methods like `save()`. That costs CPU and memory.

```ts
const orders = await OrderModel
  .find({ user: userId })
  .sort({ createdAt: -1 })
  .limit(20)
  .select('status total createdAt')
  .lean();          // ← plain JS objects
```

`lean()` returns **plain JavaScript objects** straight from the driver: no hydration, no change tracking, **no virtuals, no getters, no `save()`**. It's noticeably faster and lighter, which is ideal for read-only API responses.

Use full documents when you'll **modify and `save()`**; use `lean()` when you'll **only read and return**.

> **Remember:** default to `.lean()` for read-only endpoints. You lose virtuals, getters and `save()`, which you usually don't need there.

## 7. populate(): extra queries, not a join

```ts
const orders = await OrderModel
  .find({ status: 'paid' })
  .populate('user', 'name email')   // only these fields
  .lean();
```

What actually happens:

```text
 Query 1: orders.find({ status: 'paid' })
          → collects all user ids: [u1, u2, u3...]
 Query 2: users.find({ _id: { $in: [u1, u2, u3...] } })
          → Mongoose stitches users into orders in Node.js
```

So `populate` is **one extra query per populated path**, run by Mongoose, with the merging done **in your app**. That's fine. The **N+1 problem** appears when you misuse it:

```ts
// ❌ N+1: one query for orders, then one per order
const orders = await OrderModel.find({ status: 'paid' });
for (const o of orders) {
  await o.populate('user');
}

// ✅ 2 queries total
const orders = await OrderModel.find({ status: 'paid' }).populate('user');
```

Deep nested populates (`items.product` → `product.brand` → …) add a query per level, and every round trip adds latency.

| | `populate()` | `$lookup` |
|---|---|---|
| Where it runs | Extra queries from Node.js | Inside MongoDB, in one aggregation |
| Round trips | 1 + one per populated path | 1 |
| Filter / sort by joined fields | ❌ Awkward | ✅ |
| Ease of use | ✅ Very easy | More verbose |

See [Aggregation pipeline](/lessons/mongodb-aggregation) for `$lookup`. If you populate the same data on every request, consider **embedding a snapshot**, like we do with `name` and `price` in order items.

## 8. Versioning: what `__v` actually protects

Every document gets a **`versionKey`** field, `__v`. By default it does **not** protect against all concurrent updates. It only protects **array positions** when you use `save()`:

- If one `save()` changes an array in a way that can shift positions (for example removing an element), Mongoose increments `__v`.
- Another `save()` that updates `items.2.qty` based on the old array includes `__v` in its filter. It fails with a **`VersionError`** instead of editing the wrong item.

For full **optimistic concurrency control** on every `save()`, set `optimisticConcurrency: true` on the schema (as in `orderSchema`):

```ts
const a = await OrderModel.findById(id);
const b = await OrderModel.findById(id);
a!.status = 'shipped';   await a!.save();   // __v 0 → 1
b!.status = 'cancelled'; await b!.save();   // ❌ VersionError: b is stale
```

⚠️ This only applies to `save()`. `updateOne` and `findOneAndUpdate` don't check `__v`. Make those safe with atomic operators and conditions in the filter, such as `{ _id, status: 'pending' }`.

## 9. strict and strictQuery

- **`strict`** (default `true`): fields not in the schema are **silently dropped** when you create or update a document. Use `strict: 'throw'` if you'd rather get an error.
- **`strictQuery`** (default `false` since Mongoose 7): fields not in the schema are **passed through** in query **filters**.

Why it matters:

```ts
await OrderModel.deleteMany({ stauts: 'cancelled' });   // typo!
// strictQuery: false → filter on non-existent field → deletes nothing
// strictQuery: true  → unknown field stripped → filter {} → deletes EVERYTHING
```

Also never pass raw `req.body` or `req.query` objects straight into filters, because a user could send `{ "$ne": null }`. Validate input, or use Mongoose's `sanitizeFilter` option.

> **Remember:** `strict` is about what you **write**, `strictQuery` is about what you **filter by**.

## 10. Indexes, connections and production setup

### Indexes: declare in the schema, build deliberately

Mongoose's **`autoIndex`** (on by default) calls `createIndex` for every schema index when the app starts. Building an index on a large production collection at startup can hurt performance at the worst possible moment.

```ts
mongoose.set('autoIndex', false);   // production

// In a deploy/migration step instead:
await OrderModel.createIndexes();   // creates missing indexes from the schema
// syncIndexes() also DROPS indexes not in the schema; use with care
```

See [MongoDB indexes](/lessons/mongodb-indexes) for which indexes to create.

### Connect once, reuse the pool

```ts
await mongoose.connect(process.env.MONGODB_URI!, { maxPoolSize: 20 });
```

`mongoose.connect` creates a **connection pool** (the driver default is `maxPoolSize: 100`). Connect **once at startup** and reuse it. Never connect per request.

In **serverless** functions (Vercel, Lambda), each warm container is reused, so cache the connection promise globally:

```ts
declare global { var mongoosePromise: Promise<typeof mongoose> | undefined }

export function connectDB() {
  global.mongoosePromise ??= mongoose.connect(process.env.MONGODB_URI!, { maxPoolSize: 10 });
  return global.mongoosePromise;
}
```

Keep `maxPoolSize` small there: 500 concurrent function instances × 100 connections each can exhaust your cluster's connection limit.

## 11. Common pitfalls

- **Forgetting `await`.** A Mongoose query is a lazy, thenable `Query`. It only runs when you `await` it, call `.then()` or `.exec()`. `const order = OrderModel.findById(id)` gives you a Query, so `order.status` is `undefined`. Executing the same Query object twice throws "Query was already executed".
- **Invalid ObjectId.** `OrderModel.findById('abc')` rejects with a **`CastError`**, which becomes a 500 unless you handle it. Check with `mongoose.isObjectIdOrHexString(id)` and return 400.
- **Mutating `Mixed` fields or Dates in place.** Mongoose can't detect `product.specs.color = 'red'` on a `Mixed` path, or `date.setMonth(5)`. Call `doc.markModified('specs')` before `save()`, or reassign the whole value.
- **`findOneAndUpdate` returns the old document** by default. Pass `{ new: true }` to get the updated one.
- **Virtuals missing from API responses.** They aren't included in `toJSON()` unless you set `toJSON: { virtuals: true }`, and never with `lean()`.
- **Returning huge documents.** Use `.select()` to fetch only what the endpoint needs, mark secrets with `select: false` (like `passwordHash`), and use `lean()`.

## 12. When NOT to use Mongoose / trade-offs

| | Mongoose | Native driver |
|---|---|---|
| Schemas, casting, validation | ✅ Built in | ❌ DIY (or JSON Schema validation in MongoDB) |
| Hooks, virtuals, populate | ✅ | ❌ |
| Raw performance | Slower (hydration) unless `lean()` | ✅ Fastest |
| New MongoDB features | Sometimes lags | ✅ Immediately |
| Hidden behaviour | ⚠️ Plenty | Very little |

Mongoose is a great default for typical CRUD-heavy MERN apps. Consider the native driver (you can still reach it via `Model.collection` or `mongoose.connection.db`) for high-throughput ingestion, bulk jobs, heavy aggregation services, or when your team prefers **database-side** validation with MongoDB's `$jsonSchema` validator, which protects data no matter which app writes it.

> **Remember:** Mongoose validation only protects writes that go through Mongoose. For rules that must always hold, also enforce them in the database.
