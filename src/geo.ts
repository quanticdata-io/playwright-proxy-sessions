/** Where a proxy exits, as an IP echo reports it. */
export interface ExitInfo {
  ip: string;
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
}

/** The free QuanticData IP echo: no key, never cached, location as Cloudflare sees it. */
export const DEFAULT_ECHO_URL = 'https://api.quanticdata.io/v1/public/ip-echo';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Read an IP echo answer: the QuanticData envelope (`{type, payload}`) or a
 * flat object with the usual field names (`ip`/`origin`/`query`,
 * `countryCode`/`country_code`/`country`, `timezone`/`time_zone`,
 * `latitude`/`lat`, `longitude`/`lon`, or ipinfo-style `loc: "lat,lon"`).
 */
export function parseExit(body: unknown): ExitInfo {
  let data = (typeof body === 'string' ? JSON.parse(body) : body) as Record<string, unknown>;
  if (data && typeof data.payload === 'object' && data.payload !== null) data = data.payload as Record<string, unknown>;
  const ip = str(data?.ip) ?? str(data?.origin)?.split(',')[0]?.trim() ?? str(data?.query);
  if (!ip) throw new Error('the IP echo answer has no IP field');
  const out: ExitInfo = { ip };
  const country = str(data.countryCode) ?? str(data.country_code) ?? str(data.country);
  if (country) out.country = country.length === 2 ? country.toUpperCase() : country;
  const region = str(data.region) ?? str(data.regionName);
  if (region) out.region = region;
  const city = str(data.city);
  if (city) out.city = city;
  const tz = str(data.timezone) ?? str(data.time_zone);
  if (tz) out.timezone = tz;
  let lat = num(data.latitude) ?? num(data.lat);
  let lon = num(data.longitude) ?? num(data.lon);
  const loc = str(data.loc);
  if ((lat === undefined || lon === undefined) && loc && loc.includes(',')) {
    const [a, b] = loc.split(',');
    lat = num(a);
    lon = num(b);
  }
  if (lat !== undefined && lon !== undefined) {
    out.latitude = lat;
    out.longitude = lon;
  }
  return out;
}

/**
 * Default browser locale per exit country. A deliberate short list of the
 * main language of each country; pass `locale` yourself where the country has
 * several (Switzerland, Belgium, Canada, India...) or for any country missing here.
 */
export const COUNTRY_LOCALES: Readonly<Record<string, string>> = {
  AE: 'ar-AE', AR: 'es-AR', AT: 'de-AT', AU: 'en-AU', BE: 'nl-BE', BG: 'bg-BG', BR: 'pt-BR', CA: 'en-CA',
  CH: 'de-CH', CL: 'es-CL', CN: 'zh-CN', CO: 'es-CO', CZ: 'cs-CZ', DE: 'de-DE', DK: 'da-DK', EG: 'ar-EG',
  ES: 'es-ES', FI: 'fi-FI', FR: 'fr-FR', GB: 'en-GB', GR: 'el-GR', HK: 'zh-HK', HU: 'hu-HU', ID: 'id-ID',
  IE: 'en-IE', IL: 'he-IL', IN: 'en-IN', IT: 'it-IT', JP: 'ja-JP', KR: 'ko-KR', MX: 'es-MX', MY: 'ms-MY',
  NG: 'en-NG', NL: 'nl-NL', NO: 'nb-NO', NZ: 'en-NZ', PE: 'es-PE', PH: 'en-PH', PK: 'en-PK', PL: 'pl-PL',
  PT: 'pt-PT', RO: 'ro-RO', RS: 'sr-RS', RU: 'ru-RU', SA: 'ar-SA', SE: 'sv-SE', SG: 'en-SG', TH: 'th-TH',
  TR: 'tr-TR', TW: 'zh-TW', UA: 'uk-UA', US: 'en-US', VN: 'vi-VN', ZA: 'en-ZA',
};

export interface GeoMatch {
  timezoneId?: string;
  locale?: string;
  geolocation?: { latitude: number; longitude: number; accuracy: number };
}

/** Browser context settings that agree with where the proxy exits. */
export function geoMatch(exit: ExitInfo, overrides: { locale?: string } = {}): GeoMatch {
  const out: GeoMatch = {};
  if (exit.timezone) out.timezoneId = exit.timezone;
  const locale = overrides.locale ?? (exit.country ? COUNTRY_LOCALES[exit.country] : undefined);
  if (locale) out.locale = locale;
  if (exit.latitude !== undefined && exit.longitude !== undefined) {
    // City-level databases are rarely closer than a few kilometres.
    out.geolocation = { latitude: exit.latitude, longitude: exit.longitude, accuracy: 5000 };
  }
  return out;
}
