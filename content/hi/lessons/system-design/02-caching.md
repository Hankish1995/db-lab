---
slug: caching
title: 'Caching: hot जवाबों को पास रखें ताकि database साँस ले सके'
module: Scaling
summary: 'Caches कहाँ रहते हैं, पाँच caching patterns, TTLs और eviction, stale data serve किए बिना invalidate कैसे करें, और Node.js और Redis के साथ stampedes, penetration और avalanches से कैसे बचें।'
recap: >-
  Cache महँगे, बार-बार दोहराए जाने वाले reads के जवाब तेज़ memory में रखता है, यानी freshness के बदले speed।
  Default pattern cache-aside है: cache पढ़ें, miss होने पर database पढ़ें और TTL के साथ cache भरें, और writes पर
  पहले database update करें फिर key delete करें। मुश्किल हिस्सों के लिए plan करें: invalidation races, hot key
  expire होने पर stampedes, ग़ायब keys की requests से penetration, और एक साथ कई keys expire होने पर avalanches।
  ऐसा data कभी cache न करें जो फ़ैसले के समय बिल्कुल सही होना चाहिए, जैसे checkout पर stock, और staleness को
  हमेशा एक TTL से सीमित रखें।
---

## 1. कहानी: fridge पर चिपका sticky note

आप परिवार के ज़रूरी phone numbers study room में रखी एक मोटी address book में रखते हैं। जब भी किसी को pizza वाले का number चाहिए, वह study तक जाता है और book के पन्ने पलटता है। तो आप सबसे ज़्यादा use होने वाले पाँच numbers **fridge पर एक sticky note** पर लिख देते हैं।

- Address book = **database** (पूरा, authoritative, धीमा)।
- Sticky note = **cache** (छोटा, तेज़, शायद पुराना)।
- Note पर number मिल जाना = **cache hit**। Study तक जाना = **cache miss**।
- Pizza वाला अपना number बदल देता है और कोई note update नहीं करता = **stale data**।
- Note पर सिर्फ़ पाँच numbers की जगह है, इसलिए जिसे कोई use नहीं करता उसे काट दिया जाता है = **eviction**।
- हर महीने हर number दोबारा check करना = एक **TTL** (time to live)।

> **याद रखें:** cache एक copy है। हर caching समस्या असल में यही सवाल है: "इस copy को कितना stale होने की इजाज़त है?"

## 2. Caching काम क्यों करता है

Caching का फ़ायदा इसलिए मिलता है क्योंकि असली traffic **skewed** होता है:

- **Read-heavy:** एक e-commerce store हर product update पर शायद 100 product reads करता है।
- **Locality:** items का एक छोटा set ज़्यादातर traffic लेता है। आज का flash-sale sneaker 50,000 बार देखा जाता है; catalog का ज़्यादातर हिस्सा कभी-कभार देखा जाता है। सबसे hot कुछ प्रतिशत keys को cache करना अक्सर ज़्यादातर reads सोख लेता है।
- **Compute करना महँगा:** एक product page products, prices, ratings और stock को join कर सकता है। इसे एक बार compute करके reuse करने से असली CPU बचता है।

उसी data centre के अंदर Redis `GET` आम तौर पर एक millisecond से काफ़ी कम लेता है; joins वाली database query milliseconds या उससे ज़्यादा लेती है, और उस एक machine का CPU खाती है जिसे overload करना आप सबसे कम afford कर सकते हैं।

## 3. Caches कहाँ रहते हैं

```text
 Browser ──► CDN edge ──► App memory ──► Redis ──► Database
  cache       cache        (per          (shared    buffer cache
                           instance)     cache)     + disk
 fastest ◄──────────────────────────────────────────► authoritative
```

| Layer | किसके लिए अच्छा | किस बात का ध्यान रखें |
|---|---|---|
| **Browser** (`Cache-Control`) | Static assets, कम बदलने वाले API responses | आप किसी user का browser purge नहीं कर सकते |
| **CDN** | Images, JS, public product pages | Per-user responses को कभी public के रूप में cache न करें |
| **In-process memory** (एक LRU map) | छोटा, बहुत hot config या lookup data | हर instance की अपनी copy; instances के बीच inconsistent |
| **Redis / Memcached** | सभी app instances के लिए shared cache | Network hop, चलाने के लिए एक और system |
| **Database buffer cache** | अपने-आप: PostgreSQL `shared_buffers` + OS page cache, MongoDB का WiredTiger cache | App caching का विकल्प नहीं; query फिर भी चलती है |

