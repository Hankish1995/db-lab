import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { setLocale, useLocale, useT } from '@/i18n/locale';
import { type Locale } from '@/types/content';

/** EN | हिं switch in the top bar. The choice is remembered in this browser. */
export function LanguageToggle() {
  const locale = useLocale();
  const t = useT();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={locale}
      // Radix sends "" when the active item is clicked again; keep the current language then.
      onValueChange={(value) => value && setLocale(value as Locale)}
      aria-label={t.language.label}
    >
      <ToggleGroupItem value="en" lang="en" aria-label={t.language.english} className="px-2.5 text-xs">
        EN
      </ToggleGroupItem>
      <ToggleGroupItem value="hi" lang="hi" aria-label={t.language.hindi} className="px-2.5 text-xs">
        हिं
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
