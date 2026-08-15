/**
 * Browser-side re-export of the shared phase schedule. The single source of
 * truth lives in `../phase.ts`; this file exists so the browser tree
 * continues to import from `./domain.ts` and to keep the `formatCountdown`
 * formatter (purely a render concern that no other face needs).
 *
 * Pure peak/off-peak status logic, browser-clock edition. Mirrors the
 * authoritative schedule published at
 * https://api-docs.deepseek.com/quick_start/pricing/.
 *
 * Peak hours (UTC): 01:00–04:00 and 06:00–10:00. All other hours are
 * off-peak. Pricing split takes effect at 16:00 UTC on 2026-08-16; before
 * that moment the API bills at a single flat rate, so the widget labels
 * that window "FLAT" and counts down to the cutover.
 *
 * No I/O, no React, no DOM. Tested by the time math in the standalone
 * widget's smoke run; this copy must agree with that copy exactly.
 */

export {
  CUTOVER_UTC,
  currentPhase,
  isPeak,
  phaseLabel,
  type Phase,
  type PhaseSnapshot,
} from '../phase.ts'

export function formatCountdown(minutes: number): string {
  const hh = Math.floor(minutes / 60)
  const mm = minutes % 60
  return `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m`
}
