// Ocean surface + sky background rendering.
import { FRAME_WGSL, ATMO_CORE_WGSL, ROGUE_WGSL, LAMP_WGSL, ENV_MIPS, ENV_SIZE, N, CASCADES } from './common.js';
import { SKY_RENDER_FUNCS, SKY_CLOUD_FUNCS } from './sky.js';
import { SHIP_SHAPE_WGSL, SHIP_RAY_WGSL } from './boat.js';

const RENDER_BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
`;

// Full-resolution sky + clouds. Cloud silhouettes are anti-aliased analytically: the
// screen-space derivative of each layer's edge function sets the width of its opacity edge.
export const SKY_BG = FRAME_WGSL + ATMO_CORE_WGSL + RENDER_BINDINGS + SKY_RENDER_FUNCS + SKY_CLOUD_FUNCS + LAMP_WGSL + /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
// night sky: one jittered star per lit cell of a grid wrapped around the view sphere
fn stars(dir: vec3f, pixAng: f32) -> vec3f {
  let c = floor(dir * 220.0);
  let h = fract(sin(dot(c, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
  if (h < 0.984) { return vec3f(0.0); }
  let j = vec3f(fract(h * 13.7), fract(h * 71.3), fract(h * 151.9));
  let sp = normalize(c + 0.2 + 0.6 * j);
  let d = length(dir - sp);
  let r = max(pixAng * 0.75, 0.0004);
  let b = pow(fract(h * 977.0), 4.0);
  let tint = mix(vec3f(0.75, 0.82, 1.0), vec3f(1.0, 0.86, 0.7), fract(h * 3.3));
  return tint * (exp(-d * d / (r * r)) * (0.15 + 4.0 * b));
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VO;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}
@fragment fn fs(in: VO) -> @location(0) vec4f {
  let dir = normalize(F.camFwd.xyz + in.ndc.x * F.camRight.xyz + in.ndc.y * F.camUp.xyz);
  let pixAng = 2.0 * length(F.camUp.xyz) * F.screen.w;
  var d2 = dir;
  d2.y = max(d2.y, 0.0005);
  d2 = normalize(d2);
  // edge functions at this pixel (uniform control flow, so fwidth is valid)
  let hl = hitLayer(d2, F.cloudP.x);
  let el = lowEdge(hl.q, hl.t * pixAng / hl.mu, 7);
  let hh = hitLayer(d2, 4.5);
  let eh = highEdge(hh.q, hh.t * pixAng / hh.mu, 6);
  let aa = vec2f(fwidth(el), fwidth(eh));
  var sunT = 1.0;
  let cl = cloudLayers(d2, pixAng, aa, &sunT);
  var L = skyAtmo(d2) * (1.0 - cl.a) + cl.rgb + sunDisk(dir) * sunT;
  if (F.night.x > 0.0 && dir.y > 0.0) {
    L += stars(dir, pixAng) * (F.night.x * F.sunDir.w * 0.12 * (1.0 - cl.a) * smoothstep(0.0, 0.08, dir.y));
  }
  // sea fog: the horizon dissolves into it; the lantern glows in it
  if (F.night.z > 0.0) {
    let fogT = exp(-F.night.z * 900.0 * (1.0 - smoothstep(0.0, 0.35, dir.y)));
    L = mix(skyAtmo(normalize(vec3f(dir.x, 0.002, dir.z))), L, fogT);
  }
  L += lampFog(dir, 3000.0);
  // lightning: a jagged bolt from the cloud base to the sea
  if (F.storm.x > 0.0) {
    let az = atan2(dir.x, -dir.z);
    let el = asin(clamp(dir.y, -1.0, 1.0));
    let top = 0.16;
    if (el > -0.002 && el < top) {
      let sd = F.storm.y * 13.7;
      let path = 0.018 * gnoise(vec2f(el * 22.0, sd)) + 0.007 * gnoise(vec2f(el * 85.0, sd + 4.0)) + 0.002 * gnoise(vec2f(el * 300.0, sd));
      var da = az - F.storm.y - path;
      da -= round(da / 6.2831853) * 6.2831853;
      let w = pixAng * 0.9 + 0.0006;
      let core = 1.0 - smoothstep(w, w * 2.5, abs(da));
      let glow = exp(-abs(da) / 0.01) * 0.15;
      L += vec3f(0.75, 0.82, 1.0) * (core * 900.0 + glow * 60.0) * F.storm.x * (1.0 - smoothstep(top - 0.03, top, el));
    }
  }
  return vec4f(L, 1.0);
}
`;

