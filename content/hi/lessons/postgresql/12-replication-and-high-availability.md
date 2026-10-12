---
slug: postgres-replication
title: 'Replication और high availability: copies, failover और backups'
module: Scaling
summary: 'PostgreSQL WAL को standby servers तक कैसे stream करता है, async बनाम sync का trade-off, replication lag और slots, logical replication, failover असल में कैसे होता है, और backups एक अलग चीज़ क्यों हैं।'
recap: >-
  PostgreSQL का primary अपना WAL standbys को stream करता है, जो उसे replay करते हैं और read-only queries
  serve कर सकते हैं। Replication default रूप से asynchronous है, इसलिए crash होने पर आख़िरी commits खो सकते हैं
  और replicas पीछे (lag) रह सकते हैं; synchronous commit यह नुकसान ख़त्म करता है, लेकिन latency और
  availability की कीमत पर। Slots वह WAL संभालकर रखते हैं जिसकी replica को अभी ज़रूरत है, लेकिन छोड़ दिए जाएँ
  तो disk भर सकते हैं। PostgreSQL ख़ुद failover नहीं करता: Patroni जैसे tools या managed service एक standby
  को promote करते हैं और पुराने primary को fence करते हैं। Replication backup नहीं है; PITR के लिए base
  backup और archived WAL चाहिए।
---

## 1. कहानी

एक bank का head office हर transaction को ledgers छूने से पहले एक **journal** में लिखता है। एक courier हर नया journal page दो **branch offices** तक ले जाता है, जो entries को अपने ledgers में copy कर लेती हैं।

- Customers branch पर **सवाल पूछ सकते हैं** ("मेरा balance कितना है?"), लेकिन **deposits सिर्फ़ head office लेता है**।
- अगर courier धीमा है, तो branch **कुछ pages पीछे** हो सकती है।
- अगर head office जल जाए, तो branches **ख़ुद तय नहीं करतीं** कि कौन कमान संभालेगा। फ़ोन लिए एक **manager** देखता है कि कौन up to date है, नया head office नियुक्त करता है, और पक्का करता है कि पुराना office दोबारा खुल भी जाए तो बंद ही रहे।
- इनमें से कुछ भी उस हालत से नहीं बचाता जब कोई clerk **ग़लत entry लिख दे**: courier ग़लतियाँ भी copy करता है। उसके लिए आप एक vault में **archived journals** रखते हैं।

| Bank | PostgreSQL |
|---|---|
| Journal | **WAL** (write-ahead log) |
| Head office | **Primary**: अकेला server जो writes लेता है |
| Branch offices | **Standbys** (replicas) |
| Branch पर सवालों के जवाब देना | **Hot standby**: read-only queries |
| Courier | **Streaming replication** (walsender → walreceiver) |
| पीछे छूटे pages | **Replication lag** |
| Manager | **Patroni** जैसा failover tool, या आपका cloud provider |
| पुराने office को बंद रखना | **Fencing** |
| Vault में archived journals | **Base backup + WAL archive** |

> **याद रखें:** standby एक copy है जो लगातार primary का WAL replay करती रहती है। यह availability और reads के लिए है, ग़लतियाँ undo करने के लिए नहीं।

## 2. यह क्यों है

एक अकेला server single point of failure है: ख़राब disk, crash हुई VM या OS upgrade आपकी shop को offline कर देता है। Replication आपको देता है:

- **High availability (HA):** एक standby जो seconds से minutes में primary बन सकता है।
- **Read scaling:** reports, search pages और analytics replicas पर।
- **Disaster recovery:** किसी दूसरे zone या region में एक copy।

यह write capacity **नहीं** बढ़ाता: हर standby हर write को replay करता है। उसके लिए [Sharding](/lessons/sharding) देखें।

## 3. Physical streaming replication कैसे काम करता है

हर change पहले **WAL** में लिखा जाता है ([PostgreSQL architecture](/lessons/postgres-architecture) देखें)। WAL source of truth है: crash के बाद PostgreSQL इसे replay करके अपनी data files दोबारा बनाता है। Standby बस यही काम **हमेशा** करता रहता है: वह recovery mode में रहता है, primary से WAL लेता है और उसे replay करता है।

