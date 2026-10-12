import { BookOpen, Brain, Database, LayoutDashboard, Leaf, Network, type LucideIcon } from 'lucide-react';
import { Link, useLocation, useMatch } from 'react-router';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { allLessons, getLesson, lessonText } from '@/content';
import { statusOf, useProgress } from '@/features/progress/store';
import { useLocale, useT } from '@/i18n/locale';
import { TRACKS, type TrackId } from '@/types/content';

export const TRACK_ICONS: Record<TrackId, LucideIcon> = {
  fundamentals: BookOpen,
  mongodb: Leaf,
  postgresql: Database,
  'system-design': Network,
};

export function AppSidebar() {
  const { pathname } = useLocation();
  // The sidebar sits in the layout route, so read the child route's params from the URL directly.
  const trackMatch = useMatch('/tracks/:trackId');
  const lessonMatch = useMatch('/lessons/:slug');
  const currentSlug = lessonMatch?.params.slug;
  const progress = useProgress();
  const locale = useLocale();
  const t = useT();

  // The open track: the one in the URL, or the track of the lesson being read.
  const activeTrack =
    (trackMatch?.params.trackId as TrackId | undefined) ?? (currentSlug ? getLesson(currentSlug)?.track : undefined);

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <Link to="/" className="flex items-center gap-2 px-2 py-1.5">
          <img src="/favicon.svg" alt="" className="size-7" />
          <div className="leading-tight">
            <p className="font-semibold">DB Lab</p>
            <p className="text-xs text-muted-foreground">{t.app.subtitle}</p>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === '/'}>
                  <Link to="/">
                    <LayoutDashboard /> {t.nav.dashboard}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === '/questions'}>
                  <Link to="/questions">
                    <Brain /> {t.nav.questions}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>{t.nav.tracks}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {TRACKS.map((track) => {
                const Icon = TRACK_ICONS[track.id];
                const trackLessons = allLessons.filter((l) => l.track === track.id);
                const isOpen = activeTrack === track.id;
                return (
                  <SidebarMenuItem key={track.id}>
                    <SidebarMenuButton asChild isActive={pathname === `/tracks/${track.id}`}>
                      <Link to={`/tracks/${track.id}`}>
                        <Icon /> {t.tracks[track.id].title}
                      </Link>
                    </SidebarMenuButton>
                    <SidebarMenuBadge>{trackLessons.length}</SidebarMenuBadge>
                    {isOpen && trackLessons.length > 0 && (
                      <SidebarMenuSub>
                        {trackLessons.map((lesson) => (
                          <SidebarMenuSubItem key={lesson.slug}>
                            <SidebarMenuSubButton asChild isActive={currentSlug === lesson.slug}>
                              <Link to={`/lessons/${lesson.slug}`}>
                                {/* Short name: the part of the title before the colon. */}
                                <span className="truncate">{lessonText(lesson, locale).title.split(':')[0]}</span>
                                <StatusDot status={statusOf(progress, 'lesson', lesson.slug)} />
                              </Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === 'known') return <span className="ml-auto size-2 shrink-0 rounded-full bg-emerald-500" />;
  if (status === 'revise') return <span className="ml-auto size-2 shrink-0 rounded-full bg-amber-500" />;
  return null;
}
