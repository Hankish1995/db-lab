// Compares Hindi translations in content/hi/ with their English originals.
//   node scripts/check-hindi.mjs                → check every Hindi file
//   node scripts/check-hindi.mjs mongodb/05-indexes.md mongodb/mongodb-indexes.json
//                                               → check only these (paths relative to lessons/ or questions/)
// Exits 1 if anything is wrong. Code blocks and diagrams must be identical; comment lines
// (// … or -- …) inside non-diagram code blocks may be translated.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content');
const problems = [];
const fail = (file, message) => problems.push(`${file}: ${message}`);

/** Fenced code blocks as { lang, code }. */
function codeBlocks(markdown) {
  const blocks = [];
  const re = /^```(\w*)[^\n]*\n([\s\S]*?)^```/gm;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) blocks.push({ lang: m[1], code: m[2] });
  return blocks;
}
const withoutComments = (code) =>
  code
    .split('\n')
    .map((line) => line.replace(/\s*(\/\/|--)(?![>-]).*$/, '').trimEnd())
    .join('\n');
const outsideCode = (markdown) => markdown.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
/**
 * Typos like "Nहीं": a Latin letter glued directly to a Devanagari letter or vowel sign (outside code).
 * Danda punctuation (। ॥, U+0964/U+0965) and Devanagari digits are allowed next to English words.
 */
const DEVANAGARI_LETTER = '[\\u0900-\\u0963\\u0971-\\u097F]';
const mixedScriptTypos = (text) =>
  outsideCode(text).match(new RegExp(`[A-Za-z]${DEVANAGARI_LETTER}|${DEVANAGARI_LETTER}[A-Za-z]`, 'g')) ?? [];
const headings = (md) => outsideCode(md).match(/^#{2,3} /gm)?.length ?? 0;
const tableRows = (md) => outsideCode(md).match(/^\|.*\|\s*$/gm)?.length ?? 0;
const links = (md) => [...outsideCode(md).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).sort();

function compareMarkdown(file, en, hi) {
  const typos = mixedScriptTypos(hi);
  if (typos.length) fail(file, `Latin letter glued to Devanagari (typo?): ${[...new Set(typos)].join(', ')}`);
  const a = codeBlocks(en);
  const b = codeBlocks(hi);
  if (a.length !== b.length) {
    fail(file, `code blocks: English has ${a.length}, Hindi has ${b.length}`);
  } else {
    a.forEach((block, i) => {
      const other = b[i];
      if (block.lang !== other.lang) fail(file, `code block #${i + 1}: language "${block.lang}" became "${other.lang}"`);
      const same =
        block.lang === 'text' || block.lang === ''
          ? block.code === other.code
          : withoutComments(block.code) === withoutComments(other.code);
      if (!same) fail(file, `code block #${i + 1} (${block.lang || 'plain'}) was changed`);
    });
  }
  if (headings(en) !== headings(hi)) fail(file, `headings: English ${headings(en)}, Hindi ${headings(hi)}`);
  if (tableRows(en) !== tableRows(hi)) fail(file, `table rows: English ${tableRows(en)}, Hindi ${tableRows(hi)}`);
  if (links(en).join('|') !== links(hi).join('|')) fail(file, `link targets differ: ${links(en)} vs ${links(hi)}`);
}

function checkLesson(rel) {
  const file = `hi/lessons/${rel}`;
  const enPath = path.join(root, 'lessons', rel);
  if (!existsSync(enPath)) return fail(file, 'no English lesson with this file name');
  let hi;
  try {
    hi = matter(readFileSync(path.join(root, 'hi', 'lessons', rel), 'utf8'));
  } catch (error) {
    return fail(file, `invalid front matter YAML: ${error.message}`);
  }
  const en = matter(readFileSync(enPath, 'utf8'));
  const allowed = ['slug', 'title', 'module', 'summary', 'recap'];
  for (const key of Object.keys(hi.data)) if (!allowed.includes(key)) fail(file, `unexpected front matter field "${key}"`);
  for (const key of allowed) {
    if (typeof hi.data[key] !== 'string' || !hi.data[key].trim()) fail(file, `front matter "${key}" missing`);
  }
  if (hi.data.slug !== en.data.slug) fail(file, `slug "${hi.data.slug}" should be "${en.data.slug}"`);
  if (hi.data.module !== en.data.module) fail(file, `module "${hi.data.module}" should stay "${en.data.module}"`);
  if (!/[ऀ-ॿ]/.test(hi.content)) fail(file, 'body has no Devanagari text (not translated?)');
  compareMarkdown(file, en.content, hi.content);
}

function checkQuestions(rel) {
  const file = `hi/questions/${rel}`;
  const enPath = path.join(root, 'questions', rel);
  if (!existsSync(enPath)) return fail(file, 'no English questions file with this name');
  let hi;
  try {
    hi = JSON.parse(readFileSync(path.join(root, 'hi', 'questions', rel), 'utf8'));
  } catch (error) {
    return fail(file, `invalid JSON: ${error.message}`);
  }
  const en = JSON.parse(readFileSync(enPath, 'utf8'));
  if (!Array.isArray(hi)) return fail(file, 'must be a JSON array');
  if (hi.length !== en.length) fail(file, `English has ${en.length} questions, Hindi has ${hi.length}`);
  en.forEach((q, i) => {
    const h = hi[i];
    if (!h) return;
    const at = `${file} [${q.slug}]`;
    if (h.slug !== q.slug) return problems.push(`${at}: slug/order mismatch (found "${h.slug}")`);
    const allowed = ['slug', 'topic', 'question', 'answer', 'explanation', 'followUps'];
    for (const key of Object.keys(h)) if (!allowed.includes(key)) problems.push(`${at}: unexpected field "${key}"`);
    for (const key of ['topic', 'question', 'answer']) {
      if (typeof h[key] !== 'string' || !h[key].trim()) problems.push(`${at}: "${key}" missing`);
    }
    if (Boolean(q.explanation) !== Boolean(h.explanation)) problems.push(`${at}: explanation present in one language only`);
    if (!Array.isArray(h.followUps) || h.followUps.length !== q.followUps.length) {
      problems.push(`${at}: followUps count should be ${q.followUps.length}`);
    }
    if (!/[ऀ-ॿ]/.test(`${h.question} ${h.answer}`)) problems.push(`${at}: not translated (no Devanagari)`);
    compareMarkdown(at + ' answer', q.answer, h.answer ?? '');
    if (q.explanation && h.explanation) compareMarkdown(at + ' explanation', q.explanation, h.explanation);
  });
}

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(path.join(dir, d.name)).map((f) => `${d.name}/${f}`) : [d.name],
      )
    : [];

const only = process.argv.slice(2).map((p) => p.replaceAll('\\', '/'));
const lessons = walk(path.join(root, 'hi', 'lessons')).filter((f) => f.endsWith('.md'));
const questions = walk(path.join(root, 'hi', 'questions')).filter((f) => f.endsWith('.json'));
const pick = (list) => (only.length ? list.filter((f) => only.includes(f)) : list);

pick(lessons).forEach(checkLesson);
pick(questions).forEach(checkQuestions);

const checked = pick(lessons).length + pick(questions).length;
if (problems.length) {
  console.log(problems.map((p) => `✗ ${p}`).join('\n'));
  console.log(`\n${problems.length} problem(s) in ${checked} file(s).`);
  process.exit(1);
}
console.log(`✓ ${checked} Hindi file(s) match their English originals.`);
