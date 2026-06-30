// Google Workspace API OAuth2 scope definitions and helpers
//
// Gmail scope hierarchy (for reference):
//   - gmail.readonly: Read-only access to emails
//   - gmail.modify: Read AND write access except permanent delete
//   - gmail.compose: Create drafts and send emails
//   - gmail.send: Send emails only
//   - gmail.labels: Manage labels only
//   - gmail.settings.basic: Manage filters and settings
//   - mail.google.com: Full access including permanent delete
//
// Note: gmail.modify includes all capabilities of gmail.readonly,
// so you don't need both scopes together. mail.google.com is the only
// scope that authorizes users.messages.delete / users.threads.delete
// (purge from Trash) — gmail.modify alone returns HTTP 403
// "Insufficient Permission" on those endpoints.
//
// Drive / Sheets / Slides / Docs scopes (added in v0.31):
//   - drive: Full Drive read+write. Needed for replying to comments
//     on docs not created by this app (drive.file would block that).
//     Restricted scope per Google's verification policy; fine in
//     OAuth Consent "Testing" mode for personal use.
//   - drive.readonly: Read-only Drive access (registered for opt-in
//     read-only deployments; not in DEFAULT_SCOPES).
//   - drive.file: Picker-only writes (registered for forward
//     compatibility; not currently used).
//   - spreadsheets.readonly: Sheets API read. Required for multi-tab
//     Sheets reads — Drive's files.export(text/csv) only returns the
//     first/active tab.
//   - spreadsheets: Sheets API read+write (added in v0.33). Required
//     for sheets_write_tab. Superset of spreadsheets.readonly — a
//     token holding this scope satisfies both.
//   - presentations: Slides API read+write — needed to create or
//     populate decks programmatically.
//   - documents: Docs API read+write — pre-authorized for forward-
//     compatible Docs drafting tools.

// Map shorthand scope names to full Google API URLs
export const SCOPE_MAP: Record<string, string> = {
  "gmail.readonly": "https://www.googleapis.com/auth/gmail.readonly",
  "gmail.modify": "https://www.googleapis.com/auth/gmail.modify",
  "gmail.compose": "https://www.googleapis.com/auth/gmail.compose",
  "gmail.send": "https://www.googleapis.com/auth/gmail.send",
  "gmail.labels": "https://www.googleapis.com/auth/gmail.labels",
  "gmail.settings.basic": "https://www.googleapis.com/auth/gmail.settings.basic",
  "gmail.settings.sharing": "https://www.googleapis.com/auth/gmail.settings.sharing",
  "mail.google.com": "https://mail.google.com/",
  // Drive / Sheets / Slides / Docs — added v0.31
  drive: "https://www.googleapis.com/auth/drive",
  "drive.readonly": "https://www.googleapis.com/auth/drive.readonly",
  "drive.file": "https://www.googleapis.com/auth/drive.file",
  "spreadsheets.readonly": "https://www.googleapis.com/auth/spreadsheets.readonly",
  spreadsheets: "https://www.googleapis.com/auth/spreadsheets",
  presentations: "https://www.googleapis.com/auth/presentations",
  documents: "https://www.googleapis.com/auth/documents",
};

// Reverse map for converting full URLs back to shorthand
export const SCOPE_REVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SCOPE_MAP).map(([short, full]) => [full, short]),
);

// Default scopes (original behavior)
export const DEFAULT_SCOPES = ["gmail.modify", "gmail.settings.basic"];

// Convert shorthand scope name to full Google API URL
// e.g., "gmail.readonly" -> "https://www.googleapis.com/auth/gmail.readonly"
export function scopeNameToUrl(scope: string): string {
  return SCOPE_MAP[scope] || scope;
}

// Convert full Google API URL to shorthand name
// e.g., "https://www.googleapis.com/auth/gmail.readonly" -> "gmail.readonly"
export function scopeUrlToName(scope: string): string {
  return SCOPE_REVERSE_MAP[scope] || scope;
}

// Convert array of shorthand scope names to full Google API URLs
export function scopeNamesToUrls(scopes: string[]): string[] {
  return scopes.map(scopeNameToUrl);
}

// Check if the authorized scopes grant access to a tool
// Returns true if ANY of the tool's required scopes are present in authorizedScopes
export function hasScope(authorizedScopes: string[], requiredScopes: string[]): boolean {
  // Normalize to shorthand names for comparison (handles both URL and shorthand input)
  const normalizedAuth = authorizedScopes.map(scopeUrlToName);
  return requiredScopes.some((scope) => normalizedAuth.includes(scope));
}

// Parse scope input from CLI (comma-separated or space-separated)
export function parseScopes(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Validate that all scopes are recognized
export function validateScopes(scopes: string[]): { valid: boolean; invalid: string[] } {
  const invalid = scopes.filter((s) => !SCOPE_MAP[s]);
  return { valid: invalid.length === 0, invalid };
}

// Get available scope names for help text
export function getAvailableScopeNames(): string[] {
  return Object.keys(SCOPE_MAP);
}
