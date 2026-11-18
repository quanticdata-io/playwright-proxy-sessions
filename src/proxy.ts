/** A proxy in the shape Playwright and Puppeteer take. */
export interface ProxyEndpoint {
  /** `scheme://host:port`, no credentials: Playwright's `proxy.server`, Puppeteer's `proxyServer`. */
  server: string;
  scheme: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const SCHEMES: Record<string, ProxyEndpoint['scheme']> = {
  http: 'http',
  https: 'https',
  socks4: 'socks4',
  socks4a: 'socks4',
  socks5: 'socks5',
  socks5h: 'socks5',
};

export class ProxyParseError extends Error {
  override name = 'ProxyParseError';
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function hostPort(text: string, original: string): { host: string; port: number } {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^\s:@/[\]]+):(\d{1,5})$/.exec(text);
  if (!m) throw new ProxyParseError(`expected host:port in ${redact(original)}`);
  const port = Number(m[2]);
  if (port < 1 || port > 65535) throw new ProxyParseError(`port out of range in ${redact(original)}`);
  return { host: m[1]!.toLowerCase(), port };
}

/** Hide the password of a proxy string, for errors and logs. */
export function redact(text: string): string {
  const at = text.lastIndexOf('@');
  if (at >= 0) {
    const head = text.slice(0, at);
    const colon = head.lastIndexOf(':');
    const schemeEnd = head.indexOf('://');
    if (colon > schemeEnd + 2) return `${head.slice(0, colon)}:*****${text.slice(at)}`;
    return text;
  }
  const parts = text.split(':');
  return parts.length >= 4 ? [...parts.slice(0, 3), '*****'].join(':') : text;
}

/**
 * Parse `host:port`, `user:pass@host:port`, `host:port:user:pass` or
 * `scheme://[user:pass@]host:port`. Strings without a scheme are `http`.
 */
export function parseProxy(input: string, defaultScheme: ProxyEndpoint['scheme'] = 'http'): ProxyEndpoint {
  const raw = input.trim();
  if (!raw) throw new ProxyParseError('empty proxy string');
  let scheme = defaultScheme;
  let rest = raw;
  const sep = raw.indexOf('://');
  if (sep >= 0) {
    const name = raw.slice(0, sep).toLowerCase();
    const known = SCHEMES[name];
    if (!known) throw new ProxyParseError(`unsupported scheme "${name}" in ${redact(raw)}`);
    scheme = known;
    rest = raw.slice(sep + 3).replace(/\/$/, '');
  }
  let username: string | undefined;
  let password: string | undefined;
  let address = rest;
  const pieces = rest.split(':');
  if (sep < 0 && pieces.length >= 4 && /^\d+$/.test(pieces[1]!) && !pieces[0]!.includes('@')) {
    address = `${pieces[0]}:${pieces[1]}`;
    username = decode(pieces[2]!);
    password = decode(pieces.slice(3).join(':'));
  } else {
    const at = rest.lastIndexOf('@');
    if (at >= 0) {
      const creds = rest.slice(0, at);
      address = rest.slice(at + 1);
      const colon = creds.indexOf(':');
      username = decode(colon >= 0 ? creds.slice(0, colon) : creds);
      password = colon >= 0 ? decode(creds.slice(colon + 1)) : undefined;
    }
  }
  const { host, port } = hostPort(address, raw);
  const out: ProxyEndpoint = { server: `${scheme}://${host}:${port}`, scheme, host, port };
  if (username) {
    out.username = username;
    if (password !== undefined) out.password = password;
  }
  return out;
}

/** `scheme://user:*****@host:port`, safe for logs. */
export function maskProxy(p: ProxyEndpoint): string {
  if (!p.username) return p.server;
  return `${p.scheme}://${encodeURIComponent(p.username)}:*****@${p.host}:${p.port}`;
}

/** A stable key for a proxy (server and username, not the password). */
export function proxyKey(p: ProxyEndpoint): string {
  return `${p.server}#${p.username ?? ''}`;
}
