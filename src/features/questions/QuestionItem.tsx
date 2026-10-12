import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { DifficultyBadge, StatusBadge } from '@/components/common/badges';
import { Markdown } from '@/components/common/Markdown';
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { questionText, useHindiQuestions } from '@/content';
import { StatusButtons } from '@/features/progress/StatusButtons';
import { useStatus } from '@/features/progress/store';
import { useLocale, useT } from '@/i18n/locale';
import { type Question } from '@/types/content';

/**
 * One interview question inside an <Accordion>. The answer stays hidden until opened,
 * so you can try answering out loud first — active recall is what makes it stick.
 * Shown in the chosen language; untranslated questions fall back to English.
 */
export function QuestionItem({ question, showLessonLink = true }: { question: Question; showLessonLink?: boolean }) {
  const status = useStatus('question', question.slug);
  const locale = useLocale();
  const t = useT();
  const text = questionText(question, useHindiQuestions(locale));

  return (
    <AccordionItem value={question.slug}>
      <AccordionTrigger className="gap-3 text-left hover:no-underline">
        <span className="flex flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-medium">{text.question}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <StatusBadge status={status} />
            <DifficultyBadge difficulty={question.difficulty} />
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="space-y-4">
        <div>
          <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t.question.answer}</p>
          <Markdown>{text.answer}</Markdown>
        </div>

        {text.explanation && (
          <div className="rounded-lg bg-muted/50 p-4">
            <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {t.question.deeper}
            </p>
            <Markdown>{text.explanation}</Markdown>
          </div>
        )}

        {text.followUps.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {t.question.followUps}
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {text.followUps.map((f) => (
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
              {t.question.readLesson} <ArrowRight className="size-3.5" />
            </Link>
          )}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}
