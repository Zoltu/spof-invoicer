// Hand-written shim for the vendored pdf-lib ESM bundle — declares the vendored exports the app's modules import or re-export.
export interface RGB {
	type: "RGB";
	red: number;
	green: number;
	blue: number;
}

export interface Grayscale {
	type: "Grayscale";
	gray: number;
}

export type Color = RGB | Grayscale;

export declare const rgb: (red: number, green: number, blue: number) => RGB;
export declare const grayscale: (gray: number) => Grayscale;

export declare const PageSizes: {
	readonly A4: [number, number];
	readonly Letter: [number, number];
};

export declare const StandardFonts: {
	readonly Courier: "Courier";
	readonly CourierBold: "Courier-Bold";
	readonly CourierOblique: "Courier-Oblique";
	readonly CourierBoldOblique: "Courier-BoldOblique";
	readonly Helvetica: "Helvetica";
	readonly HelveticaBold: "Helvetica-Bold";
	readonly HelveticaOblique: "Helvetica-Oblique";
	readonly HelveticaBoldOblique: "Helvetica-BoldOblique";
	readonly TimesRoman: "Times-Roman";
	readonly TimesRomanBold: "Times-Bold";
	readonly TimesRomanItalic: "Times-Italic";
	readonly TimesRomanBoldItalic: "Times-BoldItalic";
	readonly Symbol: "Symbol";
	readonly ZapfDingbats: "ZapfDingbats";
};

/** A string in the font's own encoding, as `PDFFont.encodeText` produces it and a text-showing operator consumes it: opaque here, handed straight back. */
export interface PDFEncodedText {}

/** One content-stream operator, as the factories below build it: opaque here, handed straight back to `PDFPage.pushOperators`. */
export interface PDFOperator {}

export interface PDFFont {
	readonly name: string;
	widthOfTextAtSize(text: string, size: number): number;
	heightAtSize(size: number, options?: { descender?: boolean }): number;
	encodeText(text: string): PDFEncodedText;
}

/** One embedded image, as `PDFDocument.embedPng` returns it: the pixel size the PNG carries, which a draw scales to the box it is given. */
export interface PDFImage {
	readonly width: number;
	readonly height: number;
}

export interface PDFPageDrawTextOptions {
	color?: Color;
	font?: PDFFont;
	size?: number;
	x?: number;
	y?: number;
	lineHeight?: number;
	maxWidth?: number;
	wordBreaks?: string[];
}

export interface PDFPageDrawLineOptions {
	start: { x: number; y: number };
	end: { x: number; y: number };
	thickness?: number;
	color?: Color;
	dashArray?: number[];
	dashPhase?: number;
}

export interface PDFPageDrawRectangleOptions {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	color?: Color;
	opacity?: number;
	borderColor?: Color;
	borderWidth?: number;
	borderOpacity?: number;
}

export interface PDFPageDrawImageOptions {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	opacity?: number;
}

export interface PDFPage {
	getSize(): { width: number; height: number };
	getWidth(): number;
	getHeight(): number;
	setFont(font: PDFFont): void;
	setFontSize(size: number): void;
	drawText(text: string, options?: PDFPageDrawTextOptions): void;
	drawLine(options: PDFPageDrawLineOptions): void;
	drawRectangle(options?: PDFPageDrawRectangleOptions): void;
	drawImage(image: PDFImage, options?: PDFPageDrawImageOptions): void;
	/** Register `font` in the page's resources and return its key there, which is the name a font-setting operator carries. */
	setOrEmbedFont(font: PDFFont): { readonly oldFont: PDFFont; readonly oldFontKey: string | undefined; readonly newFont: PDFFont; readonly newFontKey: string };
	/** Append operators to the page's content stream, after everything drawn before them. */
	pushOperators(...operators: PDFOperator[]): void;
}

export interface PDFDocument {
	addPage(page?: PDFPage | [number, number]): PDFPage;
	getPage(index: number): PDFPage;
	getPages(): PDFPage[];
	getPageCount(): number;
	embedFont(font: string | Uint8Array | ArrayBuffer): Promise<PDFFont>;
	// Narrower than the vendored signature: the only caller hands over the rasterizer's PNG bytes, so the shim offers neither pdf-lib's base64 string nor its ArrayBuffer spelling, both of which its parser reads as text.
	embedPng(png: Uint8Array): Promise<PDFImage>;
	embedStandardFont(font: string): PDFFont;
	setTitle(title: string): void;
	setAuthor(author: string): void;
	setSubject(subject: string): void;
	setCreator(creator: string): void;
	setProducer(producer: string): void;
	getTitle(): string | undefined;
	getAuthor(): string | undefined;
	getSubject(): string | undefined;
	getCreator(): string | undefined;
	getProducer(): string | undefined;
	save(options?: { useObjectStreams?: boolean; addDefaultPage?: boolean }): Promise<Uint8Array>;
}

export declare const PDFDocument: {
	create(options?: { updateMetadata?: boolean }): Promise<PDFDocument>;
	load(
		pdf: string | Uint8Array | ArrayBuffer,
		options?: { ignoreEncryption?: boolean; updateMetadata?: boolean },
	): Promise<PDFDocument>;
};

export declare const pushGraphicsState: () => PDFOperator;
export declare const popGraphicsState: () => PDFOperator;
export declare const beginText: () => PDFOperator;
export declare const endText: () => PDFOperator;
export declare const setFillingColor: (color: Color) => PDFOperator;
export declare const setFontAndSize: (name: string, size: number) => PDFOperator;
export declare const setCharacterSqueeze: (squeeze: number) => PDFOperator;
export declare const setTextMatrix: (a: number, b: number, c: number, d: number, e: number, f: number) => PDFOperator;
export declare const showText: (text: PDFEncodedText) => PDFOperator;
