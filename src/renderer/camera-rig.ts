/**
 * Cinematic camera rig.
 *
 * Two motion regimes, deliberately kept separate:
 *
 *  - *Continuous* input (drag, wheel) drives target values that the actual
 *    camera chases with frame-rate-independent exponential damping. This is
 *    what makes dragging feel weighted rather than nailed to the cursor.
 *  - *Discrete* travel (clicking a star, jumping to a search result) runs an
 *    explicit tween with an ease curve and an arc, so the camera banks through
 *    the galaxy instead of teleporting.
 *
 * The rig is a spherical orbit around a moving target. It never rolls, and the
 * polar angle is clamped short of the poles so the horizon never flips.
 */

import { Vector3, type PerspectiveCamera } from 'three';

const TWO_PI = Math.PI * 2;

export interface CameraState {
  target: Vector3;
  /** Distance from target, world units. */
  distance: number;
  /** Horizontal angle, radians. */
  azimuth: number;
  /** Vertical angle from +Z, radians. Clamped away from the poles. */
  polar: number;
}

export interface RigLimits {
  minDistance: number;
  maxDistance: number;
  minPolar: number;
  maxPolar: number;
}

export interface FlightOptions {
  /** Seconds. Scaled by travel distance when `adaptive` is set. */
  duration?: number;
  /** Longer trips take proportionally longer, capped. */
  adaptive?: boolean;
  /** Rise out of the disk mid-flight, then settle. 0 disables. */
  arc?: number;
  onArrive?: () => void;
}

/** Smoothstep-based ease that starts and ends at exactly zero velocity. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Frame-rate-independent exponential decay.
 *
 * `lambda` is the rate; at 60 FPS a lambda of 9 settles ~95% in a quarter
 * second. Using `1 - exp(-lambda*dt)` rather than a fixed per-frame factor is
 * what keeps the feel identical at 30, 60 and 144 Hz.
 */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Shortest signed angular difference, so azimuth never unwinds the long way. */
function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return delta;
}

interface Flight {
  from: CameraState;
  to: CameraState;
  /** Pre-resolved shortest azimuth delta. */
  azimuthDelta: number;
  elapsed: number;
  duration: number;
  arc: number;
  onArrive?: (() => void) | undefined;
}

export class CameraRig {
  readonly desired: CameraState;
  readonly current: CameraState;
  readonly limits: RigLimits;

  #flight: Flight | null = null;
  #dampingLambda = 7.5;

  /** Scratch vectors — the rig runs every frame and must not allocate. */
  readonly #scratch = new Vector3();
  readonly #offset = new Vector3();

  constructor(initial: Partial<CameraState> = {}, limits: Partial<RigLimits> = {}) {
    const target = initial.target?.clone() ?? new Vector3(0, 0, 0);
    this.desired = {
      target,
      distance: initial.distance ?? 260,
      azimuth: initial.azimuth ?? -Math.PI / 2,
      polar: initial.polar ?? 0.72,
    };
    this.current = {
      target: target.clone(),
      distance: this.desired.distance,
      azimuth: this.desired.azimuth,
      polar: this.desired.polar,
    };
    this.limits = {
      minDistance: limits.minDistance ?? 6,
      maxDistance: limits.maxDistance ?? 900,
      minPolar: limits.minPolar ?? 0.08,
      maxPolar: limits.maxPolar ?? Math.PI - 0.08,
    };
  }

  get isFlying(): boolean {
    return this.#flight !== null;
  }

