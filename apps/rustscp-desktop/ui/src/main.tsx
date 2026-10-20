import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Toaster } from './components/ui/toast.tsx';
import { installInputHardening } from './utils/inputHardening.ts';
import './index.css';
import './i18n.ts';

// Typed text (usernames, hosts, paths, commands) must never be auto-capitalized or autocorrected.
installInputHardening();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
      <Toaster />
    </ErrorBoundary>
  </React.StrictMode>
);
