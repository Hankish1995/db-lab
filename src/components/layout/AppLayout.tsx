import { Outlet, ScrollRestoration } from 'react-router';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from './AppSidebar';
import { ThemeToggle } from './ThemeToggle';

export function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      {/* min-w-0: let the content column shrink, so wide code blocks scroll instead of overflowing the page. */}
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <span className="text-sm font-medium text-muted-foreground">Learn it once. Remember it forever.</span>
          <div className="ml-auto">
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
