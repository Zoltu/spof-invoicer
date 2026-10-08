/**
 * Render and verify the `vendor-src/SHA256SUMS` provenance manifest: hash a tree, render or parse the manifest, and compare it against what is committed.
 * Shared by `build.mjs`, `scripts/fetch-vendor.mjs`, and the vendor tests.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The provenance manifest's file name, excluded from the tree it hashes. */
export const MANIFEST_FILE = "SHA256SUMS";

/** The lower-case hex SHA256 of `bytes`. */
export function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Every file under `dir`, as slash-joined paths relative to it, sorted. */
export async function listFiles(dir, prefix = "") {
	const found = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			found.push(...(await listFiles(join(dir, entry.name), rel)));
		} else {
			found.push(rel);
		}
	}
	return found.sort();
}

/** `[path, sha256]` pairs for every file under `dir` except `skip`, in sorted path order. */
export async function hashTree(dir, { skip = [MANIFEST_FILE] } = {}) {
	const skipped = new Set(skip);
	const entries = [];
	for (const rel of await listFiles(dir)) {
		if (skipped.has(rel)) continue;
		entries.push([rel, sha256(await readFile(join(dir, rel)))]);
	}
	return entries;
}

/** Render the SHA256SUMS text: provenance comments, the pinned package versions, then one `sha256  path` line per entry. */
export function renderManifest(entries, packages) {
	const header = [
		"# Provenance for vendor-src/ — `bun run vendor` rewrites this only over an unchanged tree;",
		"# a changed tree needs an explicit re-bless with `bun run vendor -- --force`.",
		"# Pinned packages (version and tarball sha512 as recorded in bun.lock):",
		...packages.map(({ name, version, integrity }) => `#   ${name}@${version} ${integrity}`),
		"# Format: <sha256>  <path relative to vendor-src/>",
	];
	const body = entries.map(([rel, digest]) => `${digest}  ${rel}`);
	return `${[...header, "", ...body].join("\n")}\n`;
}

/** Parse SHA256SUMS text into a map of path to digest, dropping comments and blank lines. */
export function parseManifest(text) {
	const entries = new Map();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const match = /^([0-9a-f]{64})\s+(.+)$/.exec(trimmed);
		if (match === null) {
			throw new Error(`manifest: unparsable line: ${line}`);
		}
		entries.set(match[2], match[1]);
	}
	return entries;
}

/** The differences between an expected path-to-digest map and `entries`, as human-readable lines. */
export function compareManifest(expected, entries) {
	const actual = new Map(entries);
	const problems = [];
	for (const [rel, digest] of expected) {
		if (!actual.has(rel)) {
			problems.push(`listed file is missing: ${rel}`);
		} else if (actual.get(rel) !== digest) {
			problems.push(`hash mismatch: ${rel}`);
		}
	}
	for (const rel of actual.keys()) {
		if (!expected.has(rel)) {
			problems.push(`file is not listed in the manifest: ${rel}`);
		}
	}
	return problems;
}

/** The problems that keep vendor-src/ from matching its committed manifest; empty when the tree matches. */
export async function verifyTree(dir) {
	const manifestPath = join(dir, MANIFEST_FILE);
	if (!existsSync(manifestPath)) {
		return [`vendor-src/${MANIFEST_FILE} is missing — run \`bun run vendor\``];
	}
	const expected = parseManifest(await readFile(manifestPath, "utf8"));
	return compareManifest(expected, await hashTree(dir));
}
