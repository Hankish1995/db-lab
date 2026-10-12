---
slug: acid
title: 'ACID: एक transaction के चार वादे'
module: Transactions
summary: 'Transaction क्या होता है, हर ACID property क्या guarantee देती है और उसके बिना क्या टूटता है, PostgreSQL और MongoDB इन्हें कैसे implement करते हैं, और कब आपको multi-statement transactions की ज़रूरत नहीं होती।'
recap: >-
  Transaction कई operations को एक all-or-nothing unit में बाँध देता है। Atomicity का मतलब है कोई आधा-अधूरा काम नहीं,
  Consistency का मतलब है हर commit के बाद data आपके नियमों के हिसाब से valid रहता है, Isolation का मतलब है एक साथ चल रहे
  transactions एक-दूसरे का अधूरा काम नहीं देखते, और Durability का मतलब है commit हुआ data crash के बाद भी बचा रहता है।
  Databases यह सब write-ahead log, constraints, locks या MVCC, और fsync से बनाते हैं। ACID का C valid data के बारे में है,
  CAP का C नहीं। MongoDB में single-document write पहले से atomic होता है, इसलिए अच्छी modelling से अक्सर
  multi-document transactions की ज़रूरत ही खत्म हो जाती है।
---

## 1. कहानी

Asha running shoes की एक जोड़ी के लिए **Pay ₹2,999** पर click करती है। उस एक click के पीछे store को चार काम करने होते हैं:

1. Asha के wallet से ₹2,999 काटना।
2. Shoe का stock 1 से कम करना।
3. Order बनाना।
4. Payment record करना।

अब सोचिए कि server **step 1 के बाद crash** हो जाता है। Asha के पैसे कट गए, लेकिन कोई order नहीं बना। वह गुस्से में support को call करती है। या सोचिए कि **दो लोग** एक ही पल में आख़िरी जोड़ी खरीदते हैं, और दोनों सफल हो जाते हैं।

**Transaction** database का वादा है कि वह इन चारों steps को **एक unit** की तरह treat करेगा: या तो सारे होंगे, या कोई भी नहीं होगा, और बीच की state किसी को दिखेगी नहीं।

इसे **property sale पर sign करने वाले notary** की तरह सोचिए। Buyer पैसे देता है, seller चाबियाँ सौंपता है, deed update होती है। Notary किसी को आधी deal लेकर जाने नहीं देता (**atomicity**), कानून तोड़ने वाली deals मना कर देता है (**consistency**), एक घर के लिए एक समय में एक ही deal संभालता है (**isolation**), और signed deed को fireproof archive में रख देता है (**durability**)।

| Notary | ACID property | वादा |
|---|---|---|
| कोई आधी deal नहीं | **Atomicity** | सब कुछ या कुछ भी नहीं |
| सिर्फ़ कानूनी deals | **Consistency** | Commit के बाद नियम हमेशा लागू रहते हैं |
| हर घर के लिए एक समय में एक deal | **Isolation** | Concurrent transactions एक-दूसरे में दख़ल नहीं देते |
| Fireproof archive | **Durability** | Committed = crash के बाद भी सुरक्षित |

> **याद रखें:** **transaction** reads और writes का एक group है जिसे database **एक अविभाज्य unit** मानता है। ACID उन चार वादों की list है जो database उस unit के बारे में करता है।

## 2. हर letter, और उसके बिना क्या टूटता है

### A: Atomicity

Transaction के सारे operations सफल होते हैं, या किसी का भी असर नहीं होता। अगर कुछ भी fail हो (कोई error, constraint violation, crash, या आपका code `ROLLBACK` call करे), तो हर change undo हो जाता है।

❌ **इसके बिना:** wallet से पैसे कट गए, order नहीं बना। पैसा गायब।

यहाँ "Atomic" का मतलब है **अविभाज्य (indivisible)**, "concurrent-safe" नहीं। वह isolation का काम है।

### C: Consistency

Transaction database को एक **valid state** से दूसरी valid state में ले जाता है। "Valid" का मतलब है आपके सारे नियम लागू हैं: `stock >= 0`, हर order किसी मौजूदा user को reference करता है, emails unique हैं।

❌ **इसके बिना:** stock -1 हो जाता है, कोई order deleted user की तरफ़ point करता है।

एक ज़रूरी बारीकी: database सिर्फ़ वही नियम लागू करता है जो **आप declare करते हैं** (constraints, validators)। "Wallet debit order total के बराबर होना चाहिए" जैसा नियम आपके code में रहता है। इसलिए consistency एक **साझा ज़िम्मेदारी (shared responsibility)** है: database A, I और D के साथ constraints देता है; आपकी application इनका इस्तेमाल करके data को सही रखती है।

### I: Isolation

