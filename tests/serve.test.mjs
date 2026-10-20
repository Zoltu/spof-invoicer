/** The suite for `serve.mjs`: the static server's path confinement, the content type each file is served with, the `cache-control` and `x-content-type-options` headers it sends, the framing directives it omits, and the loopback bind with its cautions. */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStaticServer, hostCaution, parseServeArgs, serveCaution } from "../serve.mjs";
import { codeOnly } from "./helpers/code-only.mjs";
import { SERVED_BUNDLES } from "./helpers/vendor-bundles.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function listen() {
	const server = createStaticServer({ hostname: "127.0.0.1", port: 0 });
	return {
		origin: `http://127.0.0.1:${server.port}`,
		close: () => server.stop(true),
	};
}

async function get(origin, path) {
	const response = await fetch(origin + path);
	return { status: response.status, headers: response.headers, body: await response.text() };
}

function assertRefused(response, path) {
	assert.ok(
		response.status === 404 || response.status === 403,
		`${path} must be refused, got ${response.status}`,
	);
}

test("serves app/ with content types a browser can run", async () => {
	const server = listen();
	try {
		const page = await get(server.origin, "/");
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-type"), /^text\/html/);
		assert.match(page.body, /<script type="module" src="js\/main\.js">/);

		const script = await get(server.origin, "/js/main.js");
		assert.equal(script.status, 200);
		assert.match(script.headers.get("content-type"), /^text\/javascript/);
		assert.match(script.body, /getElementById/);

		const stylesheet = await get(server.origin, "/stylesheets/app.css");
		assert.equal(stylesheet.status, 200);
		assert.match(stylesheet.headers.get("content-type"), /^text\/css/);
	} finally {
		await server.close();
	}
});

test("never serves a file outside app/", async () => {
	const server = listen();
	try {
		// The WHATWG URL parser rewrites bare `%2e%2e` dot segments before the request is sent, so `/%2e%2e/package.json` arrives as `/package.json` and only proves `app/` lacks that file.
		// An encoded slash keeps the `..` inside a single path segment through parsing, and the handler's `decodeURIComponent` turns it back into a real `..` — the path that reaches the containment guard.
		// Each target below decodes to a file that genuinely exists outside `app/`.
		const escapes = [
			"/..%2fpackage.json",
			"/..%2fserve.mjs",
			"/..%2fREADME.md",
			"/js/..%2f..%2fREADME.md",
			"/%2e%2e%2fpackage.json",
			"/%2E%2E%2Fpackage.json",
			"/%2e%2e%2f%2e%2e%2fetc/passwd",
		];
		const leaked = /invoicing-spa|Invoicing & Payment|createStaticServer|root:/;
		for (const path of escapes) {
			const response = await get(server.origin, path);
			assertRefused(response, path);
			assert.ok(!leaked.test(response.body), `${path} leaked file content outside app/`);
		}
	} finally {
		await server.close();
	}
});

