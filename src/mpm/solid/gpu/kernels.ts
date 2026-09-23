// The step of the 3D model (sim3.ts) as WebGPU compute kernels, in the order sim3.ts advance() runs its stages:
// p2g → fold → grid → folA/folB (followRoll) → mirror → g2pv → vmean → g2pu. Each kernel is the CPU stage line for
// line, in single precision (WebGPU has no f64). The particle state is one f32 buffer of PSTRIDE floats per point
// (the offsets below; sim3.ts's arrays packed side by side), the grid one u32 buffer of NSLOT slots of ng entries
// each, read and written through bitcasts so that the P2G scatter can add floats with compare-exchange (the order
// of those sums varies between runs: the GPU is not bit-reproducible). The controls that take a step's result
// (the roll's adjustment, the bending, the tensions, the stall check) stay on the CPU, once per batch of steps
// (Sim3.advanceBatch), so the roll, the tensions and the deflection are uniform over a batch.
//
// Written for any WebGPU device (Metal, Vulkan, D3D12): default limits only (one bind group of five buffers,
// 64-wide workgroups, dispatches over two dimensions past 65535 workgroups), no float atomics, no subgroups, no
// f16; the arguments of log and pow are clamped where a select would discard the arm, so no arm computes Inf or
// NaN; a point whose stencil would fall outside the grid is left alone (a negative index would wrap).

/** threads per workgroup (all kernels are 1-D, 64 wide) */
export const WG = 64;
/** workgroups per dispatch row (WebGPU's default maxComputeWorkgroupsPerDimension): a bigger dispatch goes to a second row */
export const DISPATCH_MAX = 65535;

/** floats per point in the particle buffer */
export const PSTRIDE = 52;
export const P_X = 0, P_V = 3, P_C = 6, P_F = 15, P_S = 24, P_PRES = 30, P_MASS = 31, P_VOL0 = 32, P_EP = 33, P_TEMP = 34;
export const P_STR = 35, P_STREP = 36, P_VR = 37, P_TH = 38, P_SEQ = 39, P_ETA = 40, P_TOUCH = 41, P_ACTIVE = 42, P_FAILED = 43, P_WORK = 44;
export const P_YSIZE = 45, P_DJC = 46, P_DHM = 47, P_DCL = 48, P_FAILSTEP = 49, P_RATE = 50;

/** grid slots (each ng entries): mass, momentum ×3, θ, Je, B, Mv, pen key, push, con, fy, tq, fn (contact), fn (followRoll), slip ×3, follow N / D */
export const G_M = 0, G_VX = 1, G_VY = 2, G_VZ = 3, G_TH = 4, G_JE = 5, G_B = 6, G_MV = 7, G_PEN = 8, G_PUSH = 9, G_CON = 10, G_FY = 11, G_TQ = 12;
export const G_FN = 13, G_FNF = 14, G_SLX = 15, G_SLY = 16, G_SLZ = 17, G_FOLN = 18, G_FOLD = 19;
export const NSLOT = 20;

/** the uniform block: u32 / f32 by index (see `U` below); one entry per step of a batch, USTRIDE bytes apart */
export const UCOUNT = 64;
export const USTRIDE = 256;
export const U = {
  n: 0, nxN: 1, nyN: 2, nzN: 3,
  h: 4, invH: 5, ox: 6, dt: 7,
  dp: 8, cy: 9, R: 10, omega: 11,
  mu: 12, planeStrain: 13, pushing: 14, vPush: 15,
  mMin: 16, K: 17, G: 18, jcA: 19,
  jcB: 20, jcN: 21, jcC: 22, jcM: 23,
  epsDot0: 24, tRoom: 25, tMelt: 26, rho: 27,
  cp: 28, chi: 29, rateScale: 30, xMin: 31,
  xMax: 32, yMax: 33, zMax: 34, tailEnd: 35,
  ng: 36, swift: 37, swK: 38, swE0: 39,
  swN: 40, vR: 41, vcy: 42, bending: 43,
  tractionB: 44, tractionF: 45, gripCols: 46, NI: 47,
  dz: 48, dmgModel: 49, etaCutoff: 50, D1: 51,
  D2: 52, D3: 53, D4: 54, D5: 55,
  clCrit: 56, stepIndex: 57, backOn: 58, frontOn: 59,
  gapHalf: 60, full: 61, gyOff: 62, yMin: 63,
} as const;
/** the u32 entries of U (the rest are f32) */
export const U_INTS = new Set<number>([U.n, U.nxN, U.nyN, U.nzN, U.planeStrain, U.pushing, U.tailEnd, U.ng, U.swift, U.bending, U.gripCols, U.NI, U.dmgModel, U.stepIndex, U.backOn, U.frontOn, U.full]);

