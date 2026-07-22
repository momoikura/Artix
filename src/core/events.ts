/**
 * Typed application event bus.
 *
 * Used for cross-cutting notifications that must not create a module cycle:
 * storage tells the renderer that sessions changed; importers report progress;
 * plugins observe lifecycle. Deliberately synchronous and tiny — this is not a
 * message queue.
 */

import type { SessionId } from './types.ts';

export interface ArtixEvents {
  /** The session set changed in a way that requires a galaxy rebuild. */
  'library:changed': { reason: 'import' | 'delete' | 'edit' | 'reindex'; ids: SessionId[] };
  /** A long-running import/export is making progress. */
  'job:progress': { jobId: string; label: string; done: number; total: number };
  'job:finished': { jobId: string; ok: boolean; message: string };
  /** Selection changed (galaxy <-> list <-> search all stay in sync via this). */
  'selection:changed': { id: SessionId | null };
  /** Ask the renderer to fly the camera to a node. */
  'camera:focus': { id: SessionId; immediate: boolean };
  /** Toast-worthy user-facing message. */
  notify: { level: 'info' | 'success' | 'warn' | 'error'; message: string; detail?: string };
}

export type ArtixEventName = keyof ArtixEvents;
export type Listener<K extends ArtixEventName> = (payload: ArtixEvents[K]) => void;

export interface Unsubscribe {
  (): void;
}

class EventBus {
  readonly #listeners = new Map<ArtixEventName, Set<Listener<never>>>();

  on<K extends ArtixEventName>(event: K, listener: Listener<K>): Unsubscribe {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set!.delete(listener as Listener<never>);
    };
  }

  once<K extends ArtixEventName>(event: K, listener: Listener<K>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends ArtixEventName>(event: K, payload: ArtixEvents[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    // Copy so a listener that unsubscribes during dispatch cannot skip a sibling.
    for (const listener of [...set]) {
      try {
        (listener as Listener<K>)(payload);
      } catch (e) {
        // A broken listener (typically a plugin) must never break the emitter.
        console.error(`[artix] listener for "${event}" threw`, e);
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}

export const bus = new EventBus();

/** Convenience wrapper so call sites read as prose. */
export function notify(
  level: ArtixEvents['notify']['level'],
  message: string,
  detail?: string,
): void {
  bus.emit('notify', detail === undefined ? { level, message } : { level, message, detail });
}
