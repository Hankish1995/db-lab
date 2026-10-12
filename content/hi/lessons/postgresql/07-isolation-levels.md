---
slug: postgres-isolation-levels
title: 'PostgreSQL में isolation levels: अंदर असल में क्या होता है'
module: Transactions
summary: 'PostgreSQL के Read Committed, Repeatable Read और Serializable snapshots, concurrent updates और write skew के साथ असल में कैसे behave करते हैं, serialization failures को retry कैसे करें, और कौन सा level चुनें।'
recap: >-
  Read Committed, जो default है, हर statement के लिए नया snapshot लेता है; जब दो updates एक ही row पर पड़ते हैं, तो दूसरा
  wait करता है और फिर नए version पर अपना WHERE दोबारा check करता है, जो आपको चौंका सकता है। Repeatable Read snapshot
  isolation है: हर transaction का एक snapshot, कोई phantoms नहीं, और concurrent update को overwrite करने की जगह error,
  लेकिन write skew फिर भी संभव है। Serializable SSI जोड़ता है, जो खतरनाक read/write patterns पकड़कर एक transaction को
  SQLSTATE 40001 के साथ abort कर देता है, इसलिए application को retry करना ही होगा। Read Uncommitted, Read Committed जैसा
  ही behave करता है।
---

## 1. कहानी

तीन shop managers stock गिन रहे हैं, और customers लगातार खरीदारी कर रहे हैं।

- **Manager A (Read Committed)** हर **वाक्य लिखने से पहले** live shelf देखता है। उसकी report की हर line उस पल के लिए सही है जब वो लिखी गई, पर line 1 और line 5 अलग-अलग पलों के बारे में हो सकती हैं।
- **Manager B (Repeatable Read)** शुरुआत में shelves की **एक photo** लेता है और पूरी report उसी photo से लिखता है। एकदम consistent, पर अगर वो कोई ऐसा item बदलने की कोशिश करे जिसे photo के बाद किसी और ने बदल दिया है, तो उसे कहा जाता है "आपकी photo पुरानी हो गई है, दोबारा शुरू करें"।
- **Manager C (Serializable)** भी photo से ही काम करता है, पर एक **referee** देखता रहता है कि हर manager ने क्या *पढ़ा* और क्या *लिखा*। अगर मिला-जुला नतीजा ऐसा है जो managers के एक-एक करके काम करने पर हो ही नहीं सकता था, तो referee उनमें से एक को cancel कर देता है।

| Shop | PostgreSQL |
|---|---|
| Shelf को देखना | **Snapshot** लेना |
| हर वाक्य से पहले | **Read Committed**: हर **statement** का snapshot |
| पूरी report के लिए एक photo | **Repeatable Read**: हर **transaction** का snapshot (snapshot isolation) |
| Referee | **SSI** (Serializable Snapshot Isolation) |
| "दोबारा शुरू करें" | **Serialization failure**, SQLSTATE `40001` |

Anomalies खुद (dirty read, lost update, phantom, write skew) [Concurrency और locking](/lessons/concurrency-and-locking) में समझाई गई हैं। ये lesson इस बारे में है कि PostgreSQL *असल में क्या करता है*।

> **याद रखें:** PostgreSQL में isolation level ज़्यादातर इस बात का सवाल है कि **snapshot कब लिया जाता है** और **किसी concurrent writer से टकराने पर क्या होता है**।

## 2. Snapshots: हर level के पीछे का engine

PostgreSQL **MVCC** इस्तेमाल करता है: update overwrite करने की जगह एक नया row version लिखता है। **Snapshot** एक छोटा सा record है जो कहता है "इस पल से पहले commit हुए transactions मुझे दिखते हैं, जो अभी चल रहे हैं या बाद में शुरू हुए वो नहीं"। हर read एक snapshot इस्तेमाल करता है, इसलिए readers को किसी भी level पर कभी uncommitted data नहीं दिखता। Row versions कैसे काम करते हैं, ये [MVCC और VACUUM](/lessons/postgres-mvcc-and-vacuum) में है।

```text
 Level             Snapshot taken          On concurrent update of
                                           the same row
 ───────────────   ─────────────────────   ─────────────────────────
 Read Committed    at every statement      wait, re-check, continue
 Repeatable Read   at 1st statement of tx  wait, then ERROR 40001
 Serializable      at 1st statement of tx  ERROR 40001, plus SSI
                                           checks on reads
```

