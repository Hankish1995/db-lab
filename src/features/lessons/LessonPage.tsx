import { ArrowLeft, ArrowRight, Clock, Zap } from 'lucide-react';
import { Component, Suspense, use, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { LevelBadge } from '@/components/common/badges';
import { Markdown } from '@/components/common/Markdown';
import { NotFound } from '@/components/common/NotFound';
import { Accordion } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { getLesson, getLessonQuestions, getTrackLessons, loadLessonContent } from '@/content';
import { StatusButtons } from '@/features/progress/StatusButtons';
import { QuestionItem } from '@/features/questions/QuestionItem';
import { TRACKS } from '@/types/content';

/** The lesson text lives in its own chunk; `use` suspends until it has downloaded. */
function LessonBody({ slug }: { slug: string }) {
  const { body, recap } = use(loadLessonContent(slug));
  return (
    <>
      <Markdown>{body}</Markdown>
      {recap && (
        <Card className="border-emerald-500/40 bg-emerald-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="size-4 text-emerald-600" /> The 10-second recap
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="leading-relaxed">{recap}</p>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function BodySkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading lesson">
      <Skeleton className="h-7 w-1/3" />
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

/** Shown if the lesson chunk can't be downloaded (e.g. offline, or a new deploy replaced old files). */
class ChunkErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <p className="font-medium text-destructive">This lesson couldn't be loaded.</p>
        <p className="mt-1 text-muted-foreground">Check your connection, then reload the page.</p>
      </div>
    );
  }
}

export function LessonPage() {
  const { slug = '' } = useParams();
  const lesson = getLesson(slug);
  if (!lesson) return <NotFound />;

  const track = TRACKS.find((t) => t.id === lesson.track);
  const siblings = getTrackLessons(lesson.track);
  const index = siblings.findIndex((l) => l.slug === lesson.slug);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 ? siblings[index + 1] : undefined;
  const questions = getLessonQuestions(lesson.slug);

  return (
    <article className="space-y-8">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to={`/tracks/${lesson.track}`}>{track?.title}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{lesson.module}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight text-balance">{lesson.title}</h1>
        <p className="text-lg text-muted-foreground">{lesson.summary}</p>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <LevelBadge level={lesson.level} />
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3.5" /> {lesson.readingMinutes} min read
          </span>
          {lesson.tags.slice(0, 5).map((tag) => (
            <Badge key={tag} variant="outline" className="font-normal">
              {tag}
            </Badge>
          ))}
        </div>
      </header>

      <Separator />

      {/* key: reset the boundary when navigating to another lesson. */}
      <ChunkErrorBoundary key={lesson.slug}>
        <Suspense fallback={<BodySkeleton />}>
          <LessonBody slug={lesson.slug} />
        </Suspense>
      </ChunkErrorBoundary>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
        <p className="text-sm font-medium">How well do you know this lesson?</p>
        <StatusButtons kind="lesson" slug={lesson.slug} />
      </div>

      {questions.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-xl font-semibold">Interview questions</h2>
            <p className="text-sm text-muted-foreground">
              Try answering out loud before opening each one.
            </p>
          </div>
          <Accordion type="multiple" className="rounded-lg border px-4">
            {questions.map((q) => (
              <QuestionItem key={q.slug} question={q} showLessonLink={false} />
            ))}
          </Accordion>
        </section>
      )}

      <nav className="flex justify-between gap-4 border-t pt-6">
        {previous ? (
          <Link to={`/lessons/${previous.slug}`} className="group flex flex-col text-sm">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <ArrowLeft className="size-3.5" /> Previous
            </span>
            <span className="font-medium group-hover:underline">{previous.title.split(':')[0]}</span>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link to={`/lessons/${next.slug}`} className="group flex flex-col items-end text-right text-sm">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              Next <ArrowRight className="size-3.5" />
            </span>
            <span className="font-medium group-hover:underline">{next.title.split(':')[0]}</span>
          </Link>
        )}
      </nav>
    </article>
  );
}
