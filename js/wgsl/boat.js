// Ships: a 10 m sloop and a 30 m pirate galleon. Procedural geometry plus the WGSL shared
// with the ocean. Hulls are analytic (one parameter set per type), so the mesh, the water
// clipped inside the hull, the buoyancy samples and the reflection/shadow rays on the water
// all agree on one shape.
// Ship-local frame: x = starboard, y = up (0 = design waterline), z = towards the bow.
import { N, CASCADES, FRAME_WGSL, ROGUE_WGSL } from './common.js';

export const MAX_SHIPS = 4;

// Hull parameters. Stations s run from -1 (transom) to +1 (stem).
export const SHIP_TYPES = [
  { // 0: 10 m sloop
    L: 10, B: 3.3, deck0: 0.95, sheerF: 0.30, sheerA: 0.06, castleA: 0, castleF: 0, draft: 0.62, keelF: 0.25,
    keelA: 0.08, transom: 0.3, entry: 2.2, pAft: 0.30, pFwd: 0.65, tumble: 0, bulwark: 0, cabin: 1,
  },
  { // 1: 30 m galleon: deep U-shaped hull, tumblehome, high sterncastle and forecastle
    L: 30, B: 8.4, deck0: 2.7, sheerF: 1.0, sheerA: 0.5, castleA: 2.6, castleF: 1.4, draft: 3.0, keelF: 1.4,
    keelA: 0.9, transom: 0.42, entry: 1.7, pAft: 0.42, pFwd: 0.55, tumble: 0.16, bulwark: 1.0, cabin: 0,
  },
];
const SHAPE_KEYS = ['L', 'B', 'deck0', 'sheerF', 'sheerA', 'castleA', 'castleF', 'draft', 'keelF', 'keelA',
  'transom', 'entry', 'pAft', 'pFwd', 'tumble', 'bulwark', 'cabin'];

// ---- hull shape (mirrored in SHIP_SHAPE_WGSL) -------------------------------------------
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const topY = (h, s) => {
  const f = Math.max(s, 0), a = Math.min(s, 0);
  return h.deck0 + h.sheerF * f * f + h.sheerA * a * a + h.castleA * (1 - sstep(-0.78, -0.5, s)) + h.castleF * sstep(0.62, 0.82, s);
};
const keelY = (h, s) => -h.draft * Math.pow(Math.max(1 - s * s, 0), 0.55) + h.keelF * sstep(0.55, 1, s) + h.keelA * (1 - sstep(-1, -0.6, s));
const halfBeam = (h, s) => (s > 0 ? Math.pow(Math.max(1 - Math.pow(s, h.entry), 0), 0.55) : 1 - h.transom * s * s) * 0.5 * h.B;
const secPow = (h, s) => h.pAft + (h.pFwd - h.pAft) * sstep(-0.2, 1, s);
const hullHalfW = (h, s, y) => {
  const yk = keelY(h, s), t = clamp01((y - yk) / (topY(h, s) - yk));
  return halfBeam(h, s) * Math.pow(t, secPow(h, s)) * (1 - h.tumble * sstep(0.55, 1, t));
};
const walkY = (h, s) => topY(h, s) - h.bulwark;
// stations crowd towards the bow, where the hull curves fastest
const station = (u) => -1 + 2 * (1 - Math.pow(1 - u, 1.5));

// sloop cabin trunk
const CAB_S0 = -0.40, CAB_S1 = 0.28;
const SLOOP = SHIP_TYPES[0];
const cabinTop = (s) => topY(SLOOP, s) + 0.58 - 0.30 * sstep(0.12, CAB_S1, s);
const cabinHalfW = (s) => 0.62 * halfBeam(SLOOP, s);

const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---- sloop rig --------------------------------------------------------------------------
const MAST_S = 0.24, MAST_H = 13.5, BOOM_H = 1.05, BOOM_LEN = 4.3, BOOM_ANG = 0.32;
const MAST_Z = MAST_S * 0.5 * SLOOP.L;
const MAST_D = topY(SLOOP, MAST_S);
const MAST_TOP = [0, MAST_D + MAST_H, MAST_Z];
const BOOM_A = [0, MAST_D + BOOM_H, MAST_Z];
const BOOM_B = [Math.sin(BOOM_ANG) * BOOM_LEN, MAST_D + BOOM_H - 0.12, MAST_Z - Math.cos(BOOM_ANG) * BOOM_LEN];
const STEM = [0, topY(SLOOP, 1) + 0.04, 0.5 * SLOOP.L];
const FORESTAY_TOP = [0, MAST_D + MAST_H - 0.35, MAST_Z];
// sail corners (tack, head, clew), leeward = +x
const MAIN = [[0, BOOM_A[1] + 0.08, MAST_Z - 0.06], [0, MAST_TOP[1] - 0.45, MAST_Z - 0.06], lerp3(BOOM_A, BOOM_B, 0.96)];
MAIN[2][1] += 0.08;
const JIB = [[0, topY(SLOOP, 0.96) + 0.14, 0.96 * 0.5 * SLOOP.L], lerp3(STEM, FORESTAY_TOP, 0.84), [1.05, topY(SLOOP, 0.0) + 0.5, MAST_Z - 1.15]];

