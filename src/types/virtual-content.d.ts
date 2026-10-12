// Generated at dev/build time from /content by vite/content-plugin.ts.
declare module 'virtual:dblab-content' {
  import {
    type Lesson,
    type LessonContent,
    type LessonTranslation,
    type Question,
    type QuestionTranslation,
  } from '@/types/content';

  type LessonLoader = () => Promise<{ default: LessonContent }>;

  export const lessons: Lesson[];
  export const questions: Question[];
  /** One lazy chunk per English lesson body, keyed by slug. */
  export const lessonContent: Record<string, LessonLoader>;
  /** Hindi title/summary for translated lessons, keyed by slug. */
  export const lessonsHi: Record<string, LessonTranslation>;
  /** One lazy chunk per translated Hindi lesson body, keyed by slug. */
  export const lessonContentHi: Record<string, LessonLoader>;
  /** All Hindi question texts in one lazy chunk, keyed by question slug. */
  export const loadQuestionsHi: () => Promise<{ default: Record<string, QuestionTranslation> }>;
}
