/**
 * Resolve and verify the pinned registry tarball that `bun run vendor` anchors an acquisition to.
 * A first-time `SOURCES` path is copied from a tarball whose base64 `sha512` equals the pin in `scripts/vendor-pins.mjs`, never from the installed tree, so that path is anchored to the lockfile rather than to a tree nothing independent vouches for.
 * Everything here reads local files only — a pinned tarball in bun's install cache or one named with `--tarball <path>` — so a vendor run stays offline.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { pinFor, pinForIntegrity } from "./vendor-pins.mjs";

const BLOCK = 512;

/** The most bytes a pinned package tarball may occupy; a candidate larger than this is not read, so a planted huge file cannot stall or exhaust memory during an acquisition while the sha512 pin stays the only acceptance criterion. */
export const TARBALL_BYTE_CAP = 64 * 1024 * 1024;

/** The most bytes a pinned package tarball may decompress to; the tarball's sha512 pin is what admits an archive, so this bound is defense in depth against an archive whose expansion ratio exhausts memory, and it sits well above the real packages vendored here so a pinned archive is never refused for its size alone. */
export const DECOMPRESSED_BYTE_CAP = 256 * 1024 * 1024;

/** The directory bun caches installed packages in, unless `BUN_INSTALL_CACHE_DIR` names another one. */
export function tarballCacheDir(env = process.env) {
	const configured = env.BUN_INSTALL_CACHE_DIR;
	return configured === undefined || configured === "" ? join(homedir(), ".bun", "install", "cache") : configured;
}

/** The base64 `sha512` integrity of `bytes`, in the `sha512-…` form bun.lock records and the pin table holds. */
export function integrityOf(bytes) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** The stats of `path`, or null when no entry is there at all. */
function statOrNull(path) {
	try {
		return statSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

/** A package's name without its scope, as npm names its tarball: `@noble/hashes` ships `hashes-2.4.0.tgz`. */
function bareName(pkg) {
	const slash = pkg.indexOf("/");
	return slash === -1 ? pkg : pkg.slice(slash + 1);
}

/** The two fixed npm spellings a default-source lookup probes for `pkg@version` under `cacheDir`: `<basename>-<version>.tgz`, then the scoped `<pkg>-<version>.tgz` when it differs. */
function fixedTarballPaths(pkg, version, cacheDir) {
	const names = [`${bareName(pkg)}-${version}.tgz`];
	if (names[0] !== `${pkg}-${version}.tgz`) names.push(`${pkg}-${version}.tgz`);
	return names.map((name) => join(cacheDir, name));
}

/**
 * The paths a default-source lookup probes for `pkg@version` in `cacheDir`: the fixed npm spellings from `fixedTarballPaths`, followed by every other `*.tgz` the cache directory itself holds whose name mentions the package's scoped or bare name, so discovery does not rest on one exact filename.
 * The sha512 pin stays the gate, and `resolveVerifiedTarball` treats the two kinds differently: a fixed-spelling path that disagrees with the pin is refused, while a broader name-substring discovery that disagrees is skipped, so an unrelated archive in a shared cache cannot fail a routine run that then falls back to `node_modules`.
 * Recent bun versions store the cache as extracted package trees rather than tarballs, so this lookup can find nothing even where the package was installed; naming a tarball with `--tarball <path>` (or pointing `BUN_INSTALL_CACHE_DIR` at a directory of the pinned archives) is then the source.
 */
export function cachedTarballCandidates(pkg, version, cacheDir) {
	const paths = fixedTarballPaths(pkg, version, cacheDir);
	if (!existsSync(cacheDir)) return paths;
	const needles = [pkg.toLowerCase(), bareName(pkg).toLowerCase()];
	for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".tgz")) continue;
		if (!needles.some((needle) => entry.name.toLowerCase().includes(needle))) continue;
		const discovered = join(cacheDir, entry.name);
		if (!paths.includes(discovered)) paths.push(discovered);
	}
	return paths;
}

