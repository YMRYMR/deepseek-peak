/**
 * Live balance fetch against the DeepSeek platform `/user/balance` endpoint.
 *
 * Source of truth for the API:
 *   GET https://api.deepseek.com/user/balance
 *   Authorization: Bearer <API_KEY>
 *   Accept: application/json
 *
 * Response shape:
 *   {
 *     "is_available": boolean,
 *     "balance_infos": [
 *       { "currency": "USD", "total_balance": "25.50",
 *         "granted_balance": "5.00", "topped_up_balance": "20.50" }
 *     ]
 *   }
 *
 * Two risk surfaces to be honest about:
 *   1. CORS: `api.deepseek.com` may not allow cross-origin reads from the
 *      harness dev origin (`http://127.0.0.1:3080`). If the OPTIONS preflight
 *      is rejected, the fetch fails with a TypeError and the caller falls
 *      back to "spent only" mode.
 *   2. Key-in-browser: storing the API key in `localStorage` is fine for a
 *      local dev tool the user runs themselves, but we never log or display
 *      the value back. The settings UI shows only the last-4 characters.
 *
 * The key never leaves the browser. The fetch is a plain GET with an
 * Authorization header — no body, no cookies, no user-agent fingerprinting.
 */

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const STORAGE_KEY = 'peak-hours.deepseek.apiKey'
/** Cached balance is reused for this many ms before re-fetching. */
const CACHE_TTL_MS = 5 * 60 * 1000

export interface BalanceEntry {
  readonly currency: string
  readonly total: number
  readonly granted: number
  readonly toppedUp: number
}

export interface BalanceSnapshot {
  readonly entries: readonly BalanceEntry[]
  readonly isAvailable: boolean
  /** Epoch ms when the fetch resolved. */
  readonly refreshedAt: number
}

export interface BalanceError {
  readonly kind: 'no-key' | 'network' | 'http' | 'parse' | 'unavailable'
  readonly status?: number
  readonly message: string
}

export type BalanceResult =
  | { ok: true; balance: BalanceSnapshot }
  | { ok: false; error: BalanceError }

/** Read the persisted API key, or null if the user has not set one. */
export function readApiKey(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Persist the API key. Pass null to clear. */
export function writeApiKey(value: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (value === null || value.length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // localStorage may be disabled (private mode, sandboxed iframe) — fail silent.
  }
}

/** Mask a key for display: only the last 4 chars are visible. */
export function maskKey(value: string | null): string {
  if (value === null) return 'not set'
  if (value.length <= 4) return '••••'
  return `••••${value.slice(-4)}`
}

/**
 * Fetch the current DeepSeek balance. The caller is responsible for
 * caching; this function does not consult any in-memory store.
 */
export async function fetchBalance(apiKey: string): Promise<BalanceResult> {
  if (apiKey.length === 0) {
    return { ok: false, error: { kind: 'no-key', message: 'API key is empty' } }
  }
  let response: Response
  try {
    response = await fetch(BALANCE_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      // Never send cookies — this is a plain bearer-auth GET.
      credentials: 'omit',
      // 10 s is generous; the platform usually answers in <1 s.
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'network',
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      error: {
        kind: 'http',
        status: response.status,
        message: `HTTP ${response.status} ${response.statusText}`,
      },
    }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: err instanceof Error ? err.message : 'invalid JSON',
      },
    }
  }
  return parseBalance(body)
}

function parseBalance(body: unknown): BalanceResult {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: { kind: 'parse', message: 'response is not an object' } }
  }
  const obj = body as Record<string, unknown>
  if (obj.is_available === false) {
    return {
      ok: false,
      error: { kind: 'unavailable', message: 'platform reports balance unavailable' },
    }
  }
  const rawInfos = obj.balance_infos
  if (!Array.isArray(rawInfos)) {
    return { ok: false, error: { kind: 'parse', message: 'balance_infos is not an array' } }
  }
  const entries: BalanceEntry[] = []
  for (const raw of rawInfos) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const currency = typeof item.currency === 'string' ? item.currency : ''
    const total = parseBalanceNumber(item.total_balance)
    const granted = parseBalanceNumber(item.granted_balance)
    const toppedUp = parseBalanceNumber(item.topped_up_balance)
    if (currency.length === 0 || total === null) continue
    entries.push({
      currency,
      total,
      granted: granted ?? 0,
      toppedUp: toppedUp ?? 0,
    })
  }
  if (entries.length === 0) {
    return { ok: false, error: { kind: 'parse', message: 'no valid balance entries' } }
  }
  return {
    ok: true,
    balance: {
      entries,
      isAvailable: obj.is_available !== false,
      refreshedAt: Date.now(),
    },
  }
}

function parseBalanceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** In-memory cache wrapper. Caller holds the cache across hovers. */
export class BalanceCache {
  private cached: { result: BalanceResult; at: number } | null = null

  get valid(): boolean {
    return this.cached !== null && Date.now() - this.cached.at < CACHE_TTL_MS
  }

  get value(): BalanceResult | null {
    return this.valid ? this.cached!.result : null
  }

  set(result: BalanceResult): void {
    this.cached = { result, at: Date.now() }
  }

  invalidate(): void {
    this.cached = null
  }
}
