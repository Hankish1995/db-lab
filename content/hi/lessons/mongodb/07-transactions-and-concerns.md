---
slug: mongodb-transactions
title: 'Transactions और concerns: आपको कितना पक्का होना है?'
module: Transactions
summary: 'MongoDB operations अपने-आप में कब atomic होते हैं, Node.js में multi-document transactions कैसे काम करते हैं, और write concern, read concern व read preference durability और freshness को कैसे control करते हैं।'
recap: >-
  MongoDB में single-document write हमेशा atomic होता है, इसलिए अच्छा schema design ज़्यादातर cases संभाल
  लेता है। Multi-document transactions के लिए replica set या sharded cluster चाहिए; session.withTransaction
  इस्तेमाल करें ताकि transient errors retry हों, उन्हें छोटा रखें, और 60-second की default lifetime याद रखें।
  Write concern बताता है कि कितने members को write confirm करना है, read concern बताता है कि आप जो data पढ़ते
  हैं वो कितना committed होना चाहिए, और read preference बताता है कि आप किस member से पढ़ते हैं। Majority,
  primary और causal sessions मिलकर रोज़मर्रा की सबसे मज़बूत guarantees देते हैं।
---

## 1. कहानी

आप courier से एक ज़रूरी parcel भेज रहे हैं।

- **Write concern** वो receipt है जो आप माँगते हैं। "बस इतना बता दो कि counter ने ले लिया" (तेज़, जोखिम भरा) या "मुझे तब बताओ जब यह main warehouse **और** एक backup warehouse तक पहुँच जाए" (धीमा, सुरक्षित)।
- **Read concern** वो है जो आप tracking check करते समय मानने को तैयार हैं। "Local counter ने जो भी लिखा है वो दिखा दो, भले confirm न हुआ हो" या "सिर्फ़ वो updates दिखाओ जिन्हें ज़्यादातर warehouses ने confirm किया है"।
- **Read preference** यह है कि check करने के लिए आप **किस office को call करते हैं**: head office (हमेशा up to date) या पास की कोई branch (नज़दीक, लेकिन उसकी जानकारी कुछ मिनट पुरानी हो सकती है)।
- **Transaction** तीन parcels भेजना है जो **या तो सब पहुँचें या कोई नहीं**: एक order, एक stock adjustment और एक payment slip।

Mapping:

| Courier | MongoDB |
|---|---|
| Head office | **Primary** (सारे writes लेता है) |
| Branch offices | **Secondaries** (data की copies) |
| आप जो receipt माँगते हैं | **Write concern** (`w`, `j`) |
| Tracking info कितनी confirmed होनी चाहिए | **Read concern** (`local`, `majority`, …) |
| आप किस office को call करते हैं | **Read preference** |
| सब-या-कुछ-नहीं वाला bundle | **Multi-document transaction** |

Atomicity और isolation की बुनियादी बातें [ACID](/lessons/acid) में हैं। यह lesson इस बारे में है कि MongoDB उन्हें कैसे लागू करता है।

## 2. Single-document operations पहले से atomic हैं

MongoDB में **एक document** पर हर write atomic होता है, उसके सारे embedded arrays और sub-documents समेत। दूसरे readers को कभी आधा लागू हुआ update नहीं दिखता।

```js
// One atomic operation: decrement stock only if enough is left
db.products.updateOne(
  { _id: 'KB-1', stock: { $gte: 2 } },
  { $inc: { stock: -2 }, $push: { reservations: { orderId: 9001, qty: 2 } } }
)
// modifiedCount: 0 means "not enough stock": nothing changed
```

इसीलिए MongoDB में schema design इतना ज़रूरी है। अगर एक order अपने line items, shipping address और status history को **embed** करता है, तो "order बनाना" **एक document write** है और उसे transaction की ज़रूरत नहीं।

> **याद रखें:** MongoDB में ऐसे design करें कि जो चीज़ें साथ बदलनी चाहिए वो एक ही document में रहें। तब atomicity मुफ़्त मिलती है।

## 3. Multi-document transactions

कभी-कभी data सच में बिखरा होता है। एक checkout तीन collections को छूता है:

1. `orders` में insert
2. `products` में stock घटाना
3. `payments` में insert

अगर step 2 के बाद server crash हो जाए, तो बिना order के आपका stock चला गया। **Multi-document transaction** पक्का करता है कि तीनों succeed हों या कोई नहीं।