export const OCEAN = FRAME_WGSL + ATMO_CORE_WGSL + RENDER_BINDINGS + /* wgsl */ `
@group(0) @binding(4) var dispTex: texture_2d_array<f32>;
@group(0) @binding(5) var derivTex: texture_2d_array<f32>;
@group(0) @binding(6) var momTex: texture_2d_array<f32>;
@group(0) @binding(7) var foamTex: texture_2d<f32>;
@group(0) @binding(8) var envCube: texture_cube<f32>;
@group(0) @binding(9) var sampR: sampler;
@group(0) @binding(10) var foamWorld: texture_2d_array<f32>;
@group(0) @binding(11) var<storage, read> sunVis: array<f32, 4>;
@group(0) @binding(12) var<storage, read> ships: array<Ship, MAX_SHIPS>;
` + ROGUE_WGSL + SHIP_SHAPE_WGSL + SHIP_RAY_WGSL + SKY_RENDER_FUNCS + LAMP_WGSL + /* wgsl */ `
const ENV_MAXMIP: f32 = ${ENV_MIPS - 1}.0;
const ENV_TEXELS_PER_RAD: f32 = ${ENV_SIZE}.0 / 1.5708;
const TEX_N: f32 = ${N}.0;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) rel: vec3f,     // displaced position relative to the camera
  @location(1) xz: vec2f,      // undisplaced (lagrangian) coordinates
  @location(2) height: f32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) inst: vec4f) -> VSOut {
  let n = u32(F.lodP.y);
  let g = vec2f(f32(vi % (n + 1u)), f32(vi / (n + 1u)));
  let spacing = inst.z / f32(n);
  var xz = inst.xy + g * spacing;
  // CDLOD morph towards the next coarser level
  let R = F.lodP.x * exp2(inst.w);
  let d = distance(vec3f(xz.x, 0.0, xz.y), F.camPos.xyz);
  let mk = clamp((d - 0.8 * R) / (0.2 * R), 0.0, 1.0);
  xz -= fract(g * 0.5) * 2.0 * spacing * mk;
  let eff = spacing * (1.0 + mk);
  var disp = rogueAt(xz).d;
  for (var c = 0u; c < ${CASCADES}u; c++) {
    let texel = F.cascL[c >> 2u][c & 3u] / TEX_N;
    let lod = log2(max(eff / texel, 1.0)) + 0.5;
    if (lod < 8.0) {
      disp += textureSampleLevel(dispTex, sampR, xz * F.cascInvL[c >> 2u][c & 3u], c, lod).xyz;
    }
  }
  var o: VSOut;
  let world = vec3f(xz.x + disp.x, disp.y, xz.y + disp.z);
  o.rel = world - F.camPos.xyz;
  o.pos = F.viewProj * vec4f(o.rel, 1.0);
  o.xz = xz;
  o.height = disp.y;
  return o;
}

fn fresnelWater(c: f32) -> f32 {
  // Schlick with F0 for n = 1.333
  let x = 1.0 - clamp(c, 0.0, 1.0);
  let x2 = x * x;
  return 0.02 + 0.98 * x2 * x2 * x;
}

fn lambdaSmith(w: vec3f, cov: vec3f) -> f32 {
  let xz2 = max(dot(w.xz, w.xz), 1e-8);
  let il = inverseSqrt(xz2);
  let az = w.xz * il;
  let sig2 = az.x * az.x * cov.x + az.y * az.y * cov.y + 2.0 * az.x * az.y * cov.z;
  let cotT = w.y * il;
  let a = max(cotT, 1e-3) / sqrt(2.0 * max(sig2, 1e-7));
  if (a >= 1.6) { return 0.0; }
  return (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a);
}

fn foamPattern(xz: vec2f, t: f32) -> f32 {
  let a = textureSample(foamTex, sampR, xz * 0.23 + vec2f(0.013, 0.0) * t).r;
  let b = textureSample(foamTex, sampR, xz * 0.71 + vec2f(0.37, 0.71)).g;
  return a * 0.78 + b * 0.22;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let xz = in.xz;
  var s = vec2f(0.0);
  var jxx = 0.0;
  var jzz = 0.0;
  var jxz = 0.0;
  var cov = vec3f(0.0);
  // wind gusts ("cat's paws"): patches where the short ripples are stronger or calmer
  let gustN = textureSample(foamTex, sampR, xz * 0.011 + F.windP[0].xy * (F.camPos.w * 0.0004)).b;
  let gust = mix(0.35, 1.2, smoothstep(0.3, 0.72, gustN));
  for (var c = 0u; c < ${CASCADES}u; c++) {
    let uv = xz * F.cascInvL[c >> 2u][c & 3u];
    let gk = mix(1.0, gust, select(0.0, select(0.5, 1.0, c >= 4u), c >= 3u));
    let dv = textureSample(derivTex, sampR, uv, c) * gk;
    let mv = textureSample(momTex, sampR, uv, c) * (gk * gk);
    let av = textureSample(dispTex, sampR, uv, c) * gk;
    s += dv.xy;
    jxx += dv.z;
    jzz += dv.w;
    jxz += av.w;
    cov += vec3f(max(mv.x - dv.x * dv.x, 0.0), max(mv.y - dv.y * dv.y, 0.0), mv.z - dv.x * dv.y);
  }
  let rg = rogueAt(xz);
  s += rg.s;
  jxx += rg.jxx;
  jzz += rg.jzz;
  jxz += rg.jxz;
  let dist = length(in.rel);
  let V = -in.rel / dist;
  let Ld = F.sunDir.xyz;

  // slope statistics (LEAN): add unresolved capillary roughness + sun disk size
  // unresolved roughness; grows with distance to reach Cox-Munk-like totals in the far sheen
  let unres = F.waterCol.w + 0.0035 * smoothstep(30.0, 500.0, dist);
  cov.x += unres;
  cov.y += unres;
  let jx = max(1.0 + jxx, 0.15);
  let jz = max(1.0 + jzz, 0.15);
  let sl = vec2f(s.x / jx, s.y / jz);
  let nrm = normalize(vec3f(-sl.x, 1.0, -sl.y));
  // specular anti-aliasing: slope variation across the pixel widens the lobe
  let dsx = dpdx(sl);
  let dsy = dpdy(sl);
  let aa = vec3f(dsx.x * dsx.x + dsy.x * dsy.x, dsx.y * dsx.y + dsy.y * dsy.y, dsx.x * dsx.y + dsy.x * dsy.y) * 0.5;
  cov += aa * min(1.0, 0.03 / max(max(aa.x, aa.y), 1e-8));
  let J = (1.0 + jxx) * (1.0 + jzz) - jxz * jxz;

  // the ships' shadows (sails let some light through)
  let Pw = in.rel + F.camPos.xyz;
  let bsh = shipsRay(Pw, Ld);
  let sunE = sunIlluminance() * sunVis[0] * (1.0 - bsh.x * select(1.0, 0.7, bsh.y == 1.0));
  let skyUp = textureSampleLevel(envCube, sampC, vec3f(0.0, 1.0, 0.0), ENV_MAXMIP).rgb;
  // average radiance of the whole upper hemisphere (incl. the bright horizon band)
  let skyHemi = skyUp * 0.4 + 0.15 * (
      textureSampleLevel(envCube, sampC, vec3f(0.94, 0.34, 0.0), ENV_MAXMIP - 1.0).rgb +
      textureSampleLevel(envCube, sampC, vec3f(-0.94, 0.34, 0.0), ENV_MAXMIP - 1.0).rgb +
      textureSampleLevel(envCube, sampC, vec3f(0.0, 0.34, 0.94), ENV_MAXMIP - 1.0).rgb +
      textureSampleLevel(envCube, sampC, vec3f(0.0, 0.34, -0.94), ENV_MAXMIP - 1.0).rgb);
  let skyN = textureSampleLevel(envCube, sampC, nrm, ENV_MAXMIP - 1.0).rgb;

  // ---- sun glitter: anisotropic Gaussian slope distribution ----
  let Hv = normalize(V + Ld);
  let hs = -Hv.xz / max(Hv.y, 1e-3);
  let dsl = hs - sl;
  let det = max(cov.x * cov.y - cov.z * cov.z, 1e-10);
  let e = (dsl.x * dsl.x * cov.y + dsl.y * dsl.y * cov.x - 2.0 * dsl.x * dsl.y * cov.z) / det;
  let pdf = exp(-0.5 * e) / (2.0 * PI * sqrt(det));
  let hy2 = Hv.y * Hv.y;
  let Dm = pdf / max(hy2 * hy2, 1e-6);
  let G = 1.0 / (1.0 + lambdaSmith(V, cov) + lambdaSmith(Ld, cov));
  let Fh = fresnelWater(dot(V, Hv));
  let spec = sunE * (Fh * Dm * G / (4.0 * max(V.y, 0.02))) * step(0.0, Ld.y);

  // ---- sky reflection ----
  // At grazing angles the *visible* facets are biased towards the viewer (projected-area
  // weighting + masking), so the effective reflector tilts up and sees higher, greyer sky.
  let sig = sqrt(max(cov.x + cov.y, 1e-6) * 0.5);
  let vh = normalize(vec3f(V.x, 0.0, V.z) + vec3f(1e-5, 0.0, 0.0));
  let sigV = sqrt(max(vh.x * vh.x * cov.x + vh.z * vh.z * cov.y + 2.0 * vh.x * vh.z * cov.z, 1e-6));
  let aV = max(V.y, 1e-3) / max(sqrt(1.0 - V.y * V.y), 1e-3) / (1.4142 * sigV);
  let tilt = 0.32 * sigV * (1.0 - smoothstep(0.0, 2.5, aV));
  let nV = normalize(nrm + vh * tilt);
  var R = reflect(-V, nV);
  R.y = abs(R.y) * 0.4 + max(R.y, 0.0) * 0.6;
  R = normalize(R);
  let envLod = clamp(log2(max(2.0 * sig * ENV_TEXELS_PER_RAD, 1.0)), 0.0, ENV_MAXMIP);
  var refl = textureSampleLevel(envCube, sampC, R, envLod).rgb;
  // ships seen in the reflection (hulls in shade, sails glowing when backlit)
  let brf = shipsRay(Pw, R);
  if (brf.x > 0.0) {
    let gal = brf.z > 0.5;
    var bc = select(vec3f(0.78, 0.78, 0.76), vec3f(0.09, 0.06, 0.04), gal) * skyHemi * 1.3;
    if (brf.y == 1.0) {
      let cloth = select(vec3f(0.88, 0.85, 0.78), vec3f(0.62, 0.57, 0.47), gal);
      bc = select(cloth, vec3f(0.035), brf.w > 0.5) * (skyHemi * 1.2 + sunE * 0.12 * pow(max(dot(R, Ld), 0.0), 2.0));
    } else if (brf.y == 2.0) {
      bc = vec3f(0.15) * skyHemi;
    }
    refl = mix(refl, bc, brf.x);
  }
  let NdV = max(dot(nV, V), 0.0);
  // Fresnel from a partially smoothed normal: the long-wave facet plus the grazing-angle
  // statistics of everything finer (visible facets at grazing incidence stay highly reflective)
  let nF = normalize(mix(nrm, vec3f(0.0, 1.0, 0.0), 0.45));
  let Fr = fresnelWater(max(dot(nF, V), 0.0));

  // ---- water body: upwelling scatter + backlit subsurface glow ----
  let ambient = skyUp * 1.3 + skyN * 0.5;
  let NdL = max(dot(nrm, Ld), 0.0);
  // upwelling light is diffuse: light it with smooth terms only (no per-pixel normal noise)
  var body = F.waterCol.rgb * (skyHemi * 1.6 + sunE * max(Ld.y, 0.0) * 0.8);
  // light transmitted through the thin upper part of backlit crests
  let crest = clamp((in.height - 0.05) / 0.9, 0.0, 1.0);
  let toSun = max(dot(Ld, -V), 0.0);
  let thin = pow(clamp(0.5 - 0.5 * dot(Ld, nrm), 0.0, 1.0), 3.0);
  let k1 = F.sssCol.w * crest * crest * pow(toSun, 4.0) * thin * exp(-dist / 600.0);
  body += F.sssCol.rgb * sunE * k1;

  // ---- foam ----
  // persistent foam from the world-space clipmaps (near: fine, far: coarse), plus
  // instantaneous crest foam from the per-pixel Jacobian for anything beyond them
  let dc = abs(xz - F.camPos.xz);
  let cheb = max(dc.x, dc.y);
  let w0 = 1.0 - smoothstep(0.30 * F.lodP.z, 0.45 * F.lodP.z, cheb);
  let w1 = 1.0 - smoothstep(0.30 * F.lodP.w, 0.45 * F.lodP.w, cheb);
  let fw0 = textureSample(foamWorld, sampR, xz / F.lodP.z, 0u);
  let fw1 = textureSample(foamWorld, sampR, xz / F.lodP.w, 1u);
  let fwl = mix(fw1, fw0, w0) * w1;
  let fresh = clamp((F.foamP.x - J) * F.foamP.y, 0.0, 1.0);
  var cover = clamp((max(fwl.r, fresh * (1.0 - w1 * 0.7)) + fwl.g * 0.6) * F.foamP.z, 0.0, 1.5);
  // aged foam breaks into wind-aligned streaks; fresh crest foam stays dense
  let wd = F.windP[0].xy;
  let ws = vec2f(dot(xz, wd), dot(xz, vec2f(-wd.y, wd.x)));
  let streak = textureSample(foamTex, sampR, ws * vec2f(0.035, 0.11)).a;
  let freshK = clamp(fwl.g * 2.0 + fresh, 0.0, 1.0);
  cover *= mix(smoothstep(0.25, 0.75, streak) * 1.5, 1.0, freshK);
  let pat = foamPattern(xz, F.camPos.w);
  let fw = fwidth(pat) + 0.03;
  // soft threshold: thin foam is a translucent film, dense foam is opaque white
  // dense foam has crisp edges, thin decaying foam a soft translucent margin
  let soft = 0.04 + 0.14 * (1.0 - clamp(cover, 0.0, 1.0));
  let fm = smoothstep(1.0 - cover - fw - soft, 1.0 - cover + fw + soft, pat);
  var foamMask = clamp(fm * smoothstep(0.0, 0.5, cover), 0.0, 1.0) * (0.68 + 0.32 * smoothstep(0.3, 0.9, cover));
  // freshly broken crests: dense, almost opaque core
  foamMask = max(foamMask, smoothstep(0.35, 0.9, fwl.g) * smoothstep(0.25, 0.6, pat + 0.25) * 0.95);
  // submerged bubbles brighten and tint the water just beneath foam
  body += F.sssCol.rgb * (sunE * 0.05 + ambient * 0.35) * clamp(cover, 0.0, 1.0);
  body += vec3f(0.10, 0.32, 0.30) * skyUp * fwl.g * 0.35;
  // bubbly brightness variation inside the foam
  let bub = textureSample(foamTex, sampR, xz * 1.9 + vec2f(0.21, 0.53)).g;
  let foamAlb = vec3f(0.82, 0.87, 0.92) * (0.78 + 0.3 * bub);
  // diffuse: albedo * (sky irradiance / pi + sun * cos / pi); sky dominates at sunset
  // foam scatters light from the whole hemisphere (incl. the cool zenith): use a less saturated ambient
  let foamAmb = skyHemi * 1.0 + skyN * 0.3;
  let foamAmbN = mix(foamAmb, vec3f(dot(foamAmb, vec3f(0.2126, 0.7152, 0.0722))), 0.85);
  // grazing sun is largely self-shadowed by the foam's lumpy micro-structure
  var foamLit = foamAlb * (sunE * max(dot(nrm, Ld), 0.0) * 0.318 * 0.5 + foamAmbN * 1.55);

  if (F.post.w > 0.5) {
    // debug: r = foam cover, g = clamp(J), b = world foam level-0 weight
    if (F.post.w < 1.5) { return vec4f(cover, clamp(J * 0.5, 0.0, 1.0), w0 * 0.3, 1.0) * 0.2; }
    if (F.post.w > 2.5 && F.post.w < 3.5) { return vec4f(refl, 1.0); }
    if (F.post.w > 3.5 && F.post.w < 4.5) { return vec4f(vec3f(Fr), 1.0) * 0.5; }
    if (F.post.w > 4.5 && F.post.w < 5.5) { return vec4f(body * (1.0 - Fr), 1.0); }
    if (F.post.w > 5.5 && F.post.w < 6.5) { return vec4f(foamLit, 1.0); }
    if (F.post.w > 6.5 && F.post.w < 7.5) { return vec4f(skyUp, 1.0); }
    return vec4f(fwl.r, fwl.g, fresh, 1.0) * 0.2;
  }
  var col = body * (1.0 - Fr) + refl * Fr + spec;
  if (F.night.y > 0.0) {
    // the lantern: its own glitter path on the waves, a little light into the water, lit foam
    let toL = lampPos() - Pw;
    let Ll = normalize(toL);
    let lE = lampE(Pw);
    let Hl = normalize(V + Ll);
    let dl = -Hl.xz / max(Hl.y, 1e-3) - sl;
    let el = (dl.x * dl.x * cov.y + dl.y * dl.y * cov.x - 2.0 * dl.x * dl.y * cov.z) / det;
    let hl2 = Hl.y * Hl.y;
    let Dl = exp(-0.5 * el) / (2.0 * PI * sqrt(det)) / max(hl2 * hl2, 1e-6);
    let Gl = 1.0 / (1.0 + lambdaSmith(V, cov) + lambdaSmith(Ll, cov));
    col += lE * (fresnelWater(dot(V, Hl)) * Dl * Gl / (4.0 * max(V.y, 0.02))) * step(0.0, Ll.y);
    col += F.waterCol.rgb * lE * max(Ll.y, 0.0) * 0.6 * (1.0 - Fr);
    foamLit += foamAlb * lE * max(dot(nrm, Ll), 0.0) * 0.318;
  }
  col = mix(col, foamLit, foamMask * 0.95);

  // ---- aerial perspective ----
  // aerial perspective: atmosphere extinction plus a marine haze floor
  let T = exp(-max(F.fogExt.rgb, vec3f(F.fogExt.w)) * dist);
  let hz = normalize(vec3f(-V.x, 0.002, -V.z));
  let fogCol = skyAtmo(hz);
  col = col * T + fogCol * (1.0 - T) + lampFog(-V, dist);
  // no water inside the hulls
  if (inAnyHull(Pw, 0.03)) { discard; }
  return vec4f(col, 1.0);
}
`;

