/**
 * The clipboard seam the copy controls share.
 *
 * A "Copy" affordance appears on more than one surface — the share dialog's two strings, the payment panel's transaction hash, and the payment section's verbatim values — so the small amount of logic that touches the async Clipboard API lives here rather than in whichever module happened to need it first.
 * `ui/share.ts`, `ui/pay.ts`, and `ui/payment-section.ts` depend on this neutral module, so none of them is coupled to the others for a generic helper.
 *
 * {@link copyText} wraps the one method this app uses (`writeText`).
 * {@link copyWithFallback} is the copy control's own click handler built on top: it writes, confirms the write in the control's status line, and when the clipboard is unavailable or refuses, selects the value and tells the user to copy by hand.
 * Both confirmations are spelled here once, so the surfaces cannot drift.
 */

/** The subset of the async Clipboard API this app uses; absent outside a secure context. */
export interface ClipboardLike {
	writeText(text: string): Promise<void>;
}

/** What a copy control's status reads once the text is on the clipboard. */
const COPIED = "Copied";

/** What a copy control's status reads when the clipboard is unavailable and the value is selected. */
const COPY_BY_HAND = "Press Ctrl/Cmd+C to copy";

/**
 * Copy `text` to the clipboard.
 * Returns `false` — never throws — when no clipboard is available (a non-secure context) or the write is refused, so the caller can fall back to selectable text.
 */
export async function copyText(text: string, clipboard: ClipboardLike | null | undefined): Promise<boolean> {
	if (clipboard === null || clipboard === undefined) return false;
	try {
		await clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * Select what `element` shows, so a manual copy takes it.
 *
 * A text control selects its own value, since its value is not part of the document tree a range could span; any other element — the payment section's verbatim values are text — has its contents selected through the document's own selection.
 */
function selectContents(element: HTMLElement): void {
	const tag = element.tagName.toLowerCase();
	if (tag === "input" || tag === "textarea") {
		(element as HTMLInputElement | HTMLTextAreaElement).select();
		return;
	}
	const selection = document.getSelection();
	if (selection === null) return;
	const range = document.createRange();
	range.selectNodeContents(element);
	selection.removeAllRanges();
	selection.addRange(range);
}

/**
 * Wire a copy click: copy `text`, report the outcome in `status`, and fall back to selecting `element` for a manual copy when the clipboard is unavailable or refuses the write.
 */
export function copyWithFallback(
	text: string,
	clipboard: ClipboardLike | null | undefined,
	element: HTMLElement,
	status: HTMLElement,
): void {
	void copyText(text, clipboard).then((copied) => {
		if (copied) {
			status.textContent = COPIED;
			return;
		}
		selectContents(element);
		status.textContent = COPY_BY_HAND;
	});
}
