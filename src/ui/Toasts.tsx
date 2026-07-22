/**
 * Toast stack. Bottom-left so it never covers the inspector or the timeline's
 * scrub handles.
 */

import { useUi } from '../state/ui-store.ts';
import './Toasts.css';

const ICONS: Record<string, string> = {
  info: 'ℹ',
  success: '✓',
  warn: '!',
  error: '✕',
};

export function Toasts(): JSX.Element {
  const toasts = useUi((state) => state.toasts);
  const dismiss = useUi((state) => state.dismissToast);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.level}`}>
          <span className="toast__icon" aria-hidden="true">
            {ICONS[toast.level]}
          </span>
          <div className="toast__content">
            <div className="toast__message">{toast.message}</div>
            {toast.detail && <div className="toast__detail selectable">{toast.detail}</div>}
          </div>
          <button
            className="toast__close"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
