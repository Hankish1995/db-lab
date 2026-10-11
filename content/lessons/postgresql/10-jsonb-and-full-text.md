---
slug: postgres-jsonb-and-full-text
title: 'JSONB and full-text search: a document store and a search box inside PostgreSQL'
module: Features
order: 100
summary: How to store, query, index and update flexible JSONB data, when JSONB beats real columns and when it doesn't, and how to build ranked product search with tsvector, tsquery and GIN indexes.
level: intermediate
tags: [postgresql, jsonb, gin, full-text-search, tsvector, tsquery, indexing, document-database]
recap: >-
  JSONB stores JSON in a parsed binary form with duplicate keys removed and no key order, so it's fast to query and
  indexable. Use operators like ->, ->>, @> and ?, a GIN index for containment and key-existence queries, or an
  expression index for one hot field, and update with jsonb_set or ||. Put varying attributes in JSONB and anything you
  filter, join or constrain on often in real columns. For search, store a generated tsvector column with a GIN index,
  query it with websearch_to_tsquery and rank with ts_rank; reach for Elasticsearch or OpenSearch when you need typo tolerance, facets at scale or heavy relevance tuning.
---

## 1. The story

Your store sells **shoes, phones and books**. They share a few facts (name, price, category) but everything else differs:

- Shoes: size, colour, waterproof.
- Phones: RAM, storage, screen size and type.
- Books: author, pages, format.

In a relational table you'd need dozens of mostly-empty columns, or a new column every time the merchandising team invents an attribute. In MongoDB you'd just store each product's own fields.

PostgreSQL gives you a **labelled drawer** inside each row: a **JSONB** column holds whatever attributes that product has, and you can still query and index it. And next to the shelf there's a **search desk**: **full-text search** understands that a customer typing "running shoe" means the product called "Trail Running Shoes".

| Shop | PostgreSQL |
|---|---|
| Fixed label on every box: name, price | Regular **columns** |
| Drawer of extra details, different per product | A **`jsonb`** column |
| Index cards listing which drawers contain "colour: red" | A **GIN index** |
| Search desk that understands "run" = "running" | **Full-text search** (`tsvector`, `tsquery`) |

## 2. JSON vs JSONB

PostgreSQL has two JSON types. Real output for the same input:

```sql
SELECT '{"b":1, "a":2, "a":3}'::json  AS as_json,
       '{"b":1, "a":2, "a":3}'::jsonb AS as_jsonb;
```

```text
        as_json        |     as_jsonb
-----------------------+------------------
 {"b":1, "a":2, "a":3} | {"a": 3, "b": 1}
```

| | `json` | `jsonb` |
|---|---|---|
| Storage | The exact input text | Parsed **binary** format |
| Duplicate keys | Kept | **Last one wins** |
| Key order, whitespace | Preserved | **Not preserved** |
| Insert speed | Slightly faster (no parsing) | Slightly slower |
| Query speed | Re-parses on every access | **Fast** |
| Indexing (GIN), `@>`, `?` | ❌ | ✅ |

Use **`jsonb`** by default. Use `json` only when you must keep the exact original text (e.g. storing a webhook payload verbatim for auditing).

> **Remember:** JSONB = parsed, deduplicated, unordered and indexable. It's the type you want 99% of the time.

## 3. The operators

```sql
CREATE TABLE catalog (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  category    text NOT NULL,
  price       numeric(10,2) NOT NULL,
  description text NOT NULL,
  attributes  jsonb NOT NULL DEFAULT '{}'
);

INSERT INTO catalog (name, category, price, description, attributes) VALUES
('Trail Running Shoes', 'shoes', 3499,
 'Lightweight running shoes with a grippy sole for muddy trails.',
 '{"brand":"Stride","size":[8,9,10],"color":"red","waterproof":true}'),
('Pixel Phone 9', 'phones', 59999,
 'A fast phone with a great camera and all-day battery.',
 '{"brand":"Pixelco","ram_gb":12,"storage_gb":256,
   "specs":{"screen":{"inches":6.3,"type":"OLED"}},"colors":["black","white"]}');
```