```text
  App ── writes ──►┌──────────────────┐
                   │     PRIMARY      │
                   │ WAL ... 0/5050E9 │
                   └──┬────────────┬──┘
           walsender  │            │  walsender
          ┌───────────┘            └───────────┐
 ┌────────▼────────┐                  ┌────────▼────────┐
 │    STANDBY 1    │                  │    STANDBY 2    │
 │ walreceiver     │                  │ walreceiver     │
 │ replays WAL     │                  │ replays WAL     │
 │ read-only SQL ◄─┼── App reads ────►┼─ read-only SQL  │
 └─────────────────┘                  └─────────────────┘
```

मुख्य बातें:

- यह **physical** है: data pages के bytes, इसलिए standby **पूरे cluster** (सभी databases) की block-level पर हूबहू copy होता है, और **same major version** पर।
- Standby एक **base backup** से बनता है, जैसे `pg_basebackup -h primary -U replicator -D /data -R`। `-R` flag `standby.signal` और `primary_conninfo` लिख देता है, ताकि वह standby के रूप में start हो।
- **`hot_standby = on`** (default) के साथ standby **read-only** queries serve करता है। Writes `cannot execute INSERT in a read-only transaction` के साथ fail होते हैं।

इसे primary पर monitor करें:

```sql
SELECT application_name, state, sync_state, replay_lag,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS bytes_behind
FROM pg_stat_replication;
```

एक **LSN** (log sequence number, जैसे `0/5050E988`) WAL में एक position है। LSNs की तुलना करके आपको ठीक-ठीक पता चलता है कि standby कितना पीछे है।

## 4. Asynchronous बनाम synchronous replication

Default रूप से replication **asynchronous** है: primary commit करता है, app को "OK" का जवाब देता है, और WAL बाद में भेजता है।

```text
 ASYNCHRONOUS (default)
 App          Primary                  Standby
  │── COMMIT ──►│ write + flush WAL       │
  │◄──── OK ────┤                         │
  │             ├──── WAL (soon after) ──►│ replay

 SYNCHRONOUS (synchronous_commit = on)
 App          Primary                  Standby
  │── COMMIT ──►│ write + flush WAL       │
  │             ├──── WAL ───────────────►│ flush to disk
  │             │◄─────────── ack ────────┤
  │◄──── OK ────┤                         │
```

Async में, अगर primary "OK" बोलने के ठीक बाद मर जाए, तो आख़िरी कुछ commits **standby तक कभी नहीं पहुँचते**। उसे promote करें, और वे orders ग़ायब।

Synchronous करने के लिए उन standbys के नाम दें जिनकी confirmation का commits को इंतज़ार करना होगा:

```sql
-- postgresql.conf on the primary (application_name of each standby)
-- synchronous_standby_names = 'ANY 1 (standby1, standby2)'
-- synchronous_commit = on
```

`synchronous_commit` तय करता है कि commit return होने से पहले standby को **कितनी दूर** तक पहुँचना होगा:

| Value | Commit किसका इंतज़ार करता है… | Data खोता है अगर… |
|---|---|---|
| `off` | किसी का नहीं; local WAL flush भी async है | Primary crash हो (आख़िरी कुछ सौ ms; कोई corruption नहीं) |
| `local` | सिर्फ़ local WAL flush | WAL भेजे जाने से पहले primary खो जाए |
| `remote_write` | Standby ने उसे **receive करके write** कर दिया (OS cache) | Primary और standby दोनों का OS crash हो |
| `on` (default) | Standby ने उसे disk पर **flush** कर दिया | दोनों servers की disks खो जाएँ |
| `remote_apply` | Standby ने उसे **replay** कर दिया: वहाँ queries को दिखता है | `on` जैसा ही, और सबसे धीमा |

