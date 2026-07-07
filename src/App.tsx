import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { cx } from '@linaria/core';
import { lightTheme, spacing, typography } from 'haze-ui';
import { Toaster } from 'sonner';
import { AppQueryProvider } from './hooks/useQueryClient';
import { globalStyles } from './styles/global';
import { css } from '@linaria/core';
import ErrorBoundary from './web/components/ErrorBoundary';

const appShell = css`
  height: 100%;
  width: 100%;
`;
import { useKeyboard, shortcutActions } from './web/hooks/useKeyboard';

// Global keyboard shortcuts
function KeyboardShortcuts() {
  useKeyboard([
    { key: '/', ctrl: true, handler: shortcutActions.toggleSearch, description: 'Toggle search' },
    { key: 'Escape', handler: shortcutActions.closePanel, description: 'Close panel' },
    { key: 'p', ctrl: true, shift: true, handler: shortcutActions.togglePreview, description: 'Toggle preview' },
  ]);
  return null;
}

const HomePage = lazy(() => import('./web/pages/HomePage'));
const ProjectPage = lazy(() => import('./web/pages/ProjectPage'));
const SettingsPage = lazy(() => import('./web/pages/SettingsPage'));

export default function App() {
  return (
    <AppQueryProvider>
      <BrowserRouter>
        <div className={cx(globalStyles, lightTheme, spacing, typography, appShell)}>
          <KeyboardShortcuts />
          <Toaster position="top-right" richColors />
          <ErrorBoundary>
            <Suspense fallback={<div>加载中...</div>}>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/projects/:id" element={<ProjectPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </div>
      </BrowserRouter>
    </AppQueryProvider>
  );
}
