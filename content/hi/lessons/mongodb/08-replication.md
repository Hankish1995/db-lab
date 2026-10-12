---
slug: mongodb-replication
title: 'Replication: copies रखना ताकि एक failure कभी आपको गिरा न सके'
module: Scaling
summary: 'MongoDB replica set oplog के ज़रिए data कैसे copy करता है, एक primary fail होने पर नया primary कैसे चुनता है, और इसका आपके writes और reads के लिए क्या मतलब है।'
recap: >-
  Replica set में एक primary होता है जो सारे writes लेता है, और secondaries जो उसका oplog copy करते हैं,
  जो idempotent operations की एक capped collection है। Members हर 2 seconds में heartbeats भेजते हैं; अगर
  primary लगभग 10 seconds तक नहीं मिलता, तो votes की majority वाले members नया primary चुनते हैं। जो writes
  majority ने acknowledge नहीं किए, वो failover के बाद rollback हो सकते हैं, इसीलिए w majority ज़रूरी है।
  Replication availability और read copies देता है, ज़्यादा write capacity नहीं और backups भी नहीं।
---

## 1. कहानी

एक व्यस्त restaurant में एक **head chef** और दो **assistant chefs** हैं।

- Recipe में बदलाव सिर्फ़ **head chef** तय करता है: "curry में थोड़ा और नमक डालो"। हर बदलाव एक **recipe change log** में जाता है।
- Assistants लगातार **log पढ़ते रहते हैं** और वही बदलाव अपनी recipe book की copy में करते रहते हैं।
- हर दो-एक seconds में chefs **एक-दूसरे पर नज़र डालते हैं** कि सब मौजूद हैं या नहीं।
- अगर head chef गिर जाए, तो assistants यह नोटिस करते हैं और अपने में से किसी एक को कमान सौंपने के लिए **vote** करते हैं। Kitchen चलता रहता है।

**यही है replica set.**

| Restaurant | MongoDB |
|---|---|
| Head chef | **Primary**: अकेला member जो writes लेता है |
| Assistant chefs | **Secondaries**: primary का data copy करते हैं |
| Recipe change log | **Oplog** (operations log) |
| एक-दूसरे पर नज़र डालना | **Heartbeats** |
| नए head chef के लिए vote | **Election** |
| गिरने के बाद कमान संभालना | **Failover** |

> **याद रखें:** replica set = एक primary जो writes लेता है + secondaries जो उसका किया हर काम copy करते हैं।

## 2. यह क्यों है

एक ही server के साथ:

- अगर वो **crash** हो जाए, तो आपकी दुकान offline है।
- अगर उसकी **disk मर जाए**, तो आपका data जा सकता है।
- **Maintenance** (upgrades, OS patches) का मतलब है downtime।

Replication इसे **redundancy** और **automatic failover** से ठीक करता है। यह आपको कुछ reads (analytics, reports) secondaries पर भेजने देता है।

यह आपको क्या **नहीं** देता: ज़्यादा **write** capacity। सारे writes अब भी एक primary पर ही जाते हैं। उसके लिए आपको [Sharding](/lessons/sharding) चाहिए।

## 3. यह कैसे काम करता है

### Standard 3-member replica set

```text
                    ┌─────────────────┐
     App (driver) ─►│     PRIMARY     │◄── all writes
                    │  oplog: op1..n  │
                    └───┬─────────┬───┘
      oplog + heartbeat │         │ oplog + heartbeat
         ┌──────────────┘         └─────────────┐
         ▼                                      ▼
 ┌─────────────────┐   heartbeats   ┌─────────────────┐
 │   SECONDARY A   │◄──────────────►│   SECONDARY B   │
 │ applies oplog   │                │ applies oplog   │
 └─────────────────┘                └─────────────────┘
```

आपका driver एक connection string से connect करता है जिसमें members की list होती है (या एक `mongodb+srv://` address), और खुद पता लगा लेता है कि primary कौन है।

```text
mongodb://db1:27017,db2:27017,db3:27017/shop?replicaSet=rs0
```

