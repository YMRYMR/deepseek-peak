/**
 * UsageTooltip: hover overlay for the peak-hours pill.
 *
 * Renders one card per model with a tiny inline-SVG daily bar chart.
 * Anchored below the pill, right-aligned. Same color tokens and border
 * style as the pill so the two read as one element. The pill itself
 * is unchanged.
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
  formatTokens, formatUsd, type ModelUsage, type UsageSummary,
} from './usage.ts'
import type { Phase } from './domain.ts'
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
}

export function UsageTooltip(props: UsageTooltipProps) {
  const { summary, isLoading, phase, preLaunch } = props

  const cardClass = [
    css.card,
    phase === 'peak' ? css.cardPeak : css.cardOff,
    preLaunch ? css.cardPreLaunch : '',
  ].filter(Boolean).join(' ')

  if (isLoading) {
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
        {hasData ? (
          <div className={css.subtitle}>
            Spent <span className={css.subNum}>≈ {formatUsd(summary.totalCost)}</span>
            <span className={css.subDot}>·</span>
            <span>{summary.totalMessages.toLocaleString()} messages</span>
            {summary.hadMissing && <span className={css.warn}>· partial</span>}
          </div>
        ) : (
          <div className={css.subtitle}>
            <span className={css.subDot}>·</span>
            <span>Usage appears here once you chat with a V4 model</span>
          </div>
        )}
      </header>

      {hasData && (
        <div className={css.models}>
          {summary.models.map((m) => (
            <ModelCard key={m.model} model={m}
              days={RANGE_DAYS}
              rangeStartMs={summary.rangeStartUtc.getTime()} />
          ))}
        </div>
      )}

      {hasData && (
        <footer className={css.footer}>
          <span>Last {RANGE_DAYS} days</span>
          <span className={css.footDot}>·</span>
          <span>UTC</span>
          {summary.firstRecordMs !== null && (
            <>
              <span className={css.footDot}>·</span>
              <span title={new Date(summary.firstRecordMs).toISOString()}>
                since {new Date(summary.firstRecordMs).toISOString().slice(0, 10)}
              </span>
            </>
          )}
        </footer>
      )}
    </div>
  )
}

interface ModelCardProps {
  model: ModelUsage
  days: number
  rangeStartMs: number
}

function ModelCard({ model, days, rangeStartMs }: ModelCardProps) {
  const { series, max, labels } = useMemo(() => {
    const s = new Array<number>(days).fill(0)
    for (const [dateStr, bucket] of model.daily) {
      const dayIndex = Math.round(
        (Date.parse(`${dateStr}T00:00:00Z`) - rangeStartMs) / DAY_MS
      )
      if (dayIndex >= 0 && dayIndex < days) s[dayIndex] = bucket.tokens
    }
    const maxVal = Math.max(1, ...s)
    const labelCount = Math.min(5, days)
    const labelIdx: number[] = []
    for (let i = 0; i < labelCount; i++) {
      labelIdx.push(Math.round((i * (days - 1)) / Math.max(1, labelCount - 1)))
    }
    return { series: s, max: maxVal, labels: labelIdx }
  }, [model, days, rangeStartMs])

  // Y-axis ticks in viewBox units (0, 33, 66, 100).
  const yTickValues = [0, Math.round(max / 3), Math.round((2 * max) / 3), max]

  return (
    <section className={css.model} data-model={model.model}>
      <div className={css.modelHeader}>
        <span className={css.modelName}>{modelDisplayName(model.model)}</span>
        <span className={css.modelMeta}>
          {formatTokens(model.totalTokens)}
          <span className={css.modelDot}>·</span>
          {formatUsd(model.totalCost)}
        </span>
      </div>
      <div className={css.chartWrap}>
        {/* Y-axis labels first so they sit on the LEFT in the flex row. */}
        <div className={css.yAxis} aria-hidden="true">
          {yTickValues.slice().reverse().map((t) => (
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
            return (
              <rect
                key={i}
                x={i + (1 - BAR_UNIT) / 2}
                y={CHART_VIEW_H - h}
                width={BAR_UNIT}
                height={h}
                className={css.bar}
              />
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
