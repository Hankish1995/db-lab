---
slug: postgres-ctes-and-window-functions
title: 'CTEs और window functions: rows खोए बिना analytics'
module: Querying
summary: 'GROUP BY से आगे subqueries, CTEs (PostgreSQL उन्हें कब materialize करता है और recursive CTEs trees पर कैसे चलते हैं समेत) और window functions तक कैसे जाएँ, ताकि rankings, month-over-month growth, running totals, moving averages और हर group के top-N निकाल सकें।'
recap: >-
  GROUP BY rows को हर group की एक row में समेट देता है; FILTER conditional aggregates जोड़ता है। CTEs बीच के steps को
  नाम देते हैं, और PostgreSQL 12 से एक बार इस्तेमाल होने वाला non-recursive CTE inline हो जाता है, जब तक आप MATERIALIZED
  न लिखें। Recursive CTEs category hierarchies जैसे trees पर चलते हैं, cycles से बचाव के साथ। Window functions rows को
  समेटे बिना related rows पर calculation करते हैं: rankings के लिए ROW_NUMBER, RANK और DENSE_RANK, तुलना के लिए LAG और
  LEAD, running totals के लिए SUM OVER और moving averages के लिए frames। हर group के top-N के लिए ROW_NUMBER या LATERAL
  subquery इस्तेमाल करें।
---

## 1. कहानी

एक school के sports day के final results की कल्पना कीजिए।

- **Principal का summary** कहता है: "Red House: 340 points, Blue House: 310।" हर house एक लाइन में समेट दिया गया। यही **GROUP BY** है।
- **Results board** पर हर student की list है, और हर नाम के आगे लिखा है "house में rank: 3rd", "ऊपर वाले student से 4 points पीछे", "अब तक house का total: 120"। हर student की अपनी लाइन बनी रहती है, लेकिन हर लाइन अपने पड़ोसियों के बारे में भी जानती है। यही **window function** है।
- Organiser पहले जो **clipboard notes** लिखता है ("step 1: disqualified runs हटाओ, step 2: times को points में बदलो") और फिर final board में इस्तेमाल करता है, वे **CTEs** हैं।

| Sports day | SQL |
|---|---|
| हर house की एक लाइन | `GROUP BY` |
| हर student की लाइन + house का context | `OVER (PARTITION BY house)` वाला window function |
| "अपने house में rank" | `RANK() OVER (PARTITION BY house ORDER BY points DESC)` |
| Clipboard पर नाम वाले तैयारी के steps | CTE: `WITH step1 AS (...)` |
| House → team → sub-team chart | Recursive CTE |

> **याद रखें:** GROUP BY rows को groups में **समेट देता है**। Window function **हर row को रखता है** और related rows पर निकाली गई एक value जोड़ देता है।

## 2. यह क्यों ज़रूरी है

इन tools के बिना, MERN app में analytics का मतलब आमतौर पर होता है: हज़ारों rows Node.js में लाओ, loop चलाओ, sort करो, JavaScript में ranks और deltas निकालो। यह धीमा है, memory खाता है और इसमें ग़लती करना आसान है।

इनके साथ "हर महीने का revenue growth % के साथ", "हर category का सबसे ज़्यादा बिकने वाला product" या "हर customer के 3 latest orders" एक-एक query बन जाते हैं जो data के पास ही चलती हैं। ये सबसे आम SQL interview questions में से भी हैं।

सारे examples एक scratch e-commerce database पर चलते हैं: `users`, `orders` (500,000 rows), `order_items`, `products` और `categories`।

## 3. GROUP BY, HAVING और FILTER

एक छोटा-सा refresher। `WHERE` grouping से **पहले** rows filter करता है, `HAVING` grouping के **बाद** groups filter करता है।

