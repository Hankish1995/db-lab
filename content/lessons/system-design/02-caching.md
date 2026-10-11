---
slug: caching
title: 'Caching: keeping hot answers close so the database can breathe'
module: Scaling
order: 20
summary: Where caches live, the five caching patterns, TTLs and eviction, how to invalidate without serving stale data, and how to survive stampedes, penetration and avalanches with Node.js and Redis.
level: intermediate
tags: [caching, redis, cache-aside, invalidation, ttl, eviction, cache-stampede, system-design]
recap: >-
  A cache stores answers to expensive, frequently repeated reads in fast memory, trading freshness for speed. The default
  pattern is cache-aside: read the cache, on a miss read the database and fill the cache with a TTL, and on writes update
  the database then delete the key. Plan for the hard parts: invalidation races, stampedes when a hot key expires,
  penetration by requests for missing keys, and avalanches when many keys expire at once. Never cache data that must be
  exact at decision time, such as stock at checkout, and always bound staleness with a TTL.
---

## 1. The story: the sticky note on the fridge

You keep the family's important phone numbers in a thick address book in the study. Every time someone needs the pizza place's number, they walk to the study and flip through the book. So you write the five most-used numbers on a **sticky note on the fridge**.

- The address book = the **database** (complete, authoritative, slower).
- The sticky note = the **cache** (small, fast, possibly out of date).
- Finding the number on the note = a **cache hit**. Walking to the study = a **cache miss**.
- The pizza place changes its number and nobody updates the note = **stale data**.
- The note only has room for five numbers, so you cross out the one nobody uses = **eviction**.
- Re-checking each number every month = a **TTL** (time to live).

> **Remember:** a cache is a copy. Every caching problem is really the question "how stale is this copy allowed to be?"

## 2. Why caching works

Caching pays off because real traffic is **skewed**:

- **Read-heavy:** an e-commerce store might do 100 product reads for every product update.
- **Locality:** a small set of items gets most of the traffic. Today's flash-sale sneaker is viewed 50,000 times; most of the catalog is viewed rarely. Caching the hottest few percent of keys often absorbs most reads.
- **Expensive to compute:** a product page may join products, prices, ratings and stock. Computing it once and reusing it saves real CPU.

A Redis `GET` typically takes well under a millisecond inside the same data centre; a database query with joins takes milliseconds or more, and costs CPU on the one machine you can least afford to overload.

## 3. Where caches live

```text
 Browser ──► CDN edge ──► App memory ──► Redis ──► Database
  cache       cache        (per          (shared    buffer cache
                           instance)     cache)     + disk
 fastest ◄──────────────────────────────────────────► authoritative
```

| Layer | Good for | Watch out for |
|---|---|---|
| **Browser** (`Cache-Control`) | Static assets, rarely changing API responses | You can't purge a user's browser |
| **CDN** | Images, JS, public product pages | Never cache per-user responses as public |
| **In-process memory** (an LRU map) | Tiny, very hot config or lookup data | Each instance has its own copy; inconsistent across instances |
| **Redis / Memcached** | Shared cache for all app instances | Network hop, another system to run |
| **Database buffer cache** | Automatic: PostgreSQL `shared_buffers` + OS page cache, MongoDB's WiredTiger cache | Not a substitute for app caching; it still runs the query |

## 4. The caching patterns

### Cache-aside (lazy loading): the default

The application owns the logic: check the cache, on a miss load from the database and populate the cache.

```ts
import Redis from 'ioredis';
import { MongoClient, ObjectId } from 'mongodb';

const redis = new Redis(process.env.REDIS_URL!);
const mongo = new MongoClient(process.env.MONGO_URL!);
const products = mongo.db('shop').collection('products');

const TTL_SECONDS = 300;

export async function getProduct(id: string) {
  const key = `product:${id}`;

  const cached = await redis.get(key);         // 1. try the cache
  if (cached !== null) return JSON.parse(cached);

  const product = await products.findOne({ _id: new ObjectId(id) }); // 2. miss

  // 3. fill the cache; cache "not found" briefly too (see penetration)
  const ttl = product ? TTL_SECONDS : 30;
  await redis.set(key, JSON.stringify(product), 'EX', ttl);
  return product;
}

export async function updatePrice(id: string, priceCents: number) {
  await products.updateOne({ _id: new ObjectId(id) }, { $set: { priceCents } });
  await redis.del(`product:${id}`);            // invalidate AFTER the write
}
```