// Samples the displaced surface height under the camera (inverting the horizontal
// displacement with a few fixed-point iterations).
export const HEIGHT_PROBE = FRAME_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var dispTex: texture_2d_array<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read_write> outH: array<f32, 4>;
` + ROGUE_WGSL + /* wgsl */ `
fn dispAt(xz: vec2f) -> vec3f {
  var d = rogueAt(xz).d;
  for (var c = 0u; c < ${CASCADES}u; c++) {
    d += textureSampleLevel(dispTex, samp, xz * F.cascInvL[c >> 2u][c & 3u], c, 0.0).xyz;
  }
  return d;
}
@compute @workgroup_size(1)
fn main() {
  let goal = F.camPos.xz;
  var x0 = goal;
  for (var i = 0; i < 4; i++) {
    let d = dispAt(x0);
    x0 = goal - d.xz;
  }
  outH[0] = dispAt(x0).y;
}
`;

// Swimming: puts the eye just above the water the probe found under it this frame (a CPU
// readback lags several frames, and a passing rogue crest would bury the camera).
export const SWIM_LIFT = /* wgsl */ `
@group(0) @binding(0) var<storage, read> waterH: array<f32, 4>;
@group(0) @binding(1) var<storage, read_write> frame: array<vec4f, 28>;
@compute @workgroup_size(1)
fn main() {
  let p = frame[4];
  frame[4] = vec4f(p.x, waterH[0] + 0.3, p.z, p.w);
}
`;


// Ships. Sloop: gelcoat hull with boot stripe and antifouling, non-skid deck, teak, tinted
// windows, aluminium spars. Galleon: planked dark wood, ochre gunport strake with black
// ports, glowing stern windows and lanterns, tattered canvas or black sails, Jolly Roger.
// Thin parts (sails, flag, rigging) are lit two-sided.
export const SHIP_RENDER = FRAME_WGSL + ATMO_CORE_WGSL + RENDER_BINDINGS + /* wgsl */ `
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var<storage, read> ships: array<Ship, MAX_SHIPS>;
@group(0) @binding(6) var<storage, read> sunVis: array<f32, 4>;
` + SHIP_SHAPE_WGSL + SKY_RENDER_FUNCS + LAMP_WGSL + /* wgsl */ `
const ENV_MAXMIP: f32 = ${ENV_MIPS - 1}.0;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) rel: vec3f,
  @location(1) n: vec3f,
  @location(2) lp: vec3f,
  @location(3) @interpolate(flat) mat: u32,
  @location(4) @interpolate(flat) ship: u32,
};

