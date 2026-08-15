/**
 * UsageTooltip: hover overlay for the peak-hours pill.
 *
 * Renders one card with:
 *   - the live DeepSeek account balance (host-routed, no key in browser)
 *   - a subtitle line: spent ≈ $X · N messages (per-trajectory-walk totals)
 *   - one chart card per model with a tiny inline-SVG daily bar chart
 *   - a footer with the date range metadata
 *
 * The card is anchored below the pill, right-aligned. It uses the same
 * color tokens and border style as the pill so the two read as one
 * element. The pill itself is unchanged.
 *
 * Width: the card fills the host (= the pill's width) exactly. The
 * chart scales to fit the card via SVG viewBox so 30 daily bars
 * always cover the available width regardless of pill width.
 *
 * Data: `UsageSummary` from `./usage.ts`. The parent owns the
 * aggregation lifecycle and re-aggregates only when the underlying
 * sessions store changes.
 */

import { useMemo } from 'react'
import { modelDisplayName } from './pricing.ts'
import {
  formatTokens, formatTokensFull, formatUsd, type ModelUsage, type UsageSummary,
} from './usage.ts'
import type { Phase } from './domain.ts'
import type { BalanceError, BalanceResult } from './balance.ts'
import css from './UsageTooltip.module.css'

const DAY_MS = 24 * 60 * 60 * 1000
const RANGE_DAYS = 30
// Chart viewBox is in unit-space: 30 days wide, 100 units tall. The
// actual rendered size is set by the CSS `width: 100%` of the chart
// wrapper, so the chart always fits the card width exactly.
const CHART_VIEW_W = 30
const CHART_VIEW_H = 100
const BAR_UNIT = 0.78  // bar width in viewBox units (gap = 0.22)
const FLOOR_UNIT = 0.78

export interface UsageTooltipProps {
  summary: UsageSummary | null
  isLoading: boolean
  phase: Phase
  preLaunch: boolean
  balance: BalanceResult | null
  balanceLoading: boolean
  /**
   * When true, the card is rendered inside the PeakHoursHost's
   * `.hover` container, which owns the absolute positioning. The
   * card itself becomes `position: static` so it stacks with the
   * queue card below it. The default (`false`) keeps the legacy
   * standalone behaviour, so other call sites (tests, etc.) work
   * unchanged.
   */
  wrapperMode?: boolean
}

export function UsageTooltip(props: UsageTooltipProps) {
  const { summary, isLoading, phase, preLaunch, balance, balanceLoading, wrapperMode = false } = props

  // In wrapper mode, the host's `.hover` container owns the absolute
  // positioning, so the card applies `.cardInWrapper` (static positioning
  // override) on top of the `.card` body styling. Otherwise the default
  // `.card` (absolute) keeps the tooltip usable standalone.
  const cardClass = [
    css.card,
    wrapperMode ? css.cardInWrapper : '',
    phase === 'peak' ? css.cardPeak : css.cardOff,
    preLaunch ? css.cardPreLaunch : '',
  ].filter(Boolean).join(' ')

  if (isLoading && summary === null) {
    return (
      <div className={cardClass} role="tooltip" data-state="loading">
        <span className={css.spinner} aria-hidden="true" />
        <span className={css.placeholder}>Scanning session history…</span>
      </div>
    )
  }

  const hasData = summary !== null && summary.totalMessages > 0

  return (
    <div className={cardClass} role="tooltip" data-state={hasData ? 'ready' : 'empty'}>
      <header className={css.header}>
        <BalanceRow balance={balance} loading={balanceLoading} />
        {hasData && (
          <span
            className={css.headerMeta}
            title="Harness-local events walked from the session persistence log. The platform's usage page at platform.deepseek.com shows your total DeepSeek usage across every tool; the peak/off-peak split per bar here is only computable from this harness's per-event timestamps."
          >
            This harness · last {RANGE_DAYS} days
          </span>
        )}
      </header>

      {hasData && (
        <div className={css.models}>
          {summary.models.map(m => (
            <ModelCard key={m.model} model={m}
              days={RANGE_DAYS}
              rangeStartMs={summary.rangeStartUtc.getTime()} />
          ))}
          {/* Shared legend so the peak/off-peak split is legible. The
            * chart bars use the same green/red as the pill (peak red on
            * top, off-peak green on the bottom), but with no legend a
            * first-time viewer can't tell which is which — and pre-cutover
            * data is all green, so the legend has to ship before the
            * cutover or the value of the split is invisible. */}
          <div className={css.legend} aria-hidden="true">
            <span className={css.legendPeak} />
            <span className={css.legendLabel}>peak</span>
            <span className={css.legendOff} />
            <span className={css.legendLabel}>off-peak</span>
          </div>
        </div>
      )}
    </div>
  )
}

interface BalanceRowProps {
  balance: BalanceResult | null
  loading: boolean
}