| Operator | Meaning | Example | Result |
|---|---|---|---|
| `->` | Get field as **jsonb** | `attributes -> 'brand'` | `"Pixelco"` |
| `->>` | Get field as **text** | `attributes ->> 'brand'` | `Pixelco` |
| `#>` | Get by **path** as jsonb | `attributes #> '{specs,screen,inches}'` | `6.3` |
| `#>>` | Get by path as text | `attributes #>> '{specs,screen,type}'` | `OLED` |
| `@>` | **Contains** this JSON | `attributes @> '{"color":"red"}'` | true/false |
| `?` | Has this **top-level key** | `attributes ? 'waterproof'` | true/false |
| `?\|` | Has **any** of these keys | `attributes ?\| array['cpu','author']` | true/false |
| `?&` | Has **all** of these keys | `attributes ?& array['ram_gb','specs']` | true/false |

All of these were run on a scratch catalogue (these two products, four more hand-written ones such as "Road Runner 2" and "Budget Phone A1", plus 100,000 generated items); the results above are real. A few things that trip people up:

```sql
-- ->> returns text: cast before comparing numbers
SELECT name FROM catalog WHERE (attributes ->> 'ram_gb')::int >= 12;

-- @> works inside arrays too: shoes available in size 10
SELECT name FROM catalog WHERE attributes @> '{"size":[10]}';

-- SQL/JSON path, for more complex conditions
SELECT name FROM catalog WHERE attributes @? '$.ram_gb ? (@ >= 12)';
SELECT jsonb_path_query(attributes, '$.specs.screen.inches') FROM catalog;
```

## 4. Indexing JSONB

### GIN on the whole column

A **GIN** (generalized inverted) index stores every key and value as a separate entry pointing to the rows that contain it, like the index at the back of a book. With 100,000 products, "green Nova products" before and after:

```sql
CREATE INDEX catalog_attrs_gin ON catalog USING gin (attributes);
```

```text
Before: Seq Scan on catalog
          Filter: (attributes @> '{"brand": "Nova", ...}')
          Rows Removed by Filter: 95006
        Execution Time: 33.307 ms
After:  Bitmap Index Scan on catalog_attrs_gin
          Index Cond: (attributes @> '{"brand": "Nova", ...}')
        Execution Time: 7.084 ms
```

### jsonb_ops vs jsonb_path_ops

| Operator class | Supports | Size here | Use when |
|---|---|---|---|
| **`jsonb_ops`** (default) | `@>`, `?`, `?\|`, `?&`, `@?`, `@@` | 824 kB | You also query key existence |
| **`jsonb_path_ops`** | `@>`, `@?`, `@@` only | 464 kB | You only use containment; smaller and usually faster |

```sql
CREATE INDEX catalog_attrs_pathops ON catalog USING gin (attributes jsonb_path_ops);
```

Verified: with only the `jsonb_path_ops` index, `attributes @> '{"color":"green"}'` used it, but `attributes ? 'waterproof'` fell back to a Seq Scan.

### The trap: GIN does not help `->>` equality

```sql
EXPLAIN SELECT count(*) FROM catalog WHERE attributes ->> 'brand' = 'Nova';
-- Seq Scan on catalog   (even with the GIN index present)
```

GIN indexes serve **operators** like `@>`, not arbitrary expressions. Either rewrite as containment (`attributes @> '{"brand":"Nova"}'`) or create an **expression index** on the one field you filter by most:

```sql
CREATE INDEX catalog_brand_idx ON catalog ((attributes ->> 'brand'));
ANALYZE catalog;
EXPLAIN SELECT id, name FROM catalog WHERE attributes ->> 'brand' = 'Pixelco';
-- Bitmap Index Scan on catalog_brand_idx
```

A B-tree expression index is smaller than a GIN index, supports ranges and sorting, and (after `ANALYZE`) gives the planner **real statistics** for that field. Without it, the planner guessed 500 matching rows for `->> 'brand'`; with it, it estimated 25,225, close to the truth. See [PostgreSQL indexes](/lessons/postgres-indexes) and [EXPLAIN](/lessons/postgres-explain).

> **Remember:** GIN on the whole column for flexible `@>` and `?` queries; a B-tree expression index for one hot field you compare with `=`, `<` or `ORDER BY`.

## 5. Updating JSONB

```sql
-- Set a nested value
UPDATE catalog
SET attributes = jsonb_set(attributes, '{specs,screen,inches}', '6.4')
WHERE name = 'Pixel Phone 9';

-- Merge keys (shallow: right side wins for top-level keys)
UPDATE catalog
SET attributes = attributes || '{"color":"green","on_sale":true}'
WHERE id = 1;

-- Remove a key
UPDATE catalog SET attributes = attributes - 'on_sale' WHERE id = 1;
```

