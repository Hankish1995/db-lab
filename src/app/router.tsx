import { createBrowserRouter } from 'react-router';
import { AppLayout } from '@/components/layout/AppLayout';
import { NotFound } from '@/components/common/NotFound';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { LessonPage } from '@/features/lessons/LessonPage';
import { TrackPage } from '@/features/lessons/TrackPage';
import { QuestionsPage } from '@/features/questions/QuestionsPage';

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'tracks/:trackId', element: <TrackPage /> },
      { path: 'lessons/:slug', element: <LessonPage /> },
      { path: 'questions', element: <QuestionsPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