`synchronous_standby_names` के बिना `on`, `remote_write` और `remote_apply` सब `local` जैसे बर्ताव करते हैं। इसीलिए default PostgreSQL "locally durable, replicas के लिए async" है।

Trade-off:

- **Latency:** हर commit एक network round trip का इंतज़ार करता है (regions के पार और बुरा)।
- **Availability:** अगर ज़रूरी standby down है, तो commits fail नहीं होते, **अटक जाते हैं**। `FIRST 1 (standby1)` और एक standby के साथ, standby का outage आपके writes रोक देता है। दो standbys के साथ `ANY 1 (standby1, standby2)` इससे बचाता है।
- इसे **हर transaction के हिसाब से** set किया जा सकता है: कम क़ीमत वाले events के लिए `SET LOCAL synchronous_commit = off`, payments के लिए पूरा sync।

> **याद रखें:** async = तेज़, लेकिन failover में आख़िरी commits खो सकते हैं। Sync = कोई नुकसान नहीं, लेकिन धीमे commits जो कोई sync standby न मिलने पर अटक जाते हैं।

## 5. Replication lag और read-your-writes

Async replicas के साथ, standby milliseconds (या load में seconds या minutes) पीछे हो सकता है। Classic bug:

1. एक customer अपना shipping address बदलता है (write → primary)।
2. अगला page profile को replica से पढ़ता है।
3. उसे **पुराना address** दिखता है और वह सोचता है कि save fail हो गया।

व्यावहारिक fixes, सबसे simple से शुरू करके:

- **Write के बाद primary से पढ़ें**, जैसे उस user के लिए अगले कुछ seconds तक, या सभी "my account" pages के लिए।
- **Sticky sessions:** जिस user ने अभी write किया है, उसे थोड़ी देर के लिए primary पर route करें।
- **LSN check करें:** write के बाद primary की WAL position याद रखें, और सिर्फ़ वही replica use करें जो उससे आगे तक replay कर चुकी है।

```js
// After a write on the primary
const { rows } = await primary.query('SELECT pg_current_wal_lsn() AS lsn');
req.session.minLsn = rows[0].lsn;

// Before a read: is the replica caught up?
async function poolFor(minLsn) {
  if (!minLsn) return replica;
  const { rows } = await replica.query(
    'SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS ok', [minLsn]);
  return rows[0].ok ? replica : primary;
}
```

`synchronous_commit = remote_apply` भी **synchronous** standbys पर read-your-writes की guarantee देता है, लेकिन हर commit पर latency की कीमत के साथ।

⚠️ Standby पर लंबी queries `canceling statement due to conflict with recovery` के साथ **cancel** हो सकती हैं, जब replay को ऐसी rows हटानी हों जिन्हें query अभी भी देख रही है। `max_standby_streaming_delay` (default 30 s) तय करता है कि replay कितनी देर इंतज़ार करे; `hot_standby_feedback = on` ज़्यादातर cancellations रोकता है, लेकिन **primary पर bloat** पैदा कर सकता है, क्योंकि VACUUM को वे पुरानी rows रखनी पड़ती हैं।

## 6. Replication slots

आम तौर पर primary पुरानी WAL files को तब recycle कर देता है जब उसे उनकी ज़रूरत नहीं रहती। अगर कोई standby एक घंटे के लिए disconnect हो जाए और जिस WAL की उसे ज़रूरत है वह जा चुका हो, तो वह catch up नहीं कर पाता और उसे नए base backup से दोबारा बनाना पड़ता है।

**Replication slot** इसे ठीक करता है: primary **वह सारा WAL रखता है जिसे slot के consumer ने अभी confirm नहीं किया**।

ख़तरा: एक **abandoned slot** (delete की गई replica, बंद पड़ी CDC pipeline) primary को WAL **हमेशा** रखने पर मजबूर करता है। `pg_wal` तब तक बढ़ता है जब तक **disk भर न जाए और primary रुक न जाए**। यह PostgreSQL के सबसे आम outages में से एक है।

