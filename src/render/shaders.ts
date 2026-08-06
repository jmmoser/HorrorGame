// GLSL for the deferred-ish post chain. Everything here reads the scene's
// depth buffer; nothing needs a second geometry pass.
//
// These are GLSL ES 3.00 (`glslVersion: GLSL3`). three does not provide the
// `fragColor` compatibility define, so every fragment shader declares its
// own output — and the volumetric pass needs 3.00 anyway, for `sampler2DShadow`.
//
// Conventions shared by every shader below:
//   - view space, right-handed, camera looking down -z (so viewZ is negative)
//   - `cameraProjectionMatrix` / `cameraInverseProjectionMatrix` are the live
//     camera's, uploaded per frame
//   - depth comes from a real DepthTexture, non-reversed

/** depth → view position, and normals rebuilt from the depth derivative */
const DEPTH_UTILS = /* glsl */ `
  uniform sampler2D tDepth;
  uniform mat4 cameraProjectionMatrix;
  uniform mat4 cameraInverseProjectionMatrix;
  uniform float cameraNear;
  uniform float cameraFar;

  float readDepth(vec2 uv) {
    return texture(tDepth, uv).x;
  }

  vec3 viewPosFromDepth(vec2 uv, float depth) {
    float viewZ = perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
    float clipW = cameraProjectionMatrix[2][3] * viewZ + cameraProjectionMatrix[3][3];
    vec4 clip = vec4((vec3(uv, depth) - 0.5) * 2.0, 1.0) * clipW;
    return (cameraInverseProjectionMatrix * clip).xyz;
  }

  vec3 viewPosAt(vec2 uv) {
    return viewPosFromDepth(uv, readDepth(uv));
  }

  // Four-tap reconstruction that picks the nearer neighbour on each axis, so
  // silhouettes don't smear a normal across a depth discontinuity.
  vec3 normalFromDepth(vec2 uv, vec2 texel, vec3 P) {
    vec3 l = viewPosAt(uv - vec2(texel.x, 0.0));
    vec3 r = viewPosAt(uv + vec2(texel.x, 0.0));
    vec3 d = viewPosAt(uv - vec2(0.0, texel.y));
    vec3 u = viewPosAt(uv + vec2(0.0, texel.y));
    vec3 ddx = abs(l.z - P.z) < abs(r.z - P.z) ? (P - l) : (r - P);
    vec3 ddy = abs(d.z - P.z) < abs(u.z - P.z) ? (P - d) : (u - P);
    vec3 n = normalize(cross(ddx, ddy));
    return dot(n, P) > 0.0 ? -n : n;
  }

  // interleaved gradient noise — stable under motion, cheap, no texture
  float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }
`;

export const FULLSCREEN_VERT = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// ------------------------------------------------------------ ambient occlusion

