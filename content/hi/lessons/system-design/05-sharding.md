---
slug: sharding
title: 'Sharding: एक बहुत बड़े database को कई machines में बाँटना'
module: Scaling
summary: 'Sharding क्या है, यह क्यों है, shard key कैसे सब कुछ तय करती है, और कब shard नहीं करना चाहिए।'
recap: >-
  Sharding = data को कई machines में बाँटना, क्योंकि एक machine काफ़ी नहीं है। Shard key तय करती है कि data कहाँ
  जाएगा और कौन सी queries तेज़ होंगी। Hashed writes को फैलाता है; ranged, range queries में मदद करता है। Hot shards और
  scatter-gather से सावधान रहें। यह replication (copies) या partitioning (एक ही machine) नहीं है। Shard सबसे आखिर में
  करें, सबसे पहले नहीं।
---

## 1. कहानी

आप एक library चलाते हैं जिसकी **एक ही building** है। शुरू में सब ठीक है। फिर आपके पास 1 करोड़ (10 million) किताबें और रोज़ 50,000 visitors हो जाते हैं।

- Building **भर चुकी है**: shelves पर और जगह नहीं (**storage limit**)।
- Front desk पर **बहुत लंबी line** है (**बहुत ज़्यादा reads और writes**)।
- बड़ी building खरीदना महँगा पड़ता है, और आखिरकार **उससे बड़ी building होती ही नहीं** (**vertical scaling की सीमा आ जाती है**)।

तो आप **4 branches** खोलते हैं और किताबें उनमें बाँट देते हैं:

```text
Authors A–F  →  Branch 1
Authors G–M  →  Branch 2
Authors N–S  →  Branch 3
Authors T–Z  →  Branch 4
```

शहर के entrance पर एक **receptionist** हर visitor को बताता है कि किस branch में जाना है।

**यही sharding है।**

- हर branch = एक **shard**: एक अलग database server जिसमें data का *एक हिस्सा* है।
- "Author का पहला अक्षर" = **shard key**: वो field जो तय करती है कि हर record कहाँ रहेगा।
- Receptionist = **router** (MongoDB में `mongos`)। यह हर query को सही shard पर भेजता है।
- Receptionist की notebook कि "कौन से अक्षर किस branch में हैं" = **config servers** (metadata)।

> **याद रखें:** sharding = **एक database की rows को कई machines में बाँटना**, ताकि **कोई एक machine न तो सारा data रखे और न ही सारा traffic संभाले।**

## 2. मुख्य लक्ष्य

Sharding **एक machine के काफ़ी न होने** की समस्या solve करती है:

| समस्या | Sharding इसे कैसे ठीक करती है |
|---|---|
| Data एक disk के लिए बहुत बड़ा है | हर shard सिर्फ़ एक हिस्सा store करता है |
| एक server के लिए बहुत ज़्यादा writes | Writes shards में फैल जाते हैं |
| बहुत ज़्यादा reads | Reads भी फैल जाते हैं |
| बड़े servers बहुत महँगे हो जाते हैं | इसकी जगह और सस्ते servers जोड़ें |

यह **horizontal scaling** है (और machines जोड़ना)। **Vertical scaling** का मतलब है बड़ी machine खरीदना।

## 3. एक असली उदाहरण: e-commerce `orders` collection

आपके पास **2 billion orders** हैं। एक server उन सबको नहीं रख सकता, इसलिए आप `customerId` से 3 shards में shard करते हैं:

```text
          ┌──────────── App ────────────┐
                        │
                  ┌─────▼─────┐
                  │  mongos   │  ← router: "which shard has this?"
                  └─────┬─────┘
        ┌───────────────┼───────────────┐
   ┌────▼────┐     ┌────▼────┐     ┌────▼────┐
   │ Shard 1 │     │ Shard 2 │     │ Shard 3 │
   │ cust    │     │ cust    │     │ cust    │
   │ 1–1M    │     │ 1M–2M   │     │ 2M–3M   │
   └─────────┘     └─────────┘     └─────────┘
```

**Query: "Customer 1,500,000 के सारे orders दिखाओ।"**
Router जानता है कि जवाब Shard 2 पर है और **सिर्फ़ Shard 2** से पूछता है। यह एक **targeted query** है, और यह तेज़ है। ✅

```js
db.orders.find({ customerId: 1500000 }) // includes the shard key → targeted
```

**Query: "आज के सारे orders दिखाओ।"**
Query में `customerId` नहीं है, इसलिए router को **तीनों shards** से पूछना पड़ता है और results merge करने पड़ते हैं। यह एक **scatter-gather query** है, और यह धीमी है। ⚠️

```js
db.orders.find({ createdAt: { $gte: ISODate('2026-10-11') } }) // no shard key → every shard
```

