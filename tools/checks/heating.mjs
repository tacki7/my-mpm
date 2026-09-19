// Adiabatic heating (Taylor-Quinney): ΔT = χ w J / (ρ0 cp) matches its closed form,
// the heat stored in the sheet equals χ times the plastic work it took (energy
// balance over a coarse pass), and with χ = 0 the temperature stays at tRoom.
// @check
import { ok, near, done } from './lib.mjs';
import { adiabaticRise } from '../../src/mpm/material.ts';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';

// σy 500 MPa over Δεp 0.01 in steel: 0.9 × 5 MJ/m³ / (7870 × 460) = 1.243 K
near(adiabaticRise(0.9, 500e6 * 0.01, 1, 7870, 460), (0.9 * 5e6) / (7870 * 460), 1e-15, 'ΔT = χ σy Δεp / (ρ cp)');
near(adiabaticRise(0.9, 5e6, 1.02, 7870, 460), 1.02 * adiabaticRise(0.9, 5e6, 1, 7870, 460), 1e-15, 'per reference volume: × J');

const pass = (chi) => {
  const P = defaultParams();
  P.numerics.cellsThrough = 6;
  P.rolling.sheetLength = 4e-3;
  P.material.chi = chi;
  const sim = new Sim(P);
  for (let k = 0; k < 9000; k++) sim.advance();
  let heat = 0;
  let maxDT = 0;
  let off = 0;
  for (let p = 0; p < sim.n; p++) {
    const dT = sim.temp[p] - P.material.tRoom;
    heat += P.material.rho * sim.vol0[p] * P.material.cp * dT;
    maxDT = Math.max(maxDT, dT);
    if (dT !== 0) off++;
  }
  return { sim, heat, maxDT, off, P };
};
const on = pass(0.9);
ok(on.sim.plasticWork > 0 && on.maxDT > 1, 'the sheet flows and heats', `plastic work ${on.sim.plasticWork.toFixed(1)} J/m, max ΔT ${on.maxDT.toFixed(1)} K`);
near(on.heat, 0.9 * on.sim.plasticWork, 1e-9, 'heat stored = χ × plastic work (energy balance)');
const cold = pass(0);
ok(cold.off === 0, 'χ = 0: every point stays at tRoom', `${cold.off} points changed`);
done();