एक ही समय पर चल रहे transactions ऐसे behave करते हैं जैसे वे **एक के बाद एक** चले हों, या कम से कम एक-दूसरे का अधूरा काम नहीं देखते। यह कितना strict है, यह **isolation level** पर निर्भर करता है।

❌ **इसके बिना:** दो checkouts दोनों `stock = 1` पढ़ते हैं, दोनों `stock = 0` लिखते हैं, और एक shoe के दो orders बन जाते हैं (एक **lost update**)। या कोई report ऐसा balance पढ़ लेती है जिसे एक अभी-तक-commit-न-हुए transaction ने बदला था और जो बाद में roll back हो जाता है (एक **dirty read**)।

| Anomaly | क्या होता है |
|---|---|
| **Dirty read** | आप किसी दूसरे transaction का uncommitted change पढ़ लेते हैं |
| **Non-repeatable read** | आप एक ही row दो बार पढ़ते हैं और अलग-अलग values मिलती हैं |
| **Phantom read** | आप range query दोबारा चलाते हैं और नई rows दिख जाती हैं |
| **Lost update** | दो read-modify-write cycles एक-दूसरे को overwrite कर देते हैं |

### D: Durability

एक बार database ने **committed** कह दिया, तो data crash, बिजली जाने या restart के बाद भी बचा रहता है।

❌ **इसके बिना:** Asha को "Order confirmed" दिखता है, server की बिजली चली जाती है, और restart के बाद उसका order मौजूद ही नहीं है।

**Disk failure** के ख़िलाफ़ durability के लिए एक से ज़्यादा machine चाहिए: replication और backups।

> **याद रखें:** **A** = सब कुछ या कुछ भी नहीं। **C** = नियम हमेशा लागू। **I** = concurrent transactions एक-दूसरे से नहीं टकराते। **D** = committed का मतलब saved।

## 3. Databases हर वादे को कैसे implement करते हैं

```text
 BEGIN
   │
   ├─ change 1 ──► log record appended (in memory)
   ├─ change 2 ──► log record appended
   ├─ change 3 ──► log record appended
   │
 COMMIT
   │
   ├─ commit record appended to the log
   ├─ log flushed to disk (fsync)   ← durability point
   └─ "OK" returned to the app
         data pages written to disk later (checkpoint)

 Crash before the fsync?  → transaction never committed, discarded
 Crash after the fsync?   → log replayed on restart, data restored
```

| Property | मुख्य mechanism |
|---|---|
| **Atomicity** | Undo जानकारी (पुराने row versions या undo log) + log में commit record |
| **Consistency** | Constraints (`NOT NULL`, `UNIQUE`, `CHECK`, foreign keys), triggers, MongoDB schema validation + atomicity |
| **Isolation** | **Locks** और **MVCC** (multi-version concurrency control) |
| **Durability** | **Write-ahead log** / journal जिसे commit acknowledge करने से पहले `fsync` से flush किया जाता है |

कुछ details जो जानने लायक हैं:

- **Undo और redo.** *Redo* का मतलब है crash के बाद logged changes को replay करना (WAL)। *Undo* का मतलब है uncommitted changes को discard करना। PostgreSQL को अलग undo log की ज़रूरत नहीं होती: MVCC की वजह से यह **नए row versions** लिखता है और aborted transaction के versions बस कभी visible ही नहीं होते। MySQL InnoDB एक explicit undo log इस्तेमाल करता है।
- **MVCC.** Readers को writers का इंतज़ार कराने के बजाय, database एक row के **कई versions** रखता है। हर transaction एक **snapshot** से पढ़ता है, इसलिए readers writers को block नहीं करते और writers readers को block नहीं करते। **एक ही** row पर लिखने वाले writers में फिर भी conflict होता है। PostgreSQL और MongoDB (WiredTiger) दोनों MVCC इस्तेमाल करते हैं।
- **fsync.** File में लिखा गया data आमतौर पर पहले OS cache में जाता है। `fsync` उसे physical disk पर लिखने के लिए मजबूर करता है। Commit तभी durable होता है जब log fsync हो चुका हो।
- **Knobs (settings).** PostgreSQL का `synchronous_commit = off` WAL flush से पहले ही return कर देता है: तेज़ है, लेकिन crash होने पर आख़िरी एक सेकंड के कुछ हिस्से के commits खो सकते हैं (data corrupt हुए बिना)। MongoDB में write concern `j: true` या `w: 'majority'` journal का इंतज़ार करता है; journaling के बिना `w: 1` कम इंतज़ार करता है।

### PostgreSQL में isolation levels

