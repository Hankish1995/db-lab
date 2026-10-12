---
slug: database-case-studies
title: 'Database case studies: चार classic interview designs, data सबसे पहले'
module: Case Studies
summary: 'चार interview-style designs (URL shortener, checkout और inventory, chat messages, social feed), जिन्हें scale estimates से लेकर data model, queries, indexes, database choice, scaling plan और pitfalls तक हल किया गया है, साथ में एक दोबारा इस्तेमाल होने वाली checklist।'
recap: >-
  Database design के सवाल का जवाब एक तय क्रम में दें: requirements, back-of-the-envelope numbers, access patterns, data
  model, keys और indexes, database choice, scaling plan, consistency और failure modes। URL shortener एक read-heavy
  key-value lookup है जहाँ ID generation और caching मायने रखते हैं। Checkout को overselling रोकनी होती है, एक atomic
  conditional update या expiry वाले reservation से, साथ में idempotent payments। Chat को conversation के हिसाब से
  partition किया जाता है, time-ordered keys और cursor pagination के साथ। Feed fan-out on write और fan-out on read के
  बीच संतुलन बनाता है, celebrities के लिए hybrid के साथ।
---

## 1. कहानी: एक architect की sketchbook

एक architect हर घर शून्य से design नहीं करती। उसके पास हल की हुई समस्याओं की एक sketchbook होती है: "kitchen में sink, stove और fridge के बीच एक triangle चाहिए", "staircase को इतना headroom चाहिए"। नए घर, जानी-पहचानी sketches के combinations होते हैं।

System design interviews भी ऐसे ही चलते हैं। चार designs बार-बार आते हैं, और हर एक database का एक ऐसा idea सिखाता है जो बार-बार काम आता है:

| Case | दोबारा काम आने वाला idea |
|---|---|
| URL shortener | ID generation, read-heavy key-value lookups, caching |
| Checkout & inventory | Concurrency में correctness, idempotency |
| Chat messages | किसी entity के हिसाब से partitioning, time-ordered keys, cursor pagination |
| Social feed | पहले से compute करें vs read पर compute करें (fan-out) |

हर case में हम ऐसे चलते हैं: **requirements → numbers → data model → queries और indexes → database choice → scaling → pitfalls।**

> **याद रखें:** interviewers reasoning को grade करते हैं, logo को नहीं। "मैंने X चुना क्योंकि access pattern Y है और scale Z है" किसी सबसे trendy database का नाम लेने से कहीं बेहतर है।

Numbers के लिए एक छोटा tool: एक दिन में ~86,400 seconds होते हैं, इसलिए **1 million per day ≈ 12 per second**। Peak traffic अक्सर average का 2–10× होता है।

## 2. Case 1: URL shortener

**Requirements.** एक लंबे URL के लिए short link बनाना; `sho.rt/aZ3kQ9x` को तेज़ी से उस पर redirect करना; optional expiry; basic click analytics।

**Numbers.**

- 100M नए links/month ≈ 100M ÷ 2.6M s ≈ **40 writes/s**।
- Reads writes के ~100× हैं: average **~4,000 redirects/s**, peak पर ~20,000/s।
- 5 साल × 1.2B/year = 6B links × ~500 bytes ≈ **3 TB**।
- Code length: 7 characters वाला base62 (`0-9a-zA-Z`) = 62⁷ ≈ **3.5 trillion** codes। काफ़ी से भी ज़्यादा।

**Data model.** Primary key से एक lookup, कोई joins नहीं:

```sql
CREATE TABLE links (
  code        varchar(10) PRIMARY KEY,
  long_url    text        NOT NULL,
  user_id     bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);
-- the redirect query: one primary-key lookup
SELECT long_url, expires_at FROM links WHERE code = 'aZ3kQ9x';
```

### ID generation: मुख्य trade-off