/** The message a caller reports when no verified tarball is resolvable for `pkg`: it names the exact cache paths the default lookup probed and the ways to supply the pinned archive, leaving the meaning of a missing tarball to the caller's acquisition policy. */
export function missingTarballMessage(pkg, pin, cacheDir) {
	const probed = cachedTarballCandidates(pkg, pin.version, cacheDir).map((path) => `\n  ${path}`).join("");
	return `no verified tarball for ${pkg}@${pin.version}; the default lookup probes:${probed} — put the pinned tarball at one of those paths (or point BUN_INSTALL_CACHE_DIR at a directory that holds it), or pass it with \`--tarball <path>\``;
}

// A fixed-spelling cache candidate disagreed with the pin, so it may not be trusted: the abort names the first mismatch and lists every mismatched fixed-spelling candidate with the sha512 each actually hashed to.
function mismatchedTarballError(pkg, pin, mismatched) {
	const [{ path, integrity }] = mismatched;
	const named = mismatched.map((entry) => `\n  ${entry.path} hashes to ${entry.integrity}`).join("");
	return new Error(`vendor: ${path} hashes to ${integrity}, which does not match the pinned ${pkg}@${pin.version} ${pin.integrity} — refusing it; the mismatched fixed-spelling candidates were:${named}`);
}

/** A plain description of what `stats` reports, so a refusal can name the entry kind rather than only asserting it is not a regular file. */
function entryKind(stats) {
	if (stats.isDirectory()) return "a directory";
	if (stats.isFIFO()) return "a FIFO";
	if (stats.isSocket()) return "a socket";
	if (stats.isCharacterDevice()) return "a character device";
	if (stats.isBlockDevice()) return "a block device";
	return "a non-regular entry";
}

// A fixed-spelling cache candidate is not a regular file, so it is refused before it is read: reading a directory aborts with a raw EISDIR and reading a FIFO blocks until a writer appears, so neither reaches the sha512 check.
function irregularTarballError(irregular) {
	const [{ path, kind }] = irregular;
	const named = irregular.map((entry) => `\n  ${entry.path} is ${entry.kind}`).join("");
	return new Error(`vendor: ${path} is ${kind}, not a regular file — refusing to read it; the irregular fixed-spelling candidates were:${named}`);
}

// A fixed-spelling cache candidate is larger than the cap, so it is refused before it is read rather than hashed whole: the abort names the first oversized path and lists every oversized fixed-spelling candidate with its byte size.
function oversizedTarballError(pkg, pin, oversized, maxBytes) {
	const [{ path, size }] = oversized;
	const named = oversized.map((entry) => `\n  ${entry.path} is ${entry.size} bytes`).join("");
	return new Error(`vendor: ${path} is ${size} bytes, over the ${maxBytes}-byte cap for the pinned ${pkg}@${pin.version} tarball — refusing to read it; the oversized fixed-spelling candidates were:${named}`);
}

/**
 * Locate and verify the pinned tarball for `pkg`, returning the exact bytes that matched the pin so a caller never re-reads an unverified file.
 * A `carried` entry — one `assignTarballs` already read — is returned as-is, so an explicit `--tarball` path is read once and not re-read; its bytes are hashed against the pin like every other source rather than the entry's recorded integrity being trusted.
 * Otherwise the `cachedTarballCandidates` paths under `cacheDir` are probed and each is hashed until `pinForIntegrity` maps its base64 `sha512` to `pinFor(pkg)`.
 * A candidate larger than `maxBytes` is not read at all: a fixed-spelling one is refused and a name-substring one is skipped, so a planted huge file cannot stall or exhaust memory while the sha512 pin stays the only acceptance criterion.
 * A candidate that is not a regular file is refused the same way when its path is a fixed spelling and skipped otherwise, so a directory or a FIFO planted at a probed path is named rather than read.
 * A fixed-spelling candidate that disagrees with the pin is refused rather than quietly replaced by the installed tree; a name-substring discovery that disagrees is skipped, and with no candidate matching at all the result is `null`, so a listed `SOURCES` path can keep reading `node_modules`.
 */
