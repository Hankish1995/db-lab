---
slug: mongodb-aggregation
title: 'Aggregation pipeline: an assembly line for your documents'
module: Querying
order: 60
summary: How the aggregation pipeline transforms documents stage by stage, which stages matter most, how to write fast pipelines, and how they map to SQL.
level: intermediate
tags: [mongodb, aggregation, pipeline, group, lookup, facet, window-functions, analytics]
recap: >-
  An aggregation pipeline is an assembly line: documents flow through stages, and each stage filters,
  reshapes, groups, joins or sorts them. $match and $sort go first so they can use indexes; $group,
  $unwind, $lookup, $facet and $setWindowFields do the heavy lifting. Each blocking stage has a 100 MB
  memory limit and spills to disk when allowed. Use $merge or $out to save results, and keep the pipeline
  short on the data it touches.
---

## 1. The story

Picture a **factory assembly line** that builds gift boxes.

1. At the first station, a worker **throws out damaged items** so nobody wastes time on them.
2. The next worker **unpacks multi-item crates** into single items.
3. Another worker **sorts items into bins by category** and counts them.
4. The last worker **arranges the bins** from biggest to smallest and ships the report.

Each worker does **one job** and passes the result to the next. Nobody sees the whole factory, only what arrives at their station.

**That's the aggregation pipeline.**

- The conveyor belt = the **pipeline**: an array of stages.
- Each worker = a **stage** (`$match`, `$unwind`, `$group`, `$sort`…).
- The items on the belt = **documents**. A stage receives documents and outputs (possibly different) documents.
- Throwing out damaged items early = **filtering with `$match` first**, so later stages do less work.

```text
 orders ──► $match ──► $unwind ──► $group ──► $sort ──► result
           (filter)   (split      (bucket    (order
                       arrays)     + count)   bins)
```

> **Remember:** a pipeline is an ordered list of stages. Each stage only sees the output of the stage before it.

## 2. Why it exists

`find()` can filter, project and sort. It can't answer business questions like:

- "What is the **revenue per category** this month?"
- "Who are the **top 3 products** in each category?"
- "Show **monthly sales** with a **running total**."
- "Give me orders **with the customer's name**."

Without aggregation you'd pull thousands of documents into Node.js and loop over them. That wastes network, memory and time. The pipeline runs **inside the database**, next to the data, and returns only the answer.

## 3. The stages you'll actually use

### Filtering and reshaping

| Stage | What it does | SQL cousin |
|---|---|---|
| `$match` | Keeps documents that match a filter | `WHERE` |
| `$project` | Includes, excludes or computes fields | `SELECT a, b` |
| `$addFields` / `$set` | Adds or overwrites fields (same thing, two names) | `SELECT *, x AS y` |
| `$unset` | Removes fields | — |
| `$sort`, `$limit`, `$skip` | Order and slice | `ORDER BY`, `LIMIT`, `OFFSET` |
| `$count` | Outputs one document with a count | `SELECT COUNT(*)` |

### Grouping

`$group` collects documents with the same `_id` expression into one output document, using **accumulators**:

| Accumulator | Result |
|---|---|
| `$sum`, `$avg`, `$min`, `$max` | Math over the group (`$sum: 1` counts) |
| `$count: {}` | Number of documents in the group |
| `$push` | Array of all values (duplicates kept) |
| `$addToSet` | Array of unique values |
| `$first`, `$last` | Value from the first/last document, **in the order they arrived** |
| `$topN`, `$bottomN` | Top/bottom N values by a sort you specify |

⚠️ `$first` and `$last` are only meaningful if you `$sort` before `$group`. Otherwise "first" is whatever order the documents happened to arrive in.

### Arrays, joins and multi-results

| Stage | What it does |
|---|---|
| `$unwind` | Turns one document with an array of N items into N documents, one per item |
| `$lookup` | Left outer join with another collection in the same database |
| `$facet` | Runs several sub-pipelines on the same input, returns all results in one document |
| `$bucket` / `$bucketAuto` | Groups values into ranges (you pick boundaries / MongoDB picks them) |
| `$sortByCount` | `$group` by a value + count + sort descending, in one stage |
| `$setWindowFields` | Window functions: running totals, moving averages, ranks |
| `$out` / `$merge` | Writes the results into a collection (must be the last stage) |

