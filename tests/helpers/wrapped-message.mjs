/**
 * The wrap `app/ts/invoice/model.ts` puts on another module's validator message before it carries it, which is the message the create form then shows.
 *
 * The address suites reproduce that wrap to pin the refusal a user pasting a long address actually reads; it mirrors the module-local `WRAPPED_MESSAGE_MAX` they cannot import.
 * The create form's own clip is the looser `FIELD_MESSAGE_MAX` (300), so it never binds for a message the model already wrapped.
 */

export const WRAPPED_MESSAGE_MAX = 200;
