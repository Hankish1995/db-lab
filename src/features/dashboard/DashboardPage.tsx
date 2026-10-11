import { ArrowRight, BookOpen, Brain, RotateCcw } from 'lucide-react';
import { Link } from 'react-router';
import { TRACK_ICONS } from '@/components/layout/AppSidebar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { allLessons, allQuestions, getLesson } from '@/content';
import { slugsWithStatus, useProgress } from '@/features/progress/store';
import { TRACKS } from '@/types/content';
import { ProgressBackup } from './ProgressBackup';

export function DashboardPage() {
  const progress = useProgress();

  // Only count items that still exist in the content (a lesson may have been renamed or removed).
  const lessonSlugs = new Set(allLessons.map((l) => l.slug));
  const questionSlugs = new Set(allQuestions.map((q) => q.slug));
  const count = (kind: 'lesson' | 'question', status: 'known' | 'revise', valid: Set<string>) =>
    slugsWithStatus(progress, kind, status).filter((slug) => valid.has(slug));

  const knownLessons = count('lesson', 'known', lessonSlugs).length;
  const knownQuestions = count('question', 'known', questionSlugs).length;
  const reviseLessons = count('lesson', 'revise', lessonSlugs)
    .map((slug) => getLesson(slug))
    .filter((l) => l !== undefined);
  const reviseQuestionCount = count('question', 'revise', questionSlugs).length;

  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Welcome back 👋</h1>
        <p className="text-muted-foreground">
          Every concept follows the same path: <strong>story → why it exists → real example → pitfalls → interview
          answers → 10-second recap</strong>.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={<BookOpen className="size-4" />}
          label="Lessons mastered"
          value={knownLessons}
          total={allLessons.length}
        />
        <StatCard
          icon={<Brain className="size-4" />}
          label="Questions you know"
          value={knownQuestions}
          total={allQuestions.length}
        />
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <RotateCcw className="size-4" /> To revise
            </CardDescription>
            <CardTitle className="text-3xl">{reviseLessons.length + reviseQuestionCount}</CardTitle>
          </CardHeader>
          <CardContent>
            <Link
              to="/questions?status=revise"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Revise {plural(reviseQuestionCount, 'question')} <ArrowRight className="size-3.5" />
            </Link>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Tracks</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {TRACKS.map((track) => {
            const Icon = TRACK_ICONS[track.id];
            const lessonCount = allLessons.filter((l) => l.track === track.id).length;
            const questionCount = allQuestions.filter((q) => q.track === track.id).length;
            return (
              <Link key={track.id} to={`/tracks/${track.id}`} className="group">
                <Card className="h-full transition-colors group-hover:border-primary/50">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Icon className="size-5" /> {track.title}
                    </CardTitle>
                    <CardDescription>{track.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">
                    {plural(lessonCount, 'lesson')} · {plural(questionCount, 'question')}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>

      {reviseLessons.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Lessons to revise</h2>
          <ul className="divide-y rounded-lg border">
            {reviseLessons.map((lesson) => (
              <li key={lesson.slug}>
                <Link
                  to={`/lessons/${lesson.slug}`}
                  className="flex items-center justify-between gap-3 p-3 hover:bg-muted/50"
                >
                  <span className="font-medium">{lesson.title}</span>
                  <ArrowRight className="size-4 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ProgressBackup />
    </div>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function StatCard({ icon, label, value, total }: { icon: React.ReactNode; label: string; value: number; total: number }) {
  const percent = total ? Math.round((value / total) * 100) : 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2">
          {icon} {label}
        </CardDescription>
        <CardTitle className="text-3xl">
          {value}
          <span className="text-base font-normal text-muted-foreground"> / {total}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Progress value={percent} aria-label={`${label}: ${percent}%`} />
      </CardContent>
    </Card>
  );
}
