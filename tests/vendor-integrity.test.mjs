/** The suite for the vendor guards: the pinned `node_modules` byte comparison, the lockfile integrity pins, and the overrides that reach the overwrite and re-bless guards. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveOutRoot, vendorTreeProblems } from "../build.mjs";
import { SOURCES, blessManifest, upstreamProblems } from "../scripts/fetch-vendor.mjs";
import { MANIFEST_FILE, parseManifest, sha256 } from "../scripts/vendor-manifest.mjs";
import { checkLockPins, pinFor, VENDOR_PINS } from "../scripts/vendor-pins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockText = readFileSync(join(root, "bun.lock"), "utf8");

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
	const problems = await upstreamProblems();
	assert.deepEqual(problems, [], problems.join("; "));
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

test("the vendor run refuses an installed tree that diverges from the committed vendor-src, --force included", async () => {
	const repo = await mkdtemp(join(tmpdir(), "invoice-vendor-cross-check-"));
	try {
		await mkdir(join(repo, "scripts"), { recursive: true });
		for (const name of ["fetch-vendor.mjs", "vendor-manifest.mjs", "vendor-pins.mjs"]) {
			await copyFile(join(root, "scripts", name), join(repo, "scripts", name));
		}
		await copyFile(join(root, "bun.lock"), join(repo, "bun.lock"));
		// A minimal installed tree whose bytes differ from the committed vendor-src copies: the cross-check must catch the divergence before the copy loop can re-bless it.
		for (const source of SOURCES) {
			await mkdir(join(repo, "node_modules", source.pkg), { recursive: true });
			await writeFile(join(repo, "node_modules", source.pkg, "package.json"), JSON.stringify({ version: pinFor(source.pkg).version }));
			for (const [from, name] of source.files) {
				await mkdir(dirname(join(repo, "node_modules", source.pkg, from)), { recursive: true });
				await writeFile(join(repo, "node_modules", source.pkg, from), `installed ${from}\n`);
				await mkdir(dirname(join(repo, "vendor-src", source.dir, name)), { recursive: true });
				await writeFile(join(repo, "vendor-src", source.dir, name), `committed ${name}\n`);
			}
		}
		const run = (args) =>
			spawnSync(process.execPath, [join(repo, "scripts", "fetch-vendor.mjs"), ...args], { cwd: repo, encoding: "utf8" });

		const routine = run([]);
		assert.notEqual(routine.status, 0, "a routine vendor run must abort on a divergence");
		assert.match(routine.stderr, /does not match the installed node_modules bytes/);
		assert.match(routine.stderr, /vendor-src\/pdf-lib\/pdf-lib\.esm\.js/, "the abort names a file that diverged");

		const forced = run(["--force"]);
		assert.notEqual(forced.status, 0, "--force alone must not bypass the installed-bytes cross-check");
		assert.match(forced.stderr, /does not match the installed node_modules bytes/);

		const overridden = run(["--force", "--allow-upstream-drift"]);
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
		await mkdir(join(repo, "scripts"), { recursive: true });
		for (const name of ["fetch-vendor.mjs", "vendor-manifest.mjs", "vendor-pins.mjs"]) {
			await copyFile(join(root, "scripts", name), join(repo, "scripts", name));
		}
		await copyFile(join(root, "bun.lock"), join(repo, "bun.lock"));
		// node_modules holds the pinned bytes while vendor-src/ was hand-edited and its manifest re-blessed to match: only the upstream cross-check can see that divergence.
		for (const source of SOURCES) {
			await mkdir(join(repo, "node_modules", source.pkg), { recursive: true });
			await writeFile(join(repo, "node_modules", source.pkg, "package.json"), JSON.stringify({ version: pinFor(source.pkg).version }));
			for (const [from, name] of source.files) {
				await mkdir(dirname(join(repo, "node_modules", source.pkg, from)), { recursive: true });
				await writeFile(join(repo, "node_modules", source.pkg, from), `pinned ${from}\n`);
				await mkdir(dirname(join(repo, "vendor-src", source.dir, name)), { recursive: true });
				await writeFile(join(repo, "vendor-src", source.dir, name), `hand-edited ${name}\n`);
			}
		}
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		const run = (args) =>
			spawnSync(process.execPath, [join(repo, "scripts", "fetch-vendor.mjs"), ...args], { cwd: repo, encoding: "utf8" });

		const routine = run([]);
		assert.notEqual(routine.status, 0, "a routine run must abort on the hand-edit");
		assert.match(routine.stderr, /does not match the installed node_modules bytes/);
		assert.match(routine.stderr, /--force/, "the abort names --force, which the drift override alone does not replace");
		assert.match(routine.stderr, /vendor-src\/pdf-lib\/pdf-lib\.esm\.js/, "the abort names the hand-edited file");

		const driftOnly = run(["--allow-upstream-drift"]);
		assert.notEqual(driftOnly.status, 0, "--allow-upstream-drift alone still stops at the per-file overwrite guard");
		assert.match(driftOnly.stderr, /no longer matches the blessed vendor-src/);

		const forcedOnly = run(["--force"]);
		assert.notEqual(forcedOnly.status, 0, "--force alone must not bypass the cross-check");
		assert.match(forcedOnly.stderr, /does not match the installed node_modules bytes/);

		const both = run(["--force", "--allow-upstream-drift"]);
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

test("vendor refuses to re-bless a drifted tree without an explicit --force", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-vendor-bless-"));
	try {
		await writeFile(join(dir, "x.js"), "v1\n");
		await blessManifest({ dir });
		assert.equal(parseManifest(readFileSync(join(dir, MANIFEST_FILE), "utf8")).get("x.js"), sha256(Buffer.from("v1\n")));

		await writeFile(join(dir, "x.js"), "v2\n");
		await assert.rejects(blessManifest({ dir }), /refusing to re-bless/);

		await blessManifest({ dir, force: true });
		assert.equal(parseManifest(readFileSync(join(dir, MANIFEST_FILE), "utf8")).get("x.js"), sha256(Buffer.from("v2\n")));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
