/**
 * Peak/Off-peak surface plugin, browser half. Registers a compact status
 * pill in the session header's right-aligned utilities row, so the user
 * always sees the current pricing band right next to the Session log
 * button. The widget reads the browser clock directly; the host plane
 * has nothing to compute.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pull the SlotMap merge for the session header utilities row
// so this plugin's contribution type-checks against the conversation
// header's children.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PeakHoursPill } from './PeakHoursPill.tsx'

/** Services the registration reads at apply time. */
export const inject = ['slots']

/**
 * Browser plugin body. Injects the PeakHoursPill into the session header
 * utilities row. Order 5 sits to the LEFT of higher-order utilities (the
 * Session log button is order 50) so the peak status appears first in the
 * right-aligned row, just left of the Session log button.
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
  }, PeakHoursPill))
}