// ---- galleon rig ------------------------------------------------------------------------
const GAL = SHIP_TYPES[1];
// masts: station, height above the deck, sails as [bottom, top] fractions of the height
// with [bottom width, top width] in metres
const GAL_MASTS = [
  { s: 0.46, h: 24, sails: [[0.13, 0.40, 13.0, 12.0], [0.43, 0.68, 11.2, 9.0], [0.71, 0.86, 7.6, 5.6]] },
  { s: 0.02, h: 28, sails: [[0.12, 0.40, 15.0, 14.0], [0.43, 0.68, 13.0, 10.5], [0.71, 0.86, 9.0, 6.5]] },
  { s: -0.52, h: 17, sails: [[0.16, 0.45, 9.5, 8.6], [0.48, 0.74, 7.6, 5.8]] },
].map((m) => {
  const z = m.s * 0.5 * GAL.L, d = walkY(GAL, m.s);
  return { ...m, z, d, top: d + m.h };
});
const SPRIT_A = [0, topY(GAL, 0.95) - 0.3, 0.47 * GAL.L];
const SPRIT_B = [0, topY(GAL, 0.95) + 3.6, 0.5 * GAL.L + 8.5];
const GAL_JIB = [lerp3(SPRIT_A, SPRIT_B, 0.55), lerp3([0, GAL_MASTS[0].d, GAL_MASTS[0].z], [0, GAL_MASTS[0].top, GAL_MASTS[0].z], 0.62),
  [1.6, topY(GAL, 0.75) + 1.0, 0.36 * GAL.L]];
const FLAG_LEN = 3.4, FLAG_H = 2.2;
const FLAG_TOP = GAL_MASTS[1].top + 1.2;

