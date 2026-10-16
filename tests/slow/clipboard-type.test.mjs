/** The slow half of the clipboard suite: the copy seam's status contract, pinned by compiling one probe under the project's own `tsc` and tsconfig. */

import { test } from "node:test";
import { runTypeProbe } from "../helpers/type-probe.mjs";

test("the copy seam's status contract is the members it reads, so a plain object reports in it and one without text does not", () => {
	// The seam writes the confirmation into the status's text and reads whether it is still mounted, so those two members are the whole contract; the probe pins a plain object's acceptance and refuses one that cannot carry the text, where a parameter typed as an element would state a contract neither the guard nor the tests hold.
	runTypeProbe({
		prefix: "invoice-clipboard-status-probe-",
		fileName: "clipboard-status.ts",
		failureMessage: "the type probe must compile cleanly under the project's own configuration, so a plain object is accepted as the copy seam's status while one that cannot carry the confirmation's text is refused",
		source: (specifier) => `/** The compile-time probe for the copy seam's status contract, compiled by tests/slow/clipboard-type.test.mjs under the project's own tsconfig. */
import { copyWithFallback, type CopyStatus } from "${specifier("app/ts/ui/clipboard.js")}";
import { copyControlClick } from "${specifier("app/ts/ui/payment-section.js")}";

declare const value: HTMLElement;

const status: CopyStatus = { textContent: "" };
const detached: CopyStatus = { textContent: "", isConnected: false };

copyWithFallback("zcash:u1example", null, value, status);
copyControlClick("zcash:u1example", null, value, detached, { after: () => () => {} });

// @ts-expect-error a status that cannot carry the confirmation's text is not one this seam writes into
const silent: CopyStatus = { isConnected: true };
`,
	});
});
