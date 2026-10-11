/**
 * Turns /content into data the app can import:
 *
 *   import { lessons, questions, lessonContent } from 'virtual:dblab-content';
 *
 *   content/lessons/<track>/<NN-name>.md      → lessons (metadata) + one lazy chunk per lesson body
 *   content/questions/<track>/<lesson>.json   → questions (array)
 *
 * Lesson bodies are split out (`lessonContent[slug]()` → `virtual:dblab-lesson/<slug>`) so the
 * main bundle stays small and each lesson's text is downloaded only when it is opened.
 *
 * Runs in Node at dev/build time: files are parsed and validated here, so a broken lesson
 * fails loudly with the file name instead of breaking the page. There is no backend and no
 * database: everything ends up in the JavaScript bundle.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { type Plugin } from 'vite';
import { z } from 'zod';
import { TRACK_IDS, type Lesson, type LessonContent, type Question } from '../src/types/content';

const VIRTUAL_ID = 'virtual:dblab-content';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const LESSON_PREFIX = 'virtual:dblab-lesson/';
const RESOLVED_LESSON_PREFIX = `\0${LESSON_PREFIX}`;
const WORDS_PER_MINUTE = 200;

type FullLesson = Lesson & LessonContent;

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

async function listFiles(dir: string, extension: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(extension)).sort();
  } catch {
    return [];
  }
}

async function loadLessons(contentDir: string): Promise<FullLesson[]> {
  const lessons: FullLesson[] = [];
  for (const track of TRACK_IDS) {
    const dir = path.join(contentDir, 'lessons', track);
    for (const file of await listFiles(dir, '.md')) {
      const where = `content/lessons/${track}/${file}`;
      let parsed: matter.GrayMatterFile<string>;
      try {
        parsed = matter(await readFile(path.join(dir, file), 'utf8'));
      } catch (error) {
        // Common cause: an unquoted ": " inside a front-matter value.
        throw new Error(`Invalid YAML front matter in ${where}: ${error instanceof Error ? error.message : error}`);
      }
      const front = LessonFrontMatter.safeParse(parsed.data);
      if (!front.success) throw new Error(`Invalid front matter in ${where}: ${front.error.message}`);

      const words = parsed.content.split(/\s+/).filter(Boolean).length;
      lessons.push({
        ...front.data,
        track,
        body: parsed.content.trim(),
        readingMinutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
      });
    }
  }
  return lessons.sort((a, b) => TRACK_IDS.indexOf(a.track) - TRACK_IDS.indexOf(b.track) || a.order - b.order);
}

async function loadQuestions(contentDir: string): Promise<Question[]> {
  const questions: Question[] = [];
  for (const track of TRACK_IDS) {
    const dir = path.join(contentDir, 'questions', track);
    for (const file of await listFiles(dir, '.json')) {
      const where = `content/questions/${track}/${file}`;
      let json: unknown;
      try {
        json = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
      } catch (error) {
        throw new Error(`Invalid JSON in ${where}: ${error instanceof Error ? error.message : error}`);
      }
      const parsed = QuestionFile.safeParse(json);
      if (!parsed.success) throw new Error(`Invalid ${where}: ${parsed.error.message}`);
      questions.push(...parsed.data.map((q) => ({ ...q, track })));
    }
  }
  return questions;
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

export function contentPlugin({ contentDir }: { contentDir: string }): Plugin {
  // Parsed lessons from the latest load of the main module, reused by the per-lesson modules.
  let lessonCache: Map<string, FullLesson> | undefined;

  const getLessons = async () => {
    lessonCache ??= new Map((await loadLessons(contentDir)).map((l) => [l.slug, l]));
    return lessonCache;
  };

  return {
    name: 'dblab-content',

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      if (id.startsWith(LESSON_PREFIX)) return `\0${id}`;
      return undefined;
    },

    async load(id) {
      if (id === RESOLVED_ID) {
        lessonCache = undefined; // always re-read files when the main module (re)loads
        const [lessons, questions] = await Promise.all([getLessons(), loadQuestions(contentDir)]);
        const all = [...lessons.values()];
        assertConsistent(all, questions);

        const metadata: Lesson[] = all.map(({ body: _body, recap: _recap, ...meta }) => meta);
        // Literal import() per lesson, so the bundler emits one chunk per lesson body.
        const loaders = all
          .map((l) => `  ${JSON.stringify(l.slug)}: () => import(${JSON.stringify(LESSON_PREFIX + l.slug)}),`)
          .join('\n');
        return [
          `export const lessons = ${JSON.stringify(metadata)};`,
          `export const questions = ${JSON.stringify(questions)};`,
          `export const lessonContent = {\n${loaders}\n};`,
        ].join('\n');
      }

      if (id.startsWith(RESOLVED_LESSON_PREFIX)) {
        const slug = id.slice(RESOLVED_LESSON_PREFIX.length);
        const lesson = (await getLessons()).get(slug);
        if (!lesson) throw new Error(`Unknown lesson "${slug}"`);
        const content: LessonContent = { body: lesson.body, recap: lesson.recap };
        return `export default ${JSON.stringify(content)};`;
      }

      return undefined;
    },

    // Editing a lesson or question file reloads the page with the new content.
    configureServer(server) {
      server.watcher.add(contentDir);
      const onChange = (file: string) => {
        if (!path.resolve(file).startsWith(path.resolve(contentDir))) return;
        lessonCache = undefined;
        for (const mod of server.moduleGraph.idToModuleMap.values()) {
          if (mod.id === RESOLVED_ID || mod.id?.startsWith(RESOLVED_LESSON_PREFIX)) {
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
