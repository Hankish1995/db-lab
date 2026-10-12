---
slug: replication-patterns
title: 'Replication patterns: leaders, followers और जब copies आपस में सहमत न हों'
module: Replication & Consistency
summary: 'तीन replication architectures (single-leader, multi-leader, leaderless), synchronous vs asynchronous replication, असली apps में replication lag से होने वाली anomalies, और split brain व lost writes जैसे failover के जाल।'
recap: >-
  Replication एक ही data की copies कई machines पर रखता है, ताकि availability मिले, reads scale हों और latency कम हो।
  Single-leader default और सबसे आसान है; multi-leader कई regions में writes की इजाज़त देता है पर उसे conflict resolution
  चाहिए; leaderless systems quorums इस्तेमाल करते हैं, जहाँ W + R > N होने से reads और writes overlap करते हैं।
  Asynchronous replication तेज़ है, पर failover पर acknowledged writes खो सकता है और lag anomalies पैदा करता है, जिन्हें
  read-your-writes, monotonic reads और consistent prefix guarantees से ठीक किया जाता है। Failover को split brain रोकना
  ही चाहिए, आमतौर पर majority elections और fencing tokens से।
---

## 1. कहानी: एक head chef, कई line cooks

एक restaurant chain अपनी **recipe book** को सारी kitchens में sync रखती है।

- **Single-leader:** सिर्फ़ **head chef** ही recipe बदल सकती है। वो हर बदलाव बाकी kitchens को भेजती है, और वो उसे copy कर लेती हैं। कोई भी किसी भी kitchen में recipe *पढ़* सकता है।
- **Multi-leader:** हर शहर का अपना head chef है जो locally recipes बदल सकता है, और वो आपस में बदलाव exchange करते हैं। हर शहर के लिए तेज़, पर हो सकता है दो chefs एक ही दिन एक ही recipe को अलग-अलग तरीके से बदल दें।
- **Leaderless:** कोई head chef नहीं है। आप एक बदलाव एक साथ कई kitchens को भेजते हैं और जब **काफ़ी** kitchens confirm कर दें तो उसे पूरा मान लेते हैं। पढ़ने के लिए आप कई kitchens से पूछते हैं और सबसे नया version ले लेते हैं।

| Kitchen | Database |
|---|---|
| Head chef | **Leader** (primary) |
| बदलाव copy करने वाली kitchens | **Followers** (replicas, secondaries) |
| भेजे गए बदलावों की list | **Replication log** (WAL, oplog, binlog) |
| वो kitchen जिसे कल का बदलाव अभी तक नहीं मिला | **Replication lag** |
| दो chefs एक ही recipe बदल रहे हैं | **Write conflict** |

यह lesson किसी एक engine से बंधा नहीं है। कोई खास database इसे कैसे करता है, यह देखने के लिए [MongoDB replication](/lessons/mongodb-replication) और [PostgreSQL replication](/lessons/postgres-replication) देखें।

## 2. Replicate करें ही क्यों

- **High availability:** अगर कोई machine मर जाए, तो दूसरी copy संभाल लेती है।
- **Read scaling:** reads को followers पर बाँट दें।
- **Latency:** हर region में users के पास एक copy रखें।
- **Durability:** disk या zone fail होने पर भी data बचा रहता है।

Single-leader systems में replication writes को scale **नहीं** करता: हर follower को हर write apply करना पड़ता है। Writes scale करने के लिए आपको data बाँटना होगा, देखें [Sharding](/lessons/sharding)।

> **याद रखें:** replication एक ही data copy करता है; sharding अलग-अलग data बाँटता है। असली systems दोनों करते हैं।

## 3. Single-leader (leader-follower)

```text
              writes + reads
  App ───────────────────────────►┌──────────┐
                                  │  Leader  │
                                  └────┬─────┘
                 replication log       │
             ┌─────────────────────────┼──────────────┐
        ┌────▼─────┐              ┌────▼─────┐   ┌────▼─────┐
        │ Follower │              │ Follower │   │ Follower │
        └──────────┘              └──────────┘   └──────────┘
             ▲  reads (possibly stale)
```

सारे writes एक ही node से होकर जाते हैं, इसलिए **कोई write conflicts नहीं होते**: order leader तय करता है। PostgreSQL, MySQL, MongoDB replica sets और ज़्यादातर managed databases में यही default है। इसकी कमज़ोरियाँ हैं अकेला writer (throughput की एक सीमा) और वो पल जब leader fail हो जाए (section 7)।

## 4. Multi-leader

