---
slug: postgres-data-types-and-constraints
title: 'Data types and constraints: the bouncer at the door of your tables'
module: Data Modeling
order: 40
summary: How to pick the right PostgreSQL type for money, text, time, ids, JSON and status fields, and how NOT NULL, UNIQUE, PRIMARY KEY, FOREIGN KEY, CHECK, EXCLUDE and generated columns let the database itself refuse bad data, ending with a complete e-commerce schema.
level: beginner
tags: [postgresql, data-types, constraints, schema-design, numeric, timestamptz, foreign-keys, identity]
recap: >-
  Choose types that make bad data impossible: bigint identity for ids, numeric for money (never float), text for strings,
  timestamptz for moments in time, uuid for public ids and jsonb only for truly flexible attributes. Then let constraints
  guard the door: NOT NULL, UNIQUE (NULLs are distinct unless you say NULLS NOT DISTINCT), PRIMARY KEY, FOREIGN KEY with
  a deliberate ON DELETE rule and an index you create yourself, CHECK rules like stock >= 0, and EXCLUDE for overlaps.
  Constraints in the database protect every code path, not just the one that goes through your Mongoose model.
---

## 1. The story

A nightclub has a **bouncer** at the door with a checklist:

- "Do you have ID?" (no ID, no entry)
- "Are you on the list only once?" (no duplicate guests)
- "Is your +1 actually someone on the guest list?" (no imaginary friends)
- "Are you over 18?" (a rule about the value itself)

The bouncer checks **everyone**, whichever door they come through: the main entrance, the VIP side door, or the kitchen. Inside, nobody has to double-check.

| Nightclub | PostgreSQL |
|---|---|
| Wristband colour (adult, VIP, staff) | **Data type**: what kind of value a column can hold |
| "Must show ID" | `NOT NULL` |
| "On the list only once" | `UNIQUE` / `PRIMARY KEY` |
| "+1 must be a real guest" | `FOREIGN KEY` |
| "Over 18" | `CHECK (age >= 18)` |
| Every door has the same bouncer | Constraints apply to **every** client: API, admin script, migration, psql |

> **Remember:** types decide what a value **can** be; constraints decide what the database **accepts**. Together they make bad data impossible, not just unlikely.

## 2. Why this matters

In a MERN app, validation usually lives in a Mongoose schema or a Joi/Zod validator. That protects one code path. Then reality happens:

- A cron job writes with the raw driver and skips Mongoose.
- A teammate runs a fix-up script.
- Two concurrent requests both pass the "email not taken" check and both insert.

