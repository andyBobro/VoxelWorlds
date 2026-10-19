/** DOM overlays of the walking window: HUD, prompt, toasts, fade, loading card, pause menu, fatal error. */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

export class WalkUi {
  readonly view: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly help: HTMLElement;
  private readonly cross: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly fadeEl: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly lTitle: HTMLElement;
  private readonly lText: HTMLElement;
  private readonly lBar: HTMLElement;
  private readonly lCancel: HTMLButtonElement;
  private readonly pause: HTMLElement;
  private readonly pResume: HTMLButtonElement;
  private readonly pTitle: HTMLElement;
  private readonly fatal: HTMLElement;
  private readonly fText: HTMLElement;
  private onCancel: (() => void) | null = null;

  constructor(root: HTMLElement, h: { onResume: () => void; onExit: () => void }) {
    root.textContent = '';
    this.view = el('div', '', root);
    this.view.id = 'walk-view';
    const layer = el('div', 'w-layer', root);
    this.hud = el('div', 'w-hud', layer);
    this.help = el('div', 'w-help', layer, 'WASD move  Shift run  Space jump  E interact  Wheel speed  F3 stats  F11 fullscreen  Esc menu');
    this.cross = el('div', 'w-cross', layer);
    this.prompt = el('div', 'w-prompt', layer);
    this.toasts = el('div', 'w-toasts', layer);
    this.fadeEl = el('div', 'w-fade', root);

    this.loading = el('div', 'w-overlay show', root);
    const lc = el('div', 'w-card', this.loading);
    this.lTitle = el('h2', '', lc, 'Loading');
    this.lText = el('p', '', lc, '');
    this.lBar = el('div', 'w-bar indet', lc);
    el('i', '', this.lBar);
    this.lCancel = el('button', '', el('div', 'w-row', lc), 'Cancel');
    this.lCancel.style.display = 'none';
    this.lCancel.addEventListener('click', () => this.onCancel?.());

    this.pause = el('div', 'w-overlay', root);
    const pc = el('div', 'w-card', this.pause);
    this.pTitle = el('h2', '', pc, 'Paused');
    el('p', '', pc, 'WASD move, Shift run, Space jump, E enter a building. Wheel changes walking speed. F3 shows statistics, F11 toggles fullscreen, Esc opens this menu (Esc again resumes).');
    const pr = el('div', 'w-row', pc);
    this.pResume = el('button', 'primary', pr, 'Resume');
    const pe = el('button', '', pr, 'Exit walking');
    this.pResume.addEventListener('click', h.onResume);
    pe.addEventListener('click', h.onExit);

    this.fatal = el('div', 'w-overlay', root);
    const fc = el('div', 'w-card', this.fatal);
    el('h2', '', fc, 'The walking view stopped');
    this.fText = el('p', 'err', fc, '');
    el('button', 'primary', el('div', 'w-row', fc), 'Exit walking').addEventListener('click', h.onExit);
  }

  showLoading(title: string, text: string, fraction: number | null, onCancel?: () => void): void {
    this.loading.classList.add('show');
    this.lTitle.textContent = title;
    this.lText.textContent = text;
    this.lBar.classList.toggle('indet', fraction === null);
    (this.lBar.firstElementChild as HTMLElement).style.width = fraction === null ? '' : `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    this.onCancel = onCancel ?? null;
    this.lCancel.style.display = onCancel ? '' : 'none';
    this.lCancel.disabled = false;
  }
  setLoadingCancelling(): void {
    this.lCancel.disabled = true;
    this.lText.textContent = 'Cancelling...';
  }
  get loadingVisible(): boolean {
    return this.loading.classList.contains('show');
  }
  hideLoading(): void {
    this.loading.classList.remove('show');
    this.onCancel = null;
  }

  showPause(v: boolean, first = false): void {
    this.pTitle.textContent = first ? 'Ready to walk' : 'Paused';
    this.pResume.textContent = first ? 'Start walking' : 'Resume';
    this.pause.classList.toggle('show', v);
    if (v) this.pResume.focus();
  }
  get pauseVisible(): boolean {
    return this.pause.classList.contains('show');
  }

  showFatal(msg: string): void {
    this.hideLoading();
    this.pause.classList.remove('show');
    this.fText.textContent = msg;
    this.fatal.classList.add('show');
  }

  setHud(text: string): void {
    if (this.hud.textContent !== text) this.hud.textContent = text;
  }
  setCrosshair(v: boolean): void {
    this.cross.style.display = v ? 'block' : 'none';
  }
  /** `html` is built from fixed strings plus escaped text; kbd marks keys */
  setPrompt(text: string | null, key?: string, warn = false, title = ''): void {
    if (!text) { this.prompt.style.display = 'none'; return; }
    this.prompt.textContent = '';
    if (key) { this.prompt.append('Press '); el('kbd', '', this.prompt, key); this.prompt.append(' '); }
    this.prompt.append(text);
    this.prompt.classList.toggle('warn', warn);
    this.prompt.title = title;
    this.prompt.style.display = 'block';
  }

  toast(text: string, kind: 'ok' | 'warn' | 'err' = 'ok', ms = 4000): void {
    const t = el('div', `w-toast ${kind}`, this.toasts, text);
    setTimeout(() => t.classList.add('out'), ms);
    setTimeout(() => t.remove(), ms + 400);
  }

  /** Fades to (true) / from (false) black; resolves when the transition ended. */
  fade(black: boolean): Promise<void> {
    if (this.fadeEl.classList.contains('on') === black) return Promise.resolve();
    this.fadeEl.classList.toggle('on', black);
    return new Promise((res) => setTimeout(res, 300));
  }

  dispose(): void {
    this.view.parentElement?.replaceChildren();
  }
}
