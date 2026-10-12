---
slug: postgres-mvcc-and-vacuum
title: 'MVCC और VACUUM: PostgreSQL कभी row को overwrite क्यों नहीं करता'
module: Internals
summary: 'PostgreSQL हर row के कई versions को xmin और xmax के साथ कैसे store करता है, snapshots कैसे तय करते हैं कि आपको क्या दिखेगा, इससे dead tuples क्यों बनते हैं, और VACUUM, autovacuum, HOT updates और freezing database को healthy कैसे रखते हैं।'
recap: >-
  PostgreSQL कभी row को उसी जगह update नहीं करता: UPDATE एक नया row version लिखता है और पुराने पर xmax mark कर देता है,
  और हर transaction का snapshot तय करता है कि उसे कौन सा version दिखेगा, इसलिए readers और writers एक-दूसरे को block नहीं
  करते। पुराने versions dead tuples बन जाते हैं जिन्हें VACUUM reusable space के रूप में mark करता है; VACUUM FULL table
  को दोबारा लिखता है पर उसे पूरी तरह lock कर देता है। Autovacuum ये अपने-आप करता है और साथ ही statistics refresh करता है
  और transaction ID wraparound से बचाने के लिए पुरानी rows को freeze करता है, इसलिए इसे कभी disable न करें और उन लंबी
  चलने वाली या idle-in-transaction sessions पर नज़र रखें जो cleanup को रोकती हैं।
---

## 1. कहानी

आपके store का **product catalogue** एक shared document है। उसे edit करने के दो तरीके सोचिए।

- **Whiteboard**: आप पुरानी price मिटाते हैं और नई लिख देते हैं। Edit के दौरान पढ़ने वाले को wait करना पड़ेगा, वरना उसे आधा मिटा हुआ text दिखेगा।
- **History वाला ledger**: आप कभी नहीं मिटाते। आप पुरानी line को "edit #1879 से बदली गई" note के साथ **काट देते** हैं और नीचे एक **नई line** लिखते हैं। जिसने आपके edit से पहले पढ़ना शुरू किया था, वो पुरानी line पढ़ता रहता है; नए लोग नई line पढ़ते हैं। किसी को wait नहीं करना पड़ता।

Ledger की एक समस्या है: ये कटी हुई lines से भर जाता है। इसलिए एक **clerk** नियमित रूप से आता है और उन lines को खाली कर देता है जिनकी **किसी reader को अब कभी ज़रूरत नहीं पड़ सकती**, ताकि नई entries उस जगह को दोबारा इस्तेमाल कर सकें।

| Ledger | PostgreSQL |
|---|---|
| Ledger की एक line | एक **tuple** (row का एक physical version) |
| "Edit #1877 ने लिखी" | **`xmin`**: वो transaction ID जिसने version बनाया |
| "Edit #1879 ने काटी" | **`xmax`**: वो transaction ID जिसने उसे delete या replace किया |
| Page पर line number | **`ctid`**: physical location `(page, item)` |
| कौन से edits एक reader देख सकता है | एक **snapshot** |
| कटी हुई lines जिनकी किसी को ज़रूरत नहीं | **Dead tuples** |
| Clerk | **VACUUM** / **autovacuum** |

यही है **MVCC** (multi-version concurrency control)।

> **याद रखें:** PostgreSQL में UPDATE असल में "एक नया version INSERT करो + पुराने को expired mark करो" है। कुछ भी उसी जगह overwrite नहीं होता।

## 2. MVCC क्यों है

Versions के बिना, एक ही row को छूने वाले reader और writer को बारी-बारी से काम करना पड़ता है (locks)। Versions के साथ:

- **Readers writers को block नहीं करते**, और **writers readers को block नहीं करते**। एक लंबी report checkout को नहीं रोकती।
- हर statement एक **consistent snapshot** देखता है, कभी आधा-अधूरा apply हुआ change नहीं।
- **Rollback मुफ़्त है**: abort हुए transaction के नए versions बस कभी दिखते ही नहीं। कोई undo काम नहीं चाहिए।

