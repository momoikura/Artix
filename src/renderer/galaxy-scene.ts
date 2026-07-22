/**
 * The galaxy renderer.
 *
 * One `THREE.Points` draw call renders every session. All motion — orbital
 * rotation, epicycles, timeline reorganisation, search pulses — is computed in
 * the vertex shader from static attributes plus a handful of uniforms. The CPU
 * uploads geometry once and then does almost nothing per frame, which is the
 * entire reason 100k+ nodes hold 60 FPS.
 *
 * Layering, back to front:
 *   nebula (fullscreen ray-marched-ish backdrop)
 *   deep starfield
 *   core glow
 *   dust motes
 *   session nodes
 *   selection / hover rings
 *   → bloom
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import { rand01 } from '../core/hash.ts';
import { CameraRig } from './camera-rig.ts';
import { AdaptiveQuality, QUALITY_PROFILES } from './quality.ts';
import { SpatialGrid } from './spatial-index.ts';
import {
  LAYOUT,
  galaxyExtent,
  nodePosition,
  orbitRadius,
  packGeometry,
  toLayoutDay,
  toLayoutNode,
} from './layout.ts';
import { NODE_FRAGMENT, NODE_VERTEX, RING_FRAGMENT, RING_VERTEX } from './shaders/nodes.glsl.ts';
import {
  CORE_FRAGMENT,
  CORE_VERTEX,
  DUST_FRAGMENT,
  DUST_VERTEX,
  NEBULA_FRAGMENT,
  NEBULA_VERTEX,
  STARFIELD_FRAGMENT,
  STARFIELD_VERTEX,
} from './shaders/background.glsl.ts';
import type { LayoutNode, LayoutTime, PackedGeometry } from './layout.ts';
import type { QualityTier } from './quality.ts';
import type { GalaxyNode, SessionId } from '../core/types.ts';

/** A label the React overlay should draw, in CSS pixels. */
export interface ScreenLabel {
  id: SessionId;
  x: number;
  y: number;
  /** 0..1 — drives opacity so labels fade in rather than pop. */
  weight: number;
  /** Screen-space radius of the node, for offsetting the label. */
  radius: number;
}

export interface GalaxyCallbacks {
  onHover?: (id: SessionId | null, screen: { x: number; y: number } | null) => void;
  onSelect?: (id: SessionId | null) => void;
  onOpen?: (id: SessionId) => void;
  onContextMenu?: (id: SessionId | null, screen: { x: number; y: number }) => void;
  onLabels?: (labels: ScreenLabel[]) => void;
  onQualityChange?: (tier: QualityTier) => void;
  onFrame?: (fps: number) => void;
}

export interface GalaxyOptions {
  quality: QualityTier | 'auto';
  motion: boolean;
  motionSpeed: number;
  labels: boolean;
  labelBudget: number;
  bloom: boolean;
  nebula: boolean;
  dust: boolean;
  depthOfField: boolean;
}

const DEFAULT_OPTIONS: GalaxyOptions = {
  quality: 'auto',
  motion: true,
  motionSpeed: 1,
  labels: true,
  labelBudget: 40,
  bloom: true,
  nebula: true,
  dust: true,
  depthOfField: true,
};

/** Palette. Deliberately narrow — this is a night sky, not a disco. */
const PALETTE = {
  nebulaA: new Color(0x1b2f5e),
  nebulaB: new Color(0x3a2a6b),
  deepField: new Color(0x04060f),
  coreInner: new Color(0xfff2d8),
  coreOuter: new Color(0x5f7fd8),
  highlight: new Color(0x7fd4ff),
  selection: new Color(0x8ae0ff),
  hover: new Color(0xffffff),
};

export class GalaxyScene {
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: WebGLRenderer;
  readonly #scene = new Scene();
  readonly #camera: PerspectiveCamera;
  readonly #rig: CameraRig;
  readonly #grid = new SpatialGrid(7);
  readonly #quality: AdaptiveQuality;
  readonly #callbacks: GalaxyCallbacks;

  #composer: EffectComposer | null = null;
  #bloomPass: UnrealBloomPass | null = null;

  /* --- scene objects --- */
  #nodes: Points | null = null;
  #nodeMaterial: ShaderMaterial | null = null;
  #nebula: Mesh | null = null;
  #starfield: Points | null = null;
  #dust: Points | null = null;
  #coreGlow: Mesh | null = null;
  #selectionRing: Mesh | null = null;
  #hoverRing: Mesh | null = null;

  /* --- data --- */
  #layoutNodes: LayoutNode[] = [];
  #packed: PackedGeometry | null = null;
  #indexById = new Map<SessionId, number>();
  #highlightTarget: Float32Array = new Float32Array(0);
  #highlightAnimating = false;

  /* --- state --- */
  #options: GalaxyOptions = { ...DEFAULT_OPTIONS };
  #time: LayoutTime = { nowDay: 0, spanDays: 730, elapsed: 0 };
  #timeWindow: [number, number] = [-1e9, 1e9];
  #searchActive = false;
  #selectedId: SessionId | null = null;
  #hoverId: SessionId | null = null;

