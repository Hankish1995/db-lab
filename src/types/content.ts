/** The learning tracks. Every lesson and question belongs to exactly one. */
export const TRACKS = [
  {
    id: 'fundamentals',
    title: 'Fundamentals',
    description: 'How databases think: ACID, CAP, data modeling, SQL vs NoSQL.',
  },
  {
    id: 'mongodb',
    title: 'MongoDB',
    description: 'Documents, schema patterns, aggregation, indexes, transactions, replication, sharding.',
  },
  {
    id: 'postgresql',
    title: 'PostgreSQL',
    description: 'SQL in depth, query plans, indexes, isolation levels, MVCC, locking, partitioning.',
  },
  {
    id: 'system-design',
    title: 'System Design',
    description: 'Scaling, caching, consistency and real-world database design case studies.',
  },
] as const;

export type TrackId = (typeof TRACKS)[number]['id'];

export const TRACK_IDS = TRACKS.map((t) => t.id) as [TrackId, ...TrackId[]];

export type Level = 'beginner' | 'intermediate' | 'advanced';

/** Lesson metadata: always in the main bundle (sidebar, track pages, dashboard). */
export interface Lesson {
  slug: string;
  track: TrackId;
  /** Group inside a track, e.g. "Indexes" or "Scaling". */
  module: string;
  order: number;
  title: string;
  summary: string;
  level: Level;
  tags: string[];
  readingMinutes: number;
}

/** A lesson's text: one small chunk per lesson, loaded when the lesson is opened. */
export interface LessonContent {
  /** Markdown. */
  body: string;
  /** The "10-second recap" shown at the end of the lesson. */
  recap: string;
}

export type Difficulty = 'easy' | 'medium' | 'hard';

/** An interview question with a short answer you can say out loud and a deeper explanation. */
export interface Question {
  slug: string;
  track: TrackId;
  /** Lesson this question belongs to, if any. */
  lessonSlug?: string;
  topic: string;
  difficulty: Difficulty;
  question: string;
  /** The 20–40 second answer to give in an interview (Markdown). */
  answer: string;
  /** Optional deeper explanation, examples, diagrams (Markdown). */
  explanation?: string;
  /** Questions an interviewer typically asks next. */
  followUps: string[];
  tags: string[];
}

/** UI and content languages. English is the source; Hindi falls back to English when untranslated. */
export const LOCALES = ['en', 'hi'] as const;
export type Locale = (typeof LOCALES)[number];

/** Hindi lesson metadata (module stays English: it groups lessons). */
export interface LessonTranslation {
  title: string;
  summary: string;
}

/** Hindi text of a question; everything else (difficulty, track, tags…) comes from English. */
export interface QuestionTranslation {
  topic: string;
  question: string;
  answer: string;
  explanation?: string;
  followUps: string[];
}

export const PROGRESS_STATUSES = ['new', 'revise', 'known'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

export type ProgressKind = 'lesson' | 'question';