| तरीका | कैसे | फ़ायदे | नुकसान |
|---|---|---|---|
| **Counter + base62** | Global counter → encode | कोई collisions नहीं, छोटा | Codes का अंदाज़ा लगाया जा सकता है/गिने जा सकते हैं; counter distributed होना चाहिए (हर server को ID ranges बाँटें, या Snowflake-style IDs) |
| URL का **hash** | MD5/SHA → 7 chars लें | Same URL → same code (dedupe) | काटने (truncation) से collisions होते हैं; check और retry करना पड़ता है; अलग users के बीच dedupe शायद न चाहिए |
| **Random** 7 chars | Crypto-random → insert | अंदाज़ा नहीं लगाया जा सकता, कोई coordination नहीं | Collision संभव: **unique constraint** पर भरोसा करें और retry करें |

```ts
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function toBase62(n: bigint): string {
  if (n === 0n) return '0';
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}
```

Random codes के साथ, insert करें और database को collisions पकड़ने दें (`INSERT ... ON CONFLICT (code) DO NOTHING`, zero rows आने पर retry)। 3.5T संभव codes में से 6B links पर collisions कम हैं पर नामुमकिन नहीं, और unique key उन्हें हानिरहित बना देती है।

**Database choice.** यह एक key-value workload है: तेज़ primary-key lookups वाला कोई भी store चलेगा। PostgreSQL 3 TB और 40 writes/s आराम से संभाल लेता है। अगर आपको built-in horizontal scaling चाहिए तो key-value / wide-column store (DynamoDB, Cassandra) आकर्षक है। दोनों का बचाव किया जा सकता है; बस वजह बताइए।

**Scaling plan.** Redirects बहुत ज़्यादा cacheable और skewed होते हैं (कुछ links viral हो जाते हैं)। `code → long_url` को Redis में cache करें (कुछ GB में करोड़ों hot links आ जाते हैं) और CDN पर भी। ज़रूरत हो तो read replicas जोड़ें। अगर एक primary छोटा पड़ जाए, तो `hash(code)` से shard करें: हर query में code होता है, इसलिए हर query targeted है।

**301 vs 302.**

- **301 (permanent):** browsers और proxies redirect को cache कर सकते हैं, इसलिए बार-बार के clicks शायद **आप तक कभी पहुँचें ही नहीं**। Load कम, पर click counts खो जाते हैं।
- **302 (या 307, temporary):** हर click आपके servers पर आता है। Load ज़्यादा, analytics सटीक।

**Pitfalls.**

- हर redirect पर एक `click_count` column update करना एक viral link को **hot row** बना देता है। Click events को queue/log में लिखें और उन्हें analytics store में aggregate करें।
- लंबे URLs validate न करना (malware, open-redirect का दुरुपयोग)।
- Expired links: read पर `expires_at` check करें और background में साफ़ करें।

## 3. Case 2: E-commerce checkout और inventory

**Requirements.** जो stock आपके पास नहीं है उसे कभी न बेचें; कभी दो बार charge न करें; flash sale के दौरान भी checkout चलता रहे।

**Numbers.** आमतौर पर ~100k orders/day ≈ **1–2 orders/s**: बहुत कम। मुश्किल case flash sale है: पहले minute में 200,000 shoppers 5,000 units वाले **एक SKU** पर "Buy" दबाते हैं ≈ **एक ही row पर 3,000+ attempts/s**। समस्या volume नहीं है; समस्या **contention** है।

**Data model** (relational, क्योंकि यहाँ पैसा और invariants हैं):

```sql
CREATE TABLE inventory (
  product_id  bigint  PRIMARY KEY,
  available   integer NOT NULL CHECK (available >= 0)
);

CREATE TABLE reservations (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    bigint      NOT NULL,
  product_id  bigint      NOT NULL REFERENCES inventory,
  qty         integer     NOT NULL,
  status      text        NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | CONFIRMED | EXPIRED
  expires_at  timestamptz NOT NULL
);
CREATE INDEX ON reservations (expires_at) WHERE status = 'ACTIVE';
```

