/**
 * Spatial index for hit-testing.
 *
 * The galaxy is a thin disk, so a uniform 2D hash grid over (x, y) is both
 * simpler and faster than an octree here — constant-time insertion, no
 * rebalancing, and a query touches a handful of cells.
 *
 * The index is built in *static* space (pattern rotation removed). Because the
 * rotation is rigid, picking inverse-rotates the query point rather than
 * rebuilding 100k entries every frame. Only a timeline scrub — which changes
 * radii — invalidates the index.
 */

import { nodePositionStatic, patternRotation } from './layout.ts';
import type { LayoutNode, LayoutTime, Vec3 } from './layout.ts';

export interface GridQueryResult {
  index: number;
  /** Squared distance from the query point, in world units. */
  distanceSq: number;
}

export class SpatialGrid {
  readonly #cellSize: number;
  readonly #cells = new Map<number, number[]>();
  /** Static-space positions, xyz interleaved. */
  #positions = new Float32Array(0);
  #count = 0;

  constructor(cellSize = 6) {
    this.#cellSize = cellSize;
  }

  get count(): number {
    return this.#count;
  }

  /** Static-space position of node `index`, written into `out`. */
  positionAt(index: number, out: Vec3): Vec3 {
    out.x = this.#positions[index * 3] ?? 0;
    out.y = this.#positions[index * 3 + 1] ?? 0;
    out.z = this.#positions[index * 3 + 2] ?? 0;
    return out;
  }

  rebuild(nodes: readonly LayoutNode[], time: LayoutTime): void {
    this.#cells.clear();
    this.#count = nodes.length;
    this.#positions = new Float32Array(nodes.length * 3);

    const scratch: Vec3 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < nodes.length; i++) {
      nodePositionStatic(nodes[i]!, time, scratch);
      this.#positions[i * 3] = scratch.x;
      this.#positions[i * 3 + 1] = scratch.y;
      this.#positions[i * 3 + 2] = scratch.z;

      const key = this.#key(scratch.x, scratch.y);
      const bucket = this.#cells.get(key);
      if (bucket) bucket.push(i);
      else this.#cells.set(key, [i]);
    }
  }

  /**
   * Nodes within `radius` of a *world-space* point at time `elapsed`.
   * The point is inverse-rotated into static space before querying.
   */
  query(x: number, y: number, radius: number, elapsed: number, limit = 64): GridQueryResult[] {
    const angle = -patternRotation(elapsed);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const qx = x * cos - y * sin;
    const qy = x * sin + y * cos;

    const cellRadius = Math.ceil(radius / this.#cellSize);
    const cx = Math.floor(qx / this.#cellSize);
    const cy = Math.floor(qy / this.#cellSize);
    const radiusSq = radius * radius;

    const out: GridQueryResult[] = [];

    for (let dy = -cellRadius; dy <= cellRadius; dy++) {
      for (let dx = -cellRadius; dx <= cellRadius; dx++) {
        const bucket = this.#cells.get(this.#keyFromCell(cx + dx, cy + dy));
        if (!bucket) continue;

        for (const index of bucket) {
          const px = this.#positions[index * 3]! - qx;
          const py = this.#positions[index * 3 + 1]! - qy;
          const distanceSq = px * px + py * py;
          if (distanceSq <= radiusSq) out.push({ index, distanceSq });
        }
      }
    }

    out.sort((a, b) => a.distanceSq - b.distanceSq);
    return out.length > limit ? out.slice(0, limit) : out;
  }

  /** Every node inside an axis-aligned world rectangle. Used by box-select. */
  queryRect(minX: number, minY: number, maxX: number, maxY: number, elapsed: number): number[] {
    const angle = -patternRotation(elapsed);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // The rotated rectangle is not axis-aligned in static space, so widen to
    // its bounding box and filter precisely afterwards.
    const corners = [
      [minX, minY],
      [maxX, minY],
      [minX, maxY],
      [maxX, maxY],
    ].map(([x, y]) => [x! * cos - y! * sin, x! * sin + y! * cos] as const);

    const sx = Math.min(...corners.map((c) => c[0]));
    const sy = Math.min(...corners.map((c) => c[1]));
    const ex = Math.max(...corners.map((c) => c[0]));
    const ey = Math.max(...corners.map((c) => c[1]));

    const out: number[] = [];
    const c0 = Math.floor(sx / this.#cellSize);
    const c1 = Math.floor(ex / this.#cellSize);
    const r0 = Math.floor(sy / this.#cellSize);
    const r1 = Math.floor(ey / this.#cellSize);

    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const bucket = this.#cells.get(this.#keyFromCell(cx, cy));
        if (!bucket) continue;
        for (const index of bucket) {
          const px = this.#positions[index * 3]!;
          const py = this.#positions[index * 3 + 1]!;
          // Rotate back into world space for the precise test.
          const wx = px * cos + py * sin;
          const wy = -px * sin + py * cos;
          if (wx >= minX && wx <= maxX && wy >= minY && wy <= maxY) out.push(index);
        }
      }
    }
    return out;
  }

  #key(x: number, y: number): number {
    return this.#keyFromCell(Math.floor(x / this.#cellSize), Math.floor(y / this.#cellSize));
  }

  /**
   * Pack two signed cell coordinates into one number key.
   *
   * Cells are offset into the positive range and packed into 32 bits, which is
   * exact for |coord| < 32768 — far beyond the galaxy's extent.
   */
  #keyFromCell(cx: number, cy: number): number {
    return ((cx + 32768) << 16) | ((cy + 32768) & 0xffff);
  }
}
