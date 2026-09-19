// A live region (aria-live) is written only when its words change: writing the same words again every frame still
// changes the DOM, and a screen reader may read them out again each time.
export function say(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
