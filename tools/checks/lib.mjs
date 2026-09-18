// Tiny assertion helpers for the check scripts: each call prints one line,
// and `done()` exits 1 if any of them failed.
let failures = 0;

export function ok(cond, what, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

/** |a − b| ≤ tol·|b| (or ≤ tol when b = 0) */
export function near(a, b, tol, what) {
  const err = b === 0 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b);
  ok(Number.isFinite(a) && err <= tol, what, `got ${fmt(a)}, expected ${fmt(b)} ±${tol * 100}%`);
}

export function between(a, lo, hi, what) {
  ok(Number.isFinite(a) && a >= lo && a <= hi, what, `got ${fmt(a)}, allowed [${fmt(lo)}, ${fmt(hi)}]`);
}

export function done() {
  if (failures) console.log(`${failures} assertion(s) failed`);
  process.exit(failures ? 1 : 0);
}

function fmt(v) {
  return typeof v === 'number' ? (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(4) : v.toPrecision(6)) : String(v);
}
