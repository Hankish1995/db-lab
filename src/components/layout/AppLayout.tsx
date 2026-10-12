import { Outlet, ScrollRestoration } from 'react-router';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { useT } from '@/i18n/locale';
import { AppSidebar } from './AppSidebar';
import { LanguageToggle } from './LanguageToggle';
import { ThemeToggle } from './ThemeToggle';

export function AppLayout() {
  const t = useT();
  return (
    <SidebarProvider>
      <AppSidebar />
      {/* min-w-0: let the content column shrink, so wide code blocks scroll instead of overflowing the page. */}
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <span className="hidden truncate text-sm font-medium text-muted-foreground sm:block">{t.app.tagline}</span>
          <div className="ml-auto flex items-center gap-2">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-4xl min-w-0 px-4 py-8 sm:px-6 lg:py-10">
          <Outlet />
        </main>
      </SidebarInset>
      <ScrollRestoration />
    </SidebarProvider>
  );
}