export const AO_FRAG = /* glsl */ `
  #include <common>
  #include <packing>
  ${DEPTH_UTILS}

  uniform vec2 resolution;
  uniform float radius;
  uniform float intensity;
  uniform float bias;
  uniform float power;
  uniform float frame;

  in vec2 vUv;
  layout(location = 0) out vec4 fragColor;

  void main() {
    float depth = readDepth(vUv);
    // nothing was drawn here — the far plane is not occluded by anything
    if (depth >= 1.0) { fragColor = vec4(1.0); return; }

    vec2 texel = 1.0 / resolution;
    vec3 P = viewPosFromDepth(vUv, depth);
    vec3 N = normalFromDepth(vUv, texel, P);

    // Rotate the sample spiral per pixel and per frame; the bilateral blur and
    // the film grain hide what's left of the banding.
    float rot = ign(gl_FragCoord.xy + frame * 5.588238) * PI2;

    float occlusion = 0.0;
    for (int i = 0; i < AO_SAMPLES; i++) {
      float fi = float(i) + 0.5;
      float ang = fi * 2.39996323 + rot;
      float rad = radius * sqrt(fi / float(AO_SAMPLES));
      // cosine-ish hemisphere: spiral on the tangent disc, lifted along N
      vec3 t = normalize(abs(N.z) < 0.9 ? cross(N, vec3(0.0, 0.0, 1.0)) : cross(N, vec3(1.0, 0.0, 0.0)));
      vec3 b = cross(N, t);
      float lift = 0.25 + 0.75 * (fi / float(AO_SAMPLES));
      vec3 dir = normalize(t * cos(ang) + b * sin(ang) + N * lift);
      vec3 samplePos = P + dir * rad;

      vec4 clip = cameraProjectionMatrix * vec4(samplePos, 1.0);
      vec2 sUv = (clip.xy / clip.w) * 0.5 + 0.5;
      if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) continue;

      float sceneZ = viewPosAt(sUv).z;
      float diff = sceneZ - samplePos.z;
      // range check keeps a distant wall from occluding a near desk
      float range = smoothstep(0.0, 1.0, radius / max(1e-4, abs(P.z - sceneZ)));
      occlusion += step(bias, diff) * range;
    }

    // the power curve is what turns a faint grey wash into a corner
    float ao = pow(clamp(1.0 - (occlusion / float(AO_SAMPLES)) * intensity, 0.0, 1.0), power);
    fragColor = vec4(ao);
  }
`;

/** depth-aware separable blur — keeps AO from bleeding across silhouettes */
export const AO_BLUR_FRAG = /* glsl */ `
  #include <common>
  #include <packing>
  ${DEPTH_UTILS}

  uniform sampler2D tAO;
  uniform vec2 resolution;
  uniform vec2 direction;
  in vec2 vUv;
  layout(location = 0) out vec4 fragColor;

  void main() {
    vec2 texel = direction / resolution;
    float centerZ = viewPosAt(vUv).z;
    float sum = 0.0;
    float wsum = 0.0;
    for (int i = -3; i <= 3; i++) {
      float fi = float(i);
      vec2 uv = vUv + texel * fi;
      float w = exp(-fi * fi * 0.18);
      float z = viewPosAt(uv).z;
      w *= exp(-abs(z - centerZ) * 4.0);
      sum += texture(tAO, uv).r * w;
      wsum += w;
    }
    fragColor = vec4(sum / max(wsum, 1e-4));
  }
`;

// -------------------------------------------------------------- volumetrics

/**
 * Single-scattering raymarch through the dust. Light 0 is always the
 * inspector's flashlight and is the only one that samples a shadow map — it is
 * the beam the player is pointing, so it is the one whose occlusion is read as
 * a mistake if it's missing. Fixture beams hang from the ceiling with nothing
 * between them and the air, and go unshadowed.
 */