The last one is the killer: **app-level uniqueness checks are race conditions**. Only a unique index in the database can enforce uniqueness under concurrency (Mongoose's own `unique: true` is, in fact, just a MongoDB unique index, not a validator).

In PostgreSQL the schema is enforced by the database itself, for every writer, inside the same transaction as the write.

## 3. Numbers: integer, bigint, numeric, and never float for money

| Type | Range / precision | Use for |
|---|---|---|
| `smallint` | ±32,767 | Ratings 1–5, small codes |
| `integer` | ±2.1 billion | Quantities, stock |
| `bigint` | ±9.2 × 10^18 | **Primary keys**, counters that grow forever |
| `numeric(p,s)` | Exact decimal | **Money**, anything a customer sees |
| `real` / `double precision` | Approximate binary float | Measurements, scientific values |

Why never float for money? Floats are binary fractions, and 0.1 has no exact binary representation. Real output from PostgreSQL:

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

Summing 0.1 a thousand times gives `99.9999999999986` as a float and exactly `100.0` as numeric. Invoices that are off by a paisa are a support ticket; ledgers that don't balance are an audit finding.

- `numeric(10,2)` stores up to 99,999,999.99 and **rounds** extra decimals (`19.999` → `20.00`).
- `numeric` is slower than integers. If you need raw speed, store **integer minor units** (`amount_paise bigint`), the way Stripe does.
- Use `bigint` for ids. `integer` overflows at 2.1 billion (`ERROR: integer out of range`), and changing a primary key type on a large live table is a painful migration.

## 4. Text: text vs varchar(n)

In PostgreSQL, `text`, `varchar` and `varchar(n)` are stored **the same way** and perform the same. The only difference: `varchar(n)` rejects longer values (`ERROR: value too long for type character varying(5)`).

- Use **`text`** by default.
- If there's a real business limit, express it as a constraint: `CHECK (length(full_name) <= 200)`. Changing a CHECK later is easier than altering a column type.
- Avoid `char(n)`: it pads with spaces, which causes surprising comparisons.

## 5. Time: timestamptz, timestamp, date

This is the type choice people get wrong most often.

| Type | Stores | Meaning |
|---|---|---|
| `timestamptz` | An absolute instant (internally UTC) | "The order was placed at this moment" |
| `timestamp` | A date and wall-clock time, **no zone** | "9:00", but 9:00 where? |
| `date` | A calendar day | Birthdays, delivery date |

Despite the name, `timestamptz` does **not** store a time zone. It converts the input to UTC on the way in and converts to the **session's** `TimeZone` on the way out. Same row, three sessions:

```text
 session TimeZone   timestamp (a)          timestamptz (b)
 ─────────────────  ─────────────────────  ─────────────────────────
 Asia/Kolkata       2026-10-11 09:00:00    2026-10-11 09:00:00+05:30
 America/New_York   2026-10-11 09:00:00    2026-10-10 23:30:00-04
 UTC                2026-10-11 09:00:00    2026-10-11 03:30:00+00
```

The `timestamptz` value is the **same instant** shown three ways. The `timestamp` value is just "09:00" and nobody knows in which zone. Worse, if you insert `'2026-10-11 09:00+05:30'` into a `timestamp` column, the offset is **silently discarded**.

Rule: **always `timestamptz`** for events (`created_at`, `paid_at`, `shipped_at`). Store instants, and convert to the user's zone in the UI. The `pg` driver for Node.js returns `timestamptz` as a JavaScript `Date`, which is also an absolute instant, so they fit together perfectly.

> **Remember:** money → `numeric` (or integer cents), ids → `bigint`, strings → `text`, moments → `timestamptz`. Floats and zone-less timestamps cause bugs that look fine in testing.

## 6. Booleans, UUIDs, JSON and arrays

- **`boolean`**: real `true`/`false`/`NULL`. Not `'Y'`/`'N'` strings, not `0`/`1`.
- **`uuid`**: 16 bytes, not a 36-character string. `gen_random_uuid()` is built in since PostgreSQL 13 (no extension needed). Common pattern: a `bigint` identity as the internal primary key, plus a `uuid` **public id** for URLs so customers can't guess `/orders/1001`.
- **`jsonb`**: binary JSON, indexable with GIN. Great for genuinely variable attributes (a laptop has `ram_gb`, a T-shirt has `size`). Don't put fields you filter, join or constrain on every day into JSON; give them real columns. Deep dive: [JSONB and full-text search](/lessons/postgres-jsonb-and-full-text).
- **Arrays** (`text[]`): good for small lists of simple values like tags. Query with `tags @> ARRAY['sale']` or `'gift' = ANY(tags)`. If the list items need their own attributes or foreign keys, use a separate table.

## 7. Status columns: enum vs lookup table vs CHECK

Three ways to restrict `orders.status`:

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
| Storage | 4 bytes | The text value | The text (or an id) |
| Add a value | `ALTER TYPE ... ADD VALUE` (easy) | Replace the constraint | `INSERT` a row |
| Remove / rename | Rename yes; **removing isn't supported** | Replace the constraint | `DELETE` / `UPDATE` |
| Extra data per value | ❌ | ❌ | ✅ (label, sort order, is_final) |
| Sort order | Declaration order, not alphabetical | Alphabetical | Whatever you define |

A subtle enum gotcha: `WHERE status > 'paid'` compares by **declaration order**, so it matches shipped, delivered and cancelled. Handy or surprising, depending on whether you expected it.

Pick CHECK for small, stable sets; a lookup table when the business edits the list or needs metadata; enums when values only ever get added.

## 8. Identity columns vs serial

```sql
-- old way
id serial PRIMARY KEY
-- modern, SQL-standard way
id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
```

Both use a sequence behind the scenes. Prefer **identity** because:

- `GENERATED ALWAYS` **rejects** manually supplied ids (`cannot insert a non-DEFAULT value into column "id"`), so a buggy import can't collide with the sequence later. You can still override deliberately with `OVERRIDING SYSTEM VALUE`.
- The sequence is owned by and tied to the column, with simpler permissions.
- `serial` is `integer`, a 2.1 billion ceiling. Use `bigint` either way.

Sequences can have **gaps** (rolled-back inserts still consume values). Never use ids as "count of orders" or invoice numbers that must be gapless.

## 9. Constraints, one by one

**NOT NULL**: the column must have a value. Make it the default habit; allow NULL only when "unknown" is a real state.

**DEFAULT**: the value used when an insert omits the column: `DEFAULT now()`, `DEFAULT 0`, `DEFAULT gen_random_uuid()`. A default is not a constraint; it doesn't stop someone from explicitly inserting a bad value.

**UNIQUE**: no two rows share the value. Backed by a unique B-tree index. The NULL catch:

```sql
CREATE TABLE coupon_uses (code text, user_id bigint, UNIQUE (code, user_id));
INSERT INTO coupon_uses VALUES ('WELCOME', NULL), ('WELCOME', NULL);  -- both succeed!
```

By default **NULLs are distinct**: NULL means "unknown", and two unknowns aren't considered equal. Since PostgreSQL 15 you can say otherwise:

```sql
UNIQUE NULLS NOT DISTINCT (code, user_id)
-- ERROR: duplicate key value violates unique constraint
-- DETAIL: Key (code, user_id)=(WELCOME, null) already exists.
```

Sometimes the default is exactly what you want: `UNIQUE (provider, provider_ref)` on payments allows many cash-on-delivery payments with no `provider_ref`.

**PRIMARY KEY**: `UNIQUE` + `NOT NULL`, one per table. Can be composite: `PRIMARY KEY (order_id, product_id)`.

**FOREIGN KEY**: the value must exist in the referenced table. You choose what happens when the parent row is deleted:

| `ON DELETE` | Deleting a user with orders… | Use for |
|---|---|---|
| `NO ACTION` / `RESTRICT` | Fails with an error | Orders, payments: history you must keep |
| `CASCADE` | Deletes the child rows too | `order_items` when an order is deleted |
| `SET NULL` | Sets the child's FK column to NULL | `reviews.user_id` when an account is erased |

(`NO ACTION`, the default, and `RESTRICT` both block the delete; `NO ACTION` checks at the end of the statement and can be deferred, `RESTRICT` checks immediately.)

⚠️ **PostgreSQL does not index foreign key columns automatically.** It indexes the **referenced** side (the primary key) but not `orders.user_id`. Without that index, joins from users to orders scan, and every `DELETE FROM users` must scan `orders` to check for references. Create them yourself:

```sql
CREATE INDEX orders_user_id_idx ON orders (user_id);
```

**CHECK**: any boolean expression on the row.

```sql
stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0)
```

```text
UPDATE products SET stock = stock - 1000 WHERE id = 1;
ERROR:  new row for relation "products" violates check constraint "products_stock_check"
```

This single line is a last line of defence against overselling, whatever the app code does (see [Concurrency and locking](/lessons/concurrency-and-locking)). CHECK constraints see only the current row; rules across rows or tables need UNIQUE, FK, EXCLUDE or triggers.

**EXCLUDE**: a generalization of UNIQUE with any operator. "No two promotions for the same product may overlap in time":

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

**Generated columns**: computed from other columns and stored.

```sql
line_total numeric(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED
```

You can't write to it (`column "line_total" can only be updated to DEFAULT`); it's always consistent.

> **Remember:** UNIQUE treats NULLs as different unless you write `NULLS NOT DISTINCT`. Foreign keys are not indexed for you. CHECK is your free, always-on validator.

## 10. The full e-commerce schema

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

- `order_items.unit_price` copies the price **at purchase time**; `products.price` will change later.
- The composite primary key on `order_items` already covers lookups by `order_id` (leftmost column), so only `product_id` needs its own index.
- `users.email` is forced to lowercase by a CHECK, so the plain unique index enforces case-insensitive uniqueness. (The alternative is a unique index on `lower(email)`.)
- `categories` uses `NULLS NOT DISTINCT` so two top-level categories can't share a name.

## 11. Common mistakes and gotchas

- **`float` or `real` for prices.** Rounding errors that accumulate in totals.
- **`timestamp` without time zone** for events. Offsets silently dropped; daylight-saving bugs.
- **`integer` primary keys** on tables that will grow. Use `bigint` from day one.
- **Forgetting FK indexes.** Slow joins and painfully slow parent deletes.
- **`ON DELETE CASCADE` everywhere.** One `DELETE FROM users` can silently wipe orders and payments you're legally required to keep.
- **Expecting UNIQUE to block duplicate NULLs.** It doesn't, unless `NULLS NOT DISTINCT`.
- **Adding a constraint to a big live table in one step.** `ADD CONSTRAINT ... CHECK (...) NOT VALID` first (only new rows are checked), then `VALIDATE CONSTRAINT` separately, which checks existing rows with a lighter lock.

## 12. Database constraints vs app validation

| | Mongoose / Zod validation | PostgreSQL constraints |
|---|---|---|
| Where it runs | In one app's code path | Inside the database, for every writer |
| Bypassed by | Raw driver, scripts, other services, `updateOne` without validators | Nothing (short of dropping the constraint) |
| Concurrency-safe uniqueness | ❌ check-then-insert races | ✅ unique index |
| Cross-table rules | Manual lookups | `FOREIGN KEY`, `EXCLUDE` |
| Friendly error messages | ✅ great | ⚠️ generic, map SQLSTATE codes (`23505` unique, `23503` FK, `23514` check) |

Use **both**: app validation for friendly, early feedback; database constraints as the guarantee.

## 13. Trade-offs: when to hold back

- **Every constraint costs a little on writes.** FKs need a lookup in the parent; that's almost always worth it, but very hot ingest tables (raw events, logs) are often left without them.
- **Over-strict types age badly.** `varchar(50)` for names or an enum for something marketing edits weekly will cause migrations. Prefer `text` + CHECK, or a lookup table.
- **jsonb isn't a shortcut around modelling.** It drops type checking, FKs and statistics on the fields inside. Use it for the genuinely unstructured part.
- **Cascades hide deletes.** Prefer explicit soft deletes or `RESTRICT` for business records.

> **Remember:** make the database the last line of defence. If a rule must **always** hold, it belongs in a constraint, not only in a Mongoose schema.
