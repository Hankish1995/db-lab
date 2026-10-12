/**
 * Turns /content into data the app can import:
 *
 *   import { lessons, questions, lessonContent, … } from 'virtual:dblab-content';
 *
 *   content/lessons/<track>/<NN-name>.md          → lessons (metadata) + one lazy chunk per lesson body
 *   content/questions/<track>/<lesson>.json       → questions (array)
 *   content/hi/lessons/<track>/<NN-name>.md       → Hindi title/summary + one lazy chunk per Hindi body
 *   content/hi/questions/<track>/<lesson>.json    → Hindi question text (one lazy chunk for all)
 *
 * Lesson bodies are split out (`lessonContent[slug]()` → `virtual:dblab-lesson/<locale>/<slug>`) so the
 * main bundle stays small and each lesson's text is downloaded only when it is opened, in the language
 * being read. Hindi files are optional: anything without a translation falls back to English.
 *
 * Runs in Node at dev/build time: files are parsed and validated here, so a broken lesson or
 * translation fails loudly with the file name instead of breaking the page. There is no backend
 * and no database: everything ends up in the JavaScript bundle.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { type Plugin } from 'vite';
import { z } from 'zod';
import {
  TRACK_IDS,
  type Lesson,
  type LessonContent,
  type LessonTranslation,
  type Question,
  type QuestionTranslation,
} from '../src/types/content';

const VIRTUAL_ID = 'virtual:dblab-content';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const LESSON_PREFIX = 'virtual:dblab-lesson/';
const RESOLVED_LESSON_PREFIX = `\0${LESSON_PREFIX}`;
const HI_QUESTIONS_ID = 'virtual:dblab-questions/hi';
const RESOLVED_HI_QUESTIONS_ID = `\0${HI_QUESTIONS_ID}`;
const WORDS_PER_MINUTE = 200;

type FullLesson = Lesson & LessonContent;
type HindiLesson = LessonTranslation & LessonContent & { slug: string };

interface ContentState {
  lessons: Map<string, FullLesson>;
  questions: Question[];
  hiLessons: Map<string, HindiLesson>;
  hiQuestions: Record<string, QuestionTranslation>;
}

const LessonFrontMatter = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  module: z.string().min(1),
  order: z.number().int(),
  summary: z.string().min(1),
  level: z.enum(['beginner', 'intermediate', 'advanced']),
  tags: z.array(z.string()).default([]),
  recap: z.string().default(''),
});

const QuestionFile = z.array(
  z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    lessonSlug: z.string().optional(),
    topic: z.string().min(1),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    question: z.string().min(1),
    answer: z.string().min(1),
    explanation: z.string().optional(),
    followUps: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
  }),
);

const HindiLessonFrontMatter = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  module: z.string().min(1),
  summary: z.string().min(1),
  recap: z.string().default(''),
});

const HindiQuestionFile = z.array(
  z.object({
    slug: z.string().min(1),
    topic: z.string().min(1),
    question: z.string().min(1),
    answer: z.string().min(1),
    explanation: z.string().optional(),
    followUps: z.array(z.string()).default([]),
  }),
);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function listFiles(dir: string, extension: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(extension)).sort();
  } catch {
    return [];
  }
}

async function readMarkdown(file: string, where: string): Promise<matter.GrayMatterFile<string>> {
  try {
    return matter(await readFile(file, 'utf8'));
  } catch (error) {
    // Common cause: an unquoted ": " inside a front-matter value.
    throw new Error(`Invalid YAML front matter in ${where}: ${message(error)}`);
  }
}

async function readJson(file: string, where: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${where}: ${message(error)}`);
  }
}

/** English lessons, keyed by "<track>/<file>" (so Hindi files can be matched by path) and sorted. */
async function loadLessons(contentDir: string): Promise<Map<string, FullLesson>> {
  const byPath = new Map<string, FullLesson>();
  for (const track of TRACK_IDS) {
    const dir = path.join(contentDir, 'lessons', track);
    for (const file of await listFiles(dir, '.md')) {
      const where = `content/lessons/${track}/${file}`;
      const parsed = await readMarkdown(path.join(dir, file), where);
      const front = LessonFrontMatter.safeParse(parsed.data);
      if (!front.success) throw new Error(`Invalid front matter in ${where}: ${front.error.message}`);

      const words = parsed.content.split(/\s+/).filter(Boolean).length;
      byPath.set(`${track}/${file}`, {
        ...front.data,
        track,
        body: parsed.content.trim(),
        readingMinutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
      });
    }
  }
  return byPath;
}

