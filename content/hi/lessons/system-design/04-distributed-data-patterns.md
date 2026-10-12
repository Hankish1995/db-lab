---
slug: distributed-data-patterns
title: 'Distributed data patterns: अलग-अलग services में checkout को सही रखना'
module: Replication & Consistency
summary: 'एक transaction कई services में क्यों नहीं फैल सकता, two-phase commit और sagas multi-step काम को कैसे coordinate करते हैं, transactional outbox dual-write problem को कैसे ठीक करता है, और idempotency keys retries को safe कैसे बनाती हैं।'
recap: >-
  जब checkout अलग-अलग services में बँटे orders, payments, inventory और email को छूता है, तो कोई एक ACID transaction
  उसे cover नहीं करता। Two-phase commit atomicity देता है पर coordinator fail होने पर block हो जाता है, इसलिए ज़्यादातर
  systems sagas इस्तेमाल करते हैं: local transactions की एक chain, जिसमें payment refund करने जैसे compensating actions
  होते हैं। Database में लिखना और event publish करना atomic नहीं हो सकता, इसलिए event को उसी transaction में एक outbox
  table में लिखें और relay या CDC को उसे publish करने दें। Delivery at-least-once होती है, इसलिए हर consumer और payment
  call idempotent होनी चाहिए, आमतौर पर एक unique idempotency key से।
---

## 1. कहानी: चार vendors के साथ शादी की planning

आप एक शादी book कर रहे हैं: venue, caterer, photographer और band। हर vendor का अपना calendar है। आपको **चारों चाहिए या कोई नहीं**।

आप चारों vendors से एक ही पल में एक contract sign नहीं करवा सकते। तो आप या तो:

- **पहले सबसे date hold करवाते हैं, फिर सबको confirm करते हैं** (two-phase commit)। अगर "hold" के बाद आप गायब हो गए, तो vendors एक ऐसी date पकड़े बैठे रहते हैं जो वो किसी और को नहीं दे सकते।
- **एक-एक करके book करते हैं, और अगर बाद वाली booking fail हो तो पहले वाली cancel कर देते हैं** (saga)। Venue book हो गया, caterer ने मना कर दिया, तो आप venue cancel कर देते हैं, शायद कुछ fee गँवाकर। यह अदृश्य नहीं है, पर काम करता है।

| शादी | Distributed system |
|---|---|
| हर vendor का calendar | हर service का **अपना database** |
| "Date hold करेंगे?" / "Confirmed" | 2PC के **prepare** / **commit** phases |
| आप, coordinate करते हुए | **Coordinator** या **orchestrator** |
| Venue cancel करना | एक **compensating action** |
| गलती से band को दो बार call करना | एक **duplicate message**, जिसके लिए **idempotency** चाहिए |

## 2. समस्या: checkout चार चीज़ों को छूता है

```text
 POST /checkout
      │
      ├──► Orders service    → orders DB    (create order)
      ├──► Payment service   → payments DB  (charge via provider)
      ├──► Inventory service → inventory DB (reserve stock)
      └──► Email service     → provider     (send confirmation)
```

एक database के अंदर, आप इसे एक transaction में लपेट देते और [ACID](/lessons/acid) मिल जाता। पर अलग-अलग services में, जिनका अपना-अपना database है, साथ में एक external payment provider और email service भी, **कोई shared transaction नहीं है**। क्या-क्या गलत हो सकता है:

- Payment सफल, inventory reservation fail → customer से बिना कुछ दिए पैसे कट गए।
- Order save हुआ, पर "OrderCreated" event कभी publish नहीं हुआ → warehouse कभी ship नहीं करता।
- Payment call पर network time out हो गया → charge हुआ या नहीं? Retry करने से **दो बार charge** हो सकता है।

> **याद रखें:** distributed systems में सवाल कभी "क्या कोई step fail होगा?" नहीं होता, बल्कि "जब होगा, तब सब कुछ किस state में होगा?" होता है।

