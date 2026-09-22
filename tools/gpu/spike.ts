// A spike, not the product: the 3D solver's step (Sim3) on WebGPU, to measure what the GPU gives before
// deciding on the port. The step is P2G → grid (contact, mirrors) → G2P velocity + volume means → G2P update
// (F, Jaumann, J2 return with Johnson-Cook, adiabatic heating). Left out here, on both sides of the comparison:
// followRoll, the tensions, the roll's adjustment and bending, the damage sums, the stall check. Single precision
// throughout (WebGPU has no f64). The P2G scatter uses compare-exchange float adds, so the order of the sums
// varies between runs (not bit-reproducible; the port would sort the points into cells and gather instead).
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';

const S = 48; // floats per point
const P_X = 0, P_V = 3, P_C = 6, P_F = 15, P_S = 24, P_PRES = 30, P_MASS = 31, P_VOL0 = 32, P_EP = 33, P_TEMP = 34;
const P_STR = 35, P_STREP = 36, P_VR = 37, P_TH = 38, P_SEQ = 39, P_ETA = 40, P_TOUCH = 41, P_ACTIVE = 42, P_FAILED = 43, P_WORK = 44;
// grid slots (each NG u32/f32): mass, momentum ×3, θ, Je, B, Mv, pen key, push, con, fy, tq
const G_M = 0, G_VX = 1, G_VY = 2, G_VZ = 3, G_TH = 4, G_JE = 5, G_B = 6, G_MV = 7, G_PEN = 8, G_PUSH = 9, G_CON = 10, G_FY = 11, G_TQ = 12;
const NSLOT = 13;