> **Remember:** `$unwind` multiplies documents, `$group` collapses them, `$lookup` enriches them, `$facet` forks them.

## 4. The e-commerce dataset

Every example below was run on this data. An `orders` collection embeds its line items:

```js
// orders
{ _id: 101, customerId: 1, status: 'paid', createdAt: ISODate('2026-01-05'),
  items: [ { sku: 'KB-1',  name: 'Keyboard', category: 'electronics', qty: 1, price: 50 },
           { sku: 'MUG-1', name: 'Mug',      category: 'kitchen',     qty: 2, price: 10 } ] }

// customers
{ _id: 1, name: 'Asha', email: 'asha@example.com', city: 'Pune' }
```

There are six orders: four `paid`, one `cancelled` and one `draft` with an empty `items` array.

### Example 1: revenue per category (GROUP BY)

```js
db.orders.aggregate([
  { $match: { status: 'paid' } },             // 1. filter first
  { $unwind: '$items' },                      // 2. one doc per line item
  { $group: {
      _id: '$items.category',
      revenue:   { $sum: { $multiply: ['$items.qty', '$items.price'] } },
      unitsSold: { $sum: '$items.qty' }
  } },
  { $sort: { revenue: -1 } }
])
// [ { _id: 'electronics', revenue: 410, unitsSold: 7 },
//   { _id: 'kitchen',     revenue: 105, unitsSold: 5 } ]
```

The SQL you already know, assuming a normalized `order_items` table:

```sql
SELECT oi.category,
       SUM(oi.qty * oi.price) AS revenue,
       SUM(oi.qty)            AS units_sold
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status = 'paid'
GROUP BY oi.category
ORDER BY revenue DESC;
```

Notice that `$unwind` plays the role of the join to `order_items`: the items live inside the order, so you "flatten" them instead of joining.

### Example 2: top 2 products per category

Group twice: first per product, then per category, keeping the best N.

```js
db.orders.aggregate([
  { $match: { status: 'paid' } },
  { $unwind: '$items' },
  { $group: {
      _id: { category: '$items.category', name: '$items.name' },
      revenue: { $sum: { $multiply: ['$items.qty', '$items.price'] } }
  } },
  { $group: {
      _id: '$_id.category',
      top: { $topN: {
        n: 2,
        sortBy: { revenue: -1 },
        output: { name: '$_id.name', revenue: '$revenue' }
      } }
  } }
])
// [ { _id: 'electronics', top: [ { name: 'Monitor', revenue: 200 },
//                                { name: 'Keyboard', revenue: 150 } ] },
//   { _id: 'kitchen', top: [ { name: 'Pan', revenue: 40 },
//                            { name: 'Teapot', revenue: 35 } ] } ]
```

The older pattern still works and you'll see it in interviews: `$sort` by revenue, `$group` with `$push`, then `$project` with `{ $slice: ['$top', 2] }`. `$topN` is cleaner and avoids building the full array first.

### Example 3: monthly sales with a running total

```js
db.orders.aggregate([
  { $match: { status: 'paid' } },
  { $set: { orderTotal: { $sum: {
      $map: { input: '$items', as: 'i', in: { $multiply: ['$$i.qty', '$$i.price'] } }
  } } } },
  { $group: {
      _id: { $dateTrunc: { date: '$createdAt', unit: 'month' } },
      revenue: { $sum: '$orderTotal' },
      orders:  { $count: {} }
  } },
  { $setWindowFields: {
      sortBy: { _id: 1 },
      output: {
        runningRevenue: { $sum: '$revenue', window: { documents: ['unbounded', 'current'] } }
      }
  } }
])
// Jan: revenue 270, runningRevenue 270
// Feb: revenue 140, runningRevenue 410
// Mar: revenue 105, runningRevenue 515
```

`$setWindowFields` is the MongoDB version of SQL window functions (`SUM(...) OVER (ORDER BY month)`). Unlike `$group`, it **keeps every document** and adds a computed field. Add `partitionBy` to restart the window per group, and use `$rank` / `$denseRank` for rankings:

```js
{ $setWindowFields: { sortBy: { spent: -1 }, output: { rank: { $rank: {} } } } }
```

### Example 4: orders with customer info (JOIN)

Simple form: match one field against another.

