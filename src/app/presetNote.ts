// The preset's note at the top of the conditions: a paragraph folded to three lines, and after it a real button
// (aria-expanded, aria-controls) that opens and folds it — shown only while the folded note hides some of its words.
export class PresetNote {
  private readonly note: HTMLElement;
  private readonly more: HTMLButtonElement;

  constructor(note: HTMLElement) {
    this.note = note;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'note-more';
    more.setAttribute('aria-controls', note.id);
    more.addEventListener('click', () => this.set(!note.classList.contains('open')));
    note.after(more);
    this.more = more;
    // the lines a note takes change with the pane's width
    new ResizeObserver(() => this.fit()).observe(note);
    this.set(false);
  }

  /** a new note, folded */
  show(text: string): void {
    this.note.textContent = text;
    this.note.title = text;
    this.set(false);
  }

  private set(open: boolean): void {
    this.note.classList.toggle('open', open);
    this.more.setAttribute('aria-expanded', String(open));
    this.more.textContent = open ? 'たたむ' : '続きを読む';
    this.fit();
  }

  private fit(): void {
    if (!this.note.classList.contains('open')) this.more.hidden = this.note.scrollHeight <= this.note.clientHeight + 1;
  }
}
