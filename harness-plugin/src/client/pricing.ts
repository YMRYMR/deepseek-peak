/**
 * DeepSeek V4 API pricing — authoritative source:
 * https://api-docs.deepseek.com/quick_start/pricing/
 *
 * All rates are in USD per 1,000,000 tokens.
 *
 * Schedule:
 *   - Pre-cutover (before 2026-08-16 16:00 UTC): single flat rate.
 *   - Post-cutover: peak hours (01:00-04:00, 06:00-10:00 UTC) charge 2x
 *     the off-peak rate.
 *
 * The `cacheRead` tokens (cache hits) are billed at the cache-hit rate;
 * `input - cacheRead` (uncached input) is billed at the cache-miss rate.
 * `output` is billed at the output rate. The harness's `TokenUsage` shape
 * already separates these, so this module does not re-derive them.
 *
 * The same CUTOVER constant as domain.ts so the peak pill and the
 * usage chart agree on what "before/after" means.
 */

import { CUTOVER_UTC } from './domain.ts'

export type ModelId = 'deepseek-v4-flash' | 'deepseek-v4-pro'

interface Rate {
  /** USD per 1M cache-hit input tokens. */
  readonly cacheHit: number
  /** USD per 1M uncached input tokens. */
  readonly cacheMiss: number
  /** USD per 1M output tokens. */
  readonly output: number
}

const V4_FLASH: Record<'flat' | 'off' | 'peak', Rate> = {
  flat:    { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
  off:     { cacheHit: 0.007,  cacheMiss: 0.22, output: 0.66 },
  peak:    { cacheHit: 0.014,  cacheMiss: 0.44, output: 1.32 },
}

const V4_PRO: Record<'flat' | 'off' | 'peak', Rate> = {
  flat:    { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
  off:     { cacheHit: 0.022,    cacheMiss: 0.66,  output: 1.98 },
  peak:    { cacheHit: 0.044,    cacheMiss: 1.32,  output: 3.96 },
}

const RATES: Record<ModelId, Record<'flat' | 'off' | 'peak', Rate>> = {
  'deepseek-v4-flash': V4_FLASH,
  'deepseek-v4-pro':  V4_PRO,
}

/** Pick the rate row that was in effect for a request at `atTime`. */
function rateFor(model: ModelId, atTime: Date): Rate {
  const table = RATES[model]
  if (atTime.getTime() < CUTOVER_UTC) return table.flat
  const h = atTime.getUTCHours() + atTime.getUTCMinutes() / 60
  const inPeak = (h >= 1 && h < 4) || (h >= 6 && h < 10)
  return inPeak ? table.peak : table.off
}

export interface TokenUsage {
  readonly input: number
  readonly cacheRead: number
  readonly output: number
}

/**
 * Compute the USD cost of a single request.
 *
 * @param model  - the DeepSeek model id (e.g. `deepseek-v4-flash`).
 * @param usage  - per-message token counts (input / cacheRead / output).
 * @param atTime - request timestamp; selects the right rate row.
 * @returns USD cost as a float, or 0 for unknown models.
 */
export function costForUsage(model: string, usage: TokenUsage, atTime: Date): number {
  if (!(model in RATES)) return 0
  const r = rateFor(model as ModelId, atTime)
  const uncachedInput = Math.max(0, usage.input - usage.cacheRead)
  return (
    (usage.cacheRead / 1_000_000) * r.cacheHit +
    (uncachedInput  / 1_000_000) * r.cacheMiss +
    (usage.output   / 1_000_000) * r.output
  )
}

/** Display name for a model id (strips the `deepseek-` prefix). */
export function modelDisplayName(model: string): string {
  return model.replace(/^deepseek-/, '')
}
