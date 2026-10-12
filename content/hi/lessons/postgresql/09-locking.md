---
slug: postgres-locking
title: 'PostgreSQL में locking: row locks, table locks और वो migration जिसने site गिरा दी'
module: Transactions
summary: 'चार row-level lock modes, NOWAIT और SKIP LOCKED वाली job queues, practice में मायने रखने वाले table lock modes, एक मासूम सा ALTER TABLE outage कैसे करवाता है, safe migration patterns, deadlocks, advisory locks और कौन किसे block कर रहा है ये कैसे देखें।'
recap: >-
  MVCC reads और writes को साथ चलने देता है, पर एक ही row पर लिखने वाले writers और schema changes को अब भी locks चाहिए।
  Row locks चार ताक़तों में आते हैं; plain UPDATE FOR NO KEY UPDATE लेता है ताकि foreign key checks चलते रहें, और SKIP
  LOCKED एक table को job queue बना देता है। Table locks ज़्यादातर दिखते ही नहीं, जब तक कोई DDL statement ACCESS EXCLUSIVE
  न माँगे और किसी लंबी query के पीछे queue में न लग जाए, जिससे उसके पीछे सब block हो जाते हैं, इसलिए migrations को
  lock_timeout, retries और CREATE INDEX CONCURRENTLY और NOT VALID constraints जैसे online patterns के साथ चलाएँ।
  Blockers को pg_blocking_pids से ढूँढें।
---

## 1. कहानी

एक hotel renovation के दौरान भी खुला रहता है।

- हर **room key** से एक guest एक room बदल सकता है। दो guests एक ही room को एक साथ नहीं सजा सकते, पर अलग-अलग rooms में कोई दिक्कत नहीं। ये हैं **row locks**।
- कुछ काम के लिए **पूरा floor** चाहिए: corridor की tiles बदलना। एक board लग जाता है: "floor बंद है"। ये है **table lock**।
- Lift पर **एक ही queue** है। अगर tiling crew किसी धीमे guest के निकलने का इंतज़ार कर रही है, तो crew के *बाद* आने वाला हर guest crew के पीछे wait करता है, भले ही उसे बस वहाँ से गुज़रना हो। ये है **lock queue**, और इसी तरह 2-millisecond का `ALTER TABLE` एक website गिरा देता है।
- Manager के whiteboard पर लिखा "एक बार में सिर्फ़ एक night audit" किसी room के बारे में है ही नहीं। ये है **advisory lock**।

| Hotel | PostgreSQL |
|---|---|
| Room key | **Row-level lock** (`FOR UPDATE` और उसके साथी) |
| "Floor बंद है" वाला board | **Table-level lock** (जैसे `ACCESS EXCLUSIVE`) |
| Lift पर एक queue | हर table की **lock wait queue** |
| Whiteboard का नियम | **Advisory lock** |
| दो guests, हर एक के पास वो key जो दूसरे को चाहिए | **Deadlock** |

Pessimistic vs optimistic locking जैसी basics [Concurrency और locking](/lessons/concurrency-and-locking) में हैं। यहाँ हम PostgreSQL के अंदर गहराई में जाते हैं।

## 2. MVCC के साथ भी locks क्यों हैं

[MVCC](/lessons/postgres-mvcc-and-vacuum) **read vs write** को हल करता है: readers एक snapshot देखते हैं और कभी wait नहीं करते। Locks फिर भी इनके लिए चाहिए:

- **एक ही row पर write vs write**: दो checkouts एक ही stock घटा रहे हैं।
- **Schema vs बाकी सब कुछ**: जब कोई query किसी column को पढ़ रही हो, आप उसे drop नहीं कर सकते।
- **App-level mutual exclusion**: "एक बार में सिर्फ़ एक invoice job"।

## 3. Row-level locks: चार ताक़तें

