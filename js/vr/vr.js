// Overboard in VR (WebXR + three.js / WebGL2, sized for a Meta Quest 2).
// The WebGPU ocean is far too heavy for a standalone headset, so this is a lighter twin of
// the same voyage: a Gerstner sea computed identically on the GPU (mesh) and the CPU
// (buoyancy, the swimmer's eye), the same procedural ships, the same story: calm sunset,
// the helm, the storm, the rogue wave that knocks the sloop down and sweeps you overboard.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { buildShip, SHIP_TYPES, sloopWalkY, SLOOP_TILLER } from '../wgsl/boat.js';

const D2R = Math.PI / 180;
const G = 9.81;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------------------
// Sea state: calm sunset -> storm (blended by the story), wind towards WIND_DIR
// ---------------------------------------------------------------------------------------
const WIND_DIR = 118 * D2R;
const WIND = [Math.cos(WIND_DIR), Math.sin(WIND_DIR)];
const NW = 12;
// wavelengths (m), spread of directions about the wind, deterministic phases
const WAVES = [180, 128, 92, 66, 47, 34, 24, 17, 12, 8.6, 6.1, 4.3].map((L, i) => {
  const a = WIND_DIR + (((i * 7) % 5) - 2) * 0.22 * (i < 3 ? 0.5 : 1);
  const k = 2 * Math.PI / L;
  return { dx: Math.cos(a), dz: Math.sin(a), k, w: Math.sqrt(G * k), ph: i * 2.39, L };
});
// amplitude shares: long waves carry most of the height
const SHARE = WAVES.map((w) => Math.pow(w.L / 180, 0.9));
const SHARE_SUM = Math.sqrt(SHARE.reduce((s, x) => s + x * x, 0));
const SEA = {
  calm: { hs: 1.3, steep: 0.55, sunElev: 3.2, exposure: 0.55, fog: 0.00035 },
  storm: { hs: 4.6, steep: 0.85, sunElev: 3.2, exposure: 0.22, fog: 0.0016 },
};
const sea = { amp: new Float32Array(NW), qa: new Float32Array(NW), storm: 0, fog: SEA.calm.fog };
function setSea(s) {
  sea.storm = s;
  const hs = lerp(SEA.calm.hs, SEA.storm.hs, s), steep = lerp(SEA.calm.steep, SEA.storm.steep, s);
  for (let i = 0; i < NW; i++) {
    const A = (hs / 4) * Math.SQRT2 * SHARE[i] / SHARE_SUM * 1.4;
    sea.amp[i] = A;
    sea.qa[i] = Math.min(1, steep / (WAVES[i].k * A * NW)) * A;   // Q*A, never looping
  }
  sea.fog = lerp(SEA.calm.fog, SEA.storm.fog, s);
}
setSea(0);

// rogue wave: one steep crest in a Gaussian group (same shape as the WebGPU version)
const ROGUE_L = 180, ROGUE_K = 2 * Math.PI / ROGUE_L, ROGUE_C = Math.sqrt(G / ROGUE_K);
const rogue = { on: false, u: 0, amp: 0, ox: 0, oz: 0, dx: WIND[0], dz: WIND[1], sw: 120, lw: 520, q: 0 };

// Horizontal displacement and height at lagrangian point (x0, z0), time t.
function gerstner(x0, z0, t, out) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < NW; i++) {
    const w = WAVES[i];
    const th = w.k * (w.dx * x0 + w.dz * z0) - w.w * t + w.ph;
    const c = Math.cos(th), s = Math.sin(th);
    x += sea.qa[i] * w.dx * c; z += sea.qa[i] * w.dz * c; y += sea.amp[i] * s;
  }
  if (rogue.amp > 0) {
    const qx = x0 - rogue.ox, qz = z0 - rogue.oz;
    const u = qx * rogue.dx + qz * rogue.dz - rogue.u, v = -qx * rogue.dz + qz * rogue.dx;
    const env = rogue.amp * Math.exp(-(u * u) / (rogue.sw * rogue.sw) - (v * v) / (rogue.lw * rogue.lw));
    const hx = -rogue.q * env * Math.sin(ROGUE_K * u);
    x += rogue.dx * hx; z += rogue.dz * hx; y += env * Math.cos(ROGUE_K * u);
  }
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}
// Surface height under a world point (inverts the horizontal displacement).
const _g = [0, 0, 0];
function heightAt(x, z, t) {
  let x0 = x, z0 = z;
  for (let i = 0; i < 4; i++) { gerstner(x0, z0, t, _g); x0 = x - _g[0]; z0 = z - _g[2]; }
  return gerstner(x0, z0, t, _g)[1];
}

// ---------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------
const WAVE_GLSL = /* glsl */ `
uniform vec4 uW[${NW}];       // dir.xz, k, omega
uniform vec3 uA[${NW}];       // amplitude, Q*A, phase
uniform vec4 uRogueA;         // dir.xz, crest u, amplitude
uniform vec4 uRogueB;         // origin.xz, k, Q
uniform vec2 uRogueC;         // group length, crest length
uniform float uTime;
// displaced position, normal and a crest (foam) measure for lagrangian point x0
void wave(vec2 x0, out vec3 P, out vec3 N, out float foam) {
  vec3 d = vec3(0.0);
  vec3 n = vec3(0.0, 1.0, 0.0);
  float j = 1.0;
  for (int i = 0; i < ${NW}; i++) {
    vec4 w = uW[i];
    float th = w.z * dot(w.xy, x0) - w.w * uTime + uA[i].z;
    float c = cos(th), s = sin(th);
    d += vec3(uA[i].y * w.x * c, uA[i].x * s, uA[i].y * w.y * c);
    float wa = w.z * uA[i].x;
    n.x -= w.x * wa * c;
    n.z -= w.y * wa * c;
    n.y -= w.z * uA[i].y * s;
    j -= w.z * uA[i].y * s;
  }
  if (uRogueA.w > 0.0) {
    vec2 q = x0 - uRogueB.xy;
    float u = dot(q, uRogueA.xy) - uRogueA.z;
    float v = dot(q, vec2(-uRogueA.y, uRogueA.x));
    float env = uRogueA.w * exp(-(u * u) / (uRogueC.x * uRogueC.x) - (v * v) / (uRogueC.y * uRogueC.y));
    float k = uRogueB.z;
    float c = cos(k * u), s = sin(k * u);
    float hx = -uRogueB.w * env * s;
    d += vec3(uRogueA.x * hx, env * c, uRogueA.y * hx);
    float dy = -env * k * s;
    n.xz -= uRogueA.xy * dy;
    float jj = uRogueB.w * env * k * c;
    n.y -= jj;
    j -= jj;
  }
  P = vec3(x0.x, 0.0, x0.y) + d;
  N = normalize(n);
  foam = j;
}
`;

