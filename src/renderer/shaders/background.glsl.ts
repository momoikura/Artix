/**
 * Background: nebula, deep starfield and dust.
 *
 * The nebula is rendered as a fullscreen triangle whose fragment shader
 * reconstructs a world-space ray per pixel. Sampling 3D noise along that ray
 * gives genuine parallax — the clouds sit *behind* the galaxy and shift
 * correctly as the camera moves, rather than being a flat backdrop that slides.
 */

import { NOISE_GLSL, TONEMAP_GLSL } from './common.glsl.ts';

export const NEBULA_VERTEX = /* glsl */ `
varying vec2 vNdc;

void main() {
  vNdc = position.xy;
  // Already in clip space: this geometry is a fullscreen triangle.
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

export const NEBULA_FRAGMENT = /* glsl */ `
precision highp float;

${NOISE_GLSL}
${TONEMAP_GLSL}

uniform mat4 uInverseProjection;
uniform mat4 uInverseView;
uniform float uElapsed;
uniform float uIntensity;
uniform int uOctaves;
uniform vec3 uColorA;   // cold outer hydrogen
uniform vec3 uColorB;   // warm inner core glow
uniform vec3 uColorC;   // deep field tint

varying vec2 vNdc;

void main() {
  // Reconstruct the world-space view ray for this pixel.
  vec4 clip = vec4(vNdc, 1.0, 1.0);
  vec4 viewPos = uInverseProjection * clip;
  viewPos /= viewPos.w;
  vec3 dir = normalize((uInverseView * vec4(viewPos.xyz, 0.0)).xyz);

  // Two noise layers at different scales, offset in the third dimension so the
  // structure evolves imperceptibly slowly instead of looping.
  vec3 p = dir * 2.4;
  float drift = uElapsed * 0.004;

  float base = fbm(p + vec3(0.0, 0.0, drift), uOctaves);
  float detail = fbm(p * 3.1 + vec3(11.3, 4.7, drift * 1.7), max(uOctaves - 2, 2));

  // Ridged combination gives filament structure rather than cotton wool.
  float density = base * 0.75 + detail * 0.25;
  density = pow(max(density - 0.34, 0.0) * 1.72, 2.1);

  // Concentrate the nebula towards the galactic plane, where the gas would be.
  float planeFalloff = exp(-abs(dir.z) * 2.6);
  density *= mix(0.35, 1.0, planeFalloff);

  vec3 color = mix(uColorA, uColorB, clamp(detail * 1.6, 0.0, 1.0));
  vec3 rgb = color * density * uIntensity;

  // Deep-field floor so the "empty" sky is never pure black — real space isn't.
  rgb += uColorC * (0.35 + 0.65 * planeFalloff);

  gl_FragColor = vec4(tonemap(rgb), 1.0);
}
`;

/** Distant starfield. Static points at a large radius, with subtle twinkle. */
export const STARFIELD_VERTEX = /* glsl */ `
attribute float aMagnitude;   // 0..1 apparent brightness
attribute float aTwinkle;     // phase offset

uniform float uElapsed;
uniform float uPixelRatio;
uniform float uSizeScale;

varying float vAlpha;
varying vec3 vTint;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Background stars are effectively at infinity: constant screen size.
  gl_PointSize = (0.6 + aMagnitude * 2.1) * uPixelRatio * uSizeScale;

  // Atmospheric-style scintillation, very low amplitude.
  float twinkle = 0.88 + 0.12 * sin(uElapsed * 1.7 + aTwinkle * 6.283);
  vAlpha = (0.10 + aMagnitude * 0.72) * twinkle;

  // Cheap stellar-class tint: dim stars skew red, bright ones blue-white.
  vTint = mix(vec3(1.0, 0.84, 0.72), vec3(0.80, 0.88, 1.0), aMagnitude);
}
`;

export const STARFIELD_FRAGMENT = /* glsl */ `
precision mediump float;

varying float vAlpha;
varying vec3 vTint;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = dot(uv, uv);
  if (d > 1.0) discard;
  float intensity = exp(-d * 5.5);
  gl_FragColor = vec4(vTint * intensity, intensity * vAlpha);
}
`;

/**
 * Foreground dust motes. These sit in the disk, catch light, and give the
 * camera a strong parallax reference when panning — without them, zooming
 * reads as scaling rather than travelling.
 */
export const DUST_VERTEX = /* glsl */ `
attribute float aDrift;

uniform float uElapsed;
uniform float uPixelRatio;
uniform float uSizeScale;
uniform float uMotion;

varying float vAlpha;

void main() {
  vec3 p = position;

  // Slow rotation with the galaxy, plus a gentle vertical breathing motion.
  float angle = uElapsed * 0.0072 * uMotion;
  float c = cos(angle);
  float s = sin(angle);
  vec3 rotated = vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z);
  rotated.z += sin(uElapsed * 0.16 * uMotion + aDrift * 6.283) * 1.4;

  vec4 mvPosition = modelViewMatrix * vec4(rotated, 1.0);
  float depth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;

  gl_PointSize = clamp(2.2 * uSizeScale / max(depth, 1.0), 1.0, 26.0) * uPixelRatio;

  // Fade out both very close (would smear across the lens) and very far.
  vAlpha = 0.055
    * smoothstep(6.0, 26.0, depth)
    * (1.0 - smoothstep(180.0, 420.0, depth));
}
`;

export const DUST_FRAGMENT = /* glsl */ `
precision mediump float;

varying float vAlpha;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = dot(uv, uv);
  if (d > 1.0) discard;
  float intensity = (1.0 - d) * (1.0 - d);
  gl_FragColor = vec4(vec3(0.62, 0.70, 0.86) * intensity, intensity * vAlpha);
}
`;

/**
 * Volumetric core glow. A camera-facing quad with a radial profile that
 * approximates the integrated emission of the dense inner region.
 */
export const CORE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const CORE_FRAGMENT = /* glsl */ `
precision highp float;

${NOISE_GLSL}
${TONEMAP_GLSL}

uniform float uElapsed;
uniform float uIntensity;
uniform vec3 uInner;
uniform vec3 uOuter;

varying vec2 vUv;

void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  float d = length(uv);
  if (d > 1.0) discard;

  // Two-component profile: a bright bulge and a broad halo, as in a real bulge.
  float bulge = exp(-d * d * 9.0);
  float halo = exp(-d * 2.3) * 0.4;

  // Break up the perfect circle so it reads as gas, not a sprite.
  float texture = 0.82 + 0.18 * fbm(vec3(uv * 3.0, uElapsed * 0.01), 4);

  float intensity = (bulge + halo) * texture * uIntensity;
  vec3 rgb = mix(uOuter, uInner, bulge);

  float alpha = clamp(intensity, 0.0, 1.0) * (1.0 - smoothstep(0.85, 1.0, d));
  if (alpha < 0.003) discard;

  gl_FragColor = vec4(tonemap(rgb * intensity), alpha);
}
`;
