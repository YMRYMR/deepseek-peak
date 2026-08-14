/**
 * PeakHoursDock: a small always-visible card in the conversation input dock
 * showing whether the DeepSeek V4 API is in its peak (2x) or off-peak
 * pricing band, with a live countdown to the next phase change. Phase is
 * computed from the browser clock; no host round-trip.
 */

import { useEffect, useState } from 'react'
import { currentPhase, formatCountdown, phaseLabel, type PhaseSnapshot } from './domain.ts'
import css from './PeakHoursDock.module.css'

export function PeakHoursDock() {
  const [snap, setSnap] = useState<PhaseSnapshot>(() => currentPhase(new Date()))

  useEffect(() => {
    // 1 Hz keeps the seconds-precision clock feeling live without burning the
    // dock strip's layout budget. The card is small enough that a single
    // interval is cheaper than any framework-blessed subscription.
    const id = setInterval(() => {
      setSnap(currentPhase(new Date()))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const localBoundary = snap.nextBoundaryUtc.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  return (
    <div
      className={[
        css.dock,
        snap.phase === 'peak' ? css.peak : css.off,
        snap.preLaunch ? css.preLaunch : '',
      ].filter(Boolean).join(' ')}
      data-peak-hours
      data-phase={snap.phase}
      data-pre-launch={snap.preLaunch ? 'true' : 'false'}
      role="status"
      aria-live="polite"
    >
      <div className={css.bar}>
        <span className={css.dot} aria-hidden="true" />
        <span className={css.label}>{phaseLabel(snap.phase)}</span>
        <span className={css.subtitle}>
          {snap.phase === 'peak' ? '2x surcharge' : '0.5x baseline'}
        </span>
        {snap.preLaunch && <span className={css.badge}>pre-cutover</span>}
        <span className={css.spacer} />
        <span className={css.countdownLabel}>Next</span>
        <span className={css.countdownValue}>{formatCountdown(snap.minutesToNext)}</span>
        <span className={css.countdownTarget}>
          → {snap.nextLabel} {localBoundary}
        </span>
      </div>
    </div>
  )
}
