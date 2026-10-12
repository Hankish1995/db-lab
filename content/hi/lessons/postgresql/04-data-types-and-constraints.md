---
slug: postgres-data-types-and-constraints
title: 'Data types और constraints: आपकी tables के दरवाज़े पर खड़ा bouncer'
module: Data Modeling
summary: 'Money, text, time, ids, JSON और status fields के लिए सही PostgreSQL type कैसे चुनें, और NOT NULL, UNIQUE, PRIMARY KEY, FOREIGN KEY, CHECK, EXCLUDE और generated columns कैसे database को ख़ुद ख़राब data ठुकराने देते हैं; आख़िर में एक पूरा e-commerce schema।'
recap: >-
  ऐसे types चुनें जो ख़राब data को नामुमकिन बना दें: ids के लिए bigint identity, money के लिए numeric (float कभी नहीं),
  strings के लिए text, समय के पलों के लिए timestamptz, public ids के लिए uuid, और jsonb सिर्फ़ सच में flexible attributes
  के लिए। फिर constraints को दरवाज़े पर पहरा देने दें: NOT NULL, UNIQUE (NULLs distinct माने जाते हैं जब तक आप NULLS NOT
  DISTINCT न लिखें), PRIMARY KEY, सोच-समझकर चुने ON DELETE rule और ख़ुद बनाए index के साथ FOREIGN KEY, stock >= 0 जैसे
  CHECK rules, और overlaps के लिए EXCLUDE। Database के constraints हर code path को बचाते हैं, सिर्फ़ उसे नहीं जो आपके
  Mongoose model से होकर जाता है।
---

## 1. कहानी

एक nightclub के दरवाज़े पर एक **bouncer** checklist लेकर खड़ा है:

- "ID है?" (ID नहीं, तो entry नहीं)
- "क्या आप list में सिर्फ़ एक बार हैं?" (कोई duplicate guest नहीं)
- "क्या आपका +1 सच में guest list में है?" (कोई काल्पनिक दोस्त नहीं)
- "क्या आप 18 से ऊपर हैं?" (ख़ुद value के बारे में एक नियम)

Bouncer **हर किसी** को check करता है, चाहे वह किसी भी दरवाज़े से आए: main entrance, VIP side door, या kitchen। अंदर किसी को दोबारा check नहीं करना पड़ता।

| Nightclub | PostgreSQL |
|---|---|
| Wristband का रंग (adult, VIP, staff) | **Data type**: column किस तरह की value रख सकता है |
| "ID दिखाना ज़रूरी" | `NOT NULL` |
| "List में सिर्फ़ एक बार" | `UNIQUE` / `PRIMARY KEY` |
| "+1 असली guest होना चाहिए" | `FOREIGN KEY` |
| "18 से ऊपर" | `CHECK (age >= 18)` |
| हर दरवाज़े पर वही bouncer | Constraints **हर** client पर लागू होते हैं: API, admin script, migration, psql |

> **याद रखें:** types तय करते हैं कि value क्या **हो सकती** है; constraints तय करते हैं कि database क्या **accept** करता है। मिलकर ये ख़राब data को सिर्फ़ मुश्किल नहीं, नामुमकिन बना देते हैं।

## 2. यह क्यों ज़रूरी है

MERN app में validation आमतौर पर Mongoose schema या Joi/Zod validator में रहता है। यह एक code path को बचाता है। फिर असलियत सामने आती है:

- कोई cron job raw driver से लिखता है और Mongoose को skip कर देता है।
- कोई teammate fix-up script चला देता है।
- दो concurrent requests दोनों "email पहले से नहीं लिया गया" check पास कर लेती हैं और दोनों insert कर देती हैं।

आख़िरी वाला सबसे ख़तरनाक है: **app-level uniqueness checks race conditions हैं**। Concurrency में uniqueness सिर्फ़ database का unique index ही enforce कर सकता है (Mongoose का अपना `unique: true` भी असल में बस एक MongoDB unique index है, validator नहीं)।

