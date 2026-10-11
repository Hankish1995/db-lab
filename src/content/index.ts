import { lessonContent, lessons, questions } from 'virtual:dblab-content';
import { type Lesson, type LessonContent, type Question, type TrackId } from '@/types/content';

/** All lessons (metadata only), in track order and reading order (sorted at build time). */
export const allLessons: readonly Lesson[] = lessons;

/** All interview questions. */
export const allQuestions: readonly Question[] = questions;

const lessonBySlug = new Map(lessons.map((l) => [l.slug, l]));

export function getLesson(slug: string): Lesson | undefined {
  return lessonBySlug.get(slug);
}

export function getTrackLessons(track: TrackId): Lesson[] {
  return lessons.filter((l) => l.track === track);
}

const DIFFICULTY_ORDER = { easy: 0, medium: 1, hard: 2 } as const;

/** A lesson's questions, easy → hard. */
export function getLessonQuestions(lessonSlug: string): Question[] {
  return questions
    .filter((q) => q.lessonSlug === lessonSlug)
    .sort((a, b) => DIFFICULTY_ORDER[a.difficulty] - DIFFICULTY_ORDER[b.difficulty]);
}

// One promise per lesson, reused across renders: React's use() needs a stable promise.
const contentPromises = new Map<string, Promise<LessonContent>>();

/** Loads a lesson's text (its own small chunk). Only call it for slugs that exist. */
export function loadLessonContent(slug: string): Promise<LessonContent> {
  let promise = contentPromises.get(slug);
  if (!promise) {
    const load = lessonContent[slug];
    if (!load) throw new Error(`Unknown lesson "${slug}"`);
    promise = load().then((module) => module.default);
    // If the chunk fails to download (e.g. offline), allow a retry on the next visit.
    promise.catch(() => contentPromises.delete(slug));
    contentPromises.set(slug, promise);
  }
  return promise;
}
