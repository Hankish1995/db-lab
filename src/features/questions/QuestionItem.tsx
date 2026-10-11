import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { DifficultyBadge, StatusBadge } from '@/components/common/badges';
import { Markdown } from '@/components/common/Markdown';
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { StatusButtons } from '@/features/progress/StatusButtons';
import { useStatus } from '@/features/progress/store';
import { type Question } from '@/types/content';

/**
 * One interview question inside an <Accordion>. The answer stays hidden until opened,
 * so you can try answering out loud first — active recall is what makes it stick.
 */
export function QuestionItem({ question, showLessonLink = true }: { question: Question; showLessonLink?: boolean }) {
  const status = useStatus('question', question.slug);

  return (
    <AccordionItem value={question.slug}>
      <AccordionTrigger className="gap-3 text-left hover:no-underline">
        <span className="flex flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-medium">{question.question}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <StatusBadge status={status} />
            <DifficultyBadge difficulty={question.difficulty} />
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="space-y-4">
        <div>
          <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Interview answer
          </p>
          <Markdown>{question.answer}</Markdown>
        </div>

        {question.explanation && (
          <div className="rounded-lg bg-muted/50 p-4">
            <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Go deeper</p>
            <Markdown>{question.explanation}</Markdown>
          </div>
        )}

        {question.followUps.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Likely follow-ups
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {question.followUps.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <StatusButtons kind="question" slug={question.slug} />
          {showLessonLink && question.lessonSlug && (
            <Link
              to={`/lessons/${question.lessonSlug}`}
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Read the lesson <ArrowRight className="size-3.5" />
            </Link>
          )}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}
