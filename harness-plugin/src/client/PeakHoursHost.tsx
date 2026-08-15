/**
 * PeakHoursHost: owns the hover state, the local usage aggregation, and
 * the balance fetch. Mounts the unchanged `<PeakHoursPill />` next to a
 * hover-revealed `<UsageTooltip />`.
 *
 * The pill itself is untouched; this component is purely a host that
 * adds the overlay. The tooltip stays open while the mouse is over
 * either the pill or the tooltip itself (container-level hover), so
 * the user can move the cursor freely without the card flashing off.
 *
 * The host also derives `phase` + `preLaunch` from the browser clock
 * and passes them to the tooltip so the card's color and border style
 * track the pill's band. The pill keeps its own 1 Hz ticker; the host
 * ticks only while the tooltip is open.
 *
 * The balance is fetched through the host's `/api/peak-hours/balance`
 * route, which resolves the DeepSeek API key server-side. The browser
 * never holds the key; the host returns the JSON envelope directly.
 *
 * Usage aggregation walks the host's `/api/peak-hours/usage` endpoint
 * (a `ctx.sessionPersistence` walk) first, then falls back to the
 * in-browser trajectory-view walk if the host endpoint is unavailable
 * (TUI build, transient network blip). The host's response is the
 * source of truth for the chart's per-day buckets, so the chart
 * survives a harness relaunch even when the trajectory view is empty.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { PeakHoursPill } from './PeakHoursPill.tsx'
import { UsageTooltip } from './UsageTooltip.tsx'
import { QueueCard } from './QueueCard.tsx'
import { usePeakHoursState } from './peakHoursState.ts'
import { fetchHostUsage, type UsageSummary } from './usage.ts'
import { currentPhase, type Phase } from './domain.ts'
import { BalanceCache, fetchBalance, type BalanceResult } from './balance.ts'
import css from './PeakHoursHost.module.css'

const RANGE_DAYS = 30

/**
 * Throttle window for "new message landed" ticks. The host's `?fresh=1`
 * walk is the dominant cost of a refresh (parallel-batched, but still
 * bounded by the number of persisted sessions, since listSnapshots
 * doesn't expose a "last event time" to skip sessions outside the
 * range). For a busy harness the cold walk is in the 1-5 s range, and
 * a burst of chat messages would otherwise queue one walk per message,
 * leaving the chart stuck in "Scanning session history…" almost
 * continuously. The first message in a quiet window triggers an
 * immediate fresh walk; further messages within this many ms are
 * coalesced. 30 s gives an active user a clearly live chart (a fresh
 * walk every 30 s of traffic) without the constant loading state.
 */
const MESSAGE_TICK_THROTTLE_MS = 30_000

/**
 * Background refresh cadence for the chart while the tooltip is open.
 * Matches the balance row's 5-min host cache so the user always sees
 * data no more than 5 min old without leaving the tooltip. The
 * refresh fires silently (no loading flash): the data swaps in
 * without a visible state transition because a user who is hovering
 * the pill for 6 minutes does not want to see "Scanning…" every
 * 5 min — they want the bars to keep moving.
 */
const CHART_REFRESH_MS = 5 * 60_000

export interface PeakHoursHostProps {
  /**
   * Per-request aggregation closure. Used as the fallback when the host
   * endpoint is unavailable; the browser's trajectory view is built
   * lazily, so on a cold launch this returns an empty summary.
   */
  aggregate: (rangeDays: number) => UsageSummary
  /** Subscribe to the sessions list; re-aggregates on each notification. */
  subscribeSessions: (listener: () => void) => () => void
  /** Subscribe to a tick fired after each new assistant message. */
  subscribeMessageTick?: (listener: () => void) => () => void
}