ध्यान दें: Repeatable Read transaction का snapshot उसकी **पहली query** पर लिया जाता है, `BEGIN` पर नहीं।

## 3. Read Committed (default)

हर **statement** वो सब देखता है जो उस statement के शुरू होने से पहले commit हो चुका था। एक ही transaction में दो एक जैसे `SELECT` अलग-अलग results लौटा सकते हैं।

### एक ही row पर दो UPDATEs

जब आपका `UPDATE` ऐसी row पाता है जिसे किसी दूसरे transaction ने update किया है पर commit नहीं किया, तो वो row lock के लिए **wait** करता है। जब दूसरा transaction commit हो जाता है, PostgreSQL दोबारा शुरू से नहीं चलता। वो **उस row का नया version** लेता है, उस पर **आपका `WHERE` दोबारा evaluate** करता है, और उसे तभी update करता है जब वो अब भी match करे।

इसीलिए `UPDATE products SET stock = stock - 1 WHERE id = 1 AND stock > 0` Read Committed पर safe है: दूसरा buyer fresh value पर `stock > 0` दोबारा check करता है।

### चौंकाने वाला नतीजा

दो deal products: Headphones 900 पर और Speaker 1100 पर। एक admin एक transaction में दोनों के prices आपस में बदल देता है। उसी पल, एक job 1000 से कम वाले हर product को flag करती है।

```text
 T1 (admin)                       T2 (flag job, Read Committed)
 ──────────────────────────────   ──────────────────────────────
 BEGIN;
 UPDATE: Headphones → 1100,
         Speaker    → 900
                                  UPDATE deal_products
                                  SET flagged = true
                                  WHERE price < 1000;
                                  -- snapshot sees Headphones=900
                                  -- tries to lock it ... WAITS
 COMMIT;
                                  -- re-checks Headphones: 1100
                                  -- no longer < 1000, skip
                                  UPDATE 0
```

असली नतीजा (verified, दूसरे session ने लगभग 2 seconds wait किया):

```text
UPDATE 0
 id |    name    | price | flagged
----+------------+-------+---------
  1 | Headphones |  1100 | f
  2 | Speaker    |   900 | f
```

हर committed पल पर **ठीक एक** product 1000 से सस्ता था, फिर भी कुछ flag नहीं हुआ। T2 सिर्फ़ उन्हीं rows को दोबारा check करता है जो **उसके अपने snapshot** ने ढूँढी थीं; Speaker उस snapshot में match नहीं करता था, इसलिए उस पर कभी विचार ही नहीं हुआ। Statement ने "पहले" और "बाद" का मिला-जुला रूप देखा।

सीधे single-row updates के लिए ये ठीक है। लेकिन ऐसी rows पर multi-row, condition-based updates के लिए जिन्हें दूसरे बदल रहे हैं, ये ऐसे results दे सकता है जो न पुरानी state से match करते हैं, न नई से।

> **याद रखें:** Read Committed पर blocked UPDATE अपना WHERE **पहले से मिली rows के सबसे नए version** पर दोबारा check करता है; वो search दोबारा नहीं चलाता। जो rows दूसरे commit के बाद ही match करना शुरू करती हैं, वो छूट जाती हैं।

## 4. Repeatable Read = snapshot isolation

पूरा transaction **एक snapshot** से पढ़ता है। दोबारा पढ़ने पर बिल्कुल वही results मिलते हैं, और दूसरों की insert की हुई नई rows कभी नहीं दिखतीं। इसलिए PostgreSQL का Repeatable Read **phantoms** को भी रोकता है, जो SQL standard की ज़रूरत से ज़्यादा सख़्त है।

### एक ही row का concurrent update: error मिलता है, wait-and-continue नहीं

```sql
-- T2
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT qty FROM stock WHERE product_id = 1;          -- 10 (snapshot taken)
-- meanwhile T1 updated this row and is about to commit
UPDATE stock SET qty = qty - 1 WHERE product_id = 1; -- waits for T1...
```

T1 के commit होने के बाद असली output:

```text
ERROR:  40001: could not serialize access due to concurrent update
```

