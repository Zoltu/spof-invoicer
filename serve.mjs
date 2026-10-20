/**
 * The `bun run serve` entry point: a dependency-free static server for the `app/` tree, bound to loopback by default and widened only by an explicit `--host`/`--port`.
 * Its server, argument-parsing, and caution helpers are exported for the serve suite.
 */

import { realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "app");

/**
 * The address `bun run serve` binds by default: loopback only, so the dev server never puts the served tree — the TypeScript sources under `app/ts/` and the inline-sourced maps beside the compiled `app/js/**` — on the local network.
 * Widening it beyond loopback is an explicit opt-in on the command line (`--host`, and `--port` for another port).
 */
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 80;

/**
 * The policy `app/index.html` delivers in its meta tag, repeated here so a served document carries it as a header too.
 *
 * A header is enforced whatever the markup says, and the meta tag is the one delivery a static IPFS gateway can be given, so a document served from both carries the policy in both. The browser enforces the intersection of the two, which is why these are the meta tag's own directives and no others: a directive the meta tag states and this header omitted would narrow the served page's policy, and the wallet workaround's script-src-elem allowance would be the first casualty. `tests/serve.test.mjs` holds the two deliveries to each other directive for directive.
 * The two deliveries state one list, and for this policy a browser enforces the same directives from both: the CSP specification has it ignore `frame-ancestors`, `sandbox`, and `report-uri` in a policy it reads out of a `meta` element, and this policy states none of those three, so `require-trusted-types-for 'script'` reaches a document from the meta tag exactly as it reaches one from this header. What differs is the engine rather than the delivery — only Chromium enforces that directive — which is why `tests/serve.test.mjs` sweeps the served bundles for the sinks it refuses, and why `README.md`'s "Security over features" states the difference for the payer.
 * `frame-ancestors` and `sandbox` are absent for the meta tag's own reason: framing is permitted on purpose, so this server adds no framing directive and no `X-Frame-Options` header.
 */
const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; media-src 'none'; form-action 'none'; script-src 'self'; script-src-elem 'self' 'unsafe-inline'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; font-src 'none'; connect-src 'none'; require-trusted-types-for 'script'";

/**
 * The content types a browser parses as a document, which is the set the document policy governs: an HTML page, an XHTML document, an XML document, and an SVG.
 * An SVG is in the set because a browser navigated to one parses it as a document rather than as an image, and a script inside that document runs in the serving origin.
 */
const DOCUMENT_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml", "application/xml", "text/xml", "image/svg+xml"]);

/**
 * Whether a served file is one a browser parses as a document, which is the only response a document policy governs: the policy states what a page may load and where it may navigate, so it is sent on a document and on nothing else.
 *
 * The decision reads the content type the response carries rather than the requested filename's suffix, because the type is what the browser dispatches on and the suffix is not: a `.htm` page, an XHTML file, and an SVG navigated on its own are all documents the suffix test would have delivered with no policy at all.
 */
function isDocument(contentType) {
	return DOCUMENT_CONTENT_TYPES.has(contentType.split(";")[0].trim().toLowerCase());
}

