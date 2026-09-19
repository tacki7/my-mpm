// Number inputs show their value rounded to 6 digits. An input whose text is still
// the one shown was not touched, and the conditions keep the value it had: reading
// the text back would turn −1/3 into −0.333333, so one edit would change the rest.

const shown = new WeakMap<HTMLInputElement, string>();

/** Put v in the input, rounded for display, and remember the text. */
export function showNumber(input: HTMLInputElement, v: number): void {
  const text = String(+v.toPrecision(6));
  input.value = text;
  shown.set(input, text);
}

/** Whether the text differs from the one last shown (true if nothing was shown). */
export function edited(input: HTMLInputElement): boolean {
  return shown.get(input) !== input.value;
}
