import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// One full-screen pass: film grain, vignette, slight chromatic aberration,
// gentle desaturation. Restrained — photographic, not VHS.

const FilmShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    grain: { value: 0.055 },
    vignette: { value: 0.42 },
    aberration: { value: 0.0035 },
    desat: { value: 0.24 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float grain;
    uniform float vignette;
    uniform float aberration;
    uniform float desat;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7)) + time * 43.7) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec2 fromCenter = uv - 0.5;
      float r2 = dot(fromCenter, fromCenter);

      // chromatic aberration, radial and slight
      vec2 caOff = fromCenter * aberration * (1.0 + r2 * 4.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + caOff).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - caOff).b;

      // desaturate toward film gray
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(luma), desat);

      // grain, luma-weighted so shadows crawl a little
      float g = (hash(uv * vec2(1920.0, 1080.0)) - 0.5) * grain;
      col += g * (1.0 - luma * 0.5);

      // vignette
      float vig = 1.0 - smoothstep(0.15, 0.85, r2 * (1.6 + vignette));
      col *= mix(1.0, vig, vignette + 0.25);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class PostFX {
  composer: EffectComposer;
  private film: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.film = new ShaderPass(FilmShader);
    this.composer.addPass(this.film);
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
  }

  render(dt: number) {
    this.film.uniforms.time.value = (this.film.uniforms.time.value + dt) % 100;
    this.composer.render();
  }
}
