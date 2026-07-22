/**
 * Pointer and wheel input.
 *
 * Kept out of `GalaxyScene` so the interaction model can be swapped by a
 * plugin (a trackpad-first scheme, a VR rig) without touching the renderer.
 *
 * Gesture map:
 *   wheel            zoom, multiplicative and cursor-anchored
 *   left drag        orbit
 *   middle/shift drag pan
 *   click            select + fly toward
 *   double click     open the session
 *   right click      context menu
 */

import type { GalaxyScene } from './galaxy-scene.ts';
import type { SessionId } from '../core/types.ts';

export interface ControlCallbacks {
  onSelect: (id: SessionId | null) => void;
  onOpen: (id: SessionId) => void;
  onHover: (id: SessionId | null, screen: { x: number; y: number } | null) => void;
  onContextMenu: (id: SessionId | null, screen: { x: number; y: number }) => void;
}

/** Movement beyond this many pixels turns a click into a drag. */
const DRAG_THRESHOLD = 4;
/** Two clicks within this window on the same node count as a double click. */
const DOUBLE_CLICK_MS = 320;

export class GalaxyControls {
  readonly #canvas: HTMLCanvasElement;
  readonly #scene: GalaxyScene;
  readonly #callbacks: ControlCallbacks;

  #pointerId: number | null = null;
  #mode: 'orbit' | 'pan' | null = null;
  #lastX = 0;
  #lastY = 0;
  #downX = 0;
  #downY = 0;
  #moved = 0;

  #lastClickAt = 0;
  #lastClickId: SessionId | null = null;

  /** Hover is picked on a rAF tick, not on every pointermove event. */
  #pendingHover: { x: number; y: number } | null = null;
  #hoverHandle = 0;
  #hoverId: SessionId | null = null;

  #disposed = false;

  constructor(canvas: HTMLCanvasElement, scene: GalaxyScene, callbacks: ControlCallbacks) {
    this.#canvas = canvas;
    this.#scene = scene;
    this.#callbacks = callbacks;

    canvas.addEventListener('pointerdown', this.#onPointerDown);
    canvas.addEventListener('pointermove', this.#onPointerMove);
    canvas.addEventListener('pointerup', this.#onPointerUp);
    canvas.addEventListener('pointercancel', this.#onPointerUp);
    canvas.addEventListener('pointerleave', this.#onPointerLeave);
    canvas.addEventListener('wheel', this.#onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.#onContextMenu);
    canvas.addEventListener('dblclick', this.#onDoubleClick);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    const canvas = this.#canvas;
    canvas.removeEventListener('pointerdown', this.#onPointerDown);
    canvas.removeEventListener('pointermove', this.#onPointerMove);
    canvas.removeEventListener('pointerup', this.#onPointerUp);
    canvas.removeEventListener('pointercancel', this.#onPointerUp);
    canvas.removeEventListener('pointerleave', this.#onPointerLeave);
    canvas.removeEventListener('wheel', this.#onWheel);
    canvas.removeEventListener('contextmenu', this.#onContextMenu);
    canvas.removeEventListener('dblclick', this.#onDoubleClick);

    if (this.#hoverHandle) cancelAnimationFrame(this.#hoverHandle);
  }

  /* ------------------------------------------------------------- handlers */

  #onPointerDown = (event: PointerEvent): void => {
    if (this.#pointerId !== null) return;

    this.#pointerId = event.pointerId;
    this.#canvas.setPointerCapture(event.pointerId);

    this.#mode = event.button === 1 || event.shiftKey ? 'pan' : 'orbit';
    this.#lastX = this.#downX = event.clientX;
    this.#lastY = this.#downY = event.clientY;
    this.#moved = 0;
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (this.#pointerId === event.pointerId && this.#mode !== null) {
      const dx = event.clientX - this.#lastX;
      const dy = event.clientY - this.#lastY;
      this.#lastX = event.clientX;
      this.#lastY = event.clientY;
      this.#moved += Math.abs(dx) + Math.abs(dy);

      if (this.#mode === 'orbit') {
        // 0.006 rad/px is roughly "the galaxy tracks your hand" at default zoom.
        this.#scene.rig.orbit(-dx * 0.006, -dy * 0.006);
      } else {
        this.#scene.rig.pan(dx, dy, this.#scene.camera);
      }
      return;
    }

    // Hover picking, coalesced onto the next frame.
    this.#pendingHover = { x: event.clientX, y: event.clientY };
    if (this.#hoverHandle === 0) {
      this.#hoverHandle = requestAnimationFrame(this.#resolveHover);
    }
  };

  #resolveHover = (): void => {
    this.#hoverHandle = 0;
    const pending = this.#pendingHover;
    this.#pendingHover = null;
    if (!pending || this.#disposed) return;

    const id = this.#scene.pick(pending.x, pending.y);
    if (id === this.#hoverId) return;

    this.#hoverId = id;
    this.#scene.setHovered(id);
    this.#canvas.style.cursor = id ? 'pointer' : 'grab';
    this.#callbacks.onHover(id, id ? { x: pending.x, y: pending.y } : null);
  };

  #onPointerUp = (event: PointerEvent): void => {
    if (this.#pointerId !== event.pointerId) return;

    if (this.#canvas.hasPointerCapture(event.pointerId)) {
      this.#canvas.releasePointerCapture(event.pointerId);
    }
    const wasDrag = this.#moved > DRAG_THRESHOLD;
    this.#pointerId = null;
    this.#mode = null;
    this.#canvas.style.cursor = this.#hoverId ? 'pointer' : 'grab';

    if (wasDrag || event.button === 2) return;
    // A drag that ends where it started is still a click; use the down point.
    if (Math.hypot(event.clientX - this.#downX, event.clientY - this.#downY) > DRAG_THRESHOLD) return;

    const id = this.#scene.pick(event.clientX, event.clientY);
    const now = performance.now();

    // `dblclick` fires too, but pointer capture makes it unreliable on some
    // platforms; detecting it here as well keeps the interaction dependable.
    if (id !== null && id === this.#lastClickId && now - this.#lastClickAt < DOUBLE_CLICK_MS) {
      this.#lastClickAt = 0;
      this.#lastClickId = null;
      this.#callbacks.onOpen(id);
      return;
    }

    this.#lastClickAt = now;
    this.#lastClickId = id;

    this.#callbacks.onSelect(id);
    if (id !== null) this.#scene.focusOn(id);
  };

  #onPointerLeave = (): void => {
    if (this.#hoverId === null) return;
    this.#hoverId = null;
    this.#scene.setHovered(null);
    this.#callbacks.onHover(null, null);
  };

  /**
   * Zoom.
   *
   * Multiplicative so each notch changes the view by the same proportion at
   * every scale, and normalised across the three `deltaMode` values browsers
   * emit (pixels, lines, pages) so a trackpad and a mouse wheel feel alike.
   */
  #onWheel = (event: WheelEvent): void => {
    event.preventDefault();

    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    // Clamp before exponentiating: some mice emit 1000+ in one event.
    const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
    this.#scene.rig.zoom(Math.exp(delta * 0.0013));
  };

  #onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const id = this.#scene.pick(event.clientX, event.clientY);
    this.#callbacks.onContextMenu(id, { x: event.clientX, y: event.clientY });
  };

  #onDoubleClick = (event: MouseEvent): void => {
    event.preventDefault();
    const id = this.#scene.pick(event.clientX, event.clientY);
    if (id !== null) this.#callbacks.onOpen(id);
  };
}
