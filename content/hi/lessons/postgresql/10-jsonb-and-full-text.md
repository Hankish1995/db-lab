---
slug: postgres-jsonb-and-full-text
title: 'JSONB और full-text search: PostgreSQL के अंदर एक document store और एक search box'
module: Features
summary: 'Flexible JSONB data को store, query, index और update कैसे करें, JSONB कब असली columns से बेहतर है और कब नहीं, और tsvector, tsquery और GIN indexes से ranked product search कैसे बनाएँ।'
recap: >-
  JSONB, JSON को parsed binary रूप में store करता है, duplicate keys हटाकर और बिना key order के, इसलिए इसे query करना
  तेज़ है और ये indexable है। ->, ->>, @> और ? जैसे operators इस्तेमाल करें, containment और key-existence queries के लिए
  GIN index, या एक hot field के लिए expression index, और jsonb_set या || से update करें। बदलते रहने वाले attributes JSONB
  में रखें और जिस चीज़ पर आप अक्सर filter, join या constraint लगाते हैं वो असली columns में। Search के लिए GIN index वाला
  एक generated tsvector column रखें, उसे websearch_to_tsquery से query करें और ts_rank से rank करें; जब typo tolerance,
  बड़े पैमाने पर facets या भारी relevance tuning चाहिए, तब Elasticsearch या OpenSearch की तरफ़ जाएँ।
---

## 1. कहानी

आपका store **shoes, phones और books** बेचता है। इनमें कुछ बातें common हैं (name, price, category), पर बाकी सब अलग है:

- Shoes: size, colour, waterproof।
- Phones: RAM, storage, screen size और type।
- Books: author, pages, format।

Relational table में आपको दर्जनों ज़्यादातर खाली columns चाहिए होंगे, या हर बार merchandising team कोई नया attribute लाए तो एक नया column। MongoDB में आप बस हर product के अपने fields store कर देते।

PostgreSQL आपको हर row के अंदर एक **label वाली दराज़** देता है: एक **JSONB** column उस product के जो भी attributes हों उन्हें रखता है, और आप फिर भी उसे query और index कर सकते हैं। और shelf के बगल में एक **search desk** है: **full-text search** समझता है कि "running shoe" type करने वाले customer का मतलब "Trail Running Shoes" नाम वाला product है।

| Shop | PostgreSQL |
|---|---|
| हर box पर fixed label: name, price | सामान्य **columns** |
| Extra details की दराज़, हर product में अलग | एक **`jsonb`** column |
| Index cards जो बताते हैं किन दराज़ों में "colour: red" है | एक **GIN index** |
| Search desk जो समझता है "run" = "running" | **Full-text search** (`tsvector`, `tsquery`) |

## 2. JSON vs JSONB

PostgreSQL में दो JSON types हैं। एक ही input के लिए असली output:

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
| Storage | बिल्कुल वही input text | Parsed **binary** format |
| Duplicate keys | रखी जाती हैं | **आख़िरी वाली जीतती है** |
| Key order, whitespace | बचे रहते हैं | **नहीं बचते** |
| Insert speed | थोड़ा तेज़ (कोई parsing नहीं) | थोड़ा धीमा |
| Query speed | हर access पर दोबारा parse करता है | **तेज़** |
| Indexing (GIN), `@>`, `?` | ❌ | ✅ |

Default रूप से **`jsonb`** इस्तेमाल करें। `json` सिर्फ़ तब इस्तेमाल करें जब आपको बिल्कुल original text रखना ही हो (जैसे auditing के लिए webhook payload को हूबहू store करना)।

> **याद रखें:** JSONB = parsed, deduplicated, unordered और indexable। 99% बार आपको यही type चाहिए।

## 3. Operators

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

| Operator | मतलब | उदाहरण | Result |
|---|---|---|---|
| `->` | Field को **jsonb** के रूप में लो | `attributes -> 'brand'` | `"Pixelco"` |
| `->>` | Field को **text** के रूप में लो | `attributes ->> 'brand'` | `Pixelco` |
| `#>` | **Path** से jsonb के रूप में लो | `attributes #> '{specs,screen,inches}'` | `6.3` |
| `#>>` | Path से text के रूप में लो | `attributes #>> '{specs,screen,type}'` | `OLED` |
| `@>` | ये JSON **contain** करता है | `attributes @> '{"color":"red"}'` | true/false |
| `?` | ये **top-level key** मौजूद है | `attributes ? 'waterproof'` | true/false |
| `?\|` | इनमें से **कोई भी** key मौजूद है | `attributes ?\| array['cpu','author']` | true/false |
| `?&` | इनमें से **सारी** keys मौजूद हैं | `attributes ?& array['ram_gb','specs']` | true/false |