ज़रूरतें और limits:

- Transactions के लिए **replica set** या **sharded cluster** चाहिए। Standalone `mongod` में oplog नहीं होता और वो इन्हें नहीं चला सकता। (Local पर भी, अगर आपको इनकी ज़रूरत है तो single-node replica set चलाएँ।)
- अंदर के हर operation को एक ही **session** इस्तेमाल करना होगा।
- Default रूप से अगर transaction **60 seconds** (`transactionLifetimeLimitSeconds`) से ज़्यादा चले तो वो abort हो जाता है।
- Transaction के अंदर reads को read preference **primary** इस्तेमाल करना होगा।

### Node.js driver: `withTransaction`

```js
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db('shop');

async function checkout({ userId, productId, qty, amount }) {
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const stock = await db.collection('products').updateOne(
        { _id: productId, stock: { $gte: qty } },
        { $inc: { stock: -qty } },
        { session }                                // ← every op gets the session
      );
      if (stock.modifiedCount === 0) {
        throw new Error('OUT_OF_STOCK');           // throwing aborts the transaction
      }

      const { insertedId: orderId } = await db.collection('orders').insertOne(
        { userId, items: [{ productId, qty }], status: 'pending', createdAt: new Date() },
        { session }
      );

      await db.collection('payments').insertOne(
        { orderId, userId, amount, status: 'authorized' },
        { session }
      );
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary'
    });
  } finally {
    await session.endSession();
  }
}
```

### `withTransaction` आपके लिए क्या retry करता है

| Error label | मतलब | Helper क्या करता है |
|---|---|---|
| `TransientTransactionError` | किसी अस्थायी चीज़ ने transaction तोड़ दिया (दूसरे transaction के साथ write conflict, primary election, network में झटका) | **आपका पूरा callback दोबारा चलाता है** |
| `UnknownTransactionCommitResult` | Commit भेजा गया लेकिन driver को नहीं पता कि वो succeed हुआ या नहीं | **Commit को retry करता है** (commit retry करना सुरक्षित है) |
| बाकी कुछ भी (आपका `OUT_OF_STOCK`) | आपका logic fail हुआ | **Abort करता है** और error आपको वापस फेंकता है |

Driver एक time limit तक retry करता रहता है। क्योंकि आपका callback **एक से ज़्यादा बार चल सकता है**, उसमें ऐसे side effects नहीं होने चाहिए जो दोहराए न जा सकें, जैसे email भेजना या किसी external API से card charge करना। ये काम transaction commit होने के **बाद** करें।

> **याद रखें:** `withTransaction` इस्तेमाल करें, हर operation को `{ session }` दें, और side effects callback से बाहर रखें क्योंकि वो retry हो सकता है।

### Mongoose में यही चीज़

```ts
import mongoose from 'mongoose';

await mongoose.connection.transaction(async (session) => {
  const res = await Product.updateOne(
    { _id: productId, stock: { $gte: qty } },
    { $inc: { stock: -qty } },
    { session }
  );
  if (res.modifiedCount === 0) throw new Error('OUT_OF_STOCK');

  // create() needs an ARRAY when you pass options
  const [order] = await Order.create(
    [{ user: userId, items: [{ product: productId, qty }], status: 'pending' }],
    { session }
  );
  await Payment.create([{ order: order._id, amount, status: 'authorized' }], { session });
});
```

`connection.transaction()` driver के `withTransaction` को wrap करता है (इसलिए उसे वही retries मिलते हैं) और transaction abort होने पर Mongoose document state को भी reset कर देता है। आप सीधे `const session = await mongoose.startSession()` और `session.withTransaction(...)` भी इस्तेमाल कर सकते हैं।

### Transactions की कीमत

Transactions मुफ़्त नहीं हैं:

- ये अपनी पूरी अवधि तक **locks और एक snapshot** पकड़े रहते हैं। लंबे transactions WiredTiger cache पर दबाव डालते हैं और दूसरे operations के साथ **write conflicts** पैदा करते हैं।
- एक conflicting write की वजह से एक side `TransientTransactionError` के साथ fail होकर retry करती है: contention में ज़्यादा latency।
- Sharded clusters में, कई shards को छूने वाले transaction को उनके बीच **two-phase commit** चाहिए।