## 3. Two-phase commit (2PC)

एक **coordinator** transaction को दो phases में चलाता है:

```text
 Phase 1: PREPARE               Phase 2: COMMIT
     ┌─────────────┐                ┌─────────────┐
     │ Coordinator │                │ Coordinator │
     └──────┬──────┘                └──────┬──────┘
            │ "can you commit?"            │ "commit!" (all YES)
   ┌────────┼────────┐            ┌────────┼────────┐
   ▼        ▼        ▼            ▼        ▼        ▼
 Orders  Payments  Stock        Orders  Payments  Stock
  YES      YES      YES          done     done     done
 (work durable, locks HELD)     (locks released)
```

1. **Prepare:** हर participant काम करता है, उसे durably लिखता है, अपने locks पकड़े रखता है, और YES ("मैं वादा करता हूँ कि commit कर सकता हूँ") या NO vote देता है।
2. **Commit:** अगर सबने YES vote दिया, तो coordinator फ़ैसला record करता है और सबको commit करने को कहता है; नहीं तो सब abort कर देते हैं।

PostgreSQL participant वाली तरफ़ को `PREPARE TRANSACTION 'id'` और `COMMIT PREPARED 'id'` से support करता है (default रूप से disabled: `max_prepared_transactions = 0`)। MongoDB कई shards में फैले transactions के लिए अंदर ही अंदर एक 2PC protocol इस्तेमाल करता है।

**Blocking problem:** एक बार participant ने YES vote दे दिया, तो वो **खुद से फ़ैसला नहीं कर सकता**। अगर coordinator फ़ैसला भेजने से पहले crash हो जाए, तो participants "in doubt" रहते हैं और उन rows पर locks पकड़े रहते हैं, जब तक coordinator recover न हो जाए। Hot inventory rows का minutes तक locked रहना मतलब checkout down है।

बाकी कीमतें: हर transaction पर extra round trips, हर participant को 2PC support करना होगा (Stripe और email providers नहीं करते), और availability सारे participants की availability का गुणनफल बन जाती है।

> **याद रखें:** 2PC atomicity देता है, पर blocking की कीमत पर। यह एक database cluster के अंदर काम करता है; microservices और third-party APIs के बीच यह शायद ही fit होता है।

## 4. Saga pattern

**Saga** **local transactions** का एक sequence है, हर service का एक। हर step अपने आप commit होता है। अगर बाद का कोई step fail हो, तो saga **compensating actions** चलाता है जो पहले के steps को अर्थ के हिसाब से (semantically) undo करते हैं।

```text
 Happy path:
 ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
 │ Create     ├──►│ Charge     ├──►│ Reserve    ├──►│ Confirm    │
 │ order      │   │ payment    │   │ inventory  │   │ order      │
 │ (PENDING)  │   │            │   │            │   │ + email    │
 └────────────┘   └────────────┘   └─────┬──────┘   └────────────┘
                                         │ fails: out of stock
 Compensation:                           ▼
 ┌────────────┐   ┌────────────┐   ┌────────────┐
 │ Cancel     │◄──┤ Refund     │◄──┤ Failure    │
 │ order      │   │ payment    │   │ detected   │
 └────────────┘   └────────────┘   └────────────┘
```

Compensation rollback **नहीं** है। Charge सच में हुआ था; refund एक नया, दिखने वाला transaction है। Customer को अपने statement पर दोनों दिख सकते हैं।

### Choreography vs orchestration

- **Choreography:** कोई central दिमाग नहीं। हर service events पर react करती है: Orders `OrderCreated` emit करता है, Payments उसे सुनकर `PaymentCaptured` emit करता है, Inventory उसे सुनकर `StockReserved` या `StockReservationFailed` emit करता है, और Payments failure सुनकर refund कर देता है।
- **Orchestration:** एक **orchestrator** (कोई service, या Temporal या AWS Step Functions जैसा workflow engine) हर service को बताता है कि क्या करना है और saga की state track करता है।