PostgreSQL में schema ख़ुद database enforce करता है, हर writer के लिए, उसी transaction के अंदर जिसमें write हो रहा है।

## 3. Numbers: integer, bigint, numeric, और money के लिए float कभी नहीं

| Type | Range / precision | किसके लिए |
|---|---|---|
| `smallint` | ±32,767 | Ratings 1–5, छोटे codes |
| `integer` | ±2.1 billion | Quantities, stock |
| `bigint` | ±9.2 × 10^18 | **Primary keys**, हमेशा बढ़ने वाले counters |
| `numeric(p,s)` | Exact decimal | **Money**, जो कुछ भी customer देखता है |
| `real` / `double precision` | Approximate binary float | Measurements, scientific values |

Money के लिए float कभी क्यों नहीं? Floats binary fractions होते हैं, और 0.1 का कोई exact binary रूप नहीं होता। PostgreSQL का असली output:

```sql
SELECT 0.1::float8 + 0.2::float8         AS float_sum,
       0.1::float8 + 0.2::float8 = 0.3   AS float_equal,
       0.1::numeric + 0.2::numeric       AS numeric_sum;
```

```text
      float_sum      │ float_equal │ numeric_sum
─────────────────────┼─────────────┼─────────────
 0.30000000000000004 │ f           │         0.3
```

0.1 को हज़ार बार जोड़ने पर float में `99.9999999999986` आता है और numeric में ठीक `100.0`। एक पैसे से ग़लत invoices एक support ticket हैं; जो ledgers balance न हों वे audit finding हैं।

- `numeric(10,2)` 99,999,999.99 तक रखता है और ज़्यादा decimals को **round** करता है (`19.999` → `20.00`)।
- `numeric` integers से धीमा है। अगर raw speed चाहिए, तो **integer minor units** store कीजिए (`amount_paise bigint`), जैसा Stripe करता है।
- Ids के लिए `bigint` इस्तेमाल कीजिए। `integer` 2.1 billion पर overflow हो जाता है (`ERROR: integer out of range`), और बड़ी live table पर primary key का type बदलना एक दर्दनाक migration है।

## 4. Text: text vs varchar(n)

PostgreSQL में `text`, `varchar` और `varchar(n)` **एक ही तरह** store होते हैं और performance भी एक जैसी है। फ़र्क़ बस इतना है: `varchar(n)` लंबी values को reject करता है (`ERROR: value too long for type character varying(5)`)।

- Default रूप से **`text`** इस्तेमाल कीजिए।
- अगर कोई असली business limit है, तो उसे constraint की तरह लिखिए: `CHECK (length(full_name) <= 200)`। बाद में CHECK बदलना column type बदलने से आसान है।
- `char(n)` से बचिए: यह spaces से padding करता है, जिससे comparisons में अजीब नतीजे आते हैं।

## 5. Time: timestamptz, timestamp, date

यह वह type choice है जिसमें लोग सबसे ज़्यादा ग़लती करते हैं।

| Type | क्या store करता है | मतलब |
|---|---|---|
| `timestamptz` | एक absolute instant (अंदर UTC में) | "Order इसी पल place हुआ था" |
| `timestamp` | Date और घड़ी का समय, **कोई zone नहीं** | "9:00", लेकिन कहाँ के 9:00? |
| `date` | एक calendar day | Birthdays, delivery date |

नाम के बावजूद `timestamptz` time zone store **नहीं** करता। यह input को अंदर जाते समय UTC में बदलता है और बाहर आते समय **session** के `TimeZone` में। एक ही row, तीन sessions:

```text
 session TimeZone   timestamp (a)          timestamptz (b)
 ─────────────────  ─────────────────────  ─────────────────────────
 Asia/Kolkata       2026-10-11 09:00:00    2026-10-11 09:00:00+05:30
 America/New_York   2026-10-11 09:00:00    2026-10-10 23:30:00-04
 UTC                2026-10-11 09:00:00    2026-10-11 03:30:00+00
```

