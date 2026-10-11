---
slug: database-case-studies
title: 'Database case studies: four classic interview designs, data first'
module: Case Studies
order: 60
summary: Four interview-style designs (URL shortener, checkout and inventory, chat messages, social feed) worked through from scale estimates to data model, queries, indexes, database choice, scaling plan and pitfalls, plus a reusable checklist.
level: advanced
tags: [system-design, case-study, url-shortener, inventory, chat, news-feed, fan-out, data-modeling, interviews]
recap: >-
  Answer a database design question in a fixed order: requirements, back-of-the-envelope numbers, access patterns, data
  model, keys and indexes, database choice, scaling plan, consistency and failure modes. A URL shortener is a read-heavy
  key-value lookup where ID generation and caching matter. Checkout must prevent overselling with an atomic conditional
  update or a reservation with expiry, plus idempotent payments. Chat partitions by conversation with time-ordered keys
  and cursor pagination. A feed balances fan-out on write and on read, with a hybrid for celebrities.
---

## 1. The story: an architect's sketchbook

An architect doesn't design every house from zero. She has a sketchbook of solved problems: "a kitchen needs a triangle between sink, stove and fridge", "a staircase needs this much headroom". New houses are combinations of known sketches.

System design interviews work the same way. Four designs come up again and again, and each teaches a reusable database idea:

| Case | The reusable idea |
|---|---|
| URL shortener | ID generation, read-heavy key-value lookups, caching |
| Checkout & inventory | Correctness under concurrency, idempotency |
| Chat messages | Partitioning by an entity, time-ordered keys, cursor pagination |
| Social feed | Precompute vs compute on read (fan-out) |

For each case we go: **requirements → numbers → data model → queries and indexes → database choice → scaling → pitfalls.**

> **Remember:** interviewers grade the reasoning, not the logo. "I chose X because the access pattern is Y and the scale is Z" beats naming the trendiest database.

A quick tool for the numbers: a day has ~86,400 seconds, so **1 million per day ≈ 12 per second**. Peak traffic is often 2–10× the average.

## 2. Case 1: URL shortener

**Requirements.** Create a short link for a long URL; redirect `sho.rt/aZ3kQ9x` to it fast; optional expiry; basic click analytics.

**Numbers.**

- 100M new links/month ≈ 100M ÷ 2.6M s ≈ **40 writes/s**.
- Reads are ~100× writes: **~4,000 redirects/s** on average, ~20,000/s at peak.
- 5 years × 1.2B/year = 6B links × ~500 bytes ≈ **3 TB**.
- Code length: base62 (`0-9a-zA-Z`) with 7 characters = 62⁷ ≈ **3.5 trillion** codes. Plenty.

**Data model.** One lookup by primary key, no joins:

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

### ID generation: the core trade-off

| Approach | How | Pros | Cons |
|---|---|---|---|
| **Counter + base62** | Global counter → encode | No collisions, short | Codes are guessable/enumerable; counter must be distributed (hand out ID ranges per server, or Snowflake-style IDs) |
| **Hash** of the URL | MD5/SHA → take 7 chars | Same URL → same code (dedupe) | Truncation causes collisions; must check and retry; dedupe across users may be unwanted |
| **Random** 7 chars | Crypto-random → insert | Unguessable, no coordination | Collision possible: rely on the **unique constraint** and retry |

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

With random codes, insert and let the database detect collisions (`INSERT ... ON CONFLICT (code) DO NOTHING`, retry on zero rows). At 6B links out of 3.5T possible, collisions are rare but not impossible, and the unique key makes them harmless.

**Database choice.** It's a key-value workload: any store with fast primary-key lookups works. PostgreSQL handles 3 TB and 40 writes/s comfortably. A key-value / wide-column store (DynamoDB, Cassandra) is attractive if you want built-in horizontal scaling. Either is defensible; say why.