| | Choreography | Orchestration |
|---|---|---|
| Control | Distributed, event-driven | Central orchestrator |
| Coupling | Services एक-दूसरे के events जानती हैं | Services सिर्फ़ orchestrator के commands जानती हैं |
| Visibility | Flow छिपा हुआ, trace करना मुश्किल | Flow एक जगह साफ़ लिखा हुआ |
| किसके लिए best | 2–4 आसान steps | लंबे flows, timeouts, complex compensation |
| जोखिम | Events की गोल-गोल घूमती spaghetti | Orchestrator एक "god service" बन जाता है |

### Saga design tips

- **Steps का order सोच-समझकर रखें।** जिन steps के fail होने की संभावना ज़्यादा है या जिन्हें undo करना आसान है, उन्हें पहले रखें। कई shops **पहले inventory reserve करती हैं** और payment को सिर्फ़ **authorize** (capture नहीं) करती हैं, और capture order confirm होने के बाद ही करती हैं। Reservation छोड़ना refund से सस्ता और कम दिखने वाला है।
- **Steps के बीच कोई isolation नहीं।** दूसरी requests आधा-अधूरा saga देख सकती हैं। **Semantic locks** इस्तेमाल करें: order status `PENDING` में रहता है और UI व दूसरे flows इसका सम्मान करते हैं।
- **Compensations retry करने लायक और idempotent होने चाहिए**, क्योंकि वो भी fail हो सकते हैं।

> **याद रखें:** saga, atomicity के बदले availability देता है: हर step locally commit होता है, और failures को compensations से आगे बढ़कर ठीक किया जाता है।

## 5. Dual-write problem और Transactional Outbox

Orders service order save करती है और एक event publish करती है:

```ts
await db.query('INSERT INTO orders ...');   // 1. commit to DB
await broker.publish('OrderCreated', evt);  // 2. publish
```

अगर process 1 और 2 के बीच crash हो जाए, तो order मौजूद है पर **कोई event कभी नहीं भेजा जाता**। Order उल्टा कर दें, तो crash के बाद एक ऐसे order का event बचता है जो मौजूद ही नहीं। दो अलग systems में atomically नहीं लिखा जा सकता: यही **dual-write problem** है।

**Transactional Outbox:** event को business change के साथ **उसी local transaction में** एक `outbox` table में लिखें। एक अलग **relay** outbox rows को broker पर publish करता है।

```sql
CREATE TABLE outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id  text        NOT NULL,
  event_type    text        NOT NULL,
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

BEGIN;
INSERT INTO orders (id, user_id, total_cents, status)
VALUES ('ord_1001', 42, 12999, 'PENDING');
INSERT INTO outbox (aggregate_id, event_type, payload)
VALUES ('ord_1001', 'OrderCreated',
        '{"orderId":"ord_1001","userId":42,"totalCents":12999}');
COMMIT;
```

या तो दोनों rows commit होती हैं या कोई नहीं। Relay या तो **poll** करता है:

```sql
BEGIN;
SELECT id, event_type, payload FROM outbox
WHERE published_at IS NULL
ORDER BY created_at
LIMIT 100
FOR UPDATE SKIP LOCKED;   -- several relays can run without double-claiming
-- publish each row to the broker, then:
UPDATE outbox SET published_at = now() WHERE id = ANY($1);
COMMIT;
```

…या **change data capture** (CDC) इस्तेमाल करता है: Debezium जैसा tool database का log (PostgreSQL WAL) पढ़ता है और outbox inserts publish करता है, बिना polling के।

MongoDB में, multi-document transaction इस्तेमाल करें (इसके लिए replica set या sharded cluster चाहिए):

