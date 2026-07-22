/**
 * Shared GLSL. Injected into several programs, so it must stay free of
 * uniforms and only declare pure functions.
 */

/** Hash / value-noise / fbm used by the nebula and dust. */
export const NOISE_GLSL = /* glsl */ `
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  // Value noise with smoothstep interpolation — cheaper than gradient noise and
  // indistinguishable once it is stacked into fbm and heavily blurred.
  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }

  float fbm(vec3 p, int octaves) {
    float sum = 0.0;
    float amplitude = 0.5;
    float total = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      sum += amplitude * valueNoise(p);
      total += amplitude;
      amplitude *= 0.5;
      p *= 2.03;   // slightly off 2.0 to avoid axis-aligned repetition
    }
    return sum / max(total, 0.0001);
  }
`;

/** ACES-inspired filmic tone curve. Keeps bright cores from clipping to flat white. */
export const TONEMAP_GLSL = /* glsl */ `
  vec3 tonemap(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }
`;

/**
 * The orbital layout, in GLSL.
 *
 * MUST stay identical to `nodePosition()` in `../layout.ts`. The constants are
 * injected by `layoutDefines()` so there is exactly one source of truth for the
 * numbers, even though the formula is written twice.
 */
export const ORBIT_GLSL = /* glsl */ `
  float normalizedAge(float day, float nowDay, float spanDays) {
    return clamp((nowDay - day) / max(spanDays, 1.0), 0.0, 1.0);
  }

  float orbitRadius(float day, float nowDay, float spanDays) {
    float age = normalizedAge(day, nowDay, spanDays);
    return R_MIN + (R_MAX - R_MIN) * pow(age, AGE_CURVE);
  }

  // orbit = (day, angle, height, phase)
  vec3 positionOf(vec4 orbit, float nowDay, float spanDays, float elapsed) {
    float r = orbitRadius(orbit.x, nowDay, spanDays);

    float theta = orbit.y
      + WIND * log(r / R_MIN)
      + PATTERN_SPEED * elapsed;

    float omega = 0.35 / sqrt(r / R_MIN);
    float wobbleX = cos(elapsed * omega + orbit.w) * EPICYCLE;
    float wobbleY = sin(elapsed * omega + orbit.w) * EPICYCLE;

    float falloff = exp(-r / Z_SCALE);

    return vec3(
      r * cos(theta) + wobbleX,
      r * sin(theta) + wobbleY,
      orbit.z * falloff
    );
  }
`;
