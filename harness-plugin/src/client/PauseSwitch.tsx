/**
 * PauseSwitch: a small pill-internal switch that toggles the host's
 * pause-during-peak state. The host is the source of truth for both
 * the persisted `paused` flag and the live `isBlockedNow` derivation,
 * so the switch renders the host's snapshot and POSTs on click.
 *
 * Three visual states, derived from `(isPaused, phase)`:
 *
 *   - OFF                — track uses the pill's off-peak tint (muted green)
 *   - ON + off-peak      — track is solid green; knob is to the right
 *   - ON + peak          — track is solid red; knob is to the right;
 *                          a small badge with the queue count rides
 *                          the track's top-right corner
 *
 * The switch is the last child of the pill and never grows the pill
 * beyond its current min-content width: a fixed 26 × 14 track with a
 * 1px border keeps the affordance inside the pill's own height. The
 * pre-cutover dashed-border treatment is inherited from the parent.
 */

import { useCallback, useRef } from 'react'
import css from './PauseSwitch.module.css'
import type { Phase } from './domain.ts'
import type { PeakHoursState } from './peakHoursState.ts'

export interface PauseSwitchProps {
  /** Host snapshot. The switch is a leaf — it does not own state. */
  readonly state: PeakHoursState | null
  /** Disable click handling while the first fetch is still in flight. */
  readonly disabled: boolean
  /** POST a new paused value. */
  readonly onToggle: (value: boolean) => Promise<void>
}

function trackClass(phase: Phase | undefined, isPaused: boolean): string {
  if (!isPaused) return css.trackOff ?? ''
  if (phase === 'peak') return css.trackPeak ?? ''
  return css.trackPausedOff ?? ''
}

function trackLabel(isPaused: boolean, isBlockedNow: boolean): string {
  if (isBlockedNow) return 'Peak hours paused — messages queue and dispatch when off-peak'
  if (isPaused) return 'Pause on, off-peak — messages pass through'
  return 'Off — messages always pass through'
}

export function PauseSwitch(props: PauseSwitchProps) {
  const { state, disabled, onToggle } = props
  const isPaused = state?.isPaused === true
  const phase = state?.phase
  const isBlockedNow = state?.isBlockedNow === true
  const queueSize = state?.queueSize ?? 0
  // In-flight flag kept in a ref so the optimistic click doesn't
  // double-fire while the POST is in flight. The host's POST is
  // idempotent for the persisted boolean, but a rapid double-click
  // would still flip back before the user sees the first result.
  const inFlightRef = useRef<boolean>(false)

  const onClick = useCallback(async (): Promise<void> => {
    if (disabled || inFlightRef.current) return
    inFlightRef.current = true
    try {
      await onToggle(!isPaused)
    } finally {
      inFlightRef.current = false
    }
  }, [disabled, isPaused, onToggle])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      void onClick()
    }
  }, [onClick])

  const label = trackLabel(isPaused, isBlockedNow)
  const showBadge = isBlockedNow && queueSize > 0
  const badgeText = queueSize > 99 ? '99+' : String(queueSize)
  const ariaLabel = `Pause DeepSeek during peak hours — ${label}. Click to ${isPaused ? 'disable' : 'enable'}.`

  return (
    <button
      type="button"
      className={[
        css.switch ?? '',
        trackClass(phase, isPaused),
      ].filter(Boolean).join(' ')}
      data-on={isPaused ? 'true' : 'false'}
      data-blocked={isBlockedNow ? 'true' : 'false'}
      aria-label={ariaLabel}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span className={css.knob} aria-hidden="true" />
      {showBadge && (
        <span className={css.badge} aria-label={`${queueSize} queued`}>{badgeText}</span>
      )}
    </button>
  )
}
