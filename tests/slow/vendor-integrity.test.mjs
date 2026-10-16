/**
 * The suite for the vendor guards. Its concerns:
 * - the build's own scratch-root refusal, and the vendor-tree provenance check the build runs;
 * - the pinned `node_modules` byte cross-check, that a routine resolution reads no tarball cache, and the anchoring predicate that decides which packages a run acquires from one, with the exported `planCopies` / `copyRefusal` / `hasNoVendoredCopy` guard predicates the run is built from;
 * - the lockfile integrity pins and the manifest header that documents them;
 * - the re-bless and overwrite guards and the `--force` / `--allow-upstream-drift` overrides that reach them;
 * - the `--tarball` CLI surface (a non-file path and a pinned-but-unvendored package each refused by name);
 * - the tarball reader (ustar, GNU/pax extended headers, committed real-world archives, escape refusal, and its fail-closed branches: an unknown typeflag, an unreadable size field, a truncated entry, and an archive that holds no files) and the resolution rules (fixed-spelling vs name-substring cache discovery, carried reads);
 * - the acquisition anchor: a first-time acquisition from a pinned tarball or a cache-resident one, refusal when none is resolvable, refusal of an archive that disagrees with its pin, and the copy loop's refusal of a file a pinned tarball does not ship;
 * - the non-regular-entry guards: a tree hash that refuses to hash through a link, a cache candidate that is not a regular file, and the bound on decompressed output.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { resolveOutRoot, vendorTreeProblems } from "../../build.mjs";
import { SOURCES, blessManifest, copyRefusal, hasNoVendoredCopy, parseVendorOptions, planCopies, requiresVerifiedTarball, resolveTrustedSources, upstreamProblems } from "../../scripts/fetch-vendor.mjs";
import { MANIFEST_FILE, hashTree, parseManifest, sha256 } from "../../scripts/vendor-manifest.mjs";
import { VENDOR_PINS, checkLockPins, pinFor } from "../../scripts/vendor-pins.mjs";
import { DECOMPRESSED_BYTE_CAP, TARBALL_BYTE_CAP, cachedTarballCandidates, extractTarball, extractTarballBytes, integrityOf, resolveVerifiedTarball } from "../../scripts/vendor-tarball.mjs";
import { buildRawTarball, buildTarball, paxData, rawTarBytes } from "../helpers/tarball-fixtures.mjs";
import { copyVendorScripts, emptyCacheDir, runVendor, seedSources, unlistManifestLine } from "../helpers/vendor-repo.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockText = readFileSync(join(root, "bun.lock"), "utf8");

/** Drop `target` from the fixture's manifest and delete its vendored copy, leaving a first-time acquisition for the tests to run. */
async function unlistTarget(repo, target) {
	const before = await unlistManifestLine(repo, target);
	await rm(join(repo, "vendor-src", target));
	return before;
}

// A repo whose @noble/hashes tree is anchored to a fabricated pinned tarball: the pin table and bun.lock record that archive's sha512, node_modules holds bytes tampered away from it, and vendor-src/ holds the tarball's bytes with one path left for the tests to unlist.
async function seedTarballRepo(prefix, { tamper = true, omit = null } = {}) {
	const repo = await mkdtemp(join(tmpdir(), prefix));
	await copyVendorScripts(repo);

	const pkg = "@noble/hashes";
	const source = SOURCES.find((entry) => entry.pkg === pkg);
	const pin = pinFor(pkg);
	const tarball = buildTarball(source.files.filter(([from]) => from !== omit).map(([from, name]) => [`package/${name}`, `tarball ${from}\n`]));
	const integrity = integrityOf(tarball);
	await mkdir(join(repo, "tarballs"), { recursive: true });
	const tarballPath = join(repo, "tarballs", `hashes-${pin.version}.tgz`);
	await writeFile(tarballPath, tarball);

	for (const file of ["scripts/vendor-pins.mjs", "bun.lock"]) {
		const path = join(repo, file);
		const text = readFileSync(path, "utf8");
		assert.ok(text.includes(pin.integrity), `${file} does not record the ${pkg} pin integrity`);
		await writeFile(path, text.replace(pin.integrity, integrity));
	}

	await seedSources(repo, {
		installed: (entry, from) => (entry.pkg === pkg && tamper ? `tampered ${from}\n` : `tarball ${from}\n`),
		vendored: (entry, from) => `tarball ${from}\n`,
	});
	await blessManifest({ dir: join(repo, "vendor-src"), force: true });
	return { repo, version: pin.version, tarball, tarballPath };
}

test("build refuses a BUILD_OUT_ROOT it does not own", () => {
	assert.equal(resolveOutRoot(""), root);
	assert.equal(resolveOutRoot("build-scratch"), resolve(root, "build-scratch"));
	assert.throws(() => resolveOutRoot("app"), /refusing to remove it/, "an existing repo directory the build did not create is refused");
	const scratch = join(tmpdir(), "invoice-out-root");
	assert.equal(resolveOutRoot(scratch), scratch, "a not-yet-created scratch path under os.tmpdir() is accepted");
	for (const escape of ["/", "/etc", `${tmpdir()}/..`]) {
		assert.throws(() => resolveOutRoot(escape), /refusing to remove it/, escape);
	}
	assert.throws(() => resolveOutRoot(tmpdir()), /refusing to remove it/, "os.tmpdir() itself is not the build's own directory");
	const owned = mkdtempSync(join(tmpdir(), "invoice-out-root-"));
	try {
		assert.equal(resolveOutRoot(owned), owned, "an empty scratch directory under os.tmpdir() is accepted");
		writeFileSync(join(owned, "keep.txt"), "another process's file\n");
		assert.throws(() => resolveOutRoot(owned), /refusing to remove it/, "a non-empty directory under os.tmpdir() is refused");
	} finally {
		rmSync(owned, { recursive: true, force: true });
	}
});

test("the committed vendor tree passes the provenance check the build runs", async () => {
	assert.deepEqual(await vendorTreeProblems(), []);
});

test("the committed vendor tree matches the pinned node_modules copies", async () => {
	// Resolve the trusted sources against an empty cache directory, so a pinned tarball on the machine running the tests cannot turn this node_modules comparison into a tarball one.
	const trusted = resolveTrustedSources({ cacheDir: emptyCacheDir(root) });
	const problems = await upstreamProblems({ trusted });
	assert.deepEqual(problems, [], problems.map((problem) => problem.message).join("; "));
});

