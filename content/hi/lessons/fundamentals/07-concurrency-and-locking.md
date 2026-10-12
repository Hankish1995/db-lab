---
slug: concurrency-and-locking
title: 'Concurrency और locking: दो खरीदार, आख़िरी एक item'
module: Transactions
summary: 'जब transactions एक साथ चलते हैं तो कौन-सी anomalies होती हैं, हर isolation level क्या रोकता है, और atomic updates, pessimistic locks और optimistic versioning SQL और MongoDB में overselling को कैसे रोकते हैं।'
recap: >-
  जब transactions overlap होते हैं तो lost updates, dirty reads, non-repeatable reads, phantoms और write skew हो सकते हैं।
  Isolation levels तय करते हैं कि इनमें से कौन-से संभव हैं; PostgreSQL का default read committed है, इसका repeatable read
  snapshot isolation है, और इसका serializable level conflict करने वाले transactions को abort करके write skew रोकता है।
  Overselling रोकने के लिए एक atomic conditional update को प्राथमिकता दें; भारी contention में pessimistic locking के लिए
  SELECT FOR UPDATE और conflicts कम हों तो optimistic locking के लिए version check इस्तेमाल करें। Consistent lock order और छोटे transactions से deadlocks से बचें, और retry के लिए हमेशा तैयार रहें।
---

## 1. कहानी

Flash sale चल रही है। **सिर्फ़ 1 PlayStation बचा है**। Asha और Ravi दोनों एक ही second में "Buy" पर click करते हैं।

आपका Node.js handler वही करता है जो सबसे सीधा लगता है:

```js
const product = await Product.findById(id);   // 1. read
if (product.stock < 1) throw new Error('Sold out');
product.stock -= 1;                           // 2. decide in app code
await product.save();                         // 3. write
await Order.create({ userId, productId: id });
```

दोनों requests `stock = 1` पढ़ती हैं। दोनों check पास कर लेती हैं। दोनों `stock = 0` लिखती हैं। दोनों को order confirmation मिल जाता है। आपने **दो** PlayStation बेच दिए, जबकि आपके पास **एक** ही था।

इसे **race condition** कहते हैं: नतीजा इस बात पर निर्भर करता है कि overlap होने वाले दो operations की timing क्या रही। ऐसा समझिए कि दुकान में दो cashier एक ही shelf पर नज़र डालते हैं, दोनों को एक item दिखता है, और दोनों उसे किसी customer को देने का वादा कर देते हैं।

| दुकान | Database |
|---|---|
| एक साथ काम करते दो cashier | **Concurrent transactions** |
| Shelf पर नज़र डालना | एक **read** |
| Item देने का वादा करना | उस read के आधार पर एक **write** |
| सबसे पहले item पर हाथ रख देना | एक **lock** |
| Shelf पर "10:02 पर check किया" वाला sticker | एक **version** number |
| हर cashier दूसरे का अधूरा काम कितना देख सकता है | **Isolation level** |

> **याद रखें:** "read करो, app code में decide करो, write करो" तब race condition है जब भी दो requests एक साथ चल सकती हैं। और web server में ऐसा हमेशा होता है।

## 2. यह मुश्किल क्यों है: पाँच anomalies

Throughput के लिए databases कई transactions concurrently चलाते हैं। बिना control के ये **anomalies** सामने आती हैं। हर timeline को ऊपर से नीचे पढ़िए।

### Lost update

दो transactions एक ही value पढ़ते हैं, दोनों उसे बदलते हैं, और दूसरा write पहले वाले को **overwrite** कर देता है।

```text
 T1 (Asha)                     T2 (Ravi)
 ────────────────────────      ────────────────────────
 read stock      → 1
                               read stock      → 1
 write stock = 0
 COMMIT
                               write stock = 0
                               COMMIT
 Result: 2 orders, stock 0. T1's decrement was lost.
```

### Dirty read

ऐसा data पढ़ना जिसे किसी दूसरे transaction ने **अभी commit नहीं किया है**, और जो rollback भी हो सकता है।

```text
 T1 (admin)                    T2 (customer)
 ────────────────────────      ────────────────────────
 set price = 0 (typo!)
                               read price      → 0
                               place order at 0
 ROLLBACK
 Result: an order at a price that never officially existed.
```

### Non-repeatable read