**एक ही row** पर लिखने वाले writers में अब भी conflict होता है (row locks; देखें [PostgreSQL locking](/lessons/postgres-locking))। MVCC की कीमत है **कचरा**: पुराने versions जमा होते जाते हैं और उन्हें साफ़ करना पड़ता है। Isolation की basics [ACID](/lessons/acid) में हैं; ये lesson अंदर की मशीनरी देखता है।

## 3. Versions को अपनी आँखों से देखना

हर table में छिपे हुए **system columns** होते हैं। एक scratch database का असली output:

```sql
CREATE TABLE inv (product_id int PRIMARY KEY, name text, stock int);
INSERT INTO inv VALUES (1,'Running shoes',10),(2,'Yoga mat',25),(3,'Water bottle',40);
SELECT xmin, xmax, ctid, * FROM inv;
```

```text
 xmin | xmax | ctid  | product_id |     name      | stock
------+------+-------+------------+---------------+-------
 1877 |    0 | (0,1) |          1 | Running shoes |    10
 1877 |    0 | (0,2) |          2 | Yoga mat      |    25
 1877 |    0 | (0,3) |          3 | Water bottle  |    40
```

तीनों rows transaction **1877** ने बनाईं। `xmax = 0` का मतलब है "delete नहीं हुई"। `ctid (0,1)` = page 0, item 1।

```sql
UPDATE inv SET stock = stock - 1 WHERE product_id = 1;
```

```text
 xmin | xmax | ctid  | product_id |     name      | stock
------+------+-------+------------+---------------+-------
 1879 |    0 | (0,4) |          1 | Running shoes |     9
```

Shoes वाली row का **नया `ctid` (0,4)** और नया `xmin` (1879) है। ये एकदम नया tuple है। `(0,1)` वाला पुराना tuple अब भी physically मौजूद है, `xmax = 1879` के साथ; बस वो आपको अब दिखता नहीं।

```sql
DELETE FROM inv WHERE product_id = 3;
```

Bottle results से गायब हो जाती है, पर उसका `(0,3)` वाला tuple `xmax` set होकर अब भी page पर है। Statistics इसकी पुष्टि करते हैं:

```text
 n_live_tup | n_dead_tup | n_tup_upd | n_tup_hot_upd | n_tup_del
------------+------------+-----------+---------------+-----------
          2 |          2 |         1 |             1 |         1
```

दो dead tuples: shoes का पुराना version और delete हुई bottle।

### एक uncommitted change, दूसरे session से देखा गया

Session A `BEGIN; UPDATE inv SET stock = stock - 1 WHERE product_id = 2;` चलाता है (transaction 1892) और अभी commit नहीं करता। Session B पढ़ता है:

```text
 xmin | xmax | ctid  | product_id |   name   | stock
------+------+-------+------------+----------+-------
 1877 | 1892 | (0,2) |          2 | Yoga mat |    25
```

B को अब भी **पुराना** version (25) दिखता है, पर उसका `xmax` पहले से 1892 बता रहा है। क्योंकि 1892 commit नहीं हुआ है, ये version B के लिए अब भी valid है। A के commit करने के बाद B को `xmin 1892, ctid (0,5), stock 24` दिखता है।

ध्यान दें: `xmax ≠ 0` का मतलब हमेशा delete नहीं होता। ये abort हुए delete से या `SELECT ... FOR UPDATE` जैसे row lock से भी set होता है।

सब कुछ commit होने के बाद page 0 में physically क्या है (`SELECT` dead tuples छिपा देता है, इसलिए ये एक sketch है, जिसमें delete transaction 1880 के रूप में चला):

```text
 page 0 of table inv
 ┌───────┬──────────────────────────────────────────────┐
 │ (0,1) │ shoes  10  xmin 1877  xmax 1879   ← dead     │
 │ (0,2) │ mat    25  xmin 1877  xmax 1892   ← dead     │
 │ (0,3) │ bottle 40  xmin 1877  xmax 1880   ← dead     │
 │ (0,4) │ shoes   9  xmin 1879  xmax 0      ← live     │
 │ (0,5) │ mat    24  xmin 1892  xmax 0      ← live     │
 └───────┴──────────────────────────────────────────────┘
```

## 4. Visibility snapshots तय करते हैं

