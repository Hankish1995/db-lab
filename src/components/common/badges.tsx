import { Badge } from '@/components/ui/badge';
import { useT } from '@/i18n/locale';
import { cn } from '@/lib/utils';
import { type Difficulty, type Level, type ProgressStatus } from '@/types/content';

const DIFFICULTY_STYLE: Record<Difficulty, string> = {
  easy: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
  medium: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  hard: 'border-rose-500/40 text-rose-700 dark:text-rose-400',
};

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  const t = useT();
  return (
    <Badge variant="outline" className={cn(DIFFICULTY_STYLE[difficulty])}>
      {t.difficulty[difficulty]}
    </Badge>
  );
}

export function LevelBadge({ level }: { level: Level }) {
  const t = useT();
  return <Badge variant="secondary">{t.level[level]}</Badge>;
}

export function StatusBadge({ status }: { status: ProgressStatus }) {
  const t = useT();
  if (status === 'known') {
    return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">{t.status.known}</Badge>;
  }
  if (status === 'revise') {
    return <Badge className="bg-amber-500 text-white hover:bg-amber-500">{t.status.revise}</Badge>;
  }
  return null;
}
