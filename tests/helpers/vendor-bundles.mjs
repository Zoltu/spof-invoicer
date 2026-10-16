/** The vendored ES-module bundles, derived from `scripts/fetch-vendor.mjs` SOURCES so the per-bundle scans in tests/slow/vendor.test.mjs and tests/slow/acceptance.test.mjs and the smoke test that imports every bundle walk the same list. */

import { SOURCES } from "../../scripts/fetch-vendor.mjs";

/** Every `.js` bundle `bun run vendor` copies into `vendor-src/`, as slash-joined `vendor-src/`-relative paths. */
export const SERVED_BUNDLES = SOURCES.flatMap(({ dir, files }) =>
	files.map(([, name]) => `${dir}/${name}`),
).filter((file) => file.endsWith(".js"));