एक ही transaction में **एक ही row को दो बार** पढ़ने पर **अलग-अलग values** मिलती हैं, क्योंकि बीच में किसी ने change commit कर दिया।

```text
 T1 (checkout)                 T2 (admin)
 ────────────────────────      ────────────────────────
 read price      → 499
                               set price = 549
                               COMMIT
 read price      → 549
 Result: the cart total and the invoice disagree.
```

### Phantom read

**एक ही query दो बार** चलाने पर **rows का अलग set** मिलता है, क्योंकि किसी ने matching rows insert या delete कर दीं।

```text
 T1 (report)                   T2 (shop)
 ────────────────────────      ────────────────────────
 count pending   → 5
                               insert pending order
                               COMMIT
 count pending   → 6
 Result: the summary says 5 but the detail lists 6.
```

### Write skew

दो transactions **एक ही data** पढ़ते हैं, उसके आधार पर फ़ैसले लेते हैं, और **अलग-अलग rows** लिखते हैं। अकेले में हर write ठीक है; लेकिन दोनों मिलकर एक नियम तोड़ देते हैं।

नियम: "हर customer WELCOME coupon सिर्फ़ एक बार redeem कर सकता है"।

```text
 T1 (tab 1)                    T2 (tab 2)
 ────────────────────────      ────────────────────────
 count redemptions → 0
                               count redemptions → 0
 insert redemption
                               insert redemption
 COMMIT                        COMMIT
 Result: coupon used twice. No row was written by both.
```

Write skew सबसे चालाक anomaly है: किसी भी दो transactions ने एक ही row को नहीं छुआ, इसलिए सिर्फ़ row locks इसे नहीं पकड़ पाते।

> **याद रखें:** lost update = overwrite। Dirty = uncommitted। Non-repeatable = वही row बदल गई। Phantom = नई rows आ गईं। Write skew = अलग rows, टूटा हुआ नियम।

## 3. Isolation levels

**Isolation level** ACID का "I" है: एक transaction उसी समय चल रहे दूसरे transactions से कितना सुरक्षित है। SQL standard चार levels define करता है, इस आधार पर कि वे उसकी तीन classic phenomena में से किन्हें होने देते हैं:

| Level | Dirty read | Non-repeatable read | Phantom read |
|---|---|---|---|
| Read uncommitted | संभव | संभव | संभव |
| Read committed | ❌ रोका गया | संभव | संभव |
| Repeatable read | ❌ | ❌ | संभव |
| Serializable | ❌ | ❌ | ❌ |

**Serializable** का मतलब: नतीजा वैसा ही होगा जैसे transactions किसी क्रम में **एक-एक करके** चले हों। निचले levels concurrency के बदले safety छोड़ते हैं।

### PostgreSQL असल में क्या करता है

Standard सिर्फ़ **न्यूनतम शर्तें** तय करता है; databases इससे ज़्यादा strict हो सकते हैं। PostgreSQL **MVCC** इस्तेमाल करता है (हर transaction writers को block करने की बजाय एक consistent **snapshot** पढ़ता है), और इसके levels ऐसे behave करते हैं:

| PostgreSQL level | Dirty | Non-repeatable | Phantom | Lost update | Write skew |
|---|---|---|---|---|---|
| Read uncommitted | ❌ | संभव | संभव | संभव | संभव |
| **Read committed** (default) | ❌ | संभव | संभव | संभव | संभव |
| Repeatable read | ❌ | ❌ | ❌ | ❌ (error) | संभव |
| Serializable | ❌ | ❌ | ❌ | ❌ (error) | ❌ (error) |

