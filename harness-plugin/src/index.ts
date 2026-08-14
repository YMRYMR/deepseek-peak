/**
 * Peak/Off-peak surface plugin, node half. The browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration.
 *
 * The host face has no work to do: the widget reads the browser clock
 * directly and never asks the host for a peak-status snapshot. A Cordis
 * service that is never read is, by the runtime invariants, the right kind
 * of empty — this is the platform-owned leave-it-alone case.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