एक **snapshot** ये record करता है: अभी चल रहा सबसे पुराना transaction, अगला assign होने वाला transaction ID, और चल रहे transactions की list। "क्या मेरा snapshot ये tuple देख सकता है?" का सरल नियम:

1. बनाने वाला (`xmin`) **commit हो चुका है** और मेरा snapshot लेते समय ही commit हो चुका था (या ये मेरा अपना transaction है), **और**
2. मिटाने वाला (`xmax`) खाली है, **या abort हुआ**, **या मेरे snapshot को अभी दिखता नहीं**।

Commit status एक छोटे structure में रहता है जिसे commit log (`pg_xact`) कहते हैं; PostgreSQL जवाब को tuple पर **hint bits** में cache कर लेता है ताकि बाद के readers को उसे दोबारा न ढूँढना पड़े।

Snapshot कब लिया जाता है, ये isolation level पर निर्भर करता है: Read Committed पर हर statement पर, Repeatable Read और Serializable पर हर transaction पर। देखें [Isolation levels](/lessons/postgres-isolation-levels)।

> **याद रखें:** हर tuple अपने साथ "xmin में जन्मा, xmax में मरा" लेकर चलता है। आपका snapshot इन IDs की तुलना उन transactions की list से करता है जिन्हें वो committed मानता है। पूरा जादू बस इतना ही है।

## 5. Dead tuples और bloat

**Dead tuple** ऐसा version है जिसे कोई चल रहा या आने वाला snapshot नहीं देख सकता। जब तक वो साफ़ न हो, वो disk space लेता रहता है और Seq Scans उसे पढ़ते हैं। **Bloat** का मतलब है एक table (या index) जो अपने live data से कहीं बड़ी हो।

असली demo: 100,000 products, फिर पूरी table पर दो stock updates, असर देखने के लिए इस table पर autovacuum disabled:

```text
 step                     size     n_live_tup  n_dead_tup
 ──────────────────────   ──────   ──────────  ──────────
 after INSERT             13 MB       100000           0
 after 2 x UPDATE all     40 MB       100000      200000
 after VACUUM             40 MB       100000           0
 after VACUUM FULL        13 MB       100000           0
```

दो बातें ध्यान देने लायक:

- हर row के हर UPDATE ने table को **तिगुना** कर दिया, क्योंकि हर एक ने 100,000 नए versions लिखे।
- **Plain VACUUM ने file को छोटा नहीं किया।** उसने space को आगे के inserts और updates के लिए **reusable** बनाया। सिर्फ़ VACUUM FULL ने space operating system को वापस दिया।

## 6. VACUUM vs VACUUM FULL vs autovacuum

| | `VACUUM` | `VACUUM FULL` | Autovacuum |
|---|---|---|---|
| क्या करता है | Dead tuples हटाता है, free space record करता है, visibility map update करता है, पुरानी rows freeze करता है | पूरी table और indexes को compact रूप में **दोबारा लिखता** है | हर table पर `VACUUM` / `ANALYZE` अपने-आप चलाता है |
| File छोटी करता है? | आमतौर पर नहीं (सिर्फ़ आख़िर के खाली pages) | हाँ | VACUUM जैसा |
| Lock | `SHARE UPDATE EXCLUSIVE`: reads और writes चलते रहते हैं | **`ACCESS EXCLUSIVE`**: कोई और पढ़ भी नहीं सकता | VACUUM जैसा, और अगर ये किसी को block करे तो **हट जाता** है (anti-wraparound runs को छोड़कर) |
| Disk चाहिए | कुछ extra नहीं | Table की एक पूरी copy | कुछ extra नहीं |
| कब | बड़े batch changes के बाद manually | कभी-कभार, maintenance window में | हमेशा on |

लंबे lock के बिना bloated table को छोटा करने के लिए teams VACUUM FULL की जगह `pg_repack` extension इस्तेमाल करती हैं।

### Autovacuum thresholds

Autovacuum किसी table को तब vacuum करता है जब:

```text
dead tuples > autovacuum_vacuum_threshold
              + autovacuum_vacuum_scale_factor × table rows
            = 50 + 0.2 × rows                  (defaults)
```