## 4. Caching patterns

### Cache-aside (lazy loading): default

Logic application के पास है: cache check करो, miss होने पर database से load करो और cache भर दो।

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

फ़ायदे: सिर्फ़ माँगा गया data cache होता है, और अगर Redis मर जाए तो app फिर भी चलती है (धीमी)। नुकसान: miss के बाद पहली request धीमी होती है, और race windows होती हैं (section 6)।

### बाकी patterns

- **Read-through:** app सिर्फ़ cache से बात करती है; miss होने पर **cache ख़ुद** database से load करता है (आपके configure किए loader से)। बर्ताव cache-aside जैसा ही, लेकिन logic किसी library या caching layer में रहता है।
- **Write-through:** हर write cache **और** database दोनों में synchronously जाता है, इसलिए cache हमेशा fresh values से भरा रहता है। Writes धीमे होते हैं, और आप ऐसा data cache कर सकते हैं जिसे कोई पढ़ता ही नहीं।
- **Write-behind (write-back):** writes cache में जाते हैं और तुरंत acknowledge हो जाते हैं; cache उन्हें database में **बाद में** flush करता है, अक्सर batches में। बहुत तेज़ writes, लेकिन अगर flush से पहले cache node मर जाए, तो **acknowledged writes खो जाते हैं**।
- **Refresh-ahead:** cache hot keys को expire होने से **पहले** refresh कर देता है, इसलिए users को miss शायद ही दिखता है। अगर अंदाज़ा ग़लत हो तो काम बेकार जाता है।

| Pattern | Miss पर कौन load करता है | Write path | Freshness | मुख्य जोखिम |
|---|---|---|---|---|
| Cache-aside | App | DB, फिर key delete | TTL / race तक stale | Race conditions, cold misses |
| Read-through | Cache layer | आम तौर पर DB + invalidate | Cache-aside जैसा | Cache library से जुड़ाव (coupling) |
| Write-through | Cache layer | Cache + DB, synchronous | Writes के बाद fresh | धीमे writes, cold data cache होता है |
| Write-behind | Cache layer | Cache अभी, DB बाद में | Cache सबसे नई copy है | Data loss, समझना मुश्किल |
| Refresh-ahead | Background refresher | कोई भी | Hot keys warm रहती हैं | बेकार refreshes |

> **याद रखें:** default रूप से TTL और delete-on-write के साथ cache-aside use करें। Write-behind तभी चुनें जब आप हाल के writes खोना बर्दाश्त कर सकें।

## 5. TTLs और eviction

**TTL** तय करता है कि एक stale value कितनी देर ज़िंदा रह सकती है। जब invalidation fail हो, तब यही आपका safety net है। इसे business से तय करें: product description 10 minutes तक stale रह सकता है; sale के दौरान price शायद 30 seconds; checkout पर stock, कभी नहीं।

जब memory भर जाती है, तो cache को कुछ **evict** करना पड़ता है:

- **LRU** (least recently used): जिसे सबसे लंबे समय से छुआ नहीं गया उसे निकालो। अच्छा general default।
- **LFU** (least frequently used): जो सबसे कम बार use होता है उसे निकालो। तब बेहतर जब कुछ keys लगातार hot रहती हैं और कभी-कभार के scans वरना उन्हें बाहर कर देते।

Redis में आप इसे `maxmemory` और `maxmemory-policy` से set करते हैं। आम choices:

| Policy | क्या evict करती है |
|---|---|
| `noeviction` (default) | कुछ नहीं; memory भरने पर writes fail होते हैं |
| `allkeys-lru` | कोई भी key, लगभग least recently used |
| `allkeys-lfu` | कोई भी key, लगभग least frequently used |
| `volatile-lru` / `volatile-lfu` / `volatile-ttl` | सिर्फ़ वे keys जिनका TTL है |

Pure cache के लिए आम तौर पर `allkeys-lru` या `allkeys-lfu` चुना जाता है। Redis इन्हें exact global ordering से नहीं, बल्कि keys को sample करके **लगभग (approximately)** implement करता है। अगर वही Redis sessions या rate-limit counters भी रखता है जिन्हें आप खो नहीं सकते, तो अलग instances या `volatile-*` policy use करें।

