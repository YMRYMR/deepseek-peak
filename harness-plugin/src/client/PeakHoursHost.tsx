/**
 * PeakHoursHost: owns the hover state and the local usage aggregation.
 * Mounts the unchanged `<PeakHoursPill />` next to a hover-revealed
 * `<UsageTooltip />`.
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
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { PeakHoursPill } from './PeakHoursPill.tsx'
import { UsageTooltip } from './UsageTooltip.tsx'
import { aggregateUsage, type UsageSummary } from './usage.ts'
import { currentPhase, type Phase } from './domain.ts'
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
  // Phase for the tooltip's color/border. The pill computes its own
  // phase independently (1 Hz), so this may drift by ≤1 s while the
  // tooltip is open; that's invisible because the colors only change at
  // the phase boundary, not within the same band.
  const [phase, setPhase] = useState<Phase>(() => currentPhase(new Date()).phase)
  const [preLaunch, setPreLaunch] = useState<boolean>(() => currentPhase(new Date()).preLaunch)

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

  // Lazy fetch: on first hover, compute summary.
  const onEnter = useCallback(() => {
    setHovered(true)
    if (summary === null && !summaryLoading) recomputeSummary()
  }, [summary, summaryLoading, recomputeSummary])

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
          phase={phase}
          preLaunch={preLaunch}
        />
      )}
    </span>
  )
}
