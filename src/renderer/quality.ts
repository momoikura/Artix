/**
 * Quality tiers.
 *
 * Each tier is a complete, self-consistent look — not a set of independent
 * toggles — so that dropping a tier never produces a broken-looking scene. The
 * adaptive controller only ever moves one step at a time and refuses to
 * oscillate.
 */

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityProfile {
  tier: QualityTier;
  maxPixelRatio: number;
  bloom: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  nebula: boolean;
  nebulaOctaves: number;
  dustCount: number;
  starCount: number;
  coreGlow: boolean;
  depthOfField: boolean;
  aperture: number;
  /** Upper bound on simultaneously rendered DOM labels. */
  labelBudget: number;
}

export const QUALITY_PROFILES: Record<QualityTier, QualityProfile> = {
  low: {
    tier: 'low',
    maxPixelRatio: 1,
    bloom: false,
    bloomStrength: 0,
    bloomRadius: 0,
    bloomThreshold: 1,
    nebula: false,
    nebulaOctaves: 3,
    dustCount: 0,
    starCount: 1200,
    coreGlow: true,
    depthOfField: false,
    aperture: 0,
    labelBudget: 12,
  },
  medium: {
    tier: 'medium',
    maxPixelRatio: 1.5,
    bloom: true,
    bloomStrength: 0.42,
    bloomRadius: 0.5,
    bloomThreshold: 0.72,
    nebula: true,
    nebulaOctaves: 4,
    dustCount: 2000,
    starCount: 3000,
    coreGlow: true,
    depthOfField: true,
    aperture: 0.28,
    labelBudget: 24,
  },
  high: {
    tier: 'high',
    maxPixelRatio: 2,
    bloom: true,
    bloomStrength: 0.58,
    bloomRadius: 0.62,
    bloomThreshold: 0.64,
    nebula: true,
    nebulaOctaves: 5,
    dustCount: 6000,
    starCount: 6000,
    coreGlow: true,
    depthOfField: true,
    aperture: 0.42,
    labelBudget: 40,
  },
  ultra: {
    tier: 'ultra',
    maxPixelRatio: 2,
    bloom: true,
    bloomStrength: 0.68,
    bloomRadius: 0.72,
    bloomThreshold: 0.58,
    nebula: true,
    nebulaOctaves: 6,
    dustCount: 12000,
    starCount: 9000,
    coreGlow: true,
    depthOfField: true,
    aperture: 0.5,
    labelBudget: 56,
  },
};

const ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

/**
 * Adaptive quality controller.
 *
 * Watches a rolling median of frame times and steps the tier down when the
 * budget is consistently missed. It steps *up* far more reluctantly than it
 * steps down, and never returns to a tier that already failed — otherwise the
 * scene visibly pumps between settings, which is worse than simply being one
 * tier lower.
 */
export class AdaptiveQuality {
  #samples: number[] = [];
  #tier: QualityTier;
  #locked: boolean;
  /** Highest tier that has already proven too slow on this machine. */
  #ceiling: QualityTier | null = null;
  #cooldown = 0;

  constructor(initial: QualityTier, adaptive: boolean) {
    this.#tier = initial;
    this.#locked = !adaptive;
  }

  get tier(): QualityTier {
    return this.#tier;
  }

  get profile(): QualityProfile {
    return QUALITY_PROFILES[this.#tier];
  }

  /** Feed a frame time in milliseconds. Returns true when the tier changed. */
  sample(frameMs: number, now: number): boolean {
    if (this.#locked) return false;

    this.#samples.push(frameMs);
    if (this.#samples.length < 90) return false;

    const sorted = [...this.#samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    // The 90th percentile catches hitching that the median hides.
    const p90 = sorted[Math.floor(sorted.length * 0.9)]!;
    this.#samples = [];

    if (now < this.#cooldown) return false;

    const index = ORDER.indexOf(this.#tier);

    // Below 45 FPS sustained, or badly spiky: step down.
    if ((median > 22 || p90 > 40) && index > 0) {
      this.#ceiling = this.#tier;
      this.#tier = ORDER[index - 1]!;
      this.#cooldown = now + 4000;
      return true;
    }

    // Comfortably above 60 FPS with headroom: step up, but never past a tier
    // that already failed.
    if (median < 11 && p90 < 16 && index < ORDER.length - 1) {
      const next = ORDER[index + 1]!;
      if (this.#ceiling !== null && ORDER.indexOf(next) >= ORDER.indexOf(this.#ceiling)) {
        return false;
      }
      this.#tier = next;
      this.#cooldown = now + 8000;
      return true;
    }

    return false;
  }

  setTier(tier: QualityTier, locked: boolean): void {
    this.#tier = tier;
    this.#locked = locked;
    this.#samples = [];
    this.#ceiling = null;
  }
}
