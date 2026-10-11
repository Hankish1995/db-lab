import { type Difficulty, type Level, type ProgressStatus } from '@/types/content';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const DIFFICULTY_STYLE: Record<Difficulty, string> = {
  easy: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
  medium: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  hard: 'border-rose-500/40 text-rose-700 dark:text-rose-400',
};

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  return (
    <Badge variant="outline" className={cn('capitalize', DIFFICULTY_STYLE[difficulty])}>
      {difficulty}
    </Badge>
  );
}

export function LevelBadge({ level }: { level: Level }) {
  return (
    <Badge variant="secondary" className="capitalize">
      {level}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: ProgressStatus }) {
  if (status === 'known') {
    return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Known</Badge>;
  }
  if (status === 'revise') {
    return <Badge className="bg-amber-500 text-white hover:bg-amber-500">Revise</Badge>;
  }
  return null;
}
