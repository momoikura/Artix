/**
 * UI state.
 *
 * Purely presentational: what is open, what is hovered, what the toasts say.
 * Kept apart from the library store so a modal opening never re-renders the
 * galaxy, and vice versa.
 */

import { create } from 'zustand';

import { bus } from '../core/events.ts';
import { newId } from '../core/id.ts';
import { DEFAULT_SETTINGS } from '../storage/settings.ts';
import type { AppSettings } from '../storage/settings.ts';
import type { SessionId } from '../core/types.ts';
import type { QualityTier } from '../renderer/quality.ts';

export interface Toast {
  id: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  detail?: string;
  createdAt: number;
}

export interface ContextMenuState {
  x: number;
  y: number;
  sessionId: SessionId | null;
}

export type Overlay = 'none' | 'palette' | 'settings' | 'import' | 'export' | 'shortcuts' | 'about';

export interface UiState {
  overlay: Overlay;
  contextMenu: ContextMenuState | null;
  hoveredId: SessionId | null;
  hoverPosition: { x: number; y: number } | null;

  /** Right-hand inspector. Collapsed by default on narrow windows. */
  inspectorOpen: boolean;
  timelineOpen: boolean;
  legendOpen: boolean;

  settings: AppSettings;
  qualityTier: QualityTier;
  fps: number;

  toasts: Toast[];

  setOverlay: (overlay: Overlay) => void;
  toggleOverlay: (overlay: Overlay) => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;
  setHovered: (id: SessionId | null, position: { x: number; y: number } | null) => void;
  setInspectorOpen: (open: boolean) => void;
  setTimelineOpen: (open: boolean) => void;
  setLegendOpen: (open: boolean) => void;
  setSettings: (settings: AppSettings) => void;
  patchSettings: (patch: Partial<AppSettings>) => void;
  setQualityTier: (tier: QualityTier) => void;
  setFps: (fps: number) => void;
  pushToast: (toast: Omit<Toast, 'id' | 'createdAt'>) => void;
  dismissToast: (id: string) => void;
}

/** How long a toast stays before self-dismissing. Errors linger. */
const TOAST_TTL: Record<Toast['level'], number> = {
  info: 4000,
  success: 4000,
  warn: 7000,
  error: 12_000,
};

export const useUi = create<UiState>((set, get) => ({
  overlay: 'none',
  contextMenu: null,
  hoveredId: null,
  hoverPosition: null,

  inspectorOpen: true,
  timelineOpen: true,
  legendOpen: false,

  settings: structuredClone(DEFAULT_SETTINGS),
  qualityTier: 'high',
  fps: 60,

  toasts: [],

  setOverlay(overlay) {
    // Opening any overlay closes a context menu — they are never both useful.
    set({ overlay, contextMenu: null });
  },

  toggleOverlay(overlay) {
    set((state) => ({
      overlay: state.overlay === overlay ? 'none' : overlay,
      contextMenu: null,
    }));
  },

  openContextMenu(menu) {
    set({ contextMenu: menu });
  },

  closeContextMenu() {
    set({ contextMenu: null });
  },

  setHovered(id, position) {
    set({ hoveredId: id, hoverPosition: position });
  },

  setInspectorOpen(open) {
    set({ inspectorOpen: open });
  },

  setTimelineOpen(open) {
    set({ timelineOpen: open });
  },

  setLegendOpen(open) {
    set({ legendOpen: open });
  },

  setSettings(settings) {
    set({ settings });
  },

  patchSettings(patch) {
    set((state) => ({ settings: { ...state.settings, ...patch } }));
  },

  setQualityTier(tier) {
    set({ qualityTier: tier });
  },

  setFps(fps) {
    // Round so the HUD does not thrash on sub-frame jitter.
    set({ fps: Math.round(fps) });
  },

  pushToast(toast) {
    const id = newId();
    const entry: Toast = { ...toast, id, createdAt: Date.now() };

    set((state) => ({
      // Cap the stack; older toasts fall off rather than filling the screen.
      toasts: [...state.toasts, entry].slice(-4),
    }));

    setTimeout(() => get().dismissToast(id), TOAST_TTL[toast.level]);
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },
}));

/**
 * Bridge the core event bus into the toast stack.
 *
 * Called once at startup. Returns a disposer so tests can tear it down.
 */
export function connectNotifications(): () => void {
  return bus.on('notify', ({ level, message, detail }) => {
    useUi.getState().pushToast(detail === undefined ? { level, message } : { level, message, detail });
  });
}
