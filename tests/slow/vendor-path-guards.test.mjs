/**
 * The suite for the entry guard every path `bun run vendor` and the build's vendor check read or write passes: the committed manifest, bun.lock, each installed source file, each vendored copy, every destination component, and a caller-named tarball path.
 * Each case plants an entry a plain read would follow, block on or abort on — a symlink, a FIFO, a directory, an oversized file — and asserts the named refusal instead of a hung run, a raw EISDIR or a write outside `vendor-src/`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { vendorTreeProblems } from "../../build.mjs";
import { SOURCE_FILE_BYTE_CAP, blessManifest } from "../../scripts/fetch-vendor.mjs";
import { MANIFEST_FILE, readManifest } from "../../scripts/vendor-manifest.mjs";
import { extractTarball } from "../../scripts/vendor-tarball.mjs";
import { buildTarball } from "../helpers/tarball-fixtures.mjs";
import { copyVendorScripts, emptyCacheDir, runVendor, seedSources } from "../helpers/vendor-repo.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A repo whose installed and vendored bytes agree and whose committed manifest lists them, so a plain run has nothing to report and only the path guard under test can stop it.
async function seedRepo(prefix) {
	const repo = await mkdtemp(join(tmpdir(), prefix));
	await copyVendorScripts(repo);
	await seedSources(repo, {
		installed: (source, from) => `vendored ${source.pkg}/${from}\n`,
		vendored: (source, from) => `vendored ${source.pkg}/${from}\n`,
	});
	await blessManifest({ dir: join(repo, "vendor-src"), force: true });
	return repo;
}

// A spawned run with its own timeout, so a path guard that failed to fire fails the case as a refusal assertion rather than hanging the suite.
function spawnVendor(repo, args = []) {
	return spawnSync(process.execPath, [join(repo, "scripts", "fetch-vendor.mjs"), ...args], {
		cwd: repo,
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, BUN_INSTALL_CACHE_DIR: emptyCacheDir(repo) },
	});
}

test("a symlink planted at the committed manifest is refused and never written through", async () => {
	const repo = await seedRepo("invoice-path-manifest-link-");
	try {
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		const outside = join(repo, "outside.txt");
		await writeFile(outside, "# outside\n");
		await rm(manifestPath);
		await symlink(outside, manifestPath);

		// --force is the run that would rewrite the manifest, so it is the one this guard has to stop.
		const result = runVendor(repo, ["--force"]);
		assert.notEqual(result.status, 0, "a symlinked manifest must be refused even by a re-blessing run");
		assert.match(result.stderr, /SHA256SUMS is not a regular file/, "the abort names the linked manifest path");
		assert.equal(readFileSync(outside, "utf8"), "# outside\n", "the run must not rewrite the file the link points at");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a FIFO planted at the committed manifest is refused instead of blocking the run", async () => {
	const repo = await seedRepo("invoice-path-manifest-fifo-");
	try {
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		await rm(manifestPath);
		assert.equal(spawnSync("mkfifo", [manifestPath]).status, 0, "the fixture needs mkfifo to plant a FIFO");

		const result = spawnVendor(repo, ["--force"]);
		assert.equal(result.error, undefined, "the run must refuse the FIFO rather than block on it");
		assert.notEqual(result.status, 0, "a FIFO at the manifest path must be refused");
		assert.match(result.stderr, /SHA256SUMS is not a regular file/, "the abort names the irregular manifest path");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("readManifest refuses a manifest that is not a regular file and bounds the bytes it reads", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-path-manifest-read-"));
	try {
		assert.equal(await readManifest(dir), null, "an absent manifest reads as null rather than as a failure");
		await writeFile(join(dir, "a.js"), "regular\n");
		await blessManifest({ dir, force: true });
		assert.ok((await readManifest(dir)).length > 0, "a committed manifest is read");

		await assert.rejects(
			() => readManifest(dir, { maxBytes: 4 }),
			/over the 4-byte cap for a manifest/,
			"an oversized manifest is refused rather than read whole",
		);

		const outside = join(dir, "outside.txt");
		await writeFile(outside, "# outside\n");
		const manifestPath = join(dir, MANIFEST_FILE);
		await rm(manifestPath);
		await symlink(outside, manifestPath);
		await assert.rejects(() => readManifest(dir), /is not a regular file/, "a symlinked manifest is refused rather than read through the link");

		await rm(manifestPath);
		await mkdir(manifestPath);
		await assert.rejects(
			() => readManifest(dir),
			(error) => {
				assert.match(error.message, /is not a regular file/);
				assert.ok(!error.message.includes("EISDIR"), "the refusal is named rather than a raw EISDIR");
				return true;
			},
			"a directory at the manifest path is refused by name",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("blessManifest refuses to write the manifest through a planted symlink", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-path-bless-link-"));
	try {
		await writeFile(join(dir, "x.js"), "v1\n");
		const outside = join(dir, "outside.txt");
		await writeFile(outside, "# outside\n");
		await symlink(outside, join(dir, MANIFEST_FILE));

		await assert.rejects(
			() => blessManifest({ dir, force: true }),
			/SHA256SUMS is not a regular file.*refusing to write through it/,
			"a re-bless must not land in the link's target",
		);
		assert.equal(readFileSync(outside, "utf8"), "# outside\n", "the blessing must not be written through the link");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the build's provenance check refuses a manifest that is not a regular file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-path-build-manifest-"));
	try {
		await writeFile(join(dir, "a.js"), "regular\n");
		await blessManifest({ dir, force: true });
		const outside = join(dir, "outside.txt");
		await writeFile(outside, "# outside\n");
		const manifestPath = join(dir, MANIFEST_FILE);
		await rm(manifestPath);
		await symlink(outside, manifestPath);

		await assert.rejects(
			() => vendorTreeProblems(dir),
			/is not a regular file/,
			"the build must not hash the tree against a manifest reached through a link",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the lockfile read refuses a FIFO instead of blocking and an oversized file instead of reading it whole", async () => {
	const repo = await seedRepo("invoice-path-lock-");
	try {
		const lockPath = join(repo, "bun.lock");
		await rm(lockPath);
		assert.equal(spawnSync("mkfifo", [lockPath]).status, 0, "the fixture needs mkfifo to plant a FIFO");

		const blocked = spawnVendor(repo);
		assert.equal(blocked.error, undefined, "the run must refuse the FIFO rather than block on it");
		assert.notEqual(blocked.status, 0, "a FIFO at the lockfile path must be refused");
		assert.match(blocked.stderr, /bun\.lock is not a regular file/, "the abort names the irregular lockfile");

		await rm(lockPath);
		await writeFile(lockPath, "");
		await truncate(lockPath, SOURCE_FILE_BYTE_CAP + 1);
		const oversized = runVendor(repo);
		assert.notEqual(oversized.status, 0, "an oversized lockfile must be refused");
		assert.match(oversized.stderr, /bun\.lock is \d+ bytes, over the \d+-byte cap for a file this run reads/, "the abort names the cap");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a directory planted at an installed source file is refused by name rather than aborting on the read", async () => {
	const repo = await seedRepo("invoice-path-source-dir-");
	try {
		const target = join(repo, "node_modules", "@noble", "hashes", "utils.js");
		await rm(target);
		await mkdir(target);

		const result = runVendor(repo);
		assert.notEqual(result.status, 0, "a directory at an installed source path must be refused");
		assert.match(result.stderr, /node_modules\/@noble\/hashes\/utils\.js is not a regular file/, "the abort names the entry");
		assert.ok(!result.stderr.includes("EISDIR"), "the refusal is named rather than a raw EISDIR");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a FIFO planted at an installed source file is refused instead of blocking the run", async () => {
	const repo = await seedRepo("invoice-path-source-fifo-");
	try {
		const target = join(repo, "node_modules", "pdf-lib", "dist", "pdf-lib.esm.js");
		await rm(target);
		assert.equal(spawnSync("mkfifo", [target]).status, 0, "the fixture needs mkfifo to plant a FIFO");

		const result = spawnVendor(repo);
		assert.equal(result.error, undefined, "the run must refuse the FIFO rather than block on it");
		assert.notEqual(result.status, 0, "a FIFO at an installed source path must be refused");
		assert.match(result.stderr, /node_modules\/pdf-lib\/dist\/pdf-lib\.esm\.js is not a regular file/, "the abort names the entry");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("an installed source file over the read cap is refused without being read", async () => {
	const repo = await seedRepo("invoice-path-source-oversize-");
	try {
		const target = join(repo, "node_modules", "pdf-lib", "LICENSE.md");
		await writeFile(target, "");
		await truncate(target, SOURCE_FILE_BYTE_CAP + 1);

		const result = runVendor(repo);
		assert.notEqual(result.status, 0, "an installed source file over the read cap must be refused");
		assert.match(
			result.stderr,
			/node_modules\/pdf-lib\/LICENSE\.md is \d+ bytes, over the \d+-byte cap for a file this run reads/,
			"the abort names the file and the cap rather than reading it whole",
		);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a directory planted at a vendored copy is refused by name rather than aborting the cross-check", async () => {
	const repo = await seedRepo("invoice-path-vendored-dir-");
	try {
		const target = join(repo, "vendor-src", "pdf-lib", "pdf-lib.esm.js");
		await rm(target);
		await mkdir(target);

		const result = runVendor(repo);
		assert.notEqual(result.status, 0, "a non-regular vendored copy must stop the run");
		assert.match(result.stderr, /vendor-src\/pdf-lib\/pdf-lib\.esm\.js is not a regular file/, "the abort names the entry");
		assert.ok(!result.stderr.includes("EISDIR"), "the refusal is named rather than a raw EISDIR");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("the copy loop refuses a SOURCES name whose intermediate destination directory is a symlink", async () => {
	const repo = await seedRepo("invoice-path-nested-destination-");
	try {
		// One SOURCES name gains a second path segment, so its destination sits under a subdirectory of its own rather than directly under vendor-src/<dir>.
		const scriptPath = join(repo, "scripts", "fetch-vendor.mjs");
		const script = readFileSync(scriptPath, "utf8");
		const patched = script.replace(`["LICENSE.md", "LICENSE.md"],`, `["LICENSE.md", "nested/LICENSE.md"],`);
		assert.notEqual(patched, script, "the fixture must patch a SOURCES name to a nested destination");
		await writeFile(scriptPath, patched);

		const nested = join(repo, "vendor-src", "pdf-lib", "nested");
		await rm(join(repo, "vendor-src", "pdf-lib", "LICENSE.md"));
		await mkdir(nested, { recursive: true });
		await writeFile(join(nested, "LICENSE.md"), "vendored pdf-lib/LICENSE.md\n");
		await blessManifest({ dir: join(repo, "vendor-src"), force: true, addNew: true });

		// The bytes behind the link differ from the installed copy, so a run that wrote through it would land them in outside/LICENSE.md.
		const outside = join(repo, "outside");
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "LICENSE.md"), "outside\n");
		await rm(nested, { recursive: true, force: true });
		await symlink(outside, nested);

		const result = runVendor(repo, ["--force", "--allow-upstream-drift"]);
		assert.notEqual(result.status, 0, "a symlinked intermediate destination directory must be refused");
		assert.match(result.stderr, /vendor-src\/pdf-lib\/nested is not a directory/, "the abort names the linked component");
		assert.equal(readFileSync(join(outside, "LICENSE.md"), "utf8"), "outside\n", "the run must not write through the symlinked directory");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("extractTarball refuses a path that is not a regular file and bounds the archive it reads", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-path-extract-"));
	try {
		const archive = join(dir, "fixture.tgz");
		await writeFile(archive, buildTarball([["package/a.js", "one\n"]]));
		assert.deepEqual([...extractTarball(archive).keys()], ["a.js"], "an archive inside the cap still reads");
		assert.throws(
			() => extractTarball(archive, { maxBytes: 4 }),
			/over the 4-byte cap for a pinned package tarball/,
			"an archive over the cap is refused rather than read whole",
		);
		assert.throws(
			() => extractTarball(dir),
			(error) => {
				assert.match(error.message, /is a directory, not a regular file/);
				assert.ok(!error.message.includes("EISDIR"), "the refusal is named rather than a raw EISDIR");
				return true;
			},
			"a directory is refused by name",
		);
		assert.throws(() => extractTarball(join(dir, "missing.tgz")), /does not exist/, "an absent path is refused by name");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