हर region में एक leader होता है जो writes accept करता है और बाकियों को asynchronously replicate करता है। Mumbai का user कम latency के साथ Mumbai leader पर write करता है, और अगर Frankfurt का link कट जाए तब भी region काम करता रहता है।

कीमत: **write conflicts**। दो leaders एक-दूसरे के बारे में सुनने से पहले ही एक ही record पर टकराने वाले बदलाव accept कर सकते हैं।

उदाहरण: एक family account की shared cart। Mumbai में Asha जूतों की quantity 2 कर देती है। उसी समय Frankfurt में Ravi जूते हटा देता है। दोनों leaders accept कर लेते हैं। जब वो sync होंगे, तो कौन जीतेगा?

Conflict resolution के विकल्प:

- **Last-write-wins (LWW):** एक timestamp लगाइए; सबसे बड़ा जीतता है, दूसरा **चुपचाप फेंक दिया जाता है**। आसान है, पर यह **data खोता है**, और अलग-अलग machines की clocks drift करती हैं, तो "last" शायद असल में last हो ही न।
- **Application में merge:** दोनों versions (siblings) store करें और code या user को उन्हें resolve करने दें।
- **CRDTs** (Conflict-free Replicated Data Types): ऐसे data structures जो इस तरह design किए गए हैं कि concurrent updates किसी भी order में हों, हमेशा एक ही result में merge होते हैं। जैसे grow-only counter, observed-remove set (cart items के लिए), या collaborative text document। ये data के कुछ खास shapes के लिए अच्छे चलते हैं, "stock negative नहीं होना चाहिए" जैसे मनमाने business rules के लिए नहीं।
- **Conflicts से बचें:** किसी record (जैसे एक user की cart) के सारे writes एक "home" leader पर route करें।

> **याद रखें:** multi-leader, conflict-free writes के बदले local writes देता है। अगर आप अपनी conflict resolution strategy का नाम नहीं बता सकते, तो आपको multi-leader नहीं चाहिए।

## 5. Leaderless (Dynamo-style)

इसे Amazon के 2007 वाले Dynamo paper ने लोकप्रिय बनाया, और Cassandra व Riak जैसे systems इसे इस्तेमाल करते हैं। (ध्यान दें: managed **DynamoDB** service, नाम के बावजूद, अंदर हर partition के लिए एक leader इस्तेमाल करती है।)

Client (या एक coordinator node) हर write को key के सभी **N** replicas को भेजता है और **W** acknowledgements का इंतज़ार करता है; हर read replicas से पूछता है और **R** responses का इंतज़ार करता है, फिर सबसे नए version वाली value लौटाता है।

```text
 N = 3 replicas, W = 2, R = 2

 write v2 ──► A ✅ v2    B ✅ v2    C ✗ (down, still v1)
 read     ──► A: v2      C: v1   → newest wins → v2
                                   + read repair: C ◄── v2
```

अगर **W + R > N** है, तो हर read set हर write set के साथ कम से कम एक node में overlap करता है, इसलिए read आमतौर पर latest successful write देख लेता है। आम choice: N = 3, W = 2, R = 2। Workload के हिसाब से tune करें: तेज़ writes के लिए W = 1, R = N; तेज़ reads के लिए W = N, R = 1 (पर तब एक dead node writes रोक देता है)।

Replicas कैसे catch up करते हैं:

- **Read repair:** जब किसी read को stale replica दिखे, तो वो नई value उसमें वापस लिख देता है।
- **Anti-entropy:** एक background process replicas की तुलना करता है (अक्सर Merkle trees से) और छूटा हुआ data copy करता है।
- **Hinted handoff:** अगर target replica down है, तो कोई दूसरा node write को एक "hint" के साथ store कर लेता है और replica लौटने पर उसे आगे भेज देता है।
- **Sloppy quorum:** outage के दौरान writes ऐसे nodes भी accept कर सकते हैं जो उस key के सामान्य N में नहीं हैं। इससे write availability बढ़ती है, पर इसका मतलब है कि जब तक hints deliver न हों, **W + R > N अब overlap की guarantee नहीं देता**।

Strict quorums के साथ भी कुछ edge cases बचे रहते हैं (concurrent writes, ऐसा write जो W से कम nodes पर सफल हुआ और rollback नहीं हुआ, clock-based conflict resolution)। Quorums काफ़ी हद तक strong consistency देते हैं, पर default रूप से linearizability नहीं।

