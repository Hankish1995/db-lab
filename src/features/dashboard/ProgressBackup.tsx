import { Download, HardDrive, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { exportProgress, importProgress, resetProgress } from '@/features/progress/store';
import { useT } from '@/i18n/locale';

/** Progress lives in this browser only, so offer a file backup and a reset. */
export function ProgressBackup() {
  const t = useT();
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const count = await importProgress(file);
      setMessage(
        count > 0 ? { kind: 'ok', text: t.backup.imported(count) } : { kind: 'error', text: t.backup.empty },
      );
    } catch {
      setMessage({ kind: 'error', text: t.backup.unreadable });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const onReset = () => {
    if (window.confirm(t.backup.confirmReset)) {
      resetProgress();
      setMessage({ kind: 'ok', text: t.backup.cleared });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HardDrive className="size-4" /> {t.backup.title}
        </CardTitle>
        <CardDescription>{t.backup.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={exportProgress}>
            <Download /> {t.backup.export}
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <Upload /> {t.backup.import}
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={onReset}>
            <Trash2 /> {t.backup.reset}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => onImport(e.target.files?.[0])}
          />
        </div>
        {message && (
          <p
            role="status"
            className={message.kind === 'ok' ? 'text-sm text-emerald-700 dark:text-emerald-400' : 'text-sm text-destructive'}
          >
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