T2 अपना change ऐसे row version पर apply नहीं कर सकता जो उसके snapshot को दिखता ही नहीं, और वो चुपचाप T1 को overwrite भी नहीं कर सकता, इसलिए वो fail हो जाता है। अगर T1 **roll back** हुआ होता, तो T2 का update हो जाता। यही error `DELETE` और `SELECT ... FOR UPDATE` पर भी लागू होती है। तो इस level पर **lost updates नामुमकिन हैं**; कीमत ये है कि आपके code को retry करना होगा।

### Write skew फिर भी निकल जाता है

नियम: **एक cart में एक coupon**। हर transaction cart check करता है, कोई coupon नहीं देखता, और अपना insert कर देता है। दोनों **अलग-अलग rows** लिखते हैं, इसलिए पकड़ने के लिए कोई row conflict है ही नहीं।

```text
 T1 (tab 1, RR)                   T2 (tab 2, RR)
 ──────────────────────────────   ──────────────────────────────
 BEGIN ISOLATION LEVEL
   REPEATABLE READ;
 SELECT count(*) ... cart 7 → 0
                                  BEGIN ISOLATION LEVEL
                                    REPEATABLE READ;
                                  SELECT count(*) ... cart 7 → 0
                                  INSERT (7, 'FESTIVE20');
                                  COMMIT;  ✓
 INSERT (7, 'WELCOME10');
 COMMIT;  ✓
 Result: cart 7 has TWO coupons
```

Verified: दोनों commits सफल हुए और `cart_discounts` में दोनों rows आ गईं। इस level पर fixes: एक constraint जो नियम को encode करे ("एक cart में एक" के लिए सिर्फ़ `cart_id` पर unique index), किसी common parent row को lock करना (`SELECT ... FROM carts WHERE id = 7 FOR UPDATE`) ताकि दोनों transactions सच में टकराएँ, या Serializable।

> **याद रखें:** Repeatable Read lost updates को error 40001 से रोकता है, पर **write skew को नहीं**: जो दो transactions एक ही data पढ़कर अलग-अलग rows लिखते हैं, दोनों commit हो सकते हैं।

## 5. Serializable = Serializable Snapshot Isolation (SSI)

Serializable वादा करता है: नतीजा committed transactions के **किसी एक-एक-करके वाले order** के बराबर होगा। PostgreSQL इसे snapshot isolation plus **conflict tracking** से implement करता है:

- Reads **predicate locks** लेते हैं (`pg_locks` में `SIReadLock` के रूप में दिखते हैं)। ये किसी को **block नहीं करते**; ये बस notes हैं जो कहते हैं "T1 ने ये range पढ़ी"।
- जब कोई दूसरा transaction उस range में लिखता है जिसे किसी ने पढ़ा था, तो PostgreSQL एक **read/write dependency** record करता है।
- जब dependencies एक **dangerous structure** बनाती हैं (एक transaction जिसकी concurrent transactions के साथ incoming और outgoing दोनों rw-dependency हो, यानी "pivot"), तो एक transaction abort कर दिया जाता है।

वही coupon race, दोनों `SERIALIZABLE` पर। T2 पहले commit करता है; T1 अपने `INSERT` पर fail होता है:

```text
ERROR:  40001: could not serialize access due to read/write
        dependencies among transactions
DETAIL:  Reason code: Canceled on identification as a pivot,
         during write.
HINT:  The transaction might succeed if retried.
```

सिर्फ़ `FESTIVE20` बचता है। जब T1 retry करता है, तो उसका fresh snapshot `count = 1` देखता है और वो दूसरे coupon को ठीक से reject कर देता है।

SSI के बारे में जानने लायक बातें:

- **कोई extra blocking नहीं**: Serializable readers को wait नहीं करवाता। कीमत है tracking के लिए CPU/memory और **aborted transactions**।
- **False positives** होते हैं। Tracking मोटे स्तर पर हो सकती है (page या पूरी relation के level पर, जैसे जब query Seq Scan करे), इसलिए कोई असली anomaly न होने पर भी transaction abort हो सकता है। अच्छे indexes tracking को ज़्यादा precise बनाते हैं।
- Error किसी read, write या `COMMIT` पर आ सकती है।
- इसमें शामिल **सारे** transactions Serializable पर चलने चाहिए; बीच में मिला कोई Read Committed transaction protected नहीं होता।
- लंबी reports के लिए `BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE` काम का है: ये एक safe snapshot का इंतज़ार करता है और फिर कभी serialization error से fail नहीं हो सकता।

