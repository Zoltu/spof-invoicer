/**
 * The notice contract a view reports through.
 *
 * Kept in its own module with no dependency on `app/`, so a view can raise a notice without importing the shell, and the shell can implement the same interface without the two forming a cycle.
 * The module graph then points one way — `app/` → `ui/` — and never back.
 */
export {};
//# sourceMappingURL=notice.js.map