| Level | क्या रोकता है | Notes |
|---|---|---|
| Read Uncommitted | Dirty reads | PostgreSQL में बिल्कुल Read Committed जैसा behave करता है |
| **Read Committed** (default) | Dirty reads | हर **statement** को एक नया snapshot दिखता है |
| Repeatable Read | + non-repeatable और phantom reads | **पूरे transaction** के लिए एक ही snapshot |
| Serializable | सारी anomalies | Serialization error के साथ abort हो सकता है: उसे retry करें |

MongoDB के multi-document transactions **snapshot isolation** इस्तेमाल करते हैं: transaction एक consistent snapshot से पढ़ता है, और अगर दो transactions एक ही document लिखते हैं, तो एक को **write conflict** मिलता है और वह abort हो जाता है (driver उसे `withTransaction` के अंदर retry करता है)।

> **याद रखें:** durability आती है **OK कहने से पहले logging + fsync** से। Isolation आती है **locks या MVCC** से। Atomicity आती है जो कुछ commit नहीं हुआ उसे **discard** कर पाने की क्षमता से।

## 4. एक असली उदाहरण: transaction के रूप में checkout

### PostgreSQL

Consistency का कुछ काम constraints कर देते हैं:

```sql
CREATE TABLE wallets (
  user_id bigint PRIMARY KEY REFERENCES users(id),
  balance numeric(12,2) NOT NULL CHECK (balance >= 0)
);
-- products.stock already has CHECK (stock >= 0)
```

Checkout:

```sql
BEGIN;

UPDATE wallets  SET balance = balance - 2999 WHERE user_id = 17;
UPDATE products SET stock   = stock - 1      WHERE id = 203;

INSERT INTO orders (user_id, status)
VALUES (17, 'paid')
RETURNING id;

COMMIT;
```

- अगर Asha के पास ₹2,999 से कम हैं, तो `CHECK (balance >= 0)` fail होता है, statement error देता है और transaction **abort** हो जाता है। उसके बाद हर statement *"current transaction is aborted"* के साथ fail होता है और `COMMIT` असल में rollback कर देता है। कुछ भी नहीं बदला।
- अगर app cancel करने का फ़ैसला करे (जैसे payment gateway decline कर दे), तो वह `COMMIT;` की जगह `ROLLBACK;` चलाता है।
- Product 203 पर दो concurrent checkouts: दूसरा `UPDATE` पहले वाले के पास मौजूद **row lock का इंतज़ार करता है**, फिर latest stock दोबारा पढ़ता है। अगर stock zero से नीचे जाता, तो `CHECK` उसे रोक देता है।

### MongoDB (Node.js driver)

Multi-document transactions के लिए **replica set** या sharded cluster चाहिए (Atlas हमेशा ऐसा ही होता है)। हर operation को `session` मिलना चाहिए:

```js
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    const shop = client.db('shop');

    const wallet = await shop.collection('wallets').updateOne(
      { userId, balance: { $gte: 2999 } },
      { $inc: { balance: -2999 } },
      { session }
    );
    if (wallet.modifiedCount !== 1) throw new Error('Insufficient balance');

    const product = await shop.collection('products').updateOne(
      { _id: productId, stock: { $gte: 1 } },
      { $inc: { stock: -1 } },
      { session }
    );
    if (product.modifiedCount !== 1) throw new Error('Out of stock');

    await shop.collection('orders').insertOne(
      { userId, status: 'paid', items: [{ productId, quantity: 1 }], createdAt: new Date() },
      { session }
    );
  }, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' }
  });
} finally {
  await session.endSession();
}
```

- Callback के अंदर throw करने से transaction **abort** हो जाता है और error आपके code तक पहुँच जाता है।
- `withTransaction` transient errors (जैसे write conflicts) पर और unknown commit result पर **अपने-आप retry** करता है, इसलिए callback ऐसा होना चाहिए जो एक से ज़्यादा बार चलने पर भी सुरक्षित हो (इसके अंदर emails न भेजें)।
- किसी एक operation पर `{ session }` भूल जाना एक classic bug है: वह write transaction के **बाहर** चलता है और roll back नहीं होगा।

## 5. MongoDB: पहले single-document atomicity

MongoDB में **single document पर हर write atomic होता है**, उसके सारे embedded arrays और subdocuments समेत। इसलिए अगर आपका data अच्छे से modelled है, तो कई "transactions" बस एक update होते हैं:

```js
// Add an item and update the total in one atomic operation
db.orders.updateOne(
  { _id: orderId, status: 'pending' },
  {
    $push: { items: { productId, quantity: 2, unitPrice: 499 } },
    $inc:  { total: 998 }
  }
)
```

या तो `$push` और `$inc` दोनों apply होंगे, या कोई भी नहीं। Session की ज़रूरत नहीं।

