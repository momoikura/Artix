/**
 * Galaxy layout.
 *
 * Every position in Artix is *derived*, never random and never simulated. The
 * mapping is:
 *
 *   radius    ← age            recent work sits near the galactic core
 *   angle     ← project        each project owns an arm sector, so a project's
 *                              sessions form a coherent streak along one arm
 *   spiral    ← log(radius)    the winding term that turns sectors into arms
 *   height    ← deterministic  a thin disk with exponential falloff
 *   rotation  ← time           a rigid *pattern* rotation (density-wave model),
 *                              so arms never shear apart no matter how long the
 *                              app stays open
 *
 * CRITICAL: this file and `shaders/nodes.glsl.ts` implement the same formula
 * twice — once on the CPU for picking and labels, once on the GPU for
 * rendering. `LAYOUT` holds the shared constants and the two implementations
 * must be changed together. `layout.test.ts` pins the CPU side against known
 * values so a divergence is caught rather than silently misaligning hit-testing.
 */

import { hash32, rand01, randGaussian } from '../core/hash.ts';
import { DAY } from '../core/time.ts';
import { languageRgb } from '../core/languages.ts';
import { nodeRadius } from '../core/celestial.ts';
import type { GalaxyNode, SessionId } from '../core/types.ts';

export const LAYOUT = {
  /** Inner radius — nothing sits exactly on the core. */
  rMin: 9,
  /** Outer radius for the oldest session in the library. */
  rMax: 165,
  /** Log-spiral winding. Higher = tighter arms. */
  wind: 2.35,
  /** Number of major arms. Two is what most barred spirals actually have. */
  arms: 2,
  /** Disk half-thickness at the core, in world units. */
  zScatter: 5.2,
  /** Vertical falloff length — the disk flares slightly outward. */
  zScale: 95,
  /** Radians per second of rigid pattern rotation. Deliberately glacial. */
  patternSpeed: 0.0072,
  /** Epicyclic wobble amplitude, world units. */
  epicycle: 0.55,
  /** Age curve exponent. <1 spreads recent work out and compresses old work. */
  ageCurve: 0.62,
  /** Angular half-width of a project's sector, radians. */
  sectorSpread: 0.22,
} as const;

/** Packed, GPU-ready view of one node. */
export interface LayoutNode {
  id: SessionId;
  /** Days since the layout epoch. Float32-safe, unlike epoch milliseconds. */
  day: number;
  /** Base angle before the spiral and rotation terms. */
  angle: number;
  /** Vertical offset factor, multiplied by the radial falloff. */
  height: number;
  /** World-space draw radius. */
  size: number;
  /** 0..1 brightness. */
  brightness: number;
  /** Linear RGB. */
  color: readonly [number, number, number];
  /** Deterministic phase so epicycles are not all in lockstep. */
  phase: number;
  kind: GalaxyNode['kind'];
  pinned: boolean;
}

/** Time state shared by the CPU layout and the shader uniforms. */
export interface LayoutTime {
  /** The "present" of the galaxy, in days since epoch. Timeline scrubbing
   *  moves this, which is what makes the galaxy reorganise chronologically. */
  nowDay: number;
  /** Age span mapped across [rMin, rMax], in days. */
  spanDays: number;
  /** Seconds since the scene started, for the rotation term. */
  elapsed: number;
}

export const LAYOUT_EPOCH_MS = Date.UTC(2020, 0, 1);

export function toLayoutDay(timestampMs: number): number {
  return (timestampMs - LAYOUT_EPOCH_MS) / DAY;
}

export function fromLayoutDay(day: number): number {
  return day * DAY + LAYOUT_EPOCH_MS;
}

/**
 * Base angle for a project.
 *
 * The project hash selects an arm, then spreads sessions inside a narrow
 * sector around it. Two projects can share an arm — real galaxies are not
 * tidy — but they occupy different sectors, so clusters stay visually
 * separable while the overall structure remains a spiral rather than a
 * pie chart.
 */
export function projectAngle(project: string, id: string): number {
  const projectHash = hash32(project.toLowerCase());
  const arm = projectHash % LAYOUT.arms;
  const armAngle = (arm * 2 * Math.PI) / LAYOUT.arms;

  // Where within the arm this project sits (stable per project).
  const sectorOffset = ((projectHash >>> 8) / 0x1000000 - 0.5) * (2 * Math.PI) / LAYOUT.arms;

  // Where within the project's sector this session sits (stable per session).
  const jitter = (rand01(id, 1) - 0.5) * 2 * LAYOUT.sectorSpread;

  return armAngle + sectorOffset + jitter;
}

/** Build the packed layout record for a session. */
export function toLayoutNode(node: GalaxyNode): LayoutNode {
  const color = languageRgb(node.language);
  const size = nodeRadius(node.kind, node.complexity);

  return {
    id: node.id,
    day: toLayoutDay(node.startedAt),
    angle: projectAngle(node.project, node.id),
    // Gaussian scatter keeps the disk dense in the middle and wispy at the edge.
    height: randGaussian(node.id, 2) * LAYOUT.zScatter,
    size,
    brightness: node.importance,
    color,
    phase: rand01(node.id, 3) * Math.PI * 2,
    kind: node.kind,
    pinned: node.pinned,
  };
}