| Lock | कौन लेता है | किसे block करता है |
|---|---|---|
| **`FOR UPDATE`** | `SELECT ... FOR UPDATE`, `DELETE`, key column बदलने वाला `UPDATE` | हर दूसरा row lock |
| **`FOR NO KEY UPDATE`** | Key columns न बदलने वाला plain `UPDATE`, `SELECT ... FOR NO KEY UPDATE` | `FOR KEY SHARE` को छोड़कर सब |
| **`FOR SHARE`** | `SELECT ... FOR SHARE` | `FOR NO KEY UPDATE`, `FOR UPDATE` |
| **`FOR KEY SHARE`** | Parent row पर foreign key checks, `SELECT ... FOR KEY SHARE` | सिर्फ़ `FOR UPDATE` |

यहाँ "key column" का मतलब, जैसा आज docs define करते हैं, ऐसा column है जिस पर **foreign key के काम आ सकने वाला unique index** हो (यानी partial या expression indexes नहीं), और value **सच में बदलनी** चाहिए।

### ये क्यों मायने रखता है: foreign keys

जब आप customer 5 के लिए order insert करते हैं, तो PostgreSQL check करता है कि customer मौजूद है और उस customer row पर **`FOR KEY SHARE`** लेता है ताकि insert के बीच में वो delete न हो सके। एक scratch database में verified, जहाँ session A customer 5 पर lock रखे हुए है और session B उस customer के लिए order insert कर रहा है:

| Session A (uncommitted) | A के पास कौन सा lock | B का `INSERT INTO orders` |
|---|---|---|
| `UPDATE customers SET country = 'IN' WHERE id = 5` | `FOR NO KEY UPDATE` | ✅ तुरंत |
| `UPDATE customers SET email = email WHERE id = 5` | `FOR NO KEY UPDATE` (value नहीं बदली) | ✅ तुरंत |
| `UPDATE customers SET email = 'new5@shop.test' WHERE id = 5` | `FOR UPDATE` (`email` पर unique index है) | ⏳ ~2 s wait किया |
| `SELECT ... WHERE id = 5 FOR UPDATE` | `FOR UPDATE` | ⏳ ~2 s wait किया |
| `DELETE FROM customers WHERE id = 5` | `FOR UPDATE` | ⏳ ~2 s wait किया |

दो सबक: जब आप parent row को सिर्फ़ non-key columns बदलने के लिए lock करें, तो `FOR UPDATE` की जगह `FOR NO KEY UPDATE` इस्तेमाल करें; और किसी uniquely-indexed column (जैसे email) को बदलने से child rows के inserts block हो जाते हैं, भले ही foreign key `id` की ओर point करती हो।

Row locks **tuple में ही** store होते हैं (`xmax` में), shared memory में नहीं, इसलिए दस लाख rows lock करने से कुछ ख़त्म नहीं होता। Wait कर रहा session `pg_locks` में दूसरे **transaction ID** पर wait करता दिखता है, इसीलिए deadlock messages कहते हैं "waits for ShareLock on transaction 1999"।

> **याद रखें:** plain UPDATE `FOR NO KEY UPDATE` लेता है, इसलिए वो foreign key checks को block नहीं करता। `FOR UPDATE` करता है। उतना ही मज़बूत lock लें जितना ज़रूरी हो।

## 4. NOWAIT और SKIP LOCKED: job queue बनाइए

Default रूप से row lock request **wait** करती है। दो modifiers ये बदलते हैं:

- **`NOWAIT`**: तुरंत fail: `ERROR: could not obtain lock on row in relation "jobs"`।
- **`SKIP LOCKED`**: जिन rows को किसी और ने lock किया है, उन्हें चुपचाप छोड़ दो।

`SKIP LOCKED` एक साधारण table को safe, concurrent **job queue** बना देता है (invoices भेजना, product images resize करना):

```sql
CREATE TABLE jobs (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind     text NOT NULL,
  payload  jsonb NOT NULL,
  status   text NOT NULL DEFAULT 'queued',
  run_at   timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0
);
CREATE INDEX jobs_queued_idx ON jobs (run_at) WHERE status = 'queued';

-- Each worker claims one job atomically
UPDATE jobs
SET status = 'running', attempts = attempts + 1
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'queued' AND run_at <= now()
  ORDER BY run_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, kind, payload;
```