// ---- mesh -------------------------------------------------------------------------------
// Interleaved vertices: position xyz + material, normal xyz + pivot z (32 bytes).
// Materials: 0 hull, 1 deck, 2 cabin, 3 spar, 4 fore-and-aft sail (mirrored to leeward),
// 5 rail, 6 boom (mirrored), 7 square sail and 8 yard (both braced about the mast at the
// pivot z), 9 flag, 10 lantern, 11 rigging.
export function buildShip(type) {
  const H = SHIP_TYPES[type];
  const pos = [], nrm = [], mat = [], piv = [], idx = [];
  function tri(a, b, c) {
    idx.push(a, b, c);
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { nrm[k * 3] += nx; nrm[k * 3 + 1] += ny; nrm[k * 3 + 2] += nz; }
  }
  // parametric patch with smooth normals, oriented along out(p) (a rough outward vector)
  function surf(rows, cols, at, m, out, pivot = 0) {
    const base = pos.length / 3;
    for (let i = 0; i <= rows; i++) {
      for (let j = 0; j <= cols; j++) {
        const p = at(i / rows, j / cols);
        pos.push(p[0], p[1], p[2]); nrm.push(0, 0, 0); mat.push(m); piv.push(pivot);
      }
    }
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const a = base + i * (cols + 1) + j, b = a + 1, c = a + cols + 1, d = c + 1;
        tri(a, c, d); tri(a, d, b);
      }
    }
    for (let k = base; k < pos.length / 3; k++) {
      const o = out([pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]]);
      let nx = nrm[k * 3], ny = nrm[k * 3 + 1], nz = nrm[k * 3 + 2];
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-12) { nx = o[0]; ny = o[1]; nz = o[2]; } else { nx /= l; ny /= l; nz /= l; }
      const sg = nx * o[0] + ny * o[1] + nz * o[2] < 0 ? -1 : 1;
      nrm[k * 3] = nx * sg; nrm[k * 3 + 1] = ny * sg; nrm[k * 3 + 2] = nz * sg;
    }
  }
  function tube(a, b, r0, r1, sides, m, pivot = 0) {
    const ax = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const al = Math.hypot(...ax);
    const d = ax.map((v) => v / al);
    const h = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let e1 = [d[1] * h[2] - d[2] * h[1], d[2] * h[0] - d[0] * h[2], d[0] * h[1] - d[1] * h[0]];
    const l1 = Math.hypot(...e1); e1 = e1.map((v) => v / l1);
    const e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    const ring = (u, v) => {
      const r = r0 + (r1 - r0) * u, ang = v * 2 * Math.PI, c = Math.cos(ang) * r, s = Math.sin(ang) * r;
      return [a[0] + ax[0] * u + e1[0] * c + e2[0] * s, a[1] + ax[1] * u + e1[1] * c + e2[1] * s, a[2] + ax[2] * u + e1[2] * c + e2[2] * s];
    };
    surf(1, sides, ring, m, (p) => {
      const t = (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2];
      return [p[0] - a[0] - d[0] * t, p[1] - a[1] - d[1] * t, p[2] - a[2] - d[2] * t];
    }, pivot);
  }
  // cambered fore-and-aft sail between luff (tack -> head) and leech (clew -> head)
  function sail(T, Hd, C, depth) {
    surf(18, 10, (v, u) => {
      const L = lerp3(T, Hd, v), R = lerp3(C, Hd, v);
      const p = lerp3(L, R, u);
      const cx = R[0] - L[0], cz = R[2] - L[2], chord = Math.hypot(cx, R[1] - L[1], cz);
      // horizontal normal of the chord, pointing to leeward (+x)
      const hl = (Math.hypot(cx, cz) || 1) * (cz > 0 ? -1 : 1);
      const b = depth * chord * 4 * u * (1 - u) * (1 - 0.35 * u);
      return [p[0] - (cz / hl) * b, p[1], p[2] + (cx / hl) * b];
    }, 4, () => [1, 0, 0]);
  }

  // hull topsides and bottom, both sides
  for (const sx of [1, -1]) {
    surf(64, 16, (u, v) => {
      const s = station(u), t = Math.pow(v, 2.2), yk = keelY(H, s), yt = topY(H, s);
      return [sx * hullHalfW(H, s, yk + (yt - yk) * t), yk + (yt - yk) * t, s * 0.5 * H.L];
    }, 0, (p) => [p[0], p[1] - 0.4 * H.draft, 0]);
  }
  // transom
  surf(16, 1, (u, v) => {
    const t = Math.pow(u, 2.2), yk = keelY(H, -1), yt = topY(H, -1), y = yk + (yt - yk) * t;
    return [(2 * v - 1) * hullHalfW(H, -1, y), y, -0.5 * H.L];
  }, 0, () => [0, 0, -1]);
  // deck (slight camber) inside the bulwarks
  const inset = H.bulwark > 0 ? 0.18 : 0;
  surf(64, 8, (u, v) => {
    const s = station(u), x = 2 * v - 1, y = walkY(H, s);
    const w = Math.max(hullHalfW(H, s, y) - inset, 0);
    return [x * w, y + 0.015 * H.B * (1 - x * x), s * 0.5 * H.L];
  }, 1, () => [0, 1, 0]);
  if (H.bulwark > 0) {
    // inner face of the bulwarks and the rail cap
    for (const sx of [1, -1]) {
      surf(64, 1, (u, v) => {
        const s = station(u), y = v < 0.5 ? walkY(H, s) : topY(H, s);
        return [sx * Math.max(hullHalfW(H, s, y) - inset, 0), y, s * 0.5 * H.L];
      }, 5, () => [-sx, 0, 0]);
      surf(64, 1, (u, v) => {
        const s = station(u), y = topY(H, s);
        return [sx * Math.max(hullHalfW(H, s, y) - inset * (1 - v), 0), y + 0.08, s * 0.5 * H.L];
      }, 5, () => [0, 1, 0]);
    }
  } else {
    for (const sx of [1, -1]) {
      surf(64, 1, (u, v) => {
        const s = station(u);
        return [sx * halfBeam(H, s), topY(H, s) + 0.07 * v, s * 0.5 * H.L];
      }, 5, () => [sx, 0, 0]);
    }
  }

  if (type === 0) {
    // cabin trunk: sides lean inwards, cambered roof, flat front and companionway faces
    const cabS = (u) => CAB_S0 + (CAB_S1 - CAB_S0) * u;
    const camber = (s, x) => topY(H, s) + 0.05 * (1 - (x / halfBeam(H, s)) ** 2);
    for (const sx of [1, -1]) {
      surf(12, 1, (u, v) => {
        const s = cabS(u), w = cabinHalfW(s);
        return v < 0.5 ? [sx * w, camber(s, w) - 0.02, s * 0.5 * H.L] : [sx * w * 0.88, cabinTop(s), s * 0.5 * H.L];
      }, 2, () => [sx, 0.2, 0]);
    }
    surf(12, 8, (u, v) => {
      const s = cabS(u), x = (2 * v - 1) * cabinHalfW(s) * 0.88;
      return [x, cabinTop(s) + 0.04 * (1 - (2 * v - 1) ** 2), s * 0.5 * H.L];
    }, 2, () => [0, 1, 0]);
    for (const [s, dz] of [[CAB_S1, 1], [CAB_S0, -1]]) {
      surf(1, 8, (v, u) => {
        const x = 2 * u - 1, w = cabinHalfW(s);
        return v < 0.5 ? [x * w, camber(s, x * w) - 0.02, s * 0.5 * H.L]
          : [x * w * 0.88, cabinTop(s) + 0.04 * (1 - x * x), s * 0.5 * H.L];
      }, 2, () => [0, 0, dz]);
    }
    // rig
    tube([0, MAST_D, MAST_Z], MAST_TOP, 0.085, 0.05, 12, 3);
    tube(BOOM_A, BOOM_B, 0.065, 0.05, 10, 6);
    tube(STEM, FORESTAY_TOP, 0.016, 0.016, 6, 3);
    tube(MAST_TOP, [0, topY(H, -1) + 0.05, -0.5 * H.L + 0.15], 0.014, 0.014, 6, 3);
    for (const sx of [1, -1]) {
      const plate = [sx * halfBeam(H, MAST_S - 0.05) * 0.94, topY(H, MAST_S - 0.05) + 0.03, MAST_Z - 0.25];
      tube([0, MAST_D + MAST_H * 0.8, MAST_Z], plate, 0.013, 0.013, 6, 3);
      tube([0, MAST_D + MAST_H - 0.3, MAST_Z], plate, 0.013, 0.013, 6, 3);
    }
    sail(MAIN[0], MAIN[1], MAIN[2], 0.10);
    sail(JIB[0], JIB[1], JIB[2], 0.12);
  } else {
    // masts, yards and square sails bellied forward by a following wind
    for (const m of GAL_MASTS) {
      tube([0, m.d - 0.5, m.z], [0, m.top + (m === GAL_MASTS[1] ? 1.4 : 0.4), m.z], 0.34 * m.h / 28, 0.12, 12, 3);
      for (const [b, t, wb, wt] of m.sails) {
        const yb = m.d + b * m.h, yt = m.d + t * m.h, hgt = yt - yb;
        surf(10, 14, (v, u) => {
          const w = wb + (wt - wb) * v;
          const belly = 0.14 * hgt * 4 * u * (1 - u) * (0.55 + 0.45 * Math.sin(Math.PI * v));
          // the foot curves up between the clews
          const y = yb + hgt * v + (1 - v) * 0.25 * hgt * 4 * u * (1 - u) * 0.35;
          return [(2 * u - 1) * w * 0.5, y, m.z + 0.5 + belly];
        }, 7, () => [0, 0, 1], m.z);
        tube([-wt * 0.55, yt + 0.15, m.z + 0.45], [wt * 0.55, yt + 0.15, m.z + 0.45], 0.16, 0.16, 8, 8, m.z);
        // shrouds from each sail's head to the rail
        for (const sx of [1, -1]) {
          const rail = [sx * hullHalfW(GAL, m.s - 0.04, topY(GAL, m.s - 0.04)), topY(GAL, m.s - 0.04) + 0.1, m.z - 1.4];
          tube([0, yt, m.z], rail, 0.045, 0.045, 5, 11);
        }
      }
    }
    tube(SPRIT_A, SPRIT_B, 0.32, 0.14, 10, 3);
    // stays: mast tops to each other and to the bowsprit
    tube([0, GAL_MASTS[0].top - 0.5, GAL_MASTS[0].z], SPRIT_B, 0.05, 0.05, 5, 11);
    tube([0, GAL_MASTS[1].top - 0.5, GAL_MASTS[1].z], [0, GAL_MASTS[0].top - 2, GAL_MASTS[0].z], 0.05, 0.05, 5, 11);
    tube([0, GAL_MASTS[2].top - 0.5, GAL_MASTS[2].z], [0, GAL_MASTS[1].d + 0.6 * GAL_MASTS[1].h, GAL_MASTS[1].z], 0.05, 0.05, 5, 11);
    sail(GAL_JIB[0], GAL_JIB[1], GAL_JIB[2], 0.10);
    // Jolly Roger: hoisted at the main masthead, flies downwind (animated in the shader)
    surf(10, 4, (u, v) => [0, FLAG_TOP - FLAG_H * (1 - v), GAL_MASTS[1].z - 0.1 - FLAG_LEN * u], 9, () => [1, 0, 0], GAL_MASTS[1].z);
    // stern lanterns
    const sy = topY(GAL, -1);
    for (const [lx, ly] of [[-2.1, 0.7], [2.1, 0.7], [0, 1.5]]) {
      tube([lx, sy + ly, -0.5 * GAL.L + 0.3], [lx, sy + ly + 0.7, -0.5 * GAL.L + 0.3], 0.26, 0.2, 6, 10);
    }
  }

  const nv = pos.length / 3;
  const verts = new Float32Array(nv * 8);
  for (let k = 0; k < nv; k++) {
    verts.set([pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2], mat[k], nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2], piv[k]], k * 8);
  }
  return { verts, idx: new Uint32Array(idx) };
}

