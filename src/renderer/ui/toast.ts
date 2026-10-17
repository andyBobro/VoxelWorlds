let host: HTMLElement | null = null;

/** Small non-blocking notice, bottom centre; auto-dismisses. */
export function toast(text: string, kind: 'ok' | 'warn' | 'err' = 'ok', ms = 3500): void {
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}
