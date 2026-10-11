---
slug: mongodb-schema-patterns
title: 'Schema design patterns: proven shapes for common problems'
module: Data Modeling
order: 40
summary: The ten MongoDB schema design patterns interviewers ask about, each with the problem it solves, an e-commerce example, and when not to use it.
level: advanced
tags: [mongodb, schema-design, patterns, bucket, computed, subset, outlier, tree]
recap: >-
  Schema patterns are reusable answers to recurring modeling problems. Attribute tames many optional fields,
  bucket groups small time-based records, computed pre-calculates expensive values, subset and extended
  reference copy just the hot part of related data, outlier handles the rare huge document, polymorphic and
  schema versioning handle different shapes, approximation cuts write load, and tree patterns model hierarchies.
  Every pattern trades write complexity or duplication for faster reads.
---

## 1. The story: a chef's prep tricks

A busy restaurant kitchen doesn't cook every dish from scratch when the order arrives. Chefs use **prep tricks**:

- Sauces are made **in batches** in the morning (bucket).
- The soup of the day is **pre-cooked**; nobody simmers it per order (computed).
- Each station keeps **a few of the most-used ingredients** at hand; the rest stay in the walk-in fridge (subset).
- One VIP table with a 40-course tasting menu gets **its own handling**, so it doesn't slow every other table (outlier).

These tricks aren't recipes. They're **patterns** that any kitchen can apply to many dishes. MongoDB's **schema design patterns** are the same: reusable shapes for recurring problems, built on the golden rule from [Schema design](/lessons/mongodb-schema-design).

> **Remember:** almost every pattern trades **more work on writes** (or some duplication) for **faster, simpler reads**. Use one only when your read pattern justifies that price.

## 2. Attribute pattern

**Problem:** products have dozens of optional, type-specific fields (`ram`, `screenSize`, `fabric`, `capacityMl`…). To filter on them you'd need an index per field.

**Solution:** move them into an array of key–value pairs and index the pair once.

```js
{ _id: "LAPTOP-7", name: "Ultrabook 14",
  attrs: [ { k: "ram", v: "16GB" }, { k: "cpu", v: "M3" }, { k: "screen", v: 14 } ] }

db.products.createIndex({ "attrs.k": 1, "attrs.v": 1 })
db.products.find({ attrs: { $elemMatch: { k: "ram", v: "16GB" } } })
```

Note `$elemMatch`: the key and value must match the **same** element.

**When not to use it:** when there are only a few known fields (plain fields are simpler to query and validate). A **wildcard index** (`{ "specs.$**": 1 }`) on a normal sub-document is an alternative that keeps the natural shape.

## 3. Bucket pattern

**Problem:** one document per page view or per price change creates millions of tiny documents, each with its own `_id` and index entries.

**Solution:** group events into one document per **time window** (per product per hour, say).

```js
// productViews: one bucket per product per hour
{ productId: "TEE-01", hour: ISODate("2026-10-11T10:00:00Z"),
  count: 3, views: [ { at: ISODate("2026-10-11T10:02:11Z"), userId: 7 }, /* … */ ] }

db.productViews.updateOne(
  { productId: "TEE-01", hour: ISODate("2026-10-11T10:00:00Z"), count: { $lt: 1000 } },
  { $push: { views: { at: new Date(), userId: 7 } }, $inc: { count: 1 } },
  { upsert: true }
)
```

The `count: { $lt: 1000 }` cap keeps buckets bounded: a full bucket no longer matches, so the upsert starts a new one.

**The modern alternative:** for measurements over time, use a built-in **time series collection**. MongoDB buckets the data internally for you, with compression and time-based queries:

```js
db.createCollection("productViews", {
  timeseries: { timeField: "at", metaField: "productId", granularity: "minutes" }
})
```

**When not to use it:** when you mostly access **individual events** by ID or update them often. Prefer time series collections over hand-rolled buckets for plain time-series data.

## 4. Computed pattern

**Problem:** the product page shows "4.3 ★ (1,284 reviews)". Computing it with an aggregation over all reviews on every page view is wasteful: reads outnumber new reviews by thousands to one.

**Solution:** compute on write, store the result.

```js
// when a review is added
db.products.updateOne({ _id: "TEE-01" }, { $inc: { ratingCount: 1, ratingSum: 5 } })
// ratingAvg = ratingSum / ratingCount (store it too, or compute when reading)
```

