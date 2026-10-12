---
slug: cap-and-pacelc
title: 'CAP और PACELC: हर distributed database के trade-offs'
module: Distributed Basics
summary: 'CAP असल में क्या कहता है, रोज़ के काम में PACELC ज़्यादा काम का model क्यों है, मुख्य consistency models कौन से हैं, और MongoDB व PostgreSQL इनमें कहाँ फिट होते हैं।'
recap: >-
  जैसे ही data एक से ज़्यादा machines पर रहता है, network उन्हें एक-दूसरे से अलग कर सकता है। CAP कहता है
  कि ऐसे partition के दौरान system को consistency (हर read latest write देखे) और availability (हर चालू
  node जवाब दे) में से एक चुनना पड़ता है। PACELC जोड़ता है कि partition न होने पर भी आप latency और
  consistency के बीच trade-off करते हैं। Consistency के कई levels होते हैं, linearizable से लेकर
  eventual तक। MongoDB और replicated PostgreSQL tunable हैं: write concern, read concern, read preference
  और synchronous replication तय करते हैं कि हर operation कहाँ बैठेगा।
---

## 1. Distributed करना ही क्यों?

एक database server simple और consistent होता है। लेकिन वह यह भी है:

- एक **single point of failure**: वह गिरा, तो पूरा store बंद,
- कुछ users से **बहुत दूर**: Mumbai का server New York के लिए धीमा है,
- **सीमित**: एक ही machine का CPU, RAM और disk।

इसलिए हम copies (**replication**) और हिस्से (**sharding**) जोड़ते हैं। जिस पल data **एक से ज़्यादा machine** पर रहने लगता है, उन machines को **network** पर बात करनी पड़ती है, और network fail होते हैं।

## 2. कहानी: दो warehouse और कटी हुई phone line

आपके store के **दो warehouse** हैं, Delhi और Mumbai। दोनों orders लेते हैं। वे phone से एक shared stock count sync में रखते हैं: हर sale की ख़बर phone करके दूसरी तरफ़ दी जाती है।

बस **एक** limited-edition sneaker बचा है।

फिर एक construction crew **phone line काट देती है**। दोनों warehouse ठीक हैं, staff काम कर रहा है, customers आ रहे हैं, लेकिन वे **एक-दूसरे से बात नहीं कर सकते**। यही है **network partition**।

एक customer Delhi में आता है और sneaker ख़रीदना चाहता है। Delhi manager के पास दो विकल्प हैं:

1. Line वापस आने तक **बेचने से मना कर दे**, क्योंकि हो सकता है Mumbai उसे पहले ही बेच चुका हो। Customers इंतज़ार करते हैं या चले जाते हैं। ➜ **Availability से ऊपर consistency (CP)।**
2. **फिर भी बेच दे** और conflicts बाद में सुलझाए। Mumbai भी उसे बेच सकता है, और एक customer को माफ़ी वाला email जाएगा। ➜ **Consistency से ऊपर availability (AP)।**

कोई तीसरा विकल्प नहीं है। जब आप बात ही नहीं कर सकते, तब आप हर customer को जवाब देना *और* यह guarantee करना कि किसी को पुराना stock न दिखे, दोनों एक साथ नहीं कर सकते।

```text
     ┌──────────────┐              ┌──────────────┐
     │    Delhi     │              │    Mumbai    │
     │ stock = 1    │─────/  /─────│ stock = 1    │
     └──────▲───────┘   partition  └──────▲───────┘
            │                             │
      "Buy sneaker"                 "Buy sneaker"

  CP: Delhi refuses (or errors) until it can reach Mumbai
  AP: both sell → stock = -1 across the system, fix later
```

| कहानी | Technical term |
|---|---|
| Warehouse | **Node** (replica) |
| Phone line | **Network** |
| Line कटी, दोनों तरफ़ ज़िंदा | **Network partition** |
| बेचने से मना करना | **Consistency** चुनना |
| फिर भी बेचना | **Availability** चुनना |

> **याद रखें:** partition का मतलब यह नहीं कि कोई server crash हो गया। इसका मतलब है **servers ज़िंदा हैं लेकिन एक-दूसरे तक पहुँच नहीं पा रहे**, और हर तरफ़ को ख़ुद तय करना है कि क्या करे।

## 3. CAP, सही तरीके से

