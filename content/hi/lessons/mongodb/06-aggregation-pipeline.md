---
slug: mongodb-aggregation
title: 'Aggregation pipeline: आपके documents के लिए एक assembly line'
module: Querying
summary: 'Aggregation pipeline documents को stage दर stage कैसे बदलता है, कौन से stages सबसे ज़रूरी हैं, तेज़ pipelines कैसे लिखें, और ये SQL से कैसे match करते हैं।'
recap: >-
  Aggregation pipeline एक assembly line है: documents stages से होकर गुज़रते हैं, और हर stage उन्हें
  filter, reshape, group, join या sort करता है। $match और $sort सबसे पहले आते हैं ताकि वो indexes इस्तेमाल
  कर सकें; भारी काम $group, $unwind, $lookup, $facet और $setWindowFields करते हैं। हर blocking stage की
  100 MB memory limit होती है और इजाज़त हो तो वो disk पर spill करता है। Results save करने के लिए $merge या
  $out इस्तेमाल करें, और pipeline जिस data को छूता है उसे कम से कम रखें।
---

## 1. कहानी

एक **factory assembly line** की कल्पना कीजिए जो gift boxes बनाती है।

1. पहले station पर एक worker **खराब items बाहर फेंक देता है**, ताकि कोई उन पर समय बर्बाद न करे।
2. अगला worker **कई items वाले crates खोलकर** उन्हें अलग-अलग items में बाँट देता है।
3. एक और worker **items को category के हिसाब से bins में छाँटता है** और उन्हें गिनता है।
4. आखिरी worker **bins को सबसे बड़े से सबसे छोटे तक लगाता है** और report भेज देता है।

हर worker **एक ही काम** करता है और result अगले को दे देता है। कोई भी पूरी factory नहीं देखता, सिर्फ़ वही जो उसके station तक पहुँचता है।

**यही है aggregation pipeline.**

- Conveyor belt = **pipeline**: stages का एक array।
- हर worker = एक **stage** (`$match`, `$unwind`, `$group`, `$sort`…)।
- Belt पर रखे items = **documents**। एक stage documents लेता है और (शायद अलग) documents आगे भेजता है।
- खराब items को जल्दी फेंक देना = **पहले `$match` से filter करना**, ताकि बाद के stages को कम काम करना पड़े।

```text
 orders ──► $match ──► $unwind ──► $group ──► $sort ──► result
           (filter)   (split      (bucket    (order
                       arrays)     + count)   bins)
```

> **याद रखें:** pipeline stages की एक ordered list है। हर stage सिर्फ़ अपने से पहले वाले stage का output देखता है।

## 2. यह क्यों है

`find()` filter, project और sort कर सकता है। लेकिन यह ऐसे business सवालों का जवाब नहीं दे सकता:

- "इस महीने **हर category का revenue** कितना है?"
- "हर category में **top 3 products** कौन से हैं?"
- "**Monthly sales** के साथ **running total** दिखाओ।"
- "मुझे orders **customer के नाम के साथ** दो।"

Aggregation के बिना आपको हज़ारों documents Node.js में खींचकर उन पर loop चलाना पड़ेगा। इसमें network, memory और समय सब बर्बाद होते हैं। Pipeline **database के अंदर** चलता है, data के बिल्कुल पास, और सिर्फ़ जवाब लौटाता है।

## 3. वो stages जो आप सच में इस्तेमाल करेंगे

### Filtering और reshaping

| Stage | यह क्या करता है | SQL में इसका भाई |
|---|---|---|
| `$match` | Filter से match होने वाले documents रखता है | `WHERE` |
| `$project` | Fields को include, exclude या compute करता है | `SELECT a, b` |
| `$addFields` / `$set` | Fields जोड़ता है या overwrite करता है (एक ही चीज़, दो नाम) | `SELECT *, x AS y` |
| `$unset` | Fields हटाता है | — |
| `$sort`, `$limit`, `$skip` | Order करना और हिस्सा काटना | `ORDER BY`, `LIMIT`, `OFFSET` |
| `$count` | Count वाला एक document output करता है | `SELECT COUNT(*)` |

### Grouping

`$group` एक जैसे `_id` expression वाले documents को एक output document में इकट्ठा करता है, **accumulators** की मदद से:

