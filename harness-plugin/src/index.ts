/**
 * Peak/off-peak surface plugin, host half. The browser half ships via
 * `exports["./client"]` and discovers its overlay from the cordis `slots`
 * injection (see `src/client/`).
 *
 * The host face runs three responsibilities that all live behind one
 * apply() so a single plugin fiber owns the whole feature:
 *
 *   1. **Live balance proxy** — `GET /api/peak-hours/balance` resolves
 *      `DEEPSEEK_API_KEY` through `ctx.credentials` and forwards to
 *      `https://api.deepseek.com/user/balance`, so the key never leaves
 *      the harness process. Cached 5 min host-side, 5 min browser-side.
 *
 *   2. **Pause-during-peak switch** — `GET /api/peak-hours/state` exposes
 *      the live state (`isPaused`, `phase`, `isBlockedNow`, `queueSize`,
 *      `nextPhaseAt`); `POST /api/peak-hours/state` toggles the global
 *      paused flag. The persisted boolean survives restarts (settings
 *      section) and is read on apply.
 *
 *   3. **LLM stream gate** — when the switch is ON and the current UTC
 *      hour is inside a peak window, every LLM stream call is held in
 *      an in-memory FIFO queue. The first item drains the moment the
 *      phase flips to off-peak (or the user toggles the switch off);
 *      items dispatch strictly in arrival order so a peak-window burst
 *      leaves in the same order it arrived.
 *
 * Graceful no-op: if any optional service (`credentials`, `webServer`,
 * `llm`, `settings`) is missing, the affected surface degrades to a
 * documented error envelope or a no-op rather than throwing at apply.
 *
 *   Browser                          Host (this plugin)
 *   ───────                          ──────────────────
 *   hover the pill
 *     → fetch('/api/peak-hours/balance')
 *        ─── HTTP GET ──►
 *                          ctx.credentials.resolve('DEEPSEEK_API_KEY')
 *                          fetch('https://api.deepseek.com/user/balance')
 *                          cache (5 min) → JSON envelope
 *        ◄── JSON ──
 *
 *   click the pause switch
 *     → fetch('/api/peak-hours/state', { method: 'POST', body: { paused } })
 *        ─── HTTP POST ──►
 *                          settings.update(NS, { paused }) → persists
 *                          onChange → recompute isBlockedNow
 *        ◄── JSON ──
 *
 *   user sends a chat message
 *     → ctx.llm.stream(options)  (in the host process)
 *        ── 'llm/stream' waterfall ──►
 *                          if isBlockedNow:
 *                            enqueue({ options, next })
 *                            return queuedStream(drainPromise, signal)
 *                          else:
 *                            return next()  (immediate dispatch)
 *
 *   1 Hz tick
 *     → recompute phase from UTC clock
 *     → if phase just flipped peak→off: drain queue in order
 *     → if phase just flipped off→peak: no-op (next request gets queued)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the `webServer` Context merge so the route registration
// is type-checked against the carrier's exact handler signature.
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { currentPhase, isPeak, type Phase, type PhaseSnapshot } from './phase.ts'
import { costForUsage, type TokenUsage as PricingUsage } from './client/pricing.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ui-peak-hours'

/**
 * The host face reads five services. They are declared in `inject` so the
 * cordis fiber waits for activation; at the call site each is still checked
 * for `undefined` because a deployment that omits one (e.g. a TUI build that
 * does not register the credentials seam) must not crash the plugin — it
 * degrades the affected surface to a documented error envelope instead.
 */
export const inject = ['credentials', 'webServer', 'llm', 'settings', 'sessionPersistence'] as const

/* -------------------------------------------------------------------------- *
 *  Balance proxy (existing route, unchanged wire shape)
 * -------------------------------------------------------------------------- */

/** Endpoint path the browser fetches. */
const BALANCE_ROUTE = '/api/peak-hours/balance'

/** Credential ref this plugin reads. The user does not interact with it. */
const API_KEY_REF: CredentialRef = credentialRef('DEEPSEEK_API_KEY')

/** Remote endpoint the platform exposes for the balance check. */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** Cached balance lives for this long. 5 min matches DeepSeek's own dashboard refresh. */
const BALANCE_CACHE_TTL_MS = 5 * 60 * 1000

/** Network timeout for the host-side fetch. The browser waits up to 10 s; we cap at 8 s. */
const BALANCE_FETCH_TIMEOUT_MS = 8_000