Multi-document transactions पूरी तरह ACID हैं, लेकिन उनकी कीमत ज़्यादा है: extra coordination, locks ज़्यादा देर तक held रहते हैं, default **60-second** runtime limit, और sharded clusters पर ज़्यादा काम। MongoDB की अपनी सलाह: जहाँ फिट बैठे, वहाँ transactions के बजाय **schema design** (embedding) को प्राथमिकता दें।

> **याद रखें:** MongoDB में design ऐसा करें कि जो चीज़ें साथ में बदलनी चाहिए वे **एक ही document में रहें**। Multi-document transaction तभी इस्तेमाल करें जब ऐसा सच में मुमकिन न हो।

## 6. ACID के C को CAP के C से confuse न करें

| | **ACID Consistency** | **CAP Consistency** |
|---|---|---|
| किस बारे में | Data आपके **नियमों** को मानता है | सारे nodes **latest** value return करते हैं |
| दायरा (Scope) | एक database, एक transaction | Replicas वाला एक **distributed** system |
| कब टूटता है | Stock -1 हो जाता है | कोई replica पुरानी stock value return करता है |
| Formal नाम | Integrity / invariants | **Linearizability** |

शब्द एक ही, मतलब बिल्कुल अलग। Interview में बिना पूछे यह बात कहना एक मज़बूत signal है।

## 7. ACID बनाम BASE

**BASE** उस style को describe करता है जिसे कई शुरुआती distributed NoSQL systems ने चुना था:

| | **ACID** | **BASE** |
|---|---|---|
| पूरा नाम | Atomicity, Consistency, Isolation, Durability | **B**asically **A**vailable, **S**oft state, **E**ventually consistent |
| प्राथमिकता | Correctness (सही होना) | Availability और scale |
| Write के बाद | सबको committed value दिखती है | Replicas **आख़िरकार (eventually)** एक जैसे हो जाते हैं |
| आमतौर पर कहाँ फिट | Payments, inventory, orders | Likes counters, feeds, analytics events |

यह एक spectrum है, दो खेमे नहीं: उदाहरण के लिए MongoDB, `majority` concerns के साथ configure करने पर replica set के अंदर ACID है, और इसे तेज़ लेकिन कमज़ोर guarantees की तरफ़ भी tune किया जा सकता है।

## 8. आम गलतियाँ और gotchas

- **लंबे transactions.** Transaction के अंदर payment API call करना या user input का इंतज़ार करना locks पकड़े रखता है और (PostgreSQL में) पुराने row versions की cleanup को रोकता है। धीमा external काम transaction के **पहले या बाद** करें, अंदर नहीं।
- **यह मान लेना कि Read Committed lost updates रोकता है.** PostgreSQL के default level में, `SELECT stock` → JS में calculate → `UPDATE stock = 5` से फिर भी update खो सकता है। `UPDATE … SET stock = stock - 1`, `SELECT … FOR UPDATE`, या कोई stricter level इस्तेमाल करें।
- **Retry न करना.** PostgreSQL में Serializable transactions और MongoDB में write conflicts कभी-कभी **ज़रूर** abort होंगे। यह design के हिसाब से ही है; आपके code को retry करना होगा।
- **Retry होने वाले callbacks के अंदर side effects.** `withTransaction` के अंदर emails या webhooks दो बार fire हो सकते हैं।
- **यह मानना कि durability का मतलब है "data खो ही नहीं सकता".** एक server की durability ख़राब disk से नहीं बचाती। आपको replication और backups भी चाहिए।
- **Standalone server पर MongoDB transactions चलाना.** वे fail होते हैं: transactions को replica set चाहिए (local dev के लिए single-node replica set काम कर जाता है)।

## 9. कब आपको multi-statement transaction की ज़रूरत नहीं है

- **एक row या एक document.** एक अकेला `UPDATE` या `updateOne` पहले से atomic है।
- **Atomic operators काम कर देते हैं.** `$inc`, `stock = stock - 1`, conditional updates (`WHERE stock > 0`, `{ stock: { $gte: 1 } }`) ज़्यादातर counter और inventory races हल कर देते हैं।
- **Embedded data.** Order + items एक ही MongoDB document में।
- **Services के पार idempotent, retry करने लायक steps.** Microservices या payment gateway के पार database transaction वैसे भी span नहीं कर सकता; **outbox** pattern या compensating actions वाला **saga** इस्तेमाल करें।
- **Append-only events** (page views, logs) जहाँ ordering खोना या कभी-कभार duplicate होना चल जाता है।

Trade-off: transactions correctness खरीदते हैं **latency, contention और complexity** की कीमत पर। जहाँ पैसा और stock है वहाँ इन्हें इस्तेमाल करें; जहाँ एक अकेला atomic write काम कर दे वहाँ इन्हें छोड़ दें।
