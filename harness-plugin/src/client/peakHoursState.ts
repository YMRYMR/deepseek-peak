/**
 * Browser-side bridge to the host's pause-state endpoint.
 *
 * The host owns the source of truth: it knows the persisted `paused` flag
 * (from `ctx.settings`), the live UTC phase, and the in-memory queue
 * depth. The browser holds a polled snapshot and a `setPaused`/`toggle`
 * thunk that POSTs the new value. Polling (2 s) is the simplest model
 * that survives a Web-bundle that has no SSE carrier, and the wire is
 * already small (one JSON envelope per tab per tick).
 *
 * The 2 s cadence is fast enough that the pill's `pause`/`queue` indicators
 * feel live to the user without flooding the host: a 30-message session
 * keeps a single state request open at any time per tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Phase } from './domain.ts'

/** Wire shape mirrored from `src/index.ts` `StateJsonSuccess.state`. */
export interface PeakHoursState {
  readonly isPaused: boolean
  readonly phase: Phase
  readonly preLaunch: boolean
  readonly isBlockedNow: boolean
  /** Epoch ms of the next phase boundary; -1 if pre-cutover (cutovertime lives in `cutoverAt`). */
  readonly nextPhaseAt: number
  /** Epoch ms of the pricing-cutover; -1 if already live. */
  readonly cutoverAt: number
  readonly queueSize: number
  readonly refreshedAt: number
}

const STATE_ENDPOINT = '/api/peak-hours/state'
const POLL_INTERVAL_MS = 2_000
/** POST body cap matches the host's readJsonBody limit. */
const POST_BODY_BYTE_LIMIT = 1_024

export interface PeakHoursStateHook {
  /** Latest snapshot from the host, or `null` until the first fetch settles. */
  readonly state: PeakHoursState | null
  /** True for the duration of the first fetch (no state yet). */
  readonly loading: boolean
  /** POST a new paused value. Resolves with the fresh state on success. */
  readonly setPaused: (value: boolean) => Promise<void>
  /** Flip the current `isPaused` value (no-op if no state yet). */
  readonly toggle: () => Promise<void>
}

interface StateJsonOk {
  readonly ok: true
  readonly state: PeakHoursState
}
interface StateJsonErr {
  readonly ok: false
  readonly error: { readonly kind: string; readonly message: string }
}
type StateJson = StateJsonOk | StateJsonErr

function isStateJson(value: unknown): value is StateJson {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (obj.ok === true) {
    const s = obj.state
    return s !== null && typeof s === 'object'
      && typeof (s as Record<string, unknown>).isPaused === 'boolean'
  }
  if (obj.ok === false) {
    return typeof (obj as Record<string, unknown>).error === 'object'
  }
  return false
}

function readState(json: StateJson): PeakHoursState | null {
  if (!json.ok) return null
  const s = json.state as unknown as Record<string, unknown>
  return {
    isPaused: Boolean(s.isPaused),
    phase: s.phase === 'peak' ? 'peak' : 'off',
    preLaunch: Boolean(s.preLaunch),
    isBlockedNow: Boolean(s.isBlockedNow),
    nextPhaseAt: typeof s.nextPhaseAt === 'number' ? s.nextPhaseAt : -1,
    cutoverAt: typeof s.cutoverAt === 'number' ? s.cutoverAt : -1,
    queueSize: typeof s.queueSize === 'number' ? s.queueSize : 0,
    refreshedAt: typeof s.refreshedAt === 'number' ? s.refreshedAt : Date.now(),
  }
}

/**
 * Read the live state and keep the snapshot fresh. One poll cycle every
 * 2 s is the only background work; the in-flight guard is a single
 * boolean ref so a slow fetch never piles up overlapping requests.
 *
 * Error policy: transient errors (network blips, harness restart) are
 * invisible to the user. The hook retries on the next interval and the
 * previous good `state` keeps rendering. A failure that lasts for the
 * whole 2 s cadence surfaces as a console warning for diagnostics, not
 * as a UI flag. The user only sees something when there is no
 * successful value yet (`state === null`, `loading === true`).
 */
export function usePeakHoursState(): PeakHoursStateHook {
  const [state, setState] = useState<PeakHoursState | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const inflightRef = useRef<boolean>(false)
  // A ref to the current state so `toggle()` can read the latest value
  // without re-creating the callback on every render.
  const stateRef = useRef<PeakHoursState | null>(null)
  stateRef.current = state

  const fetchOnce = useCallback(async (): Promise<void> => {
    if (inflightRef.current) return
    inflightRef.current = true
    try {
      const res = await fetch(STATE_ENDPOINT, { method: 'GET', headers: { accept: 'application/json' } })
      const raw: unknown = await res.json()
      if (!isStateJson(raw)) {
        console.warn('ui-peak-hours: state endpoint returned a non-state envelope; keeping previous snapshot')
        return
      }
      const next = readState(raw)
      if (next === null) {
        // `ok: false` is a host-side availability problem, not a wire problem.
        console.warn('ui-peak-hours: state endpoint returned ok:false; keeping previous snapshot')
        return
      }
      setState(next)
    } catch (err) {
      // Network blip or harness restart. The previous snapshot is still
      // good; the next 2-s tick will try again. Log only — no UI.
      console.warn('ui-peak-hours: state poll failed; keeping previous snapshot', err)
    } finally {
      inflightRef.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchOnce()
    const id = setInterval(() => { void fetchOnce() }, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchOnce])

  const setPaused = useCallback(async (value: boolean): Promise<void> => {
    // Optimistic update so the pill reflects the click before the round-trip.
    const prev = stateRef.current
    if (prev !== null) {
      setState({
        ...prev,
        isPaused: value,
        // The host recomputes isBlockedNow on the next tick; until then,
        // recompute locally so the visual state is right.
        isBlockedNow: value && prev.phase === 'peak' && !prev.preLaunch,
      })
    }
    try {
      const res = await fetch(STATE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused: value }),
      })
      // Body is small enough that the response is always under POST_BODY_BYTE_LIMIT.
      const raw: unknown = await res.json()
      if (!isStateJson(raw)) {
        console.warn('ui-peak-hours: state POST returned a non-state envelope; rolling back')
        if (prev !== null) setState(prev)
        return
      }
      const next = readState(raw)
      if (next === null) {
        console.warn('ui-peak-hours: state POST returned ok:false; rolling back')
        if (prev !== null) setState(prev)
        return
      }
      setState(next)
    } catch (err) {
      // Roll back the optimistic flip and log. The user keeps the
      // pre-click state visually; the next 2-s poll will reconcile.
      console.warn('ui-peak-hours: state POST failed; rolling back', err)
      if (prev !== null) setState(prev)
    }
  }, [])

  const toggle = useCallback(async (): Promise<void> => {
    const current = stateRef.current
    if (current === null) return
    await setPaused(!current.isPaused)
  }, [setPaused])

  return { state, loading, setPaused, toggle }
}

// Expose the byte limit for tests / parity checks against the host.
export const STATE_POST_BODY_BYTE_LIMIT = POST_BODY_BYTE_LIMIT