test("never serves a symlink from app/ to a file outside it", async () => {
	// A symlink inside the served root must be resolved and rejected.
	// The scratch root keeps the symlink out of the committed app/ tree, which the acceptance gate requires to match a fresh build byte for byte.
	const scratch = await mkdtemp(join(tmpdir(), "serve-root-"));
	const servedRoot = join(scratch, "app");
	const secret = "outside-root-secret-9f2c1a";
	try {
		await mkdir(servedRoot, { recursive: true });
		await writeFile(join(servedRoot, "index.html"), "<!doctype html><title>inside-root</title>\n");
		await writeFile(join(scratch, "secret.txt"), `${secret}\n`);
		await writeFile(join(scratch, "serve.mjs"), await readFile(join(root, "serve.mjs")));
		await symlink(join(scratch, "secret.txt"), join(servedRoot, "escape.txt"));

		const module = await import(pathToFileURL(join(scratch, "serve.mjs")).href);
		const server = module.createStaticServer({ hostname: "127.0.0.1", port: 0 });
		const origin = `http://127.0.0.1:${server.port}`;
		try {
			const inside = await get(origin, "/");
			assert.equal(inside.status, 200, "a normal in-root file must still be served");
			assert.match(inside.body, /inside-root/);

			const direct = await get(origin, "/escape.txt");
			assertRefused(direct, "/escape.txt");
			assert.ok(!direct.body.includes(secret), "/escape.txt leaked the symlink target");

			const traversed = await get(origin, "/..%2fsecret.txt");
			assertRefused(traversed, "/..%2fsecret.txt");
			assert.ok(!traversed.body.includes(secret), "/..%2fsecret.txt leaked the symlink target");
		} finally {
			server.stop(true);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

test("returns 404 for unknown paths and directories without an index", async () => {
	const server = listen();
	try {
		for (const path of ["/nope.html", "/images/", "/js/"]) {
			assert.equal((await get(server.origin, path)).status, 404, path);
		}
	} finally {
		await server.close();
	}
});

test("sends its policy as a header on the document, and no framing directive in either delivery, while keeping no-store and nosniff", async () => {
	const server = listen();
	try {
		const page = await get(server.origin, "/");
		assert.equal(page.status, 200);
		assert.equal(page.headers.get("x-frame-options"), null, "the page may be embedded by a wallet host");
		assert.doesNotMatch(String(page.headers.get("content-security-policy")), /frame-ancestors/, "and no frame-ancestors directive is set in its place");

		// The browser enforces the intersection of the header and the meta tag, so the header must state the meta tag's own directives and no others: a directive the meta tag carries and the header omits would narrow the page's policy on every served document, and the wallet workaround's `script-src-elem 'unsafe-inline'` would be the first casualty.
		const header = page.headers.get("content-security-policy");
		assert.ok(header !== null, "the served document carries the policy as a header as well as in its meta tag, so the policy does not ride on one delivery alone");
		const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(await readFile(join(root, "app/index.html"), "utf8"));
		assert.ok(meta !== null, "index.html states the policy in the meta tag this test reads");
		const directives = (policy) => policy.split(";").map((directive) => directive.trim()).filter((directive) => directive !== "").sort();
		assert.deepEqual(directives(header), directives(meta[1]), "the header states the meta tag's directives, directive for directive");
		// The deliveries state one directive list, and for this policy a browser enforces the same directives from both: it ignores `frame-ancestors`, `sandbox`, and `report-uri` in a policy it reads out of a meta tag, so neither delivery states one, and `require-trusted-types-for 'script'` is no part of what a meta delivery ignores — which is why the README and the design memo record the difference between engines rather than between deliveries.
		for (const directive of ["frame-ancestors", "sandbox", "report-uri"]) {
			assert.ok(!directives(header).includes(directive), `the header states no ${directive} directive, which a meta-delivered policy would ignore`);
			assert.ok(!directives(meta[1]).includes(directive), `nor does the meta tag state ${directive}, so the two deliveries agree on what neither states`);
		}
		assert.ok(directives(header).includes("require-trusted-types-for 'script'"), "the header states the directive that turns a DOM sink into a loud failure");
		assert.ok(directives(meta[1]).includes("require-trusted-types-for 'script'"), "and so does the meta tag, because a meta delivery ignores no part of that directive: the policy the payer gets does not depend on which delivery carried it");

		// What a document policy governs is what the browser parses as a document, which is the content type the server sends rather than the filename suffix a request happened to name: the logo a payer can navigate to on its own is an SVG document, and it carries the policy however its name ends.
		const svg = await get(server.origin, "/images/logo.svg");
		assert.equal(svg.status, 200);
		assert.equal(svg.headers.get("content-security-policy"), header, "an SVG under app/images/ is a document when a browser navigates to it, so it is delivered with the policy the served index.html is delivered with");

		const script = await get(server.origin, "/js/main.js");
		assert.equal(script.headers.get("content-security-policy"), null, "a script response carries no document policy, which is a document's own");
		for (const path of ["/stylesheets/app.css", "/js/vendor/noble-hashes/LICENSE"]) {
			const response = await get(server.origin, path);
			assert.equal(response.status, 200, path);
			assert.equal(response.headers.get("content-security-policy"), null, `${path} is no document a browser parses, so it carries no document policy either`);
		}

		assert.equal(page.headers.get("cache-control"), "no-store", "the served document is still never cached");
		assert.equal(page.headers.get("x-content-type-options"), "nosniff", "and is still not sniffed");
		assert.equal(page.body, await readFile(join(root, "app/index.html"), "utf8"), "the served body is still the file's own bytes");
	} finally {
		await server.close();
	}
});

test("attaches the document policy by the content type a browser parses as a document, not by a filename suffix", async () => {
	// The suffix a file carries is not what a browser dispatches on: a `.htm` page, an XHTML document, and an SVG navigated on its own are all parsed as documents, so a policy attached by the `.html` suffix alone would deliver every one of them with none.
	// The scratch root states those files without touching the committed app/ tree, which the acceptance gate requires to match a fresh build byte for byte.
	const scratch = await mkdtemp(join(tmpdir(), "serve-documents-"));
	const servedRoot = join(scratch, "app");
	try {
		await mkdir(join(servedRoot, "images"), { recursive: true });
		await writeFile(join(servedRoot, "index.html"), "<!doctype html><title>root</title>\n");
		await writeFile(join(servedRoot, "page.htm"), "<!doctype html><title>short suffix</title>\n");
		await writeFile(join(servedRoot, "page.xhtml"), '<html xmlns="http://www.w3.org/1999/xhtml"><title>xhtml</title></html>\n');
		await writeFile(join(servedRoot, "images/picture.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><title>picture</title></svg>\n');
		await writeFile(join(servedRoot, "notes.txt"), "plain text\n");
		await writeFile(join(scratch, "serve.mjs"), await readFile(join(root, "serve.mjs")));

		const module = await import(pathToFileURL(join(scratch, "serve.mjs")).href);
		const server = module.createStaticServer({ hostname: "127.0.0.1", port: 0 });
		const origin = `http://127.0.0.1:${server.port}`;
		try {
			const index = await get(origin, "/");
			assert.equal(index.status, 200);
			const policy = index.headers.get("content-security-policy");
			assert.ok(policy !== null, "the scratch tree's own index.html is delivered with the policy");

			for (const path of ["/page.htm", "/page.xhtml", "/images/picture.svg"]) {
				const response = await get(origin, path);
				assert.equal(response.status, 200, path);
				assert.equal(response.headers.get("content-security-policy"), policy, `${path} is a document a browser parses, so it is delivered with the document policy`);
			}

			const plain = await get(origin, "/notes.txt");
			assert.equal(plain.status, 200);
			assert.equal(plain.headers.get("content-security-policy"), null, "a plain text file is no document, so it carries no document policy");
		} finally {
			server.stop(true);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

test("no bundle the served page runs needs a Trusted Types policy the served policy would refuse", async () => {
	// The policy states `require-trusted-types-for 'script'` in both deliveries, and only Chromium enforces that directive at all, so a DOM sink inside one of these bundles is a hard Chromium failure and a silent one in an engine without Trusted Types, whichever delivery carried the policy: the sweep is what holds the bundles to the rule in every engine rather than leaving a sink to fail in one and pass in the next.
	// The bundles are read from the tree the server actually serves, and the set is pinned, so a bundle the copy step renamed or dropped cannot leave the sweep passing over nothing.
	const bundles = SERVED_BUNDLES.map((bundle) => join(root, "app", "js", "vendor", bundle));
	assert.deepEqual(bundles.filter((file) => !existsSync(file)), [], "every bundle the build serves is present under app/js/vendor/");
	const sinks = /\b(innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|execCommand)\b|\bdocument\s*\.\s*(?:write|writeln)\s*\(|\beval\s*\(|\bnew\s+Function\s*\(|\bsrcdoc\b/;
	for (const vector of ["el.innerHTML = markup;", "el.outerHTML = markup;", 'el.insertAdjacentHTML("beforeend", markup);', 'document.write("<p></p>");', "eval(source);", 'new Function("return 1");', "range.createContextualFragment(markup);", "frame.srcdoc = markup;"]) {
		assert.ok(sinks.test(vector), `the sweep misses ${vector}`);
	}
	for (const file of bundles) {
		const label = relative(root, file);
		const text = codeOnly(await readFile(file, "utf8"));
		const hits = text.split("\n").flatMap((line, index) => (sinks.test(line) ? [`${label}:${index + 1} — ${line.trim().slice(0, 120)}`] : []));
		assert.deepEqual(hits, [], "a bundle names a sink from executable code, so the directive would refuse the call the bundle makes");
	}
});

test("binds loopback by default and widens only on an explicit flag", async () => {
	const server = createStaticServer({ port: 0 });
	try {
		assert.equal(server.hostname, "127.0.0.1", "the default bind is loopback, not every interface");
	} finally {
		server.stop(true);
	}
	assert.deepEqual(parseServeArgs([]), {}, "no flags leaves the loopback default");
	assert.deepEqual(parseServeArgs(["--host", "0.0.0.0", "--port", "8080"]), { hostname: "0.0.0.0", port: 8080 });
	assert.throws(() => parseServeArgs(["--port"]), /needs a value/);
	assert.throws(() => parseServeArgs(["--port", "abc"]), /integer from 0 to 65535/);
	assert.throws(() => parseServeArgs(["--nope"]), /unknown argument/);
});

test("a --host beyond loopback earns a caution naming the source disclosure", () => {
	for (const host of ["127.0.0.1", "127.0.0.5", "127.1.2.3", "127.255.255.255", "localhost", "::1"]) {
		assert.equal(hostCaution(host), null, `${host} stays on loopback`);
	}
	for (const host of ["0.0.0.0", "192.168.1.5", "::", "example.com", "127.example.com", "127.0.0.1.example.com", "127.0.0.256"]) {
		const caution = hostCaution(host);
		assert.ok(caution, `${host} widens the bind beyond loopback`);
		assert.match(caution, /app\/ts\//, "the caution names the TypeScript sources it would disclose");
		assert.match(caution, /app\/js\//, "and the inline-sourced maps");
		assert.ok(caution.includes(host), "and the address that widens the bind");
	}
});

test("a host whose name only begins with 127. is not treated as loopback", () => {
	// A bare `/^127\./` test also matched a DNS name such as `127.example.com`, letting a widened bind skip the caution; the check must match a real loopback target only.
	for (const host of ["127.example.com", "127.0.0.1.example.com", "127."]) {
		assert.ok(hostCaution(host), `${host} is a name, not a 127.0.0.0/8 literal`);
	}
	for (const host of ["127.0.0.1", "127.1.2.3"]) {
		assert.equal(hostCaution(host), null, `${host} is a real loopback literal`);
	}
});

test("the startup caution names the whole served tree and its stray-file enforcement", () => {
	const caution = serveCaution();
	assert.match(caution, /every file under app\//, "the caution states that the whole tree is served");
	assert.match(caution, /ipfs add -r app/, "and that the same tree is pinned");
	assert.match(caution, /stray-file|unexpected file/, "and points at the acceptance gate's stray-file check as the enforcement");
});
