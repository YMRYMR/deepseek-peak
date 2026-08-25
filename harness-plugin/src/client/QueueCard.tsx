/**
 * QueueCard: a sibling card to the chart card, only rendered when the
 * host has at least one queued message. Each row is one line of the
 * user's prompt (truncated with an ellipsis if the line would
 * overflow); the full text lives in the row's `title` attribute for a
 * hover tooltip. The list is capped visually at 10 lines, with a
 * vertical scrollbar when the queue is longer.
 *
 * Aesthetic: matches the chart card exactly (same `--dsw-color-*`
 * peak/off-peak token, same opaque base, same dashed pre-cutover
 * border) so the two cards read as one surface. The className is
 * derived from the same `card` / `cardPeak` / `cardOff` /
 * `cardPreLaunch` recipe; queue-specific layout lives in
 * `QueueCard.module.css`.
 */

import type { QueueItemView } from './peakHoursState.ts'
import type { Phase } from './domain.ts'
import cardCss from './UsageTooltip.module.css'
import css from './QueueCard.module.css'

/** 10 lines of body text at the card's 11px font-size + 1.35
 *  line-height, plus a touch of padding. Capping the height here
 *  gives the card a stable footprint when the queue grows; the
 *  list scrolls inside. */
const QUEUE_MAX_HEIGHT_PX = 160

export interface QueueCardProps {
  readonly items: readonly QueueItemView[]
  /** Items not in `items` because of the host's wire cap. Shown as a
   *  small "+N more queued" footer when > 0. */
  readonly overflow: number
  readonly phase: Phase
  readonly preLaunch: boolean
  /** Per-row override: a `send` arrow on the front item releases
   *  it through the host's `POST /api/peak-hours/queue/dispatch`
   *  endpoint, bypassing the pause switch. The button only renders
   *  on the front item (FIFO dispatch); later items get a disabled
   *  arrow so the layout stays uniform but the affordance is
   *  honest. */
  readonly onDispatch?: (enqueuedAt: number) => void
}

export function QueueCard(props: QueueCardProps) {
  const { items, overflow, phase, preLaunch, onDispatch } = props

  const cardClass = [
    cardCss.card,
    phase === 'peak' ? cardCss.cardPeak : cardCss.cardOff,
    preLaunch ? cardCss.cardPreLaunch : '',
  ].filter(Boolean).join(' ')

  if (items.length === 0 && overflow === 0) return null

  return (
    <div className={`${cardClass} ${css.queueCard}`} role="status" data-state="queue" data-queue-size={items.length + overflow}>
      <header className={css.queueHeader}>
        <span className={css.queueLabel}>QUEUE</span>
        <span className={css.queueCount}>
          {items.length + overflow}
          {overflow > 0 && (
            <span className={css.queueOverflow} title={`${overflow} additional item(s) not shown; queue cap is 100 per response`}>
              {' '}(+{overflow} more)
            </span>
          )}
        </span>
      </header>
      {items.length > 0 && (
        <ul
          className={css.queueList}
          style={{ maxHeight: `${QUEUE_MAX_HEIGHT_PX}px` }}
          aria-label={`${items.length} queued message${items.length === 1 ? '' : 's'}`}
        >
          {items.map((item, idx) => {
            // The first line is the headline; if the user pasted a
            // multi-line message, collapse the rest to a single line
            // so the row stays a single visual line and the full
            // text lives in the `title` attribute for hover.
            const headline = firstLine(item.prompt)
            const isFront = idx === 0
            const decisionTitle = item.matched === undefined
              ? item.decisionReason
              : `${item.decisionReason} (matched: ${item.matched})`
            // Only the front item gets a live send button. Later
            // items render a ghost arrow (the row's layout is
            // uniform, but the disabled cursor / no-click target
            // tells the user those would dispatch out of order).
            const arrowClass = isFront ? css.queueItemArrow : `${css.queueItemArrow} ${css.queueItemArrowDisabled}`
            const arrowTitle = isFront
              ? 'Send this message now (without deactivating the pause switch)'
              : 'Only the front item can be sent; later items dispatch in order'
            return (
              <li
                key={`${item.enqueuedAt}-${idx}`}
                className={css.queueItem}
                title={item.prompt}
              >
                <span className={css.queueItemText}>
                  {headline || <span className={css.queueItemEmpty}>(empty message)</span>}
                </span>
                <span
                  className={css.queueItemDecision}
                  title={decisionTitle}
                  data-decision-source={item.decisionSource}
                >
                  DEFER
                </span>
                {onDispatch !== undefined && (
                  <button
                    type="button"
                    className={arrowClass}
                    onClick={isFront ? () => { onDispatch(item.enqueuedAt) } : undefined}
                    title={arrowTitle}
                    aria-label={isFront ? 'Send queued message' : 'Send not available for non-front items'}
                    disabled={!isFront}
                    data-queue-enqueued-at={item.enqueuedAt}
                  >
                    <svg
                      viewBox="0 0 12 12"
                      width="10"
                      height="10"
                      aria-hidden="true"
                      focusable="false"
                    >
                      {/* Right-pointing arrow; the "send" affordance
                       * for the row. The same `currentColor` as the
                       * card means it inherits the peak/off-peak
                       * tint and pre-cutover opacity without an
                       * extra color rule. */}
                      <path
                        d="M1.5 6 L9 6 M6.5 3.5 L9 6 L6.5 8.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** Strip the prompt to its first line for the row's visible text.
 *  The full text (multi-line included) lives in the row's `title`
 *  attribute and is shown on hover. */
function firstLine(text: string): string {
  if (text.length === 0) return ''
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}
