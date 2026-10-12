import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/locale';

export function NotFound() {
  const t = useT();
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="text-5xl font-bold text-muted-foreground">404</p>
      <h1 className="mt-4 text-xl font-semibold">{t.notFound.title}</h1>
      <p className="mt-2 text-muted-foreground">{t.notFound.body}</p>
      <Button asChild className="mt-6">
        <Link to="/">{t.notFound.back}</Link>
      </Button>
    </div>
  );
}
