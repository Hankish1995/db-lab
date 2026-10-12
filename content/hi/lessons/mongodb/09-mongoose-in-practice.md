---
slug: mongoose-in-practice
title: 'Mongoose in practice: यह आपके लिए क्या करता है और क्या छिपाता है'
module: Node.js
summary: 'Mongoose के schemas, models, validation, middleware, lean, populate और versioning असल में कैसे बर्ताव करते हैं, और production की वो गड़बड़ियाँ जिनमें अनुभवी Node.js developers भी फँस जाते हैं।'
recap: >-
  Schema shape और नियम बताता है, Model किसी collection से जुड़ी class है, और Document एक hydrated
  instance है। Validation और save hooks save और create पर चलते हैं, लेकिन update queries save hooks को skip
  करती हैं और सिर्फ़ runValidators के साथ validate करती हैं। Read-only data के लिए lean इस्तेमाल करें, याद
  रखें कि populate join नहीं बल्कि extra queries है, और production में autoIndex पर भरोसा न करें। एक बार
  connect करें, pool को reuse करें, और अपनी queries को हमेशा await करें।
---

## 1. कहानी

एक **passport office** के बारे में सोचिए।

- **Official form template** बताता है कि कौन सी fields हैं, कौन सी ज़रूरी हैं और उनका format क्या होना चाहिए। यही है **Schema**।
- **Passport office** भरे हुए forms लेकर उन्हें सही cabinet में file करता है। यही है **Model**, जो एक collection से बँधा होता है।
- **एक भरा हुआ, stamp लगा passport** जिसे आप हाथ में पकड़ सकते हैं, check कर सकते हैं और update कर सकते हैं। यही है **Document**।
- **Clerk** file करने से पहले आपका form check करता है (**validation**), और file करने से पहले और बाद में कुछ standard steps होते हैं, जैसे photocopy करना या SMS भेजना (**middleware hooks**)।

| Passport office | Mongoose |
|---|---|
| Form template | `new Schema({...})` |
| Office / cabinet | `model('Order', orderSchema)` → `orders` collection |
| एक passport | `new Order({...})` या किसी query का result |
| Form check करता clerk | Validators |
| Filing के आस-पास के standard steps | `pre` / `post` middleware |

Mongoose एक **ODM** (Object Document Mapper) है: यह official MongoDB Node.js driver के ऊपर बैठता है और structure, casting, validation और hooks जोड़ता है।

> **याद रखें:** Schema = नियम, Model = collection की class, Document = methods और change tracking वाला एक instance।

## 2. यह क्यों है

MongoDB खुद documents पर कोई shape थोपता नहीं। एक team में यह आज़ादी जल्दी ही ऐसी बन जाती है कि कुछ orders में `price` string है और कुछ में number। Mongoose आपको देता है:

- **Casting:** अगर path `Number` है तो `'49.99'` बन जाता है `49.99`।
- Data database तक पहुँचने से पहले **validation**।
- **Defaults**, **timestamps**, **virtuals** और **hooks**।
- Referenced documents लाने के लिए **populate**।
- आपके schema से infer किए गए **TypeScript types**।

कीमत है एक जादू की परत। वो जादू ठीक-ठीक क्या करता है, और कब **नहीं** चलता, यही interviewers परखते हैं।

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

⚠️ `unique: true` **validator नहीं है**। यह सिर्फ़ Mongoose से एक **unique index** बनाने को कहता है। Duplicates को MongoDB एक `E11000 duplicate key` error के साथ reject करता है, और वो भी तभी जब वो index सच में मौजूद हो।

## 4. Validation: कब चलता है और कब नहीं

| Operation | Validators चलते हैं? | `save` hooks चलते हैं? |
|---|---|---|
| `doc.save()`, `Model.create()` | ✅ हमेशा | ✅ |
| `Model.insertMany()` | ✅ | ❌ (इसके बजाय `insertMany` hooks) |
| `updateOne`, `updateMany`, `findOneAndUpdate`, `findByIdAndUpdate` | ❌ सिर्फ़ `runValidators: true` के साथ | ❌ |
| `Model.collection.*` (raw driver) | ❌ कभी नहीं | ❌ |

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