ये सब एक scratch catalogue पर चलाए गए थे (ये दो products, चार और हाथ से लिखे हुए जैसे "Road Runner 2" और "Budget Phone A1", plus 100,000 generated items); ऊपर के results असली हैं। कुछ चीज़ें जिनमें लोग अटकते हैं:

```sql
-- ->> returns text: cast before comparing numbers
SELECT name FROM catalog WHERE (attributes ->> 'ram_gb')::int >= 12;

-- @> works inside arrays too: shoes available in size 10
SELECT name FROM catalog WHERE attributes @> '{"size":[10]}';

-- SQL/JSON path, for more complex conditions
SELECT name FROM catalog WHERE attributes @? '$.ram_gb ? (@ >= 12)';
SELECT jsonb_path_query(attributes, '$.specs.screen.inches') FROM catalog;
```

## 4. JSONB को index करना

### पूरे column पर GIN

**GIN** (generalized inverted) index हर key और value को एक अलग entry के रूप में रखता है, जो उन rows की ओर point करती है जिनमें वो है, बिल्कुल किताब के पीछे वाले index की तरह। 100,000 products के साथ, "हरे रंग के Nova products" पहले और बाद में:

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

| Operator class | क्या support करता है | यहाँ size | कब इस्तेमाल करें |
|---|---|---|---|
| **`jsonb_ops`** (default) | `@>`, `?`, `?\|`, `?&`, `@?`, `@@` | 824 kB | जब आप key existence भी query करते हों |
| **`jsonb_path_ops`** | सिर्फ़ `@>`, `@?`, `@@` | 464 kB | जब आप सिर्फ़ containment इस्तेमाल करते हों; छोटा और आमतौर पर तेज़ |

```sql
CREATE INDEX catalog_attrs_pathops ON catalog USING gin (attributes jsonb_path_ops);
```

Verified: सिर्फ़ `jsonb_path_ops` index होने पर `attributes @> '{"color":"green"}'` ने उसे इस्तेमाल किया, पर `attributes ? 'waterproof'` वापस Seq Scan पर चला गया।

### जाल: GIN `->>` equality में मदद नहीं करता

```sql
EXPLAIN SELECT count(*) FROM catalog WHERE attributes ->> 'brand' = 'Nova';
-- Seq Scan on catalog   (even with the GIN index present)
```

GIN indexes `@>` जैसे **operators** को serve करते हैं, मनमाने expressions को नहीं। या तो इसे containment के रूप में दोबारा लिखें (`attributes @> '{"brand":"Nova"}'`) या जिस एक field पर आप सबसे ज़्यादा filter करते हैं उस पर **expression index** बनाएँ:

```sql
CREATE INDEX catalog_brand_idx ON catalog ((attributes ->> 'brand'));
ANALYZE catalog;
EXPLAIN SELECT id, name FROM catalog WHERE attributes ->> 'brand' = 'Pixelco';
-- Bitmap Index Scan on catalog_brand_idx
```

B-tree expression index GIN index से छोटा होता है, ranges और sorting support करता है, और (`ANALYZE` के बाद) planner को उस field के **असली statistics** देता है। इसके बिना planner ने `->> 'brand'` के लिए 500 matching rows का अंदाज़ा लगाया था; इसके साथ उसने 25,225 का estimate किया, जो सच के क़रीब है। देखें [PostgreSQL indexes](/lessons/postgres-indexes) और [EXPLAIN](/lessons/postgres-explain)।

> **याद रखें:** flexible `@>` और `?` queries के लिए पूरे column पर GIN; जिस एक hot field की तुलना आप `=`, `<` या `ORDER BY` से करते हैं, उसके लिए B-tree expression index।

## 5. JSONB को update करना

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

- `jsonb_set` **बीच के missing objects नहीं बनाता**: `jsonb_set('{"a":1}', '{x,y}', '2')` बिना बदले `{"a": 1}` लौटाता है।
- `||` एक **shallow** merge है: `attributes || '{"specs":{"ram":8}}'` पूरे `specs` object को बदल देता है।
- कोई भी change **पूरी JSONB value** को दोबारा लिखता है और एक नया row version बनाता है ([MVCC](/lessons/postgres-mvcc-and-vacuum))। बार-बार update होने वाले बड़े documents महँगे पड़ते हैं।

## 6. कब JSONB, और कब असली columns

ये classic **attribute problem** है (इसे EAV: entity-attribute-value भी कहते हैं)। सीमाओं के भीतर, JSONB आमतौर पर इसका सबसे अच्छा जवाब है।