fn rotY(p: vec3f, pivotZ: f32, a: f32) -> vec3f {
  let z = p.z - pivotZ;
  return vec3f(p.x * cos(a) + z * sin(a), p.y, -p.x * sin(a) + z * cos(a) + pivotZ);
}

@vertex fn vs(@builtin(instance_index) si: u32, @location(0) p: vec4f, @location(1) nIn: vec4f) -> VO {
  let sh = ships[si];
  let m = u32(p.w + 0.5);
  var lp = p.xyz;
  var ln = nIn.xyz;
  // dismasted: the mast, boom, sails and stays are gone (collapsed to a point out of sight)
  if (sh.kind.z > 1.5 && (m == 4u || m == 6u || (m == 3u && lp.y > 1.7))) { lp = vec3f(0.0, -60.0, 0.0); }
  if (m == 4u || m == 6u) {
    // fore-and-aft sails and boom swing to leeward (a gybe flattens them through the centreline)
    let sd = sh.right.w;
    lp.x *= sd;
    ln = vec3f(ln.x, ln.y * sd, ln.z * sd);
  } else if (m == 7u || m == 8u) {
    // square sails and yards are braced round the mast
    lp = rotY(lp, nIn.w, sh.pos.w);
    ln = rotY(ln, 0.0, sh.pos.w);
  } else if (m == 9u) {
    // the flag ripples and streams downwind
    let u = clamp((nIn.w - 0.1 - lp.z) / FLAG_LEN, 0.0, 1.0);
    let ph = u * 7.0 - F.camPos.w * 11.0 + lp.y * 0.8;
    lp.x += sin(ph) * 0.32 * u;
    ln = normalize(vec3f(1.0, 0.0, 0.32 * (sin(ph) + 7.0 * u * cos(ph)) / FLAG_LEN));
    lp = rotY(lp, nIn.w, sh.kind.w);
    ln = rotY(ln, 0.0, sh.kind.w);
  }
  let w = sh.pos.xyz + sh.right.xyz * lp.x + sh.up.xyz * lp.y + sh.fwd.xyz * lp.z;
  var o: VO;
  o.rel = w - F.camPos.xyz;
  o.pos = F.viewProj * vec4f(o.rel, 1.0);
  o.n = sh.right.xyz * ln.x + sh.up.xyz * ln.y + sh.fwd.xyz * ln.z;
  o.lp = p.xyz;
  o.mat = m;
  o.ship = si;
  return o;
}