Gotchas, verified:

- `jsonb_set` **won't create missing intermediate objects**: `jsonb_set('{"a":1}', '{x,y}', '2')` returns `{"a": 1}` unchanged.
- `||` is a **shallow** merge: `attributes || '{"specs":{"ram":8}}'` replaces the whole `specs` object.
- Any change rewrites the **whole JSONB value** and creates a new row version ([MVCC](/lessons/postgres-mvcc-and-vacuum)). Large documents updated often are expensive.

## 6. When to use JSONB, and when real columns

This is the classic **attribute problem** (also called EAV: entity-attribute-value). JSONB is usually the best answer to it, within limits.

| Put it in **JSONB** | Put it in a **real column** |
|---|---|
| Attributes that vary by category (screen size, shoe size) | Fields every row has (name, price, category) |
| Rarely filtered, mostly displayed | Filtered, sorted or grouped often |
| Optional, sparse data | Needs `NOT NULL`, `CHECK`, `UNIQUE` |
| Third-party payloads you store as received | Used in **joins** or **foreign keys** |
| Schema changes weekly | Needs accurate planner statistics |

Real columns win on: types enforced by the database, constraints, foreign keys, smaller storage (keys aren't repeated in every row), and statistics the planner understands. A healthy design is **hybrid**: core columns + one `attributes jsonb`. You can enforce rules inside JSONB too, e.g. `CHECK (jsonb_typeof(attributes -> 'ram_gb') = 'number')`, but it gets clumsy fast. See [Normalization](/lessons/normalization) and [Data types and constraints](/lessons/postgres-data-types-and-constraints).

> **Remember:** JSONB for what varies; columns for what you filter, join and constrain on. If you query a JSON field in every request, it has earned a column.

## 7. PostgreSQL as a document database vs MongoDB

| | PostgreSQL + JSONB | MongoDB |
|---|---|---|
| Data model | Rows with JSONB columns, mixed with relational | Documents (BSON) everywhere |
| Joins | Full SQL joins | `$lookup`, discouraged at scale |
| Transactions | Full ACID, any number of rows | Single-document atomic; multi-document transactions available with more overhead |
| Partial updates | Rewrites the whole value | `$set`, `$inc`, `$push` update in place |
| Indexing nested fields | GIN, expression indexes | Indexes on any path, multikey arrays |
| Schema enforcement | Columns + CHECK constraints | Optional JSON Schema validation |
| Horizontal scaling | Mostly vertical, read replicas; sharding via extensions | Built-in sharding |
| Best fit | Relational core with some flexible data | Document-shaped data, high write scale |

For MongoDB modelling, see [MongoDB schema patterns](/lessons/mongodb-schema-patterns).

## 8. Full-text search

`WHERE description ILIKE '%run shoe%'` fails on "running shoes", can't rank results and can't use a normal B-tree index. Full-text search fixes all three.

### tsvector: the document, normalized

```sql
SELECT to_tsvector('english',
  'Lightweight running shoes with a grippy sole for muddy trails.');
```

```text
'grippi':6 'lightweight':1 'muddi':9 'run':2 'shoe':3
'sole':7 'trail':10
```

- **Stemming**: `running` → `run`, `shoes` → `shoe`, `trails` → `trail`. These normalized words are **lexemes** (`grippi` looks odd but it's consistent: the query is stemmed the same way).
- **Stop words** removed: `with`, `a`, `for`.
- Numbers are **positions**, used for phrase search and ranking.

With the `'simple'` configuration nothing is stemmed or removed: `'running':2 'shoes':3 'with':4 'a':5 ...`. The language configuration matters.

### tsquery: the search, normalized

```text
plainto_tsquery('english', 'running shoes for the trails')
  → 'run' & 'shoe' & 'trail'
websearch_to_tsquery('english', '"running shoes" -road or trail')
  → 'run' <-> 'shoe' & !'road' | 'trail'
to_tsquery('english', 'batt:*')
  → 'batt':*        (prefix match)
```

| Function | Input style | Use for |
|---|---|---|
| `to_tsquery` | Operator syntax (`&`, `\|`, `!`, `<->`, `:*`); errors on bad syntax | Queries you build in code |
| `plainto_tsquery` | Plain words, all ANDed | Simple search boxes |
| **`websearch_to_tsquery`** | Google-like: quotes, `or`, `-`; never errors | **User-facing search boxes** |

The match operator is **`@@`**:

```sql
SELECT to_tsvector('english', 'running shoes')
       @@ plainto_tsquery('english', 'run shoe');   -- true
```

### A searchable catalogue: generated column + GIN

```sql
ALTER TABLE catalog ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX catalog_search_idx ON catalog USING gin (search);
```

The generated column keeps itself in sync on every insert and update, no triggers needed. `setweight` marks name matches as more important (`A`) than description matches (`B`).

Real plans for "battery phone" over 100,006 products:

```text
Before index: Seq Scan on catalog
                Filter: (search @@ '''batteri'' & ''phone'''::tsquery)
                Rows Removed by Filter: 100004
              Execution Time: 26.049 ms
After index:  Bitmap Index Scan on catalog_search_idx
              Execution Time: 0.212 ms
```

### Ranking

```sql
SELECT name, ts_rank(search, q) AS rank
FROM catalog, websearch_to_tsquery('english', 'running') AS q
WHERE search @@ q
ORDER BY rank DESC
LIMIT 5;
```

```text
        name         |    rank
---------------------+------------
 Trail Running Shoes | 0.66871977
 Road Runner 2       | 0.24317084
 Budget Phone A1     | 0.24317084
 Ultrabook 14        | 0.24317084
 Database Internals  | 0.24317084
```

The product with "Running" in its **name** (weight A) ranks first. The others matched "runs", "running" or "run" in their description (weight B). `ts_headline` can highlight the match for display: `An affordable phone with a big <b>battery</b> that runs for two days.`

> **Remember:** full-text search = normalize the text (`tsvector`), normalize the query (`tsquery`), match with `@@`, index with GIN, order by `ts_rank`.

## 9. Gotchas

- **Mismatched configurations.** A vector built with `'english'` and a query parsed with `'simple'` won't match stemmed words. Always pass the configuration explicitly; the default comes from `default_text_search_config`.
- **Expression must match the index.** If you index `to_tsvector('english', description)`, the query must use exactly that expression. The generated column avoids this problem.
- **Stemming isn't a dictionary.** Verified: `'I ran to the store'` does **not** match `'run'`. Irregular forms aren't merged by the Snowball stemmer.
- **No typo tolerance.** Verified: searching `baterry` finds 0 rows. The `pg_trgm` extension (trigram similarity) can add fuzzy matching.
- **Stop-word-only queries** become empty: `plainto_tsquery('english', 'the and of')` matches nothing and raises a notice.
- **Ranking is computed per matching row** and can't use the index. For very broad queries with millions of matches, sorting by rank gets slow.
- **JSONB `->>` with a GIN index** (section 4) and **`jsonb_set` on missing paths** (section 5).

## 10. When to reach for Elasticsearch or OpenSearch

PostgreSQL full-text search is excellent for **"search our catalogue"** on up to millions of rows, with transactional consistency and no extra system to run. Move to a dedicated search engine when you need:

| Need | PostgreSQL FTS | Elasticsearch / OpenSearch |
|---|---|---|
| Typo tolerance, fuzzy matching | Limited (`pg_trgm`) | ✅ Built in |
| Relevance tuning (BM25, boosting, synonyms at scale) | Basic (`ts_rank`, weights) | ✅ Rich |
| Facets / aggregations on huge result sets | Slow-ish | ✅ Designed for it |
| Autocomplete, "did you mean" | DIY | ✅ |
| Multi-language analyzers | One config per expression | ✅ Per-field analyzers |
| Always consistent with your data | ✅ Same transaction | ❌ Async sync pipeline |
| Operational cost | ✅ Nothing extra | Another cluster to run and keep in sync |

## 11. Trade-offs

- **JSONB flexibility costs safety**: no foreign keys inside it, weaker type checks, repeated keys in every row, and the planner knows little about its contents.
- **GIN indexes are slower to update** than B-trees (they're updated via a pending list by default) and bigger. Index only what you query.
- **Big JSONB documents** are stored compressed out of line (TOAST); reading one field still means fetching and decompressing the whole value.
- **Full-text search in PostgreSQL** keeps your stack simple and consistent. Pay for a search engine only when users need typo-tolerant, faceted, finely tuned search.
