/**
 * The one statement both PDF suites make about an embedded image: which image XObjects a page's resources carry, and the pixel size each declares.
 *
 * The reader lives here once so the acceptance gate and the renderer's own suite cannot drift apart on how an artifact is asked what it embedded.
 */

import { PDFDict, PDFName, PDFRawStream } from "../../app/js/vendor/pdf-lib/pdf-lib.esm.js";

/** Every image XObject the first page's resources carry, with the pixel size the embedded PNG declares. */
export function imageXObjects(doc) {
	const resources = doc.getPage(0).node.Resources();
	const xobjects = resources === undefined ? undefined : resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
	if (xobjects === undefined) return [];
	return xobjects
		.entries()
		.map(([, value]) => doc.context.lookup(value))
		.filter((object) => object instanceof PDFRawStream && String(object.dict.get(PDFName.of("Subtype"))) === "/Image")
		.map((object) => ({
			width: Number(String(object.dict.get(PDFName.of("Width")))),
			height: Number(String(object.dict.get(PDFName.of("Height")))),
		}));
}