`timestamptz` value वही **एक instant** है जो तीन तरह से दिखाया गया। `timestamp` value बस "09:00" है और किसी को नहीं पता कि किस zone में। और बुरा यह कि अगर आप `timestamp` column में `'2026-10-11 09:00+05:30'` insert करें, तो offset **चुपचाप फेंक दिया जाता है**।

नियम: events (`created_at`, `paid_at`, `shipped_at`) के लिए **हमेशा `timestamptz`**। Instants store कीजिए, और UI में user के zone में convert कीजिए। Node.js का `pg` driver `timestamptz` को JavaScript `Date` के रूप में लौटाता है, जो भी एक absolute instant है, इसलिए दोनों एकदम fit बैठते हैं।

> **याद रखें:** money → `numeric` (या integer cents), ids → `bigint`, strings → `text`, पल → `timestamptz`। Floats और बिना zone वाले timestamps ऐसे bugs पैदा करते हैं जो testing में ठीक दिखते हैं।

## 6. Booleans, UUIDs, JSON और arrays

- **`boolean`**: असली `true`/`false`/`NULL`। `'Y'`/`'N'` strings नहीं, `0`/`1` नहीं।
- **`uuid`**: 16 bytes, 36-character string नहीं। `gen_random_uuid()` PostgreSQL 13 से built in है (कोई extension नहीं चाहिए)। आम pattern: internal primary key के लिए `bigint` identity, और URLs के लिए एक `uuid` **public id** ताकि customers `/orders/1001` का अंदाज़ा न लगा सकें।
- **`jsonb`**: binary JSON, GIN से indexable। सच में बदलते रहने वाले attributes के लिए बढ़िया (laptop में `ram_gb` है, T-shirt में `size`)। जिन fields पर आप रोज़ filter, join या constraint लगाते हैं उन्हें JSON में मत डालिए; उन्हें असली columns दीजिए। गहराई से: [JSONB and full-text search](/lessons/postgres-jsonb-and-full-text)।
- **Arrays** (`text[]`): tags जैसी simple values की छोटी lists के लिए अच्छे। `tags @> ARRAY['sale']` या `'gift' = ANY(tags)` से query कीजिए। अगर list items को अपने attributes या foreign keys चाहिए, तो अलग table इस्तेमाल कीजिए।

## 7. Status columns: enum vs lookup table vs CHECK

`orders.status` को सीमित करने के तीन तरीक़े:

```sql
-- 1. ENUM type
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'delivered', 'cancelled');

-- 2. CHECK constraint on text
status text NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled'))

-- 3. Lookup table + foreign key
CREATE TABLE order_statuses (code text PRIMARY KEY, label text NOT NULL);
status text NOT NULL REFERENCES order_statuses (code)
```

| | ENUM | CHECK | Lookup table |
|---|---|---|---|
| Storage | 4 bytes | Text value | Text (या एक id) |
| Value जोड़ना | `ALTER TYPE ... ADD VALUE` (आसान) | Constraint बदलिए | एक row `INSERT` कीजिए |
| हटाना / rename | Rename हाँ; **हटाना supported नहीं** | Constraint बदलिए | `DELETE` / `UPDATE` |
| हर value के साथ extra data | ❌ | ❌ | ✅ (label, sort order, is_final) |
| Sort order | Declaration order, alphabetical नहीं | Alphabetical | जो आप define करें |

Enum का एक बारीक gotcha: `WHERE status > 'paid'` **declaration order** से compare करता है, इसलिए यह shipped, delivered और cancelled से match करता है। आपने इसकी उम्मीद की थी या नहीं, इसके हिसाब से यह काम का भी है और चौंकाने वाला भी।

छोटे, stable sets के लिए CHECK चुनिए; जब business list edit करता हो या metadata चाहिए तो lookup table; और जब values सिर्फ़ जुड़ती ही हों तो enums।

## 8. Identity columns vs serial

```sql
-- old way
id serial PRIMARY KEY
-- modern, SQL-standard way
id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
```

