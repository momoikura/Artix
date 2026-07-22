import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './styles/global.css';

/**
 * Entry point.
 *
 * The boot splash painted by `index.html` is removed only once React has
 * committed its first frame, so there is never a flash of empty canvas between
 * the two.
 */
const container = document.getElementById('root');
if (!container) throw new Error('Artix: #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App onReady={dismissBoot} />
  </StrictMode>,
);

function dismissBoot(): void {
  const boot = document.getElementById('artix-boot');
  if (!boot) return;
  boot.classList.add('is-hidden');
  boot.addEventListener('transitionend', () => boot.remove(), { once: true });
  // Belt and braces: remove it even if the transition never fires.
  setTimeout(() => boot.remove(), 1200);
}