## 6. Retry करना ही होगा: Node.js retry loop

Repeatable Read और Serializable पर `40001` **सामान्य, अपेक्षित व्यवहार** है, bug नहीं। **पूरा transaction** retry करें, उसके reads समेत। ये code (`pg` library के साथ) coupon table पर चलाया गया था: दो concurrent calls, एक को `40001` मिला, उसने retry किया, और फिर सही ढंग से देखा कि coupon पहले से लगा हुआ है।

```js
const { Pool } = require('pg');
const pool = new Pool();

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withSerializableRetry(work, { maxAttempts = 5 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (!RETRYABLE.has(err.code) || attempt === maxAttempts) throw err;
      await sleep(2 ** attempt * 10 + Math.random() * 50); // backoff + jitter
    } finally {
      client.release();
    }
  }
}

async function applyCoupon(cartId, coupon) {
  return withSerializableRetry(async (client) => {
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM cart_discounts WHERE cart_id = $1',
      [cartId]
    );
    if (rows[0].n > 0) throw new Error('Only one coupon per cart');
    await client.query(
      'INSERT INTO cart_discounts (cart_id, coupon) VALUES ($1, $2)',
      [cartId, coupon]
    );
    return coupon;
  });
}
```

Callback के नियम: उसके अंदर **कोई side effects नहीं** (emails, HTTP calls, Kafka messages), क्योंकि वो कई बार चल सकता है; हर query के लिए हमेशा वही `client` इस्तेमाल करें; attempts की एक सीमा रखें।

> **याद रखें:** Serializable सिर्फ़ retry loop **के साथ** सही है। उसके बिना ये बस race conditions को random 500 errors में बदल देता है।

## 7. Read Uncommitted, और level कैसे set करें

PostgreSQL `READ UNCOMMITTED` accept करता है, पर **उसे Read Committed की तरह ही treat करता है**। PostgreSQL में किसी भी level पर dirty reads नामुमकिन हैं।

```sql
-- For one transaction (most common)
BEGIN ISOLATION LEVEL REPEATABLE READ;

-- Or as the FIRST statement inside the transaction
BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- after any query it fails with:
-- ERROR: SET TRANSACTION ISOLATION LEVEL must be called before any query

-- Default for this session
SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- (equivalent: SET default_transaction_isolation = 'repeatable read';)

-- Default for every connection to a database or for a role
ALTER DATABASE shop SET default_transaction_isolation = 'serializable';
ALTER ROLE reporting SET default_transaction_isolation = 'repeatable read';

SHOW transaction_isolation;   -- check what you're actually running
```

## 8. Performance trade-offs

| | Read Committed | Repeatable Read | Serializable |
|---|---|---|---|
| Extra blocking | कोई नहीं | कोई नहीं | कोई नहीं (predicate locks block नहीं करते) |
| Retry करने वाली errors | सिर्फ़ deadlocks | + same-row update पर `40001` | + rw-dependency patterns पर `40001`, false positives समेत |
| Overhead | सबसे कम | कम | Tracking का CPU/memory + retry हुआ काम |
| High contention में | Waits | Hot rows पर बहुत सारे aborts | सबसे ज़्यादा aborts |
| लंबे transactions | Vacuum को रोकते हैं | Vacuum को रोकते हैं (एक पुराना snapshot) | वही + ज़्यादा tracking state |

एक लंबा Repeatable Read या Serializable transaction अपनी पूरी अवधि तक एक पुराना snapshot ज़िंदा रखता है, जिससे VACUUM नई dead rows साफ़ नहीं कर पाता। इन्हें छोटा रखें।

## 9. किस काम के लिए कौन सा level

