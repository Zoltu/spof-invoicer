/**
 * Lock-derived integrity pins for the vendored packages.
 * Each entry records the version and the tarball `sha512` integrity that `bun.lock` held when the vendor tree was last blessed.
 * `bun run vendor` refuses to acquire a package whose installed version or lock integrity disagrees with these pins, so a spoofed lockfile (or a swapped `node_modules` tree) cannot be silently re-vendored and re-blessed.
 */

/** The pinned version and bun.lock tarball integrity for each vendored package; `bun run vendor` refuses a divergence. */
export const VENDOR_PINS = [
	{
		name: "@noble/hashes",
		version: "2.4.0",
		integrity: "sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==",
	},
	{
		name: "@scure/base",
		version: "2.4.0",
		integrity: "sha512-thZ1TuJwFwBblOhgsjDKvvGirBxNp+wSvY/DR6tJBJOTDhdAAcHJ8Vbr2eFnqaxeca4+t0i9KBf+uHYGWwZORg==",
	},
	{
		name: "pdf-lib",
		version: "1.17.1",
		integrity: "sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw==",
	},
];

/** The pin for `name`, or an error naming the table to add it to when there is none. */
export function pinFor(name, pins = VENDOR_PINS) {
	const pin = pins.find((entry) => entry.name === name);
	if (pin === undefined) {
		throw new Error(`vendor: no integrity pin for ${name} — add it to scripts/vendor-pins.mjs`);
	}
	return pin;
}

// bun.lock is JSON with trailing commas and blank lines.
// Integrity strings are base64 (no commas), so dropping `,` before a closing bracket is safe and does not touch any recorded value.
function stripTrailingCommas(text) {
	return text.replace(/,(\s*[}\]])/g, "$1");
}

/** The version and integrity bun.lock records for each package, keyed by name. */
export function pinsFromLock(lockText) {
	let lock;
	try {
		lock = JSON.parse(stripTrailingCommas(lockText));
	} catch (error) {
		throw new Error(`bun.lock is not parseable: ${error.message}`);
	}
	const found = new Map();
	for (const [name, entry] of Object.entries(lock.packages ?? {})) {
		if (!Array.isArray(entry)) continue;
		const specifier = entry[0];
		const integrity = entry[3];
		if (typeof specifier !== "string" || typeof integrity !== "string") continue;
		const at = specifier.lastIndexOf("@");
		found.set(name, { version: at === -1 ? "" : specifier.slice(at + 1), integrity });
	}
	return found;
}

/** The mismatches between bun.lock's recorded versions and integrity and the pins; empty when they agree. */
export function checkLockPins(lockText, pins = VENDOR_PINS) {
	let recorded;
	try {
		recorded = pinsFromLock(lockText);
	} catch (error) {
		return [error.message];
	}
	const problems = [];
	for (const pin of pins) {
		const entry = recorded.get(pin.name);
		if (entry === undefined) {
			problems.push(`bun.lock does not record ${pin.name}@${pin.version}`);
			continue;
		}
		if (entry.version !== pin.version) {
			problems.push(`${pin.name}: bun.lock records version ${entry.version}, pinned ${pin.version}`);
		}
		if (entry.integrity !== pin.integrity) {
			problems.push(`${pin.name}: bun.lock integrity does not match the pinned tarball sha512`);
		}
	}
	return problems;
}
