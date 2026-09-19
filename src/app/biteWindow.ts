// The default window of the roll-bite picture (zoom 1, no pan), in world x [m]: its width, set by the
// first stand's sheet (a tandem draws every stand at that scale), and its centre, with the bite a little
// left of it so that the exit side shows more. The picture (view.ts) and the worker (which keeps each
// finished stand's picture from when the sheet fills that window) share it.

/** width of the default window [m] for a sheet of entry thickness h0 in a bite of this contact length */
export function windowWidth(g: { contactLength: number; h0: number }): number {
  return Math.max(3.4 * g.contactLength, 16 * g.h0);
}

/** world x at the centre of the default window, for this stand's contact length and the window's width */
export function windowCentre(contactLength: number, width: number): number {
  return -contactLength / 2 + width * 0.08;
}
