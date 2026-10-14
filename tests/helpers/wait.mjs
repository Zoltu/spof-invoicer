/**
 * Test helper: wait for a deferred callback to take effect.
 * Polls `predicate` on a `setTimeout` loop so the code under test gets its macrotask turn; `attempts` bounds the wait so a predicate that never becomes true fails the following assertion instead of hanging the suite.
 */

const POLL_INTERVAL_MS = 10;

/** Resolve once `predicate()` is true, or after `attempts` polls at {@link POLL_INTERVAL_MS} apart. */
export function waitFor(predicate, attempts = 200) {
	return new Promise((resolve) => {
		let remaining = attempts;
		const poll = () => {
			if (predicate() || remaining <= 0) {
				resolve();
				return;
			}
			remaining -= 1;
			setTimeout(poll, POLL_INTERVAL_MS);
		};
		poll();
	});
}

/** Yield one macrotask turn, so a deferred callback — the file read behind a change handler — has run before the following assertion. */
export function nextTask() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