```ts
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    await orders.insertOne(
      { _id: 'ord_1001', userId: 42, totalCents: 12999, status: 'PENDING' },
      { session });
    await outbox.insertOne(
      { type: 'OrderCreated', orderId: 'ord_1001', createdAt: new Date(), publishedAt: null },
      { session });
  });
} finally {
  await session.endSession();
}
```

`outbox` collection पर एक **change stream** (resume tokens से resumable) एक स्वाभाविक relay है। चूँकि MongoDB में single-document writes atomic होते हैं, आप pending events को order document के अंदर ही embed भी कर सकते हैं। देखें [MongoDB transactions](/lessons/mongodb-transactions)।

ध्यान दें कि relay एक row publish करके उसे published mark करने से पहले crash हो सकता है, तो वो **उसे दोबारा publish करेगा**। Outbox आपको **at-least-once** delivery देता है, exactly-once कभी नहीं।

> **याद रखें:** DB और broker में कभी अलग-अलग न लिखें। DB में एक बार लिखें (business row + outbox row), और log को broker चलाने दें।

## 6. Idempotency: retries को safe बनाना

Networks time out होते हैं। Clients retry करते हैं। Brokers दोबारा deliver करते हैं। इसका इलाज है operations को **idempotent** बनाना: उन्हें दो बार करने का असर एक बार करने जितना ही हो।

### Payments के लिए idempotency keys

Client हर checkout attempt के लिए एक unique key (एक UUID) बनाता है और हर retry के साथ उसे भेजता है। Server key को एक **unique constraint** के तहत record करता है, ताकि दूसरा attempt दूसरा payment न बना सके।

```sql
CREATE TABLE payments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key  text        NOT NULL UNIQUE,
  order_id         text        NOT NULL,
  amount_cents     integer     NOT NULL,
  status           text        NOT NULL,   -- PENDING | SUCCEEDED | FAILED
  provider_ref     text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
```

