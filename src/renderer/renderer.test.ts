import { describe, expect, it } from 'vitest';

import { DAY } from '../core/time.ts';
import {
  LAYOUT,
  LAYOUT_EPOCH_MS,
  galaxyExtent,
  nodePosition,
  normalizedAge,
  orbitRadius,
  packGeometry,
  patternRotation,
  projectAngle,
  toLayoutDay,
  toLayoutNode,
} from './layout.ts';
import { layoutDefines } from './shaders/nodes.glsl.ts';
import { SpatialGrid } from './spatial-index.ts';
import { AdaptiveQuality, QUALITY_PROFILES } from './quality.ts';
import type { LayoutTime } from './layout.ts';
import type { GalaxyNode, SessionId } from '../core/types.ts';

const NOW = Date.UTC(2026, 6, 22);
const TIME: LayoutTime = { nowDay: toLayoutDay(NOW), spanDays: 730, elapsed: 0 };

function node(overrides: Partial<GalaxyNode> = {}): GalaxyNode {
  return {
    id: 'S1' as SessionId,
    title: 'Session',
    project: 'artix',
    language: 'typescript',
    status: 'completed',
    kind: 'star',
    startedAt: NOW,
    complexity: 0.5,
    importance: 0.5,
    pinned: false,
    technologies: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------ layout math */

describe('galaxy layout', () => {
  it('is deterministic — the same session always lands in the same place', () => {
    const a = nodePosition(toLayoutNode(node()), TIME);
    const b = nodePosition(toLayoutNode(node()), TIME);
    expect(a).toEqual(b);
  });

  it('places recent work near the core and old work at the rim', () => {
    const recent = orbitRadius(toLayoutDay(NOW), TIME);
    const old = orbitRadius(toLayoutDay(NOW - 700 * DAY), TIME);
    expect(recent).toBeCloseTo(LAYOUT.rMin, 5);
    expect(old).toBeGreaterThan(recent);
    expect(old).toBeLessThanOrEqual(LAYOUT.rMax);
  });

  it('clamps ages outside the span rather than flying off the disk', () => {
    // Newer than "now" (possible mid-scrub) and far older than the span.
    expect(normalizedAge(TIME.nowDay + 50, TIME)).toBe(0);
    expect(normalizedAge(TIME.nowDay - 99_999, TIME)).toBe(1);
    expect(orbitRadius(TIME.nowDay - 99_999, TIME)).toBeCloseTo(LAYOUT.rMax, 5);
  });

  it('keeps every node inside the stated extent', () => {
    const extent = galaxyExtent();
    for (let i = 0; i < 400; i++) {
      const layout = toLayoutNode(
        node({ id: `S${i}` as SessionId, project: `p${i % 11}`, startedAt: NOW - i * DAY }),
      );
      const position = nodePosition(layout, { ...TIME, elapsed: i * 7 });
      expect(Math.hypot(position.x, position.y)).toBeLessThanOrEqual(extent + LAYOUT.epicycle + 1);
    }
  });

  it('groups a project into a coherent angular sector', () => {
    const angles = Array.from({ length: 40 }, (_, i) =>
      projectAngle('artix', `session-${i}`),
    );
    const spread = Math.max(...angles) - Math.min(...angles);
    // Within one project, jitter must stay inside the sector width.
    expect(spread).toBeLessThanOrEqual(2 * LAYOUT.sectorSpread + 1e-9);
  });

  it('separates different projects', () => {
    const a = projectAngle('artix', 'x');
    const b = projectAngle('orbital-api', 'x');
    expect(a).not.toBeCloseTo(b, 3);
  });

  it('rotates rigidly, so arms never shear apart', () => {
    const layout = toLayoutNode(node());
    const t0 = nodePosition(layout, { ...TIME, elapsed: 0 });
    const t1 = nodePosition(layout, { ...TIME, elapsed: 100 });

    // Radius is preserved (epicycle aside) — a rigid rotation, not a spiral drift.
    const r0 = Math.hypot(t0.x, t0.y);
    const r1 = Math.hypot(t1.x, t1.y);
    expect(Math.abs(r1 - r0)).toBeLessThanOrEqual(2 * LAYOUT.epicycle + 1e-6);

    expect(patternRotation(100)).toBeCloseTo(LAYOUT.patternSpeed * 100, 10);
  });

  it('keeps the disk thin', () => {
    for (let i = 0; i < 200; i++) {
      const layout = toLayoutNode(node({ id: `Z${i}` as SessionId, startedAt: NOW - i * 3 * DAY }));
      const position = nodePosition(layout, TIME);
      expect(Math.abs(position.z)).toBeLessThan(LAYOUT.zScatter * 3);
    }
  });

  it('converts timestamps to float32-safe day numbers', () => {
    const day = toLayoutDay(NOW);
    expect(day).toBeGreaterThan(0);
    expect(day).toBeLessThan(20_000);
    expect(Math.fround(day)).toBeCloseTo(day, 3);
    expect(toLayoutDay(LAYOUT_EPOCH_MS)).toBe(0);
  });
});

/**
 * The layout formula exists twice — once in TypeScript for picking, once in
 * GLSL for rendering. If they diverge, hit-testing silently targets the wrong
 * stars. The constants are injected into the shader from `LAYOUT`, so this test
 * pins that injection.
 */
describe('CPU/GPU layout parity', () => {
  const defines = layoutDefines();

  it('injects every layout constant the shader uses', () => {
    const expected: [string, number][] = [
      ['R_MIN', LAYOUT.rMin],
      ['R_MAX', LAYOUT.rMax],
      ['WIND', LAYOUT.wind],
      ['Z_SCALE', LAYOUT.zScale],
      ['PATTERN_SPEED', LAYOUT.patternSpeed],
      ['EPICYCLE', LAYOUT.epicycle],
      ['AGE_CURVE', LAYOUT.ageCurve],
    ];

    for (const [name, value] of expected) {
      const match = new RegExp(`#define ${name} ([0-9.]+)`).exec(defines);
      expect(match, `missing #define ${name}`).not.toBeNull();
      expect(Number(match![1])).toBe(value);
    }
  });

  it('emits GLSL-valid float literals', () => {
    // `#define R_MIN 9` would make integer division in the shader; it must be `9.0`.
    for (const line of defines.split('\n')) {
      const value = line.split(' ')[2]!;
      expect(value, line).toMatch(/^\d+\.\d+$/);
    }
  });
});

/* ---------------------------------------------------------------- packing */

describe('geometry packing', () => {
  it('packs attributes into correctly sized typed arrays', () => {
    const nodes = Array.from({ length: 7 }, (_, i) =>
      toLayoutNode(node({ id: `P${i}` as SessionId })),
    );
    const packed = packGeometry(nodes);

    expect(packed.count).toBe(7);
    expect(packed.orbit).toHaveLength(28);
    expect(packed.traits).toHaveLength(28);
    expect(packed.color).toHaveLength(21);
    expect(packed.highlight).toHaveLength(7);
    expect(packed.ids).toHaveLength(7);
  });

  it('encodes kind and pinned flags', () => {
    const packed = packGeometry([
      toLayoutNode(node({ id: 'A' as SessionId, kind: 'star', pinned: true })),
      toLayoutNode(node({ id: 'B' as SessionId, kind: 'asteroid', pinned: false })),
    ]);
    expect(packed.traits[2]).toBe(0); // star
    expect(packed.traits[3]).toBe(1); // pinned
    expect(packed.traits[6]).toBe(2); // asteroid
    expect(packed.traits[7]).toBe(0);
  });
});

/* ---------------------------------------------------------- spatial index */

describe('spatial grid', () => {
  const nodes = Array.from({ length: 500 }, (_, i) =>
    toLayoutNode(node({ id: `G${i}` as SessionId, project: `p${i % 9}`, startedAt: NOW - i * 2 * DAY })),
  );

  const grid = new SpatialGrid(7);
  grid.rebuild(nodes, TIME);

  it('indexes every node', () => {
    expect(grid.count).toBe(500);
  });

  it('finds a node at its own position', () => {
    const target = nodes[42]!;
    const position = nodePosition(target, TIME);
    const results = grid.query(position.x, position.y, 2, 0);
    expect(results.some((r) => r.index === 42)).toBe(true);
  });

  it('returns results ordered by distance', () => {
    const position = nodePosition(nodes[10]!, TIME);
    const results = grid.query(position.x, position.y, 40, 0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.distanceSq).toBeGreaterThanOrEqual(results[i - 1]!.distanceSq);
    }
  });

  it('stays correct as the galaxy rotates, without a rebuild', () => {
    // The index is built in static space; queries inverse-rotate instead.
    const elapsed = 900;
    const target = nodes[7]!;
    const rotated = nodePosition(target, { ...TIME, elapsed });
    const results = grid.query(rotated.x, rotated.y, 3, elapsed);
    expect(results.some((r) => r.index === 7)).toBe(true);
  });

  it('finds nothing far outside the disk', () => {
    expect(grid.query(50_000, 50_000, 5, 0)).toHaveLength(0);
  });

  it('selects nodes inside a world rectangle', () => {
    const position = nodePosition(nodes[3]!, TIME);
    const found = grid.queryRect(position.x - 1, position.y - 1, position.x + 1, position.y + 1, 0);
    expect(found).toContain(3);
  });
});

/* -------------------------------------------------------------- quality */

describe('adaptive quality', () => {
  it('does nothing while locked', () => {
    const quality = new AdaptiveQuality('high', false);
    for (let i = 0; i < 200; i++) quality.sample(80, i * 80);
    expect(quality.tier).toBe('high');
  });

  it('steps down when frames are consistently slow', () => {
    const quality = new AdaptiveQuality('high', true);
    let changed = false;
    for (let i = 0; i < 120; i++) changed = quality.sample(40, 10_000 + i * 40) || changed;
    expect(changed).toBe(true);
    expect(quality.tier).toBe('medium');
  });

  it('never climbs back to a tier that already failed', () => {
    const quality = new AdaptiveQuality('high', true);
    for (let i = 0; i < 120; i++) quality.sample(40, 10_000 + i * 40); // fails 'high'
    expect(quality.tier).toBe('medium');

    // Now report excellent frames well past the cooldown.
    for (let i = 0; i < 400; i++) quality.sample(6, 100_000 + i * 6);
    expect(quality.tier).toBe('medium');
  });

  it('orders profiles by cost', () => {
    expect(QUALITY_PROFILES.low.dustCount).toBeLessThan(QUALITY_PROFILES.ultra.dustCount);
    expect(QUALITY_PROFILES.low.bloom).toBe(false);
    expect(QUALITY_PROFILES.ultra.nebulaOctaves).toBeGreaterThan(QUALITY_PROFILES.medium.nebulaOctaves);
  });
});
