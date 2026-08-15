/**
 * Usage aggregation for the peak-hours pill's hover tooltip.
 *
 * Source of truth: the trajectory view snapshot on each session. The harness
 * already assembles one `ConversationNode` per assistant message with
 * `usage` and `provenance.model` populated, so we can walk the same data
 * without subscribing to the LLM event stream.
 *
 * The runtime deliberately types `usage` as `unknown` to keep the package
 * layer free of LLM-type coupling; this file reconstructs the LLM
 * `TokenUsage` shape with a defensive guard so a future runtime change
 * (or a pre-finalize partial) does not throw.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { isPeak } from './domain.ts'
import { costForUsage, type TokenUsage as PricingUsage } from './pricing.ts'

/** Defensive view of the LLM `TokenUsage` shape carried on assistant nodes. */
function readTokenUsage(raw: unknown): PricingUsage | null {
  if (raw === null || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const input = asNumber(u.inputTokens ?? u.input)
  const cacheRead = asNumberOrZero(u.cacheReadTokens ?? u.cacheRead)
  const output = asNumber(u.outputTokens ?? u.output)
  if (input === null || output === null) return null
  return { input, cacheRead, output }
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asNumberOrZero(value: unknown): number {
  return asNumber(value) ?? 0
}

/** Defensive view of the assistant message's `provenance.model` field. */
function readModel(node: { provenance?: { model?: unknown } }): string | null {
  const m = node.provenance?.model
  return typeof m === 'string' && m.length > 0 ? m : null
}

export interface DailyBucket {
  /** UTC date string `YYYY-MM-DD`. */
  readonly date: string
  /** Sum of input + output tokens for this model on this date (peak + off-peak). */
  readonly tokens: number
  /**
   * Tokens on this date that landed inside a peak window (and so
   * incurred the V4 surcharge). Zero pre-cutover; pre-cutover traffic
   * is all `tokens - peakTokens` off-peak.
   */
  readonly peakTokens: number
  /** USD cost for this model on this date. */
  readonly cost: number
  /** Number of assistant messages contributing to this bucket. */
  readonly messages: number
}

export interface ModelUsage {
  readonly model: string
  /** Date string → bucket, sorted ascending by date when materialized. */
  readonly daily: ReadonlyMap<string, DailyBucket>
  readonly totalTokens: number
  readonly totalCost: number
  readonly messageCount: number
}

export interface UsageSummary {
  readonly rangeDays: number
  /** Inclusive start of the range, UTC midnight. */
  readonly rangeStartUtc: Date
  /** Inclusive end of the range, UTC midnight (today). */
  readonly rangeEndUtc: Date
  /** Model id → aggregate, sorted by `totalTokens` descending at materialization. */
  readonly models: readonly ModelUsage[]
  readonly totalTokens: number
  readonly totalCost: number
  readonly totalMessages: number
  /** UTC ms of the earliest contributing record (if any). */
  readonly firstRecordMs: number | null
  /** True if at least one session was unreachable for the walk. */
  readonly hadMissing: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Walk all sessions in the harness, harvest every assistant message with
 * `usage` + `provenance.model`, and bucket them into per-model daily totals
 * clipped to the trailing `rangeDays` window (UTC days).
 *
 * @param ctx     - browser client context. Must have `sessions` injected.
 * @param rangeDays - how many trailing UTC days to include (default 30).
 * @returns Aggregated usage summary; empty if the harness has no data.
 */
export function aggregateUsage(ctx: Context, rangeDays: number = 30): UsageSummary {
  const now = Date.now()
  const rangeStartUtc = new Date(Math.floor(now / DAY_MS) * DAY_MS - (rangeDays - 1) * DAY_MS)
  const rangeEndUtc = new Date(Math.floor(now / DAY_MS) * DAY_MS)

  // Per-model, per-day mutable buckets keyed by `model -> date -> bucket`.
  const buckets = new Map<string, Map<string, DailyBucket>>()
  const modelTotals = new Map<string, { tokens: number; cost: number; messages: number }>()
  let totalTokens = 0
  let totalCost = 0
  let totalMessages = 0
  let firstRecordMs: number | null = null
  let hadMissing = false

  const sessions = (ctx as { sessions?: { list: { getSnapshot(): { ids: readonly SessionId[] } } } }).sessions
  if (sessions === undefined) {
    return {
      rangeDays, rangeStartUtc, rangeEndUtc,
      models: [], totalTokens: 0, totalCost: 0, totalMessages: 0,
      firstRecordMs: null, hadMissing: true,
    }
  }

  const ids = sessions.list.getSnapshot().ids
  const ctxAny = ctx as unknown as {
    sessions: {
      binding(id: SessionId): { session?: { getSnapshot(): { views: Map<string, unknown> } } } | undefined
    }
  }

  for (const id of ids) {
    const binding = ctxAny.sessions.binding(id)
    const session = binding?.session
    if (session === undefined) { hadMissing = true; continue }
    const snapshot = session.getSnapshot()
    const trajectory = snapshot.views.get('trajectory') as
      | { eventNodes?: ReadonlyArray<{ kind: string; time: number; usage?: unknown; provenance?: { model?: unknown } }> }
      | undefined
    if (trajectory?.eventNodes === undefined) continue
    for (const node of trajectory.eventNodes) {
      if (node.kind !== 'assistant') continue
      const usage = readTokenUsage(node.usage)
      const model = readModel(node)
      if (usage === null || model === null) continue
      // Apply the time window BEFORE computing cost, so we never spend cycles
      // pricing records that will be dropped.
      if (node.time < rangeStartUtc.getTime() || node.time >= rangeEndUtc.getTime() + DAY_MS) continue
      const dayStr = new Date(node.time).toISOString().slice(0, 10)
      const atTime = new Date(node.time)
      const tokens = usage.input + usage.output
      const peakTokens = isPeak(atTime) ? tokens : 0
      const cost = costForUsage(model, usage, atTime)
      let modelMap = buckets.get(model)
      if (modelMap === undefined) { modelMap = new Map(); buckets.set(model, modelMap) }
      const existing = modelMap.get(dayStr)
      if (existing === undefined) {
        modelMap.set(dayStr, { date: dayStr, tokens, peakTokens, cost, messages: 1 })
      } else {
        modelMap.set(dayStr, {
          date: dayStr,
          tokens: existing.tokens + tokens,
          peakTokens: existing.peakTokens + peakTokens,
          cost: existing.cost + cost,
          messages: existing.messages + 1,
        })
      }
      const totals = modelTotals.get(model) ?? { tokens: 0, cost: 0, messages: 0 }
      totals.tokens += tokens
      totals.cost += cost
      totals.messages += 1
      modelTotals.set(model, totals)
      totalTokens += tokens
      totalCost += cost
      totalMessages += 1
      if (firstRecordMs === null || node.time < firstRecordMs) firstRecordMs = node.time
    }
  }

  const models: ModelUsage[] = []
  for (const [model, totals] of modelTotals) {
    const daily = buckets.get(model) ?? new Map<string, DailyBucket>()
    models.push({
      model,
      daily,
      totalTokens: totals.tokens,
      totalCost: totals.cost,
      messageCount: totals.messages,
    })
  }
  models.sort((a, b) => b.totalTokens - a.totalTokens)

  return {
    rangeDays, rangeStartUtc, rangeEndUtc,
    models, totalTokens, totalCost, totalMessages,
    firstRecordMs, hadMissing,
  }
}

/** Format a USD cost with 2 decimals (or scientific-notation for very small). */
export function formatUsd(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/** Format a token count with thin spaces, in the human "1.4B / 482M / 12K" style. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(0)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`
  return String(value)
}

/**
 * Format a token count with dots as thousand separators (the European
 * convention) and no abbreviation: `274321` -> `274.321`. Used where the
 * model card's per-model total is the headline number and a compact
 * "274K" would hide the real magnitude.
 */
export function formatTokensFull(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  const rounded = Math.round(value)
  // Insert a dot every 3 digits from the right. Locale-free so the
  // shape is stable regardless of the browser's user-locale.
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
