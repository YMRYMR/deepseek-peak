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

/** One item in the queue card. Mirrors the host's `QueueItemWire`
 *  (capped at `QUEUE_WIRE_ITEM_CAP` items; the rest count toward
 *  `state.queueOverflow`). The card shows one line per item with
 *  the `prompt` truncated; the full text lives in the `title` for
 *  hover. */
export interface QueueItemView {
  readonly prompt: string
  readonly enqueuedAt: number
  readonly decision: 'run' | 'defer'
  readonly decisionSource: 'explicit' | 'configured-keyword' | 'incident' | 'deadline' | 'routine' | 'default'
  readonly decisionReason: string
  readonly matched?: string
}

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
  /** Per-message payload for the queue card (capped; see `queueOverflow`). */
  readonly queue: readonly QueueItemView[]
  /** Count of items not in `queue` because of the wire cap. */
  readonly queueOverflow: number
  /** Whether peak-hour admission classifies each task or queues all calls. */
  readonly schedulingMode: 'smart' | 'queue-all'
  /** Fallback used by smart mode for an ambiguous prompt. */
  readonly unknownTaskPolicy: 'run' | 'defer'
  /** Dollar amount below which the pill switches to its warning style.
   *  Mirrors the host's persisted `lowBalanceWarningUsd` setting.
   *  The browser never persists or recomputes this; it just reads
   *  the latest value on each 2 s state poll. */
  readonly lowBalanceWarningUsd: number
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
  /** Manually release the front queued item; the pause toggle is
   *  not changed. The card's "send" button calls this. */
  readonly dispatchQueueItem: (enqueuedAt: number) => Promise<void>
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
  // Queue items: defensive parse. The host sends a `queue` array of
  // `{ prompt, enqueuedAt }`; the parser rebuilds the typed view and
  // silently drops any item that doesn't match (the card would
  // rather show one less row than crash on a shape drift).
  const queue: QueueItemView[] = []
  const rawQueue = s.queue
  if (Array.isArray(rawQueue)) {
    for (const raw of rawQueue) {
      if (raw === null || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const prompt = typeof item.prompt === 'string' ? item.prompt : ''
      const enqueuedAt = typeof item.enqueuedAt === 'number' ? item.enqueuedAt : Date.now()
      const decision = item.decision === 'run' ? 'run' : 'defer'
      const rawSource = item.decisionSource
      const decisionSource = rawSource === 'explicit'
        || rawSource === 'configured-keyword'
        || rawSource === 'incident'
        || rawSource === 'deadline'
        || rawSource === 'routine'
        ? rawSource
        : 'default'
      const decisionReason = typeof item.decisionReason === 'string'
        ? item.decisionReason
        : 'deferred until off-peak'
      const matched = typeof item.matched === 'string' ? item.matched : undefined
      queue.push({
        prompt,
        enqueuedAt,
        decision,
        decisionSource,
        decisionReason,
        ...matched === undefined ? {} : { matched },
      })
    }
  }
  return {
    isPaused: Boolean(s.isPaused),
    phase: s.phase === 'peak' ? 'peak' : 'off',
    preLaunch: Boolean(s.preLaunch),
    isBlockedNow: Boolean(s.isBlockedNow),
    nextPhaseAt: typeof s.nextPhaseAt === 'number' ? s.nextPhaseAt : -1,
    cutoverAt: typeof s.cutoverAt === 'number' ? s.cutoverAt : -1,
    queueSize: typeof s.queueSize === 'number' ? s.queueSize : 0,
    queue,
    queueOverflow: typeof s.queueOverflow === 'number' ? s.queueOverflow : 0,
    schedulingMode: s.schedulingMode === 'smart' ? 'smart' : 'queue-all',
    unknownTaskPolicy: s.unknownTaskPolicy === 'run' ? 'run' : 'defer',
    // `lowBalanceWarningUsd` is a 0-or-positive USD amount. Coerce
    // non-numbers and negatives to the conservative default of $1
    // rather than NaN/negative — the comparison is `balance < threshold`
    // and a junk threshold would either false-warn or false-quiet.
    lowBalanceWarningUsd: (() => {
      const raw = s.lowBalanceWarningUsd
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 1.0
      return raw
    })(),
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

  /**
   * Manually release the front queued item via the host's
   * `POST /api/peak-hours/queue/dispatch`. The pause toggle stays
   * as-is; this is an explicit per-row override, not a state
   * change. The card's "send" button calls this with the item's
   * `enqueuedAt`. The host returns either the dispatched item
   * (success), `not-found` (item is no longer queued, e.g. it
   * drained naturally a moment ago), or `not-front` (item was
   * behind another item, which is a race the card handles by
   * refreshing its snapshot). Errors are surfaced as console
   * warnings so the user-visible card state stays clean.
   */
  const dispatchQueueItem = useCallback(async (enqueuedAt: number): Promise<void> => {
    try {
      const res = await fetch(DISPATCH_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enqueuedAt }),
      })
      const raw: unknown = await res.json()
      if (typeof raw !== 'object' || raw === null) {
        console.warn('ui-peak-hours: dispatch returned a non-object envelope')
        return
      }
      const env = raw as Record<string, unknown>
      if (env.ok === true) {
        // Success: optimistically reflect the dispatch in the local
        // snapshot so the row disappears immediately. The 2 s poll
        // will reconcile any drift.
        const prev = stateRef.current
        if (prev !== null) {
          const nextQueue = prev.queue.filter(it => it.enqueuedAt !== enqueuedAt)
          const nextSize = Math.max(0, prev.queueSize - 1)
          const nextOverflow = prev.queueSize > nextQueue.length
            ? Math.max(0, prev.queueOverflow)
            : prev.queueOverflow
          setState({ ...prev, queue: nextQueue, queueSize: nextSize, queueOverflow: nextOverflow })
        }
        return
      }
      // ok: false: the host returned a structured error. Surface it
      // in the console; the card UI keeps the row visible (the
      // next poll will reconcile if the item drained naturally).
      const err = (env as { error?: { kind?: string; message?: string } }).error
      const kind = err?.kind ?? 'unknown'
      const message = err?.message ?? 'no message'
      console.warn(`ui-peak-hours: dispatch failed (${kind}): ${message}`)
    } catch (err) {
      console.warn('ui-peak-hours: dispatch POST failed', err)
    }
  }, [])

  return { state, loading, setPaused, toggle, dispatchQueueItem }
}

const DISPATCH_ENDPOINT = '/api/peak-hours/queue/dispatch'

// Expose the byte limit for tests / parity checks against the host.
export const STATE_POST_BODY_BYTE_LIMIT = POST_BODY_BYTE_LIMIT
