import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const QUERY_KEY_NAMES = new Set(['api_key', 'apikey', 'apiKey', 'x-api-key']);
const ENV_PATHS = [
  () => path.resolve(process.cwd(), '.env'),
  () => path.resolve(__dirname, '../../.env'),
];

let cachedKeys: Set<string> | null = null;
let cachedRaw: string | null = null;

function parseKeys(raw: string) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

function parseApiKeys() {
  const rawEnv = String(process.env.API_KEYS || process.env.API_KEY || '');
  if (cachedKeys && cachedRaw === rawEnv) return cachedKeys;

  let raw = rawEnv;
  if (!raw) {
    for (const pick of ENV_PATHS) {
      const p = pick();
      if (!fs.existsSync(p)) continue;
      try {
        const parsed = dotenv.parse(fs.readFileSync(p));
        raw = String(parsed.API_KEYS || parsed.API_KEY || '');
        if (raw) break;
      } catch {
        // ignore and continue to next path
      }
    }
  }

  cachedRaw = rawEnv || raw;
  cachedKeys = parseKeys(raw);
  return cachedKeys;
}

function extractHeaderValue(v: any) {
  if (!v) return null;
  if (Array.isArray(v)) return v[0];
  return String(v);
}

function extractAuthKey(req: any) {
  const headerKey = extractHeaderValue(req.headers?.['x-api-key']);
  if (headerKey) return headerKey;

  const auth = extractHeaderValue(req.headers?.authorization);
  if (!auth) return null;
  const raw = auth.trim();
  const parts = raw.split(/\s+/);
  if (parts.length === 2 && /^(bearer|apikey|token)$/i.test(parts[0])) {
    return parts[1];
  }
  return null;
}

function hasQueryKey(req: any) {
  const q = req.query || {};
  for (const k of Object.keys(q)) {
    if (QUERY_KEY_NAMES.has(k)) return true;
  }
  return false;
}

export function apiKeyGuard(req: any, res: any, next: any) {
  if (hasQueryKey(req)) {
    return res.status(400).json({
      success: false,
      error: 'api key must be provided in headers, not query params',
    });
  }

  if (req.method === 'OPTIONS') return next();

  const path = String(req.path || '').toLowerCase();
  if (path === '/ping' || path === '/health' || path === '/healthz' || path === '/readyz') {
    return next();
  }

  const keys = parseApiKeys();
  if (keys.size === 0) {
    return next();
  }

  const key = extractAuthKey(req);
  if (!key || !keys.has(key)) {
    return res.status(401).json({
      success: false,
      error: 'invalid or missing api key',
    });
  }

  return next();
}