const f3 = (x) => x.toFixed(4);
const v3 = (p) => 'vec3f(' + p.map(f3).join(', ') + ')';
const shapeCtor = (h) => 'Shape(' + SHAPE_KEYS.map((k) => f3(h[k])).join(', ') + ')';
const galSailQuad = (m) => {
  const lo = m.sails[0], hi = m.sails[m.sails.length - 1];
  return `vec4f(${f3(m.z)}, ${f3(m.d + lo[0] * m.h)}, ${f3(m.d + hi[1] * m.h)}, ${f3(lo[2] * 0.5)}), vec4f(${f3(hi[3] * 0.5)}, ${f3(m.d)}, ${f3(m.top)}, 0.0)`;
};

// ---- WGSL: hull shapes + ship state -----------------------------------------------------
export const SHIP_SHAPE_WGSL = /* wgsl */ `
const MAX_SHIPS: u32 = ${MAX_SHIPS}u;
const CAB_S0: f32 = ${f3(CAB_S0)};
const CAB_S1: f32 = ${f3(CAB_S1)};
const FLAG_LEN: f32 = ${f3(FLAG_LEN)};
const FLAG_H: f32 = ${f3(FLAG_H)};
const FLAG_TOP: f32 = ${f3(FLAG_TOP)};
const FLAG_Z: f32 = ${f3(GAL_MASTS[1].z)};

struct Shape {
  L: f32, B: f32, deck0: f32, sheerF: f32, sheerA: f32, castleA: f32, castleF: f32, draft: f32,
  keelF: f32, keelA: f32, transom: f32, entry: f32, pAft: f32, pFwd: f32, tumble: f32, bulwark: f32, cabin: f32,
};
fn shapeOf(t: f32) -> Shape {
  if (t > 0.5) { return ${shapeCtor(SHIP_TYPES[1])}; }
  return ${shapeCtor(SHIP_TYPES[0])};
}

// Written by SHIP_SIM each frame (local -> world: pos + right*x + up*y + fwd*z).
struct Ship {
  right: vec4f,   // xyz starboard axis, w = fore-and-aft sail side (-1 port .. +1 starboard)
  up:    vec4f,   // xyz, w = speed through the water (m/s)
  fwd:   vec4f,   // xyz bow axis, w = heave velocity (m/s)
  pos:   vec4f,   // xyz origin (midships, design waterline), w = yard brace angle (rad)
  lag:   vec4f,   // xy = undisplaced (lagrangian) position, zw = horizontal bow direction
  st0:   vec4f,   // physics: offset from the lagrangian position, w = initialised
  st1:   vec4f,   // velocity
  st2:   vec4f,   // pitch, pitch rate, roll, roll rate
  kind:  vec4f,   // hull type (0 sloop, 1 galleon), sail colour (0 canvas, 1 black), active, flag angle (rad)
};

fn topY(h: Shape, s: f32) -> f32 {
  let f = max(s, 0.0);
  let a = min(s, 0.0);
  return h.deck0 + h.sheerF * f * f + h.sheerA * a * a + h.castleA * (1.0 - smoothstep(-0.78, -0.5, s)) + h.castleF * smoothstep(0.62, 0.82, s);
}
fn walkY(h: Shape, s: f32) -> f32 { return topY(h, s) - h.bulwark; }
fn keelY(h: Shape, s: f32) -> f32 {
  return -h.draft * pow(max(1.0 - s * s, 1e-6), 0.55) + h.keelF * smoothstep(0.55, 1.0, s) + h.keelA * (1.0 - smoothstep(-1.0, -0.6, s));
}
fn halfBeam(h: Shape, s: f32) -> f32 {
  if (s > 0.0) { return 0.5 * h.B * pow(max(1.0 - pow(s, h.entry), 1e-6), 0.55); }
  return 0.5 * h.B * (1.0 - h.transom * s * s);
}
fn hullHalfW(h: Shape, s: f32, y: f32) -> f32 {
  let yk = keelY(h, s);
  let t = clamp((y - yk) / (topY(h, s) - yk), 1e-6, 1.0);
  return halfBeam(h, s) * pow(t, mix(h.pAft, h.pFwd, smoothstep(-0.2, 1.0, s))) * (1.0 - h.tumble * smoothstep(0.55, 1.0, t));
}
fn cabinTop(h: Shape, s: f32) -> f32 { return topY(h, s) + 0.58 - 0.30 * smoothstep(0.12, CAB_S1, s); }
fn cabinHalfW(h: Shape, s: f32) -> f32 { return 0.62 * halfBeam(h, s); }

// solid hull (+ cabin), shrunk by 'inset' metres
fn inHull(h: Shape, lp: vec3f, inset: f32) -> bool {
  let s = lp.z / (0.5 * h.L);
  if (abs(s) > 1.0 || lp.y < keelY(h, s) + inset) { return false; }
  if (lp.y <= topY(h, s) - inset) { return abs(lp.x) <= hullHalfW(h, s, lp.y) - inset; }
  return h.cabin > 0.5 && s > CAB_S0 && s < CAB_S1 && lp.y <= cabinTop(h, s) - inset && abs(lp.x) <= cabinHalfW(h, s) - inset;
}
`;

