# DB Lab content style guide

Read this before writing or editing any lesson or question. The reference lesson is
`lessons/system-design/05-sharding.md` with its questions in `questions/system-design/sharding.json`.
Match its tone, structure and depth.

## Who the reader is

A developer with ~4 years of MERN experience preparing for interviews. Smart and practical, but
some concepts may be completely new to them. Write so that **a beginner understands it** and **an
interviewer is impressed by it**. The goal: they read it once and never forget it.

## Lesson file

Path: `lessons/<track>/<NN>-<slug>.md` (NN = two-digit position, e.g. `03-acid.md`).
Tracks: `fundamentals`, `mongodb`, `postgresql`, `system-design`.

Front matter (all fields required):

```yaml
---
slug: acid                       # lowercase-kebab, unique across ALL lessons
title: 'ACID: the four promises of a transaction'   # "Concept: plain-English hook"
module: Transactions             # group inside the track (shown as a heading)
order: 30                        # reading order inside the track: 10, 20, 30…
summary: One sentence saying what the reader will understand after this lesson.
level: beginner                  # beginner | intermediate | advanced
tags: [acid, transactions, atomicity]
recap: >-
  3–4 sentences. The "10-second recap": the whole lesson compressed. Plain text, no Markdown.
---
```

Quote the title if it contains a colon. `recap` is plain text (no `**`, no backticks).

## Lesson body structure

Use `##` numbered sections. Adapt the headings to the topic, but cover this arc, in this order:

1. **The story.** A real-life analogy that makes the concept obvious (library, bank, restaurant,
   post office…). Then map every part of the analogy to the technical term.
2. **The main goal / why it exists.** What problem does this solve? What breaks without it?
3. **How it works.** The mechanism, step by step. Use a diagram when it helps (see below).
4. **A real example.** Always the same running domain: an **e-commerce store** (users, products,
   orders, payments, reviews, inventory). Show real MongoDB shell / SQL / Mongoose code.
5. **Common mistakes / gotchas.** What people get wrong in production and in interviews.
6. **Comparison table.** "Don't confuse X with Y" or "Option A vs option B".
7. **When NOT to use it / trade-offs.**

End the body with the last section. Do **not** add the recap or interview questions to the body;
they come from `recap` and the questions file.

## Formatting rules

- Bold the key terms the first time they appear: **shard key**.
- After each big idea, add a one-line callout: `> **Remember:** …`. Aim for 3–6 per lesson.
- Code blocks always have a language: ```js, ```sql, ```ts, ```text (for diagrams).
- Diagrams are ASCII inside ```text blocks, using box-drawing characters (┌ ─ ┐ │ └ ┘ ├ ┤ ▼ ►).
  Keep them under ~70 characters wide. Every line of a box must line up.
- Tables: GitHub Markdown tables, short cells.
- Short paragraphs (1–3 sentences). Bullets for lists. No walls of text.
- Use ✅ / ❌ / ⚠️ sparingly for good/bad/careful.
- Length: roughly 1,200–2,500 words of body. Depth over padding.

## Accuracy rules (very important)

- Only state facts you are confident are correct for current MongoDB (7.x/8.x+) and PostgreSQL (15+).
- Prefer stable, long-standing behaviour. Avoid exact version numbers unless certain.
- Code must be valid and runnable (mongosh syntax for MongoDB, PostgreSQL SQL dialect).
- If something "depends", say what it depends on instead of over-simplifying into something false.

## Questions file

Path: `questions/<track>/<lesson-slug>.json`. A JSON array of 6–10 questions per lesson, covering
easy → hard. Fields:

```json
{
  "slug": "acid-what-is-atomicity",
  "lessonSlug": "acid",
  "topic": "ACID",
  "difficulty": "easy",
  "question": "What does atomicity mean in a database transaction?",
  "answer": "The 20–40 second answer to say out loud in an interview. Markdown allowed (**bold**, `code`).",
  "explanation": "Optional: deeper explanation, an example or a code snippet (Markdown).",
  "followUps": ["Question an interviewer typically asks next", "…"],
  "tags": ["acid", "transactions"]
}
```

- `slug`: lowercase-kebab, unique across ALL questions. Prefix it with the lesson slug.
- `difficulty`: `easy` | `medium` | `hard`. Include at least one `hard` (scenario/design) question.
- `answer`: structured and confident: definition → why → example in one line. 2–5 sentences.
- Include the questions actually asked in interviews for 3–4 years of experience, plus at least one
  **scenario** question ("Your query is slow, what do you check?", "How would you model X?").
- Valid JSON: escape double quotes inside strings, no trailing commas, use `\n` for line breaks.
