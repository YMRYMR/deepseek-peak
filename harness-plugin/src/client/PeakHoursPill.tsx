/**
 * PeakHoursPill: a compact always-visible status pill for the session header's
 * right-aligned utilities row (right next to the Session log button). Phase is
 * computed from the browser clock; no host round-trip.
 *
 * Auto-sizes: the pill collapses to its essentials (dot + label + countdown)
 * and lets the countdown text truncate with an ellipsis when the host utility
 * row is narrow. The pause switch is the last child on the right and never
 * grows the pill — it is a fixed 26 × 14 track that lives inside the pill's
 * own min-content height.
 *
 * The pause switch is owned by this component (not by `PeakHoursHost`) so
 * the pill's affordance is always present, not just on hover. The host
 * overlay (per-model chart + balance) lives in `PeakHoursHost`.
 */

import { useEffect, useState } from 'react'
import { currentPhase, formatCountdown, phaseLabel, type PhaseSnapshot } from './domain.ts'
import { PauseSwitch } from './PauseSwitch.tsx'
import { usePeakHoursState } from './peakHoursState.ts'
import css from './PeakHoursPill.module.css'

export interface PeakHoursPillProps {
  /**
   * When true, the pill's color cascades to an amber/warning style
   * (border, dot, label, badge) instead of the green/red phase
   * color. Computed by the parent (typically PeakHoursHost) from
   * `balance.total < settings.lowBalanceWarningUsd`; the pill itself
   * doesn't know about balance or thresholds. `undefined` is
   * treated as `false` (no warning) so existing call sites keep
   * working without changes.
   */
  lowBalance?: boolean
}

export function PeakHoursPill(props: PeakHoursPillProps = {}) {
  const { lowBalance = false } = props
  const [snap, setSnap] = useState<PhaseSnapshot>(() => currentPhase(new Date()))
  const peakHours = usePeakHoursState()

  useEffect(() => {
    // 1 Hz keeps the countdown feeling live without paying for sub-second
    // rerenders on every session header.
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
    <span
      // The class order is intentional: `.lowBalance` is appended last
      // so its color rule wins over `.peak`/`.off` in the stylesheet
      // (the warning is the dominant signal — the user has a bigger
      // problem than peak/off-peak if their balance is low). The
      // `data-low-balance` attribute is the public surface for
      // any downstream CSS or test that needs to query the state.
      className={[
        css.pill,
        snap.phase === 'peak' ? css.peak : css.off,
        snap.preLaunch ? css.preLaunch : '',
        lowBalance ? css.lowBalance : '',
      ].filter(Boolean).join(' ')}
      data-peak-hours="pill"
      data-phase={snap.phase}
      data-pre-launch={snap.preLaunch ? 'true' : 'false'}
      data-paused={peakHours.state?.isPaused === true ? 'true' : 'false'}
      data-blocked={peakHours.state?.isBlockedNow === true ? 'true' : 'false'}
      data-low-balance={lowBalance ? 'true' : 'false'}
      role="status"
      aria-live="polite"
    >
      <span className={css.dot} aria-hidden="true" />
      <span className={css.label}>{phaseLabel(snap.phase)}</span>
      {snap.preLaunch && <span className={css.badge}>pre-cutover</span>}
      <span className={css.countdown}>{formatCountdown(snap.minutesToNext)}</span>
      <span className={css.arrow} aria-hidden="true">→</span>
      <span className={css.target}>
        {snap.preLaunch ? 'live' : `${snap.nextLabel} ${localBoundary}`}
      </span>
      <PauseSwitch
        state={peakHours.state}
        disabled={peakHours.loading}
        onToggle={peakHours.setPaused}
      />
    </span>
  )
}
