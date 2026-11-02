/**
 * The UI's shared bounds, stated once so two surfaces cannot drift.
 *
 * A bound that more than one surface applies lives here rather than in either of them, so a change to the bound changes every surface that shows a clipped message at once.
 */

/**
 * Upper bound on a field or summary error's rendered length, matching the shell notice's own bound.
 *
 * A model message can embed the rejected value, so the same defensive clip the notice applies is applied here before any error reaches the DOM.
 */
export const FIELD_MESSAGE_MAX = 300;