ये `ANALYZE` भी चलाता है जब बदली हुई rows `50 + 0.1 × rows` से ज़्यादा हो जाएँ, और PostgreSQL 13 से ये insert-only tables को भी vacuum करता है (ताकि वो freeze हों और उनका visibility map update हो)।

100-million-row वाली `orders` table पर 20% का मतलब है **20 million** dead tuples का इंतज़ार। बड़ी, busy tables को अलग-अलग tune करें:

```sql
ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.01,
                        autovacuum_analyze_scale_factor = 0.02);
```

आपको **autovacuum कभी disable क्यों नहीं करना चाहिए**: bloat हमेशा बढ़ता रहता है, statistics stale हो जाते हैं (bad plans), index-only scans काम करना बंद कर देते हैं, और आख़िरकार transaction ID wraparound वैसे भी emergency vacuum करवाता है (section 10)। अगर autovacuum "बहुत महँगा" लगता है, तो आमतौर पर वो बहुत *कम* चल रहा होता है, इसलिए हर run के पास बहुत ज़्यादा काम होता है। इसे ज़्यादा बार चलाएँ और इसे ज़्यादा I/O budget दें (`autovacuum_vacuum_cost_limit`)।

> **याद रखें:** VACUUM = dead space को reusable बनाओ, कोई blocking नहीं। VACUUM FULL = छोटा करो, पर table पूरी तरह lock होती है। Autovacuum = वो default जिसे आप tune करते हैं, कभी बंद नहीं करते।

## 7. HOT updates और fillfactor

आमतौर पर UPDATE को **हर index** में भी नए tuple की ओर point करने वाली entry जोड़नी पड़ती है, भले ही कोई indexed column न बदला हो। ये महँगा है।

**HOT (heap-only tuple) update** indexes को छोड़ देता है। शर्तें:

1. **कोई indexed column** न बदले, और
2. नया version पुराने वाले के **उसी page पर समा जाए**।

Index पुराने tuple की ओर point करता रहता है, जो page के अंदर नए tuple से link होता है। पुराने HOT versions को VACUUM का इंतज़ार किए बिना, सामान्य reads और writes के दौरान **page pruning** से भी साफ़ किया जा सकता है।

Default रूप से tables 100% भरी जाती हैं, जिससे शर्त 2 के लिए कोई जगह नहीं बचती। `fillfactor` जगह reserve करता है:

```sql
CREATE TABLE inv_hot (product_id int PRIMARY KEY, stock int, note text)
WITH (fillfactor = 80);
```

असली नतीजा: अभी-अभी insert हुई 10,000 में से 5,000 rows पर `stock` update करने से `n_tup_upd = 5000`, `n_tup_hot_upd = 1308` मिला। हर page पर पहले updates reserve किए गए 20% में समा गए; page भरते ही बाकी normal updates बन गए। असली update-heavy table पर pruning और VACUUM page के अंदर जगह खाली करते रहते हैं, इसलिए HOT ratio आमतौर पर कहीं ज़्यादा होता है।

Practical tips: लगातार बदलने वाले columns (जैसे `stock` या `last_seen_at`) को index न करें, जब तक आप उनसे query न करते हों, और update-heavy tables के लिए `fillfactor` 70–90 पर विचार करें। `pg_stat_user_tables` में `n_tup_hot_upd / n_tup_upd` पर नज़र रखें।

## 8. Visibility map और free space map

हर table के साथ दो छोटी helper files होती हैं:

- **Visibility map (VM)**: हर page के लिए दो bits: **all-visible** (हर tuple सबको दिखता है) और **all-frozen**। **Index-only scans** इसका इस्तेमाल all-visible pages के लिए table को skip करने में करते हैं, और VACUUM इससे उन pages को skip करता है जिन पर कोई काम नहीं चाहिए। [EXPLAIN lesson](/lessons/postgres-explain) में, एक un-vacuumed `order_items` table ने ठीक इसी वजह से Index Only Scan पर `Heap Fetches: 999900` दिखाया था।
- **Free space map (FSM)**: हर page में कितनी खाली जगह है, ताकि inserts और non-HOT updates file बढ़ाने की जगह VACUUM की खाली की हुई जगह दोबारा इस्तेमाल कर सकें।

