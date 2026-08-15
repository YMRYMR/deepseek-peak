/**
 * Live balance fetch through the host's `/api/peak-hours/balance` route.
 *
 * The browser never holds the DeepSeek API key. The host face
 * (`src/index.ts`) reads the key from the credentials seam (or the
 * launch environment) and answers JSON over a same-origin GET, so this
 * fetch has no CORS surface and no secret ever reaches the browser tab.
 *
 * Wire shape:
 *   GET /api/peak-hours/balance
 *   Accept: application/json
 *   → 200 application/json
 *     { "ok": true, "balance": { "entries": [...], "isAvailable": true,
 *                                  "refreshedAt": 1700000000000 } }
 *     | { "ok": false, "error": { "kind": "no-key"|"network"|"http"|"parse"|"unavailable",
 *                                  "status"?: number, "message": "..." } }
 *
 * The host cache is 5 min; this client wraps the same TTL so a hover
 * storm over the same 5-min window costs at most one network round-trip.
 */

const BALANCE_ENDPOINT = '/api/peak-hours/balance'
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
  /** Epoch ms when the host's upstream fetch settled. */
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

/**
 * Fetch the current DeepSeek balance through the host's proxy. The
 * key never enters this function — the host resolves it from its own
 * credentials seam and returns the JSON payload below. A 200 with
 * `ok: false` is the documented failure shape; anything else is a
 * transport-level error and gets translated to a `network` kind.
 *
 * `fresh=true` adds `?fresh=1` to bypass the host's 5-min cache and
 * force an upstream re-fetch. The browser cache is the caller's
 * concern — pass `fresh=true` together with a `BalanceCache.invalidate()`
 * for a full cache-bust on both sides.
 */
export async function fetchBalance(fresh: boolean = false): Promise<BalanceResult> {
  const url = fresh ? `${BALANCE_ENDPOINT}?fresh=1` : BALANCE_ENDPOINT
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      // Same-origin GET; the webserver's no-credentials default is fine.
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
    // The host is documented to answer 200 with a JSON error envelope;
    // any other status is a wire surprise worth surfacing as `http`.
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
  return parseEnvelope(body)
}

/**
 * Validate the host's JSON envelope. The host-side source of truth is
 * `src/index.ts`'s `BalanceJson`; this parser mirrors it shape-for-shape
 * so a host-side change surfaces as a `parse` error here, not a runtime
 * exception.
 */
function parseEnvelope(body: unknown): BalanceResult {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: { kind: 'parse', message: 'envelope is not an object' } }
  }
  const env = body as Record<string, unknown>
  if (env.ok === true) {
    const raw = env.balance
    if (raw === null || typeof raw !== 'object') {
      return { ok: false, error: { kind: 'parse', message: 'balance field is not an object' } }
    }
    const bal = raw as Record<string, unknown>
    const rawEntries = bal.entries
    if (!Array.isArray(rawEntries)) {
      return { ok: false, error: { kind: 'parse', message: 'entries is not an array' } }
    }
    const entries: BalanceEntry[] = []
    for (const e of rawEntries) {
      if (e === null || typeof e !== 'object') continue
      const item = e as Record<string, unknown>
      const currency = typeof item.currency === 'string' ? item.currency : ''
      const total = asNumber(item.total)
      const granted = asNumber(item.granted) ?? 0
      const toppedUp = asNumber(item.toppedUp) ?? 0
      if (currency.length === 0 || total === null) continue
      entries.push({ currency, total, granted, toppedUp })
    }
    if (entries.length === 0) {
      return { ok: false, error: { kind: 'parse', message: 'no valid balance entries' } }
    }
    return {
      ok: true,
      balance: {
        entries,
        isAvailable: bal.isAvailable !== false,
        refreshedAt: typeof bal.refreshedAt === 'number' ? bal.refreshedAt : Date.now(),
      },
    }
  }
  if (env.ok === false) {
    const err = env.error
    if (err === null || typeof err !== 'object') {
      return { ok: false, error: { kind: 'parse', message: 'error field is not an object' } }
    }
    const e = err as Record<string, unknown>
    const kindRaw = e.kind
    const kind: BalanceError['kind'] =
      kindRaw === 'no-key' || kindRaw === 'network' || kindRaw === 'http'
      || kindRaw === 'parse' || kindRaw === 'unavailable'
        ? kindRaw
        : 'parse'
    const message = typeof e.message === 'string' ? e.message : 'unspecified error'
    const status = typeof e.status === 'number' ? e.status : undefined
    return { ok: false, error: status === undefined ? { kind, message } : { kind, status, message } }
  }
  return { ok: false, error: { kind: 'parse', message: 'envelope.ok is not a boolean' } }
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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