// Ray tests against the ships, for their reflections and shadows on the water.
// Requires SHIP_SHAPE_WGSL and a 'ships: array<Ship, MAX_SHIPS>' binding.
export const SHIP_RAY_WGSL = /* wgsl */ `
const MAIN_T: vec3f = ${v3(MAIN[0])};
const MAIN_H: vec3f = ${v3(MAIN[1])};
const MAIN_C: vec3f = ${v3(MAIN[2])};
const JIB_T: vec3f = ${v3(JIB[0])};
const JIB_H: vec3f = ${v3(JIB[1])};
const JIB_C: vec3f = ${v3(JIB[2])};
const SL_MAST_A: vec3f = ${v3([0, MAST_D, MAST_Z])};
const SL_MAST_B: vec3f = ${v3(MAST_TOP)};
// galleon: per mast (z, sails bottom y, sails top y, half width at the bottom), (half width at the top, mast foot y, mast top y, -)
const GAL_RIG: array<vec4f, 6> = array<vec4f, 6>(${GAL_MASTS.map(galSailQuad).join(', ')});

fn toShip(sh: Ship, p: vec3f) -> vec3f {
  let d = p - sh.pos.xyz;
  return vec3f(dot(d, sh.right.xyz), dot(d, sh.up.xyz), dot(d, sh.fwd.xyz));
}
fn toShipDir(sh: Ship, v: vec3f) -> vec3f { return vec3f(dot(v, sh.right.xyz), dot(v, sh.up.xyz), dot(v, sh.fwd.xyz)); }

fn rayTri(o: vec3f, d: vec3f, a: vec3f, b: vec3f, c: vec3f) -> f32 {
  let e1 = b - a;
  let e2 = c - a;
  let p = cross(d, e2);
  let det = dot(e1, p);
  if (abs(det) < 1e-9) { return -1.0; }
  let inv = 1.0 / det;
  let s = o - a;
  let u = dot(s, p) * inv;
  let q = cross(s, e1);
  let v = dot(d, q) * inv;
  if (u < 0.0 || v < 0.0 || u + v > 1.0) { return -1.0; }
  return dot(e2, q) * inv;
}

// closest approach of a ray to a segment: (distance, ray t)
fn raySeg(o: vec3f, d: vec3f, a: vec3f, b: vec3f) -> vec2f {
  let e = b - a;
  let w = o - a;
  let ee = dot(e, e);
  let de = dot(d, e);
  let den = max(ee - de * de, 1e-9);
  let sc = clamp((dot(d, w) * de - dot(e, w)) / -den, 0.0, 1.0);
  let tc = max(dot(a + e * sc - o, d), 0.0);
  let sc2 = clamp(dot(o + d * tc - a, e) / ee, 0.0, 1.0);
  return vec2f(distance(o + d * tc, a + e * sc2), tc);
}

// ray against an axis-aligned box: (t near, t far)
fn rayBox(o: vec3f, d: vec3f, bmin: vec3f, bmax: vec3f) -> vec2f {
  let dd = select(d, vec3f(1e-6), abs(d) < vec3f(1e-6));
  let t0 = (bmin - o) / dd;
  let t1 = (bmax - o) / dd;
  let tn = max(max(0.0, min(t0.x, t1.x)), max(min(t0.y, t1.y), min(t0.z, t1.z)));
  let tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
  return vec2f(tn, tf);
}

fn rotY(p: vec3f, pivotZ: f32, a: f32) -> vec3f {
  let z = p.z - pivotZ;
  return vec3f(p.x * cos(a) + z * sin(a), p.y, -p.x * sin(a) + z * cos(a) + pivotZ);
}

// x = coverage (0..1), y = what was hit: 0 hull, 1 sail, 2 spar
fn shipRay(i: u32, ro: vec3f, rd: vec3f) -> vec2f {
  let sh = ships[i];
  if (sh.kind.z < 0.5) { return vec2f(0.0); }
  let h = shapeOf(sh.kind.x);
  let o = toShip(sh, ro);
  let d = toShipDir(sh, rd);
  let gal = sh.kind.x > 0.5;
  // whole ship including the rig
  let top = select(15.0, 32.0, gal);
  let bow = select(0.5 * h.L, 0.5 * h.L + 9.0, gal);
  let bb = rayBox(o, d, vec3f(-0.5 * h.B - 8.0, -h.draft - 0.2, -0.5 * h.L - 1.0), vec3f(0.5 * h.B + 8.0, top, bow));
  if (bb.y <= bb.x) { return vec2f(0.0); }
  var best = 1e9;
  var kind = 2.0;
  var cov = 0.0;
  if (gal) {
    var rig = GAL_RIG;
    for (var m = 0; m < 3; m++) {
      let a = rig[m * 2];
      let b = rig[m * 2 + 1];
      let p0 = rotY(vec3f(-a.w, a.y, a.x + 0.5), a.x, sh.pos.w);
      let p1 = rotY(vec3f(a.w, a.y, a.x + 0.5), a.x, sh.pos.w);
      let p2 = rotY(vec3f(b.x, a.z, a.x + 0.5), a.x, sh.pos.w);
      let p3 = rotY(vec3f(-b.x, a.z, a.x + 0.5), a.x, sh.pos.w);
      var t = rayTri(o, d, p0, p1, p2);
      if (t <= 0.0) { t = rayTri(o, d, p0, p2, p3); }
      if (t > 0.0 && t < best) { best = t; kind = 1.0; cov = 1.0; }
      if (cov == 0.0) {
        let ms = raySeg(o, d, vec3f(0.0, b.y, a.x), vec3f(0.0, b.z, a.x));
        cov = max(cov, (1.0 - smoothstep(0.25, 0.5, ms.x)) * step(1e-4, ms.y));
      }
    }
  } else {
    let sx = vec3f(sh.right.w, 1.0, 1.0);
    let tm = rayTri(o, d, MAIN_T * sx, MAIN_H * sx, MAIN_C * sx);
    if (tm > 0.0) { best = tm; kind = 1.0; cov = 1.0; }
    let tj = rayTri(o, d, JIB_T * sx, JIB_H * sx, JIB_C * sx);
    if (tj > 0.0 && tj < best) { best = tj; kind = 1.0; cov = 1.0; }
    if (cov == 0.0) {
      let ms = raySeg(o, d, SL_MAST_A, SL_MAST_B);
      cov = (1.0 - smoothstep(0.06, 0.16, ms.x)) * step(1e-4, ms.y);
    }
  }
  // hull: march through its bounding box
  let hb = rayBox(o, d, vec3f(-0.5 * h.B, -h.draft - 0.1, -0.5 * h.L), vec3f(0.5 * h.B, h.deck0 + max(h.sheerF + h.castleF, h.sheerA + h.castleA) + 0.7, 0.5 * h.L));
  if (hb.y > hb.x && hb.x < best) {
    for (var k = 0; k < 24; k++) {
      let t = mix(hb.x, hb.y, (f32(k) + 0.5) / 24.0);
      if (t > best) { break; }
      if (inHull(h, o + d * t, 0.0)) { return vec2f(1.0, 0.0); }
    }
  }
  return vec2f(cov, kind);
}

// first ship hit by a ray: (coverage, kind, ship type, sail colour)
fn shipsRay(ro: vec3f, rd: vec3f) -> vec4f {
  var r = vec4f(0.0);
  for (var i = 0u; i < MAX_SHIPS; i++) {
    let h = shipRay(i, ro, rd);
    if (h.x > r.x) { r = vec4f(h, ships[i].kind.x, ships[i].kind.y); }
  }
  return r;
}

// inside any hull (the water there is not drawn)
fn inAnyHull(p: vec3f, inset: f32) -> bool {
  for (var i = 0u; i < MAX_SHIPS; i++) {
    let sh = ships[i];
    if (sh.kind.z > 0.5 && inHull(shapeOf(sh.kind.x), toShip(sh, p), inset)) { return true; }
  }
  return false;
}
`;