export const WGSL = /* wgsl */ `
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
  swN: f32, vR: f32, vcy: f32, bending: u32,
  tractionB: f32, tractionF: f32, gripCols: u32, NI: u32,
  dz: f32, dmgModel: u32, etaCutoff: f32, D1: f32,
  D2: f32, D3: f32, D4: f32, D5: f32,
  clCrit: f32, stepIndex: u32, backOn: u32, frontOn: u32,
  gapHalf: f32, full: u32, gyOff: f32, yMin: f32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> P: array<f32>;
@group(0) @binding(2) var<storage, read_write> Ga: array<atomic<u32>>;
// the batch's sums: per ix (fy, tq) over the steps, then the contact's normal force per node, then followRoll's
@group(0) @binding(3) var<storage, read_write> acc: array<f32>;
// the roll's deflection by z column: bend[nzN], then its rate
@group(0) @binding(4) var<storage, read> bend: array<f32>;

const S: u32 = ${PSTRIDE}u;
/** the thread's index over a 2-D dispatch (stepper.ts: rows of at most DISPATCH_MAX workgroups) */
fn tid(id: vec3u) -> u32 { return id.x + id.y * ${DISPATCH_MAX * WG}u; }
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
// the deflection of the roll's axis over z and its rate (sim3.ts bendAt / bendVelAt): linear between the columns
fn bendAt(z: f32) -> f32 {
  if (u.bending == 0u) { return 0.0; }
  let g = z * u.invH;
  let k = clamp(floor(g), 0.0, f32(u.nzN - 3u));
  let f = clamp(g - k, 0.0, 1.0);
  let i = u32(k);
  return bend[i + 1u] * (1.0 - f) + bend[i + 2u] * f;
}
fn bendVelAt(z: f32) -> f32 {
  if (u.bending == 0u) { return 0.0; }
  let g = z * u.invH;
  let k = clamp(floor(g), 0.0, f32(u.nzN - 3u));
  let f = clamp(g - k, 0.0, 1.0);
  let i = u32(k) + u.nzN;
  return bend[i + 1u] * (1.0 - f) + bend[i + 2u] * f;
}
// the point's deformed cross-section normal to x (sim3.ts section)
fn section(b: u32) -> f32 {
  let o = b + ${P_F}u;
  return u.dp * P[b + ${P_YSIZE}u] * u.dz * abs(P[o + 4u] * P[o + 8u] - P[o + 5u] * P[o + 7u]);
}
// the share of the end load for lattice column i in the grip of the tail (1) or the head (2) (sim3.ts gripWeight)
fn gripWeight(i: u32, end: u32) -> f32 {
  let g = u.gripCols;
  let j = select(i32(i) - i32(u.NI - g), i32(g) - 1 - i32(i), end == 1u);
  return (f32(j) + 0.5) / f32(g);
}

@compute @workgroup_size(64) fn p2g(@builtin(global_invocation_id) id: vec3u) {
  let p = tid(id);
  if (p >= u.n) { return; }
  let b = p * S;
  if (P[b + ${P_ACTIVE}u] == 0.0) { return; }
  let xp = P[b]; let yp = P[b + 1u]; let zp = P[b + 2u];
  let gx = (xp - u.ox) * u.invH; let gy = yp * u.invH + u.gyOff; let gz = zp * u.invH + 1.0;
  let bx = i32(floor(gx - 0.5)); let by = i32(floor(gy - 0.5)); let bz = i32(floor(gz - 0.5));
  if (bx < 0 || by < 0 || bz < 0 || bx + 2 >= i32(u.nxN) || by + 2 >= i32(u.nyN) || bz + 2 >= i32(u.nzN)) { return; }
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
  var mvx = m * P[b + 3u]; let mvy = m * P[b + 4u]; let mvz = m * P[b + 5u];
  // the tensions: the gripped points' share of the end load, as an impulse along x
  if (u.tractionB != 0.0 || u.tractionF != 0.0) {
    let i = p / u.tailEnd;
    if (u.tractionB != 0.0 && i < u.gripCols) { mvx += u.dt * u.tractionB * gripWeight(i, 1u) * section(b); }
    else if (u.tractionF != 0.0 && i >= u.NI - u.gripCols) { mvx += u.dt * u.tractionF * gripWeight(i, 2u) * section(b); }
  }
  // penetration of the point's top edge into the roll. d − R is lost in f32 (both about 0.1 m, the penetration
  // 1e-8): with e = ey + R = y − gap / 2 − bend, small, d − R = (ex² + e (e − 2 R)) / (d + R) keeps it
  // the full strip's lower half sees the bottom roll: the top roll through the mid-thickness plane
  let sr = select(1.0, -1.0, u.full == 1u && yp < 0.0);
  let ex = xp;
  let e = sr * yp - u.gapHalf - bendAt(zp);
  let ey = e - u.R;
  var pen = INF; var nx = 0.0; var ny = 0.0;
  let halfDp = 0.5 * u.dp;
  let rpMax = halfDp * (abs(F01) + abs(F11));
  let d2 = ex * ex + ey * ey;
  if (d2 <= (u.R + rpMax) * (u.R + rpMax) * (1.0 + 1e-9)) {
    let d = sqrt(d2);
    pen = (ex * ex + e * (e - 2.0 * u.R)) / (d + u.R) - halfDp * sqrt(F01 * F01 + F11 * F11);
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
      let onSide = inRoll && dx * nx + sr * dy * ny <= hh;
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

// one thread per ix: the ghost layers onto their mirror images (sim3.ts foldMomentum)
@compute @workgroup_size(64) fn fold(@builtin(global_invocation_id) id: vec3u) {
  let ix = tid(id);
  if (ix >= u.nxN) { return; }
  let ng = u.ng;
  let c = ix * u.nyN * u.nzN;
  let iyLo = select(1u, 0u, u.full == 1u);
  for (var iz = 0u; iz < u.nzN; iz++) {
    if (u.full == 1u) { break; }
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
  for (var iy = iyLo; iy < u.nyN; iy++) {
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

// one thread per node (iy, iz ≥ 1): momentum → velocity, the roll's contact with Coulomb friction (sim3.ts gridUpdate)
@compute @workgroup_size(64) fn grid(@builtin(global_invocation_id) id: vec3u) {
  let idx = tid(id);
  if (idx >= u.ng) { return; }
  let ng = u.ng;
  let slab = u.nyN * u.nzN;
  let ix = idx / slab;
  let iy = (idx - ix * slab) / u.nzN;
  let iz = idx - ix * slab - iy * u.nzN;
  if ((iy == 0u && u.full == 0u) || iz == 0u) { return; }
  let m = ld(${G_M}u * ng + idx);
  if (m <= u.mMin) {
    st(${G_VX}u * ng + idx, 0.0); st(${G_VY}u * ng + idx, 0.0); st(${G_VZ}u * ng + idx, 0.0);
    return;
  }
  let yi = (f32(iy) - u.gyOff) * u.h;
  // below the mid-thickness plane of the full strip: the bottom roll, as the top roll seen through the plane
  let sr = select(1.0, -1.0, u.full == 1u && yi < 0.0);
  var vx = ld(${G_VX}u * ng + idx) / m;
  var vy = sr * (ld(${G_VY}u * ng + idx) / m);
  var vz = ld(${G_VZ}u * ng + idx) / m;
  let yHeld = iy == 1u && u.full == 0u;
  let zHeld = iz == 1u || u.planeStrain == 1u;
  if (yHeld) { vy = 0.0; }
  if (zHeld) { vz = 0.0; }
  let key = bitcast<u32>(ld(${G_PEN}u * ng + idx));
  if (key != 0u && penOf(key) < 0.0) {
    let rx = u.ox + f32(ix) * u.h;
    var bz = 0.0; var bvz = 0.0;
    if (u.bending == 1u) { bz = bend[iz]; bvz = bend[u.nzN + iz]; }
    let ry = sr * yi - u.cy - bz;
    let vcy = u.vcy + bvz;
    let d = sqrt(rx * rx + ry * ry);
    let nx = rx / d; let ny = ry / d;
    // the roll's surface velocity at the foot of the node; an adjusted roll's surface moves along its normal too
    let ux = -u.omega * u.R * ny + u.vR * nx + vcy * ny * nx;
    let uy = u.omega * u.R * nx + u.vR * ny + vcy * ny * ny;
    let relx = vx - ux; let rely = vy - uy;
    let vn = relx * nx + rely * ny;
    if (vn < 0.0) {
      let tx = relx - vn * nx; let ty = rely - vn * ny; let tz = vz;
      let vt = sqrt(tx * tx + ty * ty + tz * tz);
      var s = 0.0;
      if (vt > -u.mu * vn) { s = 1.0 + (u.mu * vn) / vt; }
      let nvx = ux + s * tx; let nvy = uy + s * ty; let nvz = s * tz;
      st(${G_CON}u * ng + idx, 1.0);
      st(${G_SLX}u * ng + idx, s * tx);
      st(${G_SLY}u * ng + idx, sr * (s * ty));
      st(${G_SLZ}u * ng + idx, select(s * tz, 0.0, zHeld));
      let fx = m * (nvx - vx) / u.dt;
      let fy = m * (nvy - vy) / u.dt;
      st(${G_FY}u * ng + idx, fy);
      st(${G_TQ}u * ng + idx, -(rx * fy - ry * fx));
      st(${G_FN}u * ng + idx, fx * nx + fy * ny);
      vx = nvx;
      vy = select(nvy, 0.0, yHeld);
      vz = select(nvz, 0.0, zHeld);
    }
  }
  if (u.pushing == 1u && ld(${G_PUSH}u * ng + idx) != 0.0 && vx < u.vPush) { vx = u.vPush; }
  st(${G_VX}u * ng + idx, vx); st(${G_VY}u * ng + idx, sr * vy); st(${G_VZ}u * ng + idx, vz);
}

// followRoll, the points' half (sim3.ts followRoll, the first loop): what a point inside the roll lacks to keep
// its top edge on the roll's surface is asked of its held nodes, mass-weighted
@compute @workgroup_size(64) fn folA(@builtin(global_invocation_id) id: vec3u) {
  let p = tid(id);
  if (p >= u.n) { return; }
  let b = p * S;
  if (P[b + ${P_ACTIVE}u] == 0.0 || P[b + ${P_TOUCH}u] == 0.0) { return; }
  let ng = u.ng;
  let xp = P[b]; let yp = P[b + 1u]; let zp = P[b + 2u];
  let gx = (xp - u.ox) * u.invH; let gy = yp * u.invH + u.gyOff; let gz = zp * u.invH + 1.0;
  let bx = i32(floor(gx - 0.5)); let by = i32(floor(gy - 0.5)); let bz = i32(floor(gz - 0.5));
  if (bx < 0 || by < 0 || bz < 0 || bx + 2 >= i32(u.nxN) || by + 2 >= i32(u.nyN) || bz + 2 >= i32(u.nzN)) { return; }
  let fx = gx - f32(bx); let fy = gy - f32(by); let fz = gz - f32(bz);
  let wx = w3(fx); let wy = w3(fy); let wz = w3(fz);
  let sr = select(1.0, -1.0, u.full == 1u && yp < 0.0);
  let rx = xp;
  let ry = sr * yp - u.cy - bendAt(zp);
  let d = sqrt(rx * rx + ry * ry);
  let nx = rx / d; let ny = ry / d;
  let un = (u.vcy + bendVelAt(zp)) * ny + u.vR;
  let ux = -u.omega * u.R * ny + un * nx;
  let uy = u.omega * u.R * nx + un * ny;
  var e = 0.0; var W = 0.0; var dnn = 0.0;
  for (var i = 0; i < 3; i++) {
    for (var j = 0; j < 3; j++) {
      let wij = wx[i] * wy[j];
      let row = u32((bx + i) * i32(u.nyN) + by + j) * u.nzN;
      let along = ((f32(i) - fx) * nx + sr * (f32(j) - fy) * ny) * u.h;
      for (var k = 0; k < 3; k++) {
        let w = wij * wz[k];
        // the ghost layer holds its mirror image's velocity only after the copy back: read the mirror
        let iz = u32(bz + k);
        let idx = row + select(iz, 2u, iz == 0u);
        let vnode = ld(${G_VX}u * ng + idx) * nx + sr * ld(${G_VY}u * ng + idx) * ny;
        e += w * (vnode - ux * nx - uy * ny);
        dnn += w * vnode * along;
        if (ld(${G_CON}u * ng + idx) != 0.0) { W += w; }
      }
    }
  }
  let o = b + ${P_F}u;
  let k4 = 4.0 * u.invH * u.invH;
  let edge = e - 0.5 * u.dp * sqrt(P[o + 1u] * P[o + 1u] + P[o + 4u] * P[o + 4u]) * k4 * dnn;
  if (edge >= 0.0 || W <= 0.0) { return; }
  let want = -edge / W;
  let m = P[b + ${P_MASS}u];
  for (var i = 0; i < 3; i++) {
    for (var j = 0; j < 3; j++) {
      let wij = wx[i] * wy[j];
      let row = u32((bx + i) * i32(u.nyN) + by + j) * u.nzN;
      for (var k = 0; k < 3; k++) {
        let iz = u32(bz + k);
        let idx = row + select(iz, 2u, iz == 0u);
        if (ld(${G_CON}u * ng + idx) == 0.0) { continue; }
        let wm = wij * wz[k] * m;
        if (!(wm > 0.0)) { continue; }
        addF(${G_FOLN}u * ng + idx, wm * want);
        addF(${G_FOLD}u * ng + idx, wm);
      }
    }
  }
}

// followRoll, the nodes' half: the mean request applied along the normal, Coulomb's share taken from the slip
@compute @workgroup_size(64) fn folB(@builtin(global_invocation_id) id: vec3u) {
  let idx = tid(id);
  if (idx >= u.ng) { return; }
  let ng = u.ng;
  let D = ld(${G_FOLD}u * ng + idx);
  if (D == 0.0) { return; }
  let dv = ld(${G_FOLN}u * ng + idx) / D;
  let slab = u.nyN * u.nzN;
  let ix = idx / slab;
  let iy = (idx - ix * slab) / u.nzN;
  let rx = u.ox + f32(ix) * u.h;
  let yi = (f32(iy) - u.gyOff) * u.h;
  let sr = select(1.0, -1.0, u.full == 1u && yi < 0.0);
  let ry = sr * yi - u.cy;
  let d = sqrt(rx * rx + ry * ry);
  let nx = rx / d; let ny = ry / d;
  var vx = ld(${G_VX}u * ng + idx) + dv * nx;
  var vy = sr * ld(${G_VY}u * ng + idx) + dv * ny;
  var vz = ld(${G_VZ}u * ng + idx);
  let mi = ld(${G_M}u * ng + idx);
  let sx = ld(${G_SLX}u * ng + idx); let sy = sr * ld(${G_SLY}u * ng + idx); let sz = ld(${G_SLZ}u * ng + idx);
  let sl = sqrt(sx * sx + sy * sy + sz * sz);
  var tx = 0.0; var ty = 0.0;
  if (sl > 0.0) {
    let ds = min(sl, u.mu * dv);
    let c = -ds / sl;
    tx = c * sx; ty = c * sy;
    vx += tx; vy += ty; vz += c * sz;
    let stuck = ds >= sl;
    st(${G_SLX}u * ng + idx, select(sx + tx, 0.0, stuck));
    st(${G_SLY}u * ng + idx, select(sr * (sy + ty), 0.0, stuck));
    st(${G_SLZ}u * ng + idx, select(sz + c * sz, 0.0, stuck));
  }
  st(${G_VX}u * ng + idx, vx); st(${G_VY}u * ng + idx, sr * vy); st(${G_VZ}u * ng + idx, vz);
  let f = mi * dv / u.dt;
  let fx = f * nx + mi * tx / u.dt;
  let fy = f * ny + mi * ty / u.dt;
  st(${G_FY}u * ng + idx, ld(${G_FY}u * ng + idx) + fy);
  st(${G_TQ}u * ng + idx, ld(${G_TQ}u * ng + idx) - (rx * fy - ry * fx));
  st(${G_FNF}u * ng + idx, f);
}

// one thread per ix: the velocities back to the ghosts, and the column's force and torque, the nodes' normal forces summed for the batch
@compute @workgroup_size(64) fn mirror(@builtin(global_invocation_id) id: vec3u) {
  let ix = tid(id);
  if (ix >= u.nxN) { return; }
  let ng = u.ng;
  let c = ix * u.nyN * u.nzN;
  let iyLo = select(1u, 0u, u.full == 1u);
  var fy = 0.0; var tq = 0.0;
  for (var iy = iyLo; iy < u.nyN; iy++) {
    for (var iz = 1u; iz < u.nzN; iz++) {
      let g = c + iy * u.nzN + iz;
      fy += ld(${G_FY}u * ng + g);
      tq += ld(${G_TQ}u * ng + g);
      acc[2u * u.nxN + g] += ld(${G_FN}u * ng + g);
      acc[2u * u.nxN + ng + g] += ld(${G_FNF}u * ng + g);
    }
    let g = c + iy * u.nzN;
    st(${G_VX}u * ng + g, ld(${G_VX}u * ng + g + 2u));
    st(${G_VY}u * ng + g, ld(${G_VY}u * ng + g + 2u));
    st(${G_VZ}u * ng + g, -ld(${G_VZ}u * ng + g + 2u));
  }
  for (var iz = 0u; iz < u.nzN; iz++) {
    if (u.full == 1u) { break; }
    let g = c + iz;
    let m = g + 2u * u.nzN;
    st(${G_VX}u * ng + g, ld(${G_VX}u * ng + m));
    st(${G_VY}u * ng + g, -ld(${G_VY}u * ng + m));
    st(${G_VZ}u * ng + g, ld(${G_VZ}u * ng + m));
  }
  acc[2u * ix] += fy;
  acc[2u * ix + 1u] += tq;
}

@compute @workgroup_size(64) fn g2pv(@builtin(global_invocation_id) id: vec3u) {
  let p = tid(id);
  if (p >= u.n) { return; }
  let b = p * S;
  if (P[b + ${P_ACTIVE}u] == 0.0) { return; }
  let ng = u.ng;
  let gx = (P[b] - u.ox) * u.invH; let gy = P[b + 1u] * u.invH + u.gyOff; let gz = P[b + 2u] * u.invH + 1.0;
  let bx = i32(floor(gx - 0.5)); let by = i32(floor(gy - 0.5)); let bz = i32(floor(gz - 0.5));
  if (bx < 0 || by < 0 || bz < 0 || bx + 2 >= i32(u.nxN) || by + 2 >= i32(u.nyN) || bz + 2 >= i32(u.nzN)) { return; }
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
  let ix = tid(id);
  if (ix >= u.nxN) { return; }
  let ng = u.ng;
  let c = ix * u.nyN * u.nzN;
  let iyLo = select(1u, 0u, u.full == 1u);
  for (var iz = 0u; iz < u.nzN; iz++) {
    if (u.full == 1u) { break; }
    let g = c + iz;
    if (ld(${G_MV}u * ng + g) == 0.0) { continue; }
    let m = g + 2u * u.nzN;
    st(${G_TH}u * ng + m, ld(${G_TH}u * ng + m) + (ld(${G_TH}u * ng + g)));
    st(${G_JE}u * ng + m, ld(${G_JE}u * ng + m) + (ld(${G_JE}u * ng + g)));
    st(${G_B}u * ng + m, ld(${G_B}u * ng + m) + (ld(${G_B}u * ng + g)));
    st(${G_MV}u * ng + m, ld(${G_MV}u * ng + m) + (ld(${G_MV}u * ng + g)));
    st(${G_MV}u * ng + g, 0.0);
  }
  for (var iy = iyLo; iy < u.nyN; iy++) {
    let g = c + iy * u.nzN;
    if (ld(${G_MV}u * ng + g) == 0.0) { continue; }
    let m = g + 2u;
    st(${G_TH}u * ng + m, ld(${G_TH}u * ng + m) + (ld(${G_TH}u * ng + g)));
    st(${G_JE}u * ng + m, ld(${G_JE}u * ng + m) + (ld(${G_JE}u * ng + g)));
    st(${G_B}u * ng + m, ld(${G_B}u * ng + m) + (ld(${G_B}u * ng + g)));
    st(${G_MV}u * ng + m, ld(${G_MV}u * ng + m) + (ld(${G_MV}u * ng + g)));
    st(${G_MV}u * ng + g, 0.0);
  }
  for (var idx = c + iyLo * u.nzN; idx < c + u.nyN * u.nzN; idx++) {
    let m = ld(${G_MV}u * ng + idx);
    if (m > 0.0) {
      st(${G_TH}u * ng + idx, ld(${G_TH}u * ng + idx) / (m));
      let bb = ld(${G_B}u * ng + idx) / m;
      st(${G_B}u * ng + idx, bb);
      st(${G_JE}u * ng + idx, (bb * ld(${G_JE}u * ng + idx)) / m);
    }
  }
  for (var iy = iyLo; iy < u.nyN; iy++) {
    let g = c + iy * u.nzN;
    st(${G_TH}u * ng + g, ld(${G_TH}u * ng + g + 2u));
    st(${G_JE}u * ng + g, ld(${G_JE}u * ng + g + 2u));
    st(${G_B}u * ng + g, ld(${G_B}u * ng + g + 2u));
  }
  for (var iz = 0u; iz < u.nzN; iz++) {
    if (u.full == 1u) { break; }
    let g = c + iz;
    let m = g + 2u * u.nzN;
    st(${G_TH}u * ng + g, ld(${G_TH}u * ng + m));
    st(${G_JE}u * ng + g, ld(${G_JE}u * ng + m));
    st(${G_B}u * ng + g, ld(${G_B}u * ng + m));
  }
}

fn homT(T: f32) -> f32 { return clamp((T - u.tRoom) / (u.tMelt - u.tRoom), 0.0, 1.0); }
fn rateFactor(epsDot: f32) -> f32 { let r = epsDot / u.epsDot0; return select(1.0, 1.0 + u.jcC * log(max(r, 1.0)), r > 1.0); }
fn staticStrength(ep: f32) -> f32 {
  if (u.swift == 1u) { return u.swK * pow(u.swE0 + max(ep, 0.0), u.swN); }
  return u.jcA + u.jcB * select(0.0, pow(max(ep, 0.0), u.jcN), ep > 0.0);
}
fn strengthFactor(epsDot: f32, T: f32) -> f32 {
  let Ts = homT(T);
  let thermal = select(1.0, 1.0 - pow(max(Ts, 0.0), u.jcM), Ts > 0.0);
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
  let pw = select(0.0, pow(max(ep, 0.0), u.jcN), ep > 0.0);
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
// the largest eigenvalue of the symmetric tensor [[a, d, f], [d, b, e], [f, e, c]] (sim3.ts maxPrincipal)
fn maxPrincipal(a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) -> f32 {
  let m = (a + b + c) / 3.0;
  let p1 = d * d + e * e + f * f;
  let a0 = a - m; let b0 = b - m; let c0 = c - m;
  let p2 = a0 * a0 + b0 * b0 + c0 * c0 + 2.0 * p1;
  if (p2 <= 0.0) { return m; }
  let pp = sqrt(p2 / 6.0);
  let detB = (a0 * (b0 * c0 - e * e) - d * (d * c0 - e * f) + f * (d * e - b0 * f)) / (pp * pp * pp);
  let r = clamp(detB / 2.0, -1.0, 1.0);
  return m + 2.0 * pp * cos(acos(r) / 3.0);
}
fn jcFractureStrain(eta: f32, epsDotStar: f32, Ts: f32) -> f32 {
  let a = u.D1 + u.D2 * exp(u.D3 * eta);
  let b = select(1.0, 1.0 + u.D4 * log(max(epsDotStar, 1.0)), epsDotStar > 1.0);
  let c = 1.0 + u.D5 * Ts;
  return max(a * b * c, 1e-3);
}

@compute @workgroup_size(64) fn g2pu(@builtin(global_invocation_id) id: vec3u) {
  let p = tid(id);
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
    let gx = (P[b] - u.ox) * u.invH; let gy = P[b + 1u] * u.invH + u.gyOff; let gz = P[b + 2u] * u.invH + 1.0;
    let bx = i32(floor(gx - 0.5)); let by = i32(floor(gy - 0.5)); let bz = i32(floor(gz - 0.5));
    if (bx < 0 || by < 0 || bz < 0 || bx + 2 >= i32(u.nxN) || by + 2 >= i32(u.nyN) || bz + 2 >= i32(u.nzN)) { return; }
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
    cor = select(1.0, pow(max(ratio, 1e-30), 1.0 / 3.0), ratio > 0.0);
  }
  let nxp = P[b] + dt * P[b + 3u];
  let nyp = P[b + 1u] + dt * P[b + 4u];
  let nzp = P[b + 2u] + dt * P[b + 5u];
  // a point across a plane of symmetry is folded back; the full strip's y is free both ways
  P[b] = nxp; P[b + 1u] = select(abs(nyp), nyp, u.full == 1u); P[b + 2u] = abs(nzp);
  if (nxp < u.xMin || nxp > u.xMax || nyp > u.yMax || nyp < u.yMin || nzp > u.zMax) { P[b + ${P_ACTIVE}u] = 0.0; return; }
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
  P[b + ${P_RATE}u] = epsDot;
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
  var pr = select(0.0, -u.K * log(max(J, 1e-30)), J > 0.0);
  var q = sqrt(1.5 * (sx * sx + sy * sy + sz * sz + 2.0 * (sa * sa + sb * sb + sc * sc)));
  var dep = 0.0;
  var T = P[b + ${P_TEMP}u];
  P[b + ${P_VR}u] = 0.0;
  if (failed) {
    sx = 0.0; sy = 0.0; sz = 0.0; sa = 0.0; sb = 0.0; sc = 0.0; q = 0.0;
    if (pr < 0.0) { pr = 0.0; }
  } else {
    let ep = P[b + ${P_EP}u];
    if (P[b + ${P_STREP}u] != ep) { P[b + ${P_STR}u] = staticStrength(ep); P[b + ${P_STREP}u] = ep; }
    let s0 = P[b + ${P_STR}u];
    let cool = T <= u.tRoom && u.jcC >= 0.0;
    let f = strengthFactor(epsDot, T);
    if (!((cool && q <= s0) || q <= s0 * f)) { dep = plasticIncrement(q, ep, f); }
    if (dep > 0.0) {
      let sh = 1.0 - (3.0 * u.G * dep) / q;
      sx *= sh; sy *= sh; sz *= sh; sa *= sh; sb *= sh; sc *= sh;
      q -= 3.0 * u.G * dep;
      P[b + ${P_EP}u] = ep + dep;
      let work = q * dep;
      P[b + ${P_WORK}u] += work * P[b + ${P_VOL0}u] * J;
      if (u.chi > 0.0) { T += (u.chi * work * J) / (u.rho * u.cp); P[b + ${P_TEMP}u] = T; }
    }
  }
  P[s] = sx; P[s + 1u] = sy; P[s + 2u] = sz; P[s + 3u] = sa; P[s + 4u] = sb; P[s + 5u] = sc;
  P[b + ${P_PRES}u] = pr;
  let eta = select(0.0, -pr / max(q, 1e3), q > 1e3);
  P[b + ${P_SEQ}u] = q;
  P[b + ${P_ETA}u] = eta;
  if (dep > 0.0) {
    if (q > 0.0) { P[b + ${P_VR}u] = (3.0 * u.K * dep) / q; }
    if (eta > u.etaCutoff) {
      P[b + ${P_DJC}u] += dep / jcFractureStrain(eta, epsDot / u.epsDot0, homT(T));
      P[b + ${P_DHM}u] += dep / (1.65 * exp(-1.5 * eta));
    }
    let s1 = maxPrincipal(sx - pr, sy - pr, sz - pr, sa, sb, sc);
    if (s1 > 0.0) { P[b + ${P_DCL}u] += ((s1 / q) * dep) / u.clCrit; }
    if (u.dmgModel != 0u) {
      let D = select(select(P[b + ${P_DJC}u], P[b + ${P_DCL}u], u.dmgModel == 3u), P[b + ${P_DHM}u], u.dmgModel == 2u);
      let i = p / u.tailEnd;
      let gripped = (u.frontOn == 1u && i >= u.NI - u.gripCols) || (u.backOn == 1u && i < u.gripCols);
      // the ends are held by nothing here, but the pusher's column must stay whole (sim3.ts fail)
      if (D >= 1.0 && !gripped && p >= u.tailEnd) {
        P[b + ${P_FAILED}u] = 1.0;
        if (P[b + ${P_FAILSTEP}u] < 0.0) { P[b + ${P_FAILSTEP}u] = f32(u.stepIndex); }
      }
    }
  }
}
`;