export const VOLUMETRIC_FRAG = /* glsl */ `
  #include <common>
  #include <packing>
  ${DEPTH_UTILS}

  uniform mat4 cameraMatrixWorld;
  uniform vec3 cameraPositionWorld;

  uniform vec3 lightPos[VOL_MAX_LIGHTS];
  uniform vec3 lightDir[VOL_MAX_LIGHTS];
  uniform vec3 lightColor[VOL_MAX_LIGHTS];
  // x: range, y: cos(outer), z: cos(inner), w: 1 = spot, 0 = point
  uniform vec4 lightParams[VOL_MAX_LIGHTS];
  uniform int lightCount;

  // three's shadow maps are comparison textures (PCFShadowMap sets
  // compareFunction on the depth texture). Binding one to a plain sampler2D is
  // a format/sampler mismatch and the driver drops the whole draw call — so
  // this material is GLSL3 and samples it as what it actually is, which also
  // buys hardware PCF for free.
  uniform highp sampler2DShadow tShadow;
  uniform mat4 shadowMatrix;
  uniform float shadowEnabled;

  uniform float density;
  uniform float anisotropy;
  uniform float maxDistance;
  uniform float frame;
  uniform float floorHeight;

  in vec2 vUv;
  layout(location = 0) out vec4 fragColor;

  float henyeyGreenstein(float cosT, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(1e-4, 1.0 + g2 - 2.0 * g * cosT), 1.5));
  }

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  // three octaves is enough to make the beam breathe without looking like TV
  float dustNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i);
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
      f.z);
  }

  float shadowAt(vec3 worldPos) {
    if (shadowEnabled < 0.5) return 1.0;
    vec4 sc = shadowMatrix * vec4(worldPos, 1.0);
    sc.xyz /= sc.w;
    // outside the flashlight's shadow frustum there is nothing to occlude with
    if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 || sc.z < 0.0) {
      return 1.0;
    }
    return texture(tShadow, vec3(sc.xy, sc.z - 0.0025));
  }

  void main() {
    float depth = readDepth(vUv);
    vec3 viewPos = viewPosFromDepth(vUv, depth);
    vec3 worldEnd = (cameraMatrixWorld * vec4(viewPos, 1.0)).xyz;

    vec3 ray = worldEnd - cameraPositionWorld;
    float rayLen = min(length(ray), maxDistance);
    if (rayLen < 0.01) { fragColor = vec4(0.0); return; }
    vec3 rayDir = normalize(ray);

    float stepLen = rayLen / float(VOL_STEPS);
    // dither the first step so the slices don't read as bands
    float jitter = ign(gl_FragCoord.xy + frame * 3.7141);

    vec3 acc = vec3(0.0);
    for (int s = 0; s < VOL_STEPS; s++) {
      float t = (float(s) + jitter) * stepLen;
      vec3 p = cameraPositionWorld + rayDir * t;

      // dust hangs low and drifts; thicker near the floor, thin at the ceiling
      float heightFall = exp(-max(0.0, p.y) / max(0.6, floorHeight * 0.55));
      // nothing scatters in the first half metre — that is the inside of the
      // lens, and it is where a naive march dumps all its energy
      float nearFade = smoothstep(0.0, 0.7, t);
      float wisp = 0.55 + 0.9 * dustNoise(p * 0.42 + vec3(0.0, frame * 0.004, frame * 0.011));
      float d = density * heightFall * wisp * nearFade;
      if (d < 1e-5) continue;

      for (int i = 0; i < VOL_MAX_LIGHTS; i++) {
        if (i >= lightCount) break;
        vec3 toLight = lightPos[i] - p;
        float dist = length(toLight);
        float range = lightParams[i].x;
        if (dist > range) continue;
        vec3 L = toLight / max(dist, 1e-4);

        float atten = clamp(1.0 - dist / range, 0.0, 1.0);
        atten *= atten;
        if (lightParams[i].w > 0.5) {
          float ca = dot(-L, lightDir[i]);
          atten *= smoothstep(lightParams[i].y, lightParams[i].z, ca);
        }
        if (atten < 1e-4) continue;

        // cos of the scattering angle: incident direction (light → particle,
        // i.e. -L) against the outgoing direction (particle → eye, -rayDir).
        // For a head-mounted flashlight that is ~180°, so the beam correctly
        // backscatters almost nothing into its own lens instead of veiling the
        // whole frame in milk. Shafts come from lights you are looking toward.
        float phase = henyeyGreenstein(dot(L, rayDir), anisotropy);
        float vis = (i == 0) ? shadowAt(p) : 1.0;
        acc += lightColor[i] * atten * phase * vis * d * stepLen;
      }
    }

    fragColor = vec4(acc, 1.0);
  }
`;

// -------------------------------------------------------------------- bloom

export const BLOOM_PREFILTER_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float threshold;
  uniform float knee;
  in vec2 vUv;
  layout(location = 0) out vec4 fragColor;

  void main() {
    vec3 c = texture(tDiffuse, vUv).rgb;
    float br = max(c.r, max(c.g, c.b));
    // soft knee so a fixture ramps into bloom instead of popping
    float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    float contrib = max(soft, br - threshold) / max(br, 1e-4);
    fragColor = vec4(c * contrib, 1.0);
  }
