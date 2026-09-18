// Colour scales. See docs/design.md: damage runs through the temper colours
// of steel (straw → bronze → purple → blue); signed stresses use a diverging
// scale, compression blue and tension copper. Vermilion is kept for cracks.

export type Rgb = [number, number, number];

function hex(h: string): Rgb {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function ramp(stops: string[]): (t: number) => Rgb {
  const c = stops.map(hex);
  return (t) => {
    const x = Math.min(1, Math.max(0, t)) * (c.length - 1);
    const i = Math.min(c.length - 2, Math.floor(x));
    const f = x - i;
    const a = c[i];
    const b = c[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
}

/** sequential, for magnitudes that only grow (damage, plastic strain, von Mises) */
export const temper = ramp(['#d9dedc', '#e3cf86', '#c99a4a', '#8d5a33', '#6b3f7a', '#2c4a8c']);

/** diverging, 0.5 is zero: compression (negative) blue, tension (positive) copper */
export const split = ramp(['#1f3f7a', '#5b82b8', '#c5ced3', '#d9a066', '#9c4a1c']);

/** two tones of the undeformed lattice */
export const lattice = (t: number): Rgb => (t < 0.5 ? hex('#aab4ba') : hex('#58656f'));

export function css(c: Rgb): string {
  return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
}
