/**
 * Fuzzy matching.
 *
 * Two complementary strategies, because they fail in different places:
 *
 *  - `fuzzyMatch` is an fzf-style subsequence scorer. It is what makes
 *    `gxrndr` find "galaxy-renderer" while you type. Fast, allocation-light,
 *    and it returns the matched character offsets for highlighting.
 *  - `trigramSimilarity` is a Dice coefficient over character trigrams. It
 *    tolerates transpositions and typos ("recieve" vs "receive") that a
 *    subsequence scorer rejects outright.
 *
 * Both are pure and synchronous; the search engine runs them over the
 * *candidate* set only, never over the whole library.
 */

/** Result of a successful subsequence match. */
export interface FuzzyMatch {
  /** Higher is better. Unbounded above, but typically 0..400 for short strings. */
  score: number;
  /** Indices into the haystack that were matched, ascending. */
  positions: number[];
}

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTEND = -1;
const BONUS_BOUNDARY = 8; // match right after a separator
const BONUS_CAMEL = 7; // lower→Upper transition
const BONUS_CONSECUTIVE = 8;
const BONUS_FIRST_CHAR = 12;

const SEPARATORS = new Set([' ', '/', '\\', '-', '_', '.', ':', '@', '(', '[', '{', ',']);

function isSeparator(ch: string | undefined): boolean {
  return ch === undefined || SEPARATORS.has(ch);
}

/**
 * Greedy forward scan with a backward refinement pass.
 *
 * A full Smith-Waterman would score marginally better but costs O(n·m) memory;
 * at 100k candidates the greedy variant is what keeps keystroke latency in the
 * single-digit milliseconds. The backward pass recovers most of the quality by
 * pulling the match window as tight as possible.
 */
export function fuzzyMatch(needle: string, haystack: string): FuzzyMatch | null {
  if (needle.length === 0) return { score: 0, positions: [] };
  if (needle.length > haystack.length) return null;

  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();

  // Forward scan: earliest possible end position.
  let hi = 0;
  let ni = 0;
  while (hi < h.length && ni < n.length) {
    if (h[hi] === n[ni]) ni++;
    hi++;
  }
  if (ni < n.length) return null; // not a subsequence at all
  const end = hi;

  // Backward scan from `end`: latest possible start, i.e. the tightest window.
  let start = end - 1;
  let nj = n.length - 1;
  while (start >= 0 && nj >= 0) {
    if (h[start] === n[nj]) nj--;
    if (nj >= 0) start--;
  }

  // Score inside [start, end).
  const positions: number[] = [];
  let score = 0;
  let gap = 0;
  let consecutive = 0;
  let k = 0;

  for (let i = start; i < end && k < n.length; i++) {
    if (h[i] !== n[k]) {
      score += gap === 0 ? SCORE_GAP_START : SCORE_GAP_EXTEND;
      gap++;
      consecutive = 0;
      continue;
    }

    let bonus = 0;
    if (i === 0) bonus += BONUS_FIRST_CHAR;
    else {
      const prev = haystack[i - 1];
      const cur = haystack[i]!;
      if (isSeparator(prev)) bonus += BONUS_BOUNDARY;
      else if (prev !== undefined && prev === prev.toLowerCase() && cur !== cur.toLowerCase()) {
        bonus += BONUS_CAMEL;
      }
    }
    if (consecutive > 0) bonus += BONUS_CONSECUTIVE;

    score += SCORE_MATCH + bonus;
    positions.push(i);
    consecutive++;
    gap = 0;
    k++;
  }

  if (k < n.length) return null;

  // Prefer matches that cover more of a short haystack.
  score += Math.round((n.length / haystack.length) * 24);
  return { score, positions };
}

/** Cheap pre-filter: is `needle` a subsequence of `haystack` at all? */
export function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  let ni = 0;
  for (let i = 0; i < haystack.length && ni < needle.length; i++) {
    if (haystack[i] === needle[ni]) ni++;
  }
  return ni === needle.length;
}

/* ---------------------------------------------------------------- trigrams */

/** Padded character trigrams, e.g. "cat" -> ["  c", " ca", "cat", "at ", "t  "]. */
export function trigrams(value: string): Set<string> {
  const padded = `  ${value.toLowerCase().trim()}  `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Sørensen–Dice coefficient over trigram sets. 0..1. */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const g of small) if (large.has(g)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * Bounded Damerau–Levenshtein distance.
 *
 * Returns `maxDistance + 1` as soon as the true distance provably exceeds the
 * bound, so typo tolerance costs O(n·k) rather than O(n·m).
 */
export function editDistance(a: string, b: string, maxDistance = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current: number[] = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = i;

    const from = Math.max(1, i - maxDistance);
    const to = Math.min(b.length, i + maxDistance);

    // Cells outside the diagonal band can never win; mark them unreachable.
    for (let j = 1; j < from; j++) current[j] = maxDistance + 1;
    for (let j = to + 1; j <= b.length; j++) current[j] = maxDistance + 1;

    for (let j = from; j <= to; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        current[j - 1]! + 1, // insertion
        prev[j]! + 1, // deletion
        prev[j - 1]! + cost, // substitution
      );
      // Transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2]! + 1);
      }
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }

    if (rowMin > maxDistance) return maxDistance + 1;

    prev2 = prev;
    prev = current;
    current = new Array(b.length + 1);
  }

  const result = prev[b.length]!;
  return result > maxDistance ? maxDistance + 1 : result;
}

/**
 * Combined typo tolerance used by the search engine's fuzzy pass.
 * Returns 0..1; anything below ~0.55 is not worth showing.
 */
export function typoSimilarity(needle: string, haystack: string): number {
  if (haystack.includes(needle)) return 1;
  const bound = needle.length <= 4 ? 1 : needle.length <= 8 ? 2 : 3;
  const distance = editDistance(needle, haystack, bound);
  if (distance <= bound) return 1 - distance / (bound + 1);
  return trigramSimilarity(needle, haystack) * 0.8;
}