दो workers के साथ verified: worker 1 ने job 1 lock करके पकड़े रखा; worker 2 की वही query wait करने की जगह **तुरंत job 2** लौटा दी।

```text
 Worker 1                      Worker 2
 ───────────────────────────   ───────────────────────────
 lock job 1 ✓
                               job 1 locked → skip
                               lock job 2 ✓
 process, mark done            process, mark done
```

Design का चुनाव: या तो **processing के दौरान lock पकड़े रखें** (`SELECT ... FOR UPDATE SKIP LOCKED` एक ऐसे transaction के अंदर जो उसे done भी mark करे; crash होने पर lock अपने-आप छूट जाता है, पर processing के दौरान transaction खुला रहता है), या ऊपर जैसा **claim करके commit** करें, फिर दूसरे transaction में process करके done mark करें (छोटे transactions, पर crash हुए workers के jobs दोबारा queue करने के लिए आपको timeout चाहिए)।

> **याद रखें:** `FOR UPDATE SKIP LOCKED LIMIT 1` = "मुझे कोई भी ऐसा job दो जिस पर कोई और काम नहीं कर रहा"। ये PostgreSQL का standard job-queue pattern है।

## 5. Table-level locks: जो मायने रखते हैं

हर statement एक table lock लेता है, ज़्यादातर बेनुकसान वाले। `pg_locks` में verified:

| Mode | कौन लेता है | किससे टकराता है (practically) |
|---|---|---|
| **`ACCESS SHARE`** | `SELECT` | सिर्फ़ `ACCESS EXCLUSIVE` |
| `ROW SHARE` | `SELECT ... FOR UPDATE/SHARE` | `EXCLUSIVE`, `ACCESS EXCLUSIVE` |
| **`ROW EXCLUSIVE`** | `INSERT`, `UPDATE`, `DELETE`, `MERGE` | `SHARE` और उससे मज़बूत |
| `SHARE UPDATE EXCLUSIVE` | `VACUUM`, `ANALYZE`, `CREATE INDEX CONCURRENTLY`, `VALIDATE CONSTRAINT` | खुद से और उससे मज़बूत से (reads या writes से नहीं) |
| **`SHARE`** | `CREATE INDEX` (non-concurrent) | Writes (`ROW EXCLUSIVE`); reads चलते रहते हैं |
| **`ACCESS EXCLUSIVE`** | ज़्यादातर `ALTER TABLE`, `DROP`, `TRUNCATE`, `VACUUM FULL`, `CLUSTER`, `REFRESH MATERIALIZED VIEW` (non-concurrent) | **सब कुछ**, plain `SELECT` समेत |

```text
          SELECT   UPDATE   CREATE INDEX   ALTER TABLE
 SELECT     ✓        ✓          ✓              ✗
 UPDATE     ✓        ✓*         ✗              ✗
 CREATE IDX ✓        ✗          ✓              ✗
 ALTER      ✗        ✗          ✗              ✗
 (* table level is fine; same ROW still waits)
```

## 6. Outage का pattern: lock queue में ALTER TABLE

एक developer ऐसा migration चलाता है जिसमें milliseconds लगने चाहिए: `ALTER TABLE products ADD COLUMN badge text`। इस बीच एक reporting query मिनटों से `products` पढ़ रही है।

एक scratch database में reproduce किया गया: एक "report" transaction `products` पर `ACCESS SHARE` पकड़े हुए है, एक "migration" `ALTER TABLE` चलाता है, और फिर एक "checkout" एक मामूली `SELECT` चलाता है। एक चौथे session ने locks देखे:

```sql
SELECT a.pid, a.application_name AS app, l.mode, l.granted,
       pg_blocking_pids(a.pid) AS blocked_by
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = 'products'::regclass;
```

