/**
 * The refusal-message probe the address suites share: the message a validator's refusal carries.
 *
 * `assert.throws` matches a message by pattern, but these suites also compare a whole message against an expectation they build, so this probe returns the caught message itself through the project's own `messageOf`.
 */

import { messageOf } from "../../app/js/util/errors.js";

/** The message a refusal raised by `run` carries; `run` failing to refuse at all is an error, so a case that expects a refusal cannot pass silently. */
export function refusalMessage(run) {
	return messageOf(refusalError(run));
}

/**
 * The error a refusal raised by `run` carries, for a case that asserts something about the error itself — the class of its `cause`, say — rather than about its message.
 * `run` failing to refuse at all is an error here too, so a case that expects a refusal cannot pass silently.
 */
export function refusalError(run) {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the value to be refused");
}