Order `total`, `itemCount` and a user's `lifetimeSpend` are the same idea.

**When not to use it:** when the value is rarely read, or the inputs change so often that recomputing costs more than reading. Also beware drift: if a write path forgets to update the computed field, it silently becomes wrong. Keep a periodic job that recomputes from source.

> **Remember:** compute once when data changes, not every time someone reads it, as long as reads vastly outnumber writes.

## 5. Subset pattern

**Problem:** embedding all reviews makes the product document huge, but the page only shows the **latest 10**.

**Solution:** embed the hot subset, keep the full set in its own collection.

```js
// products
{ _id: "TEE-01", name: "T-Shirt", ratingAvg: 4.3,
  recentReviews: [ { user: "Asha", rating: 5, text: "Great fit" } /* max 10 */ ] }

// on new review: insert into reviews AND keep the newest 10 in the product
db.reviews.insertOne({ productId: "TEE-01", user: "Asha", rating: 5, text: "Great fit" })
db.products.updateOne({ _id: "TEE-01" }, {
  $push: { recentReviews: { $each: [{ user: "Asha", rating: 5, text: "Great fit" }],
                            $position: 0, $slice: 10 } }
})
```

**When not to use it:** when the UI usually needs the full set anyway, or when the subset is hard to keep in sync (e.g. reviews are frequently edited or deleted).

## 6. Extended reference pattern

**Problem:** the order list shows customer name and shipping address. A `$lookup` to `users` on every order view is costly, and the user's *current* address isn't even the right one.

**Solution:** copy the **few fields you need** from the referenced document, alongside the reference.

```js
{ _id: 9001,
  customer: { _id: 1, name: "Asha Rao" },          // extended reference
  shipTo: { line1: "12 MG Road", city: "Pune", pin: "411001" },
  items: [ /* … */ ] }
```

**When not to use it:** when the copied fields change frequently and must stay in sync everywhere. Copy only fields that are stable or that should be frozen as a snapshot.

## 7. Outlier pattern

**Problem:** 99.9% of products have under 500 reviews, but one viral product has **2 million**. Designing everything around the outlier punishes all the normal products.

**Solution:** design for the common case, and **flag** the outliers so they overflow into extra documents.

```js
// normal product
{ _id: "MUG-01", reviewIds: [/* up to 500 */] }

// outlier: flagged, extra reviews live in overflow docs
{ _id: "VIRAL-1", reviewIds: [/* first 500 */], hasOverflow: true }
{ productId: "VIRAL-1", page: 2, reviewIds: [/* next 500 */] }
```

The app checks `hasOverflow` and fetches the overflow documents only for those few products.

**When not to use it:** when outliers aren't rare; then your "normal" design is simply wrong. The app must also handle two code paths.

## 8. Polymorphic pattern

**Problem:** books, laptops and T-shirts are all "products" but have different fields. Separate collections would make "search all products" painful.

**Solution:** one collection, a common core, and a **type discriminator**.

```js
{ type: "book",   name: "DDIA",   price: NumberDecimal("45.00"), author: "Kleppmann", pages: 616 }
{ type: "laptop", name: "Air 14", price: NumberDecimal("999.00"), ramGb: 16, cpu: "M3" }
{ type: "tshirt", name: "Tee",    price: NumberDecimal("19.99"), sizes: ["M", "L"] }
```

Shared fields (`name`, `price`) get shared indexes; type-specific queries add `type` to the filter. Mongoose **discriminators** implement exactly this.

**When not to use it:** when the types share almost nothing and are never queried together; then separate collections are clearer.

## 9. Schema versioning pattern

**Problem:** you're changing `address` (a string) into a structured sub-document. Migrating 50 million users at once means a long, risky job or downtime.

**Solution:** add a `schemaVersion` field. The app reads both versions, writes the new one, and documents migrate **gradually** (on read, on write or by a background job).

```js
{ _id: 1, schemaVersion: 1, address: "12 MG Road, Pune 411001" }
{ _id: 2, schemaVersion: 2, address: { line1: "12 MG Road", city: "Pune", pin: "411001" } }
```

**When not to use it:** for small collections where a quick one-time migration is simpler. And don't let old versions live forever: finish the migration and drop the old code path.

