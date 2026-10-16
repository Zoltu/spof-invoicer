/** The slow half of the icon suite: the canonical-icon-text brand's compile-time refusal, pinned by compiling one probe under the project's own `tsc` and tsconfig. */

import { test } from "node:test";
import { runTypeProbe } from "../helpers/type-probe.mjs";

test("the canonical-icon-text brand refuses a raw spelling to the measurement at compile time", () => {
	// The brand's promise is a compile error, not only a comment, so the probe carries a `@ts-expect-error` on a raw string handed to `iconByteLength` beside two calls that must compile: the canonicalizer's own result, and the gate's return value.
	// Widening the measurement's parameter back to `string` consumes that expectation and fails the compile, and so does a `validateIcon` whose declared return type drops the brand it already produced.
	runTypeProbe({
		prefix: "invoice-icon-brand-probe-",
		fileName: "icon-brand.ts",
		failureMessage: "the type probe must compile cleanly under the project's own configuration, so a raw spelling handed to the measurement is a compile error while the canonicalizer's result and the gate's own return value measure without a cast",
		source: (specifier) => `/** The compile-time probe for the canonical-icon-text brand, compiled by tests/slow/icon-type.test.mjs under the project's own tsconfig. */
import { validateIcon } from "${specifier("app/ts/invoice/icon.js")}";
import { canonicalIconText } from "${specifier("app/ts/util/icon-canonical-text.js")}";
import { iconByteLength } from "${specifier("app/ts/util/icon-byte-length.js")}";

const svg = "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"64\\" height=\\"64\\"></svg>";

iconByteLength(canonicalIconText(svg));
iconByteLength(validateIcon(svg));

// @ts-expect-error a raw spelling handed to the measurement is a compile error, so a parameter widened back to string would consume this expectation and fail the compile
iconByteLength(svg);
`,
	});
});