## 6. Invalidation: मुश्किल हिस्सा

Strategies, सबसे simple से सबसे सटीक तक:

1. **सिर्फ़ TTL:** TTL तक staleness स्वीकार करें। Simple और मज़बूत।
2. **Write पर delete:** database update करने के बाद key को `DEL` करें; अगला read उसे फिर से भर देगा। **Set** की जगह **delete** चुनें: दो concurrent writers जो अपनी-अपनी value `SET` करते हैं, ग़लत क्रम में ख़त्म हो सकते हैं और पुरानी value cache में छोड़ सकते हैं।
3. **Versioned keys:** key में एक version डालें (`product:42:v17`)। Write version बढ़ा देता है, इसलिए readers पुरानी keys माँगना बंद कर देते हैं, जो TTL से ख़त्म हो जाती हैं। ऐसे content के लिए बढ़िया जिसे आप भरोसे से delete नहीं कर सकते (जैसे `app.3f9c1.js` जैसे CDN URLs)।

### Classic cache-aside race

"DB update करो, फिर delete करो" में भी एक window है:

```text
 Reader A                         Writer B
 ─────────────────────────────    ──────────────────────────────
 GET product:42  → miss
 read DB         → price 100
                                  UPDATE DB price = 80
                                  DEL product:42
 SET product:42 = 100  ← stale!
```

Reader ने पुरानी value write से पहले load की और delete के बाद store कर दी। अब TTL expire होने तक cache 100 बताता है। यह दुर्लभ है (reader को पूरे write से धीमा होना पड़ता है), लेकिन ज़्यादा traffic पर दुर्लभ चीज़ें रोज़ होती हैं।

बचाव:

- **हमेशा एक TTL रखें** ताकि नुकसान सीमित रहे।
- **Delayed double delete:** write के थोड़ी देर बाद (जैसे एक second) फिर से delete करें।
- **Version check:** cached value के साथ row का version या `updatedAt` store करें और किसी नई value को overwrite करने से मना करें (एक छोटी Lua script compare-and-set को atomic बनाती है)।
- **Leases:** cache पहले miss करने वाले reader को एक token देता है और अगर इस बीच key invalidate हो गई हो तो उसका `SET` reject कर देता है (Facebook के memcache paper में बताया गया तरीका)।
- **CDC-driven invalidation:** एक consumer database का change stream पढ़ता है और keys delete करता है, ताकि कोई एक code path invalidation भूल न सके।

> **याद रखें:** write पर set नहीं, delete करें, और safety net के रूप में TTL रखें। "Cache invalidation is hard" एक मज़ाक इसलिए है क्योंकि यह सच है।

## 7. जब caches नुकसान करते हैं: stampede, penetration, avalanche

### Stampede (thundering herd)

Hot flash-sale product की key expire हो जाती है। हर second 5,000 requests **एक ही पल में** miss करती हैं, और सब वही महँगी query चलाती हैं। Database गिर जाता है, इसलिए cache कभी दोबारा भर ही नहीं पाता।

Fixes:

- **Request coalescing:** हर process में हर key के लिए एक समय पर सिर्फ़ एक load।

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

- **Distributed lock:** instances के पार, जो सबसे पहले `SET lock:product:42 <token> EX 10 NX` जीतता है वह rebuild करता है; बाकी थोड़ी देर इंतज़ार करके cache दोबारा पढ़ते हैं, या stale value serve करते हैं।
- **Early probabilistic expiration:** expiry पास आने पर हर reader के पास जल्दी refresh करने का एक छोटा और बढ़ता हुआ chance होता है, ताकि सबके एक साथ miss करने से पहले एक request refresh कर दे।
- **Serve stale while revalidating:** पुरानी value रखें और background में refresh करें।

### Penetration

ऐसे IDs की requests जो **मौजूद ही नहीं** हैं (bugs, scrapers, random IDs आज़माते attackers) हमेशा cache miss करती हैं और database तक पहुँचती हैं। Fixes: **negative results को थोड़ी देर cache करें** (ऊपर 30-second TTL वाला `null`), input validate करें, और मौजूदा IDs का एक **Bloom filter** use करें: यह "पक्का मौजूद नहीं" बता सकता है (कोई false negative नहीं), और थोड़े false positives होते हैं जो बस normal lookup तक चले जाते हैं।