| Accumulator | Result |
|---|---|
| `$sum`, `$avg`, `$min`, `$max` | Group पर गणित (`$sum: 1` गिनती करता है) |
| `$count: {}` | Group में documents की संख्या |
| `$push` | सभी values का array (duplicates भी रहते हैं) |
| `$addToSet` | Unique values का array |
| `$first`, `$last` | पहले/आखिरी document की value, **उसी order में जिसमें वो आए** |
| `$topN`, `$bottomN` | आपके दिए sort के हिसाब से top/bottom N values |

⚠️ `$first` और `$last` का मतलब तभी बनता है जब आप `$group` से पहले `$sort` करें। वरना "first" वही होगा जिस order में documents संयोग से आ गए।

### Arrays, joins और multi-results

| Stage | यह क्या करता है |
|---|---|
| `$unwind` | N items वाले array वाले एक document को N documents में बदलता है, हर item के लिए एक |
| `$lookup` | उसी database की किसी दूसरी collection के साथ left outer join |
| `$facet` | एक ही input पर कई sub-pipelines चलाता है, सारे results एक document में लौटाता है |
| `$bucket` / `$bucketAuto` | Values को ranges में group करता है (boundaries आप चुनते हैं / MongoDB चुनता है) |
| `$sortByCount` | किसी value पर `$group` + count + descending sort, एक ही stage में |
| `$setWindowFields` | Window functions: running totals, moving averages, ranks |
| `$out` / `$merge` | Results को एक collection में लिखता है (आखिरी stage होना ज़रूरी है) |

> **याद रखें:** `$unwind` documents को बढ़ाता है, `$group` उन्हें समेटता है, `$lookup` उन्हें enrich करता है, `$facet` उन्हें कई शाखाओं में बाँटता है।

## 4. E-commerce dataset

नीचे के सारे उदाहरण इसी data पर चलाए गए हैं। एक `orders` collection अपने line items को embed करती है:

```js
// orders
{ _id: 101, customerId: 1, status: 'paid', createdAt: ISODate('2026-01-05'),
  items: [ { sku: 'KB-1',  name: 'Keyboard', category: 'electronics', qty: 1, price: 50 },
           { sku: 'MUG-1', name: 'Mug',      category: 'kitchen',     qty: 2, price: 10 } ] }

// customers
{ _id: 1, name: 'Asha', email: 'asha@example.com', city: 'Pune' }
```

छह orders हैं: चार `paid`, एक `cancelled` और एक `draft` जिसका `items` array खाली है।

### उदाहरण 1: हर category का revenue (GROUP BY)

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

वही SQL जो आप पहले से जानते हैं, मान लीजिए एक normalized `order_items` table है:

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

ध्यान दीजिए कि `$unwind` यहाँ `order_items` वाले join का काम कर रहा है: items order के अंदर ही रहते हैं, इसलिए join करने के बजाय आप उन्हें "flatten" कर देते हैं।

### उदाहरण 2: हर category के top 2 products

दो बार group करें: पहले हर product के हिसाब से, फिर हर category के हिसाब से, सबसे अच्छे N रखते हुए।

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

पुराना pattern भी अब तक चलता है और interviews में आपको दिखेगा: revenue से `$sort`, `$push` के साथ `$group`, फिर `{ $slice: ['$top', 2] }` के साथ `$project`। `$topN` ज़्यादा साफ़ है और पहले पूरा array बनाने से बचाता है।

### उदाहरण 3: running total के साथ monthly sales

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

`$setWindowFields` SQL window functions (`SUM(...) OVER (ORDER BY month)`) का MongoDB version है। `$group` के उलट, यह **हर document को रखता है** और उसमें एक computed field जोड़ देता है। हर group के लिए window को दोबारा शुरू करने के लिए `partitionBy` जोड़ें, और rankings के लिए `$rank` / `$denseRank` इस्तेमाल करें:

```js
{ $setWindowFields: { sortBy: { spent: -1 }, output: { rank: { $rank: {} } } } }
```

### उदाहरण 4: customer info के साथ orders (JOIN)

Simple form: एक field को दूसरी field से match करना।

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

