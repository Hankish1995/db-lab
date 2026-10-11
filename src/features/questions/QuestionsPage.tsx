import { Search } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { EmptyState } from '@/components/common/states';
import { Accordion } from '@/components/ui/accordion';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { allQuestions } from '@/content';
import { statusOf, useProgress } from '@/features/progress/store';
import { TRACKS, type Difficulty, type TrackId } from '@/types/content';
import { QuestionItem } from './QuestionItem';

type StatusFilter = 'all' | 'unanswered' | 'revise' | 'known';

/** Filters live in the URL (?track=…&difficulty=…), so a filtered view can be bookmarked. */
export function QuestionsPage() {
  const [params, setParams] = useSearchParams();
  const track = (params.get('track') ?? 'all') as TrackId | 'all';
  const difficulty = (params.get('difficulty') ?? 'all') as Difficulty | 'all';
  const statusFilter = (params.get('status') ?? 'all') as StatusFilter;
  const search = params.get('q') ?? '';

  const progress = useProgress();

  const setParam = (key: string, value: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (!value || value === 'all') next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  };

  const needle = search.trim().toLowerCase();
  const questions = allQuestions.filter((q) => {
    if (track !== 'all' && q.track !== track) return false;
    if (difficulty !== 'all' && q.difficulty !== difficulty) return false;
    const s = statusOf(progress, 'question', q.slug);
    if (statusFilter === 'unanswered' && (s === 'known' || s === 'revise')) return false;
    if (statusFilter === 'revise' && s !== 'revise') return false;
    if (statusFilter === 'known' && s !== 'known') return false;
    if (needle) {
      const haystack = `${q.question} ${q.topic} ${q.tags.join(' ')}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Interview questions</h1>
        <p className="text-muted-foreground">
          Read the question, answer it out loud, then open it and compare. Mark what you know; revise the rest.
        </p>
      </header>

      <div className="space-y-3 rounded-lg border p-4">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setParam('q', e.target.value)}
            placeholder="Search questions, topics, tags…"
            className="pl-9"
            aria-label="Search questions"
          />
        </div>
        <FilterRow label="Track" value={track} onChange={(v) => setParam('track', v)}>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          {TRACKS.map((t) => (
            <ToggleGroupItem key={t.id} value={t.id}>
              {t.title}
            </ToggleGroupItem>
          ))}
        </FilterRow>
        <FilterRow label="Difficulty" value={difficulty} onChange={(v) => setParam('difficulty', v)}>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="easy">Easy</ToggleGroupItem>
          <ToggleGroupItem value="medium">Medium</ToggleGroupItem>
          <ToggleGroupItem value="hard">Hard</ToggleGroupItem>
        </FilterRow>
        <FilterRow label="Status" value={statusFilter} onChange={(v) => setParam('status', v)}>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="unanswered">Not marked</ToggleGroupItem>
          <ToggleGroupItem value="revise">Revise</ToggleGroupItem>
          <ToggleGroupItem value="known">Known</ToggleGroupItem>
        </FilterRow>
      </div>

      <p className="text-sm text-muted-foreground">
        {questions.length} of {allQuestions.length} questions
      </p>
      {questions.length === 0 ? (
        <EmptyState title="No questions match these filters" />
      ) : (
        <Accordion type="multiple" className="rounded-lg border px-4">
          {questions.map((q) => (
            <QuestionItem key={q.slug} question={q} />
          ))}
        </Accordion>
      )}
    </div>
  );
}

function FilterRow({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-20 shrink-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={value}
        // Radix sends "" when the active item is clicked again; treat that as "all".
        onValueChange={(v) => onChange(v || 'all')}
        className="flex-wrap justify-start"
        aria-label={label}
      >
        {children}
      </ToggleGroup>
    </div>
  );
}
