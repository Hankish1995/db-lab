---
slug: postgres-joins
title: 'Joins: receipts को customer cards से staple करना'
module: Querying
summary: 'एक छोटे e-commerce dataset पर PostgreSQL का हर join type कैसे काम करता है, WHERE filter कैसे चुपचाप एक LEFT JOIN को inner join बना सकता है, semi- और anti-joins सुरक्षित तरीक़े से कैसे लिखें (और NULLs के साथ NOT IN कुछ भी return क्यों नहीं करता), join fan-out SUM को कैसे फुला देता है, और LATERAL कब इस्तेमाल करें।'
recap: >-
  Join दो tables की उन rows को जोड़ता है जो एक condition से match करती हैं। INNER सिर्फ़ matches रखता है, LEFT हर left
  row रखता है, RIGHT और FULL दूसरी या दोनों sides की unmatched rows रखते हैं, CROSS हर चीज़ का जोड़ा बनाता है, और self
  join एक table को ख़ुद से जोड़ता है। LEFT JOIN में right table के filters ON में जाते हैं, WHERE में नहीं। "कोई है" और
  "कोई नहीं है" के लिए EXISTS और NOT EXISTS इस्तेमाल करें, nullable column पर कभी NOT IN नहीं। Fan-out से बचने के लिए
  child tables को join से पहले aggregate करें, और हर row के top-N के लिए LATERAL इस्तेमाल करें।
---

## 1. कहानी

आपकी एक छोटी-सी दुकान है और desk पर काग़ज़ों के दो ढेर हैं:

- **Customer cards** का एक box, हर customer का एक card।
- **Receipts** का एक ढेर, हर receipt पर एक customer number लिखा है।

आपका manager पूछता है: "किस customer ने क्या ख़रीदा?" आप हर receipt उठाते हैं और उसे **matching customer card से staple** कर देते हैं। यही join है।

लेकिन details मायने रखती हैं:

- क्या आप वे customer cards रखेंगे जिन्हें **कोई receipt नहीं** मिली? (Meera ने कभी order नहीं किया।)
- क्या आप वे receipts रखेंगे जिनका **कोई customer नहीं**? (एक guest checkout।)
- अगर Asha की तीन receipts हैं, तो वह आपके result में **तीन बार** दिखेगी।

| Desk | SQL |
|---|---|
| Customer cards | `users` table (left side) |
| Receipts | `orders` table (right side) |
| "Receipt पर लिखा customer number card से match करता है" | **Join condition** (`ON o.user_id = u.id`) |
| Staple किए गए जोड़े | Result की rows |
| बिना receipt वाले cards भी रखना | **LEFT JOIN** |
| सिर्फ़ receipt वाले cards रखना | **INNER JOIN** |

> **याद रखें:** join **हर matching जोड़े के लिए एक output row** बनाता है। तीन orders वाला एक customer तीन rows बन जाता है।

## 2. Joins क्यों होते हैं

Relational database में आप **normalize** करते हैं: users, orders, products और order items अलग-अलग tables में रहते हैं, हर fact सिर्फ़ एक बार store होता है (देखें [Normalization](/lessons/normalization))। Joins query के समय इन्हें फिर से जोड़ देते हैं।

अगर आप MongoDB से आ रहे हैं, तो join को एक `$lookup` समझिए, फ़र्क़ बस इतना है कि यहाँ यह query करने का **normal, रोज़मर्रा का, अच्छी तरह optimized** तरीक़ा है, कोई अपवाद नहीं। PostgreSQL का planner इसी के इर्द-गिर्द बना है कि join करने का सबसे तेज़ तरीक़ा कैसे चुना जाए।

## 3. Sample data

नीचे के सारे examples इस छोटे dataset का इस्तेमाल करते हैं (एक असली scratch database से):

```text
users                           orders
 id │ name  │ referred_by        id  │ user_id │ status    │ total
────┼───────┼────────────       ─────┼─────────┼───────────┼───────
  1 │ Asha  │ NULL               101 │       1 │ delivered │  1200
  2 │ Ravi  │ 1                  102 │       1 │ cancelled │   300
  3 │ Meera │ 1                  103 │       2 │ delivered │   450
  4 │ Kabir │ 2                  104 │       1 │ delivered │    80
                                 105 │    NULL │ pending   │    99

products                        order_items
 id │ name     │ price           order_id │ product_id │ qty
────┼──────────┼───────         ──────────┼────────────┼─────
  1 │ Keyboard │ 50                   101 │          1 │   2
  2 │ Mouse    │ 20                   101 │          3 │   1
  3 │ Monitor  │ 300                  101 │          2 │   1
                                      103 │          2 │   1
                                      104 │          2 │   4
```