`runValidators: true` के साथ भी **update validators सीमित हैं**:

- ये सिर्फ़ **update में मौजूद paths** check करते हैं, पूरा document नहीं।
- `required` तभी fail होता है जब update field को **unset** करे या उसे `null` set करे।
- Custom validator के अंदर `this` **document नहीं होता** (document load ही नहीं होता), इसलिए दो fields की तुलना करने वाले validators उसी तरह काम नहीं करते।
- ये सिर्फ़ कुछ operators के लिए चलते हैं, जैसे `$set`, `$unset`, `$push` और `$addToSet`। `$inc` validate नहीं होता, इसलिए `$inc: { stock: -100 }` stock को `min: 0` से नीचे धकेल सकता है। इसकी बजाय filter में बचाव करें: `{ stock: { $gte: 100 } }`।

> **याद रखें:** schema validation `save`/`create` पर पक्का होता है। Update queries इसे skip करती हैं जब तक आप `runValidators: true` न दें, और तब भी सिर्फ़ आंशिक रूप से।

## 5. Middleware: `this` का मतलब बदल जाता है

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
| Hooks | `save`, `validate`, `{ document: true }` के साथ `deleteOne` / `updateOne` | `find`, `findOne`, `findOneAndUpdate`, `updateOne`, `deleteMany`… |
| `this` | Document | `Query` object |
| Field values पढ़ सकते हैं? | ✅ `this.total` | ❌ `this.getFilter()` / `this.getUpdate()` इस्तेमाल करें |

Classic bug: आप `pre('save')` में `total` compute करते हैं, फिर एक admin endpoint items बदलने के लिए `findByIdAndUpdate` इस्तेमाल करता है। Save hook कभी चलता ही नहीं, इसलिए अब `total` गलत है।

## 6. lean(): plain objects, बहुत कम काम

एक normal query हर result को एक पूरे Mongoose document में **hydrate** करती है, जिसमें change tracking, getters, setters, virtuals और `save()` जैसे methods होते हैं। इसमें CPU और memory खर्च होती है।

```ts
const orders = await OrderModel
  .find({ user: userId })
  .sort({ createdAt: -1 })
  .limit(20)
  .select('status total createdAt')
  .lean();          // ← plain JS objects
```

`lean()` सीधे driver से **plain JavaScript objects** लौटाता है: न hydration, न change tracking, **न virtuals, न getters, न `save()`**। यह साफ़ तौर पर तेज़ और हल्का है, जो read-only API responses के लिए बिल्कुल सही है।

जब आप **बदलकर `save()` करने वाले हों** तब पूरे documents इस्तेमाल करें; जब आप **सिर्फ़ पढ़कर लौटाने वाले हों** तब `lean()`।

> **याद रखें:** read-only endpoints के लिए default रूप से `.lean()` रखें। आप virtuals, getters और `save()` खोते हैं, जिनकी वहाँ आम तौर पर ज़रूरत नहीं होती।

## 7. populate(): extra queries, join नहीं

```ts
const orders = await OrderModel
  .find({ status: 'paid' })
  .populate('user', 'name email')   // only these fields
  .lean();
```

असल में क्या होता है:

```text
 Query 1: orders.find({ status: 'paid' })
          → collects all user ids: [u1, u2, u3...]
 Query 2: users.find({ _id: { $in: [u1, u2, u3...] } })
          → Mongoose stitches users into orders in Node.js
```

तो `populate` **हर populated path के लिए एक extra query** है, जिसे Mongoose चलाता है, और merging **आपके app में** होती है। यह ठीक है। **N+1 problem** तब आती है जब आप इसका गलत इस्तेमाल करते हैं:

```ts
// ❌ N+1: one query for orders, then one per order
const orders = await OrderModel.find({ status: 'paid' });
for (const o of orders) {
  await o.populate('user');
}

// ✅ 2 queries total
const orders = await OrderModel.find({ status: 'paid' }).populate('user');
```