```text
  pid  |    app    |        mode         | granted | blocked_by
-------+-----------+---------------------+---------+------------
 22804 | report    | AccessShareLock     | t       | {}
 21052 | checkout  | AccessShareLock     | f       | {22884}
 22884 | migration | AccessExclusiveLock | f       | {22804}
```

Checkout वाला `SELECT` report से बिल्कुल नहीं टकराता। वो **wait कर रहे migration से** blocked है: एक नई lock request पहले से wait कर रही conflicting request के पीछे queue में लग जाती है। अब हर checkout request जमा होती जाती है, connections ख़त्म हो जाते हैं, site down हो जाती है, और ALTER खुद अभी शुरू भी नहीं हुआ।

```text
 report (ACCESS SHARE, granted, running for minutes)
   ▲
   └── migration waits (ACCESS EXCLUSIVE)
          ▲
          ├── checkout SELECT waits
          ├── checkout SELECT waits
          └── ... every query on products waits
```

**Fix: DDL को कभी देर तक wait न करने दें।**

```sql
SET lock_timeout = '2s';
ALTER TABLE products ADD COLUMN badge text;
-- ERROR:  canceling statement due to lock timeout   (verified)
```

अगर 2 seconds में lock नहीं मिलता, तो migration हार मान लेता है, queue खाली हो जाती है, और आपका migration tool थोड़ी देर बाद **retry** करता है। Deploy करने से पहले `pg_stat_activity` में लंबे transactions भी check करें।

> **याद रखें:** `ACCESS EXCLUSIVE` के लिए wait कर रहा कोई भी statement उस table पर बाद में आने वाली हर query को block कर देता है। Migrations हमेशा `lock_timeout` और retry के साथ चलाएँ।

## 7. Safe migration patterns

| Change | ख़तरनाक तरीका | Safe तरीका |
|---|---|---|
| Index जोड़ना | `CREATE INDEX` (पूरे build के दौरान writes block करता है) | `CREATE INDEX CONCURRENTLY` (transaction के अंदर नहीं चल सकता; धीमा; fail होने पर एक `INVALID` index छोड़ देता है जिसे drop करके retry करना होता है) |
| Default वाला column जोड़ना | `gen_random_uuid()` जैसा volatile default table को दोबारा लिखता है | PostgreSQL 11 से **constant** default सिर्फ़ metadata का change है |
| `NOT NULL` जोड़ना | `SET NOT NULL` `ACCESS EXCLUSIVE` के तहत table scan करता है | `ADD CONSTRAINT ... CHECK (col IS NOT NULL) NOT VALID`, फिर `VALIDATE CONSTRAINT`, फिर `SET NOT NULL` (scan छोड़ देता है) |
| Foreign key / check जोड़ना | `ADD CONSTRAINT` मज़बूत lock के तहत हर row validate करता है | इसे `NOT VALID` जोड़ें (नई rows तुरंत check होती हैं), फिर अलग से `VALIDATE CONSTRAINT` |
| Column का type बदलना | `ALTER COLUMN TYPE` अक्सर table दोबारा लिखता है | नया column जोड़ें, batches में backfill करें, reads switch करें, पुराना drop करें |

500,000-row वाली `orders` table पर असली timings:

```text
ADD COLUMN channel text NOT NULL DEFAULT 'web'      5 ms
ADD COLUMN ref uuid DEFAULT gen_random_uuid()    2973 ms (rewrite)
SET NOT NULL after a validated CHECK constraint     3 ms
```

```sql
ALTER TABLE orders ADD CONSTRAINT orders_coupon_nn
  CHECK (coupon_code IS NOT NULL) NOT VALID;           -- instant, brief lock
ALTER TABLE orders VALIDATE CONSTRAINT orders_coupon_nn; -- scans, but only
                                                         -- SHARE UPDATE EXCLUSIVE
ALTER TABLE orders ALTER COLUMN coupon_code SET NOT NULL; -- uses the check, no scan
ALTER TABLE orders DROP CONSTRAINT orders_coupon_nn;
```

`pg_locks` में `VALIDATE CONSTRAINT` ने table पर सिर्फ़ `ShareUpdateExclusiveLock` लिया, इसलिए scan के दौरान reads और writes चलते रहे।