> **Remember:** the schema versioning pattern turns one risky big-bang migration into a gradual, zero-downtime one.

## 10. Approximation pattern

**Problem:** a "viewed 1.2M times" counter on a busy product means one write per view on the same hot document.

**Solution:** when an exact number isn't needed, **update less often**: increment by 100 roughly once every 100 views.

```js
// in the app
if (Math.random() < 0.01) {
  db.products.updateOne({ _id: "TEE-01" }, { $inc: { viewCount: 100 } })
}
```

Writes drop about 100×; the count stays statistically close.

**When not to use it:** for anything that must be exact: stock, money, order counts, billing.

## 11. Tree patterns: the category hierarchy

```text
Electronics
├── Computers
│   ├── Laptops
│   └── Desktops
└── Phones
```

| Pattern | Each category stores | Good at | Weak at |
|---|---|---|---|
| **Parent references** | `parent: "Computers"` | Finding parent; moving a subtree | All descendants (needs `$graphLookup`) |
| **Child references** | `children: ["Laptops", "Desktops"]` | Finding children | Finding parent/ancestors |
| **Array of ancestors** | `ancestors: ["Electronics", "Computers"]`, `parent` | Breadcrumbs; "all under X" | Moving subtrees (rewrite many docs) |
| **Materialized path** | `path: ",Electronics,Computers,"` | Subtree via prefix regex | Moving subtrees; string discipline |

```js
// array of ancestors: breadcrumbs in one read, subtree via index
{ _id: "Laptops", parent: "Computers", ancestors: ["Electronics", "Computers"] }
db.categories.createIndex({ ancestors: 1 })
db.categories.find({ ancestors: "Computers" })      // everything under Computers

// materialized path: anchored, case-sensitive prefix regex can use an index
{ _id: "Laptops", path: ",Electronics,Computers," }
db.categories.createIndex({ path: 1 })
db.categories.find({ path: /^,Electronics,Computers,/ })

// parent references: walk the tree on the server
db.categories.aggregate([
  { $match: { _id: "Electronics" } },
  { $graphLookup: { from: "categories", startWith: "$_id",
                    connectFromField: "_id", connectToField: "parent",
                    as: "descendants" } }
])
```

For e-commerce, **array of ancestors** is a strong default: category trees are read constantly (breadcrumbs, "all laptops under Computers") and restructured rarely.

## 12. Common mistakes

- ❌ Applying patterns because they exist, not because a measured query needs them.
- ❌ Computed or subset fields with no plan for keeping them correct (missed write paths, edits, deletes).
- ❌ Hand-rolled buckets with **no size cap**, recreating the unbounded array problem.
- ❌ Using approximation for values that must be exact.
- ❌ Extended references that copy fast-changing fields.

## 13. Summary: pattern → problem it solves

| Pattern | Problem it solves | E-commerce example |
|---|---|---|
| Attribute | Many sparse fields to search on | Product specs |
| Bucket | Too many tiny time-based documents | Hourly page views, price history |
| Computed | Expensive value read far more than it changes | Rating average, order total |
| Subset | Huge related set, only a slice is shown | Latest 10 reviews in product |
| Extended reference | Frequent `$lookup` for a few fields | Customer name and address in order |
| Outlier | A few documents far bigger than the rest | Viral product with millions of reviews |
| Polymorphic | Similar entities with different fields | Books, laptops, T-shirts in `products` |
| Schema versioning | Changing shape without downtime | Address string → sub-document |
| Approximation | Hot counters where exactness doesn't matter | View counts |
| Tree patterns | Hierarchies | Category tree, breadcrumbs |

> **Remember:** in an interview, name the **problem first**, then the pattern, then its **cost**. "The product page computes the average rating on every view, so I'd use the computed pattern and accept the extra write on each new review."

## 14. Trade-offs

- **Write complexity:** most patterns add work to writes or a background job. Someone must own that code.
- **Consistency windows:** duplicated or computed data can be briefly stale. Decide whether that's acceptable per field.
- **Multi-document updates:** keeping a subset or computed field in sync with another collection may need a [transaction](/lessons/mongodb-transactions) if they must never disagree.
- **Prefer built-ins when they exist:** time series collections over manual buckets, wildcard indexes over the attribute pattern where they fit, `$graphLookup` for occasional deep tree walks.