export function resolveVerifiedTarball(pkg, { carried, cacheDir = tarballCacheDir(), maxBytes = TARBALL_BYTE_CAP } = {}) {
	const pin = pinFor(pkg);
	if (carried !== undefined) {
		const integrity = integrityOf(carried.bytes);
		if (pinForIntegrity(integrity) !== pin) {
			throw new Error(`vendor: the carried tarball for ${pkg} hashes to ${integrity}, which does not match the pinned ${pkg}@${pin.version} ${pin.integrity} — refusing it`);
		}
		return { path: carried.path, integrity, bytes: carried.bytes };
	}
	const fixed = new Set(fixedTarballPaths(pkg, pin.version, cacheDir));
	const irregularFixed = [];
	const oversizedFixed = [];
	const mismatchedFixed = [];
	for (const path of cachedTarballCandidates(pkg, pin.version, cacheDir)) {
		if (!existsSync(path)) continue;
		const stats = statSync(path);
		if (!stats.isFile()) {
			if (fixed.has(path)) irregularFixed.push({ path, kind: entryKind(stats) });
			continue;
		}
		const { size } = stats;
		if (size > maxBytes) {
			if (fixed.has(path)) oversizedFixed.push({ path, size });
			continue;
		}
		const bytes = readFileSync(path);
		const integrity = integrityOf(bytes);
		if (pinForIntegrity(integrity) === pin) return { path, integrity, bytes };
		if (fixed.has(path)) mismatchedFixed.push({ path, integrity });
	}
	if (irregularFixed.length > 0) throw irregularTarballError(irregularFixed);
	if (oversizedFixed.length > 0) throw oversizedTarballError(pkg, pin, oversizedFixed, maxBytes);
	if (mismatchedFixed.length > 0) throw mismatchedTarballError(pkg, pin, mismatchedFixed);
	return null;
}

// The tarball is read only after its sha512 matched a pin, so these checks guard the archive's shape rather than its provenance: an entry that could escape the extraction root is refused even so.
function assertSafeEntryName(name, source) {
	const segments = name.split("/");
	if (name === "" || name.startsWith("/") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`vendor: ${source} holds the unsafe tar entry ${JSON.stringify(name)}`);
	}
	return name;
}

// A ustar size field is octal, NUL-padded; anything else — GNU's base-256 extension included — is refused rather than read as a length the header does not mean.
function parseSize(header, source) {
	const text = header.subarray(124, 136).toString("latin1").split("\0")[0].trim();
	if (!/^[0-7]+$/.test(text)) throw new Error(`vendor: ${source} holds a tar entry with an unreadable size field`);
	return Number.parseInt(text, 8);
}

function entryName(header) {
	const name = header.subarray(0, 100).toString("latin1").split("\0")[0];
	const prefix = header.subarray(345, 500).toString("latin1").split("\0")[0];
	return prefix === "" ? name : `${prefix}/${name}`;
}

// A GNU long-name entry ('L') carries the full name of the entry that follows in its data block, NUL-terminated.
function gnuLongName(data) {
	return data.toString("latin1").split("\0")[0];
}

// A pax extended header is a sequence of "<length> <key>=<value>\n" records; only `path` (a long-name override) matters here.
// A malformed record is skipped rather than fatal because the header carries no file bytes of its own.
function paxPath(data) {
	for (const record of data.toString("utf8").split("\n")) {
		const space = record.indexOf(" ");
		if (space === -1) continue;
		const equals = record.indexOf("=", space);
		if (equals === -1) continue;
		if (record.slice(space + 1, equals) === "path") return record.slice(equals + 1);
	}
	return null;
}