**CAP theorem** (Brewer's conjecture, जिसे 2002 में Gilbert और Lynch ने prove किया) तीन properties के बारे में है:

- **C — Consistency:** ख़ास तौर पर **linearizability**। हर read **सबसे recent write** लौटाता है (या error), जैसे data की सिर्फ़ एक ही copy हो।
- **A — Availability:** **किसी भी non-failed node पर आई हर request को non-error response मिलता है**। यह "99.9% uptime" नहीं है; यह कहीं ज़्यादा सख़्त, specific definition है।
- **P — Partition tolerance:** nodes के बीच network messages drop या delay करे, तब भी system काम करता रहता है।

सही statement:

> **जब network partition होता है, तब distributed system को consistency और availability में से एक चुनना पड़ता है।**

मशहूर "3 में से 2 चुनो" गुमराह करने वाला है। Distributed system में आप **P को छोड़ने का विकल्प नहीं चुन सकते**: partitions होते ही हैं, चाहे आपको पसंद हो या नहीं (switch failures, cloud zone issues, लंबे GC pauses जो network loss जैसे दिखते हैं)। इसलिए असली चुनाव सिर्फ़ **partition के दौरान** होता है: **CP** या **AP**। "CA" system बस एक single-node system है, या ऐसा system जो मान लेता है कि partitions होते ही नहीं।

> **याद रखें:** CAP "3 में से 2 चुनो" नहीं है। यह है "**जब network बँटे, तो C या A चुनो**"। जब network ठीक है, तो आपको दोनों मिल सकते हैं।

## 4. CP बनाम AP behaviour

| | Partition के दौरान **CP** | Partition के दौरान **AP** |
|---|---|---|
| जो nodes majority तक नहीं पहुँच पाते | Writes reject करते हैं (और शायद reads भी) | Reads और writes लेते रहते हैं |
| User को क्या दिखता है | Errors या timeouts | Success, शायद stale या conflicting data |
| Partition ठीक होने के बाद | Reconcile करने को कुछ नहीं | Conflicts merge करने पड़ते हैं (last-write-wins, CRDTs, app logic) |
| किसके लिए अच्छा | Payments, inventory, unique usernames | Shopping carts, likes, view counts, sessions |
| उदाहरण (लगभग default behaviour) | Single-primary MongoDB writes, etcd, ZooKeeper | Cassandra, कमज़ोर settings वाले DynamoDB-style systems |

E-commerce store में: **checkout** CP होना चाहिए (एक ही item दो बार कभी न बिके, कभी double-charge न हो)। **"recently viewed" list** या किसी **review का like count** AP हो सकता है: थोड़ा stale चल जाता है, बंद होना नहीं चलता।

कई systems आपको **हर operation के हिसाब से** चुनने देते हैं, इसीलिए "MongoDB CP है" जैसे labels ज़रूरत से ज़्यादा simple हैं।

## 5. PACELC: वह model जो आप असल में इस्तेमाल करेंगे

Partitions कम ही होते हैं। ज़्यादातर समय network ठीक रहता है। लेकिन तब भी, **replicas को sync में रखने में समय लगता है**: consistency का वादा करने से पहले write को दूसरे nodes तक पहुँचना पड़ता है।

**PACELC** (Daniel Abadi) CAP को आगे बढ़ाता है:

```text
  if Partition:            choose  Availability  or  Consistency
  Else (normal operation): choose  Latency       or  Consistency
```

| System behaviour | PACELC class | मतलब |
|---|---|---|
| हमेशा replicas का इंतज़ार | **PC/EC** | पहले सही, भले ही धीमा |
| हमेशा तेज़ और available | **PA/EL** | Low latency, eventual consistency |
| मिला-जुला | **PA/EC** या **PC/EL** | Configuration पर निर्भर |

उदाहरण: 3-node replica set में एक write।

- **सिर्फ़ primary के बाद acknowledge** → तेज़ (EL), लेकिन अगर replicate होने से पहले primary मर जाए, तो write खो सकता है।
- **Majority के बाद acknowledge** → एक network round trip जितना धीमा (EC), लेकिन write failover में बच जाता है।

यह फ़ैसला आप **हर दिन** लेते हैं, सिर्फ़ कभी-कभार होने वाले partitions में नहीं। इसीलिए PACELC ज़्यादा practical model है।

> **याद रखें:** CAP बुरे दिन के बारे में है। **PACELC normal दिन को जोड़ता है**: failures के बिना भी, stronger consistency की क़ीमत latency है।

## 6. Consistency models, सबसे strong से सबसे weak

"Consistent" हाँ/ना वाली चीज़ नहीं है। यह रही सीढ़ी, e-commerce उदाहरणों के साथ:

| Model | Guarantee | E-commerce उदाहरण |
|---|---|---|
| **Linearizable** (strong) | हर read latest write देखता है, real-time order में, जैसे एक ही copy हो | आख़िरी sneaker का stock: sale के बाद जो भी read करे, उसे 0 दिखे |
| **Sequential** | सबको operations **एक ही order** में दिखते हैं, हर client के अपने order के मुताबिक़, लेकिन ज़रूरी नहीं कि real time में | सीधे कम ही चुना जाता है; ज़्यादातर theory |
| **Causal** | अगर A की वजह से B हुआ, तो सबको A, B से पहले दिखेगा; unrelated writes किसी भी order में दिख सकते हैं | Review का reply कभी review से पहले नहीं दिखता |
| **Read-your-writes** | आपको हमेशा **अपने** writes दिखते हैं | Address update करने के बाद, Asha को refresh पर नया address दिखता है |
| **Monotonic reads** | आपको data कभी **समय में पीछे जाता** नहीं दिखता | Refresh पर order status कभी "shipped" से वापस "packed" नहीं होता |
| **Eventual** | अगर writes रुक जाएँ, तो replicas **आख़िरकार** एक बात पर सहमत हो जाते हैं; order का कोई वादा नहीं | Product का review count एक request पर 41 और अगली पर 42 दिखाता है |

Read-your-writes और monotonic reads **session guarantees** हैं: ये इस बारे में हैं कि **एक user** को क्या दिखता है, और अक्सर user-facing app को बस इतना ही चाहिए।

```text
  stronger, slower, less available
  ▲  Linearizable
  │  Sequential
  │  Causal
  │  Read-your-writes / Monotonic reads
  ▼  Eventual
  weaker, faster, more available
```

> **याद रखें:** users को दिखने वाले ज़्यादातर bugs **session** bugs होते हैं ("मैंने save किया और वह गायब हो गया")। Read-your-writes अक्सर इन्हें पूरी linearizability की क़ीमत चुकाए बिना ठीक कर देता है।

## 7. MongoDB कहाँ फिट होता है

MongoDB के **replica set** में एक **primary** होता है जो writes लेता है और **secondaries** होते हैं जो oplog के ज़रिए उससे asynchronously replicate करते हैं। आप तीन knobs से consistency tune करते हैं:

| Knob | क्या control करता है | आम values |
|---|---|---|
| **Write concern** | कितने nodes को write acknowledge करना होगा | `w: 1`, `w: 'majority'` (modern versions में ज़्यादातर deployments के लिए default) |
| **Read concern** | आप जो data पढ़ते हैं, वह कितना "committed" होना चाहिए | `local` (default), `majority`, `linearizable`, `snapshot` |
| **Read preference** | कौन सा node read serve करेगा | `primary` (default), `primaryPreferred`, `secondary`, `nearest` |

```js
// Checkout: durable write, survives failover
db.orders.insertOne(
  { userId, items, status: 'paid' },
  { writeConcern: { w: 'majority' } }
)

// Stock check that must not be stale (primary only, single document;
// linearizable reads wait for a majority, so always set a timeout)
db.products.find({ _id: productId }).readConcern('linearizable').maxTimeMS(5000)

// Analytics page: fine to be a bit behind, offload the primary
db.orders.find({ status: 'shipped' }).readPref('secondaryPreferred')
```

**Partition** के दौरान यह कैसे behave करता है:

- जिस तरफ़ voting members की **majority** है, वह primary रखती है (या elect करती है) और writes लेती है।
- जो primary **majority से contact खो देता है, वह step down कर देता है**। Minority वाली तरफ़ कोई primary नहीं होता, इसलिए **वहाँ writes fail होते हैं**। यह writes के लिए CP behaviour है।
- लेकिन `secondary` या `nearest` read preference वाले reads minority तरफ़ भी serve हो सकते हैं, शायद **stale**। यह उन reads के लिए AP जैसा behaviour है।
- `w: 1` से acknowledge हुए writes जो कभी majority तक नहीं पहुँचे, पुराने primary के वापस जुड़ने के बाद **rolled back** हो सकते हैं।

एक session के अंदर, **causal consistency** (`client.startSession({ causalConsistency: true })`, sessions के लिए default) read-your-writes और monotonic reads देती है, लेकिन सिर्फ़ तब जब आप **`majority`** read और write concerns इस्तेमाल करें।

तो interview का सही जवाब: *"MongoDB single-primary है, इसलिए default रूप से writes majority से elect हुए primary से होकर जाते हैं और CP जैसा behave करते हैं। लेकिन consistency हर operation के हिसाब से tunable है: secondary reads, `w: 1` और `local` read concern, latency और availability के लिए consistency का trade-off करते हैं।"*

## 8. PostgreSQL कहाँ फिट होता है

**Single node:** असहमत होने के लिए कोई replicas नहीं हैं, इसलिए CAP असल में लागू नहीं होता। Reads committed data देखते हैं (ACID)। अगर server down है, तो वह बस unavailable है।

**Streaming replication के साथ:**

```text
           writes
             │
       ┌─────▼─────┐   WAL stream    ┌───────────┐
       │  Primary  │────────────────►│  Standby  │
       └───────────┘                 └───────────┘
   async (default): commit returns before standby has it
   sync: commit waits for the standby to confirm
```

| Mode | Behaviour | PACELC flavour |
|---|---|---|
| **Asynchronous** (default) | Commit तुरंत लौट आता है; standby थोड़ा पीछे रहता है। Failover में आख़िरी commits **खो** सकते हैं। Standby reads stale हो सकते हैं। | EL की तरफ़ झुका |
| **Synchronous** (`synchronous_standby_names`) | Commit standby का इंतज़ार करता है। अगर कोई synchronous standby जवाब न दे, तो **primary पर commits block हो जाते हैं**। | PC/EC |
| Sync + `synchronous_commit = remote_apply` | Commit तब तक इंतज़ार करता है जब तक standby बदलाव **apply** न कर ले, ताकि वहाँ के reads उसे देख सकें | Replicas पर सबसे strong read-after-write |

ध्यान दें कि PostgreSQL ख़ुद automatic failover नहीं करता; **Patroni** जैसे tools या managed services (RDS, Cloud SQL) इसे संभालते हैं, और उनकी configuration तय करती है कि कितना data loss मुमकिन है।

> **याद रखें:** "SQL CP है, NoSQL AP है" ग़लत है। **Configuration तय करती है**: async PostgreSQL replicas stale reads देते हैं, और `majority` concerns वाला MongoDB strongly consistent है।

## 9. आम ग़लतफ़हमियाँ

| ग़लतफ़हमी | असलियत |
|---|---|
| "C, A, P में से कोई भी 2 चुनो" | Distributed system में P optional नहीं है; चुनाव partition **के दौरान** C बनाम A का है |
| "हमारा system CA है" | सिर्फ़ single node के लिए सच है। Multi-node systems में partitions होंगे |
| "Available मतलब high uptime" | CAP availability = **हर** non-failed node जवाब दे। CP system का uptime भी बढ़िया हो सकता है |
| "CAP की Consistency = ACID का C" | CAP का C linearizability है; ACID का C rules/invariants के बारे में है |
| "MongoDB CP है, Cassandra AP है" (बस, बात ख़त्म) | दोनों tunable हैं; behaviour concerns, read preference और consistency levels पर निर्भर है |
| "Eventual consistency मतलब data हमेशा के लिए ग़लत रह सकता है" | इसका मतलब है writes रुकने पर replicas converge हो जाते हैं; यह window आमतौर पर milliseconds की होती है |

## 10. Trade-offs: हर feature के हिसाब से चुनना

| Feature | ज़रूरत | सही बैठने वाली settings |
|---|---|---|
| Payment, stock decrement | कभी न खोए, कभी double-sell न हो | Primary, `w: 'majority'`, transactions / sync replication |
| Order history page | Read-your-writes | Primary reads, या `majority` के साथ causal session |
| Product catalogue browse | तेज़, कुछ seconds stale चल जाएगा | Secondary / replica reads, cache |
| Review counts, view counts | तेज़ और available | Eventual, async counters |

**Strong consistency पर ज़ोर कब न दें:** high-volume, low-value data जहाँ freshness से ज़्यादा latency मायने रखती है। **इसे ढीला कब न करें:** पैसा, stock, uniqueness (usernames, coupon redemptions)। ज़्यादातर असली systems दोनों को मिलाते हैं, feature दर feature।
