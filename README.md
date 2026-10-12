# DB Lab

A personal learning app for **MongoDB** and **PostgreSQL**, from first principles to interview-level depth.
**Frontend only:** no backend, no database. Lessons are bundled into the app and your progress is saved
in the browser. **Bilingual:** every lesson and question is available in English and Hindi (हिंदी), switched
with the EN / हिं toggle in the top bar.

Every lesson follows the same path so it sticks:
**story → main goal → real example → diagram → common mistakes → comparison → when not to use it → interview Q&A → 10-second recap.**

## Tech stack

React 19 · TypeScript · Vite · Tailwind CSS 4 · shadcn/ui · React Router · react-markdown

## Run it

Requirements: Node.js 22+.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/ (typechecks first)
npm run preview    # serve the production build locally
npm run check:hindi  # compare every Hindi translation with its English original
```

## How it works

```text
content/  (Markdown + JSON)
   │  read + validated at dev/build time by vite/content-plugin.ts
   ▼
virtual:dblab-content ── lessons (metadata) + questions → main bundle
                     ├── one small chunk per lesson body, per language → loaded when opened
                     └── Hindi question texts → one chunk, loaded when हिं is on
   ▼
React app ── progress (Known / Revise) → localStorage
          └─ language (en / hi)         → localStorage
```

- **Content** lives in `content/` as files. The Vite plugin parses the front matter, validates every
  lesson and question (required fields, unique slugs, questions pointing at real lessons) and fails the
  build with the file name if something is wrong. In `npm run dev`, saving a content file reloads the page.
- **Progress** is stored in this browser's `localStorage` (`dblab-progress-v1`). It survives reloads but
  not clearing site data, so use **Export backup** on the dashboard now and then; **Import backup**
  restores it (also on another browser or device).
- **Languages:** UI texts live in `src/i18n/strings.ts` (the Hindi dictionary is type-checked against the
  English one, so no key can be missing). Hindi lessons and questions live in `content/hi/`, mirroring the
  English files. Anything not yet translated falls back to English with a small note.

## Project structure

```text
db-lab/
├── content/                     ✍️ the learning material (source of truth)
│   ├── STYLE.md                 how to write lessons and questions
│   ├── lessons/<track>/NN-name.md
│   ├── questions/<track>/<lesson-slug>.json
│   └── hi/                      Hindi translations (same layout) + TRANSLATION.md guide
├── scripts/
│   └── check-hindi.mjs          checks translations: unchanged code/diagrams, same structure
├── vite/
│   └── content-plugin.ts        turns /content into importable, validated data
├── src/
│   ├── app/                     App.tsx (providers), router.tsx (routes), theme
│   ├── components/
│   │   ├── ui/                  shadcn/ui components (generated with the shadcn CLI)
│   │   ├── layout/              AppLayout, AppSidebar, ThemeToggle
│   │   └── common/              Markdown renderer, badges, empty state, 404
│   ├── content/                 lookups over the bundled content (getLesson, loadLessonContent…)
│   ├── i18n/                    locale store + English/Hindi UI strings
│   ├── features/                one folder per feature
│   │   ├── dashboard/           stats, tracks, revise list, progress backup
│   │   ├── lessons/             track page, lesson page
│   │   ├── questions/           question bank, question card
│   │   └── progress/            localStorage store, status buttons
│   ├── styles/                  vendored shadcn theme CSS
│   ├── types/                   content and progress types
│   └── lib/                     utils
├── index.html
├── vite.config.ts
└── vercel.json                  static hosting config (SPA rewrite)
```

## Writing content

1. Read `content/STYLE.md`.
2. Add `content/lessons/<track>/NN-slug.md` with front matter
   (`slug`, `title`, `module`, `order`, `summary`, `level`, `tags`, `recap`) and a Markdown body.
   Quote any front-matter value that contains `: `.
3. Add `content/questions/<track>/<slug>.json` with that lesson's interview questions.
4. Translate both into `content/hi/` following `content/hi/TRANSLATION.md`, then run
   `npm run check:hindi`. When you edit an English lesson, update its Hindi file too.

Tracks: `fundamentals`, `mongodb`, `postgresql`, `system-design`.

## Hosting (free)

It's a static site, so any static host works. On **Vercel** (free tier): import the repo; `vercel.json`
already sets the build command, the `dist` output folder and the rewrite that makes page refreshes on
routes like `/lessons/acid` work. No environment variables are needed.