const OCEAN_VS = /* glsl */ `
${WAVE_GLSL}
uniform vec2 uCenter;
varying vec3 vWorld;
varying vec3 vN;
varying float vFoam;
varying float vDist;
void main() {
  vec2 x0 = position.xz + uCenter;
  vec3 P, N; float j;
  wave(x0, P, N, j);
  vWorld = P;
  vN = N;
  vFoam = j;
  vec4 mv = viewMatrix * vec4(P, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const OCEAN_FS = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyZen;
uniform vec3 uSkyHor;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uStorm;
uniform float uFlash;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vN;
varying float vFoam;
varying float vDist;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
vec3 sky(vec3 r) {
  float h = clamp(r.y, 0.0, 1.0);
  return mix(uSkyHor, uSkyZen, pow(h, 0.45));
}
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  // fine ripples the mesh cannot carry: two scrolling noise octaves bend the normal
  vec2 q = vWorld.xz;
  float fade = exp(-vDist / 60.0);
  vec2 rip = vec2(vnoise(q * 0.9 + uTime * vec2(0.31, 0.17)) - 0.5, vnoise(q * 0.9 - uTime * vec2(0.13, 0.29) + 7.0) - 0.5)
           + 0.5 * vec2(vnoise(q * 2.7 + uTime * 0.6) - 0.5, vnoise(q * 2.7 - uTime * 0.5 + 3.0) - 0.5);
  vec3 N = normalize(vN + vec3(rip.x, 0.0, rip.y) * (0.22 + 0.25 * uStorm) * fade);
  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 refl = sky(R);
  float spec = pow(max(dot(R, uSunDir), 0.0), mix(900.0, 300.0, uStorm)) * 60.0 * (1.0 - 0.9 * uStorm);
  vec3 deep = mix(vec3(0.010, 0.040, 0.055), vec3(0.012, 0.022, 0.028), uStorm);
  vec3 body = deep * (uSkyZen * 2.2 + uSunCol * max(uSunDir.y, 0.0) * 0.6);
  // light through backlit crests
  float crest = clamp(vWorld.y / 3.0, 0.0, 1.0) * pow(max(dot(-V, uSunDir), 0.0), 3.0);
  body += vec3(0.05, 0.22, 0.20) * uSunCol * crest * 0.35;
  vec3 col = mix(body, refl, F) + uSunCol * spec;
  // foam on breaking crests (Jacobian), broken into patches
  float n = vnoise(q * 0.35 + uTime * 0.05) * 0.6 + vnoise(q * 1.7) * 0.4;
  float foam = smoothstep(0.62 + 0.18 * uStorm, 0.12, vFoam) * smoothstep(0.25, 0.75, n + 0.35 * uStorm);
  vec3 foamCol = (uSkyZen * 1.6 + uSkyHor * 0.8 + uSunCol * max(uSunDir.y, 0.0) * 0.5) * 0.9;
  col = mix(col, foamCol, clamp(foam, 0.0, 1.0) * 0.9);
  col += vec3(0.6, 0.68, 0.85) * uFlash * 0.25;
  float T = exp(-vDist * uFog);
  col = mix(uFogCol, col, T);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------
// Ships
// ---------------------------------------------------------------------------------------
const MAT_COL = {
  sloop: { 0: 0xdcd9d0, 1: 0x8f8d86, 2: 0xd6d4cc, 3: 0xa9adb3, 4: 0xe9e3d3, 5: 0x6a4424, 6: 0xa9adb3, 10: 0xffb860, 11: 0x101010 },
  galleon: { 0: 0x2a1a0e, 1: 0x5a4128, 2: 0x5a4128, 3: 0x3a2614, 4: 0xa89c80, 5: 0x24170c, 6: 0x3a2614, 7: 0xa89c80, 8: 0x2c1c0e, 9: 0x0b0b0b, 10: 0xffb050, 11: 0x121212 },
};
function shipMaterial(type, m, blackSails) {
  const pal = type === 0 ? MAT_COL.sloop : MAT_COL.galleon;
  let col = pal[m] ?? 0x888888;
  if (blackSails && (m === 4 || m === 7)) col = 0x141312;
  const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
  if (type === 0 && (m === 3 || m === 6)) { mat.metalness = 0.8; mat.roughness = 0.35; }
  if (type === 0 && m === 0) mat.roughness = 0.25;
  if (m === 10) { mat.emissive = new THREE.Color(col); mat.emissiveIntensity = 3; }
  return mat;
}
// Splits buildShip() output into meshes: fixed parts, the fore-and-aft rig (mirrored to
// leeward), each mast's yards and square sails (braced about its pivot), the flag, and for
// the sloop the parts lost when she is dismasted.
function makeShipObject(type, blackSails) {
  const { verts, idx } = buildShip(type, { tiller: false });
  const nv = verts.length / 8;
  const parts = new Map();
  const partOf = (k) => {
    const m = Math.round(verts[k * 8 + 3]), piv = verts[k * 8 + 7];
    let key = 'fixed:' + m;
    if (m === 4 || m === 6) key = 'lee:' + m;
    else if (m === 7 || m === 8) key = 'brace:' + m + ':' + piv.toFixed(2);
    else if (m === 9) key = 'flag:' + piv.toFixed(2);
    else if (type === 0 && m === 3 && verts[k * 8 + 1] > 1.7) key = 'rig:3';
    return { key, m, piv };
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const pa = partOf(a);
    // a triangle belongs to the rig if any of its corners does (keeps the mast whole)
    let p = pa;
    if (type === 0 && pa.m === 3) { const pb = partOf(b), pc = partOf(c); if (pb.key === 'rig:3' || pc.key === 'rig:3') p = { ...pa, key: 'rig:3' }; }
    if (!parts.has(p.key)) parts.set(p.key, { m: p.m, piv: p.piv, tri: [] });
    parts.get(p.key).tri.push(a, b, c);
  }
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  const lee = new THREE.Group(), rig = new THREE.Group(), braces = [], flags = [];
  root.add(lee, rig);
  for (const [key, part] of parts) {
    const pos = new Float32Array(part.tri.length * 3), nrm = new Float32Array(part.tri.length * 3);
    part.tri.forEach((v, i) => {
      pos[i * 3] = verts[v * 8]; pos[i * 3 + 1] = verts[v * 8 + 1]; pos[i * 3 + 2] = verts[v * 8 + 2];
      nrm[i * 3] = verts[v * 8 + 4]; nrm[i * 3 + 1] = verts[v * 8 + 5]; nrm[i * 3 + 2] = verts[v * 8 + 6];
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    const mesh = new THREE.Mesh(geo, shipMaterial(type, part.m, blackSails));
    if (key.startsWith('lee:')) lee.add(mesh);
    else if (key.startsWith('rig:')) rig.add(mesh);
    else if (key.startsWith('brace:') || key.startsWith('flag:')) {
      const pivot = new THREE.Group();
      pivot.position.z = part.piv;
      mesh.position.z = -part.piv;
      pivot.add(mesh);
      root.add(pivot);
      (key.startsWith('flag:') ? flags : braces).push(pivot);
    } else root.add(mesh);
  }
  if (type === 0) {
    // the moving tiller, pivoting on the rudder stock
    const s = SLOOP_TILLER.stock, h = SLOOP_TILLER.handle;
    const tiller = new THREE.Group();
    tiller.position.set(s[0], s[1], s[2]);
    const len = Math.hypot(h[1] - s[1], h[2] - s[2]);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.036, len, 10), shipMaterial(0, 5));
    bar.rotation.x = Math.PI / 2 - Math.atan2(h[1] - s[1], h[2] - s[2]);
    bar.position.set(0, (h[1] - s[1]) / 2, (h[2] - s[2]) / 2);
    tiller.add(bar);
    root.add(tiller);
    root.userData.tiller = tiller;
  }
  root.userData.lee = lee; root.userData.rig = rig; root.userData.braces = braces; root.userData.flags = flags;
  return root;
}

// ---------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------
export async function startVR({ immersive }) {
  const qs = new URLSearchParams(location.search);
  const canvas = document.createElement('canvas');
  canvas.id = 'vrc';
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
  document.body.prepend(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = SEA.calm.exposure;
  renderer.xr.enabled = true;
  renderer.xr.setFoveation(1);
  renderer.xr.setReferenceSpaceType('local-floor');

  let started = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 6000);
  const rig = new THREE.Group();
  rig.matrixAutoUpdate = false;
  rig.add(camera);
  scene.add(rig);
  addEventListener('resize', () => {
    if (renderer.xr.isPresenting) return;
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  });

  // ---- sky, light, fog colour ----
  const sky = new Sky();
  sky.scale.setScalar(4500);
  scene.add(sky);
  const sunDir = new THREE.Vector3();
  const sunLight = new THREE.DirectionalLight(0xffd2a0, 2.2);
  const hemi = new THREE.HemisphereLight(0x8aa0c0, 0x10202a, 0.9);
  scene.add(sunLight, sunLight.target, hemi);
  // overcast deck: a dark dome that closes in as the storm builds
  const deck = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16),
    new THREE.MeshBasicMaterial({ color: 0x1b2028, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, fog: false }));
  scene.add(deck);
  const skyZen = new THREE.Color(), skyHor = new THREE.Color(), fogCol = new THREE.Color(), sunCol = new THREE.Color();
  function setSky(s) {
    const elev = SEA.calm.sunElev * D2R, az = 4 * D2R;
    sunDir.set(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev));
    const u = sky.material.uniforms;
    u.sunPosition.value.copy(sunDir);
    u.turbidity.value = lerp(6, 14, s); u.rayleigh.value = lerp(2.2, 0.6, s);
    u.mieCoefficient.value = lerp(0.006, 0.03, s); u.mieDirectionalG.value = lerp(0.85, 0.6, s);
    deck.material.opacity = 0.9 * smooth(0.15, 0.9, s);
    skyZen.setRGB(lerp(0.16, 0.05, s), lerp(0.22, 0.06, s), lerp(0.34, 0.075, s));
    skyHor.setRGB(lerp(0.95, 0.12, s), lerp(0.62, 0.13, s), lerp(0.38, 0.15, s));
    fogCol.setRGB(lerp(0.62, 0.075, s), lerp(0.46, 0.085, s), lerp(0.36, 0.1, s));
    sunCol.setRGB(lerp(1.6, 0.25, s), lerp(1.0, 0.25, s), lerp(0.55, 0.27, s));
    sunLight.position.copy(sunDir).multiplyScalar(100);
    sunLight.intensity = lerp(2.2, 0.25, s);
    hemi.intensity = lerp(0.9, 0.5, s);
    hemi.color.setRGB(lerp(0.75, 0.3, s), lerp(0.62, 0.33, s), lerp(0.6, 0.38, s));
    renderer.toneMappingExposure = lerp(SEA.calm.exposure, SEA.storm.exposure, s) * (1 + 3 * s);
    scene.environmentIntensity = lerp(0.6, 0.15, s);
  }
  setSky(0);
  // image-based light for the ships: the calm sky, filtered once
  {
    const pm = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const s2 = new Sky(); s2.scale.setScalar(100);
    for (const k of ['sunPosition', 'turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) {
      const v = sky.material.uniforms[k].value;
      s2.material.uniforms[k].value = v.clone ? v.clone() : v;
    }
    envScene.add(s2);
    scene.environment = pm.fromScene(envScene, 0, 0.1, 200).texture;
    scene.environmentIntensity = 0.6;
    pm.dispose();
  }

  // ---- ocean: a polar grid that travels with the viewer ----
  const RINGS = 72, SEGS = 128;
  const og = new THREE.BufferGeometry();
  {
    const pos = new Float32Array((RINGS + 1) * SEGS * 3);
    let k = 0;
    for (let r = 0; r <= RINGS; r++) {
      const rad = r === 0 ? 0 : 0.6 * (Math.pow(1.105, r) - 1) / 0.105;   // ~0.6 m near, ~3 km at the rim
      for (let s = 0; s < SEGS; s++) {
        const a = (s / SEGS) * Math.PI * 2;
        pos[k++] = Math.cos(a) * rad; pos[k++] = 0; pos[k++] = Math.sin(a) * rad;
      }
    }
    const index = [];
    for (let r = 0; r < RINGS; r++) {
      for (let s = 0; s < SEGS; s++) {
        const a = r * SEGS + s, b = r * SEGS + (s + 1) % SEGS, c = a + SEGS, d = b + SEGS;
        index.push(a, c, b, b, c, d);
      }
    }
    og.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    og.setIndex(index);
  }
  const waveUniforms = {
    uW: { value: WAVES.map((w) => new THREE.Vector4(w.dx, w.dz, w.k, w.w)) },
    uA: { value: WAVES.map(() => new THREE.Vector3()) },
    uRogueA: { value: new THREE.Vector4() }, uRogueB: { value: new THREE.Vector4() }, uRogueC: { value: new THREE.Vector2(120, 520) },
    uTime: { value: 0 },
  };
  const oceanMat = new THREE.ShaderMaterial({
    vertexShader: OCEAN_VS, fragmentShader: OCEAN_FS, side: THREE.DoubleSide,
    uniforms: {
      ...waveUniforms, uCenter: { value: new THREE.Vector2() },
      uSunDir: { value: sunDir }, uSunCol: { value: sunCol }, uSkyZen: { value: skyZen }, uSkyHor: { value: skyHor },
      uFogCol: { value: fogCol }, uFog: { value: sea.fog }, uStorm: { value: 0 }, uFlash: { value: 0 },
    },
  });
  const ocean = new THREE.Mesh(og, oceanMat);
  ocean.frustumCulled = false;
  scene.add(ocean);
  scene.fog = new THREE.FogExp2(fogCol, sea.fog);

  // ---- rain: streaks in a box that follows the head ----
  const RAIN_N = 1400;
  const rainGeo = new THREE.BufferGeometry();
  {
    // both ends of a streak share one drop position (wrapped once), plus which end it is
    const p = new Float32Array(RAIN_N * 6), end = new Float32Array(RAIN_N * 2);
    for (let i = 0; i < RAIN_N; i++) {
      const x = Math.random() * 30 - 15, y = Math.random() * 16, z = Math.random() * 30 - 15;
      p.set([x, y, z, x, y, z], i * 6);
      end[i * 2 + 1] = 1;
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    rainGeo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  }
  const rainMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uT: { value: 0 }, uHead: { value: new THREE.Vector3() }, uAmt: { value: 0 }, uWind: { value: new THREE.Vector2(WIND[0], WIND[1]) } },
    vertexShader: /* glsl */ `
      uniform float uT; uniform vec3 uHead; uniform vec2 uWind;
      attribute float aEnd;
      varying float vA;
      void main() {
        vec3 p = position;
        float fall = mod(p.y - uT * 9.0, 16.0);
        vec3 w = vec3(p.x + uWind.x * (16.0 - fall) * 0.5, fall - 6.0, p.z + uWind.y * (16.0 - fall) * 0.5);
        w.xz = mod(w.xz - uHead.xz + 15.0, 30.0) - 15.0;
        // the streak trails up and upwind of the drop
        vec3 wp = w + uHead + aEnd * vec3(-uWind.x * 0.25, 0.55, -uWind.y * 0.25);
        vA = 1.0;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `uniform float uAmt; void main() { gl_FragColor = vec4(0.7, 0.75, 0.82, 0.22 * uAmt); }`,
  });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false; rain.visible = false;
  scene.add(rain);

  // ---- fleet: the sloop and two pirate galleons astern ----
  const FLEET = [
    { type: 0, black: false, heel: 7, dth: 0, r: 220 },
    { type: 1, black: true, heel: 3, dth: -0.13, r: 250 },
    { type: 1, black: false, heel: 3, dth: -0.30, r: 285 },
  ];
  const fleet = { cx: 0, cz: -330, theta: Math.PI / 2 - 0.10 };
  for (const sh of FLEET) {
    sh.obj = makeShipObject(sh.type, sh.black);
    scene.add(sh.obj);
    sh.H = SHIP_TYPES[sh.type];
    const th = fleet.theta + sh.dth;
    sh.x = fleet.cx + sh.r * Math.cos(th); sh.z = fleet.cz + sh.r * Math.sin(th);
    sh.head = th + Math.PI; sh.v = (3 / 220) * sh.r;
    sh.side = 1; sh.brace = 0;
    sh.off = [0, 0, 0]; sh.vel = [0, 0, 0]; sh.ang = [0, 0, 0, 0]; sh.init = false;
    sh.right = new THREE.Vector3(); sh.up = new THREE.Vector3(); sh.fwd = new THREE.Vector3(); sh.pos = new THREE.Vector3();
  }
  const SL = FLEET[0];
  const helm = { rudder: 0, steered: false, capsize: -1, roll: 0, sink: 0, dismast: false, grab: null };
  const BOAT_SPEED = 3;

  function windRel(head) {
    return Math.atan2(WIND[0] * Math.cos(head) + WIND[1] * Math.sin(head), WIND[0] * Math.sin(head) - WIND[1] * Math.cos(head));
  }
  function sailFleet(dt) {
    if (helm.capsize >= 0) {
      SL.v += (0 - SL.v) * Math.min(1, dt * 0.8);
      const drift = 1.1 * smooth(2, 6, helm.capsize) * dt;
      SL.x += WIND[0] * drift; SL.z += WIND[1] * drift;
    } else {
      const turn = helm.steered ? helm.rudder * 0.16 : BOAT_SPEED / 220;
      SL.head += turn * Math.min(1, SL.v / 1.5) * dt;
      const vT = BOAT_SPEED * (1 - 0.85 * smooth(2.1, 2.7, Math.abs(windRel(SL.head))));
      SL.v += (vT - SL.v) * Math.min(1, dt * 0.4);
    }
    const fx = Math.sin(SL.head), fz = -Math.cos(SL.head), rx = Math.cos(SL.head), rz = Math.sin(SL.head);
    FLEET.forEach((sh, i) => {
      if (i > 0 && helm.capsize < 0) {
        const back = 45 + 40 * (i - 1), side = i === 1 ? -22 : 26;
        const tx = SL.x - fx * back + rx * side, tz = SL.z - fz * back + rz * side;
        const d = Math.hypot(tx - sh.x, tz - sh.z);
        const want = Math.atan2(tx - sh.x, -(tz - sh.z));
        sh.head += Math.max(-0.06 * dt, Math.min(0.06 * dt, wrapPi(want - sh.head)));
        sh.v += (Math.max(1.0, Math.min(6.5, SL.v + (d - 10) * 0.05)) - sh.v) * Math.min(1, dt * 0.3);
      } else if (i > 0) {
        const dx = sh.x - SL.x, dz = sh.z - SL.z;
        if (Math.hypot(dx, dz) < 120) sh.head += Math.max(-0.08 * dt, Math.min(0.08 * dt, wrapPi(Math.atan2(dx, -dz) - sh.head)));
        sh.v += (BOAT_SPEED * 1.3 - sh.v) * Math.min(1, dt * 0.2);
      }
      sh.x += Math.sin(sh.head) * sh.v * dt; sh.z += -Math.cos(sh.head) * sh.v * dt;
    });
  }
  // buoyancy: fit a plane to 15 points of the sea under the hull, then sprung heave/pitch/roll
  const _p = [0, 0, 0];
  function floatShip(sh, t, dt) {
    const H = sh.H, hd = sh.head;
    const fw = [Math.sin(hd), -Math.cos(hd)], rt = [Math.cos(hd), Math.sin(hd)];
    const pts = [];
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < 15; i++) {
      const s = -0.75 + Math.floor(i / 3) * 0.375;
      const hb = s > 0 ? 0.5 * H.B * Math.pow(Math.max(1 - Math.pow(s, H.entry), 1e-6), 0.55) : 0.5 * H.B * (1 - H.transom * s * s);
      const ox = rt[0] * ((i % 3) - 1) * 0.6 * hb + fw[0] * s * 0.5 * H.L;
      const oz = rt[1] * ((i % 3) - 1) * 0.6 * hb + fw[1] * s * 0.5 * H.L;
      gerstner(sh.x + ox, sh.z + oz, t, _p);
      const q = [ox + _p[0], _p[1], oz + _p[2]];
      pts.push(q); mx += q[0]; my += q[1]; mz += q[2];
    }
    mx /= 15; my /= 15; mz /= 15;
    let szy = 0, szz = 0, sxy = 0, sxx = 0;
    for (const q of pts) {
      const dx = q[0] - mx, dy = q[1] - my, dz = q[2] - mz;
      const lz = dx * fw[0] + dz * fw[1], lx = dx * rt[0] + dz * rt[1];
      szy += lz * dy; szz += lz * lz; sxy += lx * dy; sxx += lx * lx;
    }
    const pitchT = Math.atan(szy / Math.max(szz, 1e-4));
    const heel = sh.heel * D2R * sh.side * Math.min(1, sh.v / 3) * (1 + 0.5 * sea.storm) * (sh === SL && helm.dismast ? 0 : 1);
    const rollT = -Math.atan(sxy / Math.max(sxx, 1e-4)) + heel + (sh === SL ? helm.roll * (sh.side < 0 ? -1 : 1) : 0);
    if (!sh.init) { sh.off = [mx, my, mz]; sh.vel = [0, 0, 0]; sh.ang = [pitchT, 0, rollT, 0]; sh.init = true; }
    const sc = Math.sqrt(10 / H.L);
    const wl = [1.6 * sc, 3.0 * sc, 1.6 * sc], zl = [0.9, 0.6, 0.9], wp = 2.2 * sc, wr = 1.7 * sc;
    const m = [mx, my, mz];
    const h = Math.min(dt, 0.05) / 4;
    for (let k = 0; k < 4; k++) {
      for (let c = 0; c < 3; c++) {
        sh.vel[c] += (wl[c] * wl[c] * (m[c] - sh.off[c]) - 2 * zl[c] * wl[c] * sh.vel[c]) * h;
        sh.off[c] += sh.vel[c] * h;
      }
      sh.ang[1] += (wp * wp * (pitchT - sh.ang[0]) - 1.2 * wp * sh.ang[1]) * h; sh.ang[0] += sh.ang[1] * h;
      sh.ang[3] += (wr * wr * (rollT - sh.ang[2]) - 1.2 * wr * sh.ang[3]) * h; sh.ang[2] += sh.ang[3] * h;
    }
    const p = sh.ang[0], r = sh.ang[2];
    const f0 = new THREE.Vector3(fw[0], 0, fw[1]), r0 = new THREE.Vector3(rt[0], 0, rt[1]), Y = new THREE.Vector3(0, 1, 0);
    const f1 = f0.clone().multiplyScalar(Math.cos(p)).addScaledVector(Y, Math.sin(p));
    const u1 = Y.clone().multiplyScalar(Math.cos(p)).addScaledVector(f0, -Math.sin(p));
    sh.right.copy(r0).multiplyScalar(Math.cos(r)).addScaledVector(u1, -Math.sin(r));
    sh.up.copy(u1).multiplyScalar(Math.cos(r)).addScaledVector(r0, Math.sin(r));
    sh.fwd.copy(f1);
    sh.pos.set(sh.x + sh.off[0], sh.off[1] - (sh === SL ? helm.sink : 0), sh.z + sh.off[2]);
    sh.obj.matrix.makeBasis(sh.right, sh.up, sh.fwd).setPosition(sh.pos);
    sh.obj.matrixWorldNeedsUpdate = true;
    // rig: fore-and-aft sails to leeward, yards braced, flag downwind
    const rel = windRel(hd), lee = rel >= 0 ? 1 : -1;
    sh.side += (lee - sh.side) * Math.min(1, dt * 0.6);
    const braceT = Math.max(-0.55, Math.min(0.55, Math.abs(rel) > Math.PI / 2 ? rel - Math.PI * lee : rel));
    sh.brace += (braceT - sh.brace) * Math.min(1, dt * 0.5);
    const ud = sh.obj.userData;
    ud.lee.scale.x = Math.abs(sh.side) < 0.05 ? 0.05 * Math.sign(sh.side || 1) : sh.side;
    for (const b of ud.braces) b.rotation.y = sh.brace;
    for (const f of ud.flags) f.rotation.y = rel + Math.PI;
    if (sh === SL) ud.rig.visible = ud.lee.visible = !helm.dismast;
  }
  const toWorld = (sh, x, y, z, out) => out.copy(sh.pos).addScaledVector(sh.right, x).addScaledVector(sh.up, y).addScaledVector(sh.fwd, z);

  // ---- captions and panels (canvas textures floating in front of you) ----
  function makePanel(w, h, px = 1024) {
    const c = document.createElement('canvas');
    c.width = px; c.height = Math.round(px * h / w);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false, fog: false }));
    mesh.renderOrder = 30;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, c, ctx: c.getContext('2d'), tex };
  }
  const cap = makePanel(1.6, 0.22);
  let capT = 0;
  function caption(text) {
    const { ctx, c } = cap;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = 'italic 52px Georgia, serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 16;
    ctx.fillStyle = '#f1ebdf';
    ctx.fillText(text, c.width / 2, c.height / 2);
    cap.tex.needsUpdate = true;
    cap.mesh.visible = true; capT = 6;
    placeInFront(cap.mesh, 2.2, 0.25);
  }
  const head = new THREE.Vector3(), headQ = new THREE.Quaternion(), headFwd = new THREE.Vector3();
  function placeInFront(mesh, dist, dy) {
    camera.getWorldPosition(head);
    camera.getWorldQuaternion(headQ);
    headFwd.set(0, 0, -1).applyQuaternion(headQ).setY(0).normalize();
    mesh.position.copy(head).addScaledVector(headFwd, dist); mesh.position.y += dy;
    mesh.lookAt(head.x, mesh.position.y, head.z);
  }
  // end panel with two buttons
  const endP = makePanel(1.4, 0.8);
  const buttons = [];
  function drawEnd() {
    const { ctx, c } = endP;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(5,8,12,0.82)';
    ctx.beginPath(); ctx.roundRect(0, 0, c.width, c.height, 40); ctx.fill();
    ctx.fillStyle = '#f1ebdf'; ctx.textAlign = 'center';
    ctx.font = 'italic 110px Georgia, serif'; ctx.fillText('Overboard', c.width / 2, 150);
    ctx.font = '30px system-ui, sans-serif'; ctx.globalAlpha = 0.85;
    ctx.fillText('Dismasted but upright, your boat drifts away into the storm.', c.width / 2, 225);
    ctx.globalAlpha = 1;
    [['Play again', 0.3], ['Exit VR', 0.7]].forEach(([label, fx], i) => {
      const bx = c.width * fx, by = 420;
      ctx.fillStyle = i === 0 ? '#f1ebdf' : 'rgba(241,235,223,0.12)';
      ctx.beginPath(); ctx.roundRect(bx - 170, by - 50, 340, 100, 50); ctx.fill();
      ctx.strokeStyle = '#f1ebdf88'; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = i === 0 ? '#14100b' : '#f1ebdf';
      ctx.font = '600 40px system-ui, sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillText(label, bx, by);
    });
    endP.tex.needsUpdate = true;
  }
  drawEnd();
  buttons.push({ u0: 0.3 - 0.166, u1: 0.3 + 0.166, v0: 1 - (470 / 585), v1: 1 - (370 / 585), act: () => location.reload() });
  buttons.push({ u0: 0.7 - 0.166, u1: 0.7 + 0.166, v0: 1 - (470 / 585), v1: 1 - (370 / 585), act: () => renderer.xr.getSession()?.end() });

  // fade: a sphere around the head (black, or dark sea-blue under water)
  const fade = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 8),
    new THREE.MeshBasicMaterial({ color: 0x021016, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, fog: false, toneMapped: false }));
  fade.renderOrder = 40;
  camera.add(fade);
  let fadeTarget = 0, fadeSpeed = 2;

  // ---- controllers: rays for the panels, grip to take the tiller / swim strokes ----
  const factory = new XRControllerModelFactory();
  const hands = [0, 1].map((i) => {
    const ctrl = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i);
    grip.add(factory.createControllerModel(grip));
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0xf1ebdf, transparent: true, opacity: 0.6 }));
    ray.scale.z = 3; ray.visible = false;
    ctrl.add(ray);
    rig.add(ctrl, grip);
    const h = { ctrl, grip, ray, src: null, squeeze: false, prev: new THREE.Vector3(), has: false };
    ctrl.addEventListener('connected', (e) => { h.src = e.data; });
    ctrl.addEventListener('disconnected', () => { h.src = null; });
    ctrl.addEventListener('squeezestart', () => { h.squeeze = true; });
    ctrl.addEventListener('squeezeend', () => { h.squeeze = false; if (helm.grab === h) helm.grab = null; });
    ctrl.addEventListener('selectstart', () => clickPanel(h));
    return h;
  });
  const pulse = (h, v, ms) => { try { h.src?.gamepad?.hapticActuators?.[0]?.pulse(v, ms); } catch (e) { /* no haptics */ } };
  const raycaster = new THREE.Raycaster();
  function clickPanel(h) {
    if (!endP.mesh.visible) return;
    const m = new THREE.Matrix4().extractRotation(h.ctrl.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(h.ctrl.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(m);
    const hit = raycaster.intersectObject(endP.mesh)[0];
    if (!hit) return;
    const b = buttons.find((bt) => hit.uv.x > bt.u0 && hit.uv.x < bt.u1 && hit.uv.y > bt.v0 && hit.uv.y < bt.v1);
    if (b) { pulse(h, 0.6, 40); b.act(); }
  }

  // ---- audio: wind, rain and surf noise beds, thunder, the splash ----
  let audio = null;
  function initAudio() {
    if (audio) return;
    try {
      const ac = new AudioContext();
      const len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
      let b = 0;
      for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = (b + 0.02 * w) / 1.02; d[i] = w * 0.5 + b * 6; }
      const bed = (type, f, q) => {
        const s = ac.createBufferSource(); s.buffer = buf; s.loop = true;
        const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
        const g = ac.createGain(); g.gain.value = 0;
        s.connect(fl).connect(g).connect(ac.destination); s.start();
        return g;
      };
      audio = { ac, buf, wind: bed('bandpass', 420, 0.5), rain: bed('highpass', 2600, 0.4), surf: bed('lowpass', 260, 0.7) };
    } catch (e) { audio = false; }
  }
  function boom(delay, freq = 200, gain = 0.9, len = 4.5) {
    if (!audio) return;
    const { ac, buf } = audio;
    const s = ac.createBufferSource(); s.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = ac.createGain(), t0 = ac.currentTime + delay;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + len);
    s.connect(f).connect(g).connect(ac.destination); s.start(t0); s.stop(t0 + len + 0.5);
  }

  // ---- the voyage ----
  const V = { t: Number(qs.get('vt')) || 0, s: -1, rogue: false, faded: false, swimT: -1, ended: false, cap: 0, mode: 'ride' };
  const CAPTIONS = [
    [3, 'Heading into the sunset. Two pirate galleons astern.'],
    [16, 'Go aft and grab the tiller (grip) to steer.'],
    [45, 'The wind is shifting…'],
    [85, 'A storm is coming.'],
  ];
  const ride = { x: 0.35, z: -3.9, yaw: 0, snapReady: true };
  const swim = { x: 0, z: 0, yaw: 0 };
  const strike = { t: 99, next: 4 };
  let flash = 0;

  function updateStory(dt, t) {
    V.t += dt;
    while (V.cap < CAPTIONS.length && V.t >= CAPTIONS[V.cap][0]) caption(CAPTIONS[V.cap++][1]);
    const s = smooth(40, 110, V.t);
    if (Math.abs(s - V.s) > 0.002) { V.s = s; setSea(s); setSky(s); }
    // lightning
    strike.t += dt;
    if (s > 0.6) {
      strike.next -= dt * smooth(0.6, 1, s);
      if (strike.next <= 0) { strike.t = 0; strike.next = 4 + Math.random() * 9; boom(0.6 + Math.random() * 2.5, 180 + Math.random() * 200); }
    }
    flash = strike.t < 1.2 ? Math.exp(-strike.t * 6) * (0.55 + 0.45 * Math.cos(strike.t * 60)) : 0;
    // the rogue wave, aimed at the sloop
    if (!V.rogue && V.t > 112) {
      V.rogue = true;
      Object.assign(rogue, { on: true, u: -320, ox: SL.x, oz: SL.z, dx: WIND[0], dz: WIND[1] });
      caption('Something huge is rising behind you…');
    }
    if (rogue.on) {
      rogue.u += ROGUE_C * dt;
      const fadeIn = Math.min(1, (rogue.u + 480) / 120) * Math.min(1, Math.max(0, (450 - rogue.u) / 200));
      rogue.amp = 32 / 1.6 * fadeIn;
      rogue.q = Math.min(1.6, 0.68 / Math.max(ROGUE_K * rogue.amp, 1e-3));
      if (rogue.u > 450) { rogue.on = false; rogue.amp = 0; }
      const us = (SL.x - rogue.ox) * rogue.dx + (SL.z - rogue.oz) * rogue.dz;
      if (helm.capsize < 0 && rogue.u > us - 6) { helm.capsize = 0; helm.grab = null; }
    }
    // knockdown, dismasting, swept overboard
    if (helm.capsize >= 0) {
      helm.capsize += dt;
      const c = helm.capsize;
      helm.roll = 1.65 * smooth(0.1, 1.4, c) * (1 - smooth(3.4, 8, c));
      helm.sink = 0.45 * smooth(0.3, 1.5, c) * (1 - smooth(4, 8, c));
      if (c > 1.5) helm.dismast = true;
      if (c > 1.0 && !V.faded) { V.faded = true; fadeTarget = 1; fadeSpeed = 3; boom(0, 260, 1.0, 3); hands.forEach((h) => pulse(h, 1, 400)); }
      if (c > 2.6 && V.mode === 'ride') {
        V.mode = 'swim';
        swim.x = SL.x - WIND[1] * 13 - WIND[0] * 4; swim.z = SL.z + WIND[0] * 13 - WIND[1] * 4;
        // face the boat
        swim.yaw = Math.atan2(SL.x - swim.x, -(SL.z - swim.z));
        V.swimT = 0;
        fadeTarget = 0; fadeSpeed = 0.4;
        setTimeout(() => caption('You were swept overboard.'), 1500);
      }
    }
    if (V.mode === 'swim' && !V.ended) {
      V.swimT += dt;
      if (V.swimT - dt < 14 && V.swimT >= 14) caption('Your boat is drifting away without you.');
      if (V.swimT > 45) { V.ended = true; endP.mesh.visible = true; placeInFront(endP.mesh, 1.6, 0); }
    }
  }

  // ---- input ----
  const stick = (h) => {
    const a = h.src?.gamepad?.axes;
    if (!a) return [0, 0];
    return a.length >= 4 ? [a[2], a[3]] : [a[0] || 0, a[1] || 0];
  };
  const keys = Object.create(null);
  addEventListener('keydown', (e) => { keys[e.code] = true; });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  // flat (no headset) test controls: drag to look, WASD to walk
  let flatYaw = 0, flatPitch = 0, drag = false;
  canvas.addEventListener('pointerdown', () => { drag = true; initAudio(); });
  addEventListener('pointerup', () => { drag = false; });
  addEventListener('pointermove', (e) => { if (drag) { flatYaw -= e.movementX * 0.004; flatPitch = Math.max(-1.4, Math.min(1.4, flatPitch - e.movementY * 0.004)); } });

  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
  const rigUp = new THREE.Vector3(), rigF = new THREE.Vector3(), rigR = new THREE.Vector3();
  const swimF = new THREE.Vector3(), swimR = new THREE.Vector3();
  const COMFORT = 0.35;   // how much of the hull's pitch and roll you feel (the rest is levelled)
  function moveInput() {
    let mx = 0, my = 0, turn = 0;
    for (const h of hands) {
      if (!h.src) continue;
      const [sx, sy] = stick(h);
      if (h.src.handedness === 'left') { mx += sx; my += -sy; } else turn += sx;
    }
    if (!renderer.xr.isPresenting) {
      my += (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      mx += (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    }
    const dz = 0.2;
    return [Math.abs(mx) > dz ? mx : 0, Math.abs(my) > dz ? my : 0, turn];
  }
  function snapTurn(turn, obj) {
    if (Math.abs(turn) > 0.7 && obj.snapReady) { obj.yaw -= Math.sign(turn) * 30 * D2R; obj.snapReady = false; }
    if (Math.abs(turn) < 0.3) obj.snapReady = true;
  }
  // head direction in the horizontal plane of the given axes (for walking where you look)
  function headDir(fwdAxis, rightAxis) {
    camera.getWorldQuaternion(tmpQ);
    tmpV.set(0, 0, -1).applyQuaternion(tmpQ);
    const f = tmpV.dot(fwdAxis), r = tmpV.dot(rightAxis), l = Math.hypot(f, r) || 1;
    return [f / l, r / l];
  }

  function updateRide(dt) {
    const [mx, my, turn] = moveInput();
    snapTurn(turn, ride);
    if (helm.capsize < 0) {
      // walk the deck (ship-local x starboard, z bow)
      const [hf, hr] = headDir(SL.fwd, SL.right);
      const sp = 1.3 * dt;
      // forward in ship coords is (hr, hf), right is (hf, -hr)
      const dx = (hr * my + hf * mx) * sp, dzz = (hf * my - hr * mx) * sp;
      for (const [ax, az] of [[dx, dzz], [dx, 0], [0, dzz]]) {
        if ((ax || az) && sloopWalkY(ride.x + ax, ride.z + az) !== null) { ride.x += ax; ride.z += az; break; }
      }
    }
    const deckY = sloopWalkY(ride.x, ride.z) ?? 1.0;
    // rig frame: on the deck, levelled towards the horizon by (1 - COMFORT)
    rigUp.set(0, 1, 0).lerp(SL.up, COMFORT).normalize();
    rigF.copy(SL.fwd).addScaledVector(rigUp, -SL.fwd.dot(rigUp)).normalize();
    rigF.applyAxisAngle(rigUp, ride.yaw);
    rigR.crossVectors(rigF, rigUp);   // right = fwd x up
    toWorld(SL, ride.x, deckY, ride.z, tmpV);
    // rig axes: x = right, y = up, z = backwards (the camera looks down -z)
    rig.matrix.makeBasis(rigR, rigUp, tmpV2.copy(rigF).negate()).setPosition(tmpV);
    rig.matrixWorldNeedsUpdate = true;
    if (!renderer.xr.isPresenting) { camera.position.set(0, 1.62, 0); camera.rotation.set(flatPitch, flatYaw, 0, 'YXZ'); }
    updateTiller(dt);
  }
  // the tiller: grip near its end to take it; pushing it to port turns her to starboard
  const handleW = new THREE.Vector3(), gripW = new THREE.Vector3();
  function updateTiller(dt) {
    const ud = SL.obj.userData;
    const st = SLOOP_TILLER.stock;
    if (helm.capsize < 0) {
      if (!helm.grab) {
        // where is the handle now (it swings with the rudder)
        const ang = ud.tiller.rotation.y;
        const h = SLOOP_TILLER.handle, len = Math.hypot(h[2] - st[2], 0);
        toWorld(SL, st[0] + Math.sin(ang) * len, h[1], st[2] + Math.cos(ang) * len, handleW);
        for (const hd of hands) {
          if (!hd.squeeze || !hd.src) continue;
          hd.grip.getWorldPosition(gripW);
          if (gripW.distanceTo(handleW) < 0.3) { helm.grab = hd; pulse(hd, 0.5, 60); if (V.cap < 2) V.cap = 2; break; }
        }
      }
      if (helm.grab) {
        helm.grab.grip.getWorldPosition(gripW);
        tmpV.copy(gripW).sub(SL.pos);
        const lx = tmpV.dot(SL.right) - st[0], lz = tmpV.dot(SL.fwd) - st[2];
        const a = Math.max(-0.6, Math.min(0.6, Math.atan2(lx, lz)));
        ud.tiller.rotation.y = a;
        helm.rudder = -a / 0.6;
        helm.steered = true;
      } else if (!renderer.xr.isPresenting && (keys.KeyQ || keys.KeyE)) {
        // flat test: Q/E move the tiller
        const a = ((keys.KeyQ ? 1 : 0) - (keys.KeyE ? 1 : 0)) * 0.5;
        ud.tiller.rotation.y += (a - ud.tiller.rotation.y) * Math.min(1, dt * 3);
        helm.rudder = -ud.tiller.rotation.y / 0.6; helm.steered = true;
      } else {
        ud.tiller.rotation.y *= 1 - Math.min(1, dt * 0.5);
        helm.rudder = -ud.tiller.rotation.y / 0.6;
      }
    }
  }
  function updateSwim(dt, t) {
    const [mx, my, turn] = moveInput();
    snapTurn(turn, swim);
    const fwd = swimF.set(Math.sin(swim.yaw), 0, -Math.cos(swim.yaw)), rgt = swimR.set(Math.cos(swim.yaw), 0, Math.sin(swim.yaw));
    const [hf, hr] = headDir(fwd, rgt);
    let vx = (rgt.x * hr + fwd.x * hf) * my + (rgt.x * hf - fwd.x * hr) * mx;
    let vz = (rgt.z * hr + fwd.z * hf) * my + (rgt.z * hf - fwd.z * hr) * mx;
    vx *= 0.7; vz *= 0.7;
    // breaststroke: pull a gripped hand back and you glide forward
    for (const h of hands) {
      h.grip.getWorldPosition(gripW);
      if (h.squeeze && h.has) {
        const d = tmpV.copy(gripW).sub(h.prev);
        vx -= d.x / Math.max(dt, 1e-3) * 0.5; vz -= d.z / Math.max(dt, 1e-3) * 0.5;
      }
      h.prev.copy(gripW); h.has = true;
    }
    const sp = Math.hypot(vx, vz);
    if (sp > 1.5) { vx *= 1.5 / sp; vz *= 1.5 / sp; }
    swim.x += vx * dt; swim.z += vz * dt;
    const y = heightAt(swim.x, swim.z, t);
    const eye = renderer.xr.isPresenting ? camera.position.y : 1.62;
    rig.matrix.makeRotationY(-swim.yaw).setPosition(swim.x, y + 0.25 - eye, swim.z);
    rig.matrixWorldNeedsUpdate = true;
    if (!renderer.xr.isPresenting) { camera.position.set(0, 1.62, 0); camera.rotation.set(flatPitch, flatYaw, 0, 'YXZ'); }
  }

  // ---- frame loop ----
  let last = performance.now(), t = Number(qs.get('t')) || 0;
  const vOrigin = new THREE.Vector3();
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    if (started) updateStory(dt, t);
    sailFleet(started ? dt : dt);
    for (const sh of FLEET) floatShip(sh, t, dt);
    if (V.mode === 'swim') updateSwim(dt, t); else updateRide(dt);
    // uniforms
    waveUniforms.uTime.value = t;
    for (let i = 0; i < NW; i++) waveUniforms.uA.value[i].set(sea.amp[i], sea.qa[i], WAVES[i].ph);
    waveUniforms.uRogueA.value.set(rogue.dx, rogue.dz, rogue.u, rogue.amp);
    waveUniforms.uRogueB.value.set(rogue.ox, rogue.oz, ROGUE_K, rogue.q);
    camera.getWorldPosition(vOrigin);
    oceanMat.uniforms.uCenter.value.set(vOrigin.x, vOrigin.z);
    oceanMat.uniforms.uFog.value = sea.fog;
    oceanMat.uniforms.uStorm.value = sea.storm;
    oceanMat.uniforms.uFlash.value = flash;
    scene.fog.density = sea.fog * 0.6;
    sky.position.copy(vOrigin); deck.position.copy(vOrigin);
    rain.visible = sea.storm > 0.45;
    rainMat.uniforms.uT.value = t; rainMat.uniforms.uHead.value.copy(vOrigin); rainMat.uniforms.uAmt.value = smooth(0.45, 0.9, sea.storm);
    hemi.intensity += flash * 2;
    // fade sphere
    const fm = fade.material;
    fm.opacity += (fadeTarget - fm.opacity) * Math.min(1, dt * fadeSpeed * 2);
    fade.visible = fm.opacity > 0.01;
    // captions linger, then go
    if (capT > 0) { capT -= dt; if (capT <= 0) cap.mesh.visible = false; }
    // laser only when there is something to point at
    for (const h of hands) h.ray.visible = endP.mesh.visible;
    // audio beds follow the weather
    if (audio) {
      const k = Math.min(1, dt * 2);
      const ws = lerp(7, 16, sea.storm);
      audio.wind.gain.value += (Math.min(0.5, ws * ws / 700) - audio.wind.gain.value) * k;
      audio.rain.gain.value += (smooth(0.45, 0.9, sea.storm) * 0.1 - audio.rain.gain.value) * k;
      audio.surf.gain.value += (0.12 + sea.storm * 0.2 + rogue.amp * 0.02 - audio.surf.gain.value) * k;
    }
    renderer.render(scene, camera);
    hemi.intensity -= flash * 2;
  });

  // ---- entering VR ----
  async function enterVR() {
    initAudio();
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
    await renderer.xr.setSession(session);
    started = true;
    session.addEventListener('end', () => location.reload());
  }
  if (!immersive) { started = true; initAudio(); }
  return { enterVR, renderer };
}
