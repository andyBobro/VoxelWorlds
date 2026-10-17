export type TabName = 'map' | 'preview' | 'worlds';

export class Tabs {
  private buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
  private listeners: Array<(t: TabName) => void> = [];
  current: TabName = 'map';

  constructor() {
    for (const b of this.buttons) b.addEventListener('click', () => this.show(b.dataset.tab as TabName));
  }

  onChange(cb: (t: TabName) => void): void {
    this.listeners.push(cb);
  }

  show(name: TabName): void {
    this.current = name;
    for (const b of this.buttons) b.classList.toggle('active', b.dataset.tab === name);
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    for (const cb of this.listeners) cb(name);
  }
}