| | Single-leader | Multi-leader | Leaderless |
|---|---|---|---|
| Writes कौन accept करता है | एक leader | हर region/DC में एक leader | कोई भी replica (quorum) |
| Write conflicts | कोई नहीं | हाँ, resolve करने होंगे | हाँ, resolve करने होंगे |
| Failure पर write availability | Failover तक रुकावट | High | High |
| Read-your-writes | आसान (leader से पढ़ें) | हर region में | Quorums से |
| Complexity | Low | High | Medium–high |
| उदाहरण | PostgreSQL, MySQL, MongoDB | Multi-region active-active setups, offline-first apps | Cassandra, Riak, ScyllaDB |

## 6. Synchronous vs asynchronous

- **Synchronous:** leader client को acknowledge करने से पहले किसी follower के confirm करने का इंतज़ार करता है। Leader मर जाए तब भी write बचा रहता है, पर हर write उतना ही धीमा होता है जितना सबसे धीमा synchronous follower, और अगर वो follower down है तो writes अटक जाते हैं।
- **Asynchronous:** leader तुरंत acknowledge कर देता है और बदलाव background में भेजता है। तेज़ और available, पर अगर leader मर गया तो **जो writes अभी replicate नहीं हुए वो खो जाते हैं**।
- **Semi-synchronous / quorum:** सबका नहीं, एक follower या majority का इंतज़ार करें। यही आम बीच का रास्ता है: PostgreSQL का `synchronous_standby_names` with `ANY 1 (...)`, MongoDB का `writeConcern: { w: 'majority' }`।

यह [CAP and PACELC](/lessons/cap-and-pacelc) का "else latency vs consistency" वाला हिस्सा है: network partition न होने पर भी, ज़्यादा मज़बूत replication guarantees की कीमत latency में चुकानी पड़ती है।

> **याद रखें:** "async" का मतलब है कि database ने OK तब बोल दिया जब data कहीं और safe नहीं था। जानिए कि आपके कौन से writes यह जोखिम उठा सकते हैं।

## 7. Replication lag: तीन anomalies और उनके fixes

Asynchronous followers के साथ, एक replica milliseconds से लेकर minutes तक पीछे हो सकता है। उससे होने वाले reads अतीत देखते हैं। तीन guarantees मदद करती हैं, हर एक के साथ एक e-commerce कहानी।

### Read-your-writes (read-after-write)

Asha अपना delivery address update करती है, page reload होता है, और read एक पिछड़े हुए replica पर जाता है: **उसे पुराना address दिखता है** और वो सोचती है कि save fail हो गया।

Fixes:

- User जो data edit कर सकता है, उसे **leader से** पढ़ें, कम से कम उसके write करने के बाद थोड़ी देर (मान लीजिए 10–60 s) तक।
- Write की position (log sequence number, optime) track करें और सिर्फ़ उसी replica से पढ़ें जो वहाँ तक catch up कर चुका हो। MongoDB के **causally consistent sessions** यह आपके लिए करते हैं।
- जब तक "recently wrote" flag set है, उस user के reads leader पर route करें।

### Monotonic reads

Asha अपना order page refresh करती है। पहली request replica 1 पर जाती है: **"Shipped"**। दूसरी request ज़्यादा पिछड़े replica 2 पर जाती है: **"Processing"**। उसका order समय में पीछे चला गया।

Fix: हर user को **एक ही replica** से पढ़वाएँ (जैसे user ID को hash करके replica चुनें), और failover सिर्फ़ तब करें जब वो unhealthy हो। उसे अब भी थोड़ा पुराना data दिख सकता है, पर कभी भी उससे पुराना नहीं जो वो पहले देख चुकी है।

### Consistent prefix reads

किसी product के Q&A पर, एक buyer पूछता है "Is this waterproof?" और seller जवाब देता है "Yes"। Partitioned system में question और answer अलग-अलग partitions में हो सकते हैं जिनका lag अलग है, इसलिए किसी दूसरे shopper को question मौजूद होने से पहले ही **"Yes"** दिख जाता है। Effects, causes से पहले दिखते हैं।

Fix: causally related data को **एक ही partition** में लिखें (जैसे Q&A को product के हिसाब से partition करें), या causal dependencies track करें ताकि कोई write उससे पहले न दिखे जिस पर वो निर्भर है।

| Anomaly | User को क्या दिखता है | आम fix |
|---|---|---|
| Read-your-writes | उसका अपना बदलाव "गायब" हो जाता है | Leader से पढ़ें / replica के catch up करने का इंतज़ार करें |
| Monotonic reads | Data समय में पीछे जाता है | हर user के लिए sticky replica |
| Consistent prefix | Question से पहले answer | Related writes के लिए same partition |