### Oplog

**Oplog** (`local.oplog.rs`) हर member पर एक **capped collection** है: एक fixed-size log जिसमें भरने पर सबसे पुरानी entries overwrite हो जाती हैं।

जब primary कोई write संभालता है, तो वो data बदलता है **और** अपने oplog में एक entry जोड़ता है। हर secondary एक oplog को **tail** करता है (जैसे किसी file पर `tail -f`), नई entries खींचता है, उन्हें अपने data पर लागू करता है, और अपने oplog में लिखता है।

Oplog entries **idempotent** होती हैं: एक entry को दो बार लागू करने पर भी result वही रहता है। MongoDB instruction नहीं, उसका *असर* record करता है:

```js
// You run on the primary:
db.products.updateOne({ _id: 'KB-1' }, { $inc: { stock: -2 } })   // stock 10 → 8

// The oplog stores the resulting value, not "decrement by 2" (entry simplified):
// { op: 'u', ns: 'shop.products', o2: { _id: 'KB-1' }, o: { $v: 2, diff: { u: { stock: 8 } } } }
```

"stock को 8 set करो" दो बार replay करना नुकसान नहीं करता; "2 घटाओ" दो बार replay करने से data खराब हो जाएगा।

⚠️ अगर कोई secondary oplog window (oplog कितना समय cover करता है) से ज़्यादा देर offline रहे, तो वो **oplog से गिर जाता है** और उसे पूरा **initial sync** चाहिए। Oplog का size अपनी maintenance windows के हिसाब से रखें।

> **याद रखें:** oplog बदलावों का एक capped, idempotent log है। Secondaries इसे tail करके sync में रहते हैं।

### Heartbeats और elections

- Members एक-दूसरे को **हर 2 seconds** में **heartbeats** भेजते हैं।
- अगर primary **`electionTimeoutMillis`** (default **10 seconds**) के अंदर जवाब न दे, तो एक eligible secondary **election** बुलाता है।
- जीतने के लिए candidate को **voting members की majority** के votes चाहिए। सबसे नए data और ज़्यादा **priority** वाले member को तरजीह मिलती है।
- Default settings के साथ, पुराने primary के fail होने के **लगभग 10–12 seconds के अंदर** आम तौर पर नया primary चुन लिया जाता है।

### Voting members की संख्या odd क्यों?

जीतने वाले को *सभी* voting members की **strict majority** चाहिए, सिर्फ़ उनकी नहीं जिन तक पहुँचा जा सकता है।

| Voting members | ज़रूरी majority | कितने failures झेल सकता है |
|---|---|---|
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |

चौथा member खर्च बढ़ाता है लेकिन **कोई extra fault tolerance नहीं** देता। इससे भी बुरा, 2 + 2 का network split होने पर **किसी भी side** के पास majority नहीं रहती, तो कोई primary ही नहीं होता। Majority का नियम ही **split brain** को भी रोकता है: एक ही समय पर दो primaries का writes लेना।

एक replica set में 50 तक members हो सकते हैं, लेकिन ज़्यादा से ज़्यादा **7 voting** members।

> **याद रखें:** elections को सभी voters की majority चाहिए। 3 या 5 voting members रखें, कभी 2 या 4 नहीं।

## 4. Failover के दौरान आपके writes का क्या होता है

```text
 t=0s    Primary db1 crashes
 t=0-10s No heartbeat answers; writes to db1 fail
 t=~10s  db2 calls an election, db3 votes yes → db2 is PRIMARY
 t=~12s  Drivers discover db2 and send writes there
```

उस window के दौरान **कोई primary नहीं होता**, इसलिए writes "not primary" जैसे errors या network errors के साथ fail होते हैं।

### Retryable writes

Modern drivers default रूप से **retryable writes** चालू रखते हैं (`retryWrites=true`)। अगर कोई write network error या "not primary" से fail होता है, तो driver नया primary ढूँढकर उसे **एक बार retry करता है**। Server एक transaction ID इस्तेमाल करता है ताकि retry से write दो बार लागू न हो। इसलिए ज़्यादातर failovers app को दिखते ही नहीं, बस कुछ seconds की latency के अलावा।

