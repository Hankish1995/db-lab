import { useSyncExternalStore } from 'react';
import {
  lessonContent,
  lessonContentHi,
  lessons,
  lessonsHi,
  loadQuestionsHi,
  questions,
} from 'virtual:dblab-content';
import {
  type Lesson,
  type LessonContent,
  type Locale,
  type Question,
  type QuestionTranslation,
  type TrackId,
} from '@/types/content';

/** All lessons (English metadata), in track order and reading order (sorted at build time). */
export const allLessons: readonly Lesson[] = lessons;

/** All interview questions (English). Use `useLocalizedQuestion` to display one in the current language. */
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

/** Lesson title and summary in `locale` (falls back to English when not translated). */
export function lessonText(lesson: Lesson, locale: Locale): { title: string; summary: string } {
  const hi = locale === 'hi' ? lessonsHi[lesson.slug] : undefined;
  return hi ?? { title: lesson.title, summary: lesson.summary };
}

export function hasHindiLesson(slug: string): boolean {
  return slug in lessonContentHi;
}

export interface LoadedLessonContent extends LessonContent {
  /** The language actually loaded: 'en' when Hindi was asked for but isn't translated yet. */
  locale: Locale;
}

// One promise per lesson+language, reused across renders: React's use() needs a stable promise.
const contentPromises = new Map<string, Promise<LoadedLessonContent>>();

/** Loads a lesson's text (its own small chunk) in `locale`, falling back to English. */
export function loadLessonContent(slug: string, locale: Locale): Promise<LoadedLessonContent> {
  const actual: Locale = locale === 'hi' && hasHindiLesson(slug) ? 'hi' : 'en';
  const key = `${actual}:${slug}`;
  let promise = contentPromises.get(key);
  if (!promise) {
    const load = (actual === 'hi' ? lessonContentHi : lessonContent)[slug];
    if (!load) throw new Error(`Unknown lesson "${slug}"`);
    promise = load().then((module) => ({ ...module.default, locale: actual }));
    // If the chunk fails to download (e.g. offline), allow a retry on the next visit.
    promise.catch(() => contentPromises.delete(key));
    contentPromises.set(key, promise);
  }
  return promise;
}

// Hindi question texts: one chunk, fetched the first time Hindi is shown. Until it arrives,
// questions render in English (a fraction of a second), so nothing suspends or flickers to empty.
let hindiQuestions: Record<string, QuestionTranslation> | null = null;
let hindiRequested = false;
const hindiListeners = new Set<() => void>();

function requestHindiQuestions() {
  if (hindiRequested) return;
  hindiRequested = true;
  loadQuestionsHi()
    .then((module) => {
      hindiQuestions = module.default;
      hindiListeners.forEach((listener) => listener());
    })
    .catch(() => {
      hindiRequested = false; // retry next time
    });
}

const subscribeHindi = (listener: () => void) => {
  hindiListeners.add(listener);
  return () => hindiListeners.delete(listener);
};

/** Hindi question texts when `locale` is Hindi and they've loaded; otherwise null. */
export function useHindiQuestions(locale: Locale): Record<string, QuestionTranslation> | null {
  if (locale === 'hi') requestHindiQuestions();
  const map = useSyncExternalStore(subscribeHindi, () => hindiQuestions);
  return locale === 'hi' ? map : null;
}

/** The question's text in `locale`, or English when not translated / not loaded yet. */
export function questionText(
  question: Question,
  hindi: Record<string, QuestionTranslation> | null,
): QuestionTranslation {
  return (
    hindi?.[question.slug] ?? {
      topic: question.topic,
      question: question.question,
      answer: question.answer,
      explanation: question.explanation,
      followUps: question.followUps,
    }
  );
}
