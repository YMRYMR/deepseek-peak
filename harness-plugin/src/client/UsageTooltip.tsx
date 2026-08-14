/**
 * UsageTooltip: hover overlay for the peak-hours pill.
 *
 * Renders one card per model with a tiny inline-SVG daily bar chart.
 * Anchored below the pill, right-aligned. Same color tokens and border
 * style as the pill so the two read as one element. The pill itself
 * is unchanged.
 *
 * Data: `UsageSummary` from `./usage.ts` and an optional `BalanceSnapshot`
 * from `./balance.ts`. The parent owns the lifecycle and re-fetches only
 * when needed.
 */

import { useMemo, useState } from 'react'
import { modelDisplayName } from './pricing.ts'
import { maskKey, type BalanceError, type BalanceSnapshot } from './balance.ts'
import {
  formatTokens, formatUsd, type ModelUsage, type UsageSummary,
} from './usage.ts'
import type { Phase } from './domain.ts'
import css from './UsageTooltip.module.css'

const DAY_MS = 24 * 60 * 60 * 1000
const BAR_PX = 4
const BAR_GAP_PX = 1
const CHART_H = 56

export interface UsageTooltipProps {
  summary: UsageSummary | null
  isLoading: boolean
  balance: BalanceSnapshot | null
  balanceError: BalanceError | null
  hasApiKey: boolean
  phase: Phase
  preLaunch: boolean
  onSaveKey: (key: string) => void
  onClearKey: () => void
  onRefreshBalance: () => void
  isRefreshingBalance: boolean
}

export function UsageTooltip(props: UsageTooltipProps) {
  const {
    summary, isLoading,
    balance, balanceError, hasApiKey,
    phase, preLaunch,
    onSaveKey, onClearKey, onRefreshBalance, isRefreshingBalance,
  } = props

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draftKey, setDraftKey] = useState('')

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
        <BalanceLine
          balance={balance}
          balanceError={balanceError}
          hasApiKey={hasApiKey}
          isRefreshing={isRefreshingBalance}
          onRefresh={onRefreshBalance}
          onOpenSettings={() => { setSettingsOpen(true); setDraftKey('') }}
        />
        {hasData && (
          <div className={css.subtitle}>
            Spent <span className={css.subNum}>≈ {formatUsd(summary.totalCost)}</span>
            <span className={css.subDot}>·</span>
            <span>{summary.totalMessages.toLocaleString()} messages here</span>
            {summary.hadMissing && <span className={css.warn}>· partial</span>}
          </div>
        )}
      </header>

      {settingsOpen && (
        <SettingsForm
          currentMask={hasApiKey ? maskKey('') : 'not set'}
          draftKey={draftKey}
          onDraftChange={setDraftKey}
          onSave={() => {
            const k = draftKey.trim()
            if (k.length > 0) onSaveKey(k)
            setSettingsOpen(false)
            setDraftKey('')
          }}
          onCancel={() => { setSettingsOpen(false); setDraftKey('') }}
          onClear={() => { onClearKey(); setSettingsOpen(false); setDraftKey('') }}
        />
      )}

      {hasData && (
        <div className={css.models}>
          {summary.models.map((m) => (
            <ModelCard key={m.model} model={m}
              days={Math.round((summary.rangeEndUtc.getTime() - summary.rangeStartUtc.getTime()) / DAY_MS) + 1}
              rangeStartMs={summary.rangeStartUtc.getTime()} />
          ))}
        </div>
      )}

      {hasData && (
        <footer className={css.footer}>
          <span>Last {summary.rangeDays} days</span>
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

      {!hasData && (
        <div className={css.emptyBody}>
          <span className={css.placeholder}>
            No tracked usage in the last {summary?.rangeDays ?? 30} days.
          </span>
          <span className={css.placeholderHint}>
            Usage appears here once you chat with a V4 model.
          </span>
        </div>
      )}
    </div>
  )
}

interface BalanceLineProps {
  balance: BalanceSnapshot | null
  balanceError: BalanceError | null
  hasApiKey: boolean
  isRefreshing: boolean
  onRefresh: () => void
  onOpenSettings: () => void
}