### Rollback: वो write जो गायब हो जाता है

मान लीजिए आप `w: 1` इस्तेमाल करते हैं:

1. db1 (primary) एक order लेता है और "OK" जवाब देता है।
2. db2 और db3 के उसे copy करने से **पहले** db1 crash हो जाता है।
3. db2 primary बनता है और नए writes लेता है। Order वहाँ नहीं है।
4. db1 secondary बनकर वापस आता है। उसका data अलग हो चुका है, इसलिए वो unreplicated order को **rollback** कर देता है, और उसे manual जाँच के लिए disk पर एक rollback file में save कर देता है।

आपके customer ने "Order confirmed" देखा, लेकिन order database से गायब है।

**`w: 'majority'`** के साथ, write तभी acknowledge होता है जब majority के पास वो पहुँच जाए। अगला election जीत सकने वाले हर member के पास वो write ज़रूर होगा, इसलिए **majority-acknowledged writes कभी rollback नहीं होते**। इसीलिए MongoDB 5.0 से ज़्यादातर deployments के लिए `w: 'majority'` default है (देखें [Transactions और concerns](/lessons/mongodb-transactions))।

> **याद रखें:** `w: 1` writes failover के बाद rollback हो सकते हैं। `w: 'majority'` writes नहीं।

## 5. Replication lag और secondaries से पढ़ना

Replication **asynchronous** है। एक secondary primary से milliseconds (या भारी load में seconds या उससे ज़्यादा) पीछे हो सकता है। इस देरी को **replication lag** कहते हैं।

```js
// In mongosh: how far behind is each secondary?
rs.printSecondaryReplicationInfo()
rs.status()   // member states, optimes, health
```

अगर आप secondaries से पढ़ते हैं (`readPreference: 'secondaryPreferred'`), तो आपको **stale reads** मिल सकते हैं:

1. एक customer अपना shipping address update करता है (write → primary)।
2. अगला page profile को एक पीछे चल रहे secondary से पढ़ता है।
3. उसे **पुराना address** दिखता है और वो सोचता है कि save fail हो गया।

Secondary reads को **analytics, reports और search pages** के लिए इस्तेमाल करें जो थोड़ा पुराना data झेल सकते हैं। Read-after-write के लिए primary से पढ़ें या causally consistent session इस्तेमाल करें।

## 6. Member types

| Member | Vote देता है? | Primary बन सकता है? | App reads को दिखता है? | Use case |
|---|---|---|---|---|
| Regular secondary | ✅ | ✅ | ✅ | Default |
| **Priority 0** | ✅ | ❌ | ✅ | कमज़ोर machine या दूर के data centre में member |
| **Hidden** | ✅ (vote कर सकता है) | ❌ (priority 0) | ❌ | Dedicated reporting या backup node |
| **Delayed** | ✅ (vote कर सकता है) | ❌ (hidden, priority 0) | ❌ | बदलाव जैसे 1 घंटा देर से लागू करता है, "oops, मैंने collection drop कर दी" के खिलाफ़ safety net |
| **Arbiter** | ✅ | ❌ | ❌ (कोई data नहीं रखता) | सिर्फ़ tie-breaker vote |

```js
// Make member 2 a delayed, hidden copy one hour behind
cfg = rs.conf()
cfg.members[2].priority = 0
cfg.members[2].hidden = true
cfg.members[2].secondaryDelaySecs = 3600
rs.reconfig(cfg)
```

### Arbiters की सलाह क्यों नहीं दी जाती

एक **arbiter** vote करता है लेकिन कोई data store नहीं करता। Primary-Secondary-Arbiter (PSA) set एक सस्ते 3-member set जैसा दिखता है, लेकिन उसमें data की सिर्फ़ **दो copies** होती हैं:

- अगर secondary down हो जाए, तो सिर्फ़ एक data-bearing member बचता है, इसलिए **`w: 'majority'` writes acknowledge नहीं हो सकते**। वो `wtimeout` तक block रहते हैं।
- इसी वजह से, कुछ arbiter setups में default write concern `w: 1` पर आ जाता है, जिससे rollback का जोखिम लौट आता है।
- जब तक secondary down है, majority-committed data आगे नहीं बढ़ सकता, जिससे primary पर **cache pressure** बन सकता है।

जब भी खर्च उठा सकें, **तीसरा data-bearing member** ही रखें।

> **याद रखें:** arbiter आपको एक vote देता है, copy नहीं। तीन असली data-bearing members दो + एक arbiter से बेहतर हैं।

## 7. एक practical बात: MongoDB Atlas

**Free Atlas cluster** भी एक **3-member replica set** है। इसीलिए transactions, change streams और `w: 'majority'` Atlas पर out of the box चलते हैं, लेकिन एक सादे local `mongod` पर नहीं। Local पर यही पाने के लिए `mongod` को `--replSet rs0` के साथ start करें और एक बार `rs.initiate()` चलाएँ।

## 8. आम गलतियाँ और gotchas

- **Replication को backup समझना।** अगर आप `db.orders.deleteMany({})` चलाते हैं, तो हर secondary भी ईमानदारी से सब कुछ delete कर देता है। आपको फिर भी असली backups चाहिए (snapshots, point-in-time restore)। Delayed member मदद करता है, लेकिन वो backup strategy नहीं है।
- **ज़रूरी data के लिए `w: 1` इस्तेमाल करना** और failover के बाद rollbacks देखकर हैरान होना।
- Read-after-write pages के लिए **secondaries से पढ़ना**, जिससे "मेरा बदलाव save नहीं हुआ" वाले bugs आते हैं।
- Replica set connection string के बजाय **एक ही host से connect करना**, जिससे driver failover को follow नहीं कर पाता।
- **दो data centres में voters का बराबर बँटवारा:** अगर उनके बीच का link टूटे, तो किसी भी side के पास majority नहीं रहती।
- भारी write bursts के लिए **बहुत छोटा oplog**, जिससे पीछे चल रहे secondaries गिर जाते हैं और उन्हें पूरा resync चाहिए।
- **Secondaries से writes scale होने की उम्मीद करना।** वो भी हर write लागू करते हैं, इसलिए उतने ही व्यस्त रहते हैं।

## 9. इन्हें आपस में न मिलाएँ

| | Replication | Sharding | Backup |
|---|---|---|---|
| यह क्या करता है | कई machines पर **एक ही data** | हर machine पर **अलग data** | कहीं और रखी **point-in-time copy** |
| किससे बचाता है | Server या disk failure | Capacity खत्म होना | गलत deletes, corruption, ransomware |
| Writes scale करता है | ❌ | ✅ | ❌ |
| Reads scale करता है | ⚠️ stale reads के साथ | ✅ | ❌ |
| गलती undo करना | ❌ (गलतियाँ भी replicate होती हैं) | ❌ | ✅ |

Production में आप **तीनों** इस्तेमाल करते हैं: हर shard एक replica set है, और पूरे cluster का backup होता है।

## 10. Trade-offs

- **खर्च:** तीन data-bearing members का मतलब है तीन गुना storage और servers।
- **Write latency:** `w: 'majority'` कम से कम एक secondary के confirm करने का इंतज़ार करता है, जिससे एक network round trip जुड़ जाता है।
- **Stale reads**, अगर आप reads को secondaries पर भेजते हैं।
- **Failover तुरंत नहीं होता:** कुछ seconds बिना primary के रहने की उम्मीद रखें। Retryable writes इसका ज़्यादातर हिस्सा छिपा लेते हैं, लेकिन आपके app में timeouts और error handling फिर भी मायने रखते हैं।

लगभग हर production MongoDB deployment के लिए ये खर्च उठाने लायक हैं। Standalone server local development के लिए ठीक है, और किसी चीज़ के लिए नहीं।
