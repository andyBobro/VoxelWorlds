export interface CspOptions {
  dev: boolean;
  /** frame-ancestors is ignored (and warned about) in <meta> CSPs */
  forMeta?: boolean;
}

export function buildCsp({ dev, forMeta = false }: CspOptions): string {
  const scripts = dev ? "'self' 'unsafe-inline'" : "'self'";
  const connect = dev ? "'self' ws://localhost:* http://localhost:*" : "'self'";
  const parts = [
    "default-src 'self'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  if (!forMeta) parts.push("frame-ancestors 'none'");
  return parts.join('; ');
}