### Overselling रोकना

**Option A: atomic conditional update.** Check और decrement एक ही statement में करें; row lock concurrent buyers को एक-एक करके (serialize) चलाता है।

```sql
UPDATE inventory
SET available = available - 1
WHERE product_id = 42 AND available >= 1
RETURNING available;   -- 0 rows returned → sold out
```

MongoDB में भी यही idea है:

```js
const res = db.inventory.updateOne(
  { _id: 42, available: { $gte: 1 } },
  { $inc: { available: -1 } }
)
// res.modifiedCount === 0 → sold out
```

**Option B: TTL वाला reservation.** असली checkouts में minutes लगते हैं (address, payment)। Checkout शुरू होते ही stock reserve करें, और अगर payment समय पर पूरा न हो तो उसे छोड़ दें:

```sql
BEGIN;
UPDATE inventory SET available = available - 1
WHERE product_id = 42 AND available >= 1;          -- 0 rows → ROLLBACK, sold out
INSERT INTO reservations (order_id, product_id, qty, expires_at)
VALUES (1001, 42, 1, now() + interval '10 minutes');
COMMIT;
```

एक background job expired reservations वापस करता है:

```sql
WITH expired AS (
  UPDATE reservations SET status = 'EXPIRED'
  WHERE status = 'ACTIVE' AND expires_at < now()
  RETURNING product_id, qty
)
UPDATE inventory i
SET available = i.available + e.total
FROM (SELECT product_id, sum(qty) AS total FROM expired GROUP BY product_id) e
WHERE i.product_id = e.product_id;
```

संभालने लायक race: payment ठीक उसी पल सफल होता है जब reservation expire होता है। एक conditional update से confirm करें (`SET status = 'CONFIRMED' WHERE id = $1 AND status = 'ACTIVE'`); अगर zero rows match हों, तो दोबारा reserve करने की कोशिश करें या refund करें। Locks और anomalies का पूरा विवरण [Concurrency and locking](/lessons/concurrency-and-locking) में है।

| | Payment पर atomic decrement | TTL वाला reservation |
|---|---|---|
| Customer experience | Card details डालने के बाद fail हो सकता है | Pay करते समय stock रुका रहता है |
| Complexity | बहुत कम | Expiry job, confirm/expire race |
| जोखिम | Overselling नामुमकिन, निराशा संभव | Bots reservations जमा कर सकते हैं (हर user की limit रखें) |

### Payments और checkout का बाकी हिस्सा

- हर checkout attempt के लिए unique constraint वाली **idempotency key**, जो payment provider को भी भेजी जाए, ताकि retries कभी double-charge न करें।
- Orders, payments, inventory और email अलग-अलग services में → compensations वाला एक **saga** और events के लिए एक **outbox**। देखें [Distributed data patterns](/lessons/distributed-data-patterns)।

**Hot SKU को scale करना.** एक row को एक सीमित रफ़्तार से ही update किया जा सकता है, क्योंकि हर update पिछले के commit होने का इंतज़ार करता है। विकल्प: transaction को बहुत छोटा रखें (उसके अंदर कोई network calls नहीं); आगे एक atomic **Redis `DECR` gate** लगाएँ ताकि ज़्यादातर हारने वाले database को छुए बिना लौटा दिए जाएँ (source of truth database ही रहता है); stock को N **sub-counters** में बाँटें (`product 42, bucket 0..9`) और किसी random bucket को decrement करें; या buyers को एक **queue** में डालें और क्रम से process करें।

**Pitfalls.** App code में read-then-write; stock cache करना और checkout पर उस पर भरोसा करना; payment API call करते समय DB transaction खुला रखना; ऐसे reservations जो कभी expire नहीं होते।

> **याद रखें:** inventory के लिए correctness database पर एक atomic, conditional write से आती है। बाकी सब (caches, Redis gates, queues) बस यह कम करते हैं कि कितनी requests वहाँ तक पहुँचें।