// A realistic archive wraps its regular files in GNU or pax extended headers — a long name ('L'), a per-file ('x') or global ('g') pax record — or carries directories and links ('1'/'2'/'5'), none of which is a regular file a SOURCES entry names.
// The extended headers are read for the name override they may carry for the entry that follows and otherwise skipped, and a link is skipped (its target is not file content), so such an archive is read rather than refused as malformed while every regular file keeps its own bytes.
// gzip's CRC covers the decompressed bytes against corruption and the caller has already matched the tarball's sha512 against the pin, so the ustar header checksum is not re-validated here.
function readUstarEntries(tar, source) {
	const entries = [];
	let override = null;
	for (let offset = 0; offset + BLOCK <= tar.length;) {
		const header = tar.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) break;
		const typeflag = String.fromCharCode(header[156]);
		const size = parseSize(header, source);
		const start = offset + BLOCK;
		const data = tar.subarray(start, start + size);
		if (data.length !== size) throw new Error(`vendor: ${source} is truncated inside ${entryName(header)}`);
		offset = start + Math.ceil(size / BLOCK) * BLOCK;
		if (typeflag === "L") {
			override = gnuLongName(data);
			continue;
		}
		if (typeflag === "x") {
			override = paxPath(data) ?? override;
			continue;
		}
		if (typeflag === "K" || typeflag === "g") continue;
		const name = override ?? entryName(header);
		override = null;
		if (typeflag === "1" || typeflag === "2" || typeflag === "5") continue;
		if (typeflag !== "0" && typeflag !== "\0") throw new Error(`vendor: ${source} holds the tar entry ${name} of unsupported type ${JSON.stringify(typeflag)}`);
		entries.push([assertSafeEntryName(name, source), data]);
	}
	return entries;
}

// npm wraps every entry in a single `package/` directory; the map is keyed by the path inside it, which is the path a SOURCES entry names.
function unwrapPackageDir(entries, source) {
	const [first] = entries;
	if (first === undefined) throw new Error(`vendor: ${source} holds no files`);
	const wrapper = first[0].slice(0, first[0].indexOf("/"));
	if (wrapper === "" || !entries.every(([name]) => name.startsWith(`${wrapper}/`))) {
		throw new Error(`vendor: ${source} does not hold every entry inside one wrapping directory`);
	}
	const files = new Map();
	for (const [name, data] of entries) {
		files.set(name.slice(wrapper.length + 1), data);
	}
	return files;
}

/**
 * The bytes of the gzipped tar at `path` as a `path → bytes` map, read from disk and extracted by `extractTarballBytes`.
 * The path is guarded like every other read this run makes — a directory, FIFO, socket or device planted at it is refused by name rather than aborted on or blocked on — and a file over `maxBytes` is refused rather than read whole.
 */
export function extractTarball(path, { maxBytes = TARBALL_BYTE_CAP } = {}) {
	const stats = statOrNull(path);
	if (stats === null) throw new Error(`vendor: ${path} does not exist — pass the path of a pinned package tarball`);
	if (!stats.isFile()) throw new Error(`vendor: ${path} is ${entryKind(stats)}, not a regular file — refusing to read it`);
	if (stats.size > maxBytes) throw new Error(`vendor: ${path} is ${stats.size} bytes, over the ${maxBytes}-byte cap for a pinned package tarball — refusing to read it`);
	return extractTarballBytes(readFileSync(path), path);
}

// `maxOutputLength` makes gunzip refuse rather than allocate past the cap, so an archive with a high expansion ratio never reaches the ustar reader as a multi-gigabyte buffer; the sha512 pin already admits only a pinned archive, so this bound is defense in depth.
function decompress(bytes, source, maxBytes) {
	try {
		return gunzipSync(bytes, { maxOutputLength: maxBytes });
	} catch (error) {
		if (error.code === "ERR_BUFFER_TOO_LARGE") {
			throw new Error(`vendor: ${source} expands past the ${maxBytes}-byte cap on decompressed output — refusing it`);
		}
		throw error;
	}
}

/**
 * The bytes of the gzipped tar in `bytes` as a `path → bytes` map, keyed by the entry's path inside the wrapper directory npm gives every package.
 * Decompression is bounded by `maxBytes`, so an archive that expands past the cap is refused by name instead of exhausting memory.
 */
export function extractTarballBytes(bytes, source, { maxBytes = DECOMPRESSED_BYTE_CAP } = {}) {
	return unwrapPackageDir(readUstarEntries(decompress(bytes, source, maxBytes), source), source);
}