function BalanceRow({ balance, loading }: BalanceRowProps) {
  // No fetch has resolved yet and one is in flight: show a subdued
  // placeholder so the row height is stable while the request resolves.
  if (balance === null) {
    return (
      <div className={css.balanceRow} data-state={loading ? 'loading' : 'idle'}>
        <span className={css.balanceLabel}>BALANCE</span>
        {loading ? (
          <>
            <span className={css.spinner} aria-hidden="true" />
            <span className={css.balanceValue} aria-live="polite">…</span>
          </>
        ) : (
          <span className={css.balanceValue} title="Hover for one tick to trigger a fetch">
            —
          </span>
        )}
      </div>
    )
  }
  if (!balance.ok) {
    // One short label per kind so the user can see what's wrong at a
    // glance. The full message (status, exception text, parse line) is
    // always on the title attribute for the hover tooltip.
    const shortLabel = balanceErrorLabel(balance.error.kind)
    return (
      <div className={css.balanceRow} data-state="error" title={balance.error.message}>
        <span className={css.balanceLabel}>BALANCE</span>
        <span className={css.balanceError} aria-live="polite">{shortLabel}</span>
        {balance.error.status !== undefined && (
          <span className={css.balanceErrorStatus}>HTTP {balance.error.status}</span>
        )}
      </div>
    )
  }
  const primary = balance.balance.entries[0]
  if (primary === undefined) {
    return (
      <div className={css.balanceRow} data-state="empty">
        <span className={css.balanceLabel}>BALANCE</span>
        <span className={css.balanceValue}>—</span>
      </div>
    )
  }
  return (
    <div className={css.balanceRow} data-state="ready" title={`Refreshed ${new Date(balance.balance.refreshedAt).toLocaleTimeString()}`}>
      <span className={css.balanceLabel}>BALANCE</span>
      <span className={css.balanceValue} aria-live="polite">
        {formatUsd(primary.total)}
        <span className={css.balanceCurrency}>{' '}{primary.currency}</span>
      </span>
    </div>
  )
}

/**
 * Map the host's error kind to a short, glanceable label. The full
 * upstream message is still in the row's title attribute.
 */
function balanceErrorLabel(kind: BalanceError['kind']): string {
  switch (kind) {
    case 'no-key': return 'no API key on host'
    case 'network': return 'fetch failed (network)'
    case 'http': return 'fetch failed (http)'
    case 'parse': return 'fetch failed (parse)'
    case 'unavailable': return 'fetch failed (unavailable)'
  }
}

interface ModelCardProps {
  model: ModelUsage
  days: number
  rangeStartMs: number
}

function ModelCard({ model, days, rangeStartMs }: ModelCardProps) {
  const { series, peakSeries, max, labels } = useMemo(() => {
    const s = new Array<number>(days).fill(0)
    const ps = new Array<number>(days).fill(0)
    for (const [dateStr, bucket] of model.daily) {
      const dayIndex = Math.round(
        (Date.parse(`${dateStr}T00:00:00Z`) - rangeStartMs) / DAY_MS,
      )
      if (dayIndex >= 0 && dayIndex < days) {
        s[dayIndex] = bucket.tokens
        ps[dayIndex] = bucket.peakTokens
      }
    }
    const maxVal = Math.max(1, ...s)
    const labelCount = Math.min(5, days)
    const labelIdx: number[] = []
    for (let i = 0; i < labelCount; i++) {
      labelIdx.push(Math.round((i * (days - 1)) / Math.max(1, labelCount - 1)))
    }
    return { series: s, peakSeries: ps, max: maxVal, labels: labelIdx }
  }, [model, days, rangeStartMs])

  // Y-axis ticks in viewBox units (0, 33, 66, 100).
  const yTickValues = [0, Math.round(max / 3), Math.round((2 * max) / 3), max]

  return (
    <section className={css.model} data-model={model.model}>
      <div className={css.modelHeader}>
        <span className={css.modelName}>{modelDisplayName(model.model)}</span>
        <span className={css.modelMeta}>{formatTokensFull(model.totalTokens)}</span>
      </div>
      <div className={css.chartWrap}>
        {/* Y-axis labels first so they sit on the LEFT in the flex row. */}
        <div className={css.yAxis} aria-hidden="true">
          {yTickValues.slice().reverse().map(t => (
            <span key={t} className={css.yTick}>{formatTokens(t)}</span>
          ))}
        </div>
        <svg
          className={css.chart}
          viewBox={`0 0 ${CHART_VIEW_W} ${CHART_VIEW_H}`}
          preserveAspectRatio="none"
          aria-label={`Daily tokens for ${modelDisplayName(model.model)}, last ${days} days`}
        >
          {series.map((value, i) => {
            const h = max === 0 ? 0 : (value / max) * (CHART_VIEW_H - 2)
            if (h < 1) {
              return (
                <rect
                  key={i}
                  x={i + (1 - BAR_UNIT) / 2}
                  y={CHART_VIEW_H - FLOOR_UNIT}
                  width={BAR_UNIT}
                  height={FLOOR_UNIT}
                  className={css.barFloor}
                />
              )
            }
            // Split: peak (red) on top, off-peak (green) on the bottom.
            // `peakShare` is the per-bar fraction of peak tokens; for
            // pre-cutover data `peakTokens === 0` so the off-peak fill
            // spans the full bar.
            const peakShare = value === 0 ? 0 : (peakSeries[i] ?? 0) / value
            const peakH = h * peakShare
            const offH = h - peakH
            return (
              <g key={i}>
                {offH > 0 && (
                  <rect
                    x={i + (1 - BAR_UNIT) / 2}
                    y={CHART_VIEW_H - offH}
                    width={BAR_UNIT}
                    height={offH}
                    className={css.barOff}
                  />
                )}
                {peakH > 0 && (
                  <rect
                    x={i + (1 - BAR_UNIT) / 2}
                    y={CHART_VIEW_H - h}
                    width={BAR_UNIT}
                    height={peakH}
                    className={css.barPeak}
                  />
                )}
              </g>
            )
          })}
        </svg>
        {/* X-axis labels positioned as percentages of the chart width. */}
        <div className={css.xAxis} aria-hidden="true">
          {labels.map((idx) => {
            const date = new Date(rangeStartMs + idx * DAY_MS)
            const mm = String(date.getUTCMonth() + 1)
            const dd = String(date.getUTCDate())
            return (
              <span
                key={idx}
                className={css.xTick}
                style={{ left: `${(idx / days) * 100}%` }}
              >
                {mm}/{dd}
              </span>
            )
          })}
        </div>
      </div>
    </section>
  )
}
