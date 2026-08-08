import * as THREE from 'three';
import {
  AO_BLUR_FRAG,
  AO_FRAG,
  BLOOM_DOWN_FRAG,
  BLOOM_PREFILTER_FRAG,
  BLOOM_UP_FRAG,
  BLUR_FRAG,
  COMPOSITE_FRAG,
  FULLSCREEN_VERT,
  VOLUMETRIC_FRAG,
} from './shaders';
import type { QualityProfile } from './quality';

/**
 * The frame, start to finish:
 *
 *   scene ──▶ sceneRT (HDR, MSAA, + depth)
 *              ├─▶ AO         (half res, bilateral blurred)
 *              ├─▶ volumetric (half res, shadowed flashlight + fixtures)
 *              ├─▶ bloom      (mip pyramid, dual-filtered)
 *              ├─▶ DOF plate  (quarter res, only while documenting)
 *              └─▶ composite ─▶ canvas
 *
 * The scene is rendered to an offscreen target, so three leaves it untonemapped
 * and the buffer stays linear HDR — which is what lets the fixtures blow out
 * into bloom instead of clipping at white.
 */

export interface VolumetricLight {
  position: THREE.Vector3;
  /** for spots: unit vector the cone points along */
  direction: THREE.Vector3;
  /** colour premultiplied by intensity */
  color: THREE.Color;
  range: number;
  cosOuter: number;
  cosInner: number;
  spot: boolean;
}

/** the per-floor look: one grade per palette, applied after the tonemap */
export interface Grade {
  exposure: number;
  lift: THREE.Color;
  gain: THREE.Color;
  gamma: number;
  saturation: number;
  shadowTint: THREE.Color;
  highlightTint: THREE.Color;
  /** in-scattering density for the volumetric march */
  fogDensity: number;
  /** forward scattering; higher = tighter, dustier beams */
  anisotropy: number;
  bloomStrength: number;
}

const VOL_MAX_LIGHTS = 6;

/**
 * Rendering to a half-float target is an *extension* in WebGL2, not core. On a
 * device without it every offscreen buffer would be framebuffer-incomplete and
 * the game would be a black screen, so check once and fall back to 8-bit.
 * The cost of the fallback is headroom: the scene buffer clips at 1.0, so the
 * bloom threshold has to come down under it to catch a lit fixture at all.
 */
function hdrSupported(renderer: THREE.WebGLRenderer): boolean {
  const gl = renderer.getContext();
  return (
    gl.getExtension('EXT_color_buffer_float') !== null ||
    gl.getExtension('EXT_color_buffer_half_float') !== null
  );
}

function fsMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string | number> = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    defines,
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: false,
  });
}

export class Pipeline {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private profile: QualityProfile;

  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;

  private sceneRT!: THREE.WebGLRenderTarget;
  private aoRT!: THREE.WebGLRenderTarget;
  private aoBlurRT!: THREE.WebGLRenderTarget;
  private volRT!: THREE.WebGLRenderTarget;
  private bloomRTs: THREE.WebGLRenderTarget[] = [];
  private dofA!: THREE.WebGLRenderTarget;
  private dofB!: THREE.WebGLRenderTarget;

  private matAO!: THREE.ShaderMaterial;
  private matAOBlur!: THREE.ShaderMaterial;
  private matVol!: THREE.ShaderMaterial;
  private matPrefilter!: THREE.ShaderMaterial;
  private matDown!: THREE.ShaderMaterial;
  private matUp!: THREE.ShaderMaterial;
  private matBlur!: THREE.ShaderMaterial;
  private matComposite!: THREE.ShaderMaterial;

  /** CSS pixels */
  private width = 1;
  private height = 1;
  /** device pixel ratio actually in use, before the adaptive multiplier */
  private pixelRatio = 1;
  /** adaptive resolution multiplier, 1 = native */
  private dynamicScale = 1;
  private frameMs = 16.7;
  private lastScaleCheck = 0;
  private frame = 0;
  private time = 0;