दोनों को VACUUM maintain करता है, और ये एक और वजह है कि autovacuum उन tables के लिए भी ज़रूरी है जिनमें deletes कम ही होते हैं।

## 9. लंबे transactions: जो कोई पढ़ सकता है, उसे clerk साफ़ नहीं कर सकता

VACUUM किसी dead tuple को तभी हटा सकता है जब **कहीं भी कोई snapshot** उसकी ज़रूरत न रखता हो। एक पुराना snapshot **पूरे database** का cleanup रोक देता है, सिर्फ़ उन tables का नहीं जिन्हें उसने छुआ।

असली demo: एक Repeatable Read transaction अपने snapshot के साथ idle पड़ा रहा, जबकि दूसरे session ने 1,000 rows update कीं और VACUUM चलाया:

```text
tuples: 3988 removed, 11000 remain, 1000 are dead but not yet removable
```

वो 1,000 versions रहने ही चाहिए क्योंकि पुराना snapshot अब भी उन्हें पढ़ सकता था। आम दोषी:

- एक session जो **`idle in transaction`** है: app ने `BEGIN`, एक query चलाई, फिर किसी HTTP call पर wait करने लगा या commit करना भूल गया।
- Primary पर कई घंटे चलने वाली analytics query या `pg_dump`।
- एक छोड़ा हुआ **replication slot**, या लंबी queries चला रहे replica से `hot_standby_feedback`।
- एक भूला हुआ prepared transaction (`PREPARE TRANSACTION`)।

उन्हें ढूँढें:

```sql
SELECT pid, state, now() - xact_start AS xact_age, backend_xmin, left(query, 50)
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY xact_start;
```

`idle_in_transaction_session_timeout` (जैसे `'60s'`) से बचाव करें, जो transaction के अंदर idle पड़ी sessions को terminate कर देता है।

> **याद रखें:** एक भी भूला हुआ open transaction database की हर table में bloat ला देता है। `idle in transaction` और सबसे पुराने `xact_start` पर नज़र रखें।

## 10. Transaction ID wraparound और freezing

Transaction IDs **32-bit** होते हैं: लगभग 4.2 billion values। PostgreSQL उनकी तुलना **एक गोले में** करता है: किसी भी transaction के लिए, लगभग 2 billion IDs "अतीत में" और 2 billion "भविष्य में" होते हैं। एक busy store कुछ सालों में billions IDs खर्च कर सकता है।

खतरा: transaction 100 की लिखी row, लगभग 2 billion और transactions के बाद, अचानक ऐसी दिखेगी जैसे वो **भविष्य में** लिखी गई हो, इसलिए वो invisible हो जाएगी। Data delete नहीं होगा, पर queries से गायब हो जाएगा।

इसका इलाज है **freezing**: VACUUM उन tuples को **frozen** mark करता है जो इतने पुराने हैं कि सबको दिखते हैं, यानी "किसी भी transaction से पुराने, हमेशा visible", इसलिए उनका `xmin` अब मायने नहीं रखता।

- हर table `relfrozenxid` track करती है, यानी सबसे पुराना unfrozen XID जो उसमें हो सकता है। `age(relfrozenxid)` बताता है कि वो कितना पीछे है।
- जब ये age **`autovacuum_freeze_max_age`** (default 200 million) से आगे जाती है, तो autovacuum उस table पर एक **anti-wraparound vacuum** शुरू करता है, **भले ही autovacuum disabled हो**, और ये दूसरे lock requests के लिए हटता नहीं।
- अगर freezing फिर भी पीछे रह जाए, तो PostgreSQL **warnings** देना शुरू करता है, और limit के क़रीब पहुँचकर vacuum पूरा होने तक **नए transaction IDs देने से मना कर देता है** (और writes नहीं)। ये असली outage है।

```sql
SELECT datname, age(datfrozenxid) FROM pg_database;
SELECT relname, age(relfrozenxid) FROM pg_class
WHERE relkind = 'r' ORDER BY 2 DESC LIMIT 10;
```

Age के 2 billion के क़रीब पहुँचने से काफ़ी पहले alert लगाएँ। Freezing को रोकने वाली चीज़ें वही हैं जो section 9 में हैं: लंबे transactions, अटके हुए replication slots, और disabled या बहुत ज़्यादा throttled autovacuum।

