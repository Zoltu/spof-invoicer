/**
 * The notice contract a view reports through.
 *
 * Kept in its own module with no dependency on `app/`, so a view can raise a notice without importing the shell, and the shell can implement the same interface without the two forming a cycle.
 * The module graph then points one way — `app/` → `ui/` — and never back.
 */

/** How a notice reads: informational, a failure, or a success. */
export type NoticeTone = "info" | "error" | "success";

/** The notice region, exposed so a view can report success or failure without owning the chrome. */
export interface NoticeApi {
	showNotice(message: string, tone?: NoticeTone): void;
	clearNotice(): void;
}