`;

/** 13-tap Call-of-Duty-style downsample: stable, no fireflies crawling */
export const BLOOM_DOWN_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 texel;
  in vec2 vUv;
  layout(location = 0) out vec4 fragColor;

  void main() {
    vec3 a = texture(tDiffuse, vUv + texel * vec2(-2.0,  2.0)).rgb;
    vec3 b = texture(tDiffuse, vUv + texel * vec2( 0.0,  2.0)).rgb;
    vec3 c = texture(tDiffuse, vUv + texel * vec2( 2.0,  2.0)).rgb;
    vec3 d = texture(tDiffuse, vUv + texel * vec2(-2.0,  0.0)).rgb;
    vec3 e = texture(tDiffuse, vUv).rgb;
    vec3 f = texture(tDiffuse, vUv + texel * vec2( 2.0,  0.0)).rgb;
    vec3 g = texture(tDiffuse, vUv + texel * vec2(-2.0, -2.0)).rgb;
    vec3 h = texture(tDiffuse, vUv + texel * vec2( 0.0, -2.0)).rgb;
    vec3 i = texture(tDiffuse, vUv + texel * vec2( 2.0, -2.0)).rgb;
    vec3 j = texture(tDiffuse, vUv + texel * vec2(-1.0,  1.0)).rgb;
    vec3 k = texture(tDiffuse, vUv + texel * vec2( 1.0,  1.0)).rgb;
    vec3 l = texture(tDiffuse, vUv + texel * vec2(-1.0, -1.0)).rgb;
    vec3 m = texture(tDiffuse, vUv + texel * vec2( 1.0, -1.0)).rgb;

    vec3 col = e * 0.125;
    col += (a + c + g + i) * 0.03125;
    col += (b + d + f + h) * 0.0625;
    col += (j + k + l + m) * 0.125;
    fragColor = vec4(col, 1.0);
  }
`;