## 4. Case 3: Chat messages

**Requirements.** 1:1 और group chats; message भेजना; latest messages load करना; history में पीछे scroll करना; user की conversation list दिखाना।

**Numbers.**

- 50M daily users × 40 messages = **2B messages/day ≈ 23,000 writes/s** average, peak पर शायद 70,000/s।
- 2B × ~200 bytes ≈ **400 GB/day ≈ 150 TB/year**, replication से पहले।

यह **write-heavy, append-only और विशाल** है। Messages लगभग कभी update नहीं होते, और reads लगभग हमेशा "एक conversation के latest N messages" होते हैं।

**मुख्य design फ़ैसले.**

- **`conversation_id` से partition करें**: सारी queries per conversation होती हैं, इसलिए वो एक ही partition पर जाती हैं।
- **Time-ordered message IDs** (Snowflake-style IDs, ULIDs, या Cassandra `timeuuid`), ताकि ID से sort करना = time से sort करना हो, और IDs pagination cursors का काम करें।
- **Cursor (keyset) pagination**: "ID X से पुराने 50 messages", कभी `OFFSET` नहीं, जो जितना गहरा scroll करें उतना धीमा होता जाता है।
- **बड़ी conversations को time से bucket करें** (जैसे per month), ताकि कोई एक partition हमेशा बढ़ता न रहे।

एक wide-column model (Cassandra CQL):

```sql
-- CQL (Cassandra / ScyllaDB)
CREATE TABLE messages (
  conversation_id  uuid,
  bucket           int,        -- e.g. 202610 = October 2026
  message_id       timeuuid,
  sender_id        uuid,
  body             text,
  PRIMARY KEY ((conversation_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- newest page, then older pages with a cursor
SELECT * FROM messages
WHERE conversation_id = ? AND bucket = ? AND message_id < ?
LIMIT 50;
```

**बहुत बड़े scale पर wide-column stores क्यों.** ये ठीक इसी काम के लिए बने हैं: log-structured (LSM) storage appends को सस्ता बनाता है, partition के अंदर rows **clustering key के हिसाब से sorted** store होती हैं इसलिए "latest 50" एक sequential read है, और nodes जोड़ने से writes लगभग linearly scale होते हैं। उदाहरण के लिए, Discord ने सार्वजनिक रूप से बताया कि उसने अपने messages MongoDB से Cassandra पर और बाद में ScyllaDB पर move किए। Trade-offs: आप tables **हर query के हिसाब से** design करते हैं (conversation list को अपनी अलग table चाहिए), कोई joins नहीं, और ad-hoc querying सीमित।

**MongoDB वाला विकल्प.** मध्यम scale पर MongoDB अच्छा चलता है:

```js
db.messages.createIndex({ conversationId: 1, _id: -1 })

db.messages.find({ conversationId: convId, _id: { $lt: lastSeenId } })
  .sort({ _id: -1 })
  .limit(50)
```

ObjectIds मोटे तौर पर time-ordered होते हैं (वो seconds में एक timestamp से शुरू होते हैं), जो ज़्यादातर apps में एक conversation के अंदर ordering के लिए काफ़ी है। ऐसी key से shard करें जो conversation से शुरू हो, जैसे `{ conversationId: 'hashed', _id: 1 }`, ताकि एक conversation की queries targeted रहें और नई conversations shards में फैलती रहें।

Documents और index entries की गिनती घटाने के लिए **bucket pattern** इस्तेमाल करें: एक document एक conversation के ~100 messages तक रखता है।

```js
db.messageBuckets.updateOne(
  { conversationId: convId, count: { $lt: 100 } },
  {
    $push: { messages: { id: msgId, senderId, body, sentAt: new Date() } },
    $inc: { count: 1 },
    $setOnInsert: { firstAt: new Date() }
  },
  { upsert: true }
)
```

