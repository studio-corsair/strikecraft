import './styles.css'; // first: screen stylesheets imported by the app build on these tokens and override them
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable app: the worker caches the shell so it opens offline. Prices and orders are never cached.
if ('serviceWorker' in navigator && import.meta.env.PROD)
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e: unknown) => console.warn('service worker not registered', e)); // error-ok: installability is optional; the app works without the worker
  });
