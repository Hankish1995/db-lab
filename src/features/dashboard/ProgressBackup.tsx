import { Download, HardDrive, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { exportProgress, importProgress, resetProgress } from '@/features/progress/store';

/** Progress lives in this browser only, so offer a file backup and a reset. */
export function ProgressBackup() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const count = await importProgress(file);
      setMessage({ kind: 'ok', text: `Imported ${count} progress entries.` });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Could not read that file.' });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const onReset = () => {
    if (window.confirm('Clear all your progress in this browser? This cannot be undone (export a backup first).')) {
      resetProgress();
      setMessage({ kind: 'ok', text: 'Progress cleared.' });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HardDrive className="size-4" /> Your progress
        </CardTitle>
        <CardDescription>
          Saved in this browser only. Clearing site data removes it, so export a backup now and then; import it to
          restore progress or move it to another browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={exportProgress}>
            <Download /> Export backup
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <Upload /> Import backup
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={onReset}>
            <Trash2 /> Reset
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