```sql
SELECT slot_name, slot_type, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;

SELECT pg_drop_replication_slot('old_replica');   -- when it's truly unused
```

Safety nets: `active = false` या बढ़ते `retained_wal` पर alert लगाएँ, और **`max_slot_wal_keep_size`** set करें, ताकि disk भरने की जगह slot invalidate हो जाए।

> **याद रखें:** replication slot WAL रखने का एक वादा है। Unused slot यह वादा तब तक निभाता है जब तक आपकी disk भर न जाए।

## 7. Logical replication

**Logical replication** raw pages की जगह WAL से decode किए गए **row changes** ("`products` में यह row insert करो") भेजता है। इसके लिए `wal_level = logical` चाहिए।

```sql
-- On the source
CREATE PUBLICATION shop_pub FOR TABLE products, orders;

-- On the target (tables must already exist there)
CREATE SUBSCRIPTION shop_sub
  CONNECTION 'host=old-db dbname=shop user=replicator'
  PUBLICATION shop_pub;
```

इस्तेमाल: कम downtime के साथ **major-version upgrades**, **कुछ tables** को दूसरे database में copy करना, और **change data capture (CDC)** (जैसे Debezium से changes को Kafka में stream करना)।

| | Physical (streaming) | Logical |
|---|---|---|
| Unit | WAL bytes / pages | हर table के row changes |
| Scope | पूरा cluster | चुनी हुई tables |
| Versions | Same major version | अलग हो सकते हैं (upgrades) |
| Target | Read-only standby | सामान्य writable database |
| DDL (schema changes) | Replicate होते हैं | ❌ Replicate नहीं होते, ख़ुद apply करें |
| आम इस्तेमाल | HA, read replicas | Upgrades, partial copies, CDC |

Gotchas: `UPDATE`/`DELETE` के लिए tables में **primary key** (या replica identity) चाहिए, और sequences को अलग से संभालना पड़ता है।

## 8. Failover: नया primary कौन चुनता है?

**PostgreSQL ख़ुद कभी नया primary elect नहीं करता।** Standby तभी primary बनता है जब उसे कहा जाए: `pg_ctl promote` या `SELECT pg_promote();`। **कब** और **कौन सा** standby, यह तय करना external tooling का काम है:

- **Patroni** हर node के साथ चलता है और एक consensus store (**etcd**, **Consul**, ZooKeeper या Kubernetes) में एक **leader lock** रखता है। Primary को इसे लगातार renew करते रहना होता है; अगर वह नहीं कर पाता, तो एक healthy, up-to-date standby lock ले लेता है और promote हो जाता है।
- **Managed services** (Amazon RDS / Aurora, Google Cloud SQL, Azure) यह आपके लिए करती हैं और एक DNS endpoint को move कर देती हैं।

### Split-brain और fencing

**Split-brain** तब होता है जब दो servers दोनों ख़ुद को primary मानते हैं और writes लेते हैं: orders दो अलग-अलग होते जा रहे databases में पहुँचते हैं, जिन्हें साफ़-साफ़ merge नहीं किया जा सकता। यह तब होता है जब पुराना primary मरा नहीं था, बस **कट गया** था, और वापस आ जाता है।

**Fencing** पक्का करता है कि पुराना primary writes न ले सके: Patroni उस primary को demote कर देता है जो अपना leader lock खो देता है, और उसे reboot करने के लिए watchdog use कर सकता है; दूसरे setups उसकी power या network काट देते हैं ("STONITH: shoot the other node in the head")। पुराना primary बाद में standby के रूप में वापस जुड़ता है, अक्सर अपना अलग हो चुका WAL हटाने के लिए **`pg_rewind`** का इस्तेमाल करके।

आपकी app को एक **stable endpoint** चाहिए जो primary के पीछे-पीछे चले: एक DNS name, एक virtual IP, Patroni के health checks से चलने वाला HAProxy, या provider का endpoint। कुछ seconds से एक minute तक errors की उम्मीद रखें, और idempotent operations को **retry** करें।