async function loadQuestions(contentDir: string): Promise<Question[]> {
  const questions: Question[] = [];
  for (const track of TRACK_IDS) {
    const dir = path.join(contentDir, 'questions', track);
    for (const file of await listFiles(dir, '.json')) {
      const where = `content/questions/${track}/${file}`;
      const parsed = QuestionFile.safeParse(await readJson(path.join(dir, file), where));
      if (!parsed.success) throw new Error(`Invalid ${where}: ${parsed.error.message}`);
      questions.push(...parsed.data.map((q) => ({ ...q, track })));
    }
  }
  return questions;
}

/** Hindi lessons must mirror an English file (same track + file name) and keep its slug and module. */
async function loadHindiLessons(contentDir: string, english: Map<string, FullLesson>) {
  const hi = new Map<string, HindiLesson>();
  for (const track of TRACK_IDS) {
    const dir = path.join(contentDir, 'hi', 'lessons', track);
    for (const file of await listFiles(dir, '.md')) {
      const where = `content/hi/lessons/${track}/${file}`;
      const source = english.get(`${track}/${file}`);
      if (!source) throw new Error(`${where} has no English lesson at content/lessons/${track}/${file}`);
      const parsed = await readMarkdown(path.join(dir, file), where);
      const front = HindiLessonFrontMatter.safeParse(parsed.data);
      if (!front.success) throw new Error(`Invalid front matter in ${where}: ${front.error.message}`);
      if (front.data.slug !== source.slug) {
        throw new Error(`${where}: slug "${front.data.slug}" must match the English slug "${source.slug}"`);
      }
      hi.set(source.slug, {
        slug: source.slug,
        title: front.data.title,
        summary: front.data.summary,
        body: parsed.content.trim(),
        recap: front.data.recap,
      });
    }
  }
  return hi;
}

async function loadHindiQuestions(contentDir: string, english: Question[]) {
  const englishSlugs = new Set(english.map((q) => q.slug));
  const hi: Record<string, QuestionTranslation> = {};
  for (const track of TRACK_IDS) {
    const dir = path.join(contentDir, 'hi', 'questions', track);
    for (const file of await listFiles(dir, '.json')) {
      const where = `content/hi/questions/${track}/${file}`;
      const parsed = HindiQuestionFile.safeParse(await readJson(path.join(dir, file), where));
      if (!parsed.success) throw new Error(`Invalid ${where}: ${parsed.error.message}`);
      for (const { slug, ...text } of parsed.data) {
        if (!englishSlugs.has(slug)) throw new Error(`${where}: question "${slug}" doesn't exist in English`);
        hi[slug] = text;
      }
    }
  }
  return hi;
}

function assertConsistent(lessons: FullLesson[], questions: Question[]) {
  const unique = (kind: string, slugs: string[]) => {
    const seen = new Set<string>();
    for (const slug of slugs) {
      if (seen.has(slug)) throw new Error(`Duplicate ${kind} slug "${slug}"`);
      seen.add(slug);
    }
    return seen;
  };
  const lessonSlugs = unique('lesson', lessons.map((l) => l.slug));
  unique('question', questions.map((q) => q.slug));
  for (const q of questions) {
    if (q.lessonSlug && !lessonSlugs.has(q.lessonSlug)) {
      throw new Error(`Question "${q.slug}" points to unknown lesson "${q.lessonSlug}"`);
    }
  }
}