- **Read uncommitted बिल्कुल read committed की तरह behave करता है।** PostgreSQL कभी uncommitted data नहीं दिखाता।
- **Read committed** **हर statement** के लिए नया snapshot लेता है। यहाँ "lost update" का मतलब कहानी वाला pattern है: app में read करो, फिर write करो।
- **Repeatable read** असल में **snapshot isolation** है: पूरे transaction के लिए एक ही snapshot, इसलिए यह phantoms भी रोकता है। अगर आप ऐसी row update करने की कोशिश करें जिसे आपके snapshot के बाद किसी और ने बदल दिया, तो आपको `could not serialize access due to concurrent update` मिलता है।
- **Serializable** **Serializable Snapshot Isolation (SSI)** इस्तेमाल करता है: यह read/write dependencies track करता है और जब write skew जैसा ख़तरनाक pattern दिखे तो एक transaction को abort कर देता है।
- Repeatable read और serializable पर, serialization failures (SQLSTATE `40001`) होने पर आपके code को **retry करना ही होगा**।

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT count(*) FROM coupon_redemptions
WHERE customer_id = 7 AND code = 'WELCOME';
INSERT INTO coupon_redemptions (customer_id, code) VALUES (7, 'WELCOME');
COMMIT;  -- one of two concurrent runs fails with 40001; retry it
```

दूसरे databases के लिए: MySQL InnoDB का default **repeatable read** है। MongoDB के multi-document transactions एक **snapshot** से पढ़ते हैं और write conflicts पर abort हो जाते हैं। MVCC अंदर से कैसे काम करता है, यह PostgreSQL track में विस्तार से समझाया गया है।

> **याद रखें:** standard वाली table याद रखें, फिर कहें "लेकिन PostgreSQL कभी dirty reads नहीं होने देता, इसका repeatable read snapshot isolation है, और serializable SSI है जो abort करता है और retry की उम्मीद रखता है।"

## 4. समाधान

### Solution 1: एक atomic, conditional statement

App code में read-then-write मत कीजिए। Database को **एक ही statement में check और change** करने दीजिए:

```sql
UPDATE products
SET stock = stock - 1
WHERE product_id = 1 AND stock > 0
RETURNING stock;
-- 1 row updated  → you got it
-- 0 rows updated → sold out
```

यह read committed पर भी safe क्यों है: पहला `UPDATE` **row को lock कर देता है**। दूसरा **इंतज़ार करता है**; जब पहला commit हो जाता है, तो PostgreSQL **नए row version पर `WHERE` को दोबारा check करता है**, देखता है कि `stock > 0` अब false है, और 0 rows update करता है।

MongoDB: हर single-document write **atomic** होता है, इसलिए stock पर filter लगाइए और `$inc` इस्तेमाल कीजिए:

```js
const res = db.products.updateOne(
  { _id: 1, stock: { $gte: 1 } },
  { $inc: { stock: -1 } }
)
// res.modifiedCount === 1 → reserved; 0 → sold out
```

### Solution 2: pessimistic locking

**पहले lock, फिर सोचो।** मान लीजिए कि conflicts होंगे ही, और जब तक आप काम कर रहे हैं तब तक दूसरों को block रखिए।

```sql
BEGIN;
SELECT stock FROM products WHERE product_id = 1 FOR UPDATE;
-- other transactions trying to lock or update this row now WAIT
-- app checks stock, applies business rules, calls services...
UPDATE products SET stock = stock - 1 WHERE product_id = 1;
INSERT INTO orders (customer_id, product_id) VALUES (7, 1);
COMMIT;  -- lock released
```

काम के variants: `FOR UPDATE NOWAIT` (इंतज़ार करने की बजाय तुरंत error) और `FOR UPDATE SKIP LOCKED` (जो rows किसी और ने पकड़ रखी हैं उन्हें छोड़ दो; job queues के लिए बढ़िया)।

### Solution 3: optimistic locking

**Lock मत करो; detect करो।** मान लीजिए कि conflicts कम होते हैं। एक **version** पढ़िए, और write सिर्फ़ तभी कीजिए जब version नहीं बदला हो।

```sql
SELECT stock, version FROM products WHERE product_id = 1;
-- stock = 5, version = 7