// Buoyancy: one workgroup per ship samples the water under 15 points of its hull, fits a
// plane through them and lets heave, surge/sway, pitch and roll follow it as damped springs
// (the hull length filters out the short waves; bigger hulls respond more slowly).
export const SHIP_SIM = FRAME_WGSL + SHIP_SHAPE_WGSL + /* wgsl */ `
struct ShipIn {
  base: vec4f,   // lagrangian x, z, heading (rad), speed (m/s)
  p:    vec4f,   // dt, heel (rad), sail side, reset
  q:    vec4f,   // hull type, sail colour, active, brace (rad)
  r:    vec4f,   // flag angle (rad), -, -, -
};
struct ShipU {
  ships: array<ShipIn, MAX_SHIPS>,
  cascL: array<vec4f, 2>,
  cascInvL: array<vec4f, 2>,
};
@group(0) @binding(0) var<uniform> U: ShipU;
@group(0) @binding(1) var dispTex: texture_2d_array<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read_write> ships: array<Ship, MAX_SHIPS>;
@group(0) @binding(4) var<uniform> F: Frame;
` + ROGUE_WGSL + /* wgsl */ `
var<workgroup> pts: array<vec3f, 15>;

@compute @workgroup_size(16)
fn main(@builtin(local_invocation_index) i: u32, @builtin(workgroup_id) wg: vec3u) {
  let si = U.ships[wg.x];
  let h = shapeOf(si.q.x);
  let hd = si.base.z;
  let fw = vec2f(sin(hd), -cos(hd));
  let rt = vec2f(cos(hd), sin(hd));
  if (i < 15u) {
    let s = -0.75 + f32(i / 3u) * 0.375;
    let off = rt * ((f32(i % 3u) - 1.0) * 0.6 * halfBeam(h, s)) + fw * (s * 0.5 * h.L);
    let x0 = si.base.xy + off;
    var d = rogueAt(x0).d;
    for (var c = 0u; c < ${CASCADES}u; c++) {
      let texel = U.cascL[c >> 2u][c & 3u] / ${N}.0;
      let lod = log2(max(0.07 * h.L / texel, 1.0));
      d += textureSampleLevel(dispTex, samp, x0 * U.cascInvL[c >> 2u][c & 3u], c, lod).xyz;
    }
    pts[i] = vec3f(off.x + d.x, d.y, off.y + d.z);
  }
  workgroupBarrier();
  if (i != 0u) { return; }

  var m = vec3f(0.0);
  for (var k = 0u; k < 15u; k++) { m += pts[k]; }
  m /= 15.0;
  var szy = 0.0; var szz = 0.0; var sxy = 0.0; var sxx = 0.0;
  for (var k = 0u; k < 15u; k++) {
    let q = pts[k] - m;
    let lz = dot(q.xz, fw);
    let lx = dot(q.xz, rt);
    szy += lz * q.y; szz += lz * lz;
    sxy += lx * q.y; sxx += lx * lx;
  }
  let pitchT = atan(szy / max(szz, 1e-4));
  let rollT = -atan(sxy / max(sxx, 1e-4)) + si.p.y;

  var sh = ships[wg.x];
  var off = sh.st0.xyz;
  var vel = sh.st1.xyz;
  var ang = sh.st2;
  if (si.p.w > 0.5 || sh.st0.w < 0.5) {
    off = m; vel = vec3f(0.0); ang = vec4f(pitchT, 0.0, rollT, 0.0);
  }
  // natural frequencies (rad/s) scale with 1/sqrt(length); keel and sails damp roll strongly
  let sc = sqrt(10.0 / h.L);
  let wl = vec3f(1.6, 3.0, 1.6) * sc;
  let zl = vec3f(0.9, 0.6, 0.9);
  let wp = 2.2 * sc;
  let wr = 1.7 * sc;
  let dt = si.p.x * 0.25;
  for (var k = 0; k < 4; k++) {
    vel += (wl * wl * (m - off) - 2.0 * zl * wl * vel) * dt;
    off += vel * dt;
    ang.y += (wp * wp * (pitchT - ang.x) - 1.2 * wp * ang.y) * dt;
    ang.x += ang.y * dt;
    ang.w += (wr * wr * (rollT - ang.z) - 1.2 * wr * ang.w) * dt;
    ang.z += ang.w * dt;
  }
  // heading, then pitch (bow up), then roll (starboard down)
  let f0 = vec3f(fw.x, 0.0, fw.y);
  let r0 = vec3f(rt.x, 0.0, rt.y);
  let f1 = f0 * cos(ang.x) + vec3f(0.0, sin(ang.x), 0.0);
  let u1 = vec3f(0.0, cos(ang.x), 0.0) - f0 * sin(ang.x);
  sh.right = vec4f(r0 * cos(ang.z) - u1 * sin(ang.z), si.p.z);
  sh.up = vec4f(u1 * cos(ang.z) + r0 * sin(ang.z), si.base.w);
  sh.fwd = vec4f(f1, vel.y);
  sh.pos = vec4f(si.base.x + off.x, off.y, si.base.y + off.z, si.q.w);
  sh.lag = vec4f(si.base.xy, fw);
  sh.st0 = vec4f(off, 1.0);
  sh.st1 = vec4f(vel, 0.0);
  sh.st2 = ang;
  sh.kind = vec4f(si.q.xyz, si.r.x);
  ships[wg.x] = sh;
}
`;