हर 100 messages पर एक index entry, और history का एक page एक document read है। कीमतें: किसी एक message को edit या delete करना ज़्यादा झंझट वाला है, और आपको bucket को 16 MB document limit से काफ़ी नीचे cap करना होगा। देखें [MongoDB schema patterns](/lessons/mongodb-schema-patterns)।

**Pitfalls.** `user_id` से partition करना (एक group message हर member के partition में लिखना पड़ेगा या scatter-gather से पढ़ना पड़ेगा); बहुत बड़े group chats के लिए unbounded partitions; clients के wall-clock timestamps को IDs की तरह इस्तेमाल करना (clock skew, duplicates); `OFFSET` pagination।

## 5. Case 4: Social feed / timeline

**Requirements.** Users दूसरों को follow करते हैं; home feed उन लोगों के recent posts दिखाता है जिन्हें वो follow करते हैं, सबसे नए पहले; यह तेज़ी से load होना चाहिए।

**Numbers.**

- 100M daily users × 10 feed loads = **1B feed reads/day ≈ 12,000/s**।
- 10M posts/day ≈ **115 posts/s**।
- औसतन 200 followers → 10M × 200 = **2B feed inserts/day ≈ 23,000/s**, अगर आप पहले से compute करते हैं।

**Data model.**

```sql
CREATE TABLE follows (
  follower_id  bigint NOT NULL,
  followee_id  bigint NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX ON follows (followee_id);           -- "who follows X?"

CREATE TABLE posts (
  id          bigint PRIMARY KEY,                 -- time-ordered ID
  author_id   bigint      NOT NULL,
  body        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON posts (author_id, created_at DESC);
```

### Fan-out on read (pull)

जब user feed खोले, तब उसे बनाएँ:

```sql
SELECT p.* FROM posts p
JOIN follows f ON f.followee_id = p.author_id
WHERE f.follower_id = $1 AND p.created_at < $2
ORDER BY p.created_at DESC
LIMIT 50;
```

Writes बहुत आसान हैं। Reads महँगे हैं: 500 accounts follow करने का मतलब है हर feed load पर 500 index ranges merge करना, एक second में 12,000 बार।

### Fan-out on write (push)

जब कोई post करे, तो post ID को हर follower के पहले से बने feed में डाल दें, जैसे time से scored एक Redis sorted set:

```text
ZADD feed:42 1760180000 9001     # score = time, member = post id
ZREMRANGEBYRANK feed:42 0 -1001  # keep only the newest 1,000
ZRANGE feed:42 0 49 REV          # read: newest 50 post ids
```

Reads एक सस्ता lookup बन जाते हैं, साथ में ID से posts fetch करना (cacheable)। Writes कई गुना हो जाते हैं: एक post → हर follower के लिए एक insert।

### Celebrity problem

50M followers वाला एक celebrity post करता है। Fan-out on write का मतलब है एक post के लिए **5 करोड़ (50 million) inserts**, और जब तक queue खाली होती है, followers को post देर से दिखता है। इस बीच, उनमें से ज़्यादातर followers आज app खोलेंगे भी नहीं।

### Hybrid

```text
 Normal author posts ──► fan-out on write ──► followers' feeds
 Celebrity posts ──────► stored once, NOT fanned out

 User opens feed:
   precomputed feed (normal authors)
     + recent posts of followed celebrities (pulled at read time)
     → merge by time → rank → return page
```

- एक follower threshold से नीचे वाले accounts के लिए fan out on write करें।
- Celebrity posts read के समय pull करें (users कम ही celebrities को follow करते हैं, इसलिए merge छोटा होता है)।
- **Inactive** users के लिए fan-out छोड़ दें; जब वो लौटें तो read पर उनका feed दोबारा बनाएँ।

