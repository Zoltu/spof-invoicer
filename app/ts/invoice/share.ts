/**
 * The URL-fragment layer of the share format.
 *
 * A shared link is `<page>#/i/<base32>`, where the payload is the bare base32 container that `invoice/codec.ts` writes; a standalone blob (`pinv1b-…`) carries that same container for pasting outside a URL.
 * This module is the single place that knows the fragment spelling: it builds the fragment a link carries (and the full URL around it), and reads a share string of any form back, so the router and the codec cannot drift.
 * The container format itself lives entirely in `codec.ts`, which knows nothing of URLs.
 */

import { describe, preview } from "../util/errors.js";
import { ShareFormatError, decodeInvoice, decodeInvoiceBlob, encodeInvoice, isShareBlob } from "./codec.js";
import type { Invoice } from "./model.js";

/** The route a shared link carries its payload on: `#/i/<payload>`. */
export const SHARE_FRAGMENT_PREFIX = "#/i/";

/** The fragment route without its leading `#`, e.g. `/i/`. */
const FRAGMENT_ROUTE = SHARE_FRAGMENT_PREFIX.slice(1);

/** The bare route root, e.g. `/i`, which is the share route with no payload. */
const FRAGMENT_ROOT = FRAGMENT_ROUTE.slice(0, -1);

/** The `#/i/<payload>` fragment that a link to `invoice` carries. */
export function encodeShare(invoice: Invoice): string {
	return SHARE_FRAGMENT_PREFIX + encodeInvoice(invoice);
}

/**
 * Read a share string of any form into an invoice: a link's `#/i/<payload>` fragment, a standalone blob, or a bare payload.
 *
 * Accepts any value: anything that is not a string is refused with a `ShareFormatError`.
 * Returns `null` when the text is a fragment on some other route, so the router can fall through to its remaining routes.
 * Everything else is handed to the container decoder — {@link decodeInvoice}, or {@link decodeInvoiceBlob} for a blob — so its failures are the ones that surface here: a `ShareFormatError` (the container is broken, including a legacy `pinv1-…` base64url blob, which is refused by name), an `InvalidInvoiceError` (the JSON is well-formed but is not a valid invoice), an `UnsupportedInvoiceVersionError` (the JSON names a schema version this build does not read), or, for a blob whose prefix names another version, an `UnsupportedShareVersionError`.
 */
export function decodeShare(text: unknown): Invoice | null {
	if (typeof text !== "string") {
		throw new ShareFormatError(`expected a share string, got ${preview(text)}`);
	}
	// Classify on the trimmed text so a whitespace-wrapped blob still routes to the blob decoder and its prefix earns the specific refusal; a bare payload keeps the text as given, so padding still reads as malformed rather than being silently decoded.
	const normalized = text.trim();
	if (normalized.startsWith("#")) {
		const payload = shareFragmentPayload(text);
		return payload === null ? null : decodeInvoice(payload);
	}
	return isShareBlob(normalized) ? decodeInvoiceBlob(normalized) : decodeInvoice(text);
}

/**
 * The shareable URL for an invoice: `baseUrl` with everything from its first `#` replaced by the fragment carrying the payload.
 * The payload is base32, which needs no escaping, so the link is byte-for-byte what {@link encodeShare} produced and stays inside the fragment.
 *
 * Accepts any value: a base URL that is not a string is refused with a `TypeError`.
 */
export function buildShareUrl(invoice: Invoice, baseUrl: unknown): string {
	if (typeof baseUrl !== "string") {
		throw new TypeError(`share: the base URL must be a string, got ${describe(baseUrl)}`);
	}
	const hashAt = baseUrl.indexOf("#");
	const base = hashAt === -1 ? baseUrl : baseUrl.slice(0, hashAt);
	return base + encodeShare(invoice);
}

/** The payload a `#/i/<payload>` fragment carries, or `null` when the hash names another route. */
function shareFragmentPayload(hash: string): string | null {
	const path = hash.trim().replace(/^#/, "");
	if (path === FRAGMENT_ROOT) {
		return "";
	}
	return path.startsWith(FRAGMENT_ROUTE) ? path.slice(FRAGMENT_ROUTE.length) : null;
}
