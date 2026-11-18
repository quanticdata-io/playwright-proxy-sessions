import { parseProxy, type ProxyEndpoint } from './proxy.js';

/**
 * Proxy strings from a QuanticData plan, through the documented and free
 * `POST /public/proxies/generate` endpoint (https://quanticdata.io/docs/).
 * The strings come back with targeting and session applied; they are used as
 * returned. Traffic through them is billed by the plan.
 */
export interface GenerateOptions {
  orderId: string;
  /** 1 to 10000. Default 10. */
  quantity?: number;
  /** Default `http`: Chromium cannot authenticate to SOCKS5 proxies. */
  protocol?: 'http' | 'socks5';
  country?: string;
  state?: string;
  city?: string;
  /** ISP or carrier code (Residential Premium, Mobile). */
  isp?: string;
  rotation?: 'rotating' | 'sticky' | 'static';
  /** Sticky session minutes. */
  sessionTime?: number;
  /** Residential Premium and Mobile: keep the IP for as long as the device is online. */
  superSticky?: boolean;
  gateway?: 'ww' | 'us' | 'eu' | 'as';
  /** Defaults to `process.env.QUANTICDATA_API_KEY`. */
  apiKey?: string;
  /** Defaults to `process.env.QUANTICDATA_API_BASE` or `https://api.quanticdata.io/v1`. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class QuanticDataError extends Error {
  override name = 'QuanticDataError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(`QuanticData API: ${message} (HTTP ${status})`);
  }
}

export async function generateProxies(options: GenerateOptions): Promise<ProxyEndpoint[]> {
  const { apiKey, baseUrl, fetch: doFetch, orderId, quantity, protocol, ...targeting } = options;
  const key = (apiKey ?? process.env.QUANTICDATA_API_KEY ?? '').trim();
  if (!key) throw new Error('QUANTICDATA_API_KEY is not set: create an API key in the QuanticData dashboard');
  if (!orderId?.trim()) throw new Error('orderId is required (GET /public/proxies lists your plans)');
  const q = quantity ?? 10;
  if (!Number.isInteger(q) || q < 1 || q > 10000) throw new Error('quantity must be between 1 and 10000');
  const proto = protocol ?? 'http';
  const body: Record<string, unknown> = { orderId, quantity: q, protocol: proto, format: `${proto}://user:pass@host:port` };
  for (const [k, v] of Object.entries(targeting)) if (v !== undefined && v !== false && v !== '') body[k] = v;
  const base = (baseUrl ?? process.env.QUANTICDATA_API_BASE ?? 'https://api.quanticdata.io/v1').replace(/\/$/, '');
  const res = await (doFetch ?? fetch)(`${base}/public/proxies/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let envelope: { type?: string; message?: string; payload?: { proxies?: string[] } };
  try {
    envelope = (await res.json()) as typeof envelope;
  } catch {
    throw new QuanticDataError('the answer is not JSON', res.status);
  }
  if (!res.ok || envelope.type !== 'response') throw new QuanticDataError(envelope.message ?? 'unknown error', res.status);
  return (envelope.payload?.proxies ?? []).map((line) => parseProxy(line, proto));
}