UPDATE products
SET stock = 4, version = version + 1
WHERE product_id = 1 AND version = 7;
-- 0 rows → someone else changed it: re-read and retry
```

```js
const p = db.products.findOne({ _id: 1 })
const res = db.products.updateOne(
  { _id: 1, version: p.version },
  { $set: { stock: p.stock - 1 }, $inc: { version: 1 } }
)
// res.matchedCount === 0 → conflict, retry
```

**Mongoose** में यह built in है। Schema option `optimisticConcurrency: true` के साथ, `doc.save()` version key (`__v`) को update filter में जोड़ता है और उसे increment करता है, और अगर load करने के बाद document बदल गया हो तो `VersionError` throw करता है। ध्यान दें कि यह सिर्फ़ **`save()`** पर लागू होता है; `updateOne()` और `findOneAndUpdate()` इसे bypass कर देते हैं।

```js
const productSchema = new mongoose.Schema(
  { name: String, stock: Number },
  { optimisticConcurrency: true }
);
```

> **याद रखें:** सबसे पहले atomic statement। Pessimistic = lock, बाकी इंतज़ार करें। Optimistic = version check, हारने वाला retry करे।

## 5. Inventory overselling के तीन समाधान

असली checkout: stock घटाना **और** order बनाना, या तो सब कुछ या कुछ भी नहीं।

**SQL, atomic (recommended):**

```sql
BEGIN;
UPDATE products SET stock = stock - 2
WHERE product_id = 1 AND stock >= 2;
-- app: if 0 rows updated → ROLLBACK, "out of stock"
INSERT INTO orders (customer_id, product_id, qty) VALUES (7, 1, 2);
COMMIT;
```

**SQL, pessimistic:** Solution 2 की तरह `SELECT ... FOR UPDATE`, फिर app में `stock >= 2` check कीजिए। इसे तब चुनिए जब फ़ैसले के लिए ऐसा logic चाहिए जो `WHERE` में फ़िट न हो (कई warehouses में stock, reservations, fraud checks)।

**SQL, optimistic:** Solution 3 वाला version check transaction के अंदर; अगर 0 rows आएँ, तो `ROLLBACK` करके पूरी प्रक्रिया retry कीजिए।

**MongoDB, atomic + transaction (Node.js driver):**

```js
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    const res = await db.collection('products').updateOne(
      { _id: productId, stock: { $gte: qty } },
      { $inc: { stock: -qty } },
      { session }
    );
    if (res.modifiedCount === 0) throw new Error('OUT_OF_STOCK');
    await db.collection('orders').insertOne(
      { userId, productId, qty, createdAt: new Date() },
      { session }
    );
  });
} finally {
  await session.endSession();
}
```

`withTransaction` write conflicts जैसी transient errors पर अपने-आप retry करता है।

**MongoDB, pessimistic-style:** यहाँ `SELECT ... FOR UPDATE` नहीं है। आम pattern यह है कि transaction के अंदर **पहले document पर write करो** (जैसे एक `findOneAndUpdate` जो `lockedAt` field set करे), जिससे वह document आपका हो जाता है। उसी document पर write करने वाले दूसरे transaction को **write conflict** मिलता है और वह retry होता है, बजाय इसके कि वह पुराना data पढ़कर उस पर काम कर ले।

**MongoDB, optimistic:** ऊपर दिखाया गया `version` filter, या `save()` के साथ Mongoose का `optimisticConcurrency`, एक retry loop में लिपटा हुआ।

## 6. Deadlocks

**Deadlock** तब होता है जब दो transactions में से हर एक ने ऐसा lock पकड़ रखा हो जिसकी दूसरे को ज़रूरत है। दोनों में से कोई आगे नहीं बढ़ सकता।

Asha का cart: पहले Mouse, फिर Keyboard। Ravi का cart: पहले Keyboard, फिर Mouse।

```text
 T1 (Asha)                     T2 (Ravi)
 ────────────────────────      ────────────────────────
 lock Mouse     ✓
                               lock Keyboard  ✓
 lock Keyboard  ... waits
                               lock Mouse     ... waits

         ┌──────────────────────────────────┐
         │ T1 waits for T2, T2 waits for T1 │
         │ cycle: nobody can ever finish    │
         └──────────────────────────────────┘