Pros: only requested data is cached, and if Redis dies the app still works (slower). Cons: the first request after a miss is slow, and there are race windows (section 6).

### The other patterns

- **Read-through:** the app only talks to the cache; on a miss, the **cache itself** loads from the database (via a loader you configure). Same behaviour as cache-aside, but the logic lives in a library or caching layer.
- **Write-through:** every write goes to the cache **and** the database synchronously, so the cache is always populated with fresh values. Writes are slower, and you may cache data nobody reads.
- **Write-behind (write-back):** writes go to the cache and are acknowledged immediately; the cache flushes to the database **later**, often in batches. Very fast writes, but if the cache node dies before flushing, **acknowledged writes are lost**.
- **Refresh-ahead:** the cache refreshes hot keys **before** they expire, so users rarely see a miss. Wasted work if the prediction is wrong.

| Pattern | Who loads on miss | Write path | Freshness | Main risk |
|---|---|---|---|---|
| Cache-aside | App | DB, then delete key | Stale up to TTL / race | Race conditions, cold misses |
| Read-through | Cache layer | Usually DB + invalidate | Same as cache-aside | Coupling to cache library |
| Write-through | Cache layer | Cache + DB, synchronous | Fresh after writes | Slower writes, caches cold data |
| Write-behind | Cache layer | Cache now, DB later | Cache is the newest copy | Data loss, hard to reason about |
| Refresh-ahead | Background refresher | Any | Hot keys stay warm | Wasted refreshes |

> **Remember:** default to cache-aside with a TTL and delete-on-write. Reach for write-behind only when you can tolerate losing recent writes.

## 5. TTLs and eviction

A **TTL** bounds how long a stale value can live. It's your safety net when invalidation fails. Choose it from the business: a product description can be stale for 10 minutes; a price during a sale maybe 30 seconds; stock at checkout, never.

When memory is full, the cache must **evict** something:

- **LRU** (least recently used): evict what hasn't been touched for the longest time. Good general default.
- **LFU** (least frequently used): evict what's used least often. Better when a few keys are consistently hot and occasional scans would otherwise flush them.

In Redis you set this with `maxmemory` and `maxmemory-policy`. Common choices:

| Policy | Evicts |
|---|---|
| `noeviction` (the default) | Nothing; writes fail when memory is full |
| `allkeys-lru` | Any key, approximately least recently used |
| `allkeys-lfu` | Any key, approximately least frequently used |
| `volatile-lru` / `volatile-lfu` / `volatile-ttl` | Only keys that have a TTL |

For a pure cache, `allkeys-lru` or `allkeys-lfu` is the usual pick. Redis implements these **approximately** by sampling keys, not with an exact global ordering. If the same Redis also stores sessions or rate-limit counters you can't lose, use separate instances or a `volatile-*` policy.

## 6. Invalidation: the hard part

Strategies, from simplest to most precise:

1. **TTL only:** accept staleness up to the TTL. Simple and robust.
2. **Delete on write:** after updating the database, `DEL` the key; the next read repopulates it. Prefer **delete** over **set**: two concurrent writers that each `SET` their value can finish in the wrong order and leave the older value cached.
3. **Versioned keys:** put a version in the key (`product:42:v17`). A write bumps the version, so readers simply stop asking for old keys, which age out by TTL. Great for content you can't delete reliably (e.g. CDN URLs like `app.3f9c1.js`).

### The classic cache-aside race

Even "update DB, then delete" has a window:

```text
 Reader A                         Writer B
 ─────────────────────────────    ──────────────────────────────
 GET product:42  → miss
 read DB         → price 100
                                  UPDATE DB price = 80
                                  DEL product:42
 SET product:42 = 100  ← stale!
```

The reader loaded the old value before the write and stored it after the delete. The cache now says 100 until the TTL expires. It's rare (the reader must be slower than the whole write), but at high traffic rare things happen daily.

Mitigations:

