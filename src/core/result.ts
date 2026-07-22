/**
 * Result type.
 *
 * Anything that crosses a trust boundary — the IPC bridge, a file the user
 * picked, a plugin — returns `Result` rather than throwing. Exceptions are
 * reserved for genuine programmer error.
 */

export type Result<T, E = ArtixError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}

/** Unwrap or fall back. Never throws. */
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** Unwrap or throw — only for call sites that genuinely cannot continue. */
export function unwrap<T>(r: Result<T, ArtixError>): T {
  if (r.ok) return r.value;
  throw new Error(`${r.error.code}: ${r.error.message}`);
}

export function map<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

/** Wrap a throwing function into a Result. */
export async function attempt<T>(
  fn: () => T | Promise<T>,
  code: ArtixErrorCode = 'unknown',
): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(toArtixError(e, code));
  }
}

/* ------------------------------------------------------------------- errors */

export const ARTIX_ERROR_CODES = [
  'unknown',
  'storage',
  'not-found',
  'duplicate',
  'invalid-input',
  'parse',
  'io',
  'unsupported',
  'plugin',
  'cancelled',
] as const;

export type ArtixErrorCode = (typeof ARTIX_ERROR_CODES)[number];

export interface ArtixError {
  code: ArtixErrorCode;
  message: string;
  /** Human-actionable next step, shown verbatim in the UI when present. */
  hint?: string;
  /** Arbitrary structured context for logs. Never rendered. */
  detail?: unknown;
}

export function artixError(
  code: ArtixErrorCode,
  message: string,
  extra: Omit<ArtixError, 'code' | 'message'> = {},
): ArtixError {
  return { code, message, ...extra };
}

/** Normalise anything thrown (including Rust IPC string payloads) into ArtixError. */
export function toArtixError(e: unknown, fallbackCode: ArtixErrorCode = 'unknown'): ArtixError {
  if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
    const candidate = e as { code: unknown; message: unknown };
    if (
      typeof candidate.message === 'string' &&
      ARTIX_ERROR_CODES.includes(candidate.code as ArtixErrorCode)
    ) {
      return e as ArtixError;
    }
  }
  if (e instanceof Error) return { code: fallbackCode, message: e.message, detail: e.stack };
  if (typeof e === 'string') return { code: fallbackCode, message: e };
  return { code: fallbackCode, message: 'Unexpected error', detail: e };
}