## 8. Deadlocks

Asha का cart पहले product 10 और फिर 20 lock करता है; Ravi का पहले 20 और फिर 10। एक scratch database की असली error:

```text
ERROR:  deadlock detected
DETAIL:  Process 6404 waits for ShareLock on transaction 1999;
         blocked by process 22316.
         Process 22316 waits for ShareLock on transaction 1998;
         blocked by process 6404.
HINT:  See server log for query details.
CONTEXT:  while updating tuple (0,20) in relation "products"
```

- जो session **`deadlock_timeout`** (default 1 s) तक wait कर चुका है, वो deadlock check चलाता है। अगर उसे cycle मिलती है, तो एक transaction SQLSTATE `40P01` के साथ abort होता है; दूसरा चलता रहता है।
- बचाव: **एक consistent order में lock करें**। Cart के लिए, सारे products एक ही statement में id से sorted करके lock करें:

```sql
SELECT id FROM products
WHERE id = ANY($1)
ORDER BY id
FOR UPDATE;
```

- Transactions छोटे रखें और `40P01` को serialization failure की तरह **retry** करें।

## 9. Advisory locks: आपकी app के लिए mutual exclusion

कभी-कभी आपको row पर नहीं, किसी **idea** पर lock चाहिए: "nightly invoice job का सिर्फ़ एक instance", "सिर्फ़ एक process search index दोबारा बनाए"। जब तीन Node.js replicas एक ही cron चला रहे हों, तो **advisory lock** एक winner चुनता है।

```sql
BEGIN;
SELECT pg_try_advisory_xact_lock(hashtext('nightly-invoice-job')) AS got_it;
-- got_it = false → another instance is running, just COMMIT and exit
-- got_it = true  → do the work
COMMIT;  -- xact-level lock released automatically
```

दो sessions के साथ verified: पहले को `true` मिला, दूसरे को `false` मिला जब तक पहला खुला था।

| Function | Scope | Wait करता है? |
|---|---|---|
| `pg_advisory_xact_lock(key)` | Transaction ख़त्म होने तक | हाँ |
| `pg_try_advisory_xact_lock(key)` | Transaction ख़त्म होने तक | नहीं, boolean लौटाता है |
| `pg_advisory_lock(key)` / `pg_advisory_unlock(key)` | Unlock होने या session ख़त्म होने तक | हाँ |

**Transaction-level** versions को प्राथमिकता दें: वो leak नहीं हो सकते। PgBouncer जैसे transaction-mode pooler के पीछे session-level locks ख़तरनाक हैं, क्योंकि आपकी अगली query किसी दूसरे server connection पर चल सकती है; देखें [Connection pooling](/lessons/postgres-connection-pooling)। Key एक `bigint` (या दो `int`) होती है; किसी नाम से key बनाने के लिए `hashtext()` एक आसान तरीका है, collisions के बहुत छोटे जोखिम के साथ।

> **याद रखें:** advisory locks PostgreSQL के अंदर नाम वाले mutexes हैं। `pg_try_advisory_xact_lock` इस्तेमाल करें ताकि crash हुआ worker कभी lock पीछे न छोड़ सके।

## 10. कौन किसे block कर रहा है?

```sql
SELECT a.pid,
       a.application_name,
       a.state,
       now() - a.xact_start      AS xact_age,
       pg_blocking_pids(a.pid)   AS blocked_by,
       left(a.query, 60)         AS query
FROM pg_stat_activity a
WHERE cardinality(pg_blocking_pids(a.pid)) > 0
   OR a.pid IN (SELECT unnest(pg_blocking_pids(pid)) FROM pg_stat_activity);
```

फिर तय करें: `SELECT pg_cancel_backend(pid)` मौजूदा query cancel करता है; `SELECT pg_terminate_backend(pid)` पूरा session ख़त्म कर देता है (`idle in transaction` के लिए यही चाहिए)।