/** Cache refresh interval on success. Matches TTL so the first hover after expiry is still warm. */
const BALANCE_REFRESH_INTERVAL_MS = BALANCE_CACHE_TTL_MS
/** Cache refresh interval on failure. A transient upstream blip should clear
 *  in seconds, not in 5 min — a stuck cache is more visible to the user
 *  than a brief retry loop. The interval is 30 s so a 1-min outage is
 *  invisible by the time the next browser poll lands. */
const BALANCE_RETRY_INTERVAL_MS = 30_000

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
      signal: AbortSignal.timeout(BALANCE_FETCH_TIMEOUT_MS),
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

/* -------------------------------------------------------------------------- *
 *  Usage aggregation proxy (read from session persistence on the host)
 * -------------------------------------------------------------------------- *
 *
 * The trajectory view in the browser is built lazily — a session that
 * was never opened in the trajectory tab has an EMPTY_TRAJECTORY_SNAPSHOT,
 * and the browser's per-day usage aggregation reads from that view and
 * finds nothing. That makes the chart start from scratch on every
 * harness relaunch: the persisted session events are still on disk,
 * but nothing asks the trajectory view to rebuild.
 *
 * The host has the `ctx.sessionPersistence` service, which is the
 * durable source of every session's event log. This route walks every
 * persisted session in the requested window, filters to
 * `assistant/message` events, and aggregates the per-day usage
 * per-model. The result mirrors the browser's `UsageSummary` shape
 * (minus the cost field, which the client computes locally from
 * per-day totals) so the chart can use the data with no extra
 * client-side work.
 *
 * Caching: the response is cached in-memory for `USAGE_CACHE_TTL_MS`
 * (5 min) keyed on the range. Sessions are walked only on a cache
 * miss; a long-running harness hits the cache for the second-and-
 * later hover in the same window.
 */

const USAGE_ROUTE = '/api/peak-hours/usage'

/** Cached usage response lifetime. 5 min matches the balance route. */
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Per-day bucket shape sent to the browser. Mirrors the client's DailyBucket.
 * `byHour` is the per-hour breakdown keyed by UTC hour 0-23, used to
 * drive the peak/off-peak split in the chart (and available for a
 * future per-hour visualization). Each hour entry mirrors the day's
 * shape minus the cost: a flat-rate record would still need a cost
 * but a per-hour cost is a derivable projection, not a stored fact.
 */
interface UsageDailyBucket {
  readonly tokens: number
  readonly peakTokens: number
  readonly cost: number
  readonly messages: number
  /**
   * Per-hour breakdown. Hours with zero traffic are omitted (the
   * `byHour` object has at most 24 keys, typically far fewer). A
   * missing key means "no events that hour", not "zero events".
   * Stored as a plain `Record` (not `Readonly`) so the inner
   * aggregation loop can write to it; the wire payload is unchanged.
   */
  readonly byHour: Record<string, { tokens: number; peakTokens: number; messages: number }>
}

/** Per-model rollup sent to the browser. Mirrors the client's ModelUsage.
 *  Note: `daily` is a plain `Record`, not a `Map`, because `JSON.stringify`
 *  serializes `Map` instances as `{}` (Maps have no own enumerable
 *  properties for their entries). The client rehydrates the `Record`
 *  back to a `Map` after the fetch. */
interface UsageModelRollup {
  readonly model: string
  readonly daily: Readonly<Record<string, UsageDailyBucket>>
  readonly totalTokens: number
  readonly totalCost: number
  readonly totalMessages: number
}

interface UsageSummaryJson {
  readonly ok: true
  readonly summary: {
    readonly rangeDays: number
    readonly rangeStartUtc: number
    readonly rangeEndUtc: number
    readonly models: readonly UsageModelRollup[]
    readonly totalTokens: number
    readonly totalCost: number
    readonly totalMessages: number
    readonly firstRecordMs: number | null
    readonly hadMissing: boolean
  }
}

interface UsageSummaryError {
  readonly ok: false
  readonly error: { readonly kind: 'unavailable' | 'invalid'; readonly message: string }
}

type UsageResponse = UsageSummaryJson | UsageSummaryError

interface CachedUsage {
  readonly result: UsageResponse
  readonly fetchedAt: number
}

const DAY_MS_USAGE = 24 * 60 * 60 * 1000
const DEFAULT_RANGE_DAYS = 30
const MAX_RANGE_DAYS = 365

function parseRangeDays(raw: string | string[] | undefined): number {
  if (raw === undefined) return DEFAULT_RANGE_DAYS
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined) return DEFAULT_RANGE_DAYS
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RANGE_DAYS
  return Math.min(MAX_RANGE_DAYS, n)
}