```sql
SELECT date_trunc('month', created_at)::date AS month,
       count(*)                                       AS orders,
       count(*)   FILTER (WHERE status = 'cancelled') AS cancelled,
       sum(total) FILTER (WHERE status <> 'cancelled') AS revenue
FROM orders
WHERE created_at >= '2024-01-01' AND created_at < '2024-04-01'
GROUP BY 1
HAVING count(*) > 1000
ORDER BY 1;
```

Example output:

```text
   month    │ orders │ cancelled │   revenue
────────────┼────────┼───────────┼─────────────
 2024-01-01 │  31885 │      1625 │ 75606253.98
 2024-02-01 │  29829 │      1523 │ 70742601.12
 2024-03-01 │  31885 │      1629 │ 75459139.62
```

**FILTER** clause table पर **एक ही pass** में कई conditional aggregates दे देता है। यह `sum(CASE WHEN ... THEN total END)` का साफ़-सुथरा रूप है।

## 4. Subqueries

तीन तरह की subqueries जो आपको बार-बार मिलेंगी:

```sql
-- Scalar subquery: returns exactly one value
SELECT id, total,
       total - (SELECT avg(total) FROM orders) AS diff_from_avg
FROM orders;

-- IN subquery: a set of values
SELECT * FROM products
WHERE id IN (SELECT product_id FROM order_items WHERE quantity >= 4);

-- Correlated subquery: references the outer row, runs per row
SELECT u.id, u.email,
       (SELECT max(o.created_at) FROM orders o WHERE o.user_id = u.id) AS last_order_at
FROM users u;
```

Correlated subquery तब ठीक है जब वह हर row के लिए एक index lookup हो (यहाँ `orders (user_id, created_at)` पर index के साथ)। बिना index वाली बड़ी outer tables पर इसका मतलब है हर outer row के लिए एक scan। "कोई है / कोई नहीं है" वाले checks के लिए `EXISTS` / `NOT EXISTS` को प्राथमिकता दीजिए (देखें [Joins](/lessons/postgres-joins))।

## 5. CTEs: अपने steps को नाम देना

**CTE** (Common Table Expression) `WITH` से define की गई एक नाम वाली subquery है, जिसे एक pipeline की तरह ऊपर से नीचे पढ़ा जा सकता है:

```sql
WITH delivered AS (
  SELECT user_id, total
  FROM orders
  WHERE status = 'delivered'
),
per_user AS (
  SELECT user_id, sum(total) AS lifetime_value, count(*) AS orders
  FROM delivered
  GROUP BY user_id
)
SELECT u.email, p.lifetime_value, p.orders
FROM per_user p
JOIN users u ON u.id = p.user_id
ORDER BY p.lifetime_value DESC
LIMIT 10;
```

अगर आप MongoDB की aggregation pipeline जानते हैं, तो हर CTE एक नाम वाले stage जैसा है।

### क्या CTEs materialize होते हैं? निर्भर करता है

पुरानी सलाह कहती है "CTEs एक optimization fence हैं"। यह **PostgreSQL 12 से पहले** सच था। अब:

- एक **non-recursive**, side-effect-free CTE जो **एक बार** reference हो, main query में **inline** हो जाता है, ताकि planner filters को उसके अंदर push कर सके।
- जो CTE **एक से ज़्यादा बार** reference हो, वह default रूप से **materialize** होता है: एक बार compute होकर temporary result की तरह store होता है।
- आप `AS MATERIALIZED` या `AS NOT MATERIALIZED` से किसी भी तरफ़ override कर सकते हैं।

Scratch database से असली plans:

```sql
WITH big_orders AS (SELECT * FROM orders WHERE total > 500)
SELECT * FROM big_orders WHERE id = 4242;
```

```text
Index Scan using orders_pkey on orders   -- inlined
  Index Cond: (id = 4242)
  Filter: (total > '500'::numeric)
```

```sql
WITH big_orders AS MATERIALIZED (SELECT * FROM orders WHERE total > 500)
SELECT * FROM big_orders WHERE id = 4242;
```