> **याद रखें:** promotion एक अकेला command है; *safe* failover (सही standby चुनना और पुराने को fence करना) के लिए Patroni या managed service चाहिए।

## 9. Backups replication नहीं हैं

ग़लती से `DELETE FROM orders;` चला दें, और हर standby भी milliseconds के अंदर उन्हें delete कर देता है।

| | `pg_dump` (logical) | Base backup + WAL archiving |
|---|---|---|
| क्या | एक database का SQL / custom-format dump | Data files की copy + तब से हर WAL segment |
| कहाँ तक restore | Dump शुरू होने का पल | **कोई भी point in time** (PITR) |
| बड़े DBs पर speed | Dump और restore दोनों धीमे | Files का तेज़ restore, फिर replay |
| किसके लिए अच्छा | छोटे DBs, migrations, schema copy करना | Production disaster recovery |

**Point-in-time recovery (PITR):** आख़िरी base backup restore करें, फिर archived WAL को `recovery_target_time = '2026-10-11 14:29:00'` तक replay करें, यानी ग़लत `DELETE` से एक minute पहले तक। WAL `archive_mode = on` और एक `archive_command` से भेजा जाता है; **pgBackRest**, **Barman** या **WAL-G** जैसे tools इसे ठीक से संभालते हैं।

दो numbers हर HA/backup design का ढाँचा तय करते हैं:

- **RPO** (Recovery Point Objective): आप कितना data **खोना** झेल सकते हैं, समय में मापा गया। Async replica: seconds। Sync: zero। Nightly `pg_dump`: 24 घंटे तक।
- **RTO** (Recovery Time Objective): आप कितनी देर **down** रहना झेल सकते हैं। Automatic failover: लगभग एक minute से कम। Backup से 2 TB restore करना: घंटे।

> **याद रखें:** replication **server** खोने से बचाता है; backups **data** खोने से बचाते हैं। Restores test करें, वरना आपके पास backups हैं ही नहीं।

## 10. PostgreSQL बनाम MongoDB replica sets

[MongoDB replication](/lessons/mongodb-replication) से तुलना करें:

| | PostgreSQL | MongoDB replica set |
|---|---|---|
| भेजा जाने वाला log | WAL (physical) | Oplog (logical, idempotent ops) |
| Default ack | Local commit; replicas के लिए async | `w: 'majority'` |
| नया primary elect करना | ❌ External (Patroni, cloud) | ✅ Built-in elections |
| Split-brain से सुरक्षा | External consensus + fencing | Protocol में majority vote |
| Driver failover के साथ चलता है | एक stable endpoint के ज़रिए | ✅ Driver नया primary ख़ुद ढूँढ लेता है |
| Replica reads | Hot standby | `readPreference` |

## 11. आम गलतियाँ और gotchas

- **Replica को backup समझना।** ग़लतियाँ तुरंत replicate हो जाती हैं।
- **Abandoned replication slots** जो `pg_wal` भर देते हैं।
- `FIRST 1` के साथ **एक synchronous standby**: जब वह मरता है, सारे commits अटक जाते हैं।
- **Writes के तुरंत बाद replicas से पढ़ना**, जिससे "मेरा change save नहीं हुआ" वाले bugs आते हैं।
- पुराने primary को **fence किए बिना standby को हाथ से promote करना**: split-brain।
- **इंतज़ार कर रहे synchronous commit को cancel करना:** transaction locally पहले ही commit हो चुका है, बस शायद replicate नहीं हुआ।
- असली outage आने तक **failover या restores कभी test न करना**।

## 12. Trade-offs

- **ज़्यादा copies ज़्यादा महँगी:** हर standby cluster की पूरी copy है।
- **Sync बनाम async** commit latency और write availability का RPO के साथ सीधा सौदा है।
- **Replica reads** reads को scale करते हैं, लेकिन staleness और query cancellations लाते हैं।
- **Self-managed HA** (Patroni, etcd, HAProxy, pgBackRest) असली operational काम है; managed service पैसे और थोड़े control के बदले यह काम आपसे हटा देती है।