Meera और Kabir के कोई orders नहीं हैं। Order 105 एक guest checkout है जिसका कोई user नहीं।

## 4. Join types

| Join | Matched pairs | Unmatched left rows | Unmatched right rows |
|---|---|---|---|
| `INNER JOIN` | ✅ | ❌ | ❌ |
| `LEFT JOIN` | ✅ | ✅ (NULL-padded) | ❌ |
| `RIGHT JOIN` | ✅ | ❌ | ✅ (NULL-padded) |
| `FULL JOIN` | ✅ | ✅ | ✅ |
| `CROSS JOIN` | हर left row × हर right row, कोई condition नहीं | | |

### INNER JOIN: सिर्फ़ matching जोड़े

```sql
SELECT u.name, o.id AS order_id, o.total
FROM users u
JOIN orders o ON o.user_id = u.id;   -- JOIN = INNER JOIN
```

```text
 name │ order_id │ total
──────┼──────────┼───────
 Asha │      101 │  1200
 Asha │      102 │   300
 Ravi │      103 │   450
 Asha │      104 │    80
```

Meera, Kabir और guest order 105 गायब हो जाते हैं: उनका कोई साथी नहीं है।

### LEFT JOIN: हर left row, match हो या न हो

```sql
SELECT u.name, o.id AS order_id, o.total
FROM users u
LEFT JOIN orders o ON o.user_id = u.id;
```

```text
 name  │ order_id │ total
───────┼──────────┼───────
 Asha  │      101 │  1200
 Asha  │      102 │   300
 Asha  │      104 │    80
 Ravi  │      103 │   450
 Meera │     NULL │  NULL
 Kabir │     NULL │  NULL
```

Unmatched users को हर `orders` column के लिए **NULLs** मिलते हैं। "सारे customers, अगर orders हैं तो उनके साथ" के लिए यही join है।

### RIGHT JOIN: हर right row

```sql
SELECT u.name, o.id AS order_id, o.total
FROM users u
RIGHT JOIN orders o ON o.user_id = u.id;
```

```text
 name │ order_id │ total
──────┼──────────┼───────
 Asha │      101 │  1200
 Asha │      102 │   300
 Ravi │      103 │   450
 Asha │      104 │    80
 NULL │      105 │    99
```

`RIGHT JOIN` बस tables की जगह बदला हुआ `LEFT JOIN` है। ज़्यादातर teams पढ़ने में आसानी के लिए हमेशा `LEFT JOIN` ही लिखती हैं।

### FULL OUTER JOIN: दोनों sides से सब कुछ

```sql
SELECT u.name, o.id AS order_id
FROM users u
FULL JOIN orders o ON o.user_id = u.id;
```

```text
 name  │ order_id
───────┼──────────
 Asha  │      101
 Asha  │      102
 Asha  │      104
 Ravi  │      103
 Meera │     NULL
 Kabir │     NULL
 NULL  │      105
```

**Reconciliation** के लिए काम का है: "Stripe के payments को हमारे orders से मिलाओ और दिखाओ कि किसी भी side पर क्या missing है"।

### CROSS JOIN: हर combination

```sql
SELECT u.name, p.name AS product
FROM users u
CROSS JOIN products p
WHERE u.id <= 2;
```

```text
 name │ product
──────┼──────────
 Asha │ Keyboard
 Asha │ Mouse
 Asha │ Monitor
 Ravi │ Keyboard
 Ravi │ Mouse
 Ravi │ Monitor
```

कोई condition नहीं: 2 users × 3 products = 6 rows। Grids बनाने के लिए काम का है (report के लिए हर product × हर दिन), लेकिन ग़लती से हो जाए तो ख़तरनाक: 100,000 rows वाली दो tables 10 billion rows दे देती हैं।

### SELF JOIN: एक table को ख़ुद से join करना

`users.referred_by` किसी दूसरे user की ओर point करता है। `users` को दो aliases के साथ ख़ुद से join कीजिए:

```sql
SELECT u.name AS customer, r.name AS referred_by
FROM users u
LEFT JOIN users r ON r.id = u.referred_by;
```

```text
 customer │ referred_by
──────────┼─────────────
 Asha     │ NULL
 Ravi     │ Asha
 Meera    │ Asha
 Kabir    │ Ravi
```