const WGSL = /* wgsl */ `
struct U {
  n: u32, nxN: u32, nyN: u32, nzN: u32,
  h: f32, invH: f32, ox: f32, dt: f32,
  dp: f32, cy: f32, R: f32, omega: f32,
  mu: f32, planeStrain: u32, pushing: u32, vPush: f32,
  mMin: f32, K: f32, G: f32, jcA: f32,
  jcB: f32, jcN: f32, jcC: f32, jcM: f32,
  epsDot0: f32, tRoom: f32, tMelt: f32, rho: f32,
  cp: f32, chi: f32, rateScale: f32, xMin: f32,
  xMax: f32, yMax: f32, zMax: f32, tailEnd: u32,
  ng: u32, swift: u32, swK: f32, swE0: f32,
  swN: f32, pad0: u32, pad1: u32, pad2: u32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> P: array<f32>;
@group(0) @binding(2) var<storage, read_write> Ga: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> col: array<f32>; // per ix: fy, tq accumulated over steps

const S: u32 = ${S}u;
fn ld(i: u32) -> f32 { return bitcast<f32>(atomicLoad(&Ga[i])); }
fn st(i: u32, v: f32) { atomicStore(&Ga[i], bitcast<u32>(v)); }
const INF: f32 = 3.0e38;

fn addF(i: u32, v: f32) {
  var old = atomicLoad(&Ga[i]);
  loop {
    let nw = bitcast<u32>(bitcast<f32>(old) + v);
    let r = atomicCompareExchangeWeak(&Ga[i], old, nw);
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}
// a float's bits made monotonic as u32, inverted so that atomicMax on a cleared slot keeps the smallest value
fn penKey(f: f32) -> u32 {
  let b = bitcast<u32>(f);
  let m = select(0x80000000u, 0xffffffffu, (b >> 31u) == 1u);
  return ~(b ^ m);
}
fn penOf(k: u32) -> f32 {
  let o = ~k;
  let m = select(0x80000000u, 0xffffffffu, (o >> 31u) == 1u);
  return bitcast<f32>(o ^ m);
}
fn w3(f: f32) -> vec3f {
  return vec3f(0.5 * (1.5 - f) * (1.5 - f), 0.75 - (f - 1.0) * (f - 1.0), 0.5 * (f - 0.5) * (f - 0.5));
}
fn det3(o: u32) -> f32 {
  let a = P[o]; let b = P[o + 1u]; let c = P[o + 2u]; let d = P[o + 3u]; let e = P[o + 4u]; let f = P[o + 5u]; let g = P[o + 6u]; let h = P[o + 7u]; let i = P[o + 8u];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

@compute @workgroup_size(64) fn p2g(@builtin(global_invocation_id) id: vec3u) {
  let p = id.x;
  if (p >= u.n) { return; }
  let b = p * S;
  if (P[b + ${P_ACTIVE}u] == 0.0) { return; }
  let xp = P[b]; let yp = P[b + 1u]; let zp = P[b + 2u];
  let gx = (xp - u.ox) * u.invH; let gy = yp * u.invH + 1.0; let gz = zp * u.invH + 1.0;
  let bx = i32(floor(gx - 0.5)); let by = i32(floor(gy - 0.5)); let bz = i32(floor(gz - 0.5));
  let fx = gx - f32(bx); let fy = gy - f32(by); let fz = gz - f32(bz);
  let wx = w3(fx); let wy = w3(fy); let wz = w3(fz);
  let o = b + ${P_F}u;
  let F01 = P[o + 1u]; let F11 = P[o + 4u];
  let J = det3(o);
  let m = P[b + ${P_MASS}u];
  let kk = -u.dt * P[b + ${P_VOL0}u] * J * 4.0 * u.invH * u.invH;
  let pr = P[b + ${P_PRES}u];
  let c = b + ${P_C}u; let s = b + ${P_S}u;
  let a00 = kk * (P[s] - pr) + m * P[c];
  let a01 = kk * P[s + 3u] + m * P[c + 1u];
  let a02 = kk * P[s + 5u] + m * P[c + 2u];
  let a10 = kk * P[s + 3u] + m * P[c + 3u];
  let a11 = kk * (P[s + 1u] - pr) + m * P[c + 4u];
  let a12 = kk * P[s + 4u] + m * P[c + 5u];
  let a20 = kk * P[s + 5u] + m * P[c + 6u];
  let a21 = kk * P[s + 4u] + m * P[c + 7u];
  let a22 = kk * (P[s + 2u] - pr) + m * P[c + 8u];
  let mvx = m * P[b + 3u]; let mvy = m * P[b + 4u]; let mvz = m * P[b + 5u];
  // penetration of the point's top edge into the roll
  let ex = xp; let ey = yp - u.cy;
  var pen = INF; var nx = 0.0; var ny = 0.0;
  let halfDp = 0.5 * u.dp;
  let rpMax = halfDp * (abs(F01) + abs(F11));
  let d2 = ex * ex + ey * ey;
  if (d2 <= (u.R + rpMax) * (u.R + rpMax) * (1.0 + 1e-9)) {
    let d = sqrt(d2);
    pen = d - u.R - halfDp * sqrt(F01 * F01 + F11 * F11);
    nx = ex / d; ny = ey / d;
  }
  let inRoll = pen < 0.0;
  P[b + ${P_TOUCH}u] = select(0.0, 1.0, inRoll);
  let pushMark = u.pushing == 1u && p < u.tailEnd;
  let key = penKey(pen);
  let hh = 0.5 * u.h;
  for (var i = 0; i < 3; i++) {
    let dx = (f32(i) - fx) * u.h;
    for (var j = 0; j < 3; j++) {
      let dy = (f32(j) - fy) * u.h;
      let wij = wx[i] * wy[j];
      let row = u32((bx + i) * i32(u.nyN) + by + j) * u.nzN + u32(bz);
      let onSide = inRoll && dx * nx + dy * ny <= hh;
      let bxv = mvx + a00 * dx + a01 * dy;
      let byv = mvy + a10 * dx + a11 * dy;
      let bzv = mvz + a20 * dx + a21 * dy;
      for (var k = 0; k < 3; k++) {
        let dzz = (f32(k) - fz) * u.h;
        let w = wij * wz[k];
        let idx = row + u32(k);
        addF(${G_M}u * u.ng + idx, w * m);
        addF(${G_VX}u * u.ng + idx, w * (bxv + a02 * dzz));
        addF(${G_VY}u * u.ng + idx, w * (byv + a12 * dzz));
        addF(${G_VZ}u * u.ng + idx, w * (bzv + a22 * dzz));
        if (onSide) { atomicMax(&Ga[${G_PEN}u * u.ng + idx], key); }
        if (pushMark) { atomicStore(&Ga[${G_PUSH}u * u.ng + idx], bitcast<u32>(1.0)); }
      }
    }
  }
}

// one thread per ix: the ghost layers onto their mirror images
@compute @workgroup_size(64) fn fold(@builtin(global_invocation_id) id: vec3u) {
  let ix = id.x;
  if (ix >= u.nxN) { return; }
  let ng = u.ng;
  let c = ix * u.nyN * u.nzN;
  for (var iz = 0u; iz < u.nzN; iz++) {
    let g = c + iz; // iy = 0
    if (ld(${G_M}u * ng + g) == 0.0) { continue; }
    let m = g + 2u * u.nzN;
    st(${G_M}u * ng + m, ld(${G_M}u * ng + m) + (ld(${G_M}u * ng + g)));
    st(${G_VX}u * ng + m, ld(${G_VX}u * ng + m) + (ld(${G_VX}u * ng + g)));
    st(${G_VY}u * ng + m, ld(${G_VY}u * ng + m) - (ld(${G_VY}u * ng + g)));
    st(${G_VZ}u * ng + m, ld(${G_VZ}u * ng + m) + (ld(${G_VZ}u * ng + g)));
    let kg = bitcast<u32>(ld(${G_PEN}u * ng + g)); let km = bitcast<u32>(ld(${G_PEN}u * ng + m));
    if (kg > km) { st(${G_PEN}u * ng + m, bitcast<f32>(kg)); }
    if (ld(${G_PUSH}u * ng + g) != 0.0) { st(${G_PUSH}u * ng + m, ld(${G_PUSH}u * ng + g)); }
    st(${G_M}u * ng + g, 0.0);
  }
  for (var iy = 1u; iy < u.nyN; iy++) {
    let g = c + iy * u.nzN; // iz = 0
    if (ld(${G_M}u * ng + g) == 0.0) { continue; }
    let m = g + 2u;
    st(${G_M}u * ng + m, ld(${G_M}u * ng + m) + (ld(${G_M}u * ng + g)));
    st(${G_VX}u * ng + m, ld(${G_VX}u * ng + m) + (ld(${G_VX}u * ng + g)));
    st(${G_VY}u * ng + m, ld(${G_VY}u * ng + m) + (ld(${G_VY}u * ng + g)));
    st(${G_VZ}u * ng + m, ld(${G_VZ}u * ng + m) - (ld(${G_VZ}u * ng + g)));
    let kg = bitcast<u32>(ld(${G_PEN}u * ng + g)); let km = bitcast<u32>(ld(${G_PEN}u * ng + m));
    if (kg > km) { st(${G_PEN}u * ng + m, bitcast<f32>(kg)); }
    if (ld(${G_PUSH}u * ng + g) != 0.0) { st(${G_PUSH}u * ng + m, ld(${G_PUSH}u * ng + g)); }
    st(${G_M}u * ng + g, 0.0);
  }
}

// one thread per node (iy, iz ≥ 1): momentum → velocity, the roll's contact
@compute @workgroup_size(64) fn grid(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  if (idx >= u.ng) { return; }
  let ng = u.ng;
  let slab = u.nyN * u.nzN;
  let ix = idx / slab;
  let iy = (idx - ix * slab) / u.nzN;
  let iz = idx - ix * slab - iy * u.nzN;
  if (iy == 0u || iz == 0u) { return; }
  let m = ld(${G_M}u * ng + idx);
  if (m <= u.mMin) {
    st(${G_VX}u * ng + idx, 0.0); st(${G_VY}u * ng + idx, 0.0); st(${G_VZ}u * ng + idx, 0.0);
    return;
  }
  var vx = ld(${G_VX}u * ng + idx) / m;
  var vy = ld(${G_VY}u * ng + idx) / m;
  var vz = ld(${G_VZ}u * ng + idx) / m;
  let yHeld = iy == 1u;
  let zHeld = iz == 1u || u.planeStrain == 1u;
  if (yHeld) { vy = 0.0; }
  if (zHeld) { vz = 0.0; }
  let key = bitcast<u32>(ld(${G_PEN}u * ng + idx));
  if (key != 0u && penOf(key) < 0.0) {
    let rx = u.ox + f32(ix) * u.h;
    let ry = f32(iy - 1u) * u.h - u.cy;
    let d = sqrt(rx * rx + ry * ry);
    let nx = rx / d; let ny = ry / d;
    let ux = -u.omega * u.R * ny;
    let uy = u.omega * u.R * nx;
    let relx = vx - ux; let rely = vy - uy;
    let vn = relx * nx + rely * ny;
    if (vn < 0.0) {
      let tx = relx - vn * nx; let ty = rely - vn * ny; let tz = vz;
      let vt = sqrt(tx * tx + ty * ty + tz * tz);
      var s = 0.0;
      if (vt > -u.mu * vn) { s = 1.0 + (u.mu * vn) / vt; }
      let nvx = ux + s * tx; let nvy = uy + s * ty; let nvz = s * tz;
      st(${G_CON}u * ng + idx, 1.0);
      let fx = m * (nvx - vx) / u.dt;
      let fy = m * (nvy - vy) / u.dt;
      st(${G_FY}u * ng + idx, fy);
      st(${G_TQ}u * ng + idx, -(rx * fy - ry * fx));
      vx = nvx;
      vy = select(nvy, 0.0, yHeld);
      vz = select(nvz, 0.0, zHeld);
    }
  }
  if (u.pushing == 1u && ld(${G_PUSH}u * ng + idx) != 0.0 && vx < u.vPush) { vx = u.vPush; }
  st(${G_VX}u * ng + idx, vx); st(${G_VY}u * ng + idx, vy); st(${G_VZ}u * ng + idx, vz);
}

// one thread per ix: the velocities back to the ghosts, and the column's force and torque
@compute @workgroup_size(64) fn mirror(@builtin(global_invocation_id) id: vec3u) {
  let ix = id.x;
  if (ix >= u.nxN) { return; }
  let ng = u.ng;
  let c = ix * u.nyN * u.nzN;
  var fy = 0.0; var tq = 0.0;
  for (var iy = 1u; iy < u.nyN; iy++) {
    for (var iz = 1u; iz < u.nzN; iz++) {
      let g = c + iy * u.nzN + iz;
      fy += ld(${G_FY}u * ng + g);
      tq += ld(${G_TQ}u * ng + g);
    }
    let g = c + iy * u.nzN;
    st(${G_VX}u * ng + g, ld(${G_VX}u * ng + g + 2u));
    st(${G_VY}u * ng + g, ld(${G_VY}u * ng + g + 2u));
    st(${G_VZ}u * ng + g, -ld(${G_VZ}u * ng + g + 2u));
  }
  for (var iz = 0u; iz < u.nzN; iz++) {
    let g = c + iz;
    let m = g + 2u * u.nzN;
    st(${G_VX}u * ng + g, ld(${G_VX}u * ng + m));
    st(${G_VY}u * ng + g, -ld(${G_VY}u * ng + m));
    st(${G_VZ}u * ng + g, ld(${G_VZ}u * ng + m));
  }
  col[2u * ix] += -fy;
  col[2u * ix + 1u] += tq;
}

@compute @workgroup_size(64) fn g2pv(@builtin(global_invocation_id) id: vec3u) {
  let p = id.x;
  if (p >= u.n) { return; }
  let b = p * S;
  if (P[b + ${P_ACTIVE}u] == 0.0) { return; }
  let ng = u.ng;
  let gx = (P[b] - u.ox) * u.invH; let gy = P[b + 1u] * u.invH + 1.0; let gz = P[b + 2u] * u.invH + 1.0;
  let bx = i32(floor(gx - 0.5)); let by = i32(floor(gy - 0.5)); let bz = i32(floor(gz - 0.5));
  let fx = gx - f32(bx); let fy = gy - f32(by); let fz = gz - f32(bz);
  let wx = w3(fx); let wy = w3(fy); let wz = w3(fz);
  var nv = vec3f(0.0);
  var B = mat3x3f(vec3f(0.0), vec3f(0.0), vec3f(0.0)); // B[col][row]: B[j][i] = Σ w v_i d_j
  for (var i = 0; i < 3; i++) {
    let dx = (f32(i) - fx) * u.h;
    for (var j = 0; j < 3; j++) {
      let dy = (f32(j) - fy) * u.h;
      let wij = wx[i] * wy[j];
      let row = u32((bx + i) * i32(u.nyN) + by + j) * u.nzN + u32(bz);
      for (var k = 0; k < 3; k++) {
        let w = wij * wz[k];
        let dzz = (f32(k) - fz) * u.h;
        let idx = row + u32(k);
        let gv = w * vec3f(ld(${G_VX}u * ng + idx), ld(${G_VY}u * ng + idx), ld(${G_VZ}u * ng + idx));
        nv += gv;
        B[0] += gv * dx; B[1] += gv * dy; B[2] += gv * dzz;
      }
    }
  }
  let k4 = 4.0 * u.invH * u.invH;
  let c = b + ${P_C}u;
  P[c] = k4 * B[0][0]; P[c + 1u] = k4 * B[1][0]; P[c + 2u] = k4 * B[2][0];
  P[c + 3u] = k4 * B[0][1]; P[c + 4u] = k4 * B[1][1]; P[c + 5u] = k4 * B[2][1];
  P[c + 6u] = k4 * B[0][2]; P[c + 7u] = k4 * B[1][2]; P[c + 8u] = k4 * B[2][2];
  P[b + 3u] = nv.x; P[b + 4u] = nv.y; P[b + 5u] = nv.z;
  let theta = k4 * (B[0][0] + B[1][1] + B[2][2]);
  P[b + ${P_TH}u] = theta;
  let J = det3(b + ${P_F}u);
  let pres = P[b + ${P_PRES}u];
  if ((P[b + ${P_FAILED}u] != 0.0 && !(pres > 0.0)) || !(J > 0.0)) { return; }
  let m = P[b + ${P_MASS}u];
  let mth = m * theta;
  let mfe = -m * pres / u.K;
  let v = P[b + ${P_VR}u];
  let mb = select(0.0, m * min(v, 1.0), v > 0.0);
  for (var i = 0; i < 3; i++) {
    for (var j = 0; j < 3; j++) {
      let wij = wx[i] * wy[j];
      let row = u32((bx + i) * i32(u.nyN) + by + j) * u.nzN + u32(bz);
      for (var k = 0; k < 3; k++) {
        let w = wij * wz[k];
        let idx = row + u32(k);
        addF(${G_TH}u * ng + idx, w * mth);
        addF(${G_JE}u * ng + idx, w * mfe);
        addF(${G_B}u * ng + idx, w * mb);
        addF(${G_MV}u * ng + idx, w * m);
      }
    }
  }
}

// one thread per ix: the volume sums folded, the means, and the means back to the ghosts
@compute @workgroup_size(64) fn vmean(@builtin(global_invocation_id) id: vec3u) {
  let ix = id.x;
  if (ix >= u.nxN) { return; }
  let ng = u.ng;
  let c = ix * u.nyN * u.nzN;
  for (var iz = 0u; iz < u.nzN; iz++) {
    let g = c + iz;
    if (ld(${G_MV}u * ng + g) == 0.0) { continue; }
    let m = g + 2u * u.nzN;
    st(${G_TH}u * ng + m, ld(${G_TH}u * ng + m) + (ld(${G_TH}u * ng + g)));
    st(${G_JE}u * ng + m, ld(${G_JE}u * ng + m) + (ld(${G_JE}u * ng + g)));
    st(${G_B}u * ng + m, ld(${G_B}u * ng + m) + (ld(${G_B}u * ng + g)));
    st(${G_MV}u * ng + m, ld(${G_MV}u * ng + m) + (ld(${G_MV}u * ng + g)));
    st(${G_MV}u * ng + g, 0.0);
  }
  for (var iy = 1u; iy < u.nyN; iy++) {
    let g = c + iy * u.nzN;
    if (ld(${G_MV}u * ng + g) == 0.0) { continue; }
    let m = g + 2u;
    st(${G_TH}u * ng + m, ld(${G_TH}u * ng + m) + (ld(${G_TH}u * ng + g)));
    st(${G_JE}u * ng + m, ld(${G_JE}u * ng + m) + (ld(${G_JE}u * ng + g)));
    st(${G_B}u * ng + m, ld(${G_B}u * ng + m) + (ld(${G_B}u * ng + g)));
    st(${G_MV}u * ng + m, ld(${G_MV}u * ng + m) + (ld(${G_MV}u * ng + g)));
    st(${G_MV}u * ng + g, 0.0);
  }
  for (var idx = c + u.nzN; idx < c + u.nyN * u.nzN; idx++) {
    let m = ld(${G_MV}u * ng + idx);
    if (m > 0.0) {
      st(${G_TH}u * ng + idx, ld(${G_TH}u * ng + idx) / (m));
      let bb = ld(${G_B}u * ng + idx) / m;
      st(${G_B}u * ng + idx, bb);
      st(${G_JE}u * ng + idx, (bb * ld(${G_JE}u * ng + idx)) / m);
    }
  }
  for (var iy = 1u; iy < u.nyN; iy++) {
    let g = c + iy * u.nzN;
    st(${G_TH}u * ng + g, ld(${G_TH}u * ng + g + 2u));
    st(${G_JE}u * ng + g, ld(${G_JE}u * ng + g + 2u));
    st(${G_B}u * ng + g, ld(${G_B}u * ng + g + 2u));
  }
  for (var iz = 0u; iz < u.nzN; iz++) {
    let g = c + iz;
    let m = g + 2u * u.nzN;
    st(${G_TH}u * ng + g, ld(${G_TH}u * ng + m));
    st(${G_JE}u * ng + g, ld(${G_JE}u * ng + m));
    st(${G_B}u * ng + g, ld(${G_B}u * ng + m));
  }
}

fn homT(T: f32) -> f32 { return clamp((T - u.tRoom) / (u.tMelt - u.tRoom), 0.0, 1.0); }
fn rateFactor(epsDot: f32) -> f32 { let r = epsDot / u.epsDot0; return select(1.0, 1.0 + u.jcC * log(r), r > 1.0); }
fn staticStrength(ep: f32) -> f32 {
  if (u.swift == 1u) { return u.swK * pow(u.swE0 + max(ep, 0.0), u.swN); }
  return u.jcA + u.jcB * select(0.0, pow(ep, u.jcN), ep > 0.0);
}
fn strengthFactor(epsDot: f32, T: f32) -> f32 {
  let Ts = homT(T);
  let thermal = select(1.0, 1.0 - pow(Ts, u.jcM), Ts > 0.0);
  return rateFactor(epsDot) * thermal;
}
// flow stress and its slope
fn flow(ep: f32, f: f32) -> vec2f {
  if (u.swift == 1u) {
    let bb = u.swE0 + max(ep, 0.0);
    let sw = u.swK * pow(bb, u.swN);
    return vec2f(sw * f, (sw * u.swN * f) / bb);
  }
  let e = max(ep, 1e-9);
  let pw = select(0.0, pow(ep, u.jcN), ep > 0.0);
  return vec2f((u.jcA + u.jcB * pw) * f, u.jcB * u.jcN * pow(e, u.jcN - 1.0) * f);
}
fn plasticIncrement(qTrial: f32, ep: f32, f: f32) -> f32 {
  let y0 = flow(ep, f).x;
  if (qTrial <= y0) { return 0.0; }
  var lo = 0.0;
  var hi = qTrial / (3.0 * u.G);
  var x = (qTrial - y0) / (3.0 * u.G);
  for (var it = 0; it < 30; it++) {
    let sh = flow(ep + x, f);
    let g = qTrial - 3.0 * u.G * x - sh.x;
    // f32: the residual bottoms out near 1e-7 q, so the test is looser than the f64 solver's 1e-9, and a step
    // that no longer moves x is converged too (else the safeguard would throw it to the bracket's middle)
    if (abs(g) < 1e-6 * qTrial) { break; }
    if (g > 0.0) { lo = x; } else { hi = x; }
    var nx = x + g / (3.0 * u.G + sh.y);
    if (nx == x) { break; }
    if (!(nx > lo && nx < hi)) { nx = 0.5 * (lo + hi); }
    x = nx;
  }
  return x;
}

@compute @workgroup_size(64) fn g2pu(@builtin(global_invocation_id) id: vec3u) {
  let p = id.x;
  if (p >= u.n) { return; }
  let b = p * S;
  if (P[b + ${P_ACTIVE}u] == 0.0) { return; }
  let ng = u.ng;
  let c = b + ${P_C}u;
  let l00 = P[c]; let l01 = P[c + 1u]; let l02 = P[c + 2u]; let l10 = P[c + 3u]; let l11 = P[c + 4u]; let l12 = P[c + 5u]; let l20 = P[c + 6u]; let l21 = P[c + 7u]; let l22 = P[c + 8u];
  let o = b + ${P_F}u;
  let Jold = det3(o);
  let dt = u.dt;
  var cor = 1.0;
  let pres0 = P[b + ${P_PRES}u];
  let failed = P[b + ${P_FAILED}u] != 0.0;
  if (!((failed && !(pres0 > 0.0)) || !(Jold > 0.0))) {
    let gx = (P[b] - u.ox) * u.invH; let gy = P[b + 1u] * u.invH + 1.0; let gz = P[b + 2u] * u.invH + 1.0;
    let bx = i32(floor(gx - 0.5)); let by = i32(floor(gy - 0.5)); let bz = i32(floor(gz - 0.5));
    let fx = gx - f32(bx); let fy = gy - f32(by); let fz = gz - f32(bz);
    let wx = w3(fx); let wy = w3(fy); let wz = w3(fz);
    var thBar = 0.0; var rA = 0.0; var rB = 0.0;
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) {
        let wij = wx[i] * wy[j];
        let row = u32((bx + i) * i32(u.nyN) + by + j) * u.nzN + u32(bz);
        for (var k = 0; k < 3; k++) {
          let w = wij * wz[k];
          let idx = row + u32(k);
          thBar += w * ld(${G_TH}u * ng + idx);
          rA += w * ld(${G_JE}u * ng + idx);
          rB += w * ld(${G_B}u * ng + idx);
        }
      }
    }
    let theta = thBar + (rA + (rB * pres0) / u.K) / dt;
    let g00 = 1.0 + dt * l00; let g11 = 1.0 + dt * l11; let g22 = 1.0 + dt * l22;
    let detG = g00 * (g11 * g22 - dt * dt * l12 * l21) - dt * l01 * (dt * l10 * g22 - dt * dt * l12 * l20) + dt * l02 * (dt * dt * l10 * l21 - g11 * dt * l20);
    let ratio = exp(dt * theta) / detG;
    cor = select(1.0, pow(ratio, 1.0 / 3.0), ratio > 0.0);
  }
  let nxp = P[b] + dt * P[b + 3u];
  let nyp = P[b + 1u] + dt * P[b + 4u];
  let nzp = P[b + 2u] + dt * P[b + 5u];
  P[b] = nxp; P[b + 1u] = abs(nyp); P[b + 2u] = abs(nzp);
  if (nxp < u.xMin || nxp > u.xMax || nyp > u.yMax || nzp > u.zMax) { P[b + ${P_ACTIVE}u] = 0.0; return; }
  let g00 = cor * (1.0 + dt * l00); let g01 = cor * dt * l01; let g02 = cor * dt * l02;
  let g10 = cor * dt * l10; let g11 = cor * (1.0 + dt * l11); let g12 = cor * dt * l12;
  let g20 = cor * dt * l20; let g21 = cor * dt * l21; let g22 = cor * (1.0 + dt * l22);
  let F00 = P[o]; let F01 = P[o + 1u]; let F02 = P[o + 2u]; let F10 = P[o + 3u]; let F11 = P[o + 4u]; let F12 = P[o + 5u]; let F20 = P[o + 6u]; let F21 = P[o + 7u]; let F22 = P[o + 8u];
  P[o] = g00 * F00 + g01 * F10 + g02 * F20;
  P[o + 1u] = g00 * F01 + g01 * F11 + g02 * F21;
  P[o + 2u] = g00 * F02 + g01 * F12 + g02 * F22;
  P[o + 3u] = g10 * F00 + g11 * F10 + g12 * F20;
  P[o + 4u] = g10 * F01 + g11 * F11 + g12 * F21;
  P[o + 5u] = g10 * F02 + g11 * F12 + g12 * F22;
  P[o + 6u] = g20 * F00 + g21 * F10 + g22 * F20;
  P[o + 7u] = g20 * F01 + g21 * F11 + g22 * F21;
  P[o + 8u] = g20 * F02 + g21 * F12 + g22 * F22;
  let J = det3(o);
  let tr3 = (l00 + l11 + l22) / 3.0;
  let exx = l00 - tr3; let eyy = l11 - tr3; let ezz = l22 - tr3;
  let exy = 0.5 * (l01 + l10); let eyz = 0.5 * (l12 + l21); let ezx = 0.5 * (l20 + l02);
  let wxy = 0.5 * (l01 - l10); let wyz = 0.5 * (l12 - l21); let wzx = 0.5 * (l20 - l02);
  let epsDot = sqrt((2.0 / 3.0) * (exx * exx + eyy * eyy + ezz * ezz + 2.0 * (exy * exy + eyz * eyz + ezx * ezx))) * u.rateScale;
  let s = b + ${P_S}u;
  var sx = P[s]; var sy = P[s + 1u]; var sz = P[s + 2u]; var sa = P[s + 3u]; var sb = P[s + 4u]; var sc = P[s + 5u];
  {
    let rxx = 2.0 * (wxy * sa - wzx * sc);
    let ryy = 2.0 * (-wxy * sa + wyz * sb);
    let rzz = 2.0 * (wzx * sc - wyz * sb);
    let rxy = wxy * (sy - sx) - wzx * sb + wyz * sc;
    let ryz = wyz * (sz - sy) - wxy * sc + wzx * sa;
    let rzx = wzx * (sx - sz) - wyz * sa + wxy * sb;
    sx += dt * rxx; sy += dt * ryy; sz += dt * rzz; sa += dt * rxy; sb += dt * ryz; sc += dt * rzx;
  }
  let g2 = 2.0 * u.G * dt;
  sx += g2 * exx; sy += g2 * eyy; sz += g2 * ezz; sa += g2 * exy; sb += g2 * eyz; sc += g2 * ezx;
  var pr = select(0.0, -u.K * log(J), J > 0.0);
  var q = sqrt(1.5 * (sx * sx + sy * sy + sz * sz + 2.0 * (sa * sa + sb * sb + sc * sc)));
  var dep = 0.0;
  P[b + ${P_VR}u] = 0.0;
  if (failed) {
    sx = 0.0; sy = 0.0; sz = 0.0; sa = 0.0; sb = 0.0; sc = 0.0; q = 0.0;
    if (pr < 0.0) { pr = 0.0; }
  } else {
    let ep = P[b + ${P_EP}u];
    if (P[b + ${P_STREP}u] != ep) { P[b + ${P_STR}u] = staticStrength(ep); P[b + ${P_STREP}u] = ep; }
    let s0 = P[b + ${P_STR}u];
    let T = P[b + ${P_TEMP}u];
    let cool = T <= u.tRoom && u.jcC >= 0.0;
    let f = strengthFactor(epsDot, T);
    P[b + 45u] = q; P[b + 46u] = s0 * f; P[b + 47u] = epsDot;
    if (!((cool && q <= s0) || q <= s0 * f)) { dep = plasticIncrement(q, ep, f); }
    if (dep > 0.0) {
      let sh = 1.0 - (3.0 * u.G * dep) / q;
      sx *= sh; sy *= sh; sz *= sh; sa *= sh; sb *= sh; sc *= sh;
      q -= 3.0 * u.G * dep;
      P[b + ${P_EP}u] = ep + dep;
      let work = q * dep;
      P[b + ${P_WORK}u] += work * P[b + ${P_VOL0}u] * J;
      if (u.chi > 0.0) { P[b + ${P_TEMP}u] = T + (u.chi * work * J) / (u.rho * u.cp); }
    }
  }
  P[s] = sx; P[s + 1u] = sy; P[s + 2u] = sz; P[s + 3u] = sa; P[s + 4u] = sb; P[s + 5u] = sc;
  P[b + ${P_PRES}u] = pr;
  P[b + ${P_SEQ}u] = q;
  P[b + ${P_ETA}u] = select(0.0, -pr / q, q > 1e3);
  if (dep > 0.0 && q > 0.0) { P[b + ${P_VR}u] = (3.0 * u.K * dep) / q; }
}
`;

