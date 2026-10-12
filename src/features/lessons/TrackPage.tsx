import { Clock } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { LevelBadge, StatusBadge } from '@/components/common/badges';
import { NotFound } from '@/components/common/NotFound';
import { EmptyState } from '@/components/common/states';
import { TRACK_ICONS } from '@/components/layout/AppSidebar';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getTrackLessons, lessonText } from '@/content';
import { statusOf, useProgress } from '@/features/progress/store';
import { useLocale, useT } from '@/i18n/locale';
import { TRACKS, type Lesson } from '@/types/content';

export function TrackPage() {
  const { trackId } = useParams();
  const progress = useProgress();
  const locale = useLocale();
  const t = useT();
  const track = TRACKS.find((tr) => tr.id === trackId);
  if (!track) return <NotFound />;
  const Icon = TRACK_ICONS[track.id];

  // Group by module, keeping the lessons' reading order.
  const modules = new Map<string, Lesson[]>();
  for (const lesson of getTrackLessons(track.id)) {
    modules.set(lesson.module, [...(modules.get(lesson.module) ?? []), lesson]);
  }

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <span className="rounded-lg bg-primary/10 p-2">
            <Icon className="size-6" />
          </span>
          <h1 className="text-3xl font-bold tracking-tight">{t.tracks[track.id].title}</h1>
        </div>
        <p className="text-muted-foreground">{t.tracks[track.id].description}</p>
      </header>

      {modules.size === 0 && <EmptyState title={t.track.comingSoon} description={t.track.beingWritten} />}

      {[...modules].map(([module, moduleLessons]) => (
        <section key={module} className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{module}</h2>
          <div className="grid gap-3">
            {moduleLessons.map((lesson) => {
              const { title, summary } = lessonText(lesson, locale);
              return (
                <Link key={lesson.slug} to={`/lessons/${lesson.slug}`} className="group">
                  <Card className="transition-colors group-hover:border-primary/50">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-3">
                        <CardTitle className="text-base group-hover:underline">{title}</CardTitle>
                        <StatusBadge status={statusOf(progress, 'lesson', lesson.slug)} />
                      </div>
                      <CardDescription>{summary}</CardDescription>
                      <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
                        <LevelBadge level={lesson.level} />
                        <span className="inline-flex items-center gap-1">
                          <Clock className="size-3" /> {t.track.minutes(lesson.readingMinutes)}
                        </span>
                      </div>
                    </CardHeader>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
