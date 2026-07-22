/**
 * Session node shader.
 *
 * One `THREE.Points` draw call renders the entire library. The vertex shader
 * computes each node's orbital position from its packed attributes, so the CPU
 * uploads geometry once and then only changes uniforms — this is what holds 60
 * FPS at 100k+ nodes.
 *
 * The fragment shader draws a physically-inspired point source: a tight core
 * with an inverse-square halo, chromatic warmth in the core, and subtle
 * diffraction spikes on the brightest stars.
 */

import { LAYOUT } from '../layout.ts';
import { NOISE_GLSL, ORBIT_GLSL, TONEMAP_GLSL } from './common.glsl.ts';

/**
 * Injects the layout constants as `#define`s so the GLSL and TypeScript
 * implementations can never drift apart numerically.
 */
export function layoutDefines(): string {
  const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);
  return [
    `#define R_MIN ${f(LAYOUT.rMin)}`,
    `#define R_MAX ${f(LAYOUT.rMax)}`,
    `#define WIND ${f(LAYOUT.wind)}`,
    `#define Z_SCALE ${f(LAYOUT.zScale)}`,
    `#define PATTERN_SPEED ${f(LAYOUT.patternSpeed)}`,
    `#define EPICYCLE ${f(LAYOUT.epicycle)}`,
    `#define AGE_CURVE ${f(LAYOUT.ageCurve)}`,
  ].join('\n');
}

export const NODE_VERTEX = /* glsl */ `
${layoutDefines()}

attribute vec4 aOrbit;      // day, angle, height, phase
attribute vec4 aTraits;     // size, brightness, kind, pinned
attribute vec3 aColor;
attribute float aHighlight; // 0..1 search highlight

uniform float uNowDay;
uniform float uSpanDays;
uniform float uElapsed;

uniform float uPixelRatio;
uniform float uSizeScale;      // viewportHeight / (2 * tan(fov/2))
uniform float uMinPointSize;
uniform float uMaxPointSize;

uniform float uFocusDistance;  // depth-of-field focal plane, world units
uniform float uAperture;       // 0 disables DOF

uniform float uSearchActive;   // 1 while a query is running
uniform float uDimAmount;      // how far non-matches fade, 0..1

uniform vec2 uTimeWindow;      // visible day range; outside fades to nothing
uniform float uTimeFeather;

${ORBIT_GLSL}

varying vec3 vColor;
varying float vAlpha;
varying float vBokeh;      // 0 = in focus, 1 = fully defocused
varying float vKind;
varying float vHighlight;
varying float vBrightness;

void main() {
  vec3 worldPos = positionOf(aOrbit, uNowDay, uSpanDays, uElapsed);

  vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
  float viewDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;

  float size = aTraits.x;
  float brightness = aTraits.y;
  vKind = aTraits.z;
  float pinned = aTraits.w;

  // --- timeline fade -------------------------------------------------------
  // Sessions outside the scrubbed window fade rather than pop.
  float timeFade =
      smoothstep(uTimeWindow.x - uTimeFeather, uTimeWindow.x, aOrbit.x)
    * (1.0 - smoothstep(uTimeWindow.y, uTimeWindow.y + uTimeFeather, aOrbit.x));

  // --- depth of field ------------------------------------------------------
  // Point sprites cannot be blurred per-fragment cheaply, so defocus is faked
  // the way a real lens behaves for a point source: the circle of confusion
  // grows and the energy spreads, so peak intensity drops.
  float coc = uAperture * abs(viewDepth - uFocusDistance) / max(viewDepth, 1.0);
  vBokeh = clamp(coc, 0.0, 1.0);

  // --- point size ----------------------------------------------------------
  float projected = size * uSizeScale / max(viewDepth, 0.1);
  projected *= 1.0 + vBokeh * 2.2;                 // circle of confusion
  projected *= mix(1.0, 1.55, aHighlight);         // search pulse
  projected *= mix(1.0, 1.2, pinned);

  gl_PointSize = clamp(projected * uPixelRatio, uMinPointSize, uMaxPointSize);

  // --- colour and alpha ----------------------------------------------------
  vColor = aColor;
  vHighlight = aHighlight;
  vBrightness = brightness;

  float alpha = mix(0.30, 1.0, brightness);
  alpha *= timeFade;
  alpha /= (1.0 + vBokeh * 2.6);                   // energy conservation

  // Non-matching nodes recede while a search is active.
  float dim = 1.0 - uSearchActive * uDimAmount * (1.0 - aHighlight);
  alpha *= dim;

  // Fade the very distant tail so the outer disk dissolves instead of ending.
  alpha *= 1.0 - smoothstep(R_MAX * 2.2, R_MAX * 4.0, viewDepth);

  vAlpha = alpha;

  // Cull fully transparent points cheaply.
  if (vAlpha < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const NODE_FRAGMENT = /* glsl */ `
precision highp float;

${TONEMAP_GLSL}

uniform float uElapsed;
uniform vec3 uHighlightColor;

varying vec3 vColor;
varying float vAlpha;
varying float vBokeh;
varying float vKind;
varying float vHighlight;
varying float vBrightness;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = length(uv);
  if (d > 1.0) discard;

  // A point source is a tight core plus a wide inverse-square halo. Defocusing
  // flattens the core into a disc, which is what a real bokeh circle looks like.
  float coreSharpness = mix(26.0, 2.4, vBokeh);
  float core = exp(-d * d * coreSharpness);
  float halo = 0.16 / (1.0 + d * d * 9.0);
  float disc = smoothstep(1.0, 0.72, d) * vBokeh * 0.55;

  float intensity = core + halo + disc;

  // Diffraction spikes: only on bright, in-focus stars, and deliberately faint.
  if (vKind < 0.5 && vBrightness > 0.55 && vBokeh < 0.35) {
    vec2 a = abs(uv);
    float spike = exp(-a.x * 42.0) + exp(-a.y * 42.0);
    intensity += spike * 0.055 * (vBrightness - 0.55) * 2.2 * (1.0 - vBokeh / 0.35);
  }

  // Hot cores skew towards white; the language colour dominates the halo. This
  // is how real stars read — the chromaticity lives in the outer envelope.
  vec3 tint = mix(vColor, vec3(1.0), core * 0.72 * vBrightness);
  tint = mix(tint, uHighlightColor, vHighlight * 0.55);

  // Search pulse: a slow breath, not a strobe.
  float pulse = 1.0 + vHighlight * 0.22 * sin(uElapsed * 2.6);

  vec3 rgb = tonemap(tint * intensity * pulse * (0.55 + vBrightness));
  float alpha = clamp(intensity, 0.0, 1.0) * vAlpha;
  if (alpha < 0.003) discard;

  gl_FragColor = vec4(rgb, alpha);
}
`;

/**
 * Selection and hover rings. A separate tiny draw call rather than a branch in
 * the main shader, because it needs alpha blending and a different depth mode.
 */
export const RING_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const RING_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uOpacity;
uniform float uElapsed;
uniform float uThickness;

varying vec2 vUv;

void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  float d = length(uv);

  // Antialiased annulus whose width is constant in screen space.
  float ring = smoothstep(1.0, 1.0 - uThickness, d) - smoothstep(1.0 - uThickness, 1.0 - uThickness * 2.0, d);

  // A slow sweep around the ring reads as "locked on" without being noisy.
  float angle = atan(uv.y, uv.x);
  float sweep = 0.72 + 0.28 * sin(angle * 2.0 - uElapsed * 1.4);

  float alpha = ring * uOpacity * sweep;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

export const NOISE_FOR_TESTS = NOISE_GLSL;