function notFound() {
	return new Response("404 Not Found\n", {
		status: 404,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

async function serveFile(request) {
	let pathname;
	try {
		pathname = decodeURIComponent(new URL(request.url).pathname);
	} catch {
		return notFound();
	}
	let target = resolve(appDir, pathname.replace(/^\/+/, ""));
	if (target !== appDir && !target.startsWith(appDir + sep)) {
		return notFound();
	}
	try {
		// The lexical check above only sees the requested path.
		// Resolve symlinks so a link planted inside app/ cannot smuggle a file from outside it past the guard.
		const root = realpathSync(appDir);
		target = realpathSync(target);
		if (statSync(target).isDirectory()) {
			target = realpathSync(resolve(target, "index.html"));
		}
		if (target !== root && !target.startsWith(root + sep)) {
			return notFound();
		}
	} catch {
		return notFound();
	}
	const file = Bun.file(target);
	if (!(await file.exists())) {
		return notFound();
	}
	// The policy rides on two deliveries rather than the meta tag alone: the header carries the same directives on any document this server sends, and framing is permitted on purpose — some wallet hosts show the invoice inside their own frame — so neither delivery states a framing directive and no `X-Frame-Options` header is sent.
	const policy = isDocument(file.type) ? { "content-security-policy": CONTENT_SECURITY_POLICY } : {};
	return new Response(file, {
		headers: {
			...policy,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

/**
 * Create the static server over `app/`, bound to loopback by default; `options` overrides the host and port.
 */
export function createStaticServer(options = {}) {
	return Bun.serve({
		hostname: DEFAULT_HOSTNAME,
		port: DEFAULT_PORT,
		...options,
		fetch: serveFile,
	});
}

/** An IPv4 literal whose first octet is 127, the shape a loopback address takes; a hostname such as `127.example.com` does not match it. */
const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * True only for a genuine loopback target: the name `localhost`, the IPv6 loopback `::1`, or an IPv4 literal in 127.0.0.0/8.
 * A bare `/^127\./` test also matched a DNS name merely beginning with `127.` — `127.example.com` — which is not loopback and would let a widened bind skip the caution below.
 */
function isLoopbackHost(hostname) {
	if (hostname === "localhost" || hostname === "::1") return true;
	const octets = IPV4_LOOPBACK.exec(hostname);
	return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * The caution to print when `--host` binds beyond loopback, or `null` when the host stays on loopback.
 *
 * The served tree deliberately contains the TypeScript sources under `app/ts/` and the inline-sourced maps beside `app/js/**`, so widening the bind past loopback discloses them to every host that can reach it; naming that here makes the disclosure a conscious choice at the point it happens rather than a side effect of the flag.
 */
export function hostCaution(hostname) {
	if (isLoopbackHost(hostname)) return null;
	return `serve: warning — --host ${hostname} exposes the served tree beyond loopback, including the TypeScript sources under app/ts/ and the inline-sourced maps beside app/js/**, to any host that can reach ${hostname}; bind the loopback default unless you mean to disclose them`;
}

/**
 * The caution to print when the server starts, naming what it serves.
 *
 * Every file under `app/` is served as-is and `ipfs add -r app` pins that same whole tree, so a file dropped under `app/` that should stay private — `app/wallet.json`, a key, a local note — is served and published.
 * The server deliberately performs no `.gitignore` filtering of the served tree; the repo's own acceptance gate (`tests/slow/acceptance.test.mjs`) is what catches a stray file under `app/`, by requiring every committed file there to be a build output or an authored source.
 */
export function serveCaution() {
	return "serve: caution — every file under app/ is served as-is and `ipfs add -r app` pins the whole tree, so keep secrets out of app/; the acceptance gate's stray-file check is what flags an unexpected file there";
}

/**
 * Read `--host <address>` and `--port <number>` from a command-line argument list, so binding beyond loopback is an explicit choice rather than the default.
 * An unknown argument or a missing or out-of-range value throws, so a typo stops the server instead of silently binding the default.
 */
export function parseServeArgs(argv) {
	const overrides = {};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag !== "--host" && flag !== "--port") {
			throw new Error(`serve: unknown argument ${flag}`);
		}
		const value = argv[index + 1];
		if (value === undefined) throw new Error(`serve: ${flag} needs a value`);
		if (flag === "--host") {
			overrides.hostname = value;
		} else {
			const port = Number(value);
			if (!Number.isInteger(port) || port < 0 || port > 65535) {
				throw new Error(`serve: --port needs an integer from 0 to 65535, got ${JSON.stringify(value)}`);
			}
			overrides.port = port;
		}
		index += 1;
	}
	return overrides;
}

if (import.meta.main) {
	try {
		const options = parseServeArgs(process.argv.slice(2));
		const server = createStaticServer(options);
		console.warn(serveCaution());
		const caution = options.hostname === undefined ? null : hostCaution(options.hostname);
		if (caution !== null) console.warn(caution);
		console.log(`serve: ${appDir} at http://${options.hostname ?? DEFAULT_HOSTNAME}:${server.port}`);
	} catch (error) {
		console.error(`serve: ${error.message}`);
		process.exit(1);
	}
}