/** The session-persistence service exposes the durable event log for
 *  every session. Walking the log here gives the chart a stable
 *  aggregate that survives harness restarts (the browser's
 *  trajectory view is built lazily and is empty on a cold launch). */
interface SessionPersistenceService {
  listSnapshots(signal?: AbortSignal): Promise<ReadonlyArray<{ readonly header: { readonly id: unknown } }>>
  inspect(id: unknown, signal?: AbortSignal): Promise<{
    readonly meta: unknown
    readonly events: ReadonlyArray<{
      readonly type: string
      readonly time: number
      readonly data: unknown
    }>
  }>
}

function isAssistantMessageEvent(data: unknown): data is {
  turn: number
  step: number
  message: { readonly source: { readonly provider: string; readonly model: string } }
  usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens?: number }
} {
  if (data === null || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  if (typeof d.turn !== 'number') return false
  if (typeof d.step !== 'number') return false
  const message = d.message
  if (message === null || typeof message !== 'object') return false
  const source = (message as Record<string, unknown>).source
  if (source === null || typeof source !== 'object') return false
  const s = source as Record<string, unknown>
  return typeof s.provider === 'string' && typeof s.model === 'string'
    && s.model.length > 0
}

function readUsageTokens(usage: { inputTokens: number; outputTokens: number } | undefined): number | null {
  if (usage === undefined) return null
  const input = Number(usage.inputTokens)
  const output = Number(usage.outputTokens)
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null
  if (input < 0 || output < 0) return null
  return input + output
}

async function aggregateFromPersistence(
  ctx: Context,
  rangeDays: number,
  signal?: AbortSignal,
): Promise<UsageSummaryJson['summary']> {
  const persistence = ctx.get('sessionPersistence') as SessionPersistenceService | undefined
  if (persistence === undefined) {
    throw new Error('session-persistence service is unavailable')
  }
  const now = Date.now()
  const todayUtcMidnight = Math.floor(now / DAY_MS_USAGE) * DAY_MS_USAGE
  const rangeStart = todayUtcMidnight - (rangeDays - 1) * DAY_MS_USAGE
  const rangeEnd = todayUtcMidnight

  const bucketsByModel = new Map<string, Map<string, UsageDailyBucket>>()
  const totalsByModel = new Map<string, { tokens: number; cost: number; messages: number }>()
  let totalTokens = 0
  let totalCost = 0
  let totalMessages = 0
  let firstRecordMs: number | null = null
  let hadMissing = false

  const snapshots = await persistence.listSnapshots(signal)
  // Inspect every session in parallel batches. The walk is the
  // dominant cost of a cold-cache `?fresh=1` call: for a harness
  // with N sessions and an average inspect-time of T ms, the
  // sequential version is N * T; with bounded concurrency C the
  // ceiling is N/C * T (plus the per-batch await overhead). 8
  // in flight saturates local I/O without exhausting the event
  // loop on the smaller rangeDays windows. The processing pass
  // (per-event bucket writes) stays single-threaded because it
  // only touches in-memory maps.
  const INSPECT_CONCURRENCY = 8
  type InspectResult = ReadonlyArray<{ type: string; time: number; data: unknown }> | null
  for (let i = 0; i < snapshots.length; i += INSPECT_CONCURRENCY) {
    if (signal?.aborted === true) throw new Error('aborted')
    const batch = snapshots.slice(i, i + INSPECT_CONCURRENCY)
    const results: InspectResult[] = await Promise.all(batch.map(async (snap): Promise<InspectResult> => {
      try {
        const inspection = await persistence.inspect(snap.header.id, signal)
        return inspection.events
      } catch {
        return null
      }
    }))
    for (const events of results) {
      if (events === null) { hadMissing = true; continue }
      for (const event of events) {
        if (event.type !== 'assistant/message') continue
        if (event.time < rangeStart || event.time >= rangeEnd + DAY_MS_USAGE) continue
        if (!isAssistantMessageEvent(event.data)) continue
        const model = event.data.message.source.model
        const rawUsage = event.data.usage as
          { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined
        const tokens = readUsageTokens(rawUsage)
        if (tokens === null) continue
        const atTime = new Date(event.time)
        const dayStr = atTime.toISOString().slice(0, 10)
        const peakTokens = isPeak(atTime) ? tokens : 0
        // Compute USD cost from the same per-message usage that the
        // client uses (`costForUsage` lives in `src/client/pricing.ts`
        // and is shared so the chart's per-day totals and the live
        // balance both come from the same rate table). Non-DeepSeek
        // models return 0 from `costForUsage`, which is the documented
        // behavior — those buckets still count tokens, just at $0.
        const cost = rawUsage === undefined
          ? 0
          : costForUsage(
            model,
              {
                input: rawUsage.inputTokens,
                cacheRead: rawUsage.cacheReadTokens ?? 0,
                output: rawUsage.outputTokens,
              } satisfies PricingUsage,
              atTime,
          )
        // Per-hour attribution: bucketed on the UTC hour of the event
        // (0-23), independent of day. The hour is stored alongside the
        // day so the chart can render either a per-day split (the
        // current view) or, in a future iteration, a per-hour
        // breakdown of a selected day. Hours with zero traffic are
        // omitted from the `byHour` Record; a missing key means
        // "no events", never "zero events".
        const hourStr = String(atTime.getUTCHours())
        let modelMap = bucketsByModel.get(model)
        if (modelMap === undefined) { modelMap = new Map(); bucketsByModel.set(model, modelMap) }
        const existing = modelMap.get(dayStr)
        if (existing === undefined) {
          const byHour: Record<string, { tokens: number; peakTokens: number; messages: number }> = {}
          byHour[hourStr] = { tokens, peakTokens, messages: 1 }
          modelMap.set(dayStr, { tokens, peakTokens, cost, messages: 1, byHour })
        } else {
          const hourBucket = existing.byHour[hourStr]
          if (hourBucket === undefined) {
            existing.byHour[hourStr] = { tokens, peakTokens, messages: 1 }
          } else {
            existing.byHour[hourStr] = {
              tokens: hourBucket.tokens + tokens,
              peakTokens: hourBucket.peakTokens + peakTokens,
              messages: hourBucket.messages + 1,
            }
          }
          modelMap.set(dayStr, {
            tokens: existing.tokens + tokens,
            peakTokens: existing.peakTokens + peakTokens,
            cost: existing.cost + cost,
            messages: existing.messages + 1,
            byHour: existing.byHour,
          })
        }
        const totals = totalsByModel.get(model) ?? { tokens: 0, cost: 0, messages: 0 }
        totals.tokens += tokens
        totals.cost += cost
        totals.messages += 1
        totalsByModel.set(model, totals)
        totalTokens += tokens
        totalCost += cost
        totalMessages += 1
        if (firstRecordMs === null || event.time < firstRecordMs) firstRecordMs = event.time
      }
    }
  }

  const models: UsageModelRollup[] = []
  for (const [model, totals] of totalsByModel) {
    const modelMap = bucketsByModel.get(model) ?? new Map<string, UsageDailyBucket>()
    // JSON.stringify would emit `{}` for a Map (Maps have no own
    // enumerable properties for their entries); flatten to a
    // `Record<date, bucket>` so the client sees the per-day data
    // intact and rehydrates into a Map locally.
    const daily: Record<string, UsageDailyBucket> = {}
    for (const [dayStr, bucket] of modelMap) daily[dayStr] = bucket
    models.push({
      model,
      daily,
      totalTokens: totals.tokens,
      totalCost: totals.cost,
      totalMessages: totals.messages,
    })
  }
  models.sort((left, right) => right.totalTokens - left.totalTokens)

  return {
    rangeDays,
    rangeStartUtc: rangeStart,
    rangeEndUtc: rangeEnd,
    models,
    totalTokens,
    totalCost,
    totalMessages,
    firstRecordMs,
    hadMissing,
  }
}

/* -------------------------------------------------------------------------- *
 *  Pause / queue state
 * -------------------------------------------------------------------------- */

const STATE_ROUTE = '/api/peak-hours/state'

/** Settings namespace owning the persisted `paused` boolean. */
const STATE_NS = settingsNamespace('peak-hours')

/** Settings schema. Only `paused` is user-visible; everything else is
 *  a 1 Hz host-side computation, never persisted. */
interface PeakHoursConfig {
  paused: boolean
}

const Config: z<PeakHoursConfig> = z.object({
  paused: z.boolean().default(false),
})

/** How often the host recomputes the phase (and watches for a boundary
 *  crossing that should drain the queue). 1 Hz is the same cadence the
 *  browser pill uses; cheaper than an hourly timer and the cost is
 *  bounded (a single Date allocation + arithmetic per second). */
const PHASE_TICK_MS = 1_000

/** When a peak window starts the queue can fill quickly; this is the cap
 *  the host reports back to the browser so the UI can show a real
 *  number rather than overflow into a tooltip. 9999 is "lots, exact
 *  count unavailable" in one constant — the queue itself can grow past
 *  this for diagnostic purposes but the wire reply clamps it. */
const QUEUE_DISPLAY_CAP = 9_999

/** JSON envelope the host always returns. */
export interface StateJsonSuccess {
  readonly ok: true
  readonly state: {
    readonly isPaused: boolean
    readonly phase: Phase
    readonly preLaunch: boolean
    /** True iff `isPaused` AND the current UTC hour is inside a peak window. */
    readonly isBlockedNow: boolean
    /** Epoch ms of the next phase boundary; -1 if pre-cutover. */
    readonly nextPhaseAt: number
    /** Epoch ms of the pricing-cutover; -1 if already live. */
    readonly cutoverAt: number
    /** Pending stream count (clamped to QUEUE_DISPLAY_CAP for the wire). */
    readonly queueSize: number
    /** Epoch ms when the host last recomputed this state. */
    readonly refreshedAt: number
  }
}

export interface StateJsonFailure {
  readonly ok: false
  readonly error: {
    readonly kind: 'unavailable' | 'invalid'
    readonly message: string
  }
}

export type StateJson = StateJsonSuccess | StateJsonFailure

/** One queued LLM stream call. `next` is the waterfall continuation
 *  (the inner chain), held until the queue decides to dispatch. */
interface QueueItem {
  /** The fully-assembled request captured at enqueue time. The agent
   *  loop already finished assembling it, so we own it as-is. */
  readonly options: GenerateOptions
  /** Continue past the gate: the inner chain of the `llm/stream`
   *  waterfall. Calling it returns the next listener's iterable, which
   *  eventually resolves to the adapter stream. */
  readonly next: () => AsyncIterable<StreamChunk>
  /** Resolves when the queue decides to release this item. */
  readonly drain: () => void
  /** Resolves when the queued stream's body finishes (either the inner
   *  stream ended, threw, or the caller's signal aborted). The drainer
   *  awaits this so items dispatch strictly in arrival order. Mutable
   *  because the resolver is installed by the drainer, not the enqueuer. */
  complete: () => void
  /** Wall-clock ms when this item was enqueued; reported in the queue
   *  endpoint for the UI's "queued for X" affordance. */
  readonly enqueuedAt: number
}

function emptyState(phaseSnap: PhaseSnapshot, isPaused: boolean, queueSize: number): StateJsonSuccess {
  return {
    ok: true,
    state: {
      isPaused,
      phase: phaseSnap.phase,
      preLaunch: phaseSnap.preLaunch,
      isBlockedNow: isPaused && phaseSnap.phase === 'peak' && !phaseSnap.preLaunch,
      nextPhaseAt: phaseSnap.nextBoundaryUtc.getTime(),
      cutoverAt: phaseSnap.preLaunch ? phaseSnap.nextBoundaryUtc.getTime() : -1,
      queueSize: Math.min(queueSize, QUEUE_DISPLAY_CAP),
      refreshedAt: Date.now(),
    },
  }
}

function stateInvalid(message: string): StateJsonFailure {
  return { ok: false, error: { kind: 'invalid', message } }
}

/**
 * Read a POST body of at most `limit` bytes and parse it as JSON. Returns
 * the parsed value, or `undefined` for an empty / unreadable / oversize
 * body. The caller is responsible for the JSON-shape check.
 */
async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buf.length
    if (total > limit) return undefined
    chunks.push(buf)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** Treat any method other than GET/HEAD as a method-not-allowed. */
function isReadMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD'
}

/* -------------------------------------------------------------------------- *
 *  Apply: wire balance proxy + state route + LLM hook + 1 Hz ticker
 * -------------------------------------------------------------------------- */

/**
 * Host plugin body. Wires the balance route and the pause-state route
 * onto the harness webserver, registers the LLM stream gate, and starts
 * the 1 Hz phase ticker. The whole registration lives inside a single
 * `ctx.effect` so a dispose cleans every piece (route, timer, queue,
 * listener) in one place.
 *
 * @param ctx - host cordis context. The credentials, webserver, llm, and
 *              settings services are all optional; missing services keep
 *              the routes live (state always returns a JSON envelope;
 *              balance degrades to `unavailable`) and skip the affected
 *              surface (no LLM hook, no persistence) without throwing.
 */
export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServer | undefined
  if (webServer === undefined) {
    ctx.logger?.warn('ui-peak-hours: webServer service is unavailable; no host routes will be registered')
  }

  /* === State closure ====================================================== *
   *  All four pieces below (paused flag, queue, ticker, settings scope) live
   *  in one closure so the disposer tears them down in one block. The
   *  LLM hook and the HTTP routes close over the same variables. */

  let isPaused = false
  let phaseSnap: PhaseSnapshot = currentPhase(new Date())
  let isBlockedNow = isPaused && phaseSnap.phase === 'peak' && !phaseSnap.preLaunch
  const queue: QueueItem[] = []
  let phaseTimer: NodeJS.Timeout | null = null
  let draining = false
  let disposed = false

  /** Resolve the current "is the next request blocked?" flag. The pause
   *  toggle and the 1 Hz phase tick both call this so the LLM hook reads
   *  the latest value without recomputing it. */
  const recomputeBlocked = (): void => {
    isBlockedNow = isPaused && phaseSnap.phase === 'peak' && !phaseSnap.preLaunch
  }

  /** Drain the queue strictly in arrival order. Each item's `complete`
   *  promise resolves when its stream's body finishes (success, error,
   *  or caller abort), so awaiting it gives true serial dispatch even
   *  though every agent loop has its own consumer. */
  const drainQueue = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0 && !isBlockedNow && !disposed) {
        const item = queue.shift()
        if (item === undefined) break
        const done = new Promise<void>((resolve) => { item.complete = () => resolve() })
        item.drain()
        await done
      }
    } finally {
      draining = false
    }
  }

  /* === 1 Hz phase ticker ================================================== *
   *  Recomputes the phase every second, watches for a peak→off-peak
   *  transition (which should release the queue), and ignores the
   *  off-peak→peak transition (next request gets queued). The timer is
   *  `.unref()`'d so a stale tick never holds the process open. */

  phaseTimer = setInterval(() => {
    if (disposed) return
    const next = currentPhase(new Date())
    const wasBlocked = isBlockedNow
    phaseSnap = next
    recomputeBlocked()
    if (wasBlocked && !isBlockedNow) {
      void drainQueue()
    }
  }, PHASE_TICK_MS)
  phaseTimer.unref?.()

  /* === Settings persistence =============================================== *
   *  The paused toggle persists in the standard settings plane. We
   *  register the namespace ourselves (instead of going through
   *  `installSettingsSection`) so the POST handler can call `scope.update`
   *  with the new value; the helper only exposes a getter thunk, not
   *  the scope. The scope lives behind a `ctx.inject(['settings'], …)`
   *  callback so registration waits for the settings service without
   *  blocking the rest of `apply()`. */

  const initialConfig: PeakHoursConfig = { paused: false }
  // The scope is created inside the inject callback; `null` until the
  // settings service is ready. The POST handler awaits this getter to
  // serialize toggle writes.
  let updateCurrent: ((patch: object) => Promise<void>) | null = null
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(STATE_NS, Config, { base: initialConfig })
    updateCurrent = patch => scope.update(patch)
    // Pull the persisted value (or the default) at attach.
    const v = scope.get()
    isPaused = v.paused
    recomputeBlocked()
    if (!isBlockedNow) void drainQueue()
    // Watch stored changes from outside the POST path (settings UI,
    // another tab, CLI tool) so the host flag tracks the source of
    // truth rather than only the live POST.
    sctx.effect(() => {
      const dispose = scope.watch((next) => {
        if (disposed) return
        isPaused = next.paused
        recomputeBlocked()
        if (!isBlockedNow) void drainQueue()
      })
      return () => dispose()
    }, 'ui-peak-hours: settings watch')
  })

  /* === LLM stream gate ==================================================== *
   *  The waterfall listener is the gate. When the switch is on AND the
   *  current UTC hour is inside a peak window, we hold the request in a
   *  FIFO and return a stream that yields nothing until the drainer
   *  releases it. Otherwise we forward to `next()` immediately. The
   *  `llm/stream` event lives on the cordis event bus, not on the
   *  `ctx.llm` service — registered listeners wrap the inner chain like
   *  middleware, so this listener is just one more wrap in the waterfall.
   *  The invariant listener (registered first via `prepend: true`) still
   *  runs on the inner stream and validates the merged output. */

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    if (!isBlockedNow) {
      // Fast path: pass-through. Returning the inner iterable directly
      // is what the invariant does; it preserves the waterfall
      // contract (the invariant validates the inner shape).
      return next()
    }
    // Blocked path: enqueue and return a stream that blocks until
    // the drainer fires. `drain`/`complete` are one-shot resolvers;
    // both are called at most once.
    let drain!: () => void
    let complete!: () => void
    const drainPromise = new Promise<void>((resolve) => { drain = resolve })
    const item: QueueItem = {
      options,
      next,
      drain,
      complete: () => {},
      enqueuedAt: Date.now(),
    }
    queue.push(item)
    const signal = options.signal
    if (signal !== undefined) {
      // Caller cancellation: pull the item out of the queue and
      // unblock the stream so the inner chain sees the abort and
      // returns quickly. The agent loop's for-await breaks on the
      // resulting `done: true`.
      const onAbort = (): void => {
        const idx = queue.indexOf(item)
        if (idx !== -1) queue.splice(idx, 1)
        drain()
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    return queuedStream(drainPromise, () => complete(), next)
  })
  // The cordis `on` registration is fiber-scoped: the listener is
  // released when this plugin's fiber disposes. We also drain any
  // pending items so a held stream never outlives the plugin.
  ctx.effect(() => () => {
    for (const item of queue) item.drain()
    queue.length = 0
  }, 'ui-peak-hours: llm gate')

  /* === Web routes ========================================================= *
   *  Both routes live in a single `ctx.effect` so one dispose removes
   *  both. The balance route is the existing proxy; the state route is
   *  the new read/toggle surface for the pause switch. */

  if (webServer !== undefined) {
    /* -- Balance proxy (existing) ---------------------------------------- */
    let balanceCached: CachedBalance | null = null
    let balanceRefreshTimer: NodeJS.Timeout | null = null
    const balanceRefresh = async (): Promise<void> => {
      let nextDelay = BALANCE_REFRESH_INTERVAL_MS
      try {
        const apiKey = await resolveApiKey(ctx)
        if (apiKey === undefined) {
          // No API key is a configuration problem, not a transient
          // failure: cache the `unavailable` envelope so the user sees
          // the diagnostic on the next hover. We do not retry fast —
          // a missing key will not appear by itself in 30 s.
          balanceCached = { result: unavailable('DEEPSEEK_API_KEY is not configured'), fetchedAt: Date.now() }
          return
        }
        const result = await fetchUpstream(apiKey)
        // Only cache the success. A failure envelope from `fetchUpstream`
        // is a transient upstream blip (network, 5xx, parse); keeping
        // the previous good value visible is more useful than flashing
        // a "fetch failed" toast at the user on every blip.
        if (result.ok) {
          balanceCached = { result, fetchedAt: Date.now() }
        } else {
          // Upstream returned an error envelope (HTTP / parse / network).
          // Do NOT touch `balanceCached`; the previous good value stays.
          // Switch the next refresh to the fast-retry cadence so the
          // blip clears in seconds, not in 5 min.
          ctx.logger?.warn(`ui-peak-hours: balance upstream error (kind=${result.error.kind}): ${result.error.message}`)
          nextDelay = BALANCE_RETRY_INTERVAL_MS
        }
      } catch (err) {
        // Defensive: `fetchUpstream` catches its own errors and returns
        // an envelope. Reaching here means a programming error, not an
        // upstream issue — log it but do not poison the cache.
        ctx.logger?.warn('ui-peak-hours: balance refresh threw unexpectedly')
        ctx.logger?.warn(err)
        nextDelay = BALANCE_RETRY_INTERVAL_MS
      } finally {
        balanceRefreshTimer = setTimeout(() => { void balanceRefresh() }, nextDelay)
        balanceRefreshTimer.unref?.()
      }
    }

    /* -- State route (new) ---------------------------------------------- */
    const disposeBalanceRoute = webServer.register({
      kind: 'exact',
      path: BALANCE_ROUTE,
      handler: async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!isReadMethod(_req.method)) {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        if (balanceCached !== null && Date.now() - balanceCached.fetchedAt < BALANCE_CACHE_TTL_MS) {
          writeJson(res, 200, balanceCached.result)
          return
        }
        await balanceRefresh()
        const result: BalanceJson = balanceCached?.result
          ?? unavailable('balance cache is empty after refresh')
        writeJson(res, 200, result)
      },
    })

    const disposeStateRoute = webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          writeJson(res, 200, emptyState(phaseSnap, isPaused, queue.length))
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, HEAD, POST' })
          res.end()
          return
        }
        const body = await readJsonBody(req, 1024)
        if (body === undefined) {
          writeJson(res, 200, stateInvalid('request body is missing or not valid JSON'))
          return
        }
        if (typeof body !== 'object' || body === null) {
          writeJson(res, 200, stateInvalid('request body must be a JSON object'))
          return
        }
        const pausedRaw = (body as Record<string, unknown>).paused
        if (typeof pausedRaw !== 'boolean') {
          writeJson(res, 200, stateInvalid('paused must be a boolean'))
          return
        }
        isPaused = pausedRaw
        recomputeBlocked()
        if (updateCurrent !== null) {
          try {
            await updateCurrent({ paused: pausedRaw })
          } catch (err) {
            // The host flag has already been flipped above (live semantics:
            // a pause toggle takes effect immediately). Persistence failure
            // is a warning, not a route failure — the next process can
            // recover from the live host state via the next POST.
            ctx.logger?.warn('ui-peak-hours: settings update failed; toggle is live but not persisted')
            ctx.logger?.warn(err)
          }
        }
        if (!isBlockedNow) void drainQueue()
        writeJson(res, 200, emptyState(phaseSnap, isPaused, queue.length))
      },
    })

    /* -- Usage aggregation proxy (new) -------------------------------- */
    // Cache is keyed by `rangeDays` so a `?rangeDays=7` and a
    // `?rangeDays=30` don't shadow each other; the value is the
    // cached response + the time it was walked. `?fresh=1` is a
    // per-request cache-buster for the "new message landed" tick.
    const usageCache = new Map<number, CachedUsage>()
    const parseUsagePath = (reqUrl: string | undefined): { rangeDays: number; fresh: boolean } => {
      if (reqUrl === undefined) return { rangeDays: DEFAULT_RANGE_DAYS, fresh: false }
      try {
        const url = new URL(reqUrl, 'http://x')
        const rangeDays = parseRangeDays(url.searchParams.get('rangeDays') ?? undefined)
        const fresh = url.searchParams.get('fresh') === '1'
        return { rangeDays, fresh }
      } catch {
        return { rangeDays: DEFAULT_RANGE_DAYS, fresh: false }
      }
    }
    const disposeUsageRoute = webServer.register({
      kind: 'exact',
      path: USAGE_ROUTE,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!isReadMethod(req.method)) {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        const { rangeDays, fresh } = parseUsagePath(req.url)
        if (!fresh) {
          const cached = usageCache.get(rangeDays)
          if (cached !== undefined && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
            writeJson(res, 200, cached.result)
            return
          }
        }
        try {
          const summary = await aggregateFromPersistence(ctx, rangeDays)
          const ok: UsageSummaryJson = { ok: true, summary }
          usageCache.set(rangeDays, { result: ok, fetchedAt: Date.now() })
          writeJson(res, 200, ok)
        } catch (err) {
          ctx.logger?.warn(`ui-peak-hours: usage aggregation failed: ${err instanceof Error ? err.message : String(err)}`)
          const failure: UsageResponse = { ok: false, error: { kind: 'unavailable', message: 'host-side usage aggregation failed' } }
          // Do NOT cache failures — the next browser poll should try again
          writeJson(res, 200, failure)
        }
      },
    })

    ctx.effect(() => () => {
      disposeBalanceRoute()
      disposeStateRoute()
      disposeUsageRoute()
      if (balanceRefreshTimer !== null) {
        clearTimeout(balanceRefreshTimer)
        balanceRefreshTimer = null
      }
      balanceCached = null
      usageCache.clear()
    }, 'ui-peak-hours: routes')
  }

  /* === Disposer =========================================================== *
   *  Stops the 1 Hz phase ticker and marks the queue gate disposed so
   *  any in-flight drain loop exits before pulling another item. The
   *  LLM hook's own disposer (registered above with the gate) handles
   *  queue cleanup; this one is just the ticker. */
  ctx.effect(() => () => {
    disposed = true
    if (phaseTimer !== null) {
      clearInterval(phaseTimer)
      phaseTimer = null
    }
  }, 'ui-peak-hours: phase ticker')
}

/* -------------------------------------------------------------------------- *
 *  Helpers
 * -------------------------------------------------------------------------- */

/**
 * A stream that yields nothing until `drainPromise` resolves, then
 * forwards every chunk from `next()` to its consumer. The body is wrapped
 * in a `try/finally` so `onComplete` fires whether the inner stream
 * returns normally, throws, or the caller aborts — the drainer relies
 * on that exact contract to advance through the queue.
 */
async function* queuedStream(
  drainPromise: Promise<void>,
  onComplete: () => void,
  next: () => AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk, void, void> {
  try {
    await drainPromise
    yield* next()
  } finally {
    onComplete()
  }
}

/** JSON content type the browser expects. */
function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}
