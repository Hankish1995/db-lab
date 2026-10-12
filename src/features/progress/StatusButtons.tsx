import { Check, RotateCcw } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useT } from '@/i18n/locale';
import { type ProgressKind } from '@/types/content';
import { setStatus, useStatus } from './store';

/** "I know this" / "Revise later" toggle. Clicking the active option resets it to "new". */
export function StatusButtons({ kind, slug }: { kind: ProgressKind; slug: string }) {
  const status = useStatus(kind, slug);
  const t = useT();
  const value = status === 'new' ? '' : status;

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(next) => setStatus(kind, slug, next === 'known' || next === 'revise' ? next : 'new')}
      aria-label={t.status.label}
    >
      <ToggleGroupItem
        value="known"
        className="gap-1.5 data-[state=on]:bg-emerald-600 data-[state=on]:text-white"
      >
        <Check className="size-4" /> {t.status.iKnowThis}
      </ToggleGroupItem>
      <ToggleGroupItem
        value="revise"
        className="gap-1.5 data-[state=on]:bg-amber-500 data-[state=on]:text-white"
      >
        <RotateCcw className="size-4" /> {t.status.reviseLater}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