/** 9-tap tent upsample, additively blended over the larger mip */
export const BLOOM_UP_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 texel;
  uniform float radius;
  in vec2 vUv;
  layout(location = 0) out vec4 fragColor;

  void main() {
    vec2 o = texel * radius;
    vec3 col = texture(tDiffuse, vUv + vec2(-o.x,  o.y)).rgb * 1.0;
    col += texture(tDiffuse, vUv + vec2( 0.0,  o.y)).rgb * 2.0;
    col += texture(tDiffuse, vUv + vec2( o.x,  o.y)).rgb * 1.0;
    col += texture(tDiffuse, vUv + vec2(-o.x,  0.0)).rgb * 2.0;
    col += texture(tDiffuse, vUv).rgb * 4.0;
    col += texture(tDiffuse, vUv + vec2( o.x,  0.0)).rgb * 2.0;
    col += texture(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb * 1.0;
    col += texture(tDiffuse, vUv + vec2( 0.0, -o.y)).rgb * 2.0;
    col += texture(tDiffuse, vUv + vec2( o.x, -o.y)).rgb * 1.0;
    fragColor = vec4(col / 16.0, 1.0);
  }
`;

// ---------------------------------------------------------------------- DOF

/** cheap separable blur of the scene, used as the out-of-focus plate */
export const BLUR_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 texel;
  uniform vec2 direction;
  in vec2 vUv;
  layout(location = 0) out vec4 fragColor;

  void main() {
    vec2 o = texel * direction;
    vec3 col = texture(tDiffuse, vUv).rgb * 0.227027;
    col += texture(tDiffuse, vUv + o * 1.3846).rgb * 0.316216;
    col += texture(tDiffuse, vUv - o * 1.3846).rgb * 0.316216;
    col += texture(tDiffuse, vUv + o * 3.2308).rgb * 0.070270;
    col += texture(tDiffuse, vUv - o * 3.2308).rgb * 0.070270;
    fragColor = vec4(col, 1.0);
  }
`;

// ---------------------------------------------------------------- composite

/**
 * Everything lands here: AO applied, light shafts added, bloom added, the
 * out-of-focus plate mixed in by circle-of-confusion, then exposure, ACES,
 * the floor's colour grade, and last the lens — aberration, vignette, grain.
 * Lens artefacts go after the grade so they read as the camera, not the room.
 */
export const COMPOSITE_FRAG = /* glsl */ `
  #include <common>
  #include <packing>
  ${DEPTH_UTILS}

  uniform sampler2D tDiffuse;
  uniform sampler2D tAO;
  uniform sampler2D tVolume;
  uniform sampler2D tBloom;
  uniform sampler2D tBlur;

  uniform float aoStrength;
  uniform float volumeStrength;
  uniform float bloomStrength;
  uniform float exposure;

  // grade
  uniform vec3 gradeLift;
  uniform vec3 gradeGain;
  uniform float gradeGamma;
  uniform float saturation;
  uniform vec3 shadowTint;
  uniform vec3 highlightTint;

  // lens
  uniform float grain;
  uniform float vignette;
  uniform float aberration;
  uniform float time;
  uniform float dofStrength;
  uniform float focusDistance;
  uniform float focusRange;

  in vec2 vUv;
  layout(location = 0) out vec4 fragColor;

  // what three's <colorspace_fragment> would have done on the way to the canvas
  vec3 linearToSRGB(vec3 c) {
    return mix(pow(c, vec3(0.41666)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
  }

  // ACES fitted, Stephen Hill's curve
  vec3 acesFilm(vec3 x) {
    const mat3 IN = mat3(
      0.59719, 0.07600, 0.02840,
      0.35458, 0.90834, 0.13383,
      0.04823, 0.01566, 0.83777);
    const mat3 OUT = mat3(
       1.60475, -0.10208, -0.00327,
      -0.53108,  1.10813, -0.07276,
      -0.07367, -0.00605,  1.07602);
    vec3 v = IN * x;
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return clamp(OUT * (a / b), 0.0, 1.0);
  }

  void main() {
    vec2 uv = vUv;

    // --- lens: sample the scene three times, once per channel, off-axis
    vec2 fromCenter = uv - 0.5;
    float r2 = dot(fromCenter, fromCenter);
    vec2 caOff = fromCenter * aberration * (1.0 + r2 * 4.0);

    vec3 col;
    col.r = texture(tDiffuse, uv + caOff).r;
    col.g = texture(tDiffuse, uv).g;
    col.b = texture(tDiffuse, uv - caOff).b;

    // --- depth of field: mix toward the blurred plate by circle of confusion
    #ifdef USE_DOF
    if (dofStrength > 0.001) {
      float depth = readDepth(uv);
      float viewZ = -perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
      float coc = clamp(abs(viewZ - focusDistance) / max(focusRange, 0.01), 0.0, 1.0);
      col = mix(col, texture(tBlur, uv).rgb, coc * dofStrength);
    }
    #endif

    // --- occlusion, then the light that never reached a surface
    #ifdef USE_AO
    float ao = texture(tAO, uv).r;
    col *= mix(1.0, ao, aoStrength);
    #endif

    #ifdef USE_VOLUME
    col += texture(tVolume, uv).rgb * volumeStrength;
    #endif

    #ifdef USE_BLOOM
    col += texture(tBloom, uv).rgb * bloomStrength;
    #endif

    // --- tone
    col = acesFilm(col * exposure);

    // --- grade: lift/gamma/gain, then a split tone, then saturation
    col = gradeLift + col * (gradeGain - gradeLift);
    col = pow(max(col, 0.0), vec3(gradeGamma));
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= mix(shadowTint, highlightTint, smoothstep(0.15, 0.75, luma));
    col = mix(vec3(luma), col, saturation);

    // --- lens, part two
    float vig = 1.0 - smoothstep(0.15, 0.85, r2 * (1.6 + vignette));
    col *= mix(1.0, vig, vignette + 0.15);

    float g = (ign(gl_FragCoord.xy + time * 71.31) - 0.5) * grain;
    col += g * (1.0 - luma * 0.5);

    fragColor = vec4(linearToSRGB(max(col, 0.0)), 1.0);
  }
`;