> **याद रखें:** INNER = सिर्फ़ matches। LEFT = left side का सब कुछ, जहाँ कुछ match नहीं हुआ वहाँ NULLs। FULL = दोनों का सब कुछ। CROSS = हर जोड़ा।

## 5. Classic जाल: WHERE एक LEFT JOIN को INNER JOIN बना देता है

लक्ष्य: "हर customer, उसके **delivered** orders के साथ (अगर हैं)"।

```sql
-- ❌ looks right, isn't
SELECT u.name, o.id AS order_id, o.status
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.status = 'delivered';
```

```text
 name │ order_id │ status
──────┼──────────┼───────────
 Asha │      101 │ delivered
 Asha │      104 │ delivered
 Ravi │      103 │ delivered
```

Meera और Kabir गायब हो गए। क्यों? `LEFT JOIN` ने उनकी rows `o.status = NULL` के साथ बनाईं, फिर `WHERE` join के **बाद** चला, और `NULL = 'delivered'` true नहीं है, इसलिए वे rows filter हो गईं। आपने कुछ extra steps के साथ एक inner join ही लिख दिया।

Fix: **right table** की conditions `ON` clause में रखिए, ताकि वे तय करें कि *क्या match होगा*, यह नहीं कि *क्या बचेगा*:

```sql
-- ✅
SELECT u.name, o.id AS order_id, o.status
FROM users u
LEFT JOIN orders o
  ON o.user_id = u.id
 AND o.status = 'delivered';
```

```text
 name  │ order_id │ status
───────┼──────────┼───────────
 Asha  │      101 │ delivered
 Asha  │      104 │ delivered
 Ravi  │      103 │ delivered
 Meera │     NULL │ NULL
 Kabir │     NULL │ NULL
```

LEFT JOIN के लिए thumb rule:

- **Left** table पर condition (`u.is_active`) → `WHERE`।
- **Right** table पर condition (`o.status`) → `ON`।

इससे जुड़ा एक counting bug: LEFT JOIN के साथ `count(*)` NULL-padded row को भी गिनता है, इसलिए Meera के **1** order दिखता है। इसकी जगह right table का कोई column गिनिए: `count(o.id)` NULLs को ignore करता है और 0 देता है।

> **याद रखें:** LEFT JOIN में right table के filters `ON` में जाते हैं। `WHERE` में वे unmatched rows को चुपचाप गिरा देते हैं।

## 6. Semi-joins और anti-joins: "कोई है" और "कोई नहीं है"

अक्सर आपको orders नहीं चाहिए, बस वे users चाहिए **जिनके** कोई orders **हैं** (या **नहीं हैं**)।

### Semi-join: EXISTS

```sql
-- users who have placed at least one order
SELECT u.name
FROM users u
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);
-- Asha, Ravi
```

`JOIN orders` क्यों नहीं? क्योंकि Asha के तीन orders हैं, सादा join उसे **तीन बार** लौटाता है, और उसे ठीक करने के लिए आपको `DISTINCT` लगाना पड़ेगा। `EXISTS` पहले match पर रुक जाता है और हर user को एक बार लौटाता है। यहाँ `WHERE u.id IN (SELECT user_id FROM orders)` भी ठीक है; PostgreSQL दोनों को semi-join की तरह plan कर सकता है।

### Anti-join: "कभी order नहीं किया" कहने के तीन तरीक़े

```sql
-- ✅ 1. NOT EXISTS (preferred)
SELECT u.name FROM users u
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);
-- Meera, Kabir

-- ✅ 2. LEFT JOIN ... IS NULL
SELECT u.name FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.user_id IS NULL;
-- Meera, Kabir

-- ❌ 3. NOT IN
SELECT u.name FROM users u
WHERE u.id NOT IN (SELECT user_id FROM orders);
-- (0 rows)
```

### NOT IN + NULL का जाल

Version 3 **कुछ भी नहीं** लौटाता, क्योंकि guest order 105 का `user_id = NULL` है। Meera के लिए `NOT IN (1, 1, 2, 1, NULL)` का मतलब है:

```text
 3 <> 1 AND 3 <> 1 AND 3 <> 2 AND 3 <> 1 AND 3 <> NULL
 true       true       true       true       NULL (unknown)
 └────────────────────── AND ────────────────────────┘
                    = NULL  →  row not returned
```

जब list में कोई unknown value हो, तो SQL यह नहीं कह सकता कि "3 list में नहीं है"। Subquery में एक भी NULL हो तो `NOT IN` zero rows लौटाता है। इसका plan भी अक्सर बुरा बनता है: PostgreSQL `NOT IN` को anti-join में नहीं बदल सकता, इसलिए हमारी 500,000-order वाली test table पर यह subplan पर चला गया, जबकि `NOT EXISTS` एक `Hash Anti Join` बन गया।

