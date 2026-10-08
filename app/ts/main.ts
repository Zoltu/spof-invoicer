/**
 * The page entry point: the one module `app/index.html` loads, as a native ES module.
 *
 * It reads three things from the environment and hands them to {@link bootApp}: the `#app` mount point, the page URL as the base for share links, and the platform clipboard when the page exposes one.
 * The mount point is required — a document without `#app` is a broken page, so its absence throws rather than booting into nothing — while `location` and `navigator` are read defensively so the module also loads where they are absent.
 */

import { bootApp } from "./app/shell.js";

const root = document.getElementById("app");

if (root === null) {
	throw new Error("main: index.html is missing the #app mount point");
}

bootApp(root, {
	baseUrl: typeof location === "undefined" ? "" : location.href,
	clipboard: typeof navigator === "undefined" ? null : (navigator.clipboard ?? null),
});