```text
CTE Scan on big_orders                   -- materialized
  Filter: (id = 4242)
  CTE big_orders
    ->  Seq Scan on orders
          Filter: (total > '500'::numeric)
```

Materialized version CTE बनाने के लिए पूरी table scan करता है, फिर उसमें खोजता है। `MATERIALIZED` सोच-समझकर इस्तेमाल कीजिए: जब कोई महँगा CTE कई बार इस्तेमाल हो, या planner को किसी ऐसी चीज़ को inline करने से रोकना हो जिसका वह ग़लत अंदाज़ा लगाता है।

> **याद रखें:** PostgreSQL 12 से एक बार इस्तेमाल होने वाला CTE inline होता है, यानी readability मुफ़्त है। दो बार इस्तेमाल हो तो वह एक बार compute होकर store होता है, जब तक आप `NOT MATERIALIZED` न कहें।

## 6. Recursive CTEs: category tree पर चलना

`categories` में एक `parent_id` है जो उसी table की ओर point करता है:

```text
 Electronics (1)
 ├── Computers (2)
 │   ├── Laptops (3)
 │   └── Accessories (4)
 └── Phones (5)
 Home (6)
 └── Kitchen (7)
```

एक **recursive CTE** के दो हिस्से होते हैं जो `UNION ALL` से जुड़े होते हैं: एक **anchor** (शुरुआती rows) और एक **recursive term** जो ख़ुद CTE को reference करता है। PostgreSQL सबसे नई rows पर recursive term को तब तक दोहराता है जब तक वह कुछ भी पैदा करना बंद न कर दे।

```sql
WITH RECURSIVE tree AS (
  -- anchor: top-level categories
  SELECT id, name, 1 AS depth, name AS path
  FROM categories
  WHERE parent_id IS NULL
  UNION ALL
  -- recursive term: children of the rows found so far
  SELECT c.id, c.name, t.depth + 1, t.path || ' > ' || c.name
  FROM categories c
  JOIN tree t ON c.parent_id = t.id
)
SELECT id, depth, path FROM tree ORDER BY path;
```

```text
 id │ depth │ path
────┼───────┼───────────────────────────────────────
  1 │     1 │ Electronics
  2 │     2 │ Electronics > Computers
  4 │     3 │ Electronics > Computers > Accessories
  3 │     3 │ Electronics > Computers > Laptops
  5 │     2 │ Electronics > Phones
  6 │     1 │ Home
  7 │     2 │ Home > Kitchen
```

Classic इस्तेमाल: "Computers के नीचे के सारे products, subcategories समेत" = anchor को `name = 'Computers'` से शुरू कीजिए और मिले हुए ids पर `products` को join कीजिए।

### Cycle से सुरक्षा

अगर ख़राब data की वजह से Electronics, Laptops का child बन जाए, तो recursion हमेशा के लिए loop में फँस जाता है। बचाव:

- जब पूरी rows दोहराई जाएँ तो `UNION ALL` की जगह `UNION` इस्तेमाल कीजिए (यह duplicates हटा देता है, जिससे simple loops रुक जाते हैं)।
- Visited path track कीजिए और कोई id दोबारा आए तो रुक जाइए, या depth limit लगाइए (`WHERE t.depth < 20`)।
- PostgreSQL 14 से built-in `CYCLE` clause आपके लिए यह कर देता है:

```sql
WITH RECURSIVE tree AS (
  SELECT id, name, parent_id FROM categories WHERE id = 1
  UNION ALL
  SELECT c.id, c.name, c.parent_id
  FROM categories c JOIN tree t ON c.parent_id = t.id
) CYCLE id SET is_cycle USING path
SELECT id, name, is_cycle FROM tree;
```

Data में cycle होने पर मुझे Electronics → Computers → Laptops → Electronics (`is_cycle = true`) मिला और query रुक गई।

## 7. Window functions: basics

**Window function** current row से related rows के एक set (उसकी **window**) पर एक value निकालता है और उसे उसी row से जोड़ देता है। `OVER` clause window define करता है:

```text
 function() OVER (
   PARTITION BY ...   ← groups, like GROUP BY but not collapsed
   ORDER BY ...       ← order inside each group
   ROWS BETWEEN ...   ← optional frame: which neighbours count
 )
```

```sql
-- each order of user 42, with the user's first order id and % of their spend
SELECT id, total,
       FIRST_VALUE(id) OVER (PARTITION BY user_id ORDER BY created_at) AS first_order_id,
       round(100.0 * total / sum(total) OVER (PARTITION BY user_id), 1) AS pct_of_spend
FROM orders
WHERE user_id = 42;
```

हर order row अब भी मौजूद है; हर एक अपने siblings के बारे में भी जानती है। Window functions `WHERE`, `GROUP BY` और `HAVING` के **बाद** चलते हैं, इसलिए आप उसी `WHERE` में उन पर filter नहीं कर सकते। Query को subquery या CTE में लपेटिए और बाहर filter कीजिए।

## 8. Ranking: ROW_NUMBER vs RANK vs DENSE_RANK

हर product की बिकी units, ऊपर और बीच में एक-एक tie के साथ:

```sql
SELECT product, units_sold,
       ROW_NUMBER() OVER (ORDER BY units_sold DESC) AS row_number,
       RANK()       OVER (ORDER BY units_sold DESC) AS rank,
       DENSE_RANK() OVER (ORDER BY units_sold DESC) AS dense_rank,
       NTILE(3)     OVER (ORDER BY units_sold DESC) AS ntile_3
FROM product_sales;
```

| product | units_sold | ROW_NUMBER | RANK | DENSE_RANK | NTILE(3) |
|---|---|---|---|---|---|
| Keyboard | 120 | 1 | 1 | 1 | 1 |
| Mouse | 120 | 2 | 1 | 1 | 1 |
| Monitor | 90 | 3 | 3 | 2 | 2 |
| Webcam | 75 | 4 | 4 | 3 | 2 |
| Cable | 75 | 5 | 4 | 3 | 3 |
| Stand | 40 | 6 | 6 | 4 | 3 |

- **ROW_NUMBER**: हमेशा unique, 1, 2, 3… Ties को एक **मनमाना** order मिलता है, जब तक आप tie-breaker न जोड़ें (`ORDER BY units_sold DESC, product_id`)।
- **RANK**: ties एक ही rank share करते हैं, फिर **gaps** (1, 1, 3)। Olympic medals की तरह।
- **DENSE_RANK**: ties एक ही rank share करते हैं, **कोई gap नहीं** (1, 1, 2)।
- **NTILE(n)**: rows को n लगभग बराबर buckets में बाँटता है (top third, middle, bottom), customer segmentation के लिए काम का।

> **याद रखें:** ROW_NUMBER = unique positions, RANK = ties फिर gaps, DENSE_RANK = बिना gaps के ties। Deterministic results चाहिए तो tie-breaker जोड़िए।

## 9. LAG, LEAD और running totals

Month-over-month revenue growth और साथ में running total, एक ही query में:

```sql
WITH monthly AS (
  SELECT date_trunc('month', created_at)::date AS month,
         sum(total) AS revenue
  FROM orders
  WHERE status <> 'cancelled'
  GROUP BY 1
)
SELECT month, revenue,
       LAG(revenue) OVER w AS prev_month,
       round(100.0 * (revenue - LAG(revenue) OVER w) / LAG(revenue) OVER w, 1) AS growth_pct,
       SUM(revenue) OVER w AS running_total
FROM monthly
WINDOW w AS (ORDER BY month)
ORDER BY month;
```

Example output (पहले चार महीने):