```ts
export async function pay(idemKey: string, orderId: string, amountCents: number) {
  const inserted = await pool.query(
    `INSERT INTO payments (idempotency_key, order_id, amount_cents, status)
     VALUES ($1, $2, $3, 'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [idemKey, orderId, amountCents]);

  if (inserted.rowCount === 0) {
    // Duplicate: return the stored outcome instead of charging again.
    const { rows } = await pool.query(
      'SELECT status, provider_ref FROM payments WHERE idempotency_key = $1', [idemKey]);
    return rows[0]; // if still PENDING, tell the client to retry later (e.g. 409)
  }

  // Pass the same key to the provider, so its side is idempotent too
  // (payment APIs such as Stripe accept an idempotency key per request).
  const charge = await paymentProvider.charge(
    { orderId, amountCents }, { idempotencyKey: idemKey });

  await pool.query(
    `UPDATE payments SET status = 'SUCCEEDED', provider_ref = $2
     WHERE idempotency_key = $1`, [idemKey, charge.id]);
  return { status: 'SUCCEEDED', provider_ref: charge.id };
}
```

ज़रूरी बारीकियाँ: key **client** पर बनाएँ (हर attempt के लिए, हर click के लिए नहीं), keys को इतनी देर रखें कि retries cover हो जाएँ (जैसे 24 hours), और **अलग parameters** के साथ दोबारा इस्तेमाल हुई key को reject करें।

### Idempotent consumers

At-least-once delivery में हर consumer को duplicates संभालने होंगे। Processed message IDs को side effect वाले **उसी transaction** में record करें:

```sql
BEGIN;
INSERT INTO processed_messages (message_id) VALUES ($1);  -- PK: fails on duplicate
UPDATE inventory SET reserved = reserved + 1 WHERE product_id = $2;
COMMIT;
```

Duplicate आने पर insert primary key violate करता है, transaction rollback हो जाता है, और consumer कुछ किए बिना message acknowledge कर देता है। दूसरा तरीका: operation को स्वाभाविक रूप से idempotent बनाएँ: `SET status = 'SHIPPED'` दोहराना safe है; `reserved = reserved + 1` नहीं।

> **याद रखें:** at-least-once delivery + idempotent consumers = effectively-once processing। यही असली, हासिल करने लायक लक्ष्य है।

## 7. Event sourcing

**क्या:** current state store करने के बजाय, जो **events का sequence** हुआ वो store करें (`OrderPlaced`, `ItemAdded`, `PaymentCaptured`, `OrderShipped`)। Current state उन्हें replay करके निकाली जाती है, आमतौर पर समय-समय पर **snapshots** के साथ, ताकि शुरुआत से replay न करना पड़े।

**कब:** आपको पूरा audit trail चाहिए (finance, ledgers), आप "पिछले मंगलवार को यह कैसा दिखता था?" का जवाब देना चाहते हैं, या domain स्वाभाविक रूप से events की एक धारा है।

**कीमत:** event schemas हमेशा के लिए रहते हैं और उन्हें version करना पड़ता है; queries के लिए अलग read models (projections) चाहिए; गलत data ठीक करने का मतलब है corrective events लिखना; और team को events में सोचना पड़ता है। एक आम product catalog के लिए यह ज़रूरत से ज़्यादा है।

## 8. CQRS

**क्या:** **Command Query Responsibility Segregation** **write model** (commands validate करता है, invariants लागू करता है) को **read models** (खास queries के लिए बने denormalized views) से अलग करता है, जो events या CDC से asynchronously update होते हैं।

**कब:** reads और writes का shape या scale बहुत अलग हो, जैसे checkout normalized tables में लिखता है जबकि storefront एक pre-joined product document और एक search index पढ़ता है। यह event sourcing के साथ स्वाभाविक रूप से जुड़ता है, पर उसकी ज़रूरत नहीं है।

**कीमत:** read models **eventually consistent** होते हैं (user को अपना order "My orders" में एक पल के लिए न दिखे), ज़्यादा moving parts, और आपको projections दोबारा बना पाने में सक्षम होना होगा। बढ़ते system में यह कहाँ fit होता है, इसके लिए [Scaling databases](/lessons/scaling-databases) देखें।

## 9. आम गलतियाँ

- खुले database transaction के **अंदर** किसी दूसरी service को call करना, network का इंतज़ार करते हुए locks पकड़े रखना।
- सादे dual write से events publish करना "क्योंकि यह लगभग कभी fail नहीं होता"।
- बिना idempotency key के payments retry करना।
- यह मान लेना कि broker end to end exactly-once की guarantee देता है।
- ऐसे compensations लिखना जो idempotent नहीं हैं, और फिर उन्हें दो बार चला देना।
- इतनी जल्दी microservices में बाँट देना कि जो काम एक database transaction कर सकता था, उसके लिए checkout को saga चाहिए।

## 10. Decision table

| स्थिति | क्या इस्तेमाल करें |
|---|---|
| सारा data एक database में | एक local ACID transaction। जिसे distribute करने की ज़रूरत नहीं, उसे distribute न करें। |
| कम participants, सब XA support करते हैं, छोटे transactions, एक ही data centre | 2PC (blocking का जोखिम स्वीकार करें) |
| Services या external APIs में फैला multi-step business flow | Saga (कुछ से ज़्यादा steps हों तो orchestration) |
| DB update करना और दूसरी services को बताना ज़रूरी है | Transactional outbox + relay/CDC |
| Side effects वाली कोई भी retry होने वाली request (payments, orders) | Idempotency key + unique constraint |
| Events consume करना | Idempotent consumer (dedup table या natural idempotency) |
| Audit trail / temporal queries मुख्य ज़रूरतें हैं | Event sourcing |
| Read और write workloads बहुत अलग हैं | Read models के साथ CQRS |

सबसे अच्छा distributed transaction वो है जिससे आप बच जाएँ: जिस data को atomically बदलना ज़रूरी है, उसे जहाँ भी domain इजाज़त दे, **एक ही service और database में** रखें।