  private volLights: VolumetricLight[] = [];
  private shadowSpot: THREE.SpotLight | null = null;
  private ceilingHeight = 2.7;

  /** half-float where the device allows it, 8-bit where it does not */
  private bufferType: THREE.TextureDataType = THREE.HalfFloatType;
  private hdr = true;

  adaptive = true;
  filmEffects = true;
  /** dev only: blit an intermediate buffer instead of the composite */
  debugView: 'none' | 'ao' | 'vol' | 'bloom' | 'depth' | 'scene' = 'none';
  debugGain = 1;
  /** dev: bypass the shadow lookup in the volumetric march */
  debugNoVolShadow = false;
  private matDebug!: THREE.ShaderMaterial;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    profile: QualityProfile,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.profile = profile;

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.hdr = hdrSupported(renderer);
    this.bufferType = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.applyRendererSettings();
    this.buildTargets(1, 1);
    this.buildMaterials();
  }

  /** true when the scene buffer can hold values above 1.0 */
  get hdrBuffers(): boolean {
    return this.hdr;
  }

  /**
   * The context can go away on a backgrounded tab or a driver reset. three
   * re-uploads textures and geometry by itself; render targets it does not.
   * Rebuild every buffer and material against the new context.
   */
  rebuildAfterContextLoss() {
    this.hdr = hdrSupported(this.renderer);
    this.bufferType = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.disposeTargets();
    this.disposeMaterials();
    this.applyRendererSettings();
    this.buildTargets(this.width, this.height);
    this.buildMaterials();
    this.setSize(this.width, this.height, this.pixelRatio);
    this.renderer.shadowMap.needsUpdate = true;
  }

  // ------------------------------------------------------------------ setup

  private applyRendererSettings() {
    const r = this.renderer;
    // the composite does the tonemapping, so the scene buffer stays linear HDR
    r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = this.profile.shadows;
    // PCFSoftShadowMap is deprecated in three 0.185 and silently falls back to
    // PCFShadowMap; ask for what we actually get. Hardware comparison plus a
    // linear filter is a 2x2 PCF tap, and `shadow.radius` widens it further.
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = this.profile.shadows;
  }

  setProfile(profile: QualityProfile) {
    const shadowsChanged = profile.shadows !== this.profile.shadows;
    this.profile = profile;
    this.applyRendererSettings();
    this.disposeTargets();
    this.disposeMaterials();
    this.dynamicScale = 1;
    this.buildTargets(this.width, this.height);
    this.buildMaterials();
    if (shadowsChanged) this.renderer.shadowMap.needsUpdate = true;
    this.setSize(this.width, this.height, this.pixelRatio);
  }

  get qualityProfile(): QualityProfile {
    return this.profile;
  }

  private makeRT(w: number, h: number, opts: THREE.RenderTargetOptions = {}) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: this.bufferType,
      depthBuffer: false,
      stencilBuffer: false,
      ...opts,
    });
    return rt;
  }

  private buildTargets(w: number, h: number) {
    const p = this.profile;
    const bw = Math.max(1, Math.round(w));
    const bh = Math.max(1, Math.round(h));

    const depth = new THREE.DepthTexture(bw, bh);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    this.sceneRT = new THREE.WebGLRenderTarget(bw, bh, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: this.bufferType,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depth,
      samples: p.msaa,
    });

    const aw = Math.max(1, Math.round(bw * p.aoScale));
    const ah = Math.max(1, Math.round(bh * p.aoScale));
    this.aoRT = this.makeRT(aw, ah, { format: THREE.RedFormat, type: THREE.UnsignedByteType });
    this.aoBlurRT = this.makeRT(aw, ah, { format: THREE.RedFormat, type: THREE.UnsignedByteType });

    const vw = Math.max(1, Math.round(bw * p.volScale));
    const vh = Math.max(1, Math.round(bh * p.volScale));
    this.volRT = this.makeRT(vw, vh);

    this.bloomRTs = [];
    for (let i = 0; i < p.bloomMips; i++) {
      const s = 2 ** (i + 1);
      this.bloomRTs.push(this.makeRT(bw / s, bh / s));
    }

    this.dofA = this.makeRT(bw / 4, bh / 4);
    this.dofB = this.makeRT(bw / 4, bh / 4);
  }

  private disposeTargets() {
    this.sceneRT?.depthTexture?.dispose();
    this.sceneRT?.dispose();
    this.aoRT?.dispose();
    this.aoBlurRT?.dispose();
    this.volRT?.dispose();
    this.bloomRTs.forEach((rt) => rt.dispose());
    this.bloomRTs = [];
    this.dofA?.dispose();
    this.dofB?.dispose();
  }

  private depthUniforms(): Record<string, THREE.IUniform> {
    return {
      tDepth: { value: this.sceneRT.depthTexture },
      cameraProjectionMatrix: { value: new THREE.Matrix4() },
      cameraInverseProjectionMatrix: { value: new THREE.Matrix4() },
      cameraNear: { value: this.camera.near },
      cameraFar: { value: this.camera.far },
    };
  }

  private buildMaterials() {
    const p = this.profile;

    this.matAO = fsMaterial(
      AO_FRAG,
      {
        ...this.depthUniforms(),
        resolution: { value: new THREE.Vector2(1, 1) },
        radius: { value: 0.9 },
        intensity: { value: 1.35 },
        bias: { value: 0.022 },
        power: { value: 1.6 },
        frame: { value: 0 },
      },
      { AO_SAMPLES: p.aoSamples },
    );

    this.matAOBlur = fsMaterial(AO_BLUR_FRAG, {
      ...this.depthUniforms(),
      tAO: { value: null },
      resolution: { value: new THREE.Vector2(1, 1) },
      direction: { value: new THREE.Vector2(1, 0) },
    });

    this.matVol = fsMaterial(
      VOLUMETRIC_FRAG,
      {
        ...this.depthUniforms(),
        cameraMatrixWorld: { value: new THREE.Matrix4() },
        cameraPositionWorld: { value: new THREE.Vector3() },
        lightPos: { value: Array.from({ length: VOL_MAX_LIGHTS }, () => new THREE.Vector3()) },
        lightDir: { value: Array.from({ length: VOL_MAX_LIGHTS }, () => new THREE.Vector3(0, -1, 0)) },
        lightColor: { value: Array.from({ length: VOL_MAX_LIGHTS }, () => new THREE.Color(0, 0, 0)) },
        lightParams: { value: Array.from({ length: VOL_MAX_LIGHTS }, () => new THREE.Vector4(1, 1, 1, 0)) },
        lightCount: { value: 0 },
        tShadow: { value: null },
        shadowMatrix: { value: new THREE.Matrix4() },
        shadowEnabled: { value: 0 },
        density: { value: 0.06 },
        anisotropy: { value: 0.72 },
        maxDistance: { value: 26 },
        frame: { value: 0 },
        floorHeight: { value: this.ceilingHeight },
      },
      { VOL_STEPS: Math.max(1, p.volSteps), VOL_MAX_LIGHTS },
    );

    this.matPrefilter = fsMaterial(BLOOM_PREFILTER_FRAG, {
      tDiffuse: { value: null },
      // an 8-bit scene buffer clips at white, so the knee has to sit under it
      threshold: { value: this.hdr ? 1.0 : 0.72 },
      knee: { value: this.hdr ? 0.55 : 0.2 },
    });

    this.matDown = fsMaterial(BLOOM_DOWN_FRAG, {
      tDiffuse: { value: null },
      texel: { value: new THREE.Vector2() },
    });

    this.matUp = fsMaterial(BLOOM_UP_FRAG, {
      tDiffuse: { value: null },
      texel: { value: new THREE.Vector2() },
      radius: { value: 1.0 },
    });
    this.matUp.blending = THREE.AdditiveBlending;
    this.matUp.transparent = true;

    this.matBlur = fsMaterial(BLUR_FRAG, {
      tDiffuse: { value: null },
      texel: { value: new THREE.Vector2() },
      direction: { value: new THREE.Vector2(1, 0) },
    });

    const defines: Record<string, string | number> = {};
    if (p.ao) defines.USE_AO = 1;
    if (p.volumetrics) defines.USE_VOLUME = 1;
    if (p.bloom) defines.USE_BLOOM = 1;
    if (p.dof) defines.USE_DOF = 1;

    this.matComposite = fsMaterial(
      COMPOSITE_FRAG,
      {
        ...this.depthUniforms(),
        tDiffuse: { value: null },
        tAO: { value: null },
        tVolume: { value: null },
        tBloom: { value: null },
        tBlur: { value: null },
        aoStrength: { value: 0.82 },
        volumeStrength: { value: 1.0 },
        bloomStrength: { value: 0.55 },
        exposure: { value: 1.5 },
        gradeLift: { value: new THREE.Color(0, 0, 0) },
        gradeGain: { value: new THREE.Color(1, 1, 1) },
        gradeGamma: { value: 1 },
        saturation: { value: 0.78 },
        shadowTint: { value: new THREE.Color(1, 1, 1) },
        highlightTint: { value: new THREE.Color(1, 1, 1) },
        grain: { value: 0.055 },
        vignette: { value: 0.22 },
        aberration: { value: 0.0035 },
        time: { value: 0 },
        dofStrength: { value: 0 },
        focusDistance: { value: 2 },
        focusRange: { value: 4 },
        dWarp: { value: 0 },
        dShake: { value: new THREE.Vector2() },
        dStatic: { value: 0 },
        dRed: { value: 0 },
        dFlash: { value: 0 },
        dCa: { value: 0 },
        dDark: { value: 0 },
        dPulse: { value: 0 },
      },
      defines,
    );

    this.matDebug = fsMaterial(
      /* glsl */ `
        #include <common>
        #include <packing>
        uniform sampler2D tSrc;
        uniform float mode;
        uniform float gain;
        uniform float near;
        uniform float far;
        in vec2 vUv;
        layout(location = 0) out vec4 fragColor;
        void main() {
          vec4 s = texture(tSrc, vUv);
          if (mode > 0.5) {
            // depth, linearized so the corridor is actually readable
            float vz = -perspectiveDepthToViewZ(s.x, near, far);
            fragColor = vec4(vec3(clamp(vz / far, 0.0, 1.0)), 1.0);
          } else {
            fragColor = vec4(s.rgb * gain, 1.0);
          }
        }
      `,
      {
        tSrc: { value: null },
        mode: { value: 0 },
        gain: { value: 1 },
        near: { value: 0.05 },
        far: { value: 60 },
      },
    );
  }

  private disposeMaterials() {
    this.matDebug?.dispose();
    for (const m of [
      this.matAO,
      this.matAOBlur,
      this.matVol,
      this.matPrefilter,
      this.matDown,
      this.matUp,
      this.matBlur,
      this.matComposite,
    ]) {
      m?.dispose();
    }
  }

  // ------------------------------------------------------------------ sizing

  setSize(cssW: number, cssH: number, pixelRatio: number) {
    this.width = cssW;
    this.height = cssH;
    this.pixelRatio = Math.min(pixelRatio, this.profile.maxPixelRatio);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(cssW, cssH, false);
    this.applyBufferSize();
  }

  private applyBufferSize() {
    const p = this.profile;
    const scale = this.pixelRatio * p.renderScale * this.dynamicScale;
    const bw = Math.max(1, Math.round(this.width * scale));
    const bh = Math.max(1, Math.round(this.height * scale));
    if (this.sceneRT.width === bw && this.sceneRT.height === bh) return;

    this.sceneRT.setSize(bw, bh);
    this.sceneRT.depthTexture!.image.width = bw;
    this.sceneRT.depthTexture!.image.height = bh;
    this.sceneRT.depthTexture!.needsUpdate = true;

    const aw = Math.max(1, Math.round(bw * p.aoScale));
    const ah = Math.max(1, Math.round(bh * p.aoScale));
    this.aoRT.setSize(aw, ah);
    this.aoBlurRT.setSize(aw, ah);
    this.volRT.setSize(Math.max(1, Math.round(bw * p.volScale)), Math.max(1, Math.round(bh * p.volScale)));
    this.bloomRTs.forEach((rt, i) => {
      const s = 2 ** (i + 1);
      rt.setSize(Math.max(1, Math.round(bw / s)), Math.max(1, Math.round(bh / s)));
    });
    this.dofA.setSize(Math.max(1, Math.round(bw / 4)), Math.max(1, Math.round(bh / 4)));
    this.dofB.setSize(Math.max(1, Math.round(bw / 4)), Math.max(1, Math.round(bh / 4)));
  }

  /**
   * Give back pixels before giving back frames. Steps are coarse and hysteretic
   * so the resolution settles instead of hunting, and it only ever moves once a
   * second — a resolution change mid-corridor should never be noticeable.
   */
  private governResolution(dt: number) {
    if (!this.adaptive) {
      if (this.dynamicScale !== 1) {
        this.dynamicScale = 1;
        this.applyBufferSize();
      }
      return;
    }
    const ms = dt * 1000;
    this.frameMs += (ms - this.frameMs) * 0.05;
    this.lastScaleCheck += dt;
    if (this.lastScaleCheck < 1) return;
    this.lastScaleCheck = 0;

    const STEPS = [0.55, 0.65, 0.75, 0.85, 1];
    let idx = STEPS.indexOf(this.dynamicScale);
    if (idx < 0) idx = STEPS.length - 1;
    // 60fps target with a wide dead band, so a steady 50fps doesn't oscillate
    if (this.frameMs > 21 && idx > 0) idx -= 1;
    else if (this.frameMs < 13.5 && idx < STEPS.length - 1) idx += 1;
    else return;

    this.dynamicScale = STEPS[idx];
    this.applyBufferSize();
  }

  // ------------------------------------------------------------- per-frame in

  setGrade(g: Grade) {
    const u = this.matComposite.uniforms;
    u.exposure.value = g.exposure;
    (u.gradeLift.value as THREE.Color).copy(g.lift);
    (u.gradeGain.value as THREE.Color).copy(g.gain);
    u.gradeGamma.value = g.gamma;
    u.saturation.value = g.saturation;
    (u.shadowTint.value as THREE.Color).copy(g.shadowTint);
    (u.highlightTint.value as THREE.Color).copy(g.highlightTint);
    u.bloomStrength.value = g.bloomStrength;
    this.matVol.uniforms.density.value = g.fogDensity;
    this.matVol.uniforms.anisotropy.value = g.anisotropy;
  }

  setCeilingHeight(h: number) {
    this.ceilingHeight = h;
    this.matVol.uniforms.floorHeight.value = h;
  }

  /** flashlight first — it is the only light whose shadow the march samples */
  setVolumetricLights(lights: VolumetricLight[]) {
    this.volLights = lights;
  }

  setShadowSource(spot: THREE.SpotLight | null) {
    this.shadowSpot = spot;
  }

  setDof(strength: number, focusDistance: number, focusRange: number) {
    const u = this.matComposite.uniforms;
    u.dofStrength.value = this.profile.dof ? strength : 0;
    u.focusDistance.value = focusDistance;
    u.focusRange.value = focusRange;
  }

  /**
   * The director's frame. Everything here is additive on top of the grade and
   * the lens, so with dread off the composite is bit-for-bit what it was.
   */
  setDread(d: {
    warp: number;
    shakeX: number;
    shakeY: number;
    staticAmt: number;
    red: number;
    flash: number;
    ca: number;
    dark: number;
    pulse: number;
  }) {
    const u = this.matComposite.uniforms;
    u.dWarp.value = d.warp;
    (u.dShake.value as THREE.Vector2).set(d.shakeX, d.shakeY);
    u.dStatic.value = d.staticAmt;
    u.dRed.value = d.red;
    u.dFlash.value = d.flash;
    u.dCa.value = d.ca;
    u.dDark.value = d.dark;
    u.dPulse.value = d.pulse;
  }

  setFilmEffects(on: boolean) {
    this.filmEffects = on;
    const u = this.matComposite.uniforms;
    u.grain.value = on ? 0.055 : 0;
    u.vignette.value = on ? 0.22 : 0.05;
    u.aberration.value = on ? 0.0035 : 0;
  }

  // ------------------------------------------------------------------ render

  private blit(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null, clear = true) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    if (clear) this.renderer.clear(true, false, false);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  private syncDepthUniforms(m: THREE.ShaderMaterial) {
    const u = m.uniforms;
    if (!u.tDepth) return;
    u.tDepth.value = this.sceneRT.depthTexture;
    (u.cameraProjectionMatrix.value as THREE.Matrix4).copy(this.camera.projectionMatrix);
    (u.cameraInverseProjectionMatrix.value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse);
    u.cameraNear.value = this.camera.near;
    u.cameraFar.value = this.camera.far;
  }

  render(dt: number) {
    this.governResolution(dt);
    this.time = (this.time + dt) % 1000;
    this.frame = (this.frame + 1) % 4096;

    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    // ---- 1. the scene itself, linear HDR, offscreen
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);

    const p = this.profile;
    const bw = this.sceneRT.width;
    const bh = this.sceneRT.height;

    // ---- 2. ambient occlusion, blurred along both axes with a depth guard
    if (p.ao) {
      this.syncDepthUniforms(this.matAO);
      (this.matAO.uniforms.resolution.value as THREE.Vector2).set(this.aoRT.width, this.aoRT.height);
      this.matAO.uniforms.frame.value = this.frame;
      this.blit(this.matAO, this.aoRT);

      this.syncDepthUniforms(this.matAOBlur);
      (this.matAOBlur.uniforms.resolution.value as THREE.Vector2).set(this.aoRT.width, this.aoRT.height);
      this.matAOBlur.uniforms.tAO.value = this.aoRT.texture;
      (this.matAOBlur.uniforms.direction.value as THREE.Vector2).set(1, 0);
      this.blit(this.matAOBlur, this.aoBlurRT);

      this.matAOBlur.uniforms.tAO.value = this.aoBlurRT.texture;
      (this.matAOBlur.uniforms.direction.value as THREE.Vector2).set(0, 1);
      this.blit(this.matAOBlur, this.aoRT);
    }

    // ---- 3. light that never reached a surface
    if (p.volumetrics && this.volLights.length > 0) {
      this.syncDepthUniforms(this.matVol);
      const u = this.matVol.uniforms;
      (u.cameraMatrixWorld.value as THREE.Matrix4).copy(this.camera.matrixWorld);
      this.camera.getWorldPosition(u.cameraPositionWorld.value as THREE.Vector3);
      const n = Math.min(this.volLights.length, p.volLights, VOL_MAX_LIGHTS);
      for (let i = 0; i < n; i++) {
        const l = this.volLights[i];
        (u.lightPos.value as THREE.Vector3[])[i].copy(l.position);
        (u.lightDir.value as THREE.Vector3[])[i].copy(l.direction);
        (u.lightColor.value as THREE.Color[])[i].copy(l.color);
        (u.lightParams.value as THREE.Vector4[])[i].set(
          l.range,
          l.cosOuter,
          l.cosInner,
          l.spot ? 1 : 0,
        );
      }
      u.lightCount.value = n;
      u.frame.value = this.frame;

      // Only sample it if it really is a comparison texture — a mismatched
      // sampler doesn't misdraw, it makes the driver discard the draw entirely.
      const depthTex = this.shadowSpot?.shadow?.map?.depthTexture;
      if (p.shadows && depthTex && depthTex.compareFunction) {
        u.tShadow.value = depthTex;
        (u.shadowMatrix.value as THREE.Matrix4).copy(this.shadowSpot!.shadow.matrix);
        u.shadowEnabled.value = this.debugNoVolShadow ? 0 : 1;
      } else {
        u.shadowEnabled.value = 0;
      }
      this.blit(this.matVol, this.volRT);
    } else if (p.volumetrics) {
      r.setRenderTarget(this.volRT);
      r.clear(true, false, false);
    }

    // ---- 4. bloom: prefilter, down the pyramid, then additively back up
    if (p.bloom && this.bloomRTs.length > 0) {
      this.matPrefilter.uniforms.tDiffuse.value = this.sceneRT.texture;
      this.blit(this.matPrefilter, this.bloomRTs[0]);
      for (let i = 1; i < this.bloomRTs.length; i++) {
        const src = this.bloomRTs[i - 1];
        this.matDown.uniforms.tDiffuse.value = src.texture;
        (this.matDown.uniforms.texel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
        this.blit(this.matDown, this.bloomRTs[i]);
      }
      for (let i = this.bloomRTs.length - 1; i > 0; i--) {
        const src = this.bloomRTs[i];
        this.matUp.uniforms.tDiffuse.value = src.texture;
        (this.matUp.uniforms.texel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
        this.blit(this.matUp, this.bloomRTs[i - 1], false);
      }
    }

    // ---- 5. the out-of-focus plate, only while the frame is being held
    const dofStrength = this.matComposite.uniforms.dofStrength.value as number;
    if (p.dof && dofStrength > 0.001) {
      this.matBlur.uniforms.tDiffuse.value = this.sceneRT.texture;
      (this.matBlur.uniforms.texel.value as THREE.Vector2).set(1 / bw, 1 / bh);
      (this.matBlur.uniforms.direction.value as THREE.Vector2).set(2, 0);
      this.blit(this.matBlur, this.dofA);

      this.matBlur.uniforms.tDiffuse.value = this.dofA.texture;
      (this.matBlur.uniforms.texel.value as THREE.Vector2).set(1 / this.dofA.width, 1 / this.dofA.height);
      (this.matBlur.uniforms.direction.value as THREE.Vector2).set(0, 2);
      this.blit(this.matBlur, this.dofB);
    }

    // ---- 6. composite to the canvas
    this.syncDepthUniforms(this.matComposite);
    const cu = this.matComposite.uniforms;
    cu.tDiffuse.value = this.sceneRT.texture;
    cu.tAO.value = this.aoRT.texture;
    cu.tVolume.value = this.volRT.texture;
    cu.tBloom.value = this.bloomRTs[0]?.texture ?? null;
    cu.tBlur.value = this.dofB.texture;
    cu.time.value = this.time;

    if (this.debugView !== 'none') {
      const src =
        this.debugView === 'ao' ? this.aoRT.texture
        : this.debugView === 'vol' ? this.volRT.texture
        : this.debugView === 'bloom' ? this.bloomRTs[0]?.texture ?? null
        : this.debugView === 'scene' ? this.sceneRT.texture
        : this.sceneRT.depthTexture;
      this.matDebug.uniforms.tSrc.value = src;
      this.matDebug.uniforms.mode.value = this.debugView === 'depth' ? 1 : 0;
      this.matDebug.uniforms.gain.value = this.debugView === 'vol' ? this.debugGain : 1;
      this.matDebug.uniforms.near.value = this.camera.near;
      this.matDebug.uniforms.far.value = this.camera.far;
      this.blit(this.matDebug, null);
    } else {
      this.blit(this.matComposite, null);
    }

    r.autoClear = prevAutoClear;
    r.setRenderTarget(null);
  }

  /** dev introspection for the debug views */
  get volLightCount(): number {
    return this.volLights.length;
  }

  /** for the FPS readout in settings */
  get smoothedFrameMs(): number {
    return this.frameMs;
  }

  get bufferSize(): { w: number; h: number; scale: number } {
    return { w: this.sceneRT.width, h: this.sceneRT.height, scale: this.dynamicScale };
  }

  dispose() {
    this.disposeTargets();
    this.disposeMaterials();
    this.quad.geometry.dispose();
  }
}
