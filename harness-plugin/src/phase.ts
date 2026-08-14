/**
 * Pure peak/off-peak status logic. Single source of truth for the schedule,
 * shared by the host face (state endpoint, LLM hook) and the browser face
 * (pill colour, countdown). Mirrors the authoritative schedule published at
 * https://api-docs.deepseek.com/quick_start/pricing/.
 *
 * Peak hours (UTC): 01:00–04:00 and 06:00–10:00. All other hours are
 * off-peak. Pricing split takes effect at 16:00 UTC on 2026-08-16; before
 * that moment the API bills at a single flat rate, so the widget labels
 * that window "FLAT" and counts down to the cutover.
 *
 * No I/O, no React, no DOM, no platform types. Host and browser import the
 * same numbers; if the schedule changes, both faces move together.
 */

const PEAK_WINDOWS_UTC = [
  { startH: 1, endH: 4 },  // 09:00–12:00 CST
  { startH: 6, endH: 10 }, // 14:00–18:00 CST
] as const

export const CUTOVER_UTC = Date.UTC(2026, 7, 16, 16, 0, 0) // Aug 16, 2026 16:00 UTC
const HOUR_MS = 3600 * 1000

export type Phase = 'peak' | 'off'

export interface PhaseSnapshot {
  readonly phase: Phase
  readonly preLaunch: boolean
  readonly nextBoundaryUtc: Date
  readonly nextLabel: string
  readonly minutesToNext: number
  readonly nowUtc: Date
}

export function currentPhase(nowUtc: Date): PhaseSnapshot {
  const h = nowUtc.getUTCHours() + nowUtc.getUTCMinutes() / 60
  let inPeak = false
  for (const w of PEAK_WINDOWS_UTC) {
    if (h >= w.startH && h < w.endH) { inPeak = true; break }
  }
  const startOfDay = Date.UTC(
    nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), 0, 0, 0,
  )
  const boundaries: { t: number; phase: Phase }[] = []
  for (const w of PEAK_WINDOWS_UTC) {
    boundaries.push({ t: startOfDay + w.startH * HOUR_MS, phase: 'peak' })
    boundaries.push({ t: startOfDay + w.endH * HOUR_MS, phase: 'off' })
  }
  const t0 = nowUtc.getTime()
  const preLaunch = t0 < CUTOVER_UTC

  // While pre-cutover, point the next-phase countdown at the cutover itself
  // (the moment peak/off-peak pricing takes effect) so the user always sees
  // an actionable "next thing" rather than a generic counter.
  let next: { t: number; phase: Phase; label: string }
  if (preLaunch) {
    next = { t: CUTOVER_UTC, phase: 'peak', label: 'cutover to live' }
  } else {
    const todayNext = boundaries.find(b => b.t > t0)
    if (todayNext) {
      next = { t: todayNext.t, phase: todayNext.phase, label: todayNext.phase === 'peak' ? 'PEAK' : 'OFF-PEAK' }
    } else {
      next = {
        t: startOfDay + 24 * HOUR_MS + PEAK_WINDOWS_UTC[0].startH * HOUR_MS,
        phase: 'peak',
        label: 'PEAK',
      }
    }
  }
  return {
    phase: inPeak ? 'peak' : 'off',
    preLaunch,
    nextBoundaryUtc: new Date(next.t),
    nextLabel: next.label,
    minutesToNext: Math.max(0, Math.floor((next.t - t0) / 60000)),
    nowUtc,
  }
}

export function phaseLabel(phase: Phase): string {
  return phase === 'peak' ? 'PEAK' : 'OFF-PEAK'
}