```js
db.orders.aggregate([
  { $match: { status: 'paid' } },
  { $lookup: {
      from: 'customers',
      localField: 'customerId',
      foreignField: '_id',
      as: 'customer'           // always an ARRAY, even for one match
  } },
  { $unwind: '$customer' },    // turn [ {...} ] into {...}
  { $project: { createdAt: 1, 'customer.name': 1, 'customer.city': 1 } }
])
```

```sql
SELECT o.id, o.created_at, c.name, c.city
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'paid';
```

Pipeline form: when you need conditions, sorting or limits on the joined side. `let` exposes fields of the outer document as `$$variables`:

```js
// Each customer with their most recent paid order
db.customers.aggregate([
  { $lookup: {
      from: 'orders',
      let: { custId: '$_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$customerId', '$$custId'] }, status: 'paid' } },
        { $sort: { createdAt: -1 } },
        { $limit: 1 },
        { $project: { createdAt: 1 } }
      ],
      as: 'lastOrder'
  } },
  { $project: { _id: 0, name: 1, lastOrder: { $first: '$lastOrder' } } }
])
// { name: 'Asha', lastOrder: { _id: 103, createdAt: ISODate('2026-02-11...') } } ...
```

⚠️ `$lookup` runs the inner lookup **for every input document**. Make sure the foreign field (`orders.customerId` here) is indexed, and `$match` the outer side down first.

### Example 5: an admin dashboard in one round trip ($facet)

```js
db.orders.aggregate([
  { $match: { status: 'paid' } },
  { $set: { orderTotal: { $sum: {
      $map: { input: '$items', as: 'i', in: { $multiply: ['$$i.qty', '$$i.price'] } }
  } } } },
  { $facet: {
      summary: [
        { $group: { _id: null, orders: { $sum: 1 },
                    revenue: { $sum: '$orderTotal' }, avgOrder: { $avg: '$orderTotal' } } },
        { $project: { _id: 0 } }
      ],
      byPriceBand: [
        { $bucket: { groupBy: '$orderTotal', boundaries: [0, 50, 150, 1000],
                     default: 'other', output: { count: { $sum: 1 } } } }
      ],
      topCustomer: [ { $sortByCount: '$customerId' }, { $limit: 1 } ]
  } }
])
// { summary: [ { orders: 4, revenue: 515, avgOrder: 128.75 } ],
//   byPriceBand: [ { _id: 50, count: 3 }, { _id: 150, count: 1 } ],
//   topCustomer: [ { _id: 1, count: 2 } ] }
```

`$bucket` labels each range by its lower boundary: `_id: 50` means "50 up to (not including) 150". Empty ranges are not returned.

> **Remember:** `$facet` = several reports from one scan of the input. The whole output is one document, so it must fit in 16 MB.

### $unwind and empty arrays

By default `$unwind` **drops** documents whose array is missing, `null` or empty. Our `draft` order with `items: []` simply disappears. To keep it:

```js
{ $unwind: { path: '$items', preserveNullAndEmptyArrays: true } }
// the draft order comes through with no "items" field
```

This matters when you count "orders per customer" after an `$unwind`: customers with empty carts silently vanish.

## 5. Order matters: making pipelines fast

Only the **first stages** of a pipeline can use an index. Once documents have been reshaped by `$group`, `$unwind` or `$project`, they are in-memory values with no index on them.

```text
 ┌─────────────────────────┐   ┌──────────┐   ┌──────────┐
 │ $match + $sort at start │──►│ $unwind  │──►│ $group   │
 │ uses index (IXSCAN)     │   │ in memory│   │ in memory│
 └─────────────────────────┘   └──────────┘   └──────────┘
```

Rules of thumb:

1. **`$match` as early as possible**, on indexed fields.
2. **`$sort` early** (right after `$match`) if you need sorted input, so the index can provide the order.
3. **`$project` late or not at all.** You don't need it to "save memory"; MongoDB already works out which fields a pipeline needs.
4. **`$sort` + `$limit` together** let MongoDB keep only the top N in memory instead of sorting everything.
5. **`$match` the outer side before `$lookup`**, and index the foreign field.

MongoDB's **optimizer** reorders some stages for you. For example, a `$match` placed after a `$sort`, or after a `$project` that doesn't compute the matched field, gets moved forward so it can use an index. Check with `explain`:

```js
db.orders.explain().aggregate([
  { $sort: { createdAt: 1 } },
  { $match: { status: 'paid' } }
])
// winning plan: IXSCAN on { status: 1, createdAt: 1 } — the $match was moved first
```

Don't rely on it blindly. The optimizer can't move a `$match` that depends on a field computed by `$group` or `$set`. Write the pipeline in the efficient order yourself, then confirm with `explain`.

> **Remember:** filter first, sort early, compute late. The optimizer helps, but `explain` is the proof.

### Memory limits

- Each **blocking stage** (`$group`, `$sort`, `$bucket`, `$setWindowFields`…) may use about **100 MB of RAM**.
- Past that, it must **spill to disk** (slower) or fail. Since MongoDB 6.0 the server parameter `allowDiskUseByDefault` is `true`, so stages spill to disk automatically unless you pass `{ allowDiskUse: false }`.
- **Each output document** is still capped at the **16 MB** BSON limit. A `$group` that `$push`es millions of values into one document will fail no matter how much disk you have.

## 6. Saving results: $out vs $merge

Both must be the **last stage**. They're useful for nightly reports and materialized views.

```js
// Recompute and upsert revenue per category into a reporting collection
db.orders.aggregate([
  { $match: { status: 'paid' } },
  { $unwind: '$items' },
  { $group: { _id: '$items.category',
              revenue: { $sum: { $multiply: ['$items.qty', '$items.price'] } } } },
  { $merge: { into: 'category_revenue', on: '_id',
              whenMatched: 'replace', whenNotMatched: 'insert' } }
])
```

| | `$out` | `$merge` |
|---|---|---|
| Effect on target | **Replaces** the whole collection | **Merges** into it, document by document |
| Existing docs | Gone | Kept, replaced, merged or left alone (your choice) |
| Incremental updates | ❌ | ✅ e.g. only reprocess today's orders |
| Typical use | Full rebuild of a snapshot | Materialized view kept up to date |

## 7. Common mistakes and gotchas

- **`$match` after `$group`** when it could go before. Filtering 10 million orders after grouping wastes all the grouping work.
- **Forgetting `$lookup` returns an array.** You need `$unwind` or `$first` to get a single object.
- **`$unwind` silently dropping documents** with empty or missing arrays.
- **`$first` / `$last` without a prior `$sort`.** The result is effectively random.
- **No index on the `$lookup` foreign field.** Every input document triggers a collection scan of the other collection.
- **Unbounded `$push`** creating a group document larger than 16 MB.
- **Using `$skip` for deep pagination** inside pipelines. It still walks past every skipped document.
- **Treating aggregation as a replacement for good schema design.** If every page load needs a five-stage `$lookup`, the data probably belongs together.

> **Remember:** an aggregation that runs on every request is a design smell. Aggregation shines for reports, dashboards and batch jobs.

## 8. Don't confuse these

| | `find()` | `aggregate()` |
|---|---|---|
| Filter / sort / project | ✅ | ✅ |
| Group, count per value | ❌ | ✅ `$group`, `$sortByCount` |
| Join collections | ❌ | ✅ `$lookup` |
| Reshape and compute fields | Limited (projection expressions) | ✅ Full expression language |
| Simplicity | Simple, easy to read | More verbose |

| | `$group` | `$setWindowFields` |
|---|---|---|
| Output | One document **per group** | **Every** input document, plus computed fields |
| SQL cousin | `GROUP BY` | `OVER (PARTITION BY … ORDER BY …)` |
| Example | Revenue per month | Running total next to each month |

## 9. When NOT to use it / trade-offs

- **Simple reads:** if `find()` with a projection does the job, use it. It's easier to read and index.
- **Hot paths on huge data:** an aggregation that scans millions of documents on every API call won't scale. Precompute with `$merge` on a schedule, or keep running counters with `$inc` at write time.
- **Heavy analytics:** for big data warehouses, exporting to a dedicated analytics store can be cheaper than running giant pipelines against your production primary.
- **Many `$lookup`s to rebuild one object:** consider embedding instead (see [MongoDB schema design](/lessons/mongodb-schema-design)).

The pipeline is powerful because it runs where the data lives. It stays fast only if each stage receives as few documents as possible.
