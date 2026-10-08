/** The suite for the build output: that `main.ts` emits `main.js` with a source map back to `app/ts/`, that `index.html` loads it as a module, and that it boots the shell. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installInteractiveDocument } from "./helpers/dom.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const jsDir = join(appDir, "js");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

test("compiles app/ts/main.ts to app/js/main.js with a source map back to ts/", () => {
	const compiled = readFileSync(join(jsDir, "main.js"), "utf8");
	assert.match(compiled, /document\.getElementById/);

	const map = readJson(join(jsDir, "main.js.map"));
	assert.equal(map.version, 3);
	assert.equal(map.file, "main.js");
	assert.deepEqual(map.sources, ["../ts/main.ts"]);
	assert.equal(map.sourcesContent.length, 1);
	assert.match(map.sourcesContent[0], /index\.html is missing the #app mount point/);
});

test("index.html loads the compiled entry point as a native ES module", () => {
	const html = readFileSync(join(appDir, "index.html"), "utf8");
	assert.match(html, /<script type="module" src="js\/main\.js"><\/script>/);
	assert.match(html, /<div id="app">/);
});

test("the compiled entry boots the app shell against a minimal document", async () => {
	const fake = installInteractiveDocument();
	const mounted = document.createElement("div");
	document.getElementById = (id) => (id === "app" ? mounted : null);

	try {
		await import(`${pathToFileURL(join(jsDir, "main.js")).href}?boot=1`);
		assert.equal(mounted.children.length, 1, "main.js mounted the shell into #app");
		const layout = mounted.children[0];
		assert.equal(layout.tagName, "div");
		assert.equal(layout.children[0].children[0].textContent, "Invoicing", "the header brand rendered");
		assert.equal(
			layout.children[2].children[0].children[0].textContent,
			"Create an invoice",
			"the default route is the create view",
		);
	} finally {
		fake.restore();
	}
});
