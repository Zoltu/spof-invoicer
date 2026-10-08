// Hand-written shim for the vendored pdf-lib ESM bundle — declares only the surface this app uses.
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

export interface PDFFont {
	readonly name: string;
	widthOfTextAtSize(text: string, size: number): number;
	heightAtSize(size: number, options?: { descender?: boolean }): number;
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

export interface PDFPage {
	getSize(): { width: number; height: number };
	getWidth(): number;
	getHeight(): number;
	setFont(font: PDFFont): void;
	setFontSize(size: number): void;
	drawText(text: string, options?: PDFPageDrawTextOptions): void;
	drawLine(options: PDFPageDrawLineOptions): void;
	drawRectangle(options?: PDFPageDrawRectangleOptions): void;
}

export interface PDFDocument {
	addPage(page?: PDFPage | [number, number]): PDFPage;
	getPage(index: number): PDFPage;
	getPages(): PDFPage[];
	getPageCount(): number;
	embedFont(font: string | Uint8Array | ArrayBuffer): Promise<PDFFont>;
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