Pipeline form: जब join होने वाली side पर आपको conditions, sorting या limits चाहिए। `let` बाहरी document की fields को `$$variables` के रूप में उपलब्ध कराता है:

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

⚠️ `$lookup` अंदर वाला lookup **हर input document के लिए** चलाता है। पक्का करें कि foreign field (यहाँ `orders.customerId`) पर index हो, और पहले बाहरी side को `$match` से छोटा कर लें।

### उदाहरण 5: एक ही round trip में admin dashboard ($facet)

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

`$bucket` हर range को उसकी निचली boundary से label करता है: `_id: 50` का मतलब है "50 से लेकर 150 तक (150 शामिल नहीं)"। खाली ranges लौटाई नहीं जातीं।

> **याद रखें:** `$facet` = input के एक ही scan से कई reports। पूरा output एक document होता है, इसलिए उसे 16 MB में fit होना चाहिए।

### $unwind और खाली arrays

Default रूप से `$unwind` उन documents को **drop कर देता है** जिनका array missing, `null` या खाली हो। हमारा `draft` order जिसमें `items: []` है, बस गायब हो जाता है। उसे रखने के लिए:

```js
{ $unwind: { path: '$items', preserveNullAndEmptyArrays: true } }
// the draft order comes through with no "items" field
```

यह तब मायने रखता है जब आप `$unwind` के बाद "हर customer के orders" गिनते हैं: खाली cart वाले customers चुपचाप गायब हो जाते हैं।

## 5. Order मायने रखता है: pipelines को तेज़ बनाना

Pipeline के सिर्फ़ **शुरुआती stages** ही index इस्तेमाल कर सकते हैं। एक बार `$group`, `$unwind` या `$project` से documents reshape हो गए, तो वो in-memory values बन जाते हैं जिन पर कोई index नहीं होता।

```text
 ┌─────────────────────────┐   ┌──────────┐   ┌──────────┐
 │ $match + $sort at start │──►│ $unwind  │──►│ $group   │
 │ uses index (IXSCAN)     │   │ in memory│   │ in memory│
 └─────────────────────────┘   └──────────┘   └──────────┘
```

कुछ आसान नियम:

1. **`$match` जितना जल्दी हो सके**, indexed fields पर।
2. **`$sort` जल्दी** (`$match` के ठीक बाद), अगर आपको sorted input चाहिए, ताकि order index से मिल सके।
3. **`$project` देर से या बिल्कुल नहीं।** "Memory बचाने" के लिए इसकी ज़रूरत नहीं; MongoDB खुद समझ लेता है कि pipeline को कौन सी fields चाहिए।
4. **`$sort` + `$limit` साथ में** होने पर MongoDB सब कुछ sort करने के बजाय memory में सिर्फ़ top N रखता है।
5. **`$lookup` से पहले बाहरी side पर `$match`**, और foreign field पर index।

MongoDB का **optimizer** कुछ stages को आपके लिए reorder कर देता है। उदाहरण के लिए, `$sort` के बाद रखा `$match`, या ऐसे `$project` के बाद रखा `$match` जो matched field को compute नहीं करता, आगे खिसका दिया जाता है ताकि वो index इस्तेमाल कर सके। `explain` से check करें:

```js
db.orders.explain().aggregate([
  { $sort: { createdAt: 1 } },
  { $match: { status: 'paid' } }
])
// winning plan: IXSCAN on { status: 1, createdAt: 1 } — the $match was moved first
```

इस पर आँख मूँदकर भरोसा न करें। Optimizer ऐसे `$match` को आगे नहीं खिसका सकता जो `$group` या `$set` से compute हुई field पर निर्भर हो। Pipeline को efficient order में खुद लिखें, फिर `explain` से पक्का करें।

> **याद रखें:** पहले filter, जल्दी sort, देर से compute। Optimizer मदद करता है, लेकिन सबूत `explain` ही है।

### Memory limits

- हर **blocking stage** (`$group`, `$sort`, `$bucket`, `$setWindowFields`…) लगभग **100 MB RAM** इस्तेमाल कर सकता है।
- उससे ज़्यादा होने पर उसे **disk पर spill** करना पड़ता है (धीमा) या वो fail हो जाता है। MongoDB 6.0 से server parameter `allowDiskUseByDefault` `true` है, इसलिए stages अपने-आप disk पर spill करते हैं, जब तक आप `{ allowDiskUse: false }` न दें।
- **हर output document** अब भी **16 MB** BSON limit से बँधा है। जो `$group` लाखों values को एक document में `$push` करता है, वो fail होगा, चाहे आपके पास कितनी भी disk हो।

