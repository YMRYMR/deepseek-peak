/**
 * PeakHoursHost: owns the hover state, the local usage aggregation, and
 * the platform balance fetch. Mounts the unchanged `<PeakHoursPill />` next
 * to a hover-revealed `<UsageTooltip />`.
 *
 * The pill itself is untouched; this component is purely a host that
 * adds the overlay. The tooltip stays open while the mouse is over either
 * the pill or the tooltip itself (container-level hover), so the user can
 * click the settings form and the refresh button without the card
 * disappearing.
 *
 * The host also derives `phase` + `preLaunch` from the browser clock and
 * passes them to the tooltip so the card's color and border style track
 * the pill's band. The pill keeps its own 1 Hz ticker; the host ticks
 * only while the tooltip is open.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PeakHoursPill } from './PeakHoursPill.tsx'
import { UsageTooltip } from './UsageTooltip.tsx'
import {
  BalanceCache,
  fetchBalance,
  readApiKey,
  writeApiKey,
  type BalanceError,
  type BalanceSnapshot,
} from './balance.ts'
import { currentPhase, type Phase } from './domain.ts'
import { type UsageSummary } from './usage.ts'
import css from './PeakHoursHost.module.css'

const RANGE_DAYS = 30

export interface PeakHoursHostProps {
  /** Per-request aggregation closure; safe to call repeatedly. */
  aggregate: (rangeDays: number) => UsageSummary
  /** Subscribe to the sessions list; re-aggregates on each notification. */
  subscribeSessions: (listener: () => void) => () => void
  /** Subscribe to a tick fired after each new assistant message. */
  subscribeMessageTick?: (listener: () => void) => () => void
}

export function PeakHoursHost(props: PeakHoursHostProps) {
  const { aggregate, subscribeSessions, subscribeMessageTick } = props

  const [hovered, setHovered] = useState(false)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [apiKey, setApiKey] = useState<string | null>(() => readApiKey())
  const [balance, setBalance] = useState<BalanceSnapshot | null>(null)
  const [balanceError, setBalanceError] = useState<BalanceError | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)
  // Phase for the tooltip's color/border. The pill computes its own
  // phase independently (1 Hz), so this may drift by ≤1 s while the
  // tooltip is open; that's invisible because the colors only change at
  // the phase boundary, not within the same band.
  const [phase, setPhase] = useState<Phase>(() => currentPhase(new Date()).phase)
  const [preLaunch, setPreLaunch] = useState<boolean>(() => currentPhase(new Date()).preLaunch)

  const balanceCacheRef = useRef<BalanceCache>(new BalanceCache())
  // Guard against double-fetch on rapid hover-in/out.
  const summaryInflightRef = useRef(false)

  const recomputeSummary = useCallback(() => {
    if (summaryInflightRef.current) return
    summaryInflightRef.current = true
    setSummaryLoading(true)
    // Yield to the event loop so the hover state can render first; the
    // aggregation itself is synchronous, but a tiny defer keeps the UI
    // responsive on the first hover of a heavy history.
    queueMicrotask(() => {
      try {
        setSummary(aggregate(RANGE_DAYS))
      } finally {
        summaryInflightRef.current = false
        setSummaryLoading(false)
      }
    })
  }, [aggregate])

  const refreshBalance = useCallback(async () => {
    const key = readApiKey()
    setApiKey(key)
    if (key === null) {
      setBalance(null)
      setBalanceError({ kind: 'no-key', message: 'API key is empty' })
      return
    }
    setBalanceLoading(true)
    const result = await fetchBalance(key)
    balanceCacheRef.current.set(result)
    if (result.ok) {
      setBalance(result.balance)
      setBalanceError(null)
    } else {
      setBalance(null)
      setBalanceError(result.error)
    }
    setBalanceLoading(false)
  }, [])

  // Lazy fetch: on first hover, compute summary + maybe fetch balance.
  const onEnter = useCallback(() => {
    setHovered(true)
    if (summary === null && !summaryLoading) recomputeSummary()
    if (balance === null && balanceError === null && readApiKey() !== null) {
      void refreshBalance()
    }
  }, [summary, summaryLoading, balance, balanceError, recomputeSummary, refreshBalance])

  const onLeave = useCallback(() => setHovered(false), [])

  // Re-aggregate when the sessions store changes (new session, archived, etc.).
  useEffect(() => {
    if (!hovered) return
    return subscribeSessions(() => recomputeSummary())
  }, [hovered, subscribeSessions, recomputeSummary])

  // Re-aggregate when a new assistant message lands.
  useEffect(() => {
    if (!hovered || subscribeMessageTick === undefined) return
    return subscribeMessageTick(() => recomputeSummary())
  }, [hovered, subscribeMessageTick, recomputeSummary])

  // Keep the tooltip's phase in sync with the live schedule. Cheap
  // (one Date allocation + arithmetic per second), and the cost is
  // bounded to the open-tooltip window.
  useEffect(() => {
    if (!hovered) return
    const tick = () => {
      const snap = currentPhase(new Date())
      setPhase(snap.phase)
      setPreLaunch(snap.preLaunch)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [hovered])

  // Cache the current key for the BalanceLine's masked display.
  const hasApiKey = useMemo(() => apiKey !== null && apiKey.length > 0, [apiKey])

  const onSaveKey = useCallback((key: string) => {
    writeApiKey(key)
    setApiKey(key)
    balanceCacheRef.current.invalidate()
    setBalance(null)
    setBalanceError(null)
    void refreshBalance()
  }, [refreshBalance])

  const onClearKey = useCallback(() => {
    writeApiKey(null)
    setApiKey(null)
    balanceCacheRef.current.invalidate()
    setBalance(null)
    setBalanceError({ kind: 'no-key', message: 'cleared' })
  }, [])

  return (
    <span
      className={css.host}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocusCapture={onEnter}
      onBlurCapture={onLeave}
    >
      <PeakHoursPill />
      {hovered && (
        <UsageTooltip
          summary={summary}
          isLoading={summaryLoading}
          balance={balance}
          balanceError={balanceError}
          hasApiKey={hasApiKey}
          phase={phase}
          preLaunch={preLaunch}
          onSaveKey={onSaveKey}
          onClearKey={onClearKey}
          onRefreshBalance={() => void refreshBalance()}
          isRefreshingBalance={balanceLoading}
        />
      )}
    </span>
  )
}