async function loadAll(contentDir: string): Promise<ContentState> {
  const [byPath, questions] = await Promise.all([loadLessons(contentDir), loadQuestions(contentDir)]);
  const sorted = [...byPath.values()].sort(
    (a, b) => TRACK_IDS.indexOf(a.track) - TRACK_IDS.indexOf(b.track) || a.order - b.order,
  );
  assertConsistent(sorted, questions);
  const [hiLessons, hiQuestions] = await Promise.all([
    loadHindiLessons(contentDir, byPath),
    loadHindiQuestions(contentDir, questions),
  ]);
  return { lessons: new Map(sorted.map((l) => [l.slug, l])), questions, hiLessons, hiQuestions };
}

/** `{ "slug": () => import("virtual:dblab-lesson/<locale>/slug"), … }` — literal imports, one chunk each. */
const loaderMap = (locale: string, slugs: string[]) =>
  `{\n${slugs
    .map((slug) => `  ${JSON.stringify(slug)}: () => import(${JSON.stringify(`${LESSON_PREFIX}${locale}/${slug}`)}),`)
    .join('\n')}\n}`;

export function contentPlugin({ contentDir }: { contentDir: string }): Plugin {
  // Parsed content from the latest load of the main module, reused by the lazy modules.
  let cache: Promise<ContentState> | undefined;
  const getContent = () => (cache ??= loadAll(contentDir).catch((error) => {
    cache = undefined;
    throw error;
  }));

  return {
    name: 'dblab-content',

    resolveId(id) {
      if (id === VIRTUAL_ID || id === HI_QUESTIONS_ID || id.startsWith(LESSON_PREFIX)) return `\0${id}`;
      return undefined;
    },

    async load(id) {
      if (id === RESOLVED_ID) {
        cache = undefined; // always re-read files when the main module (re)loads
        const { lessons, questions, hiLessons } = await getContent();
        const all = [...lessons.values()];
        const metadata: Lesson[] = all.map(({ body: _body, recap: _recap, ...meta }) => meta);
        const hiMeta: Record<string, LessonTranslation> = Object.fromEntries(
          [...hiLessons.values()].map((l) => [l.slug, { title: l.title, summary: l.summary }]),
        );
        return [
          `export const lessons = ${JSON.stringify(metadata)};`,
          `export const questions = ${JSON.stringify(questions)};`,
          `export const lessonContent = ${loaderMap('en', all.map((l) => l.slug))};`,
          `export const lessonsHi = ${JSON.stringify(hiMeta)};`,
          `export const lessonContentHi = ${loaderMap('hi', [...hiLessons.keys()])};`,
          `export const loadQuestionsHi = () => import(${JSON.stringify(HI_QUESTIONS_ID)});`,
        ].join('\n');
      }

      if (id === RESOLVED_HI_QUESTIONS_ID) {
        return `export default ${JSON.stringify((await getContent()).hiQuestions)};`;
      }

      if (id.startsWith(RESOLVED_LESSON_PREFIX)) {
        const [locale, slug = ''] = id.slice(RESOLVED_LESSON_PREFIX.length).split('/');
        const { lessons, hiLessons } = await getContent();
        const lesson = locale === 'hi' ? hiLessons.get(slug) : lessons.get(slug);
        if (!lesson) throw new Error(`Unknown ${locale} lesson "${slug}"`);
        const content: LessonContent = { body: lesson.body, recap: lesson.recap };
        return `export default ${JSON.stringify(content)};`;
      }

      return undefined;
    },

    // Editing a lesson, question or translation file reloads the page with the new content.
    configureServer(server) {
      server.watcher.add(contentDir);
      const onChange = (file: string) => {
        if (!path.resolve(file).startsWith(path.resolve(contentDir))) return;
        cache = undefined;
        for (const mod of server.moduleGraph.idToModuleMap.values()) {
          if (
            mod.id === RESOLVED_ID ||
            mod.id === RESOLVED_HI_QUESTIONS_ID ||
            mod.id?.startsWith(RESOLVED_LESSON_PREFIX)
          ) {
            server.moduleGraph.invalidateModule(mod);
          }
        }
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
}