**Scaling plan.** Redirects are extremely cacheable and skewed (a few links go viral). Cache `code → long_url` in Redis (a few GB holds tens of millions of hot links) and at the CDN. Add read replicas if needed. If you outgrow one primary, shard by `hash(code)`: every query includes the code, so every query is targeted.

**301 vs 302.**

- **301 (permanent):** browsers and proxies can cache the redirect, so repeat clicks may **never reach you**. Less load, but you lose click counts.
- **302 (or 307, temporary):** every click comes to your servers. More load, accurate analytics.

**Pitfalls.**

- Updating a `click_count` column per redirect turns a viral link into a **hot row**. Write click events to a queue/log and aggregate them in an analytics store.
- Not validating long URLs (malware, open-redirect abuse).
- Expired links: check `expires_at` on read and clean up in the background.

## 3. Case 2: E-commerce checkout and inventory

**Requirements.** Never sell stock you don't have; never charge twice; checkout stays up during a flash sale.

**Numbers.** Normally ~100k orders/day ≈ **1–2 orders/s**: tiny. The hard case is a flash sale: 200,000 shoppers hit "Buy" on **one SKU** with 5,000 units in the first minute ≈ **3,000+ attempts/s on a single row**. The problem isn't volume; it's **contention**.

**Data model** (relational, because this is money and invariants):

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

### Preventing overselling

**Option A: atomic conditional update.** Check and decrement in one statement; the row lock serializes concurrent buyers.

```sql
UPDATE inventory
SET available = available - 1
WHERE product_id = 42 AND available >= 1
RETURNING available;   -- 0 rows returned → sold out
```

The MongoDB equivalent is the same idea:

```js
const res = db.inventory.updateOne(
  { _id: 42, available: { $gte: 1 } },
  { $inc: { available: -1 } }
)
// res.modifiedCount === 0 → sold out
```

**Option B: reservation with a TTL.** Real checkouts take minutes (address, payment). Reserve stock when checkout starts, and release it if payment doesn't complete in time:

```sql
BEGIN;
UPDATE inventory SET available = available - 1
WHERE product_id = 42 AND available >= 1;          -- 0 rows → ROLLBACK, sold out
INSERT INTO reservations (order_id, product_id, qty, expires_at)
VALUES (1001, 42, 1, now() + interval '10 minutes');
COMMIT;
```

A background job returns expired reservations:

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

The race to handle: payment succeeds at the same moment the reservation expires. Confirm with a conditional update (`SET status = 'CONFIRMED' WHERE id = $1 AND status = 'ACTIVE'`); if it matches zero rows, try to reserve again or refund. The full treatment of locks and anomalies is in [Concurrency and locking](/lessons/concurrency-and-locking).

| | Atomic decrement at payment | Reservation with TTL |
|---|---|---|
| Customer experience | Can fail after entering card details | Stock held while they pay |
| Complexity | Minimal | Expiry job, confirm/expire race |
| Risk | Overselling impossible, disappointment possible | Bots can hoard reservations (limit per user) |

### Payments and the rest of checkout

- **Idempotency key** per checkout attempt with a unique constraint, passed to the payment provider too, so retries never double-charge.
- Orders, payments, inventory and email in different services → a **saga** with compensations and an **outbox** for events. See [Distributed data patterns](/lessons/distributed-data-patterns).

**Scaling the hot SKU.** One row can only be updated so fast, because each update waits for the previous one to commit. Options: keep the transaction tiny (no network calls inside it); put an atomic **Redis `DECR` gate** in front so most losers are turned away without touching the database (the database stays the source of truth); split stock into N **sub-counters** (`product 42, bucket 0..9`) and decrement a random bucket; or put buyers in a **queue** and process them in order.

**Pitfalls.** Read-then-write in app code; caching stock and trusting it at checkout; holding a DB transaction open while calling the payment API; reservations that never expire.

