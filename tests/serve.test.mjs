/** The suite for `serve.mjs`: the static server's content types and path confinement, its anti-framing headers, and the loopback bind with its cautions. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStaticServer, hostCaution, parseServeArgs, serveCaution } from "../serve.mjs";

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

test("sends anti-framing headers so the served flow cannot be framed", async () => {
	const server = listen();
	try {
		const page = await get(server.origin, "/");
		assert.equal(page.status, 200);
		assert.equal(page.headers.get("x-frame-options"), "DENY");
		assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'none'");
	} finally {
		await server.close();
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
