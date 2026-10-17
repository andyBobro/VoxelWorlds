import { h } from './h';

export interface ModalHandle {
  root: HTMLElement;
  body: HTMLElement;
  close(): void;
}

/** Generic centred dialog over a dimmed backdrop. Esc / backdrop click / close button call `onClose` (default: close). */
export function openModal(title: string, opts: { wide?: boolean; onClose?: () => void; cls?: string } = {}): ModalHandle {
  const body = h('div', { class: 'modal-body' });
  const closeBtn = h('button', { class: 'modal-x', text: '×', title: 'Close', type: 'button' });
  const box = h('div', { class: `modal-box ${opts.wide ? 'wide' : ''} ${opts.cls ?? ''}`.trim() },
    h('div', { class: 'modal-head' }, h('h2', { text: title }), closeBtn), body);
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  const root = h('div', { class: 'modal-back' }, box);
  const handle: ModalHandle = {
    root, body,
    close: () => {
      document.removeEventListener('keydown', onKey, true);
      root.remove();
    },
  };
  const request = (): void => (opts.onClose ?? handle.close)();
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    // only the topmost modal reacts
    const all = document.querySelectorAll('.modal-back');
    if (all[all.length - 1] !== root) return;
    e.stopPropagation();
    request();
  };
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('mousedown', (e) => { if (e.target === root) request(); });
  closeBtn.addEventListener('click', request);
  document.body.appendChild(root);
  return handle;
}

/** Promise-based confirm dialog. Resolves true on the confirm button, false on cancel/Esc/backdrop. */
export function confirmBox(o: { title: string; message: string; okLabel: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let m: ModalHandle;
    const done = (v: boolean): void => { m.close(); resolve(v); };
    m = openModal(o.title, { onClose: () => done(false), cls: 'confirm' });
    const ok = h('button', { class: o.danger ? 'danger' : 'primary', text: o.okLabel, type: 'button' });
    const no = h('button', { text: 'Cancel', type: 'button' });
    ok.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    m.body.append(h('p', { class: 'confirm-msg', text: o.message }), h('div', { class: 'row buttons' }, no, ok));
    no.focus();
  });
}