> **Remember:** for inventory, correctness comes from one atomic, conditional write at the database. Everything else (caches, Redis gates, queues) only reduces how many requests reach it.

## 4. Case 3: Chat messages

**Requirements.** 1:1 and group chats; send a message; load the latest messages; scroll back through history; show a user's conversation list.

**Numbers.**

- 50M daily users × 40 messages = **2B messages/day ≈ 23,000 writes/s** average, maybe 70,000/s at peak.
- 2B × ~200 bytes ≈ **400 GB/day ≈ 150 TB/year** before replication.

This is **write-heavy, append-only and huge**. Messages are almost never updated, and reads are almost always "the latest N messages of one conversation".

**Key design decisions.**

- **Partition by `conversation_id`**: all queries are per conversation, so they hit one partition.
- **Time-ordered message IDs** (Snowflake-style IDs, ULIDs, or Cassandra `timeuuid`), so sorting by ID = sorting by time, and IDs work as pagination cursors.
- **Cursor (keyset) pagination**: "50 messages older than ID X", never `OFFSET`, which gets slower the deeper you scroll.
- **Bucket big conversations** by time (e.g. per month), so no single partition grows forever.

A wide-column model (Cassandra CQL):

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

**Why wide-column stores at very large scale.** They're built for exactly this: log-structured (LSM) storage makes appends cheap, rows inside a partition are stored **sorted by the clustering key** so "latest 50" is a sequential read, and adding nodes scales writes roughly linearly. Discord, for example, publicly described moving its messages from MongoDB to Cassandra and later to ScyllaDB. The trade-offs: you design tables **per query** (the conversation list needs its own table), no joins, and limited ad-hoc querying.

**The MongoDB alternative.** At moderate scale, MongoDB works well:

```js
db.messages.createIndex({ conversationId: 1, _id: -1 })

db.messages.find({ conversationId: convId, _id: { $lt: lastSeenId } })
  .sort({ _id: -1 })
  .limit(50)
```

ObjectIds are roughly time-ordered (they start with a timestamp in seconds), which is good enough for ordering within a conversation for most apps. Shard with a key that starts with the conversation, such as `{ conversationId: 'hashed', _id: 1 }`, so a conversation's queries stay targeted while new conversations spread across shards.

To cut document and index counts, use the **bucket pattern**: one document holds up to ~100 messages of a conversation.

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

One index entry per 100 messages, and a page of history is one document read. The costs: editing or deleting a single message is more awkward, and you must cap the bucket well below the 16 MB document limit. See [MongoDB schema patterns](/lessons/mongodb-schema-patterns).

