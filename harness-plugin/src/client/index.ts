/**
 * Peak/Off-peak surface plugin, browser half. Registers a compact status
 * pill in the session header's right-aligned utilities row, so the user
 * always sees the current pricing band right next to the Session log
 * button. The widget reads the browser clock directly; the host plane
 * has nothing to compute.
 *
 * The pill itself is a leaf that knows nothing about hover; this index
 * mounts it inside a `PeakHoursHost` which adds the on-hover overlay
 * (per-model daily token usage + the platform's `/user/balance`).
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pull the SlotMap merge for the session header utilities row
// so this plugin's contribution type-checks against the conversation
// header's children.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PeakHoursHost } from './PeakHoursHost.tsx'
import { aggregateUsage } from './usage.ts'

/** Services the registration reads at apply time. */
export const inject = ['slots', 'sessions']

/**
 * Browser plugin body. Injects the PeakHoursHost into the session header
 * utilities row. Order -10 puts the pill LEFT of the Session log button
 * (which uses the default order, treated as 0). Lower = earlier in the
 * right-aligned flex row.
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'peak-hours',
    // order: -10 puts the pill LEFT of the Session log button (which uses
    // the default order, treated as 0). Lower = earlier in the flex row.
    order: -10,
    // The host needs two closures: the aggregation function and a
    // subscription to the sessions list. We pass them through the inject
    // factory so the host can re-aggregate when the underlying data
    // changes without holding a reference to the cordis ctx itself.
    inject: () => ({
      hooks: { peakHours: { version: () => Date.now() } },
      aggregate: (rangeDays: number) => aggregateUsage(ctx, rangeDays),
      subscribeSessions: (listener: () => void) => ctx.sessions.list.subscribe(listener),
    }),
  }, PeakHoursHost))
}