export interface SpikeResult {
  W: number;
  points: number;
  steps: number;
  cpuMsPerStep: number;
  gpuMsPerStep: number;
  speedup: number;
  /** after the same steps from the same state: the largest position difference [m] and the force per unit width, CPU / GPU [N/m] */
  maxDx: number;
  rmsDx: number;
  maxDs: number;
  forceCpu: number;
  forceGpu: number;
  adapter: string;
  fields?: Record<string, number>;
}

function makeSim(W: number, cells: number): Sim3 {
  const P = defaultParams();
  P.numerics.cellsThrough = cells;
  P.rolling.sheetLength = 12e-3;
  P.damage.model = 'none';
  const s = new Sim3(solidParams(P, { width: W * 1e-3 }));
  // the same simplifications as the GPU step
  (s as any).followRoll = () => [0, 0];
  (s as any).adjustRolls = () => {};
  (s as any).checkStall = () => {};
  Object.defineProperty(s, 'pusherActive', { get: () => true, set: () => {} });
  return s;
}

function pack(s: Sim3): Float32Array {
  const a = new Float32Array(s.n * S);
  for (let p = 0; p < s.n; p++) {
    const b = p * S;
    a[b] = s.px[p]; a[b + 1] = s.py[p]; a[b + 2] = s.pz[p];
    a[b + 3] = s.vx[p]; a[b + 4] = s.vy[p]; a[b + 5] = s.vz[p];
    for (let k = 0; k < 9; k++) { a[b + P_C + k] = s.C[9 * p + k]; a[b + P_F + k] = s.F[9 * p + k]; }
    a[b + P_S] = s.sxx[p]; a[b + P_S + 1] = s.syy[p]; a[b + P_S + 2] = s.szz[p]; a[b + P_S + 3] = s.sxy[p]; a[b + P_S + 4] = s.syz[p]; a[b + P_S + 5] = s.szx[p];
    a[b + P_PRES] = s.pres[p]; a[b + P_MASS] = s.mass[p]; a[b + P_VOL0] = s.vol0[p]; a[b + P_EP] = s.ep[p]; a[b + P_TEMP] = s.temp[p];
    a[b + P_STR] = (s as any).strength[p]; a[b + P_STREP] = (s as any).strengthEp[p]; a[b + P_VR] = (s as any).vr[p];
    a[b + P_ACTIVE] = s.active[p]; a[b + P_FAILED] = s.failed[p];
  }
  return a;
}

