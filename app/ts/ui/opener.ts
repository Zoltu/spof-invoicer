/**
 * The one test of whether another page opened this window, shared by the surfaces that refuse that case.
 *
 * The test is presence and nothing else: a window whose `window.opener` is neither `undefined` nor `null` counts as opened, whatever page that opener names, because presence is what the property reports without reaching across a boundary the page may not cross.
 * An opener served from the same website is the case that matters, since it can reach into the popup and drive its controls; an opener served from another website can neither read the fragment nor reach those controls, and the one presence test refuses it too rather than a second test singling it out.
 * A page that frames this window rather than opening it presents no opener, so this test cannot see it: a frame served from another origin can neither read the document nor reach its controls, while a frame served from this window's own origin shares that origin and can drive it whatever the document refuses, and README.md's "Security over features" records that framing residual as an accepted risk beside the permission that allows framing at all.
 * `window.opener` is an ordinary, replaceable window property, so this is best-effort coverage of every opener rather than a control an adversarial page is bound by; the load-bearing control remains README.md's requirement, in "Open the app", that the app's website be one whose pages are trusted with the invoice, because any other page on the same website would be trusted with the fragment.
 * A direct navigation — a modern `target="_blank"` link, a pasted URL, a bookmark — carries no opener, and a window with no `opener` at all (a test harness, a worker) counts as unopened.
 * Each surface words its own refusal on top of this answer, because what an opener could drive differs: `ui/pay.ts` refuses to reach a wallet, and `ui/mark-paid.ts` refuses to write a payment record.
 */

/**
 * Whether another page opened this window, read for presence alone.
 *
 * The presence test lives here rather than in either surface so the two refusals cannot drift into two spellings of one rule: a surface that checked `window.opener` itself could answer a slightly different question, and a window would then be refused by one of them and accepted by the other.
 */
export function windowHasOpener(): boolean {
	if (typeof window === "undefined") return false;
	// `window.opener` is read for presence alone, so it is read through the one shape this check needs rather than through the property's own `any` typing.
	const opener = (window as { opener?: unknown }).opener;
	return opener !== undefined && opener !== null;
}
