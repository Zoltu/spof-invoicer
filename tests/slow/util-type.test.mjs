/** The slow half of the util suite: the `DomAttributes` src sink's compile-time refusal, pinned by compiling one probe under the project's own `tsc` and tsconfig. */

import { test } from "node:test";
import { runTypeProbe } from "../helpers/type-probe.mjs";

test("DomAttributes refuses an src on a widened or union-typed tag at compile time, and admits it on an img", () => {
	// The probe carries a `@ts-expect-error` on the union-typed tag and on a spread that smuggles a plain string into `src`, so a `tsc` run exits zero only while both lines are compile errors and the `<img>` call site still compiles.
	runTypeProbe({
		prefix: "invoice-type-probe-",
		fileName: "dom-src.ts",
		failureMessage: "the type probe must compile cleanly under the project's own configuration, so an src is a compile error on a union-typed tag and on a spread, and still admitted on an img",
		source: (specifier) => `/** The compile-time probe for the DomAttributes src sink, compiled by tests/slow/util-type.test.mjs under the project's own tsconfig. */
import { h } from "${specifier("app/ts/util/dom.js")}";
import { svgDataUrl } from "${specifier("app/ts/util/svg-data-url.js")}";

const url = svgDataUrl(\`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>\`);

declare const widenedTag: keyof HTMLElementTagNameMap;
// @ts-expect-error an src on a union-typed tag is a compile error, not only a runtime refusal
h(widenedTag, { src: url });

h("img", { src: url, alt: "" });

// @ts-expect-error a spread that smuggles a plain string into src is a compile error, so the brand holds at the spread too
h("img", { ...{ src: "logo.svg" } });
`,
	});
});