  #running = false;
  #frameHandle = 0;
  #lastFrameTime = 0;
  #lastLabelUpdate = 0;
  #fpsAccumulator = 0;
  #fpsFrames = 0;
  #disposed = false;

  /* --- scratch (the render loop must not allocate) --- */
  readonly #scratchVec = new Vector3();
  readonly #scratchVec2 = new Vector3();
  readonly #inverseProjection = new Matrix4();
  readonly #inverseView = new Matrix4();

  constructor(canvas: HTMLCanvasElement, callbacks: GalaxyCallbacks = {}, options: Partial<GalaxyOptions> = {}) {
    this.#canvas = canvas;
    this.#callbacks = callbacks;
    this.#options = { ...DEFAULT_OPTIONS, ...options };

    this.#renderer = new WebGLRenderer({
      canvas,
      antialias: false, // bloom + point sprites; MSAA buys nothing here
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.#renderer.setClearColor(0x03040a, 1);
    this.#renderer.autoClear = true;

    this.#camera = new PerspectiveCamera(48, 1, 0.5, 4000);
    this.#camera.up.set(0, 0, 1);

    const extent = galaxyExtent();
    this.#rig = new CameraRig(
      { distance: extent * 1.85, polar: 0.62, azimuth: -Math.PI / 2 },
      { minDistance: 4, maxDistance: extent * 5 },
    );

    const initialTier =
      this.#options.quality === 'auto' ? detectInitialTier() : this.#options.quality;
    this.#quality = new AdaptiveQuality(initialTier, this.#options.quality === 'auto');