## 11. Monitoring checklist

```sql
SELECT relname,
       n_live_tup,
       n_dead_tup,
       round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       n_tup_hot_upd,
       last_vacuum,
       last_autovacuum,
       last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;
```

| लक्षण | संभावित वजह |
|---|---|
| `n_dead_tup` बढ़ता जा रहा है, `last_autovacuum` पुराना है | बड़ी table के लिए thresholds बहुत ऊँचे, या autovacuum throttled |
| VACUUM चलता है पर "dead but not yet removable" | लंबी या idle-in-transaction session, replication slot |
| Row count स्थिर है पर table size बढ़ रहा है | Bloat: updates vacuum से आगे निकल रहे हैं |
| `age(datfrozenxid)` सैकड़ों millions की ओर चढ़ रहा है | Freezing blocked है; अभी जाँच करें |
| बहुत सारे heap fetches वाले index-only scans | Visibility map maintain नहीं हो रहा |

## 12. Gotchas

- **"VACUUM मेरी table छोटी कर देगा।"** आमतौर पर नहीं करेगा। ये space को reusable बनाता है।
- **Live production table पर VACUUM FULL चलाना।** ये पूरे rewrite के दौरान `ACCESS EXCLUSIVE` lock लेता है: `SELECT`s को भी wait करना पड़ता है।
- **हर row को "बस छूने के लिए" update करना** (जैसे `UPDATE orders SET updated_at = now()`) table को दोगुना कर देता है। बड़े backfills को batches में करें और batches के बीच vacuum को साथ आने दें।
- **`count(*)` slow है**, आंशिक रूप से MVCC की वजह से: visibility हर snapshot के लिए अलग है, इसलिए PostgreSQL एक global row counter नहीं रख सकता। Estimate के लिए `reltuples` इस्तेमाल करें।
- **Bulk load के लिए autovacuum disable करना** और उसे दोबारा enable करना भूल जाना।
- **ये सोचना कि deletes तुरंत space खाली करते हैं।** 10 million rows का `DELETE` 10 million dead tuples बनाता है; space vacuum के बाद ही reusable होता है।

## 13. Confuse न हों: पुराने versions रखने के तीन तरीके

| | PostgreSQL | MySQL InnoDB | MongoDB (WiredTiger) |
|---|---|---|---|
| पुराने versions कहाँ रहते हैं | **Table में ही** (heap) | एक अलग **undo log** में | In-memory update chains; पुराने versions एक history store file में spill होते हैं |
| UPDATE क्या लिखता है | एक नया पूरा row version | Row **उसी जगह** + एक undo record | Cache में एक नया version |
| Cleanup | **VACUUM** / autovacuum | **Purge** threads undo log को छोटा करते हैं | पुराने snapshots ख़त्म होते ही अपने-आप |
| लंबे transactions से होता है | Table और index **bloat** | Undo log ("history list") का बढ़ना, धीमे reads | Cache pressure; transactions default रूप से 60 s तक सीमित हैं |
| Rollback की कीमत | मुफ़्त (versions बस invisible रहते हैं) | Undo log apply करना पड़ता है | Uncommitted updates फेंक दो |

## 14. Trade-offs

- **MVCC की जीत** है concurrency और सस्ता rollback। **इसकी कीमत** है updates पर write amplification और vacuum की ज़रूरत।
- **Update-heavy tables** (counters, sessions, carts) सबसे तेज़ी से bloat होती हैं। HOT-friendly design पर विचार करें (hot columns पर कम indexes, fillfactor), या बहुत hot counters को बाहर ले जाएँ (जैसे Redis, या batch increments)।
- **Append-only data** (orders, events) MVCC-friendly है: कम dead tuples; freezing ही मुख्य maintenance है। Time-based [partitioning](/lessons/postgres-partitioning) से आप पुराना data बिना किसी bloat के drop कर सकते हैं।
- **Vacuum I/O है**। इसे बहुत ज़्यादा throttle करना उतना ही ख़तरनाक है जितना इसे न चलाना: backlog बस बढ़ता जाता है।