गहरे nested populates (`items.product` → `product.brand` → …) हर level पर एक query जोड़ते हैं, और हर round trip latency बढ़ाता है।

| | `populate()` | `$lookup` |
|---|---|---|
| कहाँ चलता है | Node.js से extra queries | MongoDB के अंदर, एक aggregation में |
| Round trips | 1 + हर populated path के लिए एक | 1 |
| Joined fields से filter / sort | ❌ मुश्किल | ✅ |
| इस्तेमाल में आसानी | ✅ बहुत आसान | ज़्यादा लंबा-चौड़ा |

`$lookup` के लिए [Aggregation pipeline](/lessons/mongodb-aggregation) देखें। अगर आप हर request पर वही data populate करते हैं, तो **snapshot embed करने** पर विचार करें, जैसे हम order items में `name` और `price` के साथ करते हैं।

## 8. Versioning: `__v` असल में किससे बचाता है

हर document को एक **`versionKey`** field मिलती है, `__v`। Default रूप से यह सारे concurrent updates से **नहीं** बचाती। यह सिर्फ़ `save()` इस्तेमाल करने पर **array positions** की रक्षा करती है:

- अगर एक `save()` किसी array को ऐसे बदलता है जिससे positions खिसक सकती हैं (जैसे कोई element हटाना), तो Mongoose `__v` बढ़ा देता है।
- पुराने array के आधार पर `items.2.qty` update करने वाला दूसरा `save()` अपने filter में `__v` शामिल करता है। गलत item edit करने के बजाय वो **`VersionError`** के साथ fail हो जाता है।

हर `save()` पर पूरा **optimistic concurrency control** चाहिए तो schema पर `optimisticConcurrency: true` set करें (जैसा `orderSchema` में है):

```ts
const a = await OrderModel.findById(id);
const b = await OrderModel.findById(id);
a!.status = 'shipped';   await a!.save();   // __v 0 → 1
b!.status = 'cancelled'; await b!.save();   // ❌ VersionError: b is stale
```

⚠️ यह सिर्फ़ `save()` पर लागू होता है। `updateOne` और `findOneAndUpdate` `__v` check नहीं करते। उन्हें atomic operators और filter में conditions से सुरक्षित बनाएँ, जैसे `{ _id, status: 'pending' }`।

## 9. strict और strictQuery

- **`strict`** (default `true`): document create या update करते समय जो fields schema में नहीं हैं, वो **चुपचाप drop** हो जाती हैं। अगर आपको error चाहिए तो `strict: 'throw'` इस्तेमाल करें।
- **`strictQuery`** (Mongoose 7 से default `false`): जो fields schema में नहीं हैं, वो query **filters** में **जैसी की तैसी आगे भेज दी जाती हैं**।

यह क्यों मायने रखता है:

```ts
await OrderModel.deleteMany({ stauts: 'cancelled' });   // typo!
// strictQuery: false → filter on non-existent field → deletes nothing
// strictQuery: true  → unknown field stripped → filter {} → deletes EVERYTHING
```

साथ ही कभी भी raw `req.body` या `req.query` objects को सीधे filters में न डालें, क्योंकि कोई user `{ "$ne": null }` भेज सकता है। Input validate करें, या Mongoose का `sanitizeFilter` option इस्तेमाल करें।

> **याद रखें:** `strict` इस बारे में है कि आप क्या **लिखते** हैं, `strictQuery` इस बारे में कि आप किससे **filter** करते हैं।

## 10. Indexes, connections और production setup

### Indexes: schema में declare करें, सोच-समझकर build करें

Mongoose का **`autoIndex`** (default रूप से चालू) app start होने पर हर schema index के लिए `createIndex` call करता है। Startup पर किसी बड़ी production collection पर index build करना सबसे बुरे वक्त पर performance बिगाड़ सकता है।

```ts
mongoose.set('autoIndex', false);   // production

// In a deploy/migration step instead:
await OrderModel.createIndexes();   // creates missing indexes from the schema
// syncIndexes() also DROPS indexes not in the schema; use with care
```