function BalanceLine({
  balance, balanceError, hasApiKey, isRefreshing, onRefresh, onOpenSettings,
}: BalanceLineProps) {
  if (balance !== null) {
    const usd = balance.entries.find((e) => e.currency === 'USD') ?? balance.entries[0]
    if (usd !== undefined) {
      const age = Math.max(0, Math.round((Date.now() - balance.refreshedAt) / 1000))
      return (
        <div className={css.titleLine} title={`Refreshed ${age}s ago — click ↻ to refresh`}>
          <span className={css.titleLabel}>Balance</span>
          <span className={css.titleNum}>{formatUsd(usd.total)}</span>
          <span className={css.titleUnit}>{usd.currency}</span>
          <button
            type="button"
            className={css.refreshBtn}
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label="Refresh balance"
          >↻</button>
        </div>
      )
    }
  }
  if (balanceError !== null) {
    return (
      <div className={css.titleLine}>
        <span className={css.titleLabel}>Balance</span>
        <span className={css.errorHint} title={balanceError.message}>
          {balanceError.kind === 'no-key' || !hasApiKey
            ? 'set key for live balance'
            : 'fetch failed'}
        </span>
        <button type="button" className={css.refreshBtn} onClick={onOpenSettings}
          aria-label="Configure API key">⚙</button>
      </div>
    )
  }
  // No fetch yet.
  return (
    <div className={css.titleLine}>
      <span className={css.titleLabel}>Balance</span>
      <span className={css.errorHint}>{hasApiKey ? 'loading…' : 'set key for live balance'}</span>
      <button type="button" className={css.refreshBtn} onClick={onOpenSettings}
        aria-label="Configure API key">⚙</button>
    </div>
  )
}

interface SettingsFormProps {
  currentMask: string
  draftKey: string
  onDraftChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
  onClear: () => void
}

function SettingsForm(props: SettingsFormProps) {
  return (
    <div className={css.settings} role="dialog" aria-label="DeepSeek API key">
      <label className={css.settingsLabel}>
        DeepSeek API key
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          className={css.settingsInput}
          placeholder="sk-…"
          value={props.draftKey}
          onChange={(e) => props.onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); props.onSave() }
            if (e.key === 'Escape') { e.preventDefault(); props.onCancel() }
          }}
        />
      </label>
      <div className={css.settingsHint}>
        Stored locally in this browser only. Used to call
        <code> /user/balance</code>. Never logged or sent anywhere else.
      </div>
      <div className={css.settingsActions}>
        <button type="button" className={css.btn} onClick={props.onCancel}>Cancel</button>
        <button type="button" className={css.btnGhost} onClick={props.onClear}>Clear</button>
        <button type="button" className={css.btnPrimary} onClick={props.onSave}
          disabled={props.draftKey.trim().length === 0}>Save</button>
      </div>
    </div>
  )
}

interface ModelCardProps {
  model: ModelUsage
  days: number
  rangeStartMs: number
}

function ModelCard({ model, days, rangeStartMs }: ModelCardProps) {
  const width = days * BAR_PX + (days - 1) * BAR_GAP_PX
  const { bars, max, ticks, labels } = useMemo(() => {
    const series = new Array<number>(days).fill(0)
    for (const [dateStr, bucket] of model.daily) {
      const dayIndex = Math.round(
        (Date.parse(`${dateStr}T00:00:00Z`) - rangeStartMs) / DAY_MS
      )
      if (dayIndex >= 0 && dayIndex < days) series[dayIndex] = bucket.tokens
    }
    const maxVal = Math.max(1, ...series)
    const tickValues = [0, Math.round(maxVal / 3), Math.round((2 * maxVal) / 3), maxVal]
    const labelCount = Math.min(5, days)
    const labelIdx: number[] = []
    for (let i = 0; i < labelCount; i++) {
      labelIdx.push(Math.round((i * (days - 1)) / Math.max(1, labelCount - 1)))
    }
    return { bars: series, max: maxVal, ticks: tickValues, labels: labelIdx }
  }, [model, days, rangeStartMs])

  const yAt = (value: number): number => {
    if (max === 0) return CHART_H
    return CHART_H - Math.round((value / max) * CHART_H)
  }

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
        <div className={css.yAxis} aria-hidden="true">
          {ticks.slice().reverse().map((t) => (
            <span key={t} className={css.yTick}>{formatTokens(t)}</span>
          ))}
        </div>
        <svg
          className={css.chart}
          width={width} height={CHART_H}
          viewBox={`0 0 ${width} ${CHART_H}`}
          role="img"
          aria-label={`Daily tokens for ${modelDisplayName(model.model)}, last ${days} days`}
        >
          {bars.map((value, i) => {
            const x = i * (BAR_PX + BAR_GAP_PX)
            const h = Math.max(0, CHART_H - yAt(value))
            const y = CHART_H - h
            if (h === 0) {
              // Empty-day floor: a 2px sliver so zero days are still visible
              // as a baseline mark, not invisible. Matches the platform's
              // chart look where every day is represented.
              return <rect key={i} x={x} y={CHART_H - 2} width={BAR_PX} height={2} className={css.barFloor} />
            }
            return (
              <rect key={i} x={x} y={y} width={BAR_PX} height={h} className={css.bar} />
            )
          })}
        </svg>
      </div>
      <div className={css.xAxis} aria-hidden="true" style={{ width }}>
        {labels.map((idx) => {
          const date = new Date(rangeStartMs + idx * DAY_MS)
          const mm = String(date.getUTCMonth() + 1)
          const dd = String(date.getUTCDate())
          return (
            <span key={idx} className={css.xTick}
              style={{ left: idx * (BAR_PX + BAR_GAP_PX) }}>
              {mm}/{dd}
            </span>
          )
        })}
      </div>
    </section>
  )
}