इन्हें **छोटा** रखें: validation, price calculation और external API calls शुरू करने से *पहले* करें, और अंदर जितने हो सके उतने कम documents छुएँ।

## 4. Write concern: कितनी confirmations?

**Write concern** तय करता है कि server आपके write को "OK" कब कहे।

```text
                 ┌─────────┐            ┌─────────────┐
 App ──insert──► │ PRIMARY │ ──oplog──► │ SECONDARY 1 │
                 │         │            └─────────────┘
                 │         │            ┌─────────────┐
                 │         │ ──oplog──► │ SECONDARY 2 │
                 └─────────┘            └─────────────┘
   w: 1         ──► ack after the primary applies it
   w: majority  ──► ack after 2 of 3 members have it
   j: true      ──► ack only after it's in the on-disk journal
```

| Option | मतलब | Trade-off |
|---|---|---|
| `w: 0` | बिल्कुल इंतज़ार न करो | Fire-and-forget; आपको errors भी नहीं दिखेंगे |
| `w: 1` | Primary ने apply कर दिया | तेज़, लेकिन replicate होने से पहले primary मर जाए तो खो जाता है |
| `w: 'majority'` | Voting members की majority के पास है | **Failover में बच जाता है**; थोड़ा धीमा |
| `j: true` | On-disk journal में लिखा गया | Acknowledge करने वाले node(s) के crash में बच जाता है |
| `wtimeout: 5000` | 5 s के बाद इंतज़ार बंद | Write **undo नहीं होता**; वो बाद में succeed भी हो सकता है |

MongoDB 5.0 से ज़्यादातर deployments के लिए default write concern `w: 'majority'` है। (Arbiter वाले deployments में यह `w: 1` हो सकता है; देखें [Replication](/lessons/mongodb-replication)।)

```js
db.orders.insertOne(
  { userId: 7, total: 120 },
  { writeConcern: { w: 'majority', j: true, wtimeout: 5000 } }
)
```

⚠️ `wtimeout` error का मतलब है "मैंने इंतज़ार करना बंद कर दिया", **न कि** "यह fail हो गया"। आपके code को इस संभावना को संभालना होगा कि write असल में हो चुका है।

> **याद रखें:** `w: 'majority'` का मतलब है write primary failover में बच जाता है। `w: 1` rollback हो सकता है।

## 5. Read concern: data कितना committed होना चाहिए?

**Read concern** control करता है कि एक read data का कौन सा version लौटा सकता है।

| Level | क्या लौटाता है | कब इस्तेमाल करें |
|---|---|---|
| `local` | Node का latest data, भले वो अभी majority तक replicate न हुआ हो (default) | ज़्यादातर reads |
| `available` | `local` जैसा; sharded clusters में यह **orphaned** documents भी लौटा सकता है, लेकिन सबसे तेज़ है | शायद ही कभी ज़रूरत |
| `majority` | सिर्फ़ majority द्वारा acknowledged data, इसलिए यह **rollback नहीं हो सकता** | ऐसे reads जो कभी "गायब" नहीं होने चाहिए |
| `snapshot` | Documents के पार एक consistent point-in-time view | Multi-document transactions |
| `linearizable` | Read शुरू होने से पहले पूरे हुए हर majority-acknowledged write को दिखाता है; सिर्फ़ primary, single document | वो दुर्लभ "बिल्कुल latest ही चाहिए" read; धीमा |

आसान तस्वीर: `local` = "इस server के पास अभी क्या है", `majority` = "जो पक्का टिका रहेगा", `linearizable` = "जो पक्का टिका रहेगा **और** सबसे नया है, दूसरे members से double-check करके"।

## 6. Read preference: आप किस member से पूछते हैं?

| Read preference | Reads कहाँ जाते हैं | जोखिम |
|---|---|---|
| `primary` (default) | सिर्फ़ primary | Freshness का कोई जोखिम नहीं; primary न हो तो fail |
| `primaryPreferred` | Primary, primary न हो तो secondary | Failover के दौरान stale reads |
| `secondary` | सिर्फ़ secondaries | Stale reads |
| `secondaryPreferred` | Secondaries, कोई उपलब्ध न हो तो primary | Stale reads |
| `nearest` | सबसे कम network latency वाला member | Stale reads |