```text
   month    │   revenue   │ prev_month  │ growth_pct │ running_total
────────────┼─────────────┼─────────────┼────────────┼───────────────
 2024-01-01 │ 75606253.98 │        NULL │       NULL │   75606253.98
 2024-02-01 │ 70742601.12 │ 75606253.98 │       -6.4 │  146348855.10
 2024-03-01 │ 75459139.62 │ 70742601.12 │        6.7 │  221807994.72
 2024-04-01 │ 73170219.90 │ 75459139.62 │       -3.0 │  294978214.62
```

- **LAG(x)** पिछली row की value पढ़ता है; **LEAD(x)** अगली row की। दोनों एक offset और default लेते हैं: `LAG(revenue, 1, 0)`।
- **SUM() OVER (ORDER BY ...)** running total देता है।
- **WINDOW** clause एक window को एक बार नाम दे देता है ताकि आपको उसे दोहराना न पड़े।

Pattern पर ध्यान दीजिए: पहले CTE में aggregate कीजिए (हर महीने की एक row), फिर window functions लगाइए। Window functions उसी query में सीधे aggregates पर भी काम करते हैं: `SUM(sum(total)) OVER (ORDER BY ...)`।

## 10. Frames: moving averages, और ROWS vs RANGE

**Frame** window को आस-पास की rows तक सीमित करता है। Daily revenue का 7-day moving average:

```sql
WITH daily AS (
  SELECT created_at::date AS day, sum(total) AS revenue
  FROM orders
  WHERE status <> 'cancelled'
  GROUP BY 1
)
SELECT day, revenue,
       avg(revenue) OVER (
         ORDER BY day
         ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
       ) AS avg_7d
FROM daily;
```

पहले छह दिनों का average कम rows पर निकलता है (उनसे पहले कुछ है ही नहीं)। अगर कुछ दिनों में कोई order न हो, तो "6 पिछली rows" का मतलब "6 पिछले दिन" नहीं है; `generate_series` से पूरा calendar बनाकर उससे `LEFT JOIN` कीजिए, या interval वाला `RANGE` frame इस्तेमाल कीजिए (`RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW`)।

### ROWS vs RANGE

जब आप `OVER` में बिना frame के `ORDER BY` लिखते हैं, तो default frame `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` होता है। **RANGE** बराबर sort values वाली rows (**peers**) को एक step मानता है; **ROWS** physical rows गिनता है:

```text
  x  │ sum OVER (ORDER BY x)  │ ... ROWS UNBOUNDED PRECEDING
 ────┼────────────────────────┼──────────────────────────────
  10 │                     10 │                           10
  20 │                     50 │                           30
  20 │                     50 │                           50
  30 │                     80 │                           80
```

Ties होने पर default running total दोनों 20 एक साथ जोड़कर छलाँग लगाता है। अगर आपको सख़्ती से row-by-row चाहिए, तो `ROWS` लिखिए।

इससे जुड़ा एक जाल: default frame के साथ `LAST_VALUE(x) OVER (ORDER BY ...)` **current** row की value लौटाता है, क्योंकि frame current row पर ख़त्म होता है। `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` इस्तेमाल कीजिए, या उल्टे order के साथ `FIRST_VALUE`।

> **याद रखें:** ORDER BY हो और frame न हो, तो window का मतलब है "शुरुआत से current row और उसके ties तक"। जब exact frame मायने रखता हो, तो `ROWS BETWEEN ...` साफ़-साफ़ लिखिए।

## 11. हर group के top-N: दो अच्छे जवाब

"हर user के 3 latest orders।" Window function वाला तरीक़ा:

```sql
SELECT *
FROM (
  SELECT o.*,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
  FROM orders o
) ranked
WHERE rn <= 3;
```

LATERAL वाला तरीक़ा:

```sql
SELECT u.id, o.*
FROM users u
CROSS JOIN LATERAL (
  SELECT id, total, created_at
  FROM orders
  WHERE orders.user_id = u.id
  ORDER BY created_at DESC
  LIMIT 3
) o;
```

कौन तेज़ है, यह data के shape पर निर्भर करता है, `orders (user_id, created_at DESC)` पर index के साथ:

| | ROW_NUMBER | LATERAL + LIMIT |
|---|---|---|
| कैसे काम करता है | **सारे** matching orders पढ़ता है, उन्हें number देता है, rn ≤ 3 रखता है | हर user के लिए एक index scan जो 3 rows के बाद रुक जाता है |
| Scratch DB, सारे 50k users (500k orders, warm cache) | ~620 ms, सारे 500k orders पढ़ता है | ~240 ms, ~150k पढ़ता है |
| Scratch DB, 100 users | ~11 ms | ~6 ms |
| किसके लिए best | कोई matching index नहीं, ties/complex ranking, या N group size के क़रीब | हर group में बहुत rows, (group, sort) पर index |

N की तुलना में हर group में जितनी ज़्यादा rows होंगी, LATERAL का फ़ायदा उतना बड़ा होगा। Index के बिना LATERAL बहुत बुरा हो जाता है (हर user के लिए एक scan), जबकि window version बस sort करता है।

PostgreSQL 15+ window version की मदद करता है: यह plan में `Run Condition: (row_number() OVER (?) <= 3)` दिखाता है और limit पार होते ही हर partition के लिए row numbers निकालना बंद कर देता है।

## 12. आम ग़लतियाँ और gotchas

- **`WHERE` में window function पर filter करना।** इसकी इजाज़त नहीं है; उसे subquery या CTE में लपेटिए।
- **बिना tie-breaker के ROW_NUMBER** values tie होने पर हर run में अलग winners देता है।
- `LAST_VALUE` और tied values पर running totals के साथ **default frame के surprises**।
- **यह मान लेना कि CTEs हमेशा materialize होते हैं** (12 से पहले वाली सलाह) या कभी नहीं होते। Plan check कीजिए।
- User-editable hierarchies पर **बिना cycle guard वाला recursive CTE**।
- जब पिछली value 0 या NULL हो, तब **`LAG()` से भाग देना**। `NULLIF(LAG(x) OVER w, 0)` इस्तेमाल कीजिए।
- **Integer division:** integers पर `count_a / count_b` दशमलव काट देता है। पहले `100.0` से गुणा कीजिए।

## 13. Window functions vs GROUP BY

| | GROUP BY | Window function |
|---|---|---|
| Output rows | हर group की एक | हर input row की एक |
| Row details तक पहुँच | सिर्फ़ grouped columns और aggregates | हर column, साथ में निकाली गई value |
| आम सवाल | "हर महीने का revenue" | "हर महीने का revenue और पिछले महीने की तुलना में उसकी growth" |
| Ranking, पिछली/अगली row | ❌ | ✅ |
| कब चलता है | `HAVING` से पहले | `GROUP BY`/`HAVING` के बाद, `ORDER BY`/`LIMIT` से पहले |
| मिला सकते हैं? | ✅ पहले aggregate, फिर groups पर window | |

## 14. Trade-offs: इन्हें कब इस्तेमाल न करें

- **बहुत बड़े window sorts।** मेरे test में बिना index के 500k rows पर `PARTITION BY user_id ORDER BY created_at` को 22 MB का on-disk sort चाहिए था। Partition और order से match करने वाला index sort को हटा देता है।
- **बड़े history पर dashboards** जो हर page load पर दोबारा compute होते हैं: उन्हें पहले से summary table या materialized view में compute कर लीजिए।
- बहुत बड़े graphs पर **गहरी recursive queries**: PostgreSQL यह कर सकता है, लेकिन कोई dedicated model (closure table, `ltree`, या graph database) बेहतर fit हो सकता है।
- **चालाकी से ज़्यादा readability।** तीन नाम वाले CTEs एक ऐसी nested query से बेहतर हैं जिसे कोई review न कर सके।

> **याद रखें:** GROUP BY जवाब देता है "हर group में कितना"। Window functions जवाब देते हैं "यह row अपने group से कैसे तुलना करती है"। CTEs दोनों को readable बनाते हैं।
