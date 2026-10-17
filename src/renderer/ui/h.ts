type Attrs = { class?: string; text?: string; title?: string; type?: string; value?: string; min?: string; max?: string; step?: string; placeholder?: string; disabled?: boolean; checked?: boolean; hidden?: boolean; id?: string; style?: string; open?: boolean };

/** Tiny DOM builder: h('div', {class:'x', text:'y'}, child, ...). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...kids: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === 'text') el.textContent = v as string;
    else if (k === 'class') el.className = v as string;
    else if (k === 'style') el.setAttribute('style', v as string);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null) el.append(c);
  return el;
}

export function field(label: string, input: HTMLElement, cls = ''): HTMLLabelElement {
  return h('label', { class: `field ${cls}`.trim() }, h('span', { text: label }), input);
}

export function num(value: number | string, aria: string): HTMLInputElement {
  const i = h('input', { type: 'text', value: String(value) });
  i.inputMode = 'decimal';
  i.autocomplete = 'off';
  i.setAttribute('aria-label', aria);
  return i;
}