> **याद रखें:** shard key तय करती है कि कौन सी queries तेज़ होंगी। अगर query में shard key है, तो वो targeted है। अगर नहीं, तो वो हर shard पर जाती है।

## 4. Shard key चुनना (सबसे ज़रूरी फ़ैसला)

एक अच्छी shard key में तीन गुण होते हैं:

1. **High cardinality:** बहुत सारी अलग-अलग values। `country` खराब है, क्योंकि इसकी सिर्फ़ लगभग 200 values हैं, इसलिए आप लगभग 200 टुकड़ों से ज़्यादा नहीं बाँट सकते। `userId` अच्छा है।
2. **Even distribution:** data और traffic shards में बराबर फैलें।
3. **आपकी आम queries से match करे:** ज़्यादातर queries में यह होनी चाहिए, ताकि वो targeted हों।

### Classic गलती: hot shard

आप **ranged sharding** के साथ `createdAt` (date) से shard करते हैं:

```text
Shard 1: 2023 orders     😴 idle
Shard 2: 2024 orders     😴 idle
Shard 3: 2025+ orders    🔥 receives EVERY new order
```

हर नए order में आज की date होती है, इसलिए **सारे writes आखिरी shard पर पहुँचते हैं**। आपने 3 servers खरीदे, पर काम सिर्फ़ एक करता है। कोई भी key जो लगातार बढ़ती रहती है (timestamp, auto-increment ID, MongoDB `ObjectId`) उसमें यही समस्या है।

### बाँटने के दो तरीके

| Ranged sharding | Hashed sharding |
|---|---|
| Value ranges से बाँटता है (A–F, G–M…) | पहले key को hash function से गुज़ारता है, जो values को randomly बिखेर देता है |
| ✅ Range queries ("customers 100–200") तेज़ हैं, क्योंकि data साथ-साथ रहता है | ✅ Writes बराबर फैलते हैं, इसलिए कोई hot shard नहीं |
| ❌ बढ़ती keys hot shard बनाती हैं | ❌ Range queries scatter-gather बन जाती हैं |

```js
sh.shardCollection('shop.orders', { customerId: 1 })        // ranged
sh.shardCollection('shop.orders', { customerId: 'hashed' }) // hashed
```

> **याद रखें:** **ranged** = range queries के लिए अच्छा, writes के लिए जोखिम भरा। **Hashed** = writes के लिए अच्छा, ranges के लिए खराब।

## 5. चीज़ें जो shard करने के बाद ही होती हैं

- **Chunks और balancer:** MongoDB data को **chunks** में बाँटता है और एक background **balancer** chunks को shards के बीच move करता है ताकि वो बराबर रहें।
- **Jumbo chunk:** अगर बहुत सारे documents की shard key value *एक ही* हो (जैसे एक बहुत बड़ा customer), तो वो chunk न split हो सकता है न move।
- **Cross-shard transactions** संभव हैं, पर धीमे (machines के बीच two-phase commit)।
- **Unique indexes** तभी लागू हो सकते हैं जब उनमें shard key शामिल हो।
- **बाद में shard key बदलना बहुत तकलीफ़देह है**: resharding का मतलब है अपना सारा data दोबारा लिखना। **शुरू में ही सोच-समझकर चुनें।**
- **Shards के बीच joins और `$lookup`** महँगे हैं।

## 6. इन तीनों में confuse न हों

| | यह क्या करता है | मिसाल |
|---|---|---|
| **Sharding** | Data को **कई machines** में बाँटता है, हर एक में **अलग** data | Library की 4 branches, हर एक में अलग किताबें |
| **Replication** | **एक ही data की copies** कई machines पर रखता है (safety और read scaling के लिए) | *उन्हीं* किताबों की photocopies एक backup building में |
| **Partitioning** (जैसे PostgreSQL में) | एक table को **एक ही machine पर** टुकड़ों में बाँटता है | *उसी* building में अलग-अलग कमरे |

असली systems में आप **sharding और replication दोनों को मिलाते हैं**: हर shard खुद एक replica set होता है, ताकि अगर किसी shard का server मर जाए, तो उसकी copy संभाल ले।

## 7. कब shard नहीं करना चाहिए

Sharding बहुत complexity जोड़ती है। **पहले ये आज़माएँ:**

1. सही **indexes** जोड़ें
2. धीमी queries ठीक करें
3. एक **cache** जोड़ें (जैसे Redis)
4. Read-heavy load के लिए **read replicas** जोड़ें
5. Machine upgrade करें (vertical scaling)
6. पुराने data को **archive** करें

Shard सिर्फ़ तब करें जब **data size या write volume** सच में एक replica set में fit न हो सके।

> **याद रखें:** shard सबसे आखिर में करें, सबसे पहले नहीं।