  /** True when the camera has effectively stopped — lets the app idle the loop. */
  get isSettled(): boolean {
    if (this.#flight) return false;
    return (
      Math.abs(this.current.distance - this.desired.distance) < 0.01 &&
      Math.abs(shortestAngle(this.current.azimuth, this.desired.azimuth)) < 0.0005 &&
      Math.abs(this.current.polar - this.desired.polar) < 0.0005 &&
      this.current.target.distanceToSquared(this.desired.target) < 0.0004
    );
  }

  /* ------------------------------------------------------------ user input */

  /** Drag to orbit. Deltas are in radians. */
  orbit(deltaAzimuth: number, deltaPolar: number): void {
    this.cancelFlight();
    this.desired.azimuth += deltaAzimuth;
    this.desired.polar = clamp(
      this.desired.polar + deltaPolar,
      this.limits.minPolar,
      this.limits.maxPolar,
    );
  }

  /**
   * Wheel to zoom.
   *
   * Multiplicative, so a notch always changes the view by the same *proportion*
   * whether you are looking at the whole galaxy or a single star.
   */
  zoom(factor: number): void {
    this.cancelFlight();
    this.desired.distance = clamp(
      this.desired.distance * factor,
      this.limits.minDistance,
      this.limits.maxDistance,
    );
  }

  /**
   * Middle-drag to pan. Movement is scaled by distance so the world tracks the
   * cursor at any zoom level.
   */
  pan(deltaX: number, deltaY: number, camera: PerspectiveCamera): void {
    this.cancelFlight();
    const scale = this.desired.distance * 0.0016;

    // Camera-relative axes, so panning always matches what the user sees.
    this.#scratch.setFromMatrixColumn(camera.matrixWorld, 0); // right
    this.desired.target.addScaledVector(this.#scratch, -deltaX * scale);

    this.#scratch.setFromMatrixColumn(camera.matrixWorld, 1); // up
    this.desired.target.addScaledVector(this.#scratch, deltaY * scale);
  }

  /* --------------------------------------------------------------- travel */

  /**
   * Fly to a point. `distance` defaults to a framing that fills a comfortable
   * portion of the view for the given object radius.
   */
  flyTo(
    target: Vector3,
    distance: number,
    options: FlightOptions = {},
  ): void {
    const from: CameraState = {
      target: this.current.target.clone(),
      distance: this.current.distance,
      azimuth: this.current.azimuth,
      polar: this.current.polar,
    };

    const to: CameraState = {
      target: target.clone(),
      distance: clamp(distance, this.limits.minDistance, this.limits.maxDistance),
      // Keep the current viewing angle unless the caller overrides it: users
      // build a mental map of the galaxy's orientation and rotating it for them
      // is disorienting.
      azimuth: this.desired.azimuth,
      polar: this.desired.polar,
    };

    const travel = from.target.distanceTo(to.target) + Math.abs(to.distance - from.distance);

    let duration = options.duration ?? 1.15;
    if (options.adaptive !== false) {
      // Long trips take longer, but sub-linearly and hard-capped — nobody wants
      // to wait three seconds to cross the galaxy.
      duration = clamp(0.55 + Math.sqrt(travel) * 0.055, 0.45, 1.9);
    }

    this.#flight = {
      from,
      to,
      azimuthDelta: shortestAngle(from.azimuth, to.azimuth),
      elapsed: 0,
      duration,
      // Rise out of the plane proportionally to how far we are travelling.
      arc: options.arc ?? Math.min(travel * 0.12, 42),
      onArrive: options.onArrive,
    };
  }

  /** Frame the whole galaxy. */
  flyToOverview(extent: number, options: FlightOptions = {}): void {
    this.flyTo(new Vector3(0, 0, 0), extent * 1.85, { ...options, arc: 0 });
  }

  cancelFlight(): void {
    if (this.#flight) {
      // Adopt wherever the camera currently is, so cancelling never snaps.
      this.desired.target.copy(this.current.target);
      this.desired.distance = this.current.distance;
      this.desired.azimuth = this.current.azimuth;
      this.desired.polar = this.current.polar;
      this.#flight = null;
    }
  }

  /* ---------------------------------------------------------------- update */

  /** Advance the rig and write the result into `camera`. */
  update(dt: number, camera: PerspectiveCamera): void {
    // Clamp dt so a backgrounded tab does not teleport the camera on return.
    const step = Math.min(dt, 0.1);

    if (this.#flight) {
      this.#advanceFlight(step);
    } else {
      const lambda = this.#dampingLambda;
      this.current.distance = damp(this.current.distance, this.desired.distance, lambda, step);
      this.current.polar = damp(this.current.polar, this.desired.polar, lambda, step);

      // Damp along the shortest arc rather than towards the raw value.
      const delta = shortestAngle(this.current.azimuth, this.desired.azimuth);
      this.current.azimuth += delta * (1 - Math.exp(-lambda * step));

      this.current.target.x = damp(this.current.target.x, this.desired.target.x, lambda, step);
      this.current.target.y = damp(this.current.target.y, this.desired.target.y, lambda, step);
      this.current.target.z = damp(this.current.target.z, this.desired.target.z, lambda, step);
    }

    this.applyTo(camera);
  }

  #advanceFlight(dt: number): void {
    const flight = this.#flight;
    if (!flight) return;

    flight.elapsed += dt;
    const raw = Math.min(1, flight.elapsed / flight.duration);
    const t = easeInOutCubic(raw);

    const { from, to } = flight;

    this.current.target.lerpVectors(from.target, to.target, t);

    // Arc: lift out of the galactic plane at mid-flight. sin() peaks at t=0.5
    // and is exactly zero at both ends, so there is no discontinuity.
    if (flight.arc > 0) {
      this.current.target.z += Math.sin(t * Math.PI) * flight.arc;
    }

    // Pull back before diving in — the classic "establishing shot" move. The
    // bulge is proportional to how much the distance is changing.
    const distanceSwing = Math.abs(to.distance - from.distance) * 0.22;
    this.current.distance =
      from.distance + (to.distance - from.distance) * t + Math.sin(t * Math.PI) * distanceSwing;

    this.current.azimuth = from.azimuth + flight.azimuthDelta * t;
    this.current.polar = from.polar + (to.polar - from.polar) * t;

    if (raw >= 1) {
      this.desired.target.copy(to.target);
      this.desired.distance = to.distance;
      this.desired.azimuth = to.azimuth;
      this.desired.polar = to.polar;
      const { onArrive } = flight;
      this.#flight = null;
      onArrive?.();
    }
  }

  /** Convert spherical state into a camera transform. */
  applyTo(camera: PerspectiveCamera): void {
    const { distance, azimuth, polar } = this.current;
    const sinPolar = Math.sin(polar);

    this.#offset.set(
      distance * sinPolar * Math.cos(azimuth),
      distance * sinPolar * Math.sin(azimuth),
      distance * Math.cos(polar),
    );

    camera.position.copy(this.current.target).add(this.#offset);
    // +Z is "galactic north"; keeping it as up is what stops the view rolling.
    camera.up.set(0, 0, 1);
    camera.lookAt(this.current.target);
    camera.updateMatrixWorld();
  }

  /** Distance from the camera to the orbit target — the DOF focal plane. */
  get focusDistance(): number {
    return this.current.distance;
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
