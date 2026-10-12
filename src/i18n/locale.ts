import { useSyncExternalStore } from 'react';
import { LOCALES, type Locale } from '@/types/content';
import { strings, type Strings } from './strings';

/** The chosen language, remembered in this browser. English is the default. */
const STORAGE_KEY = 'dblab-locale';

function read(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if ((LOCALES as readonly string[]).includes(stored ?? '')) return stored as Locale;
  } catch {
    // Storage blocked: default language.
  }
  return 'en';
}

let current: Locale = read();
const listeners = new Set<() => void>();

function apply(locale: Locale) {
  // Correct `lang` lets the browser pick Devanagari shaping/fonts and helps screen readers.
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}
apply(current);

function notify() {
  listeners.forEach((listener) => listener());
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    current = read();
    apply(current);
    notify();
  });
}

export function setLocale(locale: Locale) {
  if (locale === current) return;
  current = locale;
  apply(locale);
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Keep the choice for this visit only.
  }
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, () => current);
}

/** UI strings for the current language: `const t = useT(); t.dashboard.title`. */
export function useT(): Strings {
  return strings[useLocale()];
}
