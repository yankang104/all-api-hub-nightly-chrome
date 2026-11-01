/** Pure helpers for talking to the Clash/Mihomo external controller. */

export const CLASH_CONTROLLER_SETTINGS_KEY = 'clashControllerSettings';
export const DEFAULT_CLASH_CONTROLLER_ADDRESS = '127.0.0.1:9097';

export interface ClashControllerConnection {
  address: string;
  secret?: string;
}

export interface ClashControllerSettings {
  address: string;
  secret: string;
}

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

const BUILTIN_PROXY_TYPES = new Set([
  'compatible',
  'direct',
  'pass',
  'reject',
  'rejectdrop',
]);

const POLICY_GROUP_TYPES = new Set([
  'fallback',
  'loadbalance',
  'relay',
  'selector',
  'smart',
  'urltest',
]);

const RESERVED_PROXY_NAMES = new Set([
  'COMPATIBLE',
  'DIRECT',
  'GLOBAL',
  'PASS',
  'REJECT',
  'REJECT-DROP',
]);

/**
 * Normalize an external-controller value to an HTTP(S) origin.
 *
 * Accepted examples: `9097`, `127.0.0.1:9097`, and
 * `http://localhost:9097/`. Only loopback hosts are allowed so a saved secret
 * cannot be forwarded to an arbitrary remote server. Paths are discarded
 * because the caller appends the API endpoint (`/listeners`, `/proxies`).
 */
export function normalizeClashControllerAddress(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  let raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) raw = `127.0.0.1:${raw}`;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;

  try {
    const url = new URL(raw);
    if (!HTTP_PROTOCOLS.has(url.protocol) || !url.hostname) return null;
    if (url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Build the optional controller authentication header from a raw secret. */
export function buildClashControllerAuthHeaders(secret: unknown): Record<string, string> {
  if (typeof secret !== 'string') return {};
  const normalized = secret.trim();
  if (!normalized || /[\r\n]/.test(normalized)) return {};
  return { Authorization: `Bearer ${normalized}` };
}

/**
 * Read leaf proxy names from Mihomo's `GET /proxies` response.
 *
 * Policy groups are identified structurally (`all`) or by the controller's
 * documented group types. Unknown leaf types are retained so a newly added
 * protocol does not disappear merely because this extension predates it.
 */
export function parseClashProxyNames(body: unknown): string[] {
  if (!isRecord(body) || !isRecord(body.proxies)) return [];

  const names: string[] = [];
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(body.proxies)) {
    if (!isRecord(value)) continue;

    const type = normalizedType(value.type);
    const candidate = typeof value.name === 'string' && value.name.trim()
      ? value.name.trim()
      : key.trim();
    if (!candidate || seen.has(candidate)) continue;

    const isGroup = Array.isArray(value.all) || POLICY_GROUP_TYPES.has(type);
    const isBuiltin = BUILTIN_PROXY_TYPES.has(type)
      || (!type && RESERVED_PROXY_NAMES.has(candidate.toUpperCase()));
    if (isGroup || isBuiltin) continue;

    seen.add(candidate);
    names.push(candidate);
  }

  return names;
}

function normalizedType(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s_-]+/g, '')
    : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