- **Always have a TTL** so the damage is bounded.
- **Delayed double delete:** delete again a short time (e.g. a second) after the write.
- **Version check:** store the row's version or `updatedAt` with the cached value and refuse to overwrite a newer one (a small Lua script makes the compare-and-set atomic).
- **Leases:** the cache hands a token to the first missing reader and rejects its `SET` if the key was invalidated meanwhile (the approach described in Facebook's memcache paper).
- **CDC-driven invalidation:** a consumer reads the database change stream and deletes keys, so invalidation can't be forgotten by one code path.

> **Remember:** delete, don't set, on write, and keep a TTL as a safety net. "Cache invalidation is hard" is a joke because it's true.

## 7. When caches hurt: stampede, penetration, avalanche

### Stampede (thundering herd)

The hot flash-sale product key expires. 5,000 requests per second all miss **at the same moment**, and all run the same expensive query. The database falls over, so the cache never gets refilled.

Fixes:

- **Request coalescing:** only one in-flight load per key per process.

```ts
const inFlight = new Map<string, Promise<unknown>>();

function loadOnce<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = loader().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
```

- **Distributed lock:** across instances, the first to win `SET lock:product:42 <token> EX 10 NX` rebuilds; others briefly wait and re-read the cache, or serve the stale value.
- **Early probabilistic expiration:** each reader, as expiry approaches, has a small and growing chance of refreshing early, so one request refreshes before everyone misses together.
- **Serve stale while revalidating:** keep the old value and refresh in the background.

### Penetration

Requests for IDs that **don't exist** (bugs, scrapers, attackers trying random IDs) always miss the cache and hit the database. Fixes: **cache negative results** briefly (the `null` with a 30-second TTL above), validate input, and use a **Bloom filter** of existing IDs: it can say "definitely not present" (no false negatives), with a small rate of false positives that just fall through to a normal lookup.

### Avalanche

Many keys expire **at the same time** (you warmed the cache at deploy with the same TTL), or the cache cluster itself goes down. Fixes: **jittered TTLs** (`300 + random(0..60)` seconds), a highly available cache, rate-limiting or circuit-breaking database access, and warming gradually.

| Problem | Trigger | Main fix |
|---|---|---|
| Stampede | One hot key expires | Coalescing, lock, early refresh |
| Penetration | Keys that don't exist | Negative caching, Bloom filter |
| Avalanche | Many keys expire / cache down | Jittered TTLs, HA cache, circuit breaker |

## 8. What not to cache (and the consistency trade-off)

- ❌ **Stock at checkout.** Showing "In stock" from a 60-second-old cache on the product page is fine. Deciding whether the purchase succeeds must use the database with an atomic conditional update (see [Concurrency and locking](/lessons/concurrency-and-locking)).
- ❌ **Per-user or sensitive data in shared caches without care.** A CDN that caches `/api/me` as public will show one user's address to another. Use `Cache-Control: private` (or `no-store`) for personal responses, and include the user ID in Redis keys.
- ❌ **Data that changes faster than it's read.** A cache with a 5% hit rate is pure overhead.
- ⚠️ **Large values** (multi-MB documents) eat memory and network; cache the fields you need.

Caching is a deliberate step away from strong consistency: you accept that readers may see an older value for up to the TTL (or until invalidation runs). Decide per feature what "too stale" means, the same trade-off described in [CAP and PACELC](/lessons/cap-and-pacelc).

> **Remember:** cache what users browse; never cache what the business decides on.

## 9. Redis beyond caching (one paragraph)

Redis is a data-structure server, so it's used for more than caching: **rate limiting** (`INCR` a per-user, per-minute counter and `EXPIRE` it), **sessions** for stateless app servers, **leaderboards** with sorted sets (`ZINCRBY`, `ZRANGE ... REV`), queues and streams, pub/sub, and simple distributed locks (with real caveats about failover). When Redis holds data you can't rebuild, it stops being "just a cache": configure persistence and replication, and don't let an `allkeys-lru` policy evict it.

## 10. Common mistakes and trade-offs

- **No TTL** "because we invalidate on write": the one code path that forgets to invalidate makes data stale forever.
- **Cache key collisions**: `product:42` used by two services with different shapes. Namespace and version your keys.
- **Treating the cache as the source of truth** without persistence.
- **Caching before measuring**: if the query takes 2 ms and runs 10 times a minute, a cache adds complexity for nothing.
- **Forgetting the cold start**: after a cache flush or deploy, the database must survive full traffic until the cache is warm.

Use a cache when reads dominate, the same data is read repeatedly, and some staleness is acceptable. Skip it, or keep TTLs very short, when every read must be exact, data is mostly unique per request, or the database is comfortably handling the load.

> **Remember:** a cache should make a healthy system faster, not keep an unhealthy one alive. If the database can't survive the cache being empty, plan for that day.