Secondaries **asynchronously** replicate करते हैं, इसलिए वो पीछे रह सकते हैं। जिस user ने अभी order किया, फिर secondary से "my orders" पढ़ा, उसे वो order **शायद न दिखे**। आप `maxStalenessSeconds` (कम से कम 90 seconds) से staleness पर सीमा लगा सकते हैं, लेकिन stale reads कभी पूरी तरह खत्म नहीं होते।

> **याद रखें:** secondaries से पढ़ने से reads scale होते हैं लेकिन बदले में freshness जाती है। User ने अभी जो बदला हो, उसके लिए default रूप से `primary` रखें।

## 7. Causal consistency: "अपने writes खुद पढ़ो"

एक **causally consistent session** guarantee देता है कि उस session के operations अपने order का सम्मान करें, अलग-अलग members पर भी:

- **Read your writes:** आपने अभी जो order insert किया, वो आपको दिखता है।
- **Monotonic reads:** आपको data कभी समय में पीछे जाता नहीं दिखता।
- **Monotonic writes** और **writes follow reads.**

```js
const session = client.startSession({ causalConsistency: true });
const orders = db.collection('orders');

await orders.insertOne(
  { userId: 7, total: 120 },
  { session, writeConcern: { w: 'majority' } }
);
const mine = await orders
  .find({ userId: 7 }, { session, readConcern: { level: 'majority' }, readPreference: 'secondary' })
  .toArray();   // waits until the secondary has caught up to our insert
await session.endSession();
```

ये guarantees पूरी तरह तभी लागू होती हैं जब आप उस session में **`w: 'majority'`** writes और **`majority`** read concern इस्तेमाल करें।

### सबसे मज़बूत combination

| लक्ष्य | Settings |
|---|---|
| Acknowledged writes कभी न खोएँ | `w: 'majority'` (+ `j: true`) |
| ऐसा data कभी न पढ़ें जो rollback हो सकता है | read concern `majority` |
| हमेशा latest पढ़ें | read preference `primary` (या single docs के लिए `linearizable`) |
| किसी भी member पर अपने writes पढ़ें | causally consistent session + majority/majority |
| Documents के पार सब-या-कुछ-नहीं | `snapshot` + `w: 'majority'` के साथ transaction |

## 8. आम गलतियाँ और gotchas

- किसी एक operation पर **`{ session }` भूल जाना**। वो transaction के **बाहर** चलता है और rollback नहीं होता।
- **Standalone** server पर transactions आज़माना। आपको error मिलता है कि transaction numbers सिर्फ़ replica set member या mongos पर allowed हैं।
- **Callback में external side effects।** Callback retry हो सकता है, इसलिए एक email दो बार जा सकता है।
- **लंबे transactions:** हज़ारों documents पर loop चलाना, या अंदर किसी धीमी API का await करना। ये 60-second limit से टकराते हैं और conflicts पैदा करते हैं।
- Write के तुरंत बाद **secondaries से पढ़ना** और सोचना कि data कहाँ गया।
- **`wtimeout` को failure मान लेना** और non-idempotent insert को retry करके duplicate बना देना।
- Embedding के बजाय, MongoDB में 1:1 port किए गए relational schema को **ठीक करने के लिए transactions इस्तेमाल करना**।

## 9. Transactions कब इस्तेमाल न करें

Transaction तभी उठाएँ जब किसी operation को **ज़रूर** कई documents को atomically छूना हो। पहले ये आज़माएँ:

1. **Embedding:** order, उसके items और उसकी status history को एक document में रखें।
2. **Atomic operators:** `$inc`, `$push`, `$pull`, `$set`, `{ stock: { $gte: qty } }` जैसे conditional filter के साथ।
3. **`findOneAndUpdate`**, एक atomic step में पढ़ने और बदलने के लिए।
4. **Idempotent, retryable steps**, status field के साथ (`pending` → `paid`), जब eventual consistency चल जाए, जैसे services के बीच।

| | Single-document atomic update | Multi-document transaction |
|---|---|---|
| Replica set चाहिए | ❌ | ✅ |
| कीमत | सबसे सस्ता | Locks, snapshot, retries, शायद 2PC |
| दायरा | एक document | कई documents / collections |
| आम इस्तेमाल | Stock घटाना, counters, status बदलना | अलग collections में order + stock + payment |

> **याद रखें:** transactions एक safety net हैं, design pattern नहीं। अगर आपके ज़्यादातर writes को इनकी ज़रूरत पड़ती है, तो schema पर दोबारा सोचें।
