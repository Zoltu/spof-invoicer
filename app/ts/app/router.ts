/**
 * Fragment routing.
 *
 * The whole app state is in `location.hash`, so an invoice link is the only thing a payee has to send and the payload never leaves the browser: the fragment is not sent to any server, there is no network I/O anywhere in this module, and a shared link is just `<page>#/i/<payload>`.
 *
 * Three routes exist: `create` (no fragment, `#/`, or `#/create`), `view` (`#/i/<payload>`, decoded through `invoice/share.ts`), and `error` (any fragment that is not one of those).
 * {@link parseHash} never throws — a hostile, truncated, oversized, or simply unknown fragment becomes an `error` route carrying a bounded message that the shell shows as the create view with a notice.
 */

import type { Invoice } from "../invoice/model.js";
import { SHARE_FRAGMENT_PREFIX, decodeShare } from "../invoice/share.js";
import { describe, messageOf, preview } from "../util/errors.js";

/** What the current fragment asks the app to show. */
export type Route =
	| { readonly kind: "create" }
	| { readonly kind: "view"; readonly invoice: Invoice }
	| { readonly kind: "error"; readonly message: string };

const CREATE_ROUTE: Route = Object.freeze({ kind: "create" });

function errorRoute(message: string): Route {
	return Object.freeze({ kind: "error", message });
}

/**
 * Read a fragment — `location.hash`, a copied link, anything — into the route it names.
 *
 * Accepts any value and never throws; anything that is not a recognized link becomes an `error` route, including a payload that is empty, malformed, or beyond the codec's limits.
 */
export function parseHash(hash: unknown): Route {
	if (typeof hash !== "string") {
		return errorRoute(`router: the URL fragment must be a string, got ${describe(hash)}`);
	}
	const path = hash.trim().replace(/^#/, "");
	if (path === "" || path === "/" || path === "/create") {
		return CREATE_ROUTE;
	}
	let invoice: Invoice | null;
	try {
		invoice = decodeShare(hash);
	} catch (error) {
		// The share layer's refusal is already a complete, bounded explanation of what was wrong.
		return errorRoute(messageOf(error));
	}
	if (invoice !== null) {
		return Object.freeze({ kind: "view", invoice });
	}
	return errorRoute(`router: unrecognized route ${preview(path)} — expected ${SHARE_FRAGMENT_PREFIX}<payload> or "#/create"`);
}

/** The route the page's own fragment asks for; with no `location` (a test, a worker) that is create. */
export function currentRoute(): Route {
	return parseHash(typeof location === "undefined" ? "" : location.hash);
}