## 8. Failover: जहाँ असल में चीज़ें बिगड़ती हैं

जब leader मरता है, तो system को उसे **detect** करना होता है (आमतौर पर timeout से), नया leader **चुनना** होता है (सबसे up-to-date follower, election या orchestrator से) और clients को **reroute** करना होता है। हर कदम fail हो सकता है।

### Async leader से lost writes

पुराने leader ने order #1001 acknowledge किया, फिर उसे replicate करने से पहले crash हो गया। नए leader ने उसे कभी देखा ही नहीं। जब पुराना leader वापस आता है, तो उसके un-replicated writes नई history से टकराते हैं और आमतौर पर **discard या rollback** कर दिए जाते हैं (MongoDB उन्हें rollback files में लिख देता है)। अगर दूसरे systems ने वो IDs पहले ही इस्तेमाल कर लिए हों (cache, email, payment), तो अब आपके systems के बीच inconsistencies हैं। ज़रूरी writes के लिए majority acknowledgement माँगने से यह टल जाता है।

### Split brain

एक network glitch की वजह से followers को लगता है कि leader मर गया। वो नया leader चुन लेते हैं, पर पुराना ज़िंदा है और कुछ clients से अब भी writes accept कर रहा है। **दो leaders**, दो अलग होती histories।

बचाव:

- **Majority (quorum) elections:** leader को majority के votes चाहिए, और जो leader majority से संपर्क खो देता है वो खुद हट जाता है। Voters की संख्या odd हो, तो partition की सिर्फ़ एक तरफ़ majority हो सकती है।
- **Fencing tokens:** हर नए leader (या lock holder) को एक strictly बढ़ता हुआ number मिलता है: एक **term** या **epoch**। Storage और downstream services अब तक देखा गया सबसे बड़ा token याद रखते हैं और **पुराना token लेकर आने वाले writes reject कर देते हैं**।

```text
 Old leader (token 33) pauses for a long GC ...
 New leader elected      → token 34 → write accepted, store sees 34
 Old leader wakes, writes → token 33 → rejected: 33 < 34 ✅
```

- **STONITH** ("shoot the other node in the head"): पुराने leader को ज़बरदस्ती power off या isolate कर दें। असरदार, पर भद्दा तरीका।

### Timeout चुनना

बहुत छोटा रखें तो धीमा network या GC pause बेवजह failovers trigger कर देता है (हर एक की कीमत थोड़ी देर का write outage है)। बहुत लंबा रखें तो leader सच में मरने पर आप ज़्यादा देर down रहते हैं। कोई universal सही value नहीं है; यह आपके network और load पर निर्भर करता है।

> **याद रखें:** failover तभी safe है जब पुराना leader अब write न कर सके। Majority elections और fencing tokens से आप यह पक्का करते हैं।

## 9. आम गलतियाँ

- **सारे** reads replicas पर भेज देना और "save then view" flows तोड़ देना।
- Lag monitor किए बिना मान लेना कि replicas "बस कुछ ms पीछे" हैं; भारी writes, replicas पर लंबी queries या network issues इसे minutes तक पहुँचा सकते हैं।
- Multi-leader setup में ऐसे data के लिए **LWW** इस्तेमाल करना जिसे आप खो नहीं सकते, जैसे orders या payments।
- यह मानना कि **W + R > N** का मतलब linearizable है। ऐसा नहीं है, खासकर sloppy quorums के साथ।
- **दो** voting nodes चलाना, जहाँ एक भी failure के बाद कोई majority नहीं बचती।
- Replication को **backup** समझना। `WHERE` के बिना एक `DELETE` तुरंत हर copy पर replicate हो जाता है।

## 10. Trade-offs: कौन सा pattern कब

- **Single-leader** लगभग हर OLTP system के लिए सही default है, e-commerce checkout समेत। जिस data को आप खो नहीं सकते उसके लिए semi-sync या majority writes जोड़ें।
- **Multi-leader** उन multi-region apps के लिए ठीक है जिन्हें region isolation के दौरान भी locally writes accept करने हैं, offline-first clients और collaborative editing के लिए भी, बशर्ते data merge हो सके (CRDTs) या conflicts कम ही हों।
- **Leaderless** बहुत ज़्यादा write availability और throughput के लिए ठीक है जहाँ eventual consistency चल जाती है: event data, activity logs, carts, IoT। Data को ऐसे model करें कि conflicts कम हों या merge हो सकें।

गहरा सवाल हमेशा एक ही है: **कौन से reads को latest write देखना ही चाहिए, और उसके लिए आप कितनी कीमत चुकाने को तैयार हैं?**