### Lock के ढेर लगने से रोकने वाले timeouts

| Setting | क्या रोकता है | आम value |
|---|---|---|
| `lock_timeout` | किसी भी lock के लिए बहुत देर तक wait करना | Migrations के लिए `2s`–`5s` |
| `statement_timeout` | बहुत देर तक चलने वाला कोई भी statement | Web app role के लिए `5s`–`30s` |
| `idle_in_transaction_session_timeout` | ऐसे sessions जो `BEGIN` करके कुछ नहीं करते, और locks पकड़े रहते हैं | `30s`–`60s` |
| `transaction_timeout` (PostgreSQL 17+) | बहुत देर तक चलने वाले पूरे transactions | सावधानी से इस्तेमाल करें |

```sql
ALTER ROLE shop_web SET statement_timeout = '10s';
ALTER ROLE shop_web SET idle_in_transaction_session_timeout = '30s';
```

## 11. Gotchas

- **`lock_timeout` के बिना DDL चलाना।** खुद का बुलाया हुआ classic outage।
- **Migration transaction के अंदर `CREATE INDEX CONCURRENTLY`।** ये error देता है (`cannot run inside a transaction block`)। कई migration tools हर file को transaction में लपेट देते हैं; इस file के लिए उसे बंद करें।
- **Fail हुए concurrent build के बाद `INVALID` index को नज़रअंदाज़ करना।** ये writes को धीमा करता है और reads के लिए इस्तेमाल नहीं होता। Drop करके retry करें।
- **जहाँ `FOR NO KEY UPDATE` काफ़ी हो वहाँ `FOR UPDATE`**, जिससे child tables पर foreign-key inserts को wait करना पड़ता है।
- **HTTP calls के दौरान row locks पकड़े रखना।** उस product का हर दूसरा buyer payment gateway का इंतज़ार करता है।
- **Transaction mode में PgBouncer के साथ session advisory locks।**
- **बिना index वाली foreign keys।** Customer को delete करते समय child orders ढूँढने पड़ते हैं; `orders.customer_id` पर index के बिना वो check locks पकड़े हुए पूरी table scan करता है।

## 12. Confuse न हों: तीन तरह के locks

| | Row locks | Table locks | Advisory locks |
|---|---|---|---|
| क्या protect करता है | अलग-अलग rows | Table structure / पूरी table वाले operations | जो भी आपकी app तय करे |
| कब लिया जाता है | Writes से अपने-आप, या `FOR UPDATE` वग़ैरह से | हर statement से अपने-आप | सिर्फ़ जब आप functions call करें |
| कहाँ store होता है | Tuple में (`xmax`) | Shared memory lock table | Shared memory lock table |
| आम दर्द | Hot-row contention, deadlocks | सब कुछ block करती DDL queues | Leak हुए session locks |
| कहाँ दिखता है | `pg_locks` में transaction waits के रूप में | `pg_locks` (`relation`) | `pg_locks` (`locktype = 'advisory'`) |

## 13. Trade-offs

- **Pessimistic row locks** सरल और सही हैं, पर हर wait करने वाला latency जोड़ता है; बहुत hot rows पर एक single atomic `UPDATE ... WHERE stock >= n` lock को milliseconds की जगह microseconds के लिए पकड़ता है।
- **SKIP LOCKED queues** हज़ारों jobs per second तक बढ़िया हैं। उससे आगे, या जब आपको fan-out और replay चाहिए, तो एक dedicated broker (SQS, RabbitMQ, Kafka) बेहतर बैठता है।
- **Online migrations** (concurrent indexes, NOT VALID + VALIDATE, batched backfills) में ज़्यादा steps और ज़्यादा समय लगता है, पर आपके users को कभी पता नहीं चलता। यही सौदा करने लायक है।

> **याद रखें:** PostgreSQL के ज़्यादातर locking incidents rows के बारे में नहीं होते। वो या तो queue में wait करता कोई DDL statement होते हैं, या खुला छोड़ा गया कोई transaction। Timeouts दोनों को ठीक करते हैं।