### Avalanche

कई keys **एक ही समय पर** expire हो जाती हैं (आपने deploy पर एक ही TTL से cache warm किया था), या cache cluster ख़ुद down हो जाता है। Fixes: **jittered TTLs** (`300 + random(0..60)` seconds), highly available cache, database access पर rate-limiting या circuit-breaking, और धीरे-धीरे warm करना।

| समस्या | Trigger | मुख्य fix |
|---|---|---|
| Stampede | एक hot key expire होती है | Coalescing, lock, early refresh |
| Penetration | मौजूद न होने वाली keys | Negative caching, Bloom filter |
| Avalanche | कई keys expire / cache down | Jittered TTLs, HA cache, circuit breaker |

## 8. क्या cache न करें (और consistency का trade-off)

- ❌ **Checkout पर stock।** Product page पर 60 second पुराने cache से "In stock" दिखाना ठीक है। Purchase सफल होगी या नहीं, यह फ़ैसला database से atomic conditional update के साथ होना चाहिए ([Concurrency and locking](/lessons/concurrency-and-locking) देखें)।
- ❌ **बिना सावधानी के shared caches में per-user या sensitive data।** जो CDN `/api/me` को public के रूप में cache करता है, वह एक user का address दूसरे को दिखा देगा। Personal responses के लिए `Cache-Control: private` (या `no-store`) use करें, और Redis keys में user ID शामिल करें।
- ❌ **ऐसा data जो पढ़े जाने से तेज़ बदलता है।** 5% hit rate वाला cache बस overhead है।
- ⚠️ **बड़ी values** (multi-MB documents) memory और network खाती हैं; सिर्फ़ ज़रूरी fields cache करें।

Caching जानबूझकर strong consistency से दूर हटने वाला step है: आप मान लेते हैं कि readers TTL तक (या invalidation चलने तक) पुरानी value देख सकते हैं। हर feature के लिए तय करें कि "बहुत ज़्यादा stale" का मतलब क्या है, वही trade-off जो [CAP and PACELC](/lessons/cap-and-pacelc) में बताया गया है।

> **याद रखें:** users जो browse करते हैं वह cache करें; business जिस पर फ़ैसला करता है वह कभी cache न करें।

## 9. Caching से आगे Redis (एक paragraph में)

Redis एक data-structure server है, इसलिए यह caching से ज़्यादा कामों में use होता है: **rate limiting** (हर user, हर minute का counter `INCR` करें और उस पर `EXPIRE` लगाएँ), stateless app servers के लिए **sessions**, sorted sets के साथ **leaderboards** (`ZINCRBY`, `ZRANGE ... REV`), queues और streams, pub/sub, और simple distributed locks (failover को लेकर असली caveats के साथ)। जब Redis ऐसा data रखता है जिसे आप दोबारा नहीं बना सकते, तो वह "सिर्फ़ cache" नहीं रहता: persistence और replication configure करें, और `allkeys-lru` policy को उसे evict न करने दें।

## 10. आम गलतियाँ और trade-offs

- **कोई TTL नहीं** "क्योंकि हम write पर invalidate करते हैं": जो एक code path invalidate करना भूल जाता है, वह data को हमेशा के लिए stale कर देता है।
- **Cache key collisions**: `product:42` को दो services अलग-अलग shapes के साथ use करती हैं। अपनी keys को namespace और version करें।
- Persistence के बिना **cache को source of truth मानना**।
- **Measure करने से पहले caching**: अगर query 2 ms लेती है और minute में 10 बार चलती है, तो cache बेवजह complexity जोड़ता है।
- **Cold start भूल जाना**: cache flush या deploy के बाद, cache warm होने तक database को पूरा traffic झेलना पड़ता है।

Cache तब use करें जब reads हावी हों, वही data बार-बार पढ़ा जाए, और थोड़ी staleness चल जाए। इसे छोड़ दें, या TTLs बहुत छोटे रखें, जब हर read बिल्कुल सही होना चाहिए, data ज़्यादातर हर request के लिए अलग हो, या database आराम से load संभाल रहा हो।

> **याद रखें:** cache को एक healthy system को तेज़ बनाना चाहिए, किसी बीमार system को ज़िंदा नहीं रखना चाहिए। अगर database खाली cache के साथ नहीं टिक सकता, तो उस दिन के लिए plan करें।