## 6. Results save करना: $out vs $merge

दोनों का **आखिरी stage** होना ज़रूरी है। ये nightly reports और materialized views के लिए काम के हैं।

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
| Target पर असर | पूरी collection को **replace** कर देता है | उसमें document दर document **merge** करता है |
| मौजूदा docs | गायब | रखे, replace, merge या जैसे के तैसे छोड़े जाते हैं (आपकी मर्ज़ी) |
| Incremental updates | ❌ | ✅ जैसे सिर्फ़ आज के orders दोबारा process करना |
| आम इस्तेमाल | Snapshot को पूरा दोबारा बनाना | Materialized view को up to date रखना |

## 7. आम गलतियाँ और gotchas

- **`$group` के बाद `$match`** जबकि वो पहले आ सकता था। Grouping के बाद 1 करोड़ orders filter करना grouping का सारा काम बर्बाद कर देता है।
- **भूल जाना कि `$lookup` array लौटाता है।** एक single object पाने के लिए आपको `$unwind` या `$first` चाहिए।
- **`$unwind` का चुपचाप documents drop करना** जिनके arrays खाली या missing हैं।
- **पहले `$sort` किए बिना `$first` / `$last`।** Result असल में random होता है।
- **`$lookup` की foreign field पर index न होना।** हर input document दूसरी collection का पूरा collection scan trigger करता है।
- **बिना सीमा का `$push`** जो 16 MB से बड़ा group document बना देता है।
- **Pipelines के अंदर deep pagination के लिए `$skip` इस्तेमाल करना।** यह फिर भी हर skipped document से होकर गुज़रता है।
- **Aggregation को अच्छे schema design का replacement मान लेना।** अगर हर page load पर पाँच stage का `$lookup` चाहिए, तो शायद वो data साथ ही रहना चाहिए।

> **याद रखें:** जो aggregation हर request पर चलता है वो design smell है। Aggregation reports, dashboards और batch jobs में चमकता है।

## 8. इन्हें आपस में न मिलाएँ

| | `find()` | `aggregate()` |
|---|---|---|
| Filter / sort / project | ✅ | ✅ |
| Group, हर value पर count | ❌ | ✅ `$group`, `$sortByCount` |
| Collections join करना | ❌ | ✅ `$lookup` |
| Fields reshape और compute करना | सीमित (projection expressions) | ✅ पूरी expression language |
| सरलता | Simple, पढ़ने में आसान | ज़्यादा लंबा-चौड़ा |

| | `$group` | `$setWindowFields` |
|---|---|---|
| Output | **हर group का** एक document | **हर** input document, साथ में computed fields |
| SQL में इसका भाई | `GROUP BY` | `OVER (PARTITION BY … ORDER BY …)` |
| उदाहरण | हर महीने का revenue | हर महीने के साथ running total |

## 9. कब इस्तेमाल न करें / trade-offs

- **Simple reads:** अगर projection के साथ `find()` से काम चल जाता है, तो वही इस्तेमाल करें। उसे पढ़ना और index करना आसान है।
- **बहुत बड़े data पर hot paths:** जो aggregation हर API call पर लाखों documents scan करता है, वो scale नहीं करेगा। Schedule पर `$merge` से पहले से compute कर लें, या write के समय `$inc` से running counters रखें।
- **भारी analytics:** बड़े data warehouses के लिए, data को एक dedicated analytics store में export करना आपके production primary पर विशाल pipelines चलाने से सस्ता पड़ सकता है।
- **एक object दोबारा बनाने के लिए कई `$lookup`:** इसके बजाय embedding पर विचार करें (देखें [MongoDB schema design](/lessons/mongodb-schema-design))।

Pipeline इसलिए powerful है क्योंकि यह वहीं चलता है जहाँ data रहता है। यह तभी तेज़ रहता है जब हर stage को जितने हो सके उतने कम documents मिलें।