fn ggx(n: vec3f, v: vec3f, l: vec3f, rough: f32, f0: vec3f) -> vec3f {
  let h = normalize(v + l);
  let ndl = max(dot(n, l), 0.0);
  let ndv = max(dot(n, v), 1e-3);
  let ndh = max(dot(n, h), 0.0);
  let a2 = max(rough * rough * rough * rough, 1e-5);
  let dn = ndh * ndh * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dn * dn);
  let vis = 0.5 / max(ndl * sqrt(ndv * ndv * (1.0 - a2) + a2) + ndv * sqrt(ndl * ndl * (1.0 - a2) + a2), 1e-5);
  let Fs = f0 + (1.0 - f0) * pow(1.0 - max(dot(v, h), 0.0), 5.0);
  return D * vis * Fs * ndl;
}

fn segD(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  return length(p - a - ab * t);
}
// skull and crossbones on the flag (p in metres from the hoist / foot); 1 = white
fn jollyRoger(p: vec2f) -> f32 {
  let c = vec2f(1.55, 1.32);
  var w = 0.0;
  // cranium and jaw
  let q = p - c;
  if (length(q * vec2f(1.0, 0.92)) < 0.42 || (abs(q.x) < 0.24 && q.y > -0.56 && q.y < -0.2)) { w = 1.0; }
  // eye sockets, nose, teeth gaps
  if (length(q - vec2f(-0.16, 0.0)) < 0.115 || length(q - vec2f(0.16, 0.0)) < 0.115) { w = 0.0; }
  if (abs(q.x) < 0.045 && q.y > -0.22 && q.y < -0.1) { w = 0.0; }
  if (q.y < -0.36 && q.y > -0.56 && abs(fract(q.x / 0.12 + 0.5) - 0.5) < 0.1 && abs(q.x) < 0.24) { w = 0.0; }
  // crossed bones with knobbly ends
  let b0 = c + vec2f(-0.85, -1.05);
  let b1 = c + vec2f(0.85, -0.45);
  let b2 = c + vec2f(-0.85, -0.45);
  let b3 = c + vec2f(0.85, -1.05);
  let bones = min(segD(p, b0, b1), segD(p, b2, b3));
  var knob = 1e9;
  for (var k = 0; k < 4; k++) {
    let e = select(select(select(b3, b2, k == 2), b1, k == 1), b0, k == 0);
    let dir = normalize(select(b1 - b0, b3 - b2, k >= 2)) * select(-1.0, 1.0, k == 1 || k == 3);
    let side = vec2f(-dir.y, dir.x) * 0.07;
    knob = min(knob, min(length(p - e - side), length(p - e + side)));
  }
  if (bones < 0.07 || knob < 0.09) { w = 1.0; }
  return w;
}

