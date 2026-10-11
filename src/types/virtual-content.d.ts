// Generated at dev/build time from /content by vite/content-plugin.ts.
declare module 'virtual:dblab-content' {
  import { type Lesson, type LessonContent, type Question } from '@/types/content';

  export const lessons: Lesson[];
  export const questions: Question[];
  /** One lazy chunk per lesson body, keyed by slug. */
  export const lessonContent: Record<string, () => Promise<{ default: LessonContent }>>;
}
