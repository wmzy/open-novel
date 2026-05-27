import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { cx } from '@linaria/core';
import { lightTheme, spacing, typography } from 'haze-ui';
import { ToastContainer } from 'haze-ui';
import { AppQueryProvider } from './hooks/useQueryClient';
import { globalStyles } from './styles/global';

const HomePage = lazy(() => import('./web/pages/HomePage'));
const ProjectPage = lazy(() => import('./web/pages/ProjectPage'));
const SettingsPage = lazy(() => import('./web/pages/SettingsPage'));

export default function App() {
  return (
    <AppQueryProvider>
      <BrowserRouter>
        <div className={cx(globalStyles, lightTheme, spacing, typography)}>
          <ToastContainer />
          <Suspense fallback={<div>Loading...</div>}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/projects/:id" element={<ProjectPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </Suspense>
        </div>
      </BrowserRouter>
    </AppQueryProvider>
  );
}