कौन से indexes बनाने हैं, इसके लिए [MongoDB indexes](/lessons/mongodb-indexes) देखें।

### एक बार connect करें, pool को reuse करें

```ts
await mongoose.connect(process.env.MONGODB_URI!, { maxPoolSize: 20 });
```

`mongoose.connect` एक **connection pool** बनाता है (driver का default `maxPoolSize: 100` है)। **Startup पर एक बार** connect करें और उसे reuse करें। कभी भी हर request पर connect न करें।

**Serverless** functions (Vercel, Lambda) में हर warm container reuse होता है, इसलिए connection promise को globally cache करें:

```ts
declare global { var mongoosePromise: Promise<typeof mongoose> | undefined }

export function connectDB() {
  global.mongoosePromise ??= mongoose.connect(process.env.MONGODB_URI!, { maxPoolSize: 10 });
  return global.mongoosePromise;
}
```

वहाँ `maxPoolSize` छोटा रखें: 500 concurrent function instances × हर एक के 100 connections आपके cluster की connection limit खत्म कर सकते हैं।

## 11. आम गड़बड़ियाँ

- **`await` भूल जाना।** Mongoose query एक lazy, thenable `Query` है। यह तभी चलती है जब आप इसे `await` करें, `.then()` या `.exec()` call करें। `const order = OrderModel.findById(id)` आपको एक Query देता है, इसलिए `order.status` `undefined` है। एक ही Query object को दो बार execute करने पर "Query was already executed" throw होता है।
- **Invalid ObjectId.** `OrderModel.findById('abc')` एक **`CastError`** के साथ reject होता है, जो handle न करने पर 500 बन जाता है। `mongoose.isObjectIdOrHexString(id)` से check करें और 400 लौटाएँ।
- **`Mixed` fields या Dates को उसी जगह mutate करना।** Mongoose `Mixed` path पर `product.specs.color = 'red'` या `date.setMonth(5)` को detect नहीं कर सकता। `save()` से पहले `doc.markModified('specs')` call करें, या पूरी value दोबारा assign करें।
- **`findOneAndUpdate` default रूप से पुराना document लौटाता है।** Updated document पाने के लिए `{ new: true }` दें।
- **API responses से virtuals गायब।** ये `toJSON()` में तब तक शामिल नहीं होते जब तक आप `toJSON: { virtuals: true }` set न करें, और `lean()` के साथ कभी नहीं।
- **बहुत बड़े documents लौटाना।** Endpoint को जो चाहिए सिर्फ़ वही लाने के लिए `.select()` इस्तेमाल करें, secrets को `select: false` से mark करें (जैसे `passwordHash`), और `lean()` इस्तेमाल करें।

## 12. Mongoose कब इस्तेमाल न करें / trade-offs

| | Mongoose | Native driver |
|---|---|---|
| Schemas, casting, validation | ✅ Built in | ❌ खुद करें (या MongoDB में JSON Schema validation) |
| Hooks, virtuals, populate | ✅ | ❌ |
| Raw performance | धीमा (hydration), जब तक `lean()` न हो | ✅ सबसे तेज़ |
| नए MongoDB features | कभी-कभी पीछे रहता है | ✅ तुरंत |
| छिपा हुआ बर्ताव | ⚠️ बहुत सारा | बहुत कम |

आम CRUD-heavy MERN apps के लिए Mongoose एक बढ़िया default है। High-throughput ingestion, bulk jobs, भारी aggregation services के लिए, या जब आपकी team MongoDB के `$jsonSchema` validator के साथ **database-side** validation पसंद करे (जो data की रक्षा करता है चाहे कोई भी app उसे लिखे), तब native driver पर विचार करें (आप अब भी `Model.collection` या `mongoose.connection.db` से उस तक पहुँच सकते हैं)।

> **याद रखें:** Mongoose validation सिर्फ़ उन writes की रक्षा करता है जो Mongoose से होकर जाते हैं। जो नियम हमेशा लागू रहने चाहिए, उन्हें database में भी enforce करें।
