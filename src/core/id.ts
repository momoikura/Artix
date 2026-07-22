/**
 * Identifier generation.
 *
 * Artix ids are lexicographically sortable by creation time (ULID-shaped:
 * 48-bit millisecond timestamp + 80 bits of entropy, Crockford base32). That
 * gives us free chronological ordering in SQLite indexes and makes debugging
 * far easier than opaque UUIDs.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I/L/O/U
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Monotonic guard: two ids minted in the same millisecond still sort correctly. */
let lastTime = -1;
let lastRandom: number[] = [];

function randomBytes(count: number): number[] {
  const out = new Uint8Array(count);
  const g = globalThis.crypto;
  if (g && typeof g.getRandomValues === 'function') {
    g.getRandomValues(out);
  } else {
    // Non-browser fallback (tests under plain node without webcrypto).
    for (let i = 0; i < count; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(out, (b) => b % ALPHABET.length);
}

function encodeTime(ms: number): string {
  let t = ms;
  let out = '';
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** Increment the random component in place so same-ms ids stay strictly increasing. */
function bumpRandom(chars: number[]): number[] {
  const next = [...chars];
  for (let i = next.length - 1; i >= 0; i--) {
    const v = next[i]!;
    if (v < 31) {
      next[i] = v + 1;
      return next;
    }
    next[i] = 0;
  }
  return randomBytes(RANDOM_LEN); // overflow after 32^16 ids in one ms: impossible
}

/** Mint a new sortable id. `now` is injectable for deterministic tests. */
export function newId(now: number = Date.now()): string {
  const time = Math.max(0, Math.floor(now));

  if (time === lastTime) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastTime = time;
    lastRandom = randomBytes(RANDOM_LEN);
  }

  return encodeTime(time) + lastRandom.map((v) => ALPHABET[v]).join('');
}

/** Recover the creation timestamp encoded in an id. */
export function idTimestamp(id: string): number | null {
  if (id.length < TIME_LEN) return null;
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ALPHABET.indexOf(id[i]!);
    if (idx < 0) return null;
    t = t * 32 + idx;
  }
  return t;
}

export function isId(value: string): boolean {
  if (value.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const ch of value) if (!ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * Stable slug used for tag and technology keys. Lowercase, hyphenated, and
 * unicode-normalised so "React " and "react" collapse to one bucket.
 */
/** Combining diacritical marks left behind by NFKD normalisation. */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

export function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9+#._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