    this.#buildBackground();
    this.#buildRings();
    this.#buildComposer();
    this.resize();
  }

  get camera(): PerspectiveCamera {
    return this.#camera;
  }

  get rig(): CameraRig {
    return this.#rig;
  }

  get qualityTier(): QualityTier {
    return this.#quality.tier;
  }

  /* ------------------------------------------------------------------ data */

  /**
   * Replace the entire node set.
   *
   * Geometry is rebuilt from scratch — with typed arrays this is a few
   * milliseconds even at 100k, and it keeps the data path simple. Incremental
   * updates go through `setHighlight`, which only touches one attribute.
   */
  setNodes(nodes: readonly GalaxyNode[]): void {
    this.#layoutNodes = nodes.map(toLayoutNode);
    this.#packed = packGeometry(this.#layoutNodes);
    this.#highlightTarget = new Float32Array(this.#packed.count);

    this.#indexById.clear();
    for (let i = 0; i < this.#packed.ids.length; i++) {
      this.#indexById.set(this.#packed.ids[i]!, i);
    }

    this.#resolveTimeRange(nodes);
    this.#grid.rebuild(this.#layoutNodes, this.#time);
    this.#buildNodeObject();
    this.#tuneCoreGlow();
  }

  /**
   * Scale the bulge with the population of the inner disk.
   *
   * A galactic bulge is bright because it is *dense with stars*. Rendering it
   * at full intensity over an empty library produced a blown-out white disc
   * that swamped the only node on screen — visually wrong and, worse,
   * physically backwards. The glow now grows with the number of nodes near the
   * core and stays dark until there is something there to light it.
   */
  #tuneCoreGlow(): void {
    if (!this.#coreGlow) return;

    // Count nodes in the inner third of the disk, where a bulge would form.
    const innerLimit = LAYOUT.rMin + (LAYOUT.rMax - LAYOUT.rMin) * 0.33;
    let inner = 0;
    for (const node of this.#layoutNodes) {
      if (orbitRadius(node.day, this.#time) <= innerLimit) inner++;
    }

    // Saturating: a handful of sessions gives a faint core, hundreds saturate it.
    const density = inner / (inner + 60);
    const material = this.#coreGlow.material as ShaderMaterial;
    material.uniforms.uIntensity!.value = 0.05 + density * 0.95;
    this.#coreGlow.visible = this.#quality.profile.coreGlow && this.#layoutNodes.length > 0;
  }

  /** Derive the timeline span from the data so the disk is always well-filled. */
  #resolveTimeRange(nodes: readonly GalaxyNode[]): void {
    if (nodes.length === 0) {
      this.#time = { ...this.#time, nowDay: toLayoutDay(Date.now()), spanDays: 730 };
      this.#timeWindow = [-1e9, 1e9];
      return;
    }

    let earliest = Infinity;
    let latest = -Infinity;
    for (const node of nodes) {
      if (node.startedAt < earliest) earliest = node.startedAt;
      if (node.startedAt > latest) latest = node.startedAt;
    }

    const nowDay = toLayoutDay(Math.max(latest, Date.now()));
    const oldestDay = toLayoutDay(earliest);
    // A little headroom so the oldest session is not pinned to the exact rim.
    const spanDays = Math.max(30, (nowDay - oldestDay) * 1.06);

    this.#time = { ...this.#time, nowDay, spanDays };
    this.#timeWindow = [oldestDay - 1, nowDay + 1];
  }

  #buildNodeObject(): void {
    const packed = this.#packed;
    if (!packed) return;

    this.#disposeNodes();

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(packed.position, 3));
    geometry.setAttribute('aOrbit', new BufferAttribute(packed.orbit, 4));
    geometry.setAttribute('aTraits', new BufferAttribute(packed.traits, 4));
    geometry.setAttribute('aColor', new BufferAttribute(packed.color, 3));

    const highlight = new BufferAttribute(packed.highlight, 1);
    highlight.setUsage(35048 /* DynamicDrawUsage */);
    geometry.setAttribute('aHighlight', highlight);

    // Positions are computed in the shader, so the bounding sphere from the
    // placeholder attribute is meaningless — cull manually (i.e. never).
    geometry.boundingSphere = null;

    const material = new ShaderMaterial({
      vertexShader: NODE_VERTEX,
      fragmentShader: NODE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      uniforms: {
        uNowDay: { value: this.#time.nowDay },
        uSpanDays: { value: this.#time.spanDays },
        uElapsed: { value: 0 },
        uPixelRatio: { value: this.#renderer.getPixelRatio() },
        uSizeScale: { value: 600 },
        uMinPointSize: { value: 1.0 },
        uMaxPointSize: { value: 190 },
        uFocusDistance: { value: this.#rig.focusDistance },
        uAperture: { value: 0 },
        uSearchActive: { value: 0 },
        uDimAmount: { value: 0.86 },
        uTimeWindow: { value: new Vector2(this.#timeWindow[0], this.#timeWindow[1]) },
        uTimeFeather: { value: 24 },
        uHighlightColor: { value: PALETTE.highlight },
      },
    });

    const points = new Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 10;

    this.#scene.add(points);
    this.#nodes = points;
    this.#nodeMaterial = material;
  }

  /* ----------------------------------------------------------- background */

  #buildBackground(): void {
    // --- nebula: a fullscreen triangle in clip space -----------------------
    const nebulaGeometry = new BufferGeometry();
    nebulaGeometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );

    const nebulaMaterial = new ShaderMaterial({
      vertexShader: NEBULA_VERTEX,
      fragmentShader: NEBULA_FRAGMENT,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uInverseProjection: { value: new Matrix4() },
        uInverseView: { value: new Matrix4() },
        uElapsed: { value: 0 },
        uIntensity: { value: 0.85 },
        uOctaves: { value: 5 },
        uColorA: { value: PALETTE.nebulaA },
        uColorB: { value: PALETTE.nebulaB },
        uColorC: { value: PALETTE.deepField },
      },
    });

    this.#nebula = new Mesh(nebulaGeometry, nebulaMaterial);
    this.#nebula.frustumCulled = false;
    this.#nebula.renderOrder = -1000;
    this.#scene.add(this.#nebula);

    // --- core glow ---------------------------------------------------------
    const coreMaterial = new ShaderMaterial({
      vertexShader: CORE_VERTEX,
      fragmentShader: CORE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uElapsed: { value: 0 },
        uIntensity: { value: 0.9 },
        uInner: { value: PALETTE.coreInner },
        uOuter: { value: PALETTE.coreOuter },
      },
    });
    this.#coreGlow = new Mesh(new PlaneGeometry(LAYOUT.rMin * 7.5, LAYOUT.rMin * 7.5), coreMaterial);
    this.#coreGlow.renderOrder = 5;
    this.#scene.add(this.#coreGlow);

    this.#rebuildStarfield(QUALITY_PROFILES[this.#quality.tier].starCount);
    this.#rebuildDust(QUALITY_PROFILES[this.#quality.tier].dustCount);
  }

  #rebuildStarfield(count: number): void {
    if (this.#starfield) {
      this.#scene.remove(this.#starfield);
      this.#starfield.geometry.dispose();
      (this.#starfield.material as ShaderMaterial).dispose();
      this.#starfield = null;
    }
    if (count <= 0) return;

    const positions = new Float32Array(count * 3);
    const magnitude = new Float32Array(count);
    const twinkle = new Float32Array(count);
    const radius = galaxyExtent() * 9;

    for (let i = 0; i < count; i++) {
      const key = `star:${i}`;
      // Uniform on a sphere: acos of a uniform variable, not a uniform angle.
      const u = rand01(key, 1) * 2 - 1;
      const theta = rand01(key, 2) * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);

      positions[i * 3] = radius * s * Math.cos(theta);
      positions[i * 3 + 1] = radius * s * Math.sin(theta);
      positions[i * 3 + 2] = radius * u;

      // Steep power law: many faint stars, few bright ones, as in reality.
      magnitude[i] = Math.pow(rand01(key, 3), 3.4);
      twinkle[i] = rand01(key, 4);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aMagnitude', new BufferAttribute(magnitude, 1));
    geometry.setAttribute('aTwinkle', new BufferAttribute(twinkle, 1));

    const material = new ShaderMaterial({
      vertexShader: STARFIELD_VERTEX,
      fragmentShader: STARFIELD_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uElapsed: { value: 0 },
        uPixelRatio: { value: this.#renderer.getPixelRatio() },
        uSizeScale: { value: 1 },
      },
    });

    this.#starfield = new Points(geometry, material);
    this.#starfield.frustumCulled = false;
    this.#starfield.renderOrder = -900;
    this.#scene.add(this.#starfield);
  }

  #rebuildDust(count: number): void {
    if (this.#dust) {
      this.#scene.remove(this.#dust);
      this.#dust.geometry.dispose();
      (this.#dust.material as ShaderMaterial).dispose();
      this.#dust = null;
    }
    if (count <= 0) return;

    const positions = new Float32Array(count * 3);
    const drift = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const key = `dust:${i}`;
      // Distribute by area so density is even across the disk, not clumped at
      // the centre the way a uniform radius would be.
      const r = LAYOUT.rMin + Math.sqrt(rand01(key, 1)) * (LAYOUT.rMax * 1.15 - LAYOUT.rMin);
      const theta = rand01(key, 2) * Math.PI * 2;
      const z = (rand01(key, 3) - 0.5) * LAYOUT.zScatter * 3.4 * Math.exp(-r / LAYOUT.zScale);

      positions[i * 3] = r * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(theta);
      positions[i * 3 + 2] = z;
      drift[i] = rand01(key, 4);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aDrift', new BufferAttribute(drift, 1));

    const material = new ShaderMaterial({
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uElapsed: { value: 0 },
        uPixelRatio: { value: this.#renderer.getPixelRatio() },
        uSizeScale: { value: 600 },
        uMotion: { value: 1 },
      },
    });

    this.#dust = new Points(geometry, material);
    this.#dust.frustumCulled = false;
    this.#dust.renderOrder = 8;
    this.#scene.add(this.#dust);
  }

  #buildRings(): void {
    const make = (color: Color) => {
      const material = new ShaderMaterial({
        vertexShader: RING_VERTEX,
        fragmentShader: RING_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: AdditiveBlending,
        side: DoubleSide,
        uniforms: {
          uColor: { value: color },
          uOpacity: { value: 0 },
          uElapsed: { value: 0 },
          uThickness: { value: 0.08 },
        },
      });
      const mesh = new Mesh(new PlaneGeometry(1, 1), material);
      mesh.renderOrder = 50;
      mesh.visible = false;
      this.#scene.add(mesh);
      return mesh;
    };

    this.#selectionRing = make(PALETTE.selection);
    this.#hoverRing = make(PALETTE.hover);
  }

  #buildComposer(): void {
    this.#composer?.dispose();

    const size = this.#renderer.getSize(new Vector2());
    const composer = new EffectComposer(this.#renderer);
    composer.addPass(new RenderPass(this.#scene, this.#camera));

    const profile = this.#quality.profile;
    if (profile.bloom && this.#options.bloom) {
      const bloom = new UnrealBloomPass(
        new Vector2(size.x, size.y),
        profile.bloomStrength,
        profile.bloomRadius,
        profile.bloomThreshold,
      );
      composer.addPass(bloom);
      this.#bloomPass = bloom;
    } else {
      this.#bloomPass = null;
    }

    this.#composer = composer;
    composer.setSize(size.x, size.y);
    composer.setPixelRatio(this.#renderer.getPixelRatio());
  }

  /* --------------------------------------------------------------- options */

  setOptions(options: Partial<GalaxyOptions>): void {
    const previous = this.#options;
    this.#options = { ...previous, ...options };

    if (options.quality !== undefined && options.quality !== previous.quality) {
      if (options.quality === 'auto') {
        this.#quality.setTier(detectInitialTier(), true);
      } else {
        this.#quality.setTier(options.quality, true);
      }
      this.#applyQualityProfile();
      return;
    }

    // Toggles that do not change the tier still need their objects updated.
    if (options.bloom !== undefined && options.bloom !== previous.bloom) this.#buildComposer();
    if (options.nebula !== undefined && this.#nebula) {
      this.#nebula.visible = options.nebula && this.#quality.profile.nebula;
    }
    if (options.dust !== undefined) {
      this.#rebuildDust(options.dust ? this.#quality.profile.dustCount : 0);
    }
  }

  #applyQualityProfile(): void {
    const profile = this.#quality.profile;

    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, profile.maxPixelRatio));
    this.#rebuildStarfield(profile.starCount);
    this.#rebuildDust(this.#options.dust ? profile.dustCount : 0);
    if (this.#nebula) this.#nebula.visible = profile.nebula && this.#options.nebula;
    this.#tuneCoreGlow();

    this.#updateNebulaUniform('uOctaves', profile.nebulaOctaves);
    this.#buildComposer();
    this.resize();

    this.#callbacks.onQualityChange?.(profile.tier);
  }

  #updateNebulaUniform(name: string, value: unknown): void {
    const material = this.#nebula?.material as ShaderMaterial | undefined;
    const uniform = material?.uniforms[name];
    if (uniform) uniform.value = value;
  }

  /* --------------------------------------------------------- interaction */

  setSelected(id: SessionId | null): void {
    this.#selectedId = id;
  }

  setHovered(id: SessionId | null): void {
    this.#hoverId = id;
  }

  /**
   * Highlight a set of nodes (search results). Non-matching nodes dim rather
   * than disappear, so the user keeps their spatial bearings.
   */
  setHighlight(ids: ReadonlySet<SessionId> | null): void {
    if (!this.#packed) return;

    this.#searchActive = ids !== null;
    const target = this.#highlightTarget;

    if (ids === null) {
      target.fill(0);
    } else {
      target.fill(0);
      for (const id of ids) {
        const index = this.#indexById.get(id);
        if (index !== undefined) target[index] = 1;
      }
    }
    this.#highlightAnimating = true;
  }

  /** Restrict the visible timeline. Nodes outside fade out smoothly. */
  setTimeWindow(fromMs: number | null, toMs: number | null): void {
    this.#timeWindow = [
      fromMs === null ? -1e9 : toLayoutDay(fromMs),
      toMs === null ? 1e9 : toLayoutDay(toMs),
    ];
  }

  /**
   * Move the galaxy's "present". Radii are recomputed in the shader, so the
   * whole galaxy reorganises chronologically for free — but the spatial index
   * is in radius space and must be rebuilt for picking to stay correct.
   */
  setNow(nowMs: number): void {
    this.#time = { ...this.#time, nowDay: toLayoutDay(nowMs) };
    this.#grid.rebuild(this.#layoutNodes, this.#time);
  }

  /** Fly the camera to a node. The signature interaction. */
  focusOn(id: SessionId, options: { immediate?: boolean; distance?: number } = {}): boolean {
    const index = this.#indexById.get(id);
    if (index === undefined) return false;

    const node = this.#layoutNodes[index]!;
    nodePosition(node, this.#time, this.#scratchVec);
    const target = new Vector3(this.#scratchVec.x, this.#scratchVec.y, this.#scratchVec.z);

    // Frame the star so it fills a comfortable fraction of the view rather than
    // using a fixed distance — a big star and a small one should both read well.
    const distance = options.distance ?? Math.max(6, node.size * 26);

    if (options.immediate) {
      this.#rig.cancelFlight();
      this.#rig.desired.target.copy(target);
      this.#rig.current.target.copy(target);
      this.#rig.desired.distance = distance;
      this.#rig.current.distance = distance;
    } else {
      this.#rig.flyTo(target, distance);
    }
    return true;
  }

  flyToOverview(): void {
    this.#rig.flyToOverview(galaxyExtent());
  }

  /**
   * Node under a screen-space point, or null.
   *
   * Two-stage: intersect the view ray with the galactic plane to get a world
   * neighbourhood, query the spatial grid there, then do an exact screen-space
   * test on the few candidates. This is O(candidates), not O(nodes).
   */
  pick(clientX: number, clientY: number): SessionId | null {
    if (!this.#packed || this.#packed.count === 0) return null;

    const rect = this.#canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    // Ray from the camera through the cursor.
    const origin = this.#scratchVec.copy(this.#camera.position);
    const direction = this.#scratchVec2.set(ndcX, ndcY, 0.5).unproject(this.#camera).sub(origin).normalize();

    // Where does it cross z = 0? That is where the disk lives.
    const candidates: number[] = [];
    if (Math.abs(direction.z) > 1e-4) {
      const t = -origin.z / direction.z;
      if (t > 0) {
        const hitX = origin.x + direction.x * t;
        const hitY = origin.y + direction.y * t;
        // Search radius scales with distance, matching the on-screen size of a
        // world unit at that depth.
        const radius = Math.max(4, this.#rig.current.distance * 0.09);
        for (const hit of this.#grid.query(hitX, hitY, radius, this.#time.elapsed, 512)) {
          candidates.push(hit.index);
        }
      }
    }

    // Edge-on view (or a miss): sample along the ray instead.
    if (candidates.length === 0) {
      for (let step = 1; step <= 6; step++) {
        const t = (this.#rig.current.distance * step) / 4;
        const radius = Math.max(6, t * 0.12);
        for (const hit of this.#grid.query(
          origin.x + direction.x * t,
          origin.y + direction.y * t,
          radius,
          this.#time.elapsed,
          128,
        )) {
          candidates.push(hit.index);
        }
        if (candidates.length > 256) break;
      }
    }

    if (candidates.length === 0) return null;

    // Exact test in screen space, weighted so bigger/brighter stars win ties.
    const pointerX = clientX - rect.left;
    const pointerY = clientY - rect.top;
    const [visibleFrom, visibleTo] = this.#timeWindow;

    let best: number | null = null;
    let bestScore = Infinity;

    for (const index of candidates) {
      const node = this.#layoutNodes[index]!;
      if (node.day < visibleFrom || node.day > visibleTo) continue;

      nodePosition(node, this.#time, this.#scratchVec);
      const projected = this.#scratchVec.project(this.#camera);
      if (projected.z > 1) continue; // behind the camera

      const sx = ((projected.x + 1) / 2) * rect.width;
      const sy = ((1 - projected.y) / 2) * rect.height;

      const dx = sx - pointerX;
      const dy = sy - pointerY;
      const distance = Math.hypot(dx, dy);

      const screenRadius = this.#screenRadius(index);
      // Generous but bounded grab radius — small stars must stay clickable.
      const tolerance = Math.max(8, Math.min(screenRadius * 1.4, 46));
      if (distance > tolerance) continue;

      // Prefer the closer of two overlapping stars, then the brighter.
      const score = distance - node.brightness * 6;
      if (score < bestScore) {
        bestScore = score;
        best = index;
      }
    }

    return best === null ? null : this.#packed.ids[best]!;
  }

  /** Approximate on-screen radius of a node, in CSS pixels. */
  #screenRadius(index: number): number {
    const node = this.#layoutNodes[index]!;
    nodePosition(node, this.#time, this.#scratchVec);
    const depth = this.#camera.position.distanceTo(this.#scratchVec);
    const rect = this.#canvas.getBoundingClientRect();
    const scale = rect.height / (2 * Math.tan((this.#camera.fov * Math.PI) / 360));
    return (node.size * scale) / Math.max(depth, 0.1);
  }

  /** World position of a node right now — used to anchor DOM popovers. */
  screenPositionOf(id: SessionId): { x: number; y: number } | null {
    const index = this.#indexById.get(id);
    if (index === undefined) return null;

    nodePosition(this.#layoutNodes[index]!, this.#time, this.#scratchVec);
    const projected = this.#scratchVec.project(this.#camera);
    if (projected.z > 1) return null;

    const rect = this.#canvas.getBoundingClientRect();
    return {
      x: ((projected.x + 1) / 2) * rect.width,
      y: ((1 - projected.y) / 2) * rect.height,
    };
  }

  /* -------------------------------------------------------------- lifecycle */

  start(): void {
    if (this.#running || this.#disposed) return;
    this.#running = true;
    this.#lastFrameTime = performance.now();
    this.#loop(this.#lastFrameTime);
  }

  stop(): void {
    this.#running = false;
    if (this.#frameHandle) cancelAnimationFrame(this.#frameHandle);
    this.#frameHandle = 0;
  }

  /**
   * Sync the drawing buffer to the canvas's CSS size.
   *
   * Called from the render loop rather than relying solely on a ResizeObserver:
   * observers do not fire in every environment (some embedded webviews and
   * headless renderers never deliver the initial notification), and a galaxy
   * rendering into a 1x1 buffer is a silent, total failure. Comparing two
   * integers per frame is free; being wrong here is not.
   */
  #syncSize(): void {
    const width = this.#canvas.clientWidth;
    const height = this.#canvas.clientHeight;
    if (width === 0 || height === 0) return;

    const pixelRatio = this.#renderer.getPixelRatio();
    const expectedWidth = Math.floor(width * pixelRatio);
    const expectedHeight = Math.floor(height * pixelRatio);

    if (this.#canvas.width === expectedWidth && this.#canvas.height === expectedHeight) return;
    this.resize();
  }

  resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    // `clientWidth` is the fallback: some webviews report a zero-size rect for
    // an element that is nonetheless laid out.
    const width = Math.max(1, Math.floor(rect.width) || this.#canvas.clientWidth);
    const height = Math.max(1, Math.floor(rect.height) || this.#canvas.clientHeight);

    this.#renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, this.#quality.profile.maxPixelRatio),
    );
    this.#renderer.setSize(width, height, false);

    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();

    this.#composer?.setSize(width, height);
    this.#composer?.setPixelRatio(this.#renderer.getPixelRatio());
    this.#bloomPass?.setSize(width, height);

    // Point size scale: converts world radius to pixels at unit depth.
    const sizeScale = height / (2 * Math.tan((this.#camera.fov * Math.PI) / 360));
    this.#setUniform(this.#nodeMaterial, 'uSizeScale', sizeScale);
    this.#setUniform(this.#dust?.material as ShaderMaterial | undefined, 'uSizeScale', sizeScale);
    this.#setUniform(
      this.#starfield?.material as ShaderMaterial | undefined,
      'uSizeScale',
      Math.max(0.6, height / 900),
    );

    const pixelRatio = this.#renderer.getPixelRatio();
    this.#setUniform(this.#nodeMaterial, 'uPixelRatio', pixelRatio);
    this.#setUniform(this.#dust?.material as ShaderMaterial | undefined, 'uPixelRatio', pixelRatio);
    this.#setUniform(
      this.#starfield?.material as ShaderMaterial | undefined,
      'uPixelRatio',
      pixelRatio,
    );
  }

  dispose(): void {
    this.stop();
    this.#disposed = true;

    this.#disposeNodes();
    for (const object of [this.#nebula, this.#starfield, this.#dust, this.#coreGlow, this.#selectionRing, this.#hoverRing]) {
      if (!object) continue;
      this.#scene.remove(object);
      object.geometry.dispose();
      (object.material as ShaderMaterial).dispose();
    }

    this.#composer?.dispose();
    this.#renderer.dispose();
  }

  #disposeNodes(): void {
    if (!this.#nodes) return;
    this.#scene.remove(this.#nodes);
    this.#nodes.geometry.dispose();
    (this.#nodes.material as ShaderMaterial).dispose();
    this.#nodes = null;
    this.#nodeMaterial = null;
  }

  /* ------------------------------------------------------------- render loop */

  #loop = (now: number): void => {
    if (!this.#running) return;
    this.#frameHandle = requestAnimationFrame(this.#loop);

    const frameMs = now - this.#lastFrameTime;
    this.#lastFrameTime = now;
    // Clamp: a stalled tab must not fast-forward the galaxy's rotation.
    const dt = Math.min(frameMs / 1000, 0.05);

    this.#syncSize();

    if (this.#options.motion) {
      this.#time.elapsed += dt * this.#options.motionSpeed;
    }

    this.#rig.update(dt, this.#camera);
    this.#animateHighlights(dt);
    this.#updateUniforms();
    this.#updateRings(dt);

    this.#composer ? this.#composer.render(dt) : this.#renderer.render(this.#scene, this.#camera);

    this.#updateLabels(now);
    this.#trackPerformance(frameMs, now);
  };

  /** Ease highlight values so search results bloom in rather than snap. */
  #animateHighlights(dt: number): void {
    if (!this.#highlightAnimating || !this.#packed || !this.#nodes) return;

    const current = this.#packed.highlight;
    const target = this.#highlightTarget;
    const rate = 1 - Math.exp(-9 * dt);

    let settled = true;
    for (let i = 0; i < current.length; i++) {
      const delta = target[i]! - current[i]!;
      if (Math.abs(delta) < 0.002) {
        current[i] = target[i]!;
        continue;
      }
      current[i] = current[i]! + delta * rate;
      settled = false;
    }

    const attribute = this.#nodes.geometry.getAttribute('aHighlight') as BufferAttribute;
    attribute.needsUpdate = true;
    if (settled) this.#highlightAnimating = false;
  }

  #updateUniforms(): void {
    const elapsed = this.#time.elapsed;

    this.#setUniform(this.#nodeMaterial, 'uElapsed', elapsed);
    this.#setUniform(this.#nodeMaterial, 'uNowDay', this.#time.nowDay);
    this.#setUniform(this.#nodeMaterial, 'uSpanDays', this.#time.spanDays);
    this.#setUniform(this.#nodeMaterial, 'uFocusDistance', this.#rig.focusDistance);
    this.#setUniform(
      this.#nodeMaterial,
      'uAperture',
      this.#options.depthOfField && this.#quality.profile.depthOfField
        ? this.#quality.profile.aperture
        : 0,
    );
    this.#setUniform(this.#nodeMaterial, 'uSearchActive', this.#searchActive ? 1 : 0);

    const timeWindow = this.#nodeMaterial?.uniforms.uTimeWindow?.value as Vector2 | undefined;
    timeWindow?.set(this.#timeWindow[0], this.#timeWindow[1]);

    this.#setUniform(this.#starfield?.material as ShaderMaterial | undefined, 'uElapsed', elapsed);
    this.#setUniform(this.#dust?.material as ShaderMaterial | undefined, 'uElapsed', elapsed);
    this.#setUniform(
      this.#dust?.material as ShaderMaterial | undefined,
      'uMotion',
      this.#options.motion ? 1 : 0,
    );

    if (this.#nebula?.visible) {
      const material = this.#nebula.material as ShaderMaterial;
      this.#setUniform(material, 'uElapsed', elapsed);
      this.#inverseProjection.copy(this.#camera.projectionMatrixInverse);
      this.#inverseView.copy(this.#camera.matrixWorld);
      material.uniforms.uInverseProjection!.value = this.#inverseProjection;
      material.uniforms.uInverseView!.value = this.#inverseView;
    }

    if (this.#coreGlow) {
      // Billboard the core so it never shows its edge.
      this.#coreGlow.quaternion.copy(this.#camera.quaternion);
      this.#setUniform(this.#coreGlow.material as ShaderMaterial, 'uElapsed', elapsed);
    }
  }

  #updateRings(dt: number): void {
    const configure = (mesh: Mesh | null, id: SessionId | null, scale: number, opacity: number) => {
      if (!mesh) return;
      const material = mesh.material as ShaderMaterial;
      const index = id === null ? undefined : this.#indexById.get(id);

      if (index === undefined) {
        // Fade out rather than vanish.
        const next = Math.max(0, (material.uniforms.uOpacity!.value as number) - dt * 4);
        material.uniforms.uOpacity!.value = next;
        mesh.visible = next > 0.01;
        return;
      }

      const node = this.#layoutNodes[index]!;
      nodePosition(node, this.#time, this.#scratchVec);
      mesh.position.copy(this.#scratchVec);
      mesh.quaternion.copy(this.#camera.quaternion);

      // Ring size tracks the star's apparent size, with a floor so a tiny
      // asteroid still gets a visible selection indicator.
      const size = Math.max(node.size * 5.5, this.#rig.current.distance * 0.035) * scale;
      mesh.scale.set(size, size, 1);

      const current = material.uniforms.uOpacity!.value as number;
      material.uniforms.uOpacity!.value = current + (opacity - current) * (1 - Math.exp(-12 * dt));
      material.uniforms.uElapsed!.value = this.#time.elapsed;
      mesh.visible = true;
    };

    configure(this.#selectionRing, this.#selectedId, 1, 0.85);
    configure(this.#hoverRing, this.#hoverId === this.#selectedId ? null : this.#hoverId, 0.78, 0.5);
  }

  /**
   * Project nearby nodes and hand the top-N to the DOM overlay.
   *
   * Throttled to ~12 Hz: labels only need to feel attached, and re-laying out
   * DOM text every frame is by far the most expensive thing the galaxy could do.
   */
  #updateLabels(now: number): void {
    if (!this.#options.labels || !this.#callbacks.onLabels) return;
    if (now - this.#lastLabelUpdate < 84) return;
    this.#lastLabelUpdate = now;

    const budget = Math.min(this.#options.labelBudget, this.#quality.profile.labelBudget);
    if (budget <= 0 || !this.#packed) {
      this.#callbacks.onLabels([]);
      return;
    }

    const rect = this.#canvas.getBoundingClientRect();
    const target = this.#rig.current.target;
    const searchRadius = Math.max(20, this.#rig.current.distance * 0.75);
    const nearby = this.#grid.query(target.x, target.y, searchRadius, this.#time.elapsed, 600);

    const [visibleFrom, visibleTo] = this.#timeWindow;
    const candidates: ScreenLabel[] = [];

    for (const { index } of nearby) {
      const node = this.#layoutNodes[index]!;
      if (node.day < visibleFrom || node.day > visibleTo) continue;
      if (this.#searchActive && this.#packed.highlight[index]! < 0.5) continue;

      nodePosition(node, this.#time, this.#scratchVec);
      const depth = this.#camera.position.distanceTo(this.#scratchVec);

      const projected = this.#scratchVec.project(this.#camera);
      if (projected.z > 1) continue;

      const x = ((projected.x + 1) / 2) * rect.width;
      const y = ((1 - projected.y) / 2) * rect.height;
      if (x < -80 || y < -40 || x > rect.width + 80 || y > rect.height + 40) continue;

      const scale = rect.height / (2 * Math.tan((this.#camera.fov * Math.PI) / 360));
      const radius = (node.size * scale) / Math.max(depth, 0.1);

      // Rank by apparent size and brightness — exactly what the eye picks out.
      const weight = Math.min(1, (radius / 14) * (0.45 + node.brightness));
      if (weight < 0.12) continue;

      candidates.push({ id: node.id, x, y, weight, radius });
    }

    candidates.sort((a, b) => b.weight - a.weight);

    // Greedy de-overlap: a label is dropped if it would collide with a
    // higher-ranked one. Cheap, and it keeps the overlay readable when zoomed out.
    const placed: ScreenLabel[] = [];
    for (const candidate of candidates) {
      if (placed.length >= budget) break;
      let collides = false;
      for (const existing of placed) {
        if (Math.abs(existing.x - candidate.x) < 130 && Math.abs(existing.y - candidate.y) < 22) {
          collides = true;
          break;
        }
      }
      if (!collides) placed.push(candidate);
    }

    this.#callbacks.onLabels(placed);
  }

  #trackPerformance(frameMs: number, now: number): void {
    this.#fpsAccumulator += frameMs;
    this.#fpsFrames++;

    if (this.#fpsAccumulator >= 500) {
      const fps = (this.#fpsFrames * 1000) / this.#fpsAccumulator;
      this.#callbacks.onFrame?.(fps);
      this.#fpsAccumulator = 0;
      this.#fpsFrames = 0;
    }

    if (this.#quality.sample(frameMs, now)) this.#applyQualityProfile();
  }

  #setUniform(material: ShaderMaterial | null | undefined, name: string, value: unknown): void {
    const uniform = material?.uniforms[name];
    if (uniform) uniform.value = value;
  }
}

/**
 * Initial tier guess before any frames have been measured. Conservative on
 * purpose — the adaptive controller will raise it within a couple of seconds if
 * the machine can take it, and starting low avoids a janky first impression.
 */
function detectInitialTier(): QualityTier {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;

  if (memory <= 4 || cores <= 2) return 'low';
  if (memory <= 8 || cores <= 4) return 'medium';
  return 'high';
}