/* ------------------------------------------------------------- positioning */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Normalised age in 0..1. 0 = the galaxy's "now", 1 = `spanDays` old.
 * Sessions newer than `nowDay` (possible while scrubbing) clamp to 0.
 */
export function normalizedAge(day: number, time: LayoutTime): number {
  const age = (time.nowDay - day) / Math.max(1, time.spanDays);
  return age < 0 ? 0 : age > 1 ? 1 : age;
}

/** Orbital radius for a node at a given moment in the timeline. */
export function orbitRadius(day: number, time: LayoutTime): number {
  const age = normalizedAge(day, time);
  return LAYOUT.rMin + (LAYOUT.rMax - LAYOUT.rMin) * Math.pow(age, LAYOUT.ageCurve);
}

/**
 * World position of a node.
 *
 * MUST stay identical to `positionOf()` in `shaders/nodes.glsl.ts`.
 */
export function nodePosition(node: LayoutNode, time: LayoutTime, out?: Vec3): Vec3 {
  const r = orbitRadius(node.day, time);

  const theta =
    node.angle +
    LAYOUT.wind * Math.log(r / LAYOUT.rMin) +
    LAYOUT.patternSpeed * time.elapsed;

  // Epicycle: a small closed loop, not drift. Frequency scales with 1/sqrt(r)
  // so inner nodes wobble faster, matching orbital intuition.
  const omega = 0.35 / Math.sqrt(r / LAYOUT.rMin);
  const wobbleX = Math.cos(time.elapsed * omega + node.phase) * LAYOUT.epicycle;
  const wobbleY = Math.sin(time.elapsed * omega + node.phase) * LAYOUT.epicycle;

  const falloff = Math.exp(-r / LAYOUT.zScale);

  const target = out ?? { x: 0, y: 0, z: 0 };
  target.x = r * Math.cos(theta) + wobbleX;
  target.y = r * Math.sin(theta) + wobbleY;
  target.z = node.height * falloff;
  return target;
}

/**
 * Position with the time-dependent terms removed.
 *
 * The spatial index is built in this frame so it never needs rebuilding as the
 * galaxy rotates; picking inverse-rotates the query instead. Only a timeline
 * scrub (which changes radii) invalidates it.
 */
export function nodePositionStatic(node: LayoutNode, time: LayoutTime, out?: Vec3): Vec3 {
  return nodePosition(node, { ...time, elapsed: 0 }, out);
}

/** The rigid rotation applied to the whole galaxy at time `elapsed`. */
export function patternRotation(elapsed: number): number {
  return LAYOUT.patternSpeed * elapsed;
}

/**
 * Bounding radius of the populated disk, used to frame the initial camera and
 * to size the background elements.
 */
export function galaxyExtent(): number {
  return LAYOUT.rMax * 1.08;
}

/* --------------------------------------------------------------- packing */

/**
 * Interleave layout nodes into the typed arrays the renderer uploads.
 *
 * Separate arrays (rather than one interleaved buffer) because the visual
 * attributes — brightness, colour, size — are updated independently of
 * position when search highlights change, and partial updates on separate
 * buffers are cheaper than restriding one.
 */
export interface PackedGeometry {
  count: number;
  /** vec3 placeholder position; the shader recomputes the real position. */
  position: Float32Array;
  /** x = day, y = angle, z = height, w = phase */
  orbit: Float32Array;
  /** x = size, y = brightness, z = kind (0 star, 1 planet, 2 asteroid), w = pinned */
  traits: Float32Array;
  color: Float32Array;
  /** Per-node search highlight in 0..1, animated by the renderer. */
  highlight: Float32Array;
  ids: SessionId[];
}

const KIND_CODE = { star: 0, planet: 1, asteroid: 2 } as const;

export function packGeometry(nodes: readonly LayoutNode[]): PackedGeometry {
  const count = nodes.length;
  const packed: PackedGeometry = {
    count,
    position: new Float32Array(count * 3),
    orbit: new Float32Array(count * 4),
    traits: new Float32Array(count * 4),
    color: new Float32Array(count * 3),
    highlight: new Float32Array(count),
    ids: new Array(count),
  };

  for (let i = 0; i < count; i++) {
    const node = nodes[i]!;

    packed.orbit[i * 4 + 0] = node.day;
    packed.orbit[i * 4 + 1] = node.angle;
    packed.orbit[i * 4 + 2] = node.height;
    packed.orbit[i * 4 + 3] = node.phase;

    packed.traits[i * 4 + 0] = node.size;
    packed.traits[i * 4 + 1] = node.brightness;
    packed.traits[i * 4 + 2] = KIND_CODE[node.kind];
    packed.traits[i * 4 + 3] = node.pinned ? 1 : 0;

    packed.color[i * 3 + 0] = node.color[0];
    packed.color[i * 3 + 1] = node.color[1];
    packed.color[i * 3 + 2] = node.color[2];

    packed.ids[i] = node.id;
  }

  return packed;
}