export async function runSpike(W = 8, cells = 4, steps = 1500, cpuSteps = steps, cpuF32 = false, sync = false): Promise<SpikeResult> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();
  const gpuErrors: string[] = [];
  device.addEventListener('uncapturederror', (e: any) => gpuErrors.push(String(e.error?.message ?? e)));
  device.pushErrorScope('validation');
  const info = (adapter as any).info ?? {};
  const s = makeSim(W, cells);
  const g = makeSim(W, cells);
  const n = s.n;
  const NG = s.nxN * s.nyN * s.nzN;
  const mat = s.params.material;
  const r = s.params.rolling;
  const uni = new ArrayBuffer(44 * 4);
  const f = new Float32Array(uni);
  const ui = new Uint32Array(uni);
  const a: any = s;
  ui[0] = n; ui[1] = s.nxN; ui[2] = s.nyN; ui[3] = s.nzN;
  f[4] = s.h; f[5] = 1 / s.h; f[6] = s.ox; f[7] = s.dt;
  f[8] = s.dp; f[9] = s.roll.cy; f[10] = s.roll.R; f[11] = s.roll.omega;
  f[12] = r.mu; ui[13] = s.params.solid.planeStrain ? 1 : 0; ui[14] = 1; f[15] = a.vIn;
  f[16] = 1e-12 * s.mass[0]; f[17] = s.el.K; f[18] = s.el.G; f[19] = mat.jcA;
  f[20] = mat.jcB; f[21] = mat.jcN; f[22] = mat.jcC; f[23] = mat.jcM;
  f[24] = mat.epsDot0; f[25] = mat.tRoom; f[26] = mat.tMelt; f[27] = mat.rho;
  f[28] = mat.cp; f[29] = mat.chi; f[30] = r.millSpeed / r.rollSpeed; f[31] = s.ox + 2 * s.h;
  f[32] = (s.nxN - 3) * s.h + s.ox; f[33] = (s.nyN - 4) * s.h; f[34] = (s.nzN - 4) * s.h; ui[35] = s.NJ * s.NK;
  ui[36] = NG; ui[37] = mat.hardening === 'swift' ? 1 : 0; f[38] = mat.swK; f[39] = mat.swE0; f[40] = mat.swN;
  const ubuf = device.createBuffer({ size: uni.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(ubuf, 0, uni);
  if (sync) { for (let i = 0; i < steps - 1; i++) s.advance(); }
  const pdata = pack(sync ? s : g);
  const pbuf = device.createBuffer({ size: pdata.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  device.queue.writeBuffer(pbuf, 0, pdata);
  const gbuf = device.createBuffer({ size: NSLOT * NG * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const cbuf = device.createBuffer({ size: 2 * s.nxN * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const module = device.createShaderModule({ code: WGSL });
  const ci = await module.getCompilationInfo();
  const errs = ci.messages.filter((m) => m.type === 'error');
  if (errs.length) throw new Error(errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const bind = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: ubuf } },
      { binding: 1, resource: { buffer: pbuf } },
      { binding: 2, resource: { buffer: gbuf } },
      { binding: 3, resource: { buffer: cbuf } },
    ],
  });
  const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipe = (entryPoint: string) => device.createComputePipeline({ layout: pl, compute: { module, entryPoint } });
  const K = { p2g: pipe('p2g'), fold: pipe('fold'), grid: pipe('grid'), mirror: pipe('mirror'), g2pv: pipe('g2pv'), vmean: pipe('vmean'), g2pu: pipe('g2pu') };
  const wgP = Math.ceil(n / 64);
  const wgX = Math.ceil(s.nxN / 64);
  const wgG = Math.ceil(NG / 64);

  const encodeSteps = (count: number) => {
    const enc = device.createCommandEncoder();
    for (let i = 0; i < count; i++) {
      enc.clearBuffer(gbuf);
      const pass = enc.beginComputePass();
      pass.setBindGroup(0, bind);
      pass.setPipeline(K.p2g); pass.dispatchWorkgroups(wgP);
      pass.setPipeline(K.fold); pass.dispatchWorkgroups(wgX);
      pass.setPipeline(K.grid); pass.dispatchWorkgroups(wgG);
      pass.setPipeline(K.mirror); pass.dispatchWorkgroups(wgX);
      pass.setPipeline(K.g2pv); pass.dispatchWorkgroups(wgP);
      pass.setPipeline(K.vmean); pass.dispatchWorkgroups(wgX);
      pass.setPipeline(K.g2pu); pass.dispatchWorkgroups(wgP);
      pass.end();
    }
    device.queue.submit([enc.finish()]);
  };
  // warm up (pipelines, first submit), then time
  if (sync) { steps = 1; cpuSteps = 1; (a as any).accFy = 0; (a as any).accSteps = 0; }
  const warm = Math.min(20, steps);
  encodeSteps(warm);
  await device.queue.onSubmittedWorkDone();
  const verr = await device.popErrorScope();
  if (verr) throw new Error('validation: ' + verr.message);
  if (gpuErrors.length) throw new Error(gpuErrors.join('\n'));
  const t0 = performance.now();
  const BATCH = 50;
  for (let done = warm; done < steps; done += BATCH) encodeSteps(Math.min(BATCH, steps - done));
  await device.queue.onSubmittedWorkDone();
  const gpuMs = (performance.now() - t0) / Math.max(1, steps - warm);

  // the CPU side, the same steps
  const t1 = performance.now();
  const arrs = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'C', 'F', 'sxx', 'syy', 'szz', 'sxy', 'syz', 'szx', 'pres', 'ep', 'temp', 'vr', 'strength'].map((k) => (s as any)[k] as Float64Array);
  for (let i = 0; i < cpuSteps; i++) {
    s.advance();
    // the CPU's state rounded to single precision after every step (the stored state only, not the arithmetic)
    if (cpuF32) for (const arr of arrs) for (let k = 0; k < arr.length; k++) arr[k] = Math.fround(arr[k]);
  }
  const cpuMs = (performance.now() - t1) / cpuSteps;
  // read back
  const rb = device.createBuffer({ size: pdata.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const rc = device.createBuffer({ size: 2 * s.nxN * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(pbuf, 0, rb, 0, pdata.byteLength);
  enc.copyBufferToBuffer(cbuf, 0, rc, 0, 2 * s.nxN * 4);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  await rc.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(rb.getMappedRange());
  const colv = new Float32Array(rc.getMappedRange());
  let fyG = 0;
  for (let ix = 0; ix < s.nxN; ix++) fyG += colv[2 * ix];
  const forceGpu = (2 * fyG) / steps;
  const forceCpu = (2 * a.accFy) / a.accSteps;
  let maxDx = 0, sum2 = 0, cnt = 0, maxDs = 0;
  // per field: the largest |GPU − CPU| relative to the field's largest |CPU|
  const fields: Record<string, number> = {};
  if (cpuSteps === steps) {
    const cmp = (name: string, off: number, cpu: (p: number) => number) => {
      let md = 0, mx = 0, at = -1;
      for (let p = 0; p < n; p++) {
        if (!s.active[p]) continue;
        const c = cpu(p);
        const d = Math.abs(out[p * S + off] - c);
        if (d > md) { md = d; at = p; }
        mx = Math.max(mx, Math.abs(c));
      }
      fields[name] = md;
      fields[name + '@'] = at;
      fields[name + ':cpu'] = at >= 0 ? cpu(at) : NaN;
      fields[name + ':gpu'] = at >= 0 ? out[at * S + off] : NaN;
    };
    cmp('px', 0, (p) => s.px[p]); cmp('py', 1, (p) => s.py[p]); cmp('pz', 2, (p) => s.pz[p]);
    cmp('vx', 3, (p) => s.vx[p]); cmp('vy', 4, (p) => s.vy[p]); cmp('vz', 5, (p) => s.vz[p]);
    cmp('C00', P_C, (p) => s.C[9 * p]); cmp('C11', P_C + 4, (p) => s.C[9 * p + 4]); cmp('C01', P_C + 1, (p) => s.C[9 * p + 1]);
    cmp('F00', P_F, (p) => s.F[9 * p]); cmp('F11', P_F + 4, (p) => s.F[9 * p + 4]);
    cmp('sxx', P_S, (p) => s.sxx[p]); cmp('syy', P_S + 1, (p) => s.syy[p]); cmp('sxy', P_S + 3, (p) => s.sxy[p]);
    cmp('pres', P_PRES, (p) => s.pres[p]); cmp('ep', P_EP, (p) => s.ep[p]); cmp('temp', P_TEMP, (p) => s.temp[p]);
    cmp('vr', P_VR, (p) => a.vr[p]); cmp('th', P_TH, (p) => a.th[p]); cmp('touch', P_TOUCH, (p) => s.touch[p]); cmp('seq', P_SEQ, (p) => s.seq[p]);
    cmp('qTrial', 45, () => 0); cmp('yield', 46, () => 0); cmp('epsDot', 47, () => 0); cmp('strength', P_STR, (p) => a.strength[p]); cmp('strengthEp', P_STREP, (p) => a.strengthEp[p]);
    for (let p = 0; p < n; p++) {
      const b = p * S;
      if (!s.active[p] || out[b + P_ACTIVE] === 0) continue;
      const d = Math.hypot(out[b] - s.px[p], out[b + 1] - s.py[p], out[b + 2] - s.pz[p]);
      maxDx = Math.max(maxDx, d);
      sum2 += d * d;
      cnt++;
      maxDs = Math.max(maxDs, Math.abs(out[b + P_SEQ] - s.seq[p]));
    }
  }
  device.destroy();
  return {
    W, points: n, steps, cpuMsPerStep: cpuMs, gpuMsPerStep: gpuMs, speedup: cpuMs / gpuMs,
    maxDx, rmsDx: cnt ? Math.sqrt(sum2 / cnt) : NaN, maxDs, forceCpu, forceGpu, fields,
    adapter: `${info.vendor ?? '?'} ${info.architecture ?? ''}`.trim(),
  };
}

(window as any).__spike = { run: runSpike };