```

**Databases इसे कैसे संभालते हैं:** PostgreSQL में, जब lock का इंतज़ार `deadlock_timeout` (default 1 second) से ज़्यादा हो जाता है, तो वह **wait-for graph** में cycle check करता है। अगर cycle मिलती है, तो वह एक transaction को `ERROR: deadlock detected` (SQLSTATE `40P01`) के साथ abort कर देता है। दूसरा आगे बढ़ जाता है। जिसे abort किया गया (victim), उसे retry करना होगा।

MongoDB में, write conflict होने पर transactions एक-दूसरे का इंतज़ार करने की बजाय abort हो जाते हैं, इसलिए यही स्थिति classic deadlock की जगह **write-conflict retries** के रूप में दिखती है।

**इनसे कैसे बचें:**

- **Consistent lock order:** cart के product IDs को sort कीजिए और हमेशा उसी क्रम में lock/update कीजिए। अब दोनों transactions पहले Mouse चाहते हैं, तो एक बस इंतज़ार करता है।
- **छोटे transactions:** HTTP calls, payment gateway calls या user के सोचने के समय के दौरान कभी locks मत पकड़े रखिए।
- **कम lock कीजिए:** atomic single statements locks को microseconds तक ही पकड़ते हैं।
- **Retry:** deadlocks फिर भी हो सकते हैं; `40P01` को `40001` की तरह treat कीजिए और retry कीजिए।

> **याद रखें:** deadlock = गोल-गोल इंतज़ार (circular waiting)। Consistent order में lock कीजिए, transactions छोटे रखिए, और victim को retry कीजिए।

## 7. आम गलतियाँ और gotchas

- **App code में stock check करना, फिर write करना।** यह classic race है। Condition को `WHERE` / filter में रखिए।
- **यह सोचना कि सिर्फ़ transaction से ठीक हो जाएगा।** PostgreSQL के default read committed पर, `BEGIN ... COMMIT` के अंदर read-then-write से updates **अब भी** lose हो सकते हैं। आपको conditional update, lock या ज़्यादा strict level चाहिए।
- **Retry logic के बिना isolation level बढ़ाना।** Repeatable read और serializable conflict पर transactions **abort** कर देते हैं। Retry नहीं = load में random 500 errors।
- **धीमे काम के दौरान `FOR UPDATE` पकड़े रखना।** हर दूसरा खरीदार उस payment API call के पीछे queue में लग जाता है।
- **Write skew को सिर्फ़ row locks से ठीक करना।** वो rows अभी exist ही नहीं करतीं। **Unique constraint** (`UNIQUE (customer_id, code)`) या serializable इस्तेमाल कीजिए।
- **यह मान लेना कि Mongoose का default `__v` सब कुछ protect करता है।** `optimisticConcurrency` के बिना, Mongoose का versioning सिर्फ़ कुछ array changes को ही guard करता है।

## 8. Pessimistic बनाम optimistic locking

| | Pessimistic | Optimistic |
|---|---|---|
| Idea | Read करने से पहले lock | Write करते समय version check |
| Conflict होने पर | बाकी **इंतज़ार करते हैं** | हारने वाला **fail होकर retry करता है** |
| कब सबसे अच्छा | Conflicts **अक्सर** हों (hot items, flash sales) | Conflicts **कम** हों (profile edits, admin forms) |
| कीमत | Lock waits, deadlock का risk | Retry पर बर्बाद हुआ काम |
| User का लंबा "think time" | ❌ मिनटों तक locks नहीं पकड़ सकते | ✅ HTTP requests के पार काम करता है |
| SQL | `SELECT ... FOR UPDATE` | `WHERE version = ?` |
| MongoDB | Transaction में पहले write | Version field filter / `optimisticConcurrency` |

## 9. Trade-offs: कौन-सा tool कब नहीं इस्तेमाल करना

- **"Safe रहने के लिए" हर जगह default रूप से serializable मत लगाइए।** यह सही है लेकिन इसकी कीमत retries और throughput में चुकानी पड़ती है; इसे उन transactions के लिए इस्तेमाल कीजिए जिनमें सच में cross-row नियम हों।
- **कम contention वाले data पर pessimistic locks मत लगाइए।** जो conflicts शायद ही कभी होते हैं, उनके लिए आप waiting और deadlock risk की कीमत चुकाते हैं।
- **Hot row पर optimistic locking मत लगाइए।** Flash sale में ज़्यादातर attempts fail होकर retry करते हैं, यानी **retry storm**। एक single atomic update बेहतर है।
- **Locking बनाइए ही मत** जब एक atomic statement या एक constraint (`CHECK (stock >= 0)`, `UNIQUE`) नियम लागू कर सकता है। Database constraints को हर code path के लिए लागू करता है, उनके लिए भी जिन्हें आप भूल जाते हैं।

> **याद रखें:** सबसे अच्छा lock वो है जिसकी आपको ज़रूरत ही न पड़े। Atomic statements और constraints को प्राथमिकता दीजिए; locks और ज़्यादा strict isolation तभी अपनाइए जब नियम एक से ज़्यादा row पर फैला हो।