| Use case | Level | क्यों |
|---|---|---|
| आम CRUD, single-row atomic updates (`stock = stock - 1 WHERE stock > 0`) | Read Committed | Atomic statements पहले से safe हैं; सबसे कम overhead |
| App code में एक row पर read-modify-write | Read Committed + `SELECT ... FOR UPDATE`, या Repeatable Read + retry | Lost updates रोकता है |
| Reports, exports, totals जिनका जोड़ मिलना चाहिए | Repeatable Read (read only) | कई queries में एक consistent snapshot |
| कई rows पर फैले नियम: एक cart में एक coupon, delivery slot की double-booking नहीं, accounts में balance | Serializable + retry (या constraint / parent-row lock) | अकेला level जो write skew को अपने-आप रोकता है |
| लंबी चलने वाली report जो serializable होनी चाहिए | `SERIALIZABLE, READ ONLY, DEFERRABLE` | कभी abort नहीं होती |
| Bulk ETL / batch jobs | Read Committed | बड़े batches के abort होने से बचें |

## 10. Gotchas

- **"मैंने level बढ़ा दिया, तो मैं safe हूँ।"** Retry loop के बिना नहीं। और Repeatable Read अब भी write skew होने देता है।
- **ये मान लेना कि Read Committed wait के बाद आपकी query दोबारा चलाता है।** वो सिर्फ़ पहले से मिली rows दोबारा check करता है (section 3)।
- **MySQL से अलग व्यवहार।** MySQL InnoDB (default Repeatable Read) में plain `SELECT`s snapshot पढ़ते हैं, पर `UPDATE` और locking reads error देने की जगह **latest committed** row पर काम करते हैं, इसलिए PostgreSQL के Repeatable Read में जो lost-update protection मिलता है, वो वहाँ default रूप से नहीं है।
- **Levels मिलाना**: SSI सिर्फ़ उन्हीं transactions को protect करता है जो खुद Serializable हैं।
- **सिर्फ़ fail हुए statement को retry करना।** `40001` के बाद transaction abort हो चुका होता है; आपको `ROLLBACK` करके सब कुछ दोबारा करना होगा, उन reads समेत जिनसे आपका फ़ैसला बना था।
- **Sequences transactional नहीं हैं।** Rolled-back या retry हुआ transaction भी `nextval()` numbers खा जाता है, इसलिए order ids में gaps की उम्मीद रखें।

## 11. Confuse न हों: standard vs PostgreSQL vs दूसरे

| Level | SQL standard क्या allow करता है | PostgreSQL असल में | MySQL InnoDB | MongoDB transactions |
|---|---|---|---|---|
| Read Uncommitted | Dirty reads | Read Committed जैसा ही | असली dirty reads | n/a |
| Read Committed | Non-repeatable, phantoms | हर statement का snapshot | हर statement का snapshot | n/a |
| Repeatable Read | Phantoms | Snapshot isolation, कोई phantoms नहीं, same-row conflict पर error | Default; snapshot reads, locking "current reads" | n/a |
| Serializable | कुछ नहीं | SSI, 40001 के साथ aborts | Plain reads shared-locking reads बन जाते हैं | n/a |
| Snapshot | n/a | (= Repeatable Read) | n/a | Snapshot reads, write conflict पर abort (retry) |

MongoDB की तरफ़ के लिए देखें [MongoDB transactions](/lessons/mongodb-transactions)।

## 12. कब ऊँचे level की तरफ़ न जाएँ

- **एक statement से काम हो जाए।** Conditional `UPDATE ... WHERE stock >= 2` या `INSERT ... ON CONFLICT DO NOTHING` किसी भी isolation level से बेहतर है।
- **Constraint से नियम encode हो सके।** `UNIQUE`, `CHECK`, exclusion constraints (overlapping time slots के लिए `EXCLUDE USING gist`) हर code path के लिए enforce होते हैं और कभी retries नहीं माँगते।
- **Hot path पर बहुत ज़्यादा contention हो।** एक ही flash-sale product पर हज़ारों Serializable transactions ज़्यादातर abort और retry होंगे। वहाँ एक single atomic statement इस्तेमाल करें।
- **आप काम को idempotent नहीं बना सकते।** अगर retry से card पर दो बार charge हो जाए, तो ढाँचा बदलें: पहले database transaction करें और external call बाद में (outbox pattern)।

> **याद रखें:** Read Committed + atomic statements + constraints एक e-commerce app का ज़्यादातर हिस्सा संभाल लेते हैं। Serializable सोच-समझकर इस्तेमाल करें, cross-row नियमों वाले गिने-चुने transactions के लिए, और हमेशा retries के साथ।