| इसे **JSONB** में रखें | इसे **असली column** में रखें |
|---|---|
| Category के हिसाब से बदलने वाले attributes (screen size, shoe size) | Fields जो हर row में हैं (name, price, category) |
| कम ही filter होते हैं, ज़्यादातर दिखाए जाते हैं | अक्सर filter, sort या group होते हैं |
| Optional, sparse data | `NOT NULL`, `CHECK`, `UNIQUE` चाहिए |
| Third-party payloads जिन्हें आप जैसे आए वैसे store करते हैं | **Joins** या **foreign keys** में इस्तेमाल होते हैं |
| Schema हर हफ़्ते बदलता है | सटीक planner statistics चाहिए |

असली columns इन चीज़ों में जीतते हैं: database से enforce होने वाले types, constraints, foreign keys, कम storage (keys हर row में दोहराई नहीं जातीं), और ऐसे statistics जिन्हें planner समझता है। एक healthy design **hybrid** होता है: core columns + एक `attributes jsonb`। आप JSONB के अंदर भी नियम enforce कर सकते हैं, जैसे `CHECK (jsonb_typeof(attributes -> 'ram_gb') = 'number')`, पर ये जल्दी ही भद्दा हो जाता है। देखें [Normalization](/lessons/normalization) और [Data types और constraints](/lessons/postgres-data-types-and-constraints)।

> **याद रखें:** जो बदलता रहता है उसके लिए JSONB; जिस पर आप filter, join और constraint लगाते हैं उसके लिए columns। अगर आप हर request में किसी JSON field को query करते हैं, तो वो column बनने का हक़दार है।

## 7. Document database के रूप में PostgreSQL vs MongoDB

| | PostgreSQL + JSONB | MongoDB |
|---|---|---|
| Data model | JSONB columns वाली rows, relational के साथ मिली-जुली | हर जगह documents (BSON) |
| Joins | पूरे SQL joins | `$lookup`, बड़े scale पर इसकी सलाह नहीं दी जाती |
| Transactions | पूरा ACID, कितनी भी rows | Single-document atomic; multi-document transactions उपलब्ध हैं, ज़्यादा overhead के साथ |
| Partial updates | पूरी value दोबारा लिखता है | `$set`, `$inc`, `$push` उसी जगह update करते हैं |
| Nested fields को index करना | GIN, expression indexes | किसी भी path पर indexes, multikey arrays |
| Schema enforcement | Columns + CHECK constraints | Optional JSON Schema validation |
| Horizontal scaling | ज़्यादातर vertical, read replicas; extensions से sharding | Built-in sharding |
| किसके लिए सबसे सही | कुछ flexible data के साथ relational core | Document-shaped data, ऊँचा write scale |

MongoDB modelling के लिए देखें [MongoDB schema patterns](/lessons/mongodb-schema-patterns)।

## 8. Full-text search

`WHERE description ILIKE '%run shoe%'` "running shoes" पर fail हो जाता है, results को rank नहीं कर सकता और सामान्य B-tree index इस्तेमाल नहीं कर सकता। Full-text search तीनों को ठीक करता है।

### tsvector: normalized document

```sql
SELECT to_tsvector('english',
  'Lightweight running shoes with a grippy sole for muddy trails.');
```

```text
'grippi':6 'lightweight':1 'muddi':9 'run':2 'shoe':3
'sole':7 'trail':10
```

- **Stemming**: `running` → `run`, `shoes` → `shoe`, `trails` → `trail`। ये normalized शब्द **lexemes** कहलाते हैं (`grippi` अजीब दिखता है पर ये consistent है: query भी इसी तरह stem होती है)।
- **Stop words** हटा दिए गए: `with`, `a`, `for`।
- Numbers **positions** हैं, जो phrase search और ranking में इस्तेमाल होती हैं।

`'simple'` configuration के साथ न कुछ stem होता है, न हटता है: `'running':2 'shoes':3 'with':4 'a':5 ...`। Language configuration मायने रखती है।

### tsquery: normalized search

```text
plainto_tsquery('english', 'running shoes for the trails')
  → 'run' & 'shoe' & 'trail'
websearch_to_tsquery('english', '"running shoes" -road or trail')
  → 'run' <-> 'shoe' & !'road' | 'trail'
to_tsquery('english', 'batt:*')
  → 'batt':*        (prefix match)
```

| Function | Input style | किसके लिए |
|---|---|---|
| `to_tsquery` | Operator syntax (`&`, `\|`, `!`, `<->`, `:*`); गलत syntax पर error देता है | Code में बनाई गई queries |
| `plainto_tsquery` | सादे शब्द, सब AND से जुड़े | सरल search boxes |
| **`websearch_to_tsquery`** | Google जैसा: quotes, `or`, `-`; कभी error नहीं देता | **Users के सामने वाले search boxes** |

