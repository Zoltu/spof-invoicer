/**
 * The one statement both PDF suites make about an embedded image: which image XObjects the document's pages carry, and the pixel size each declares.
 *
 * The reader lives here once so the acceptance gate and the renderer's own suite cannot drift apart on how an artifact is asked what it embedded.
 * It reads every page rather than the first, because what the suites ask it is a statement about the whole artifact — whether the icon is embedded exactly once — and a reading that stopped at page 0 would report an image on any later page as absent.
 */

import { PDFDict, PDFName, PDFRawStream } from "../../app/js/vendor/pdf-lib/pdf-lib.esm.js";

/**
 * Every image XObject the document's pages carry, with the pixel size the embedded PNG declares, each XObject named once however many pages reference it.
 * An object referenced from two pages' resources is one embedding rather than two, so the entries are keyed by the reference the resource dict names.
 */
export function imageXObjects(doc) {
	const seen = new Set();
	const images = [];
	for (const page of doc.getPages()) {
		const resources = page.node.Resources();
		const xobjects = resources === undefined ? undefined : resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
		if (xobjects === undefined) continue;
		for (const [, value] of xobjects.entries()) {
			const key = String(value);
			if (seen.has(key)) continue;
			const object = doc.context.lookup(value);
			if (!(object instanceof PDFRawStream) || String(object.dict.get(PDFName.of("Subtype"))) !== "/Image") continue;
			seen.add(key);
			images.push({
				width: Number(String(object.dict.get(PDFName.of("Width")))),
				height: Number(String(object.dict.get(PDFName.of("Height")))),
			});
		}
	}
	return images;
}