दोनों पर्दे के पीछे एक sequence इस्तेमाल करते हैं। **Identity** को प्राथमिकता दीजिए क्योंकि:

- `GENERATED ALWAYS` हाथ से दिए गए ids को **reject** करता है (`cannot insert a non-DEFAULT value into column "id"`), ताकि कोई buggy import बाद में sequence से टकरा न सके। आप फिर भी `OVERRIDING SYSTEM VALUE` से जान-बूझकर override कर सकते हैं।
- Sequence column का owned होता है और उसी से बँधा होता है, permissions भी आसान रहती हैं।
- `serial` एक `integer` है, यानी 2.1 billion की छत। दोनों में से कुछ भी चुनें, `bigint` इस्तेमाल कीजिए।

Sequences में **gaps** हो सकते हैं (rolled-back inserts भी values खा जाते हैं)। Ids को कभी "orders की गिनती" या ऐसे invoice numbers की तरह इस्तेमाल मत कीजिए जिनमें gap नहीं होना चाहिए।

## 9. Constraints, एक-एक करके

**NOT NULL**: column में value होनी चाहिए। इसे default आदत बनाइए; NULL तभी allow कीजिए जब "unknown" एक असली state हो।

**DEFAULT**: वह value जो तब इस्तेमाल होती है जब insert में column छोड़ दिया जाए: `DEFAULT now()`, `DEFAULT 0`, `DEFAULT gen_random_uuid()`। Default कोई constraint नहीं है; यह किसी को explicitly ख़राब value insert करने से नहीं रोकता।

**UNIQUE**: दो rows की value एक जैसी नहीं हो सकती। इसके पीछे एक unique B-tree index होता है। NULL वाला पेच:

```sql
CREATE TABLE coupon_uses (code text, user_id bigint, UNIQUE (code, user_id));
INSERT INTO coupon_uses VALUES ('WELCOME', NULL), ('WELCOME', NULL);  -- both succeed!
```

Default रूप से **NULLs distinct होते हैं**: NULL का मतलब "unknown" है, और दो unknowns बराबर नहीं माने जाते। PostgreSQL 15 से आप इसका उल्टा कह सकते हैं:

```sql
UNIQUE NULLS NOT DISTINCT (code, user_id)
-- ERROR: duplicate key value violates unique constraint
-- DETAIL: Key (code, user_id)=(WELCOME, null) already exists.
```

कभी-कभी default ही वही होता है जो आप चाहते हैं: payments पर `UNIQUE (provider, provider_ref)` बिना `provider_ref` वाले कई cash-on-delivery payments की इजाज़त देता है।

**PRIMARY KEY**: `UNIQUE` + `NOT NULL`, हर table में एक। Composite भी हो सकती है: `PRIMARY KEY (order_id, product_id)`।

**FOREIGN KEY**: value referenced table में मौजूद होनी चाहिए। Parent row delete होने पर क्या हो, यह आप चुनते हैं:

| `ON DELETE` | Orders वाले user को delete करने पर… | किसके लिए |
|---|---|---|
| `NO ACTION` / `RESTRICT` | Error के साथ fail होता है | Orders, payments: history जो रखनी ही है |
| `CASCADE` | Child rows भी delete कर देता है | Order delete होने पर `order_items` |
| `SET NULL` | Child का FK column NULL कर देता है | Account मिटाए जाने पर `reviews.user_id` |

(`NO ACTION`, जो default है, और `RESTRICT` दोनों delete को रोकते हैं; `NO ACTION` statement के अंत में check करता है और defer किया जा सकता है, `RESTRICT` तुरंत check करता है।)

⚠️ **PostgreSQL foreign key columns को अपने-आप index नहीं करता।** यह **referenced** side (primary key) को index करता है, लेकिन `orders.user_id` को नहीं। उस index के बिना users से orders के joins scan करते हैं, और हर `DELETE FROM users` को references check करने के लिए `orders` scan करना पड़ता है। इन्हें ख़ुद बनाइए:

```sql
CREATE INDEX orders_user_id_idx ON orders (user_id);
```

**CHECK**: row पर कोई भी boolean expression।

```sql
stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0)
```

```text
UPDATE products SET stock = stock - 1000 WHERE id = 1;
ERROR:  new row for relation "products" violates check constraint "products_stock_check"
```

यह एक लाइन overselling के ख़िलाफ़ बचाव की आख़िरी दीवार है, app code चाहे जो करे (देखें [Concurrency and locking](/lessons/concurrency-and-locking))। CHECK constraints सिर्फ़ current row देखते हैं; कई rows या tables वाले नियमों के लिए UNIQUE, FK, EXCLUDE या triggers चाहिए।

**EXCLUDE**: UNIQUE का किसी भी operator वाला generalization। "एक ही product के दो promotions समय में overlap नहीं कर सकते":

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- lets GiST handle "=" on bigint

CREATE TABLE promotions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id    bigint NOT NULL REFERENCES products (id),
  discount_pct  int    NOT NULL CHECK (discount_pct BETWEEN 1 AND 90),
  active_during tstzrange NOT NULL,
  EXCLUDE USING gist (product_id WITH =, active_during WITH &&)
);
-- [Nov 20, Nov 30) then [Nov 25, Dec 2) for the same product:
-- ERROR: conflicting key value violates exclusion constraint
```

**Generated columns**: दूसरे columns से compute होकर store होते हैं।

```sql
line_total numeric(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED
```

आप इसमें लिख नहीं सकते (`column "line_total" can only be updated to DEFAULT`); यह हमेशा consistent रहता है।

> **याद रखें:** UNIQUE NULLs को अलग-अलग मानता है जब तक आप `NULLS NOT DISTINCT` न लिखें। Foreign keys आपके लिए index नहीं होतीं। CHECK आपका मुफ़्त, हमेशा चालू validator है।

## 10. पूरा e-commerce schema

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'delivered', 'cancelled');

CREATE TABLE users (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   uuid        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  email       text        NOT NULL,
  full_name   text        NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  referred_by bigint      REFERENCES users (id) ON DELETE SET NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE categories (
  id        int  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      text NOT NULL,
  parent_id int  REFERENCES categories (id) ON DELETE RESTRICT,
  UNIQUE NULLS NOT DISTINCT (parent_id, name)
);

CREATE TABLE products (
  id          bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku         text          NOT NULL UNIQUE,
  name        text          NOT NULL,
  category_id int           NOT NULL REFERENCES categories (id),
  price       numeric(10,2) NOT NULL CHECK (price >= 0),
  stock       integer       NOT NULL DEFAULT 0 CHECK (stock >= 0),
  tags        text[]        NOT NULL DEFAULT '{}',
  attributes  jsonb         NOT NULL DEFAULT '{}',
  created_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX products_category_id_idx ON products (category_id);

CREATE TABLE orders (
  id         bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status     order_status  NOT NULL DEFAULT 'pending',
  total      numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  currency   text          NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_id_idx ON orders (user_id);

CREATE TABLE order_items (
  order_id   bigint        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id bigint        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  quantity   integer       NOT NULL CHECK (quantity > 0),
  unit_price numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  line_total numeric(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX order_items_product_id_idx ON order_items (product_id);

CREATE TABLE payments (
  id           bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     bigint        NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  provider     text          NOT NULL CHECK (provider IN ('card', 'upi', 'cod')),
  provider_ref text,
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  paid_at      timestamptz,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX payments_order_id_idx ON payments (order_id);

CREATE TABLE reviews (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id bigint      NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  user_id    bigint      REFERENCES users (id) ON DELETE SET NULL,
  rating     smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id)
);
CREATE INDEX reviews_user_id_idx ON reviews (user_id);
```

Design notes:

- `order_items.unit_price` **ख़रीदारी के समय** की price copy करता है; `products.price` बाद में बदल जाएगी।
- `order_items` की composite primary key पहले से `order_id` (leftmost column) से होने वाले lookups cover करती है, इसलिए सिर्फ़ `product_id` को अपना index चाहिए।
- `users.email` को एक CHECK lowercase रहने पर मजबूर करता है, इसलिए सादा unique index case-insensitive uniqueness enforce कर देता है। (दूसरा विकल्प `lower(email)` पर unique index है।)
- `categories` में `NULLS NOT DISTINCT` है ताकि दो top-level categories का नाम एक जैसा न हो सके।

## 11. आम ग़लतियाँ और gotchas

- **Prices के लिए `float` या `real`।** Rounding errors जो totals में जमा होते जाते हैं।
- Events के लिए **बिना time zone वाला `timestamp`**। Offsets चुपचाप गिर जाते हैं; daylight-saving bugs।
- बढ़ने वाली tables पर **`integer` primary keys**। पहले दिन से `bigint` इस्तेमाल कीजिए।
- **FK indexes भूल जाना।** धीमे joins और बेहद धीमे parent deletes।
- **हर जगह `ON DELETE CASCADE`।** एक `DELETE FROM users` चुपचाप वे orders और payments मिटा सकता है जिन्हें रखना आपकी क़ानूनी ज़िम्मेदारी है।
- **यह उम्मीद करना कि UNIQUE duplicate NULLs रोकेगा।** नहीं रोकता, जब तक `NULLS NOT DISTINCT` न हो।
- **बड़ी live table पर एक ही step में constraint जोड़ना।** पहले `ADD CONSTRAINT ... CHECK (...) NOT VALID` (सिर्फ़ नई rows check होती हैं), फिर अलग से `VALIDATE CONSTRAINT`, जो हल्के lock के साथ मौजूदा rows check करता है।

## 12. Database constraints vs app validation

| | Mongoose / Zod validation | PostgreSQL constraints |
|---|---|---|
| कहाँ चलता है | एक app के एक code path में | Database के अंदर, हर writer के लिए |
| कौन bypass कर देता है | Raw driver, scripts, दूसरी services, बिना validators वाला `updateOne` | कोई नहीं (जब तक constraint drop न किया जाए) |
| Concurrency-safe uniqueness | ❌ check-then-insert races | ✅ unique index |
| Cross-table rules | हाथ से lookups | `FOREIGN KEY`, `EXCLUDE` |
| Friendly error messages | ✅ बढ़िया | ⚠️ generic, SQLSTATE codes map कीजिए (`23505` unique, `23503` FK, `23514` check) |

**दोनों** इस्तेमाल कीजिए: friendly, जल्दी feedback के लिए app validation; guarantee के लिए database constraints।

## 13. Trade-offs: कब रुकना है

- **हर constraint writes पर थोड़ी क़ीमत लेता है।** FKs को parent में एक lookup चाहिए; यह लगभग हमेशा फ़ायदे का सौदा है, लेकिन बहुत hot ingest tables (raw events, logs) को अक्सर इनके बिना छोड़ दिया जाता है।
- **ज़रूरत से ज़्यादा सख़्त types समय के साथ बुरे साबित होते हैं।** Names के लिए `varchar(50)` या marketing जिसे हर हफ़्ते बदलती है उसके लिए enum, migrations करवाएँगे। `text` + CHECK, या lookup table को प्राथमिकता दीजिए।
- **jsonb modelling से बचने का shortcut नहीं है।** यह अंदर के fields पर type checking, FKs और statistics खो देता है। इसे सिर्फ़ सच में unstructured हिस्से के लिए इस्तेमाल कीजिए।
- **Cascades deletes को छिपा देते हैं।** Business records के लिए explicit soft deletes या `RESTRICT` को प्राथमिकता दीजिए।

> **याद रखें:** database को बचाव की आख़िरी दीवार बनाइए। अगर कोई नियम **हमेशा** लागू होना चाहिए, तो उसकी जगह constraint में है, सिर्फ़ Mongoose schema में नहीं।