**Pitfalls.** Partitioning by `user_id` (a group message would be written to every member's partition or read via scatter-gather); unbounded partitions for huge group chats; using wall-clock timestamps from clients as IDs (clock skew, duplicates); `OFFSET` pagination.

## 5. Case 4: Social feed / timeline

**Requirements.** Users follow others; the home feed shows recent posts from people they follow, newest first; it must load fast.

**Numbers.**

- 100M daily users × 10 feed loads = **1B feed reads/day ≈ 12,000/s**.
- 10M posts/day ≈ **115 posts/s**.
- Average 200 followers → 10M × 200 = **2B feed inserts/day ≈ 23,000/s** if you precompute.

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

Build the feed when the user opens it:

```sql
SELECT p.* FROM posts p
JOIN follows f ON f.followee_id = p.author_id
WHERE f.follower_id = $1 AND p.created_at < $2
ORDER BY p.created_at DESC
LIMIT 50;
```

Writes are trivial. Reads are expensive: following 500 accounts means merging 500 index ranges on every feed load, 12,000 times a second.

### Fan-out on write (push)

When someone posts, push the post ID into each follower's precomputed feed, e.g. a Redis sorted set scored by time:

```text
ZADD feed:42 1760180000 9001     # score = time, member = post id
ZREMRANGEBYRANK feed:42 0 -1001  # keep only the newest 1,000
ZRANGE feed:42 0 49 REV          # read: newest 50 post ids
```

Reads become one cheap lookup plus fetching posts by ID (cacheable). Writes multiply: one post → one insert per follower.

### The celebrity problem

A celebrity with 50M followers posts. Fan-out on write means **50 million inserts** for one post, and followers see it late while the queue drains. Meanwhile, most of those followers won't even open the app today.

### The hybrid

```text
 Normal author posts ──► fan-out on write ──► followers' feeds
 Celebrity posts ──────► stored once, NOT fanned out

 User opens feed:
   precomputed feed (normal authors)
     + recent posts of followed celebrities (pulled at read time)
     → merge by time → rank → return page
```

- Fan out on write for accounts below a follower threshold.
- Pull celebrity posts at read time (users follow few celebrities, so the merge is small).
- Skip fan-out to **inactive** users; rebuild their feed on read when they return.

| | Fan-out on write | Fan-out on read | Hybrid |
|---|---|---|---|
| Read cost | Very low | High | Low |
| Write cost | Followers × posts | Very low | Bounded |
| Freshness | Delayed by fan-out queue | Always fresh | Mostly fresh |
| Celebrity posts | Painful | Fine | Fine |
| Storage | Feed per user | None extra | Feed per active user |

**Database choice.** Posts and follows: a relational DB or a wide-column store, sharded by `author_id` / `follower_id`. Precomputed feeds: Redis (or a wide-column table keyed by user) holding **only IDs**, capped in length; post bodies come from a post cache. Fan-out runs asynchronously from a queue.

**Pitfalls.** Storing full post bodies in every feed (edits and deletes become fan-out too); unbounded feed lists; doing fan-out synchronously in the post request; forgetting that unfollow and delete must also clean feeds (or filter at read time).

> **Remember:** fan-out is "pay at write time or pay at read time". The hybrid pays at write time for most users and at read time for the few who would break the system.

## 6. How to answer a database design question

| Step | Ask / do | Example (chat) |
|---|---|---|
| 1. Requirements | Functional and non-functional (latency, consistency, durability) | Send, history, conversation list; messages must not be lost |
| 2. Numbers | Users, QPS (read vs write), peak, storage, growth | 23k writes/s, 150 TB/year |
| 3. Access patterns | List the top 3–5 queries with their frequency | Latest 50 in a conversation; older page |
| 4. Data model | Entities, tables/documents, embed vs reference | `messages` keyed by conversation + time-ordered ID |
| 5. Keys and indexes | Primary/partition key, sort key, secondary indexes | `((conversation_id, bucket), message_id)` |
| 6. Database choice | Match engine to pattern; justify it | Wide-column for huge append-only writes |
| 7. Consistency | What must be exact, what can be stale | Ordering within a conversation; read receipts can lag |
| 8. Scaling plan | Cache, replicas, partitioning, sharding: in that order | Partition by conversation from day one |
| 9. Failure modes | Hot keys, node loss, retries, duplicates | Huge group chats, idempotent message IDs |
| 10. Trade-offs | What you gave up and why | No ad-hoc queries; search goes to a search engine |

> **Remember:** start from the queries, not the entities. A data model is only "good" relative to the questions it must answer quickly.

## 7. Common mistakes in these interviews

- Naming a database in the first minute, before any numbers or access patterns.
- Doing back-of-the-envelope math and then ignoring it ("40 writes/s… so we need Cassandra").
- Designing for averages and forgetting the peak and the hot key (viral link, flash-sale SKU, celebrity).
- Hand-waving consistency: say which data must be strongly consistent (stock, payments) and which can be eventual (feeds, counters, analytics).
- Skipping failure modes: retries, duplicates, node loss and cache outages are where senior answers stand out.
- Over-engineering: a design that needs 12 systems for 40 writes/s doesn't show seniority. Match complexity to the numbers, as in [Scaling databases](/lessons/scaling-databases).
