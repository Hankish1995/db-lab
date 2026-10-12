import { type Difficulty, type Level, type Locale, type TrackId } from '@/types/content';

/**
 * Every UI text, in English and Hindi. Hindi follows the content style: Devanagari sentences,
 * with app/technical terms (lesson, track, interview, backup…) kept in English.
 * `hi` is typed as `Strings`, so a missing Hindi key is a compile error.
 */
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const en = {
  app: {
    subtitle: 'MongoDB · PostgreSQL',
    tagline: 'Learn it once. Remember it forever.',
  },
  nav: {
    dashboard: 'Dashboard',
    questions: 'Interview questions',
    tracks: 'Tracks',
  },
  tracks: {
    fundamentals: {
      title: 'Fundamentals',
      description: 'How databases think: ACID, CAP, data modeling, SQL vs NoSQL.',
    },
    mongodb: {
      title: 'MongoDB',
      description: 'Documents, schema patterns, aggregation, indexes, transactions, replication, sharding.',
    },
    postgresql: {
      title: 'PostgreSQL',
      description: 'SQL in depth, query plans, indexes, isolation levels, MVCC, locking, partitioning.',
    },
    'system-design': {
      title: 'System Design',
      description: 'Scaling, caching, consistency and real-world database design case studies.',
    },
  } satisfies Record<TrackId, { title: string; description: string }>,
  level: { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' } satisfies Record<Level, string>,
  difficulty: { easy: 'Easy', medium: 'Medium', hard: 'Hard' } satisfies Record<Difficulty, string>,
  status: {
    known: 'Known',
    revise: 'Revise',
    iKnowThis: 'I know this',
    reviseLater: 'Revise later',
    label: 'Learning status',
  },
  theme: { change: 'Change theme', light: 'Light', dark: 'Dark', system: 'System' },
  language: { label: 'Language', english: 'English', hindi: 'हिंदी' },
  notFound: { title: 'Page not found', body: "This page doesn't exist (yet).", back: 'Back to dashboard' },
  dashboard: {
    welcome: 'Welcome back 👋',
    pathIntro: 'Every concept follows the same path:',
    path: 'story → why it exists → real example → pitfalls → interview answers → 10-second recap',
    lessonsMastered: 'Lessons mastered',
    questionsKnown: 'Questions you know',
    toRevise: 'To revise',
    reviseQuestions: (n: number) => `Revise ${plural(n, 'question')}`,
    tracks: 'Tracks',
    trackCounts: (lessons: number, questions: number) =>
      `${plural(lessons, 'lesson')} · ${plural(questions, 'question')}`,
    lessonsToRevise: 'Lessons to revise',
  },
  track: {
    comingSoon: 'Lessons coming soon',
    beingWritten: 'This track is being written.',
    minutes: (n: number) => `${n} min`,
  },
  lesson: {
    minRead: (n: number) => `${n} min read`,
    recap: 'The 10-second recap',
    howWell: 'How well do you know this lesson?',
    interviewQuestions: 'Interview questions',
    tryAloud: 'Try answering out loud before opening each one.',
    previous: 'Previous',
    next: 'Next',
    loading: 'Loading lesson',
    loadFailed: "This lesson couldn't be loaded.",
    loadFailedHint: 'Check your connection, then reload the page.',
    notTranslated: '',
  },
  question: {
    answer: 'Interview answer',
    deeper: 'Go deeper',
    followUps: 'Likely follow-ups',
    readLesson: 'Read the lesson',
  },
  questions: {
    title: 'Interview questions',
    intro: 'Read the question, answer it out loud, then open it and compare. Mark what you know; revise the rest.',
    search: 'Search questions, topics, tags…',
    track: 'Track',
    difficulty: 'Difficulty',
    status: 'Status',
    all: 'All',
    notMarked: 'Not marked',
    count: (shown: number, total: number) => `${shown} of ${total} questions`,
    none: 'No questions match these filters',
  },
  backup: {
    title: 'Your progress',
    description:
      'Saved in this browser only. Clearing site data removes it, so export a backup now and then; import it to restore progress or move it to another browser.',
    export: 'Export backup',
    import: 'Import backup',
    reset: 'Reset',
    imported: (n: number) => `Imported ${n} progress entries.`,
    unreadable: 'Could not read that file.',
    empty: 'This file has no DB Lab progress in it.',
    confirmReset: 'Clear all your progress in this browser? This cannot be undone (export a backup first).',
    cleared: 'Progress cleared.',
  },
};

export type Strings = typeof en;

const hi: Strings = {
  app: {
    subtitle: 'MongoDB · PostgreSQL',
    tagline: 'एक बार सीखो, हमेशा याद रखो।',
  },
  nav: {
    dashboard: 'Dashboard',
    questions: 'Interview सवाल',
    tracks: 'Tracks',
  },
  tracks: {
    fundamentals: {
      title: 'बुनियादी बातें',
      description: 'Database कैसे सोचते हैं: ACID, CAP, data modeling, SQL vs NoSQL।',
    },
    mongodb: {
      title: 'MongoDB',
      description: 'Documents, schema patterns, aggregation, indexes, transactions, replication, sharding।',
    },
    postgresql: {
      title: 'PostgreSQL',
      description: 'गहराई से SQL, query plans, indexes, isolation levels, MVCC, locking, partitioning।',
    },
    'system-design': {
      title: 'System Design',
      description: 'Scaling, caching, consistency और असली database design case studies।',
    },
  },
  level: { beginner: 'शुरुआती', intermediate: 'मध्यम', advanced: 'एडवांस्ड' },
  difficulty: { easy: 'आसान', medium: 'मध्यम', hard: 'कठिन' },
  status: {
    known: 'आता है',
    revise: 'दोहराना है',
    iKnowThis: 'मुझे आता है',
    reviseLater: 'बाद में दोहराऊँगा',
    label: 'सीखने की स्थिति',
  },
  theme: { change: 'Theme बदलें', light: 'Light', dark: 'Dark', system: 'System' },
  language: { label: 'भाषा', english: 'English', hindi: 'हिंदी' },
  notFound: { title: 'Page नहीं मिला', body: 'यह page (अभी) मौजूद नहीं है।', back: 'Dashboard पर वापस जाएँ' },
  dashboard: {
    welcome: 'फिर से स्वागत है 👋',
    pathIntro: 'हर concept एक ही रास्ते से चलता है:',
    path: 'कहानी → यह क्यों है → असली उदाहरण → गलतियाँ → interview जवाब → 10-second recap',
    lessonsMastered: 'Lessons जो पक्के हो गए',
    questionsKnown: 'सवाल जो आपको आते हैं',
    toRevise: 'दोहराने के लिए',
    reviseQuestions: (n) => `${n} सवाल दोहराएँ`,
    tracks: 'Tracks',
    trackCounts: (lessons, questions) => `${lessons} lessons · ${questions} सवाल`,
    lessonsToRevise: 'दोहराने वाले lessons',
  },
  track: {
    comingSoon: 'Lessons जल्द आ रहे हैं',
    beingWritten: 'यह track अभी लिखा जा रहा है।',
    minutes: (n) => `${n} मिनट`,
  },
  lesson: {
    minRead: (n) => `${n} मिनट पढ़ाई`,
    recap: '10-second recap',
    howWell: 'यह lesson आपको कितना आता है?',
    interviewQuestions: 'Interview सवाल',
    tryAloud: 'हर सवाल खोलने से पहले उसका जवाब ज़ोर से बोलकर देखें।',
    previous: 'पिछला',
    next: 'अगला',
    loading: 'Lesson load हो रहा है',
    loadFailed: 'यह lesson load नहीं हो पाया।',
    loadFailedHint: 'अपना internet connection देखें, फिर page reload करें।',
    notTranslated: 'इस lesson का हिंदी अनुवाद अभी उपलब्ध नहीं है, इसलिए English दिखाया जा रहा है।',
  },
  question: {
    answer: 'Interview जवाब',
    deeper: 'और गहराई से',
    followUps: 'अगले संभावित सवाल',
    readLesson: 'Lesson पढ़ें',
  },
  questions: {
    title: 'Interview सवाल',
    intro: 'सवाल पढ़ें, ज़ोर से जवाब दें, फिर खोलकर मिलान करें। जो आता है उसे mark करें, बाकी दोहराएँ।',
    search: 'सवाल, topics, tags खोजें…',
    track: 'Track',
    difficulty: 'कठिनाई',
    status: 'स्थिति',
    all: 'सभी',
    notMarked: 'Mark नहीं किए',
    count: (shown, total) => `${total} में से ${shown} सवाल`,
    none: 'इन filters से कोई सवाल नहीं मिला',
  },
  backup: {
    title: 'आपकी progress',
    description:
      'सिर्फ़ इसी browser में save है। Site data साफ़ करने पर यह मिट जाती है, इसलिए समय-समय पर backup export करें; उसे import करके progress वापस लाएँ या दूसरे browser में ले जाएँ।',
    export: 'Backup export करें',
    import: 'Backup import करें',
    reset: 'Reset',
    imported: (n) => `${n} progress entries import हो गईं।`,
    unreadable: 'यह file पढ़ी नहीं जा सकी।',
    empty: 'इस file में DB Lab की कोई progress नहीं है।',
    confirmReset: 'इस browser से आपकी पूरी progress मिटा दें? यह वापस नहीं होगा (पहले backup export कर लें)।',
    cleared: 'Progress मिटा दी गई।',
  },
};

export const strings: Record<Locale, Strings> = { en, hi };
