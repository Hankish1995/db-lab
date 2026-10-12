# Hindi translation guide (हिंदी अनुवाद गाइड)

Hindi versions of lessons and questions live in `content/hi/`, mirroring the English files exactly:

```text
content/lessons/mongodb/05-indexes.md            → content/hi/lessons/mongodb/05-indexes.md
content/questions/mongodb/mongodb-indexes.json   → content/hi/questions/mongodb/mongodb-indexes.json
```

The English file is the source of truth. If a Hindi file is missing, the app shows the English one.

## Style: Devanagari Hindi + English technical terms

Write the way Indian developers actually talk: Hindi sentences in **Devanagari**, technical terms in **English**
(Latin script). The reader is preparing for interviews that use the English terms, so they must see them.

✅ `Sharding में data को कई machines पर बाँटा जाता है, ताकि कोई एक server पूरा load न उठाए।`
❌ `खंडन में आँकड़ों को कई यंत्रों पर बाँटा जाता है।` (pure Hindi: never translate technical terms)
❌ `Sharding mein data ko kai machines par baanta jaata hai.` (Roman Hindi: not this style)

Keep in English: database/DB words (index, query, transaction, replica set, shard key, primary, secondary,
oplog, schema, collection, document, table, row, column, join, lock, deadlock, snapshot, isolation level,
cache, latency, throughput, write concern, read concern, B-tree, WAL, MVCC, VACUUM, …), product names,
API/function/command names, error messages, and well-known phrases interviewers use ("scatter-gather query",
"hot shard", "lost update", "write skew", "N+1 problem"). Everyday words become Hindi
(problem → समस्या, example → उदाहरण, fast → तेज़, slow → धीमा, important → ज़रूरी, rule → नियम).

Tone: friendly, clear, like a senior explaining to a colleague. Use "आप". Short sentences. Natural Hindi word
order, not a word-by-word translation.

## What must NOT change

- **Code blocks** (```js, ```sql, ```ts, ```json, ```bash): copy exactly, character for character. You may
  translate only `//` or `--` comments inside them, and only if it reads naturally; otherwise leave them.
- **```text diagrams**: copy exactly. Do not translate labels inside diagrams (alignment would break).
- **Inline code** in backticks: unchanged.
- **Links**: keep the URL exactly, e.g. `[Sharding](/lessons/sharding)`; translate only the link text if natural.
- **Markdown structure**: same `##` sections in the same order, same lists, same tables (same number of rows
  and columns), same bold terms (bold the same concepts).
- **Numbers, units, versions, measurements, EXPLAIN output**: unchanged.
- Emojis ✅ ❌ ⚠️: keep.

## Lesson file (`content/hi/lessons/<track>/<same-file-name>.md`)

Front matter has ONLY these fields:

```yaml
---
slug: acid                      # EXACTLY the English slug
title: 'ACID: एक transaction के चार वादे'
module: Transactions             # module name: keep English (it groups lessons; keep identical to English)
summary: 'एक वाक्य: इस lesson के बाद आप क्या समझेंगे।'
recap: >-
  10-second recap in Hindi, plain text (no Markdown).
---
```

- Always quote `title` and `summary` with single quotes; escape an apostrophe inside as `''`.
- `recap` uses `>-` and plain text.
- Do NOT add order, level, tags (they come from the English file).

Body: translate everything outside code/diagrams. Translate the section headings too
(`## 1. The story` → `## 1. कहानी`). Callouts: `> **Remember:** …` → `> **याद रखें:** …`.

## Questions file (`content/hi/questions/<track>/<same-file-name>.json`)

A JSON array with one entry per English question, **same slugs, same order**, only these fields:

```json
[
  {
    "slug": "acid-what-is-atomicity",
    "topic": "ACID",
    "question": "Database transaction में atomicity का क्या मतलब है?",
    "answer": "Interview में बोलने लायक 20–40 सेकंड का जवाब …",
    "explanation": "(only if the English question has one)",
    "followUps": ["…", "…"]
  }
]
```

- `topic`: keep it as in English (it's usually a technical term).
- Same Markdown rules as lessons inside `answer` / `explanation` (code unchanged, terms in English).
- Valid JSON: escape `"` inside strings as `\"`, no trailing commas, line breaks as `\n`.
- Validate: `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log('ok')" "<file>"`
