/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-peak-hours`.
 * @module @deepseek-ai/dsh-client-ui-peak-hours/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-peak-hours'

/** Cordis companion plugin name. */
export const name = 'client-ui-peak-hours-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the dock widget is a single React component whose
 * state is purely local (`useState` + a 1 Hz `setInterval`), the package
 * owns no store, emits no cordis events, and holds no cross-plugin
 * mutable state. The browser clock is trusted against the authoritative
 * UTC windows baked into `domain.ts`; no host round-trip exists for the
 * invariants service to police.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