> **याद रखें:** "कोई नहीं है" = `NOT EXISTS`। जो column NULL हो सकता है उस पर कभी `NOT IN (subquery)` इस्तेमाल मत कीजिए।

## 7. Join fan-out: जब SUM झूठ बोलता है

Report: "हर customer का revenue और बिकी units, सिर्फ़ delivered orders"।

```sql
-- ❌ joins orders → order_items, then sums the order total
SELECT u.name, sum(o.total) AS revenue, sum(oi.qty) AS units
FROM users u
JOIN orders o ON o.user_id = u.id
LEFT JOIN order_items oi ON oi.order_id = o.id
WHERE o.status = 'delivered'
GROUP BY u.id, u.name;
```

```text
 name │ revenue │ units
──────┼─────────┼───────
 Asha │    3680 │     8
 Ravi │     450 │     1
```

Asha ने असल में 1200 + 80 = **1280** ख़र्च किए। Order 101 में **तीन** items हैं, इसलिए join ने उसे तीन rows बना दिया, और उसका 1200 का total तीन बार जुड़ गया। यही **fan-out** है: one-to-many relationship को join करने से "one" side कई गुना हो जाती है।

```text
 order 101 (total 1200) ──┬── item Keyboard ──► 1200
                          ├── item Monitor  ──► 1200   SUM = 3600 ❌
                          └── item Mouse    ──► 1200
```

Fix: **पहले child table को aggregate कीजिए**, ताकि हर order की एक row हो, फिर join कीजिए:

```sql
-- ✅
SELECT u.name, sum(o.total) AS revenue, sum(i.units) AS units
FROM users u
JOIN orders o ON o.user_id = u.id
LEFT JOIN (
  SELECT order_id, sum(qty) AS units
  FROM order_items
  GROUP BY order_id
) i ON i.order_id = o.id
WHERE o.status = 'delivered'
GROUP BY u.id, u.name;
```

```text
 name │ revenue │ units
──────┼─────────┼───────
 Asha │    1280 │     8
 Ravi │     450 │     1
```

एक ही order से **दो** child tables (items और payments) join करना और बुरा है: rows items × payments जितनी गुना हो जाती हैं। Join से पहले हर एक को अलग-अलग aggregate कीजिए। और `SUM(DISTINCT o.total)` कोई fix नहीं है: एक जैसे total वाले दो अलग orders एक ही बार गिने जाएँगे।

> **याद रखें:** अगर numbers ज़रूरत से बड़े लगें, तो fan-out है। हर one-to-many table को join करने से **पहले** हर key की एक row तक aggregate कीजिए।

## 8. LATERAL: "हर user के latest N orders"

`FROM` में एक normal subquery query की दूसरी tables को नहीं देख सकती। एक **LATERAL** subquery देख सकती है: यह अपने से पहले वाली tables की **हर row के लिए** एक बार चलती है, एक `for` loop की तरह।

```sql
SELECT u.name, o.id AS order_id, o.created_at
FROM users u
LEFT JOIN LATERAL (
  SELECT id, created_at
  FROM orders
  WHERE orders.user_id = u.id        -- refers to the outer row
  ORDER BY created_at DESC
  LIMIT 2
) o ON true;
```

```text
 name  │ order_id │ created_at
───────┼──────────┼────────────
 Asha  │      104 │ 2026-10-02
 Asha  │      102 │ 2026-09-15
 Ravi  │      103 │ 2026-09-20
 Meera │     NULL │ NULL
 Kabir │     NULL │ NULL
```

- `LEFT JOIN LATERAL ... ON true` बिना orders वाले users को रखता है; `CROSS JOIN LATERAL` उन्हें हटा देता है।
- `orders (user_id, created_at DESC)` पर index हो, तो हर iteration एक छोटा-सा index scan है जो N rows के बाद रुक जाता है। 500,000-order वाली table पर 100 users के latest 3 orders लाने में लगभग 6 ms लगे।
- दूसरा आम तरीक़ा, हर user के लिए `ROW_NUMBER()`, [CTEs and window functions](/lessons/postgres-ctes-and-window-functions) में cover किया गया है।

## 9. USING vs ON

जब join columns का नाम दोनों tables में **एक जैसा** हो, तो `USING` छोटा पड़ता है:

```sql
-- shipments(id, order_id, carrier) and order_items(order_id, ...)
-- both have a column called order_id, so these are equivalent:
SELECT * FROM shipments s JOIN order_items i ON i.order_id = s.order_id;
SELECT * FROM shipments   JOIN order_items   USING (order_id);
```

अंतर:

| | `ON` | `USING (col)` |
|---|---|---|
| Column names | अलग हो सकते हैं (`o.user_id = u.id`) | बिल्कुल एक जैसे होने चाहिए |
| Extra conditions | कोई भी expression (`AND o.status = 'paid'`) | सिर्फ़ listed columns पर equality |
| `SELECT *` output | Column की दोनों copies | एक merged column |

`NATURAL JOIN` से बचिए: यह एक जैसे नाम वाले **हर** column पर join करता है, इसलिए बाद में दोनों tables में `created_at` जोड़ते ही आपकी query चुपचाप बदल जाती है।

## 10. PostgreSQL असल में join कैसे चलाता है

आप लिखते हैं कि *क्या* join करना है; planner तय करता है कि *कैसे*। वह table sizes, indexes और statistics के आधार पर हर join के लिए तीन में से एक algorithm चुनता है:

| Algorithm | कैसे काम करता है | कब अच्छा है |
|---|---|---|
| **Nested Loop** | हर outer row के लिए matches ढूँढता है (अक्सर index के ज़रिए) | Outer side छोटी हो, inner side indexed हो |
| **Hash Join** | छोटी side पर hash table बनाता है, दूसरी side से उसे probe करता है | बड़े unsorted inputs, equality joins |
| **Merge Join** | दोनों sides को key पर sort करता है, फिर साथ-साथ चलता है | दोनों inputs पहले से sorted हों (जैसे index से) |

ये आपको `EXPLAIN` output में nodes के रूप में दिखेंगे: [Reading EXPLAIN](/lessons/postgres-explain)। एक practical नियम: **अपने foreign key columns को index कीजिए** (`orders.user_id`, `order_items.product_id`)। PostgreSQL इन्हें अपने-आप नहीं बनाता, और nested-loop joins इन्हीं पर निर्भर करते हैं।

## 11. आम ग़लतियाँ और gotchas

- LEFT JOIN के बाद **right table को `WHERE` में filter करना** (section 5)।
- **LEFT JOIN के साथ `count(*)`** NULL row को भी गिनता है। `count(right_table.id)` इस्तेमाल कीजिए।
- **Nullable subquery के साथ `NOT IN`** कुछ भी नहीं लौटाता (section 6)।
- **Duplicates को समझने की जगह `DISTINCT` से छिपाना।** Duplicates का मतलब आमतौर पर fan-out या कोई छूटी हुई join condition होता है।
- पुराने style की `FROM a, b` query में **join condition भूल जाना** ग़लती से cross join बना देता है। हमेशा explicit `JOIN ... ON` इस्तेमाल कीजिए।
- **Mismatched types पर join करना** (`text` vs `bigint`) casts करवाता है और index के इस्तेमाल को रोक सकता है।

## 12. सही tool चुनना

| आपको चाहिए | इस्तेमाल करें | क्यों |
|---|---|---|
| दोनों tables की rows | `JOIN` / `LEFT JOIN` | आपको दोनों के columns चाहिए |
| वे left rows जिनका match **है** | `EXISTS` (या `IN`) | कोई duplicates नहीं, पहले match पर रुकता है |
| वे left rows जिनका **कोई** match नहीं | `NOT EXISTS` | NULL-safe, anti-join की तरह plan होता है |
| हर parent के top-N children | `LATERAL` + `LIMIT` | हर parent के लिए index इस्तेमाल करता है |
| One-to-many tables के totals | पहले aggregate, फिर join | Fan-out से बचाता है |

## 13. Trade-offs: जब join जवाब नहीं है

- **बहुत hot read paths** जो हमेशा वही 5 tables join करते हैं, उनके लिए एक **denormalized** column या materialized view ठीक हो सकता है, जिसे सोच-समझकर sync में रखा जाए।
- अरबों rows पर **बड़े analytics joins** warehouse में होने चाहिए, आपके OLTP database में नहीं।
- **App code में loop के अंदर join** (ORMs वाला N+1 problem) एक SQL join से बुरा है। Database को एक ही round trip में यह करने दीजिए।

> **याद रखें:** joins तब सस्ते हैं जब वे indexed हों और result वही हो जो आप चाहते थे। सिर्फ़ query का syntax नहीं, row counts भी check कीजिए।
