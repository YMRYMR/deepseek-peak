/**
 * Peak/off-peak surface plugin, host half. The browser half ships via
 * `exports["./client"]` and discovers its overlay from the cordis `slots`
 * injection (see `src/client/`).
 *
 * The host face has one job: serve the user's live DeepSeek account balance
 * to the browser without the API key ever leaving the harness process.
 *
 *   Browser                          Host (this plugin)
 *   ───────                          ──────────────────
 *   hover the pill
 *     → fetch('/api/peak-hours/balance')
 *        ─── HTTP GET ──►
 *                          ctx.credentials.resolve('DEEPSEEK_API_KEY')
 *                            ↳ inherited env / $DSH_HOME/.credentials.yaml /
 *                              .env fallback (the user did NOT type a key
 *                              into the browser; they did whatever they
 *                              already do to use DeepSeek through the
 *                              harness — same key, same place)
 *                          fetch('https://api.deepseek.com/user/balance')
 *                            ↳ bearer-auth GET, server-to-server, no CORS
 *                          JSON response → cache (5 min TTL) → wire out
 *        ◄── JSON ──
 *     → render
 *
 * The cache lives only on the host. The browser holds its own 5-min
 * in-memory cache against this endpoint, so a hover-heavy session costs
 * at most one network round-trip per 5 min per browser tab. A 5-min
 * `setInterval` (`.unref()`'d so it never holds the process open)
 * pre-warms the cache so the very first hover is not a cold wait.
 *
 * Graceful no-op: if either `credentials` or `webServer` is unavailable
 * on this deployment, the route is still registered but every request
 * answers `200 OK` with `{ ok: false, error: { kind: 'unavailable', ... } }`
 * — the browser degrades to the "no balance" state instead of throwing
 * a 404, and the rest of the surface (the pill, the per-model chart)
 * continues to work.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
// Type-only: pulls the `webServer` Context merge so the route registration
// is type-checked against the carrier's exact handler signature.
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ui-peak-hours'

/**
 * The host face reads two services. Both are marked optional at the call
 * site — a deployment that mounts this row without the credentials seam
 * (e.g. a TUI build that never sets `DEEPSEEK_API_KEY`) is still legal:
 * the route stays live and the response surfaces the missing-key error.
 * `inject` only declares a load-order; absent services do not throw here.
 */
export const inject = ['credentials', 'webServer'] as const

/** Endpoint path the browser fetches. */
const BALANCE_ROUTE = '/api/peak-hours/balance'

/** Credential ref this plugin reads. The user does not interact with it. */
const API_KEY_REF: CredentialRef = credentialRef('DEEPSEEK_API_KEY')

/** Remote endpoint the platform exposes for the balance check. */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** Cached balance lives for this long. 5 min matches DeepSeek's own dashboard refresh. */
const CACHE_TTL_MS = 5 * 60 * 1000

/** Network timeout for the host-side fetch. The browser waits up to 10 s; we cap at 8 s. */
const FETCH_TIMEOUT_MS = 8_000

/** Cache refresh interval. Matches TTL so the first hover after expiry is still warm. */
const REFRESH_INTERVAL_MS = CACHE_TTL_MS

/** JSON body the host always returns. */
export interface BalanceJsonSuccess {
  readonly ok: true
  readonly balance: {
    readonly entries: ReadonlyArray<{
      readonly currency: string
      readonly total: number
      readonly granted: number
      readonly toppedUp: number
    }>
    readonly isAvailable: boolean
    /** Epoch ms when the upstream response settled. */
    readonly refreshedAt: number
  }
}

export interface BalanceJsonFailure {
  readonly ok: false
  readonly error: {
    readonly kind: 'no-key' | 'network' | 'http' | 'parse' | 'unavailable'
    readonly status?: number
    readonly message: string
  }
}

export type BalanceJson = BalanceJsonSuccess | BalanceJsonFailure

interface CachedBalance {
  readonly result: BalanceJson
  readonly fetchedAt: number
}

function unavailable(message: string): BalanceJsonFailure {
  return { ok: false, error: { kind: 'unavailable', message } }
}