@fragment fn fs(in: VO) -> @location(0) vec4f {
  let sh = ships[in.ship];
  let h = shapeOf(sh.kind.x);
  let gal = sh.kind.x > 0.5;
  let dist = length(in.rel);
  let V = -in.rel / dist;
  var n = normalize(in.n);
  let thin = in.mat == 4u || in.mat >= 6u;
  if (thin && dot(n, V) < 0.0) { n = -n; }
  let lp = in.lp;
  let s = lp.z / (0.5 * h.L);

  var alb = vec3f(0.80, 0.80, 0.78);
  var rough = 0.3;
  var metal = 0.0;
  var emit = vec3f(0.0);
  var trans = 0.0;
  switch (in.mat) {
    case 0u: {
      if (gal) {
        // planked dark oak, a low ochre strake with gun ports, weed and copper below the waterline
        let plank = smoothstep(0.0, 0.06, abs(fract(lp.y / 0.34) - 0.5) - 0.44);
        alb = vec3f(0.11, 0.07, 0.04) * (0.7 + 0.3 * plank) * (0.85 + 0.3 * gnoise(lp.zy * vec2f(0.15, 2.0)));
        rough = 0.75;
        let gy = walkY(h, s) - 1.25;
        if (abs(lp.y - gy) < 0.6) { alb = vec3f(0.40, 0.28, 0.09) * (0.8 + 0.2 * plank); }
        if (abs(lp.y - gy + 0.95) < 0.12 || abs(lp.y - gy - 0.95) < 0.10) { alb = vec3f(0.035, 0.025, 0.018); }
        if (abs(s) < 0.62 && abs(lp.y - gy) < 0.36 && abs(fract(lp.z / 2.4 + 0.5) - 0.5) < 0.16) { alb = vec3f(0.01); }
        if (lp.y < 0.15) { alb = vec3f(0.06, 0.07, 0.05); rough = 0.9; }
        // stern gallery windows
        if (s < -0.985) {
          let ty = topY(h, -1.0);
          if (lp.y > ty - 2.3 && lp.y < ty - 1.3 && abs(lp.x) < 2.2 && abs(fract(lp.x / 0.88) - 0.5) < 0.36) {
            emit = vec3f(2.6, 1.35, 0.45) * (0.85 + 0.15 * sin(F.camPos.w * 7.0 + lp.x));
            alb = vec3f(0.02);
          }
        }
      } else {
        // white gelcoat; navy sheer line and boot stripe; antifouling below the waterline
        alb = vec3f(0.82, 0.82, 0.80);
        rough = 0.16;
        let dy = topY(h, s) - lp.y;
        if ((dy > 0.10 && dy < 0.15) || (lp.y > 0.05 && lp.y < 0.15)) { alb = vec3f(0.02, 0.05, 0.14); rough = 0.14; }
        if (lp.y < 0.05) { alb = vec3f(0.05, 0.035, 0.03); rough = 0.6; }
      }
    }
    case 1u: {
      if (gal) {
        let plank = smoothstep(0.0, 0.05, abs(fract(lp.x / 0.26) - 0.5) - 0.45);
        alb = vec3f(0.30, 0.21, 0.12) * (0.75 + 0.25 * plank);
        rough = 0.8;
      } else {
        alb = vec3f(0.60, 0.60, 0.57);
        rough = 0.8;
        if (s < -0.45 && abs(lp.x) < 0.62 * halfBeam(h, s)) { alb = vec3f(0.36, 0.22, 0.12); rough = 0.65; }
      }
    }
    case 2u: {
      alb = vec3f(0.80, 0.80, 0.78);
      rough = 0.28;
      let hy = lp.y - topY(h, s);
      let side = abs(lp.x) > 0.75 * cabinHalfW(h, s);
      if (side && hy > 0.24 && hy < 0.42 && s > -0.30 && s < 0.14) { alb = vec3f(0.015, 0.02, 0.025); rough = 0.04; }
    }
    case 4u, 7u: {
      if (gal) {
        // weathered, patched and torn canvas (or the black sails of the flagship)
        let st = gnoise(lp.xy * 0.35 + vec2f(sh.kind.y * 7.0, 3.0));
        alb = select(vec3f(0.62, 0.57, 0.47), vec3f(0.035, 0.033, 0.03), sh.kind.y > 0.5) * (0.82 + 0.3 * st);
        let tear = gnoise(lp.xy * 1.6 + vec2f(f32(in.ship) * 11.0, 0.0)) + 0.5 * gnoise(lp.xy * 4.1);
        if (tear > 0.52) { discard; }
        trans = select(0.45, 0.12, sh.kind.y > 0.5);
      } else {
        alb = vec3f(0.88, 0.85, 0.78);
        trans = 0.45;
      }
      rough = 0.75;
    }
    case 5u: {
      alb = select(vec3f(0.40, 0.25, 0.13), vec3f(0.14, 0.09, 0.05), gal);
      rough = 0.6;
    }
    case 9u: {
      // black ensign; flag coordinates in metres from the hoist and the foot
      alb = vec3f(0.02);
      rough = 0.9;
      trans = 0.1;
      let fp = vec2f(FLAG_Z - 0.1 - lp.z, lp.y - (FLAG_TOP - FLAG_H));
      alb = mix(alb, vec3f(0.80, 0.78, 0.72), jollyRoger(fp));
    }
    case 10u: {
      alb = vec3f(0.05);
      emit = vec3f(9.0, 4.8, 1.5) * (0.8 + 0.2 * sin(F.camPos.w * 13.0 + lp.x * 3.0));
    }
    case 11u: {
      alb = vec3f(0.04, 0.035, 0.03);
      rough = 0.9;
    }
    default: {
      if (gal) {
        alb = vec3f(0.17, 0.11, 0.065);
        rough = 0.7;
      } else {
        alb = vec3f(0.62, 0.63, 0.65);
        rough = 0.32;
        metal = 0.85;
      }
    }
  }

  let Ld = F.sunDir.xyz;
  let sunE = sunIlluminance() * sunVis[0];
  let ndl = dot(n, Ld);
  let ndv = max(dot(n, V), 1e-3);
  // sky above, hazy sea below (the env cube holds both)
  let amb = textureSampleLevel(envCube, sampC, n, ENV_MAXMIP - 1.0).rgb;
  let f0 = mix(vec3f(0.04), alb, metal);
  var col = alb * (1.0 - metal) * (amb * 1.4 + sunE * max(ndl, 0.0) * 0.318);
  col += sunE * ggx(n, V, Ld, max(rough, 0.08), f0);
  let R = reflect(-V, n);
  let env = textureSampleLevel(envCube, sampC, R, rough * ENV_MAXMIP).rgb;
  let fe = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0) * (1.0 - rough) * (1.0 - rough);
  col += env * fe;
  if (trans > 0.0) {
    // cloth lets light through: glows when the sun is behind it
    let back = textureSampleLevel(envCube, sampC, -n, ENV_MAXMIP - 1.0).rgb;
    col += alb * (sunE * max(-ndl, 0.0) * 0.318 + back * 0.78) * trans;
  }
  if (F.night.y > 0.0) {
    let Pw = in.rel + F.camPos.xyz;
    let Ll = normalize(lampPos() - Pw);
    let lE = lampE(Pw);
    col += alb * (1.0 - metal) * lE * max(dot(n, Ll), 0.0) * 0.318 + lE * ggx(n, V, Ll, max(rough, 0.08), f0);
    if (trans > 0.0) { col += alb * lE * max(-dot(n, Ll), 0.0) * 0.318 * trans; }
  }
  col += emit;

  let T = exp(-max(F.fogExt.rgb, vec3f(F.fogExt.w)) * dist);
  let hz = normalize(vec3f(-V.x, max(-V.y, 0.002), -V.z));
  col = col * T + skyAtmo(hz) * (1.0 - T) + lampFog(-V, dist);
  return vec4f(col, 1.0);
}
`;