| | Fan-out on write | Fan-out on read | Hybrid |
|---|---|---|---|
| Read cost | बहुत कम | ज़्यादा | कम |
| Write cost | Followers × posts | बहुत कम | सीमित |
| Freshness | Fan-out queue की वजह से देरी | हमेशा fresh | ज़्यादातर fresh |
| Celebrity posts | तकलीफ़देह | ठीक | ठीक |
| Storage | हर user का feed | कुछ extra नहीं | हर active user का feed |

**Database choice.** Posts और follows: एक relational DB या wide-column store, `author_id` / `follower_id` से sharded। पहले से बने feeds: Redis (या user से keyed एक wide-column table) जिसमें **सिर्फ़ IDs** हों, लंबाई capped हो; post bodies एक post cache से आती हैं। Fan-out एक queue से asynchronously चलता है।

**Pitfalls.** हर feed में पूरी post bodies store करना (edits और deletes भी fan-out बन जाते हैं); unbounded feed lists; post request के अंदर synchronously fan-out करना; यह भूल जाना कि unfollow और delete को भी feeds साफ़ करने होंगे (या read के समय filter करना होगा)।

> **याद रखें:** fan-out का मतलब है "write के समय कीमत चुकाओ या read के समय"। Hybrid ज़्यादातर users के लिए write के समय कीमत चुकाता है और उन कुछ के लिए read के समय, जो वरना system तोड़ देते।

## 6. Database design के सवाल का जवाब कैसे दें

| Step | क्या पूछें / करें | उदाहरण (chat) |
|---|---|---|
| 1. Requirements | Functional और non-functional (latency, consistency, durability) | Send, history, conversation list; messages खोने नहीं चाहिए |
| 2. Numbers | Users, QPS (read vs write), peak, storage, growth | 23k writes/s, 150 TB/year |
| 3. Access patterns | Top 3–5 queries उनकी frequency के साथ list करें | Conversation के latest 50; पुराना page |
| 4. Data model | Entities, tables/documents, embed vs reference | Conversation + time-ordered ID से keyed `messages` |
| 5. Keys और indexes | Primary/partition key, sort key, secondary indexes | `((conversation_id, bucket), message_id)` |
| 6. Database choice | Engine को pattern से match करें; वजह बताएँ | विशाल append-only writes के लिए wide-column |
| 7. Consistency | क्या exact होना ज़रूरी है, क्या stale चल सकता है | Conversation के अंदर ordering; read receipts पीछे रह सकती हैं |
| 8. Scaling plan | Cache, replicas, partitioning, sharding: इसी क्रम में | पहले दिन से conversation से partition |
| 9. Failure modes | Hot keys, node loss, retries, duplicates | बहुत बड़े group chats, idempotent message IDs |
| 10. Trade-offs | आपने क्या छोड़ा और क्यों | कोई ad-hoc queries नहीं; search, search engine पर जाता है |

> **याद रखें:** queries से शुरू करें, entities से नहीं। कोई data model सिर्फ़ उन सवालों के हिसाब से "अच्छा" होता है जिनका जवाब उसे तेज़ी से देना है।

## 7. इन interviews की आम गलतियाँ

- पहले ही minute में, बिना किसी numbers या access patterns के, database का नाम ले लेना।
- Back-of-the-envelope math करना और फिर उसे नज़रअंदाज़ कर देना ("40 writes/s… तो हमें Cassandra चाहिए")।
- Averages के लिए design करना और peak व hot key (viral link, flash-sale SKU, celebrity) को भूल जाना।
- Consistency पर गोल-मोल बात करना: बताइए कि कौन सा data strongly consistent होना चाहिए (stock, payments) और कौन सा eventual हो सकता है (feeds, counters, analytics)।
- Failure modes छोड़ देना: retries, duplicates, node loss और cache outages ही वो जगह हैं जहाँ senior जवाब अलग दिखते हैं।
- Over-engineering: 40 writes/s के लिए 12 systems वाला design seniority नहीं दिखाता। Complexity को numbers से match करें, जैसा [Scaling databases](/lessons/scaling-databases) में है।