export function PeakHoursHost(props: PeakHoursHostProps) {
  const { aggregate, subscribeSessions, subscribeMessageTick } = props

  // Read the live pause/queue state from the host. The hook owns its
  // own 2-s polling; the host gives us the per-message payload for
  // the queue card so we can render one row per item. The `toggle`
  // / `setPaused` are exposed via the pill's own state hook
  // (PauseSwitch reads them directly), so the host doesn't need to
  // thread them through. The `dispatchQueueItem` thunk powers the
  // card's per-row "send" arrow: it bypasses the pause switch to
  // release the front item through the host's dispatch endpoint.
  const { state: pauseState, dispatchQueueItem } = usePeakHoursState()

  const [hovered, setHovered] = useState(false)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  // Phase for the tooltip's color/border. The pill computes its own
  // phase independently (1 Hz), so this may drift by ≤1 s while the
  // tooltip is open; that's invisible because the colors only change at
  // the phase boundary, not within the same band.
  const [phase, setPhase] = useState<Phase>(() => currentPhase(new Date()).phase)
  const [preLaunch, setPreLaunch] = useState<boolean>(() => currentPhase(new Date()).preLaunch)
  // Balance state for the host-routed fetch. The cache lives in a ref so
  // hovers don't lose it; the state is the last-resolved value, used by
  // the tooltip's balance row.
  const balanceCacheRef = useRef<BalanceCache>(new BalanceCache())
  const [balance, setBalance] = useState<BalanceResult | null>(() => balanceCacheRef.current.value)
  const [balanceLoading, setBalanceLoading] = useState(false)

  // Guard against double-fetch on rapid hover-in/out. The inflight
  // ref is the single source of truth across `recomputeSummary` and
  // its inner helpers; the host fetch and the client fallback both
  // short-circuit on it.
  const summaryInflightRef = useRef(false)
  const balanceInflightRef = useRef(false)
  // Abort controller for the host fetch. Cancelled when the tooltip
  // closes so an in-flight GET doesn't leak a setState on a torn-down
  // component; the next open re-fires.
  const hostUsageAbortRef = useRef<AbortController | null>(null)

  /**
   * Build a `UsageSummary` for the trailing window. Tries the host
   * endpoint first (cold-launch source of truth), then falls back to
   * the in-browser trajectory walk. `fresh=true` adds `?fresh=1` to
   * bypass the host's 5-min cache; the browser call on a
   * "new-message" tick uses fresh so the latest day is reflected
   * within seconds, not at TTL.
   */
  const loadSummary = useCallback(async (fresh: boolean): Promise<UsageSummary | null> => {
    const host = await fetchHostUsage(RANGE_DAYS, fresh, hostUsageAbortRef.current?.signal)
    if (host !== null) return host
    // Fallback: the in-browser trajectory walk. Returns an empty
    // summary on a cold launch (no trajectory view populated), but
    // it's better than showing "no data" when the host endpoint is
    // genuinely unavailable (TUI build, network blip).
    return aggregate(RANGE_DAYS)
  }, [aggregate])

  const recomputeSummary = useCallback((fresh: boolean = false, silent: boolean = false) => {
    if (summaryInflightRef.current) return
    summaryInflightRef.current = true
    // `silent` suppresses the "Scanning session history…" loading
    // flash. The 5-min auto-refresh tick uses silent so the chart
    // updates without a visible state transition; user-driven
    // fetches (hover, message tick) keep the loading flash so the
    // user can see the work is in progress.
    if (!silent) setSummaryLoading(true)
    // Cancel any previous in-flight host fetch so a fast hover
    // toggle never races two responses into the same state setter.
    if (hostUsageAbortRef.current !== null) hostUsageAbortRef.current.abort()
    const abort = new AbortController()
    hostUsageAbortRef.current = abort
    void (async () => {
      try {
        const next = await loadSummary(fresh)
        // Drop the result if the user closed the tooltip (or a newer
        // request superseded us) before this fetch resolved.
        if (hostUsageAbortRef.current !== abort) return
        setSummary(next)
      } finally {
        if (hostUsageAbortRef.current === abort) {
          hostUsageAbortRef.current = null
          summaryInflightRef.current = false
          if (!silent) setSummaryLoading(false)
        }
      }
    })()
  }, [loadSummary])

  const refreshBalance = useCallback(async () => {
    if (balanceInflightRef.current) return
    // Cache hit: surface the cached value immediately, no network.
    const cache = balanceCacheRef.current
    if (cache.valid) {
      const cached = cache.value
      if (cached !== null) setBalance(cached)
      return
    }
    balanceInflightRef.current = true
    setBalanceLoading(true)
    try {
      const result = await fetchBalance()
      cache.set(result)
      setBalance(result)
    } finally {
      balanceInflightRef.current = false
      setBalanceLoading(false)
    }
  }, [])

  // Lazy fetch: on first hover, compute summary + balance.
  const onEnter = useCallback(() => {
    setHovered(true)
    if (summary === null && !summaryLoading) recomputeSummary(false)
    if (!balanceLoading) void refreshBalance()
  }, [summary, summaryLoading, recomputeSummary, refreshBalance, balanceLoading])

  const onLeave = useCallback(() => {
    setHovered(false)
    // Cancel any in-flight host fetch so a stale response doesn't
    // land after the user has moved the cursor away.
    if (hostUsageAbortRef.current !== null) {
      hostUsageAbortRef.current.abort()
      hostUsageAbortRef.current = null
    }
  }, [])

  // Re-aggregate when the sessions store changes (new session, archived, etc.).
  useEffect(() => {
    if (!hovered) return
    return subscribeSessions(() => recomputeSummary(true))
  }, [hovered, subscribeSessions, recomputeSummary])

  // Re-aggregate when a new assistant message lands. `fresh=true`
  // bypasses the host's 5-min cache so today's bucket reflects the
  // new tokens within seconds rather than at TTL. The tick is
  // throttled so a burst of messages (100 chat replies in 10 s)
  // coalesces to ~2 host walks instead of 100, and the chart
  // never lingers in the "Scanning session history…" state for
  // most of that burst. The first message in a quiet window
  // triggers an immediate walk; the throttling only suppresses
  // the redundant ones inside the window.
  useEffect(() => {
    if (!hovered || subscribeMessageTick === undefined) return
    let lastFreshAt = 0
    return subscribeMessageTick(() => {
      const now = Date.now()
      if (now - lastFreshAt < MESSAGE_TICK_THROTTLE_MS) return
      lastFreshAt = now
      recomputeSummary(true)
    })
  }, [hovered, subscribeMessageTick, recomputeSummary])

  // Background refresh every 5 min while the tooltip is open. The
  // walk is silent (no loading flash) so a user keeping the pill
  // hovered through a long session sees the chart update in place
  // rather than flashing "Scanning…" every 5 min. The 5-min cadence
  // matches the balance row's host cache so both surfaces age
  // together — when the balance refreshes, so does the chart. The
  // interval is cleared on unmount and on tooltip close; a stale
  // timer is the one thing worse than no timer.
  useEffect(() => {
    if (!hovered) return
    const id = setInterval(() => {
      // Silent: no "Scanning session history…" flash. The data
      // swaps in when the walk resolves. If a user-driven fetch
      // is already in flight, `recomputeSummary`'s inflight guard
      // short-circuits and the interval tick is a no-op.
      recomputeSummary(true, true)
    }, CHART_REFRESH_MS)
    return () => clearInterval(id)
  }, [hovered, recomputeSummary])

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

  // The hover container is a flex column anchored below the pill.
  // It holds the chart card (always) and the queue card (only when
  // there are queued messages). The chart card applies `wrapperMode`
  // so it stops anchoring itself absolutely and stacks with the
  // queue card under it. The host's `::after` bridge absorbs the
  // 2 px gap between the pill and the container.
  const queueItems = pauseState?.queue ?? []
  const queueOverflow = pauseState?.queueOverflow ?? 0
  const queueTotal = pauseState?.queueSize ?? 0
  const showQueue = hovered && queueTotal > 0

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
        <div className={css.hover}>
          <UsageTooltip
            wrapperMode
            summary={summary}
            isLoading={summaryLoading}
            phase={phase}
            preLaunch={preLaunch}
            balance={balance}
            balanceLoading={balanceLoading}
          />
          {showQueue && (
            <QueueCard
              items={queueItems}
              overflow={queueOverflow}
              phase={phase}
              preLaunch={preLaunch}
              onDispatch={dispatchQueueItem}
            />
          )}
        </div>
      )}
    </span>
  )
}
