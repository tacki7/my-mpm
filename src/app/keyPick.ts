// Choosing a point with the keyboard: with the roll bite focused, Enter (or Space) takes the point nearest the
// middle of the view as「選んだ点」, as a click on it does; the arrow keys pan the view (viewControls.ts), so a point
// is brought to the middle and taken. While the canvas has the keyboard's focus a mark in its middle says so, and
// the choice is said (aria-live).
import type { BiteView } from './view.ts';

export function attachKeyPick(canvas: HTMLCanvasElement, view: BiteView, onPick: (id: number) => void): void {
  const aim = document.createElement('div');
  aim.className = 'pick-aim';
  aim.setAttribute('aria-hidden', 'true');
  const hint = document.createElement('span');
  hint.className = 'pick-hint';
  hint.textContent = 'Enter で中央の点を選ぶ';
  aim.append(document.createElement('span'), hint);
  aim.firstElementChild!.className = 'pick-cross';
  const say = document.createElement('p');
  say.className = 'sr-only';
  say.setAttribute('aria-live', 'polite');
  canvas.closest('.bite')!.append(say);
  // the mark sits right after the canvas, in the middle of what the canvas fills (a tandem moves the canvas into the
  // running stand's slot); CSS shows it only while the canvas has the keyboard's focus
  canvas.addEventListener('focus', () => {
    if (aim.previousElementSibling !== canvas) canvas.after(aim);
  });
  canvas.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const p = view.pick(r.left + r.width / 2, r.top + r.height / 2, Infinity);
    const f = view.frame;
    if (p < 0 || !f) return;
    onPick(p);
    // where it is: x from the roll exit (the bite is x < 0), y from the middle of the thickness
    const mm = (v: number) => (v * 1e3).toFixed(2);
    say.textContent = `表示の中央の点を選んだ（出口から x = ${mm(f.pos[2 * p])} mm、板厚の中心から y = ${mm(f.pos[2 * p + 1])} mm）。値は「応力状態」に出る`;
  });
}