test("a routine resolution consults no tarball cache, so the committed tree's outcome cannot turn on host cache state", async () => {
	// A cache holding the pinned package's exact fixed npm spelling, with bytes that disagree with the pin: an acquisition probe refuses it, but a routine resolution must not probe at all, so the committed tree passes whatever ~/.bun/install/cache holds.
	const cacheDir = await mkdtemp(join(tmpdir(), "invoice-tarball-routine-"));
	try {
		const version = pinFor("@noble/hashes").version;
		await writeFile(join(cacheDir, `hashes-${version}.tgz`), buildTarball([["package/sha2.js", "not the pinned bytes\n"]]));
		const trusted = resolveTrustedSources({ cacheDir });
		assert.deepEqual([...trusted.byPackage.values()], SOURCES.map(() => null), "a routine resolution resolves no package from the cache");
		const problems = await upstreamProblems({ trusted });
		assert.deepEqual(problems, [], problems.map((problem) => problem.message).join("; "));
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
});

test("requiresVerifiedTarball anchors a run to a tarball only for an unlisted or absent copy", () => {
	const listed = { listed: true, fresh: false };
	const unlistedPresent = { listed: false, fresh: false };
	const unlistedAbsent = { listed: false, fresh: true };
	const manifest = new Map([["noble-hashes/sha2.js", "0".repeat(64)]]);
	assert.equal(requiresVerifiedTarball([listed], manifest), false, "a listed copy present on disk reads the installed tree");
	assert.equal(requiresVerifiedTarball([unlistedPresent], manifest), true, "a copy the manifest does not list anchors while a manifest stands");
	assert.equal(requiresVerifiedTarball([unlistedAbsent], manifest), true, "a path with no vendored copy yet anchors");
	assert.equal(requiresVerifiedTarball([unlistedAbsent], null), true, "a path with no vendored copy yet anchors even with no manifest");
	assert.equal(requiresVerifiedTarball([unlistedPresent], null), false, "the manifest-restore case reads the installed tree");
	assert.equal(requiresVerifiedTarball([], manifest), false, "a package with no files anchors nothing");
	assert.equal(requiresVerifiedTarball([listed, unlistedAbsent], manifest), true, "one anchoring copy anchors the whole package");
});

test("planCopies marks each SOURCES file listed by the blessed manifest and fresh when no copy exists", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-vendor-plan-"));
	try {
		const source = { pkg: "fixture", dir: "fixture-not-vendored", files: [["dist/a.js", "a.js"], ["nested/b.js", "b.js"]] };
		const blessed = new Map([["fixture-not-vendored/a.js", "0".repeat(64)]]);
		assert.deepEqual(
			planCopies(source, blessed, dir).map(({ rel, listed, fresh }) => ({ rel, listed, fresh })),
			[
				{ rel: "fixture-not-vendored/a.js", listed: true, fresh: true },
				{ rel: "fixture-not-vendored/b.js", listed: false, fresh: true },
			],
			"a listed path is marked listed, and a path with no copy on disk is fresh",
		);
		await mkdir(join(dir, "fixture-not-vendored"), { recursive: true });
		await writeFile(join(dir, "fixture-not-vendored", "a.js"), "x\n");
		assert.equal(planCopies(source, blessed, dir)[0].fresh, false, "a copy on disk is not fresh");
		assert.deepEqual(planCopies(source, null, dir).map((copy) => copy.listed), [false, false], "no committed manifest lists nothing");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("copyRefusal refuses an unlisted copy that exists without force and a fresh unlisted path without addNew", () => {
	const listed = { rel: "pkg/listed.js", listed: true, fresh: false };
	const unlistedPresent = { rel: "pkg/present.js", listed: false, fresh: false };
	const unlistedFresh = { rel: "pkg/fresh.js", listed: false, fresh: true };
	assert.equal(copyRefusal([listed], { force: false, addNew: false }), null, "a listed copy is written");
	assert.match(copyRefusal([unlistedPresent], { force: false, addNew: false }), /does not list it/, "an existing unlisted copy is refused without force");
	assert.equal(copyRefusal([unlistedPresent], { force: true, addNew: false }), null, "force overwrites an existing unlisted copy");
	assert.match(copyRefusal([unlistedFresh], { force: false, addNew: false }), /--add-new/, "a fresh unlisted path needs addNew");
	assert.match(copyRefusal([unlistedFresh], { force: true, addNew: false }), /--add-new/, "force does not reach a fresh path; addNew does");
	assert.equal(copyRefusal([unlistedFresh], { force: false, addNew: true }), null, "addNew acquires a fresh unlisted path");
});

test("hasNoVendoredCopy is true only for a SOURCES path the manifest omits and no copy exists", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-vendor-nocopy-"));
	try {
		const rel = "pdf-lib/pdf-lib.esm.js";
		assert.equal(hasNoVendoredCopy(rel, new Map(), dir), true, "an unlisted SOURCES path with no copy is skipped by the cross-check");
		await mkdir(join(dir, "pdf-lib"), { recursive: true });
		await writeFile(join(dir, rel), "x\n");
		assert.equal(hasNoVendoredCopy(rel, new Map(), dir), false, "a copy on disk is compared, not skipped");
		assert.equal(hasNoVendoredCopy(rel, new Map([[rel, "0".repeat(64)]]), dir), false, "a listed path is never skipped");
		assert.equal(hasNoVendoredCopy(rel, null, dir), false, "no committed manifest means the manifest-restore case");
		assert.equal(hasNoVendoredCopy("not-sourced/x.js", new Map(), dir), false, "a path no SOURCES entry names is not this case");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("build exits non-zero when vendor-src/ fails its provenance check", async () => {
	const repo = await mkdtemp(join(tmpdir(), "invoice-vendor-guard-"));
	try {
		await mkdir(join(repo, "scripts"), { recursive: true });
		await copyFile(join(root, "build.mjs"), join(repo, "build.mjs"));
		await copyFile(join(root, "scripts", "vendor-manifest.mjs"), join(repo, "scripts", "vendor-manifest.mjs"));
		const vendorDir = join(repo, "vendor-src");
		await mkdir(vendorDir, { recursive: true });
		await writeFile(join(vendorDir, "x.js"), "tampered\n");
		await writeFile(join(vendorDir, MANIFEST_FILE), `# synthetic\n${"0".repeat(64)}  x.js\n`);

		const result = spawnSync(process.execPath, [join(repo, "build.mjs")], {
			cwd: repo,
			encoding: "utf8",
			env: { ...process.env, BUILD_OUT_ROOT: join(repo, "out") },
		});
		assert.notEqual(result.status, 0, "build must exit non-zero on a tampered vendor tree");
		assert.match(result.stderr, /SHA256 provenance/);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("the vendor run refuses an installed tree that diverges from the committed vendor-src, --force and --add-new included", async () => {
	const repo = await mkdtemp(join(tmpdir(), "invoice-vendor-cross-check-"));
	try {
		await copyVendorScripts(repo);
		// A minimal installed tree whose bytes differ from the committed vendor-src copies: the cross-check must catch the divergence before the copy loop can re-bless it.
		await seedSources(repo, {
			installed: (source, from) => `installed ${from}\n`,
			vendored: (source, from, name) => `committed ${name}\n`,
		});

		const routine = runVendor(repo);
		assert.notEqual(routine.status, 0, "a routine vendor run must abort on a divergence");
		assert.match(routine.stderr, /does not match the installed node_modules bytes/);
		assert.match(routine.stderr, /vendor-src\/pdf-lib\/pdf-lib\.esm\.js/, "the abort names a file that diverged");

		const forced = runVendor(repo, ["--force"]);
		assert.notEqual(forced.status, 0, "--force alone must not bypass the installed-bytes cross-check");
		assert.match(forced.stderr, /does not match the installed node_modules bytes/);

		const addedNew = runVendor(repo, ["--add-new"]);
		assert.notEqual(addedNew.status, 0, "--add-new alone must not bypass the installed-bytes cross-check");
		assert.match(addedNew.stderr, /does not match the installed node_modules bytes/);

		const overridden = runVendor(repo, ["--force", "--allow-upstream-drift"]);
		assert.equal(overridden.status, 0, overridden.stderr);
		assert.match(overridden.stderr, /--allow-upstream-drift is set/);
		assert.match(overridden.stderr, /vendor-src\/pdf-lib\/pdf-lib\.esm\.js/, "the override warning lists the files it re-blesses");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a re-blessed hand-edit against a pristine node_modules is caught, and only both overrides let it through", async () => {
	const repo = await mkdtemp(join(tmpdir(), "invoice-vendor-drift-"));
	try {
		await copyVendorScripts(repo);
		// node_modules holds the pinned bytes while vendor-src/ was hand-edited and its manifest re-blessed to match: only the upstream cross-check can see that divergence.
		await seedSources(repo, {
			installed: (source, from) => `pinned ${from}\n`,
			vendored: (source, from, name) => `hand-edited ${name}\n`,
		});
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });

		const routine = runVendor(repo);
		assert.notEqual(routine.status, 0, "a routine run must abort on the hand-edit");
		assert.match(routine.stderr, /does not match the installed node_modules bytes/);
		assert.match(routine.stderr, /--force/, "the abort names --force, which the drift override alone does not replace");
		assert.match(routine.stderr, /vendor-src\/pdf-lib\/pdf-lib\.esm\.js/, "the abort names the hand-edited file");

		const driftOnly = runVendor(repo, ["--allow-upstream-drift"]);
		assert.notEqual(driftOnly.status, 0, "--allow-upstream-drift alone still stops at the per-file overwrite guard");
		assert.match(driftOnly.stderr, /no longer matches the blessed vendor-src/);

		const forcedOnly = runVendor(repo, ["--force"]);
		assert.notEqual(forcedOnly.status, 0, "--force alone must not bypass the cross-check");
		assert.match(forcedOnly.stderr, /does not match the installed node_modules bytes/);

		const both = runVendor(repo, ["--force", "--allow-upstream-drift"]);
		assert.equal(both.status, 0, both.stderr);
		assert.match(both.stderr, /--allow-upstream-drift is set/);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("bun.lock satisfies the committed tarball-integrity pins", () => {
	assert.deepEqual(checkLockPins(lockText), []);
});

test("a tampered lockfile integrity or version is rejected", () => {
	const [pin] = VENDOR_PINS;

	const swappedIntegrity = lockText.replace(pin.integrity, "sha512-AAAA");
	assert.notEqual(swappedIntegrity, lockText, "the fixture did not contain the pin integrity");
	assert.ok(checkLockPins(swappedIntegrity).some((problem) => problem.includes(pin.name) && problem.includes("integrity")));

	const swappedVersion = lockText.replace(`${pin.name}@${pin.version}`, `${pin.name}@9.9.9`);
	assert.notEqual(swappedVersion, lockText, "the fixture did not contain the pin version");
	assert.ok(checkLockPins(swappedVersion).some((problem) => problem.includes("version")));
});

test("an unreadable lockfile fails closed", () => {
	assert.ok(checkLockPins("not a lockfile").length > 0);
});

test("the manifest header records each pinned tarball sha512", () => {
	const manifest = readFileSync(join(root, "vendor-src", MANIFEST_FILE), "utf8");
	for (const pin of VENDOR_PINS) {
		assert.ok(
			manifest.includes(`${pin.name}@${pin.version} ${pin.integrity}`),
			`the manifest header is missing the ${pin.name} integrity pin`,
		);
	}
});

test("parseVendorOptions reads the whole CLI surface into one object", () => {
	assert.deepEqual(parseVendorOptions([]), { force: false, allowUpstreamDrift: false, addNew: false, tarballs: [] });
	assert.deepEqual(
		parseVendorOptions(["--force", "--add-new", "--allow-upstream-drift", "--tarball", "a.tgz", "--tarball=b.tgz"]),
		{ force: true, allowUpstreamDrift: true, addNew: true, tarballs: ["a.tgz", "b.tgz"] },
		"the three overrides and every --tarball path are read together",
	);
	assert.throws(() => parseVendorOptions(["--tarball"]), /--tarball takes the path/, "a bare --tarball is refused");
	assert.throws(() => parseVendorOptions(["--tarball="]), /--tarball takes the path/, "an empty --tarball= is refused");
	assert.throws(() => parseVendorOptions(["--tarball", "--force"]), /--tarball takes the path/, "a --tarball followed by another flag is refused");
});

test("vendor refuses to re-bless a drifted tree without an explicit --force", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-vendor-bless-"));
	try {
		await writeFile(join(dir, "x.js"), "v1\n");
		// A missing committed manifest is itself refused, so the first blessing needs the explicit flag.
		await assert.rejects(blessManifest({ dir }), /is missing or empty/);
		await blessManifest({ dir, force: true });
		assert.equal(parseManifest(readFileSync(join(dir, MANIFEST_FILE), "utf8")).get("x.js"), sha256(Buffer.from("v1\n")));

		await writeFile(join(dir, "x.js"), "v2\n");
		await assert.rejects(blessManifest({ dir }), /refusing to re-bless/);

		await blessManifest({ dir, force: true });
		assert.equal(parseManifest(readFileSync(join(dir, MANIFEST_FILE), "utf8")).get("x.js"), sha256(Buffer.from("v2\n")));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("blessManifest treats an empty manifest like a missing one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-vendor-empty-"));
	try {
		await writeFile(join(dir, "x.js"), "v1\n");
		await writeFile(join(dir, MANIFEST_FILE), "");
		await assert.rejects(blessManifest({ dir }), /is missing or empty/);
		await blessManifest({ dir, force: true });
		assert.equal(parseManifest(readFileSync(join(dir, MANIFEST_FILE), "utf8")).get("x.js"), sha256(Buffer.from("v1\n")));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("blessManifest refuses an unlisted file without --add-new, which --force does not replace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-vendor-handwritten-"));
	try {
		await writeFile(join(dir, "x.js"), "v1\n");
		await blessManifest({ dir, force: true });
		await writeFile(join(dir, "hand-written.d.ts"), "declare const y: number;\n");
		await assert.rejects(blessManifest({ dir }), /--add-new/);
		await assert.rejects(blessManifest({ dir, force: true }), /--add-new/, "--force re-blesses a listed file, it does not introduce an unlisted one");
		await blessManifest({ dir, addNew: true });
		assert.ok(parseManifest(readFileSync(join(dir, MANIFEST_FILE), "utf8")).has("hand-written.d.ts"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extractTarball reads a package archive and refuses an entry that could escape the extraction root", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-tarball-"));
	try {
		const path = join(dir, "fixture.tgz");
		await writeFile(path, buildTarball([["package/dist/a.js", "one\n"], ["package/LICENSE", "two\n"]]));
		const files = extractTarball(path);
		assert.deepEqual([...files.keys()].sort(), ["LICENSE", "dist/a.js"], "the wrapping directory is stripped from every key");
		assert.equal(files.get("dist/a.js").toString("utf8"), "one\n");
		assert.equal(files.get("LICENSE").toString("utf8"), "two\n");

		await writeFile(path, buildTarball([["package/../escape.js", "x\n"]]));
		assert.throws(() => extractTarball(path), /unsafe tar entry/, "an entry that traverses out of the extraction root is refused");
		await writeFile(path, buildTarball([["/etc/passwd", "x\n"]]));
		assert.throws(() => extractTarball(path), /unsafe tar entry/, "an absolute entry is refused");
		await writeFile(path, buildTarball([["package/a.js", "x\n"], ["other/b.js", "y\n"]]));
		assert.throws(() => extractTarball(path), /one wrapping directory/, "two top-level directories are refused");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extractTarball reads a realistic archive with extended headers and links", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-tarball-extended-"));
	try {
		const path = join(dir, "fixture.tgz");
		await writeFile(path, buildRawTarball([
			{ name: "package/", typeflag: "5" },
			{ name: "package/PaxHeaders/a", typeflag: "x", data: paxData([["path", "package/dist/a.js"]]) },
			{ name: "package/dist/placeholder.js", data: Buffer.from("one\n") },
			{ name: "package/PaxHeaders/global", typeflag: "g", data: paxData([["comment", "built by the fixture"]]) },
			{ name: "package/long/LongLink", typeflag: "L", data: Buffer.from("package/long/verylongname.js\0") },
			{ name: "package/long/placeholder.js", data: Buffer.from("two\n") },
			{ name: "package/link.js", typeflag: "2", data: Buffer.from("dist/a.js") },
			{ name: "package/plain/b.js", data: Buffer.from("three\n") },
		]));

		const files = extractTarball(path);
		assert.deepEqual([...files.keys()].sort(), ["dist/a.js", "long/verylongname.js", "plain/b.js"], "the extended headers' name overrides apply and the directory and the symlink are skipped");
		assert.equal(files.get("dist/a.js").toString("utf8"), "one\n");
		assert.equal(files.get("long/verylongname.js").toString("utf8"), "two\n");
		assert.equal(files.get("plain/b.js").toString("utf8"), "three\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extractTarball fails closed on a malformed archive", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-tarball-malformed-"));
	try {
		const path = join(dir, "bad.tgz");

		await writeFile(path, buildRawTarball([{ name: "package/a.js", typeflag: "9", data: Buffer.from("x\n") }]));
		assert.throws(() => extractTarball(path), /unsupported type/, "an entry of an unknown typeflag is refused");

		const badSize = rawTarBytes([{ name: "package/a.js", data: Buffer.from("x\n") }]);
		badSize.write("zzzzzzzzzzzz", 124, "latin1");
		await writeFile(path, gzipSync(badSize));
		assert.throws(() => extractTarball(path), /unreadable size field/, "a non-octal size field is refused");

		const truncated = rawTarBytes([{ name: "package/a.js", data: Buffer.from("hello") }]).subarray(0, 513);
		await writeFile(path, gzipSync(truncated));
		assert.throws(() => extractTarball(path), /is truncated inside package\/a\.js/, "an entry whose data block is cut short is refused");

		await writeFile(path, buildTarball([]));
		assert.throws(() => extractTarball(path), /holds no files/, "an archive with no entry is refused");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("resolveVerifiedTarball refuses a fixed-spelling cache candidate that disagrees with the pin and skips a name-substring one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-tarball-pin-"));
	try {
		const version = pinFor("@noble/hashes").version;
		// A candidate under the fixed npm spelling that disagrees with the pin is refused, naming the path it probed.
		const spelling = join(dir, `hashes-${version}.tgz`);
		await writeFile(spelling, buildTarball([["package/sha2.js", "x\n"]]));
		assert.throws(
			() => resolveVerifiedTarball("@noble/hashes", { cacheDir: dir }),
			(error) => {
				assert.match(error.message, /does not match the pinned @noble\/hashes@/);
				assert.ok(error.message.includes(spelling), "the abort names the fixed spelling it probed");
				return true;
			},
			"a fixed-spelling archive whose sha512 disagrees with the pin is refused",
		);

		// A name-substring discovery that disagrees is skipped rather than refused, so an unrelated archive in a shared cache cannot fail a routine run.
		await rm(spelling);
		await writeFile(join(dir, `unrelated-noble-hashes-${version}.tgz`), buildTarball([["package/sha2.js", "y\n"]]));
		assert.equal(
			resolveVerifiedTarball("@noble/hashes", { cacheDir: dir }),
			null,
			"a name-substring candidate that disagrees with the pin is skipped, and a listed path falls back to node_modules",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("resolveVerifiedTarball hashes a carried entry's bytes against the pin rather than trusting its record", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-tarball-carried-"));
	try {
		const pin = pinFor("@noble/hashes");
		// A carried entry stands in for the read `assignTarballs` already made: the bytes travel with it, so a resolution that must not re-read the file never touches the path.
		const bytes = Buffer.from("carried tarball bytes\n");
		assert.throws(
			() => resolveVerifiedTarball("@noble/hashes", { carried: { path: join(dir, "gone.tgz"), bytes } }),
			/does not match the pinned @noble\/hashes@/,
			"a carried entry whose bytes hash to something other than the pin is refused",
		);
		// A recorded integrity naming the pin does not rescue bytes that hash to something else, because the field is not trusted.
		assert.throws(
			() => resolveVerifiedTarball("@noble/hashes", { carried: { path: join(dir, "gone.tgz"), bytes, integrity: pin.integrity } }),
			/does not match the pinned @noble\/hashes@/,
			"a carried entry's recorded integrity is ignored in favor of its bytes",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a first-time acquisition copies the pinned tarball's bytes, not a tampered node_modules tree", async () => {
	const { repo, tarballPath } = await seedTarballRepo("invoice-vendor-tarball-");
	try {
		const target = "noble-hashes/sha2.js";
		const before = await unlistTarget(repo, target);
		assert.equal(readFileSync(join(repo, "node_modules", "@noble/hashes", "sha2.js"), "utf8"), "tampered sha2.js\n", "the fixture must hold tampered bytes in node_modules");

		const added = runVendor(repo, ["--add-new", "--tarball", tarballPath]);
		assert.equal(added.status, 0, added.stderr);
		const acquired = readFileSync(join(repo, "vendor-src", target), "utf8");
		assert.equal(acquired, "tarball sha2.js\n", "the acquisition must copy the tarball's bytes, not the tampered node_modules copy");
		assert.equal(
			parseManifest(readFileSync(join(repo, "vendor-src", MANIFEST_FILE), "utf8")).get(target),
			sha256(Buffer.from(acquired)),
			"the run must record the acquired file's SHA256",
		);
		assert.notEqual(readFileSync(join(repo, "vendor-src", MANIFEST_FILE), "utf8"), before, "the run must record the acquired path");

		const settled = runVendor(repo, ["--tarball", tarballPath]);
		assert.equal(settled.status, 0, settled.stderr);
		assert.equal(readFileSync(join(repo, "vendor-src", target), "utf8"), acquired, "a routine run re-reads the same tarball bytes");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a repair of a removed manifest line takes the tarball, never the installed tree", async () => {
	const { repo, tarballPath } = await seedTarballRepo("invoice-vendor-repair-");
	try {
		const target = "noble-hashes/sha2.js";
		// Only the manifest line was dropped: the vendored copy and the (here tampered) installed tree both still exist, so a repair must not read node_modules.
		const before = await unlistManifestLine(repo, target);

		const noTarball = runVendor(repo, ["--force", "--add-new", "--allow-upstream-drift"]);
		assert.notEqual(noTarball.status, 0, "a removed-manifest-line repair with no verified tarball must be refused");
		assert.match(noTarball.stderr, /no verified tarball/);
		assert.equal(readFileSync(join(repo, "vendor-src", target), "utf8"), "tarball sha2.js\n", "the run must not overwrite the copy from node_modules");
		assert.equal(readFileSync(join(repo, "vendor-src", MANIFEST_FILE), "utf8"), before, "the run must not rewrite SHA256SUMS");

		const repaired = runVendor(repo, ["--force", "--add-new", "--tarball", tarballPath]);
		assert.equal(repaired.status, 0, repaired.stderr);
		assert.equal(readFileSync(join(repo, "vendor-src", target), "utf8"), "tarball sha2.js\n");
		assert.notEqual(readFileSync(join(repo, "vendor-src", MANIFEST_FILE), "utf8"), before, "the repair must record the path again");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a pinned tarball in the install cache anchors the acquisition without --tarball", async () => {
	const { repo, version, tarballPath } = await seedTarballRepo("invoice-vendor-cache-");
	try {
		const target = "noble-hashes/sha2.js";
		await unlistTarget(repo, target);
		const cacheDir = join(repo, "cache");
		await mkdir(cacheDir, { recursive: true });
		await copyFile(tarballPath, join(cacheDir, `hashes-${version}.tgz`));

		const result = runVendor(repo, ["--add-new"], { BUN_INSTALL_CACHE_DIR: cacheDir });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(join(repo, "vendor-src", target), "utf8"), "tarball sha2.js\n", "the cached tarball must be the acquisition source");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("cache discovery matches a pinned tarball by package name, not one exact filename", async () => {
	const { repo, version, tarballPath } = await seedTarballRepo("invoice-vendor-cachelayout-", { tamper: false });
	try {
		const target = "noble-hashes/sha2.js";
		await unlistTarget(repo, target);
		const cacheDir = join(repo, "cache");
		await mkdir(cacheDir, { recursive: true });
		// The pinned tarball under a name the fixed npm spelling does not cover: discovery matches it by package name, and the sha512 pin is what lets it through.
		const renamed = join(cacheDir, `noble-hashes-${version}.tgz`);
		await copyFile(tarballPath, renamed);
		assert.ok(
			cachedTarballCandidates("@noble/hashes", version, cacheDir).includes(renamed),
			"the lookup discovers a package-matching tarball beyond the fixed spelling",
		);

		const result = runVendor(repo, ["--add-new"], { BUN_INSTALL_CACHE_DIR: cacheDir });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(join(repo, "vendor-src", target), "utf8"), "tarball sha2.js\n", "the package-matching tarball must be the acquisition source");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("an unrelated tarball in the cache does not fail a routine run that falls back to node_modules", async () => {
	const { repo } = await seedTarballRepo("invoice-vendor-cache-noise-", { tamper: false });
	try {
		const cacheDir = join(repo, "cache");
		await mkdir(cacheDir, { recursive: true });
		// An archive whose name mentions @scure/base's bare name but matches no pin: discovery finds it, the pin rejects it, and it is skipped rather than aborting the run.
		await writeFile(join(cacheDir, "database-v2.tgz"), buildTarball([["package/index.js", "not a pinned archive\n"]]));

		const result = runVendor(repo, [], { BUN_INSTALL_CACHE_DIR: cacheDir });
		assert.equal(result.status, 0, result.stderr);
		assert.ok(!result.stderr.includes("no verified tarball"), "the run must fall back to node_modules rather than refuse");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a first-time acquisition with no verified tarball is refused and writes no manifest", async () => {
	const { repo } = await seedTarballRepo("invoice-vendor-notarball-", { tamper: false });
	try {
		const target = "noble-hashes/sha2.js";
		const before = await unlistTarget(repo, target);

		for (const args of [["--add-new"], ["--add-new", "--force"]]) {
			const result = runVendor(repo, args);
			assert.notEqual(result.status, 0, `${args.join(" ")} must refuse to acquire a new path from node_modules`);
			assert.match(result.stderr, /no verified tarball/, "the abort names the pinned tarball a first-time acquisition needs");
			assert.match(result.stderr, /never from the installed node_modules tree/, "the abort states that node_modules is not the acquisition source");
			assert.ok(!existsSync(join(repo, "vendor-src", target)), "the run must acquire nothing");
			assert.equal(readFileSync(join(repo, "vendor-src", MANIFEST_FILE), "utf8"), before, "the run must not rewrite SHA256SUMS");
		}
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a tarball whose sha512 disagrees with the pin is refused", async () => {
	const { repo, version } = await seedTarballRepo("invoice-vendor-wrongtarball-");
	try {
		const target = "noble-hashes/sha2.js";
		const before = await unlistTarget(repo, target);
		const wrong = buildTarball([["package/sha2.js", "not the pinned bytes\n"]]);
		const wrongPath = join(repo, "tarballs", `wrong-${version}.tgz`);
		await writeFile(wrongPath, wrong);

		const explicit = runVendor(repo, ["--add-new", "--tarball", wrongPath]);
		assert.notEqual(explicit.status, 0, "--tarball must refuse an archive that matches no pin");
		assert.match(explicit.stderr, /matches none of the pinned tarball sha512s/);

		const cacheDir = join(repo, "cache");
		await mkdir(cacheDir, { recursive: true });
		await writeFile(join(cacheDir, `hashes-${version}.tgz`), wrong);
		const cached = runVendor(repo, ["--add-new"], { BUN_INSTALL_CACHE_DIR: cacheDir });
		assert.notEqual(cached.status, 0, "a cache-resident tarball that disagrees with the pin must be refused rather than ignored");
		assert.match(cached.stderr, /does not match the pinned @noble\/hashes@/);
		assert.ok(cached.stderr.includes(join(cacheDir, `hashes-${version}.tgz`)), "the abort names the cache candidate it probed");

		assert.ok(!existsSync(join(repo, "vendor-src", target)), "no run may acquire from a tarball that failed its pin");
		assert.equal(readFileSync(join(repo, "vendor-src", MANIFEST_FILE), "utf8"), before, "no run may rewrite SHA256SUMS");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("the copy loop refuses a file a pinned tarball does not ship, naming the file", async () => {
	const { repo, tarballPath } = await seedTarballRepo("invoice-vendor-noship-", { omit: "utils.js" });
	try {
		const result = runVendor(repo, ["--tarball", tarballPath, "--allow-upstream-drift"]);
		assert.notEqual(result.status, 0, "a tarball that omits a vendored file must not be treated as complete");
		assert.match(result.stderr, /the pinned @noble\/hashes@2\.4\.0 tarball does not ship utils\.js/, "the abort names the file the tarball omits");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("--tarball=<path> is recognized and two paths for one package are refused", async () => {
	const { repo, tarballPath } = await seedTarballRepo("invoice-vendor-tarball-args-");
	try {
		const duplicate = runVendor(repo, ["--tarball", tarballPath, "--tarball", tarballPath]);
		assert.notEqual(duplicate.status, 0, "two --tarball paths matching the same pin must be refused");
		assert.match(duplicate.stderr, /pass one tarball per package/);

		const target = "noble-hashes/sha2.js";
		await unlistTarget(repo, target);
		const acquired = runVendor(repo, ["--add-new", `--tarball=${tarballPath}`]);
		assert.equal(acquired.status, 0, acquired.stderr);
		assert.equal(readFileSync(join(repo, "vendor-src", target), "utf8"), "tarball sha2.js\n", "the --tarball=<path> form must anchor the acquisition");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a resolvable tarball anchors the whole tree, catching a re-blessed hand-edit against it", async () => {
	const { repo, tarballPath } = await seedTarballRepo("invoice-vendor-tarball-drift-");
	try {
		await writeFile(join(repo, "vendor-src", "noble-hashes", "sha3.js"), "hand-edited\n");
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });

		const result = runVendor(repo, ["--tarball", tarballPath]);
		assert.notEqual(result.status, 0, "a re-blessed hand-edit must still be caught against the tarball");
		assert.match(result.stderr, /does not match its pinned upstream bytes/);
		assert.match(result.stderr, /vendor-src\/noble-hashes\/sha3\.js does not match the pinned @noble\/hashes@/, "the abort names the tarball the tree diverges from");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("the tarball reader reads committed real-world archives it did not generate", () => {
	// Bytes written by GNU tar, not by the fixture builder, so the reader is exercised against headers its own assumptions did not produce.
	const gnu = extractTarball(join(root, "tests", "fixtures", "gnu-longname.tgz"));
	assert.equal(gnu.get("plain.txt").toString("utf8"), "gnu plain\n");
	assert.equal(gnu.get("dir/inside.txt").toString("utf8"), "inside dir\n");
	assert.equal(
		gnu.get(`src/${"a".repeat(90)}/file.txt`).toString("utf8"),
		"gnu long name payload\n",
		"a GNU long-name ('L') override names the entry",
	);
	assert.ok(!gnu.has("link.txt"), "a symlink entry is skipped, not read as file content");

	const pax = extractTarball(join(root, "tests", "fixtures", "pax-longname.tgz"));
	assert.equal(pax.get("plain.txt").toString("utf8"), "pax plain\n");
	assert.equal(
		pax.get(`${"b".repeat(110)}.txt`).toString("utf8"),
		"pax long name payload\n",
		"a pax ('x') path override names the entry",
	);
});

test("--tarball refuses a directory by name instead of failing with a raw EISDIR", async () => {
	const repo = await mkdtemp(join(tmpdir(), "invoice-vendor-tarball-dir-"));
	try {
		await copyVendorScripts(repo);
		const directory = join(repo, "tarballs");
		await mkdir(directory, { recursive: true });

		const result = runVendor(repo, ["--tarball", directory]);
		assert.notEqual(result.status, 0, "a --tarball directory must be refused");
		assert.match(result.stderr, /is not a regular file/, "the refusal names the reason rather than a raw EISDIR");
		assert.ok(!result.stderr.includes("EISDIR"), "the reader must not reach a raw EISDIR");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("--tarball refuses a pinned package no SOURCES entry vendors rather than ignoring it", async () => {
	const repo = await mkdtemp(join(tmpdir(), "invoice-vendor-unvendored-"));
	try {
		await copyVendorScripts(repo);
		// A pin for a package the vendoring script does not copy: the path could never be read, so it is refused by name instead of being accepted and dropped.
		const tarball = buildTarball([["package/index.js", "stray\n"]]);
		const pinsPath = join(repo, "scripts", "vendor-pins.mjs");
		const injected = `\t{ name: "not-vendored", version: "1.0.0", integrity: "${integrityOf(tarball)}" },`;
		await writeFile(pinsPath, readFileSync(pinsPath, "utf8").replace("export const VENDOR_PINS = [", `export const VENDOR_PINS = [\n${injected}`));
		const tarballPath = join(repo, "stray.tgz");
		await writeFile(tarballPath, tarball);

		const result = runVendor(repo, ["--tarball", tarballPath]);
		assert.notEqual(result.status, 0, "a --tarball for a pinned-but-unvendored package must be refused");
		assert.match(result.stderr, /no SOURCES entry vendors/, "the abort says the pin names no vendored package");
		assert.match(result.stderr, /not-vendored@1\.0\.0/, "the abort names the pin it matched");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a guard a run would hit is reported even when the cache holds a mismatched archive for that package", async () => {
	const { repo, version } = await seedTarballRepo("invoice-vendor-guard-precedence-", { tamper: false });
	try {
		await unlistTarget(repo, "noble-hashes/sha2.js");
		const cacheDir = join(repo, "cache");
		await mkdir(cacheDir, { recursive: true });
		// A fixed-spelling archive whose bytes disagree with the pin: an acquisition that read it would abort, but this plain run acquires nothing, so the --add-new guard is what it must report.
		await writeFile(join(cacheDir, `hashes-${version}.tgz`), buildTarball([["package/sha2.js", "not the pinned bytes\n"]]));

		const result = runVendor(repo, [], { BUN_INSTALL_CACHE_DIR: cacheDir });
		assert.notEqual(result.status, 0, "the run must still refuse the unlisted path");
		assert.match(result.stderr, /--add-new/, "the reported refusal is the guard, not the mismatched cache candidate");
		assert.ok(!result.stderr.includes("does not match the pinned @noble/hashes"), "the cache probe must not pre-empt the guard message");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("the build refuses a vendor-src/ tree holding a symlink instead of hashing and publishing it", async () => {
	const repo = await mkdtemp(join(tmpdir(), "invoice-build-symlink-"));
	try {
		await mkdir(join(repo, "scripts"), { recursive: true });
		await copyFile(join(root, "build.mjs"), join(repo, "build.mjs"));
		await copyFile(join(root, "scripts", "vendor-manifest.mjs"), join(repo, "scripts", "vendor-manifest.mjs"));
		const vendorDir = join(repo, "vendor-src");
		await mkdir(vendorDir, { recursive: true });
		await writeFile(join(vendorDir, "a.js"), "regular\n");
		// The tree is blessed while it holds only regular files, then the link is planted: the manifest can no longer be computed over it, so the build's provenance check refuses before it copies a byte.
		await blessManifest({ dir: vendorDir, force: true });
		await writeFile(join(repo, "outside.txt"), "outside\n");
		await symlink(join(repo, "outside.txt"), join(vendorDir, "b.js"));

		const result = spawnSync(process.execPath, [join(repo, "build.mjs")], {
			cwd: repo,
			encoding: "utf8",
			env: { ...process.env, BUILD_OUT_ROOT: join(repo, "out") },
		});
		assert.notEqual(result.status, 0, "build must exit non-zero on a symlinked vendor entry");
		assert.match(result.stderr, /vendor-src\/b\.js is not a regular file/, "the refusal names the linked entry");
		assert.ok(!result.stderr.includes("EISDIR"), "the tree hash must not reach a raw EISDIR");
		assert.ok(!existsSync(join(repo, "out", "app", "js", "vendor", "a.js")), "the build must publish nothing from a tree holding a symlink");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("the build refuses a symlink in a source tree it copies", async () => {
	const repo = await mkdtemp(join(tmpdir(), "invoice-build-copy-symlink-"));
	try {
		await mkdir(join(repo, "scripts"), { recursive: true });
		await mkdir(join(repo, "vendor-src"), { recursive: true });
		await mkdir(join(repo, "assets-src", "images"), { recursive: true });
		await copyFile(join(root, "build.mjs"), join(repo, "build.mjs"));
		await copyFile(join(root, "scripts", "vendor-manifest.mjs"), join(repo, "scripts", "vendor-manifest.mjs"));
		await writeFile(join(repo, "vendor-src", "a.js"), "regular\n");
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		// A symlink that the manifest check cannot see, because it is not inside vendor-src/: the copy loop's own guard is what refuses it.
		await writeFile(join(repo, "assets-src", "images", "logo.svg"), "<svg></svg>\n");
		await writeFile(join(repo, "outside.txt"), "outside\n");
		await symlink(join(repo, "outside.txt"), join(repo, "assets-src", "images", "link.svg"));

		const result = spawnSync(process.execPath, [join(repo, "build.mjs")], {
			cwd: repo,
			encoding: "utf8",
			env: { ...process.env, BUILD_OUT_ROOT: join(repo, "out") },
		});
		assert.notEqual(result.status, 0, "build must exit non-zero on a symlink in a copied source tree");
		assert.match(result.stderr, /images source holds a symlink \(assets-src\/images\/link\.svg\)/);
		assert.ok(!existsSync(join(repo, "out", "app", "images", "logo.svg")), "the build must publish nothing from a tree holding a symlink");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("resolveVerifiedTarball bounds the bytes it reads, refusing an oversized fixed-spelling candidate and skipping a discovered one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-tarball-oversize-"));
	try {
		const version = pinFor("@noble/hashes").version;
		const archive = buildTarball([["package/sha2.js", "x\n"]]);
		// A tiny maxBytes stands in for TARBALL_BYTE_CAP so the case exercises the cap branch without a 64 MiB file.
		const spelling = join(dir, `hashes-${version}.tgz`);
		await writeFile(spelling, archive);
		assert.throws(
			() => resolveVerifiedTarball("@noble/hashes", { cacheDir: dir, maxBytes: 1 }),
			(error) => {
				assert.match(error.message, /over the 1-byte cap for the pinned @noble\/hashes@/);
				assert.ok(error.message.includes(spelling), "the abort names the oversized fixed-spelling candidate");
				return true;
			},
			"a fixed-spelling candidate over the cap is refused rather than read",
		);

		await rm(spelling);
		await writeFile(join(dir, `unrelated-noble-hashes-${version}.tgz`), archive);
		assert.equal(
			resolveVerifiedTarball("@noble/hashes", { cacheDir: dir, maxBytes: 1 }),
			null,
			"a name-substring candidate over the cap is skipped, so a listed path falls back to node_modules",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the provenance hash refuses a non-regular tree entry instead of hashing through it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-hashtree-link-"));
	try {
		await writeFile(join(dir, "a.js"), "regular\n");
		await writeFile(join(dir, "outside.txt"), "outside\n");
		await symlink(join(dir, "outside.txt"), join(dir, "b.js"));
		await assert.rejects(
			hashTree(dir),
			(error) => {
				assert.match(error.message, /\/b\.js is not a regular file/, "the refusal names the linked entry");
				return true;
			},
			"a symlinked entry is refused rather than hashed through the link",
		);
		await assert.rejects(
			blessManifest({ dir, force: true }),
			/is not a regular file/,
			"a digest computed through a link can never be blessed into a manifest",
		);

		await rm(join(dir, "b.js"));
		await mkdir(join(dir, "subdir"));
		await symlink(join(dir, "subdir"), join(dir, "c.js"));
		await assert.rejects(
			hashTree(dir),
			(error) => {
				assert.ok(!error.message.includes("EISDIR"), "a link to a directory is named rather than reaching a raw EISDIR");
				assert.match(error.message, /\/c\.js is not a regular file/);
				return true;
			},
			"a link to a directory is refused by name instead of aborting the read",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extractTarballBytes refuses an archive that expands past the decompressed cap", () => {
	// A tiny cap stands in for DECOMPRESSED_BYTE_CAP so the case needs no multi-hundred-MiB archive.
	const archive = buildTarball([["package/a.js", "x".repeat(4096)]]);
	assert.throws(
		() => extractTarballBytes(archive, "fixture.tgz", { maxBytes: 512 }),
		/expands past the 512-byte cap on decompressed output/,
		"an over-expanding archive is refused rather than decompressed whole",
	);
	assert.deepEqual(
		[...extractTarballBytes(archive, "fixture.tgz", { maxBytes: 8192 }).keys()],
		["a.js"],
		"an archive inside the cap still reads",
	);
	assert.ok(
		DECOMPRESSED_BYTE_CAP >= TARBALL_BYTE_CAP,
		"the decompressed cap must not be tighter than the byte cap, so no pinned archive is refused for its size alone",
	);
	assert.ok(extractTarball(join(root, "tests", "fixtures", "gnu-longname.tgz")).has("plain.txt"), "a committed real-world archive stays inside the default cap");
});

test("a cache candidate that is not a regular file is refused by name rather than read", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-tarball-irregular-"));
	try {
		const version = pinFor("@noble/hashes").version;
		const spelling = join(dir, `hashes-${version}.tgz`);
		await mkdir(spelling);
		assert.throws(
			() => resolveVerifiedTarball("@noble/hashes", { cacheDir: dir }),
			(error) => {
				assert.match(error.message, /is a directory, not a regular file/);
				assert.ok(error.message.includes(spelling), "the abort names the irregular candidate it probed");
				assert.ok(!error.message.includes("EISDIR"), "the refusal is named rather than a raw EISDIR");
				return true;
			},
			"a directory at a fixed-spelling cache path is refused before it is read",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}

	// A FIFO at that path would block the read until a writer appears, so the refusal is proven through a spawned run that must not hang.
	const { repo, version } = await seedTarballRepo("invoice-vendor-cache-fifo-");
	try {
		await unlistTarget(repo, "noble-hashes/sha2.js");
		const cacheDir = join(repo, "cache");
		await mkdir(cacheDir, { recursive: true });
		const fifo = join(cacheDir, `hashes-${version}.tgz`);
		assert.equal(spawnSync("mkfifo", [fifo]).status, 0, "the fixture needs mkfifo to plant a FIFO");
		const result = spawnSync(process.execPath, [join(repo, "scripts", "fetch-vendor.mjs"), "--add-new"], {
			cwd: repo,
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, BUN_INSTALL_CACHE_DIR: cacheDir },
		});
		assert.equal(result.error, undefined, "the run must refuse the FIFO rather than block on it");
		assert.notEqual(result.status, 0, "the run must refuse a FIFO at a probed cache path");
		assert.match(result.stderr, /is a FIFO, not a regular file/);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("paxData length-prefixes every record with the record's full length", () => {
	for (const value of ["", "a", "a".repeat(91), "a".repeat(150)]) {
		const text = paxData([["path", value]]).toString("utf8");
		const space = text.indexOf(" ");
		assert.notEqual(space, -1, "the record must carry a length prefix");
		assert.equal(Number(text.slice(0, space)), text.length, `a ${value.length}-char value needs a prefix equal to the record length`);
		assert.equal(text.slice(space + 1), `path=${value}\n`, "the record body is unchanged by the prefix computation");
	}
});
