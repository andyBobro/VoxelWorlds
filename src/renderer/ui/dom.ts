export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

/** Drop a leading error code ("PBF_NO_COVERAGE: ...") so users never see internal codes. */
export function stripCode(msg: string): string {
  return msg.replace(/^[A-Z][A-Z_]{3,}:\s*/, '');
}

/** Strip Electron's "Error invoking remote method ..." wrapper. */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