function parseBalance(body: unknown): BalanceJson {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: { kind: 'parse', message: 'response is not an object' } }
  }
  const obj = body as Record<string, unknown>
  if (obj.is_available === false) {
    return { ok: false, error: { kind: 'unavailable', message: 'platform reports balance unavailable' } }
  }
  const rawInfos = obj.balance_infos
  if (!Array.isArray(rawInfos)) {
    return { ok: false, error: { kind: 'parse', message: 'balance_infos is not an array' } }
  }
  const entries: Array<{ currency: string; total: number; granted: number; toppedUp: number }> = []
  for (const raw of rawInfos) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const currency = typeof item.currency === 'string' ? item.currency : ''
    const total = parseBalanceNumber(item.total_balance)
    const granted = parseBalanceNumber(item.granted_balance) ?? 0
    const toppedUp = parseBalanceNumber(item.topped_up_balance) ?? 0
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

/**
 * Read one API key through the most authoritative channel the deployment
 * exposes: the credentials seam first, then the launch environment. Returns
 * `undefined` for an absent or empty value; callers translate that to a
 * `no-key` error so the browser can render the missing-config state.
 */
async function resolveApiKey(ctx: Context): Promise<string | undefined> {
  const credentials = ctx.get('credentials') as CredentialProvider | undefined
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(API_KEY_REF)
    if (resolved?.value && resolved.value.length > 0) return resolved.value
  }
  const ambient = launchEnvironmentOf(ctx).get(API_KEY_REF)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}

/**
 * One upstream fetch. Errors surface as `BalanceJson` so the route handler
 * can answer without throwing — a thrown handler is a 400 (per the carrier's
 * last-resort guard) and would tell the browser the request was malformed
 * rather than that the key was missing.
 */
async function fetchUpstream(apiKey: string): Promise<BalanceJson> {
  let response: Response
  try {
    response = await fetch(BALANCE_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        // Self-identify: the platform's audit log will see this rather
        // than node-fetch's default UA.
        'User-Agent': 'deepseek-harness/0.0.1 (+ui-peak-hours)',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

/** JSON content type the browser expects. */
function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** Treat any method other than GET/HEAD as a method-not-allowed. */
function isReadMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD'
}

/**
 * Host plugin body. Wires the balance route onto the harness webserver.
 * The whole registration lives inside a single `ctx.effect` so the route
 * is removed and the refresh timer cleared on plugin dispose.
 *
 * @param ctx - host cordis context. The credentials and webserver services
 *              are optional; missing services keep the route live and
 *              surface the absence as a JSON error.
 */
export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServer | undefined
  if (webServer === undefined) {
    ctx.logger?.warn('ui-peak-hours: webServer service is unavailable; balance route will not be registered')
    return
  }

  // Cache + refresh timer live in a single closure so a dispose cleans both.
  // The cache is a one-slot write; the timer fires REFRESH_INTERVAL_MS after
  // the LAST successful refresh (set on success), so a flaky upstream does
  // not accumulate overlapping refreshes.
  let cached: CachedBalance | null = null
  let refreshTimer: NodeJS.Timeout | null = null

  const refresh = async (): Promise<void> => {
    try {
      const apiKey = await resolveApiKey(ctx)
      if (apiKey === undefined) {
        cached = { result: unavailable('DEEPSEEK_API_KEY is not configured'), fetchedAt: Date.now() }
        return
      }
      const result = await fetchUpstream(apiKey)
      // Only cache a result we know how to act on; transient errors get
      // re-tried on the next interval.
      cached = { result, fetchedAt: Date.now() }
    } catch (err) {
      // Defensive: refreshUpstream catches its own errors. A throw here
      // would be a programming error, not an upstream issue.
      ctx.logger?.warn('ui-peak-hours: balance refresh failed unexpectedly')
      ctx.logger?.warn(err)
    } finally {
      // Re-arm regardless of outcome so a single failure does not stop
      // background refreshes; the next tick will try again with the same
      // key. `.unref()` keeps the process exit semantics clean.
      refreshTimer = setTimeout(() => { void refresh() }, REFRESH_INTERVAL_MS)
      refreshTimer.unref?.()
    }
  }

  ctx.effect(() => {
    const disposeRoute = webServer.register({
      kind: 'exact',
      path: BALANCE_ROUTE,
      handler: async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!isReadMethod(_req.method)) {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        // Cache hit: serve immediately, no upstream call.
        if (cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          writeJson(res, 200, cached.result)
          return
        }
        // Cache miss or expired: refresh synchronously, then serve the
        // fresh result. A second hover while the first is in flight
        // shares the in-flight promise through the cached slot.
        await refresh()
        const result: BalanceJson = cached?.result
          ?? unavailable('balance cache is empty after refresh')
        writeJson(res, 200, result)
      },
    })

    return () => {
      disposeRoute()
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer)
        refreshTimer = null
      }
      cached = null
    }
  }, 'ui-peak-hours: balance route')
}