Match operator **`@@`** है:

```sql
SELECT to_tsvector('english', 'running shoes')
       @@ plainto_tsquery('english', 'run shoe');   -- true
```

### Searchable catalogue: generated column + GIN

```sql
ALTER TABLE catalog ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX catalog_search_idx ON catalog USING gin (search);
```

Generated column हर insert और update पर खुद को sync रखता है, किसी trigger की ज़रूरत नहीं। `setweight` name के matches को description के matches (`B`) से ज़्यादा ज़रूरी (`A`) mark करता है।

100,006 products पर "battery phone" के असली plans:

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

जिस product के **name** (weight A) में "Running" है, वो सबसे ऊपर आता है। बाकी ने अपने description (weight B) में "runs", "running" या "run" से match किया। Display के लिए `ts_headline` match को highlight कर सकता है: `An affordable phone with a big <b>battery</b> that runs for two days.`

> **याद रखें:** full-text search = text को normalize करो (`tsvector`), query को normalize करो (`tsquery`), `@@` से match करो, GIN से index करो, `ts_rank` से order करो।

## 9. Gotchas

- **Configurations का मेल न होना।** `'english'` से बना vector और `'simple'` से parse हुई query stemmed शब्दों पर match नहीं करेंगे। Configuration हमेशा explicitly pass करें; default `default_text_search_config` से आता है।
- **Expression index से match होना चाहिए।** अगर आप `to_tsvector('english', description)` को index करते हैं, तो query में बिल्कुल वही expression होना चाहिए। Generated column इस समस्या से बचा लेता है।
- **Stemming कोई dictionary नहीं है।** Verified: `'I ran to the store'` `'run'` से match **नहीं** करता। Snowball stemmer irregular forms को नहीं मिलाता।
- **कोई typo tolerance नहीं।** Verified: `baterry` search करने पर 0 rows मिलती हैं। `pg_trgm` extension (trigram similarity) fuzzy matching जोड़ सकता है।
- **सिर्फ़ stop words वाली queries** खाली हो जाती हैं: `plainto_tsquery('english', 'the and of')` कुछ match नहीं करता और एक notice देता है।
- **Ranking हर matching row के लिए compute होती है** और index इस्तेमाल नहीं कर सकती। Millions of matches वाली बहुत broad queries में rank से sort करना धीमा हो जाता है।
- **GIN index के साथ JSONB `->>`** (section 4) और **missing paths पर `jsonb_set`** (section 5)।

## 10. Elasticsearch या OpenSearch की तरफ़ कब जाएँ

PostgreSQL full-text search millions तक की rows पर **"हमारा catalogue search करो"** के लिए बेहतरीन है, transactional consistency के साथ और बिना कोई extra system चलाए। Dedicated search engine पर तब जाएँ जब आपको चाहिए:

| ज़रूरत | PostgreSQL FTS | Elasticsearch / OpenSearch |
|---|---|---|
| Typo tolerance, fuzzy matching | सीमित (`pg_trgm`) | ✅ Built in |
| Relevance tuning (BM25, boosting, बड़े पैमाने पर synonyms) | Basic (`ts_rank`, weights) | ✅ Rich |
| बहुत बड़े result sets पर facets / aggregations | थोड़ा धीमा | ✅ इसी के लिए बना है |
| Autocomplete, "did you mean" | खुद बनाओ | ✅ |
| Multi-language analyzers | हर expression के लिए एक config | ✅ Per-field analyzers |
| आपके data से हमेशा consistent | ✅ वही transaction | ❌ Async sync pipeline |
| Operational cost | ✅ कुछ extra नहीं | चलाने और sync रखने के लिए एक और cluster |

## 11. Trade-offs

- **JSONB की flexibility safety की कीमत पर आती है**: इसके अंदर कोई foreign keys नहीं, कमज़ोर type checks, हर row में दोहराई गई keys, और planner को इसके contents के बारे में बहुत कम पता होता है।
- **GIN indexes B-trees से धीमे update होते हैं** (default रूप से ये एक pending list के ज़रिए update होते हैं) और बड़े होते हैं। सिर्फ़ उसी को index करें जिसे आप query करते हैं।
- **बड़े JSONB documents** compressed होकर out of line store होते हैं (TOAST); एक field पढ़ने का मतलब भी पूरी value लाना और decompress करना है।
- **PostgreSQL में full-text search** आपके stack को सरल और consistent रखता है। Search engine पर पैसा तभी लगाएँ जब users को typo-tolerant, faceted, बारीकी से tuned search चाहिए।
