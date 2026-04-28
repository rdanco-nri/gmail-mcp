/**
 * Resolve the HTML signature configured in Gmail's web UI for a given
 * send-as alias, so that programmatically-created drafts/sends include
 * the same signature a human would see when composing in Gmail.
 *
 * Gmail's API does NOT auto-inject signatures into messages created via
 * `users.drafts.create` or `users.messages.send` — that injection only
 * happens client-side in the web UI. Without this resolver, every draft
 * we produce ships unsigned.
 *
 * Source: `users.settings.sendAs.list` returns each send-as entry with
 * its `signature` field (HTML, may include hosted <img> tags for logos,
 * inline <a> links, custom styling). Requires gmail.settings.basic OR
 * gmail.modify OR gmail.readonly. Scope-degraded: if the call fails,
 * returns `undefined` and callers fall through to no-signature behavior.
 *
 * Caching: keyed by (gmail client, sendAsEmail) so the round-trip only
 * fires once per process per alias. Uses a WeakMap on the gmail client
 * so a re-auth or new client instance triggers a refetch — necessary
 * because signature edits in the Gmail UI shouldn't require a server
 * restart to surface (well, they do until the WeakMap entry is evicted,
 * but at least swapping clients works).
 */

import type { gmail_v1 } from "googleapis";

// Per-client cache: Map<sendAsEmail | "__default__", htmlSignature | "">
// Empty string means "fetched, no signature configured" — distinct from
// "not yet fetched" (key absent).
type PerClientCache = Map<string, string>;

let cache = new WeakMap<gmail_v1.Gmail, PerClientCache>();
let inFlight = new WeakMap<gmail_v1.Gmail, Map<string, Promise<string>>>();

const DEFAULT_KEY = "__default__";

/**
 * Extract the bare email from a `From:` value that may be either
 * `"Display Name <addr@host>"` or just `"addr@host"`. Used to map the
 * resolved sender back to a sendAs entry.
 */
function bareEmail(from: string | undefined): string | undefined {
  if (!from) return undefined;
  const trimmed = from.trim();
  const m = trimmed.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim().toLowerCase();
  // No angle brackets — assume the whole string is the email.
  return trimmed.toLowerCase();
}

/**
 * Returns the HTML signature for the given send-as alias, or for the
 * primary/default alias if none specified. Returns `undefined` when no
 * signature is configured or when the scope doesn't permit reading
 * sendAs settings.
 *
 * Honors `GMAIL_MCP_DISABLE_SIGNATURE=true` — set this env var to
 * suppress auto-injection entirely (e.g. in tests, or when the caller
 * is constructing the body with their own signature already).
 */
export async function resolveSignature(
  gmail: gmail_v1.Gmail,
  sendAsEmail?: string,
): Promise<string | undefined> {
  if (process.env.GMAIL_MCP_DISABLE_SIGNATURE === "true") return undefined;

  const key = bareEmail(sendAsEmail) ?? DEFAULT_KEY;

  const clientCache = cache.get(gmail);
  if (clientCache) {
    const hit = clientCache.get(key);
    if (hit !== undefined) return hit === "" ? undefined : hit;
  }

  const clientInFlight = inFlight.get(gmail) ?? new Map();
  inFlight.set(gmail, clientInFlight);
  const pending = clientInFlight.get(key);
  if (pending) {
    const result = await pending;
    return result === "" ? undefined : result;
  }

  const task = (async (): Promise<string> => {
    try {
      const resp = await gmail.users.settings.sendAs.list({ userId: "me" });
      const entries = resp.data.sendAs ?? [];

      // Find the matching entry: explicit email match first, otherwise
      // the default/primary entry. Mirrors resolveDefaultSender's
      // selection so signatures stay in sync with the resolved From:.
      let entry: gmail_v1.Schema$SendAs | undefined;
      if (key !== DEFAULT_KEY) {
        entry = entries.find((s) => (s.sendAsEmail ?? "").toLowerCase() === key);
      }
      if (!entry) {
        entry =
          entries.find((s) => s.isDefault === true) ??
          entries.find((s) => s.isPrimary === true) ??
          entries[0];
      }

      const sig = (entry?.signature ?? "").trim();
      return sig;
    } catch {
      // Scope doesn't grant settings.basic, or transient API failure —
      // degrade silently to no signature.
      return "";
    }
  })();

  clientInFlight.set(key, task);
  try {
    const result = await task;
    let store = cache.get(gmail);
    if (!store) {
      store = new Map();
      cache.set(gmail, store);
    }
    store.set(key, result);
    return result === "" ? undefined : result;
  } finally {
    clientInFlight.delete(key);
  }
}

/** Test-only: clear the per-client cache between cases. */
export function _resetSignatureCache(): void {
  cache = new WeakMap();
  inFlight = new WeakMap();
}

/**
 * Marker wrapped around auto-injected signatures so the same draft
 * being re-processed (e.g. an LLM passing a previously-rendered body
 * back through draft_email) doesn't double-up the signature. Detection
 * is a substring check; the marker is intentionally distinctive.
 */
export const SIGNATURE_MARKER = "data-gmail-mcp-signature=\"auto\"";

/**
 * Mutates `args` in place to inject the HTML signature when one is
 * available. Behavior:
 *
 *   - If `args.htmlBody` already contains `SIGNATURE_MARKER`, no-op
 *     (idempotent — safe to call repeatedly on the same args).
 *   - If `args.htmlBody` is set: append `<br><br>--<br>` + wrapped
 *     signature to the end.
 *   - If only `args.body` (plain text) is set: promote to HTML by
 *     wrapping each paragraph in `<p>...</p>`, append the signature,
 *     and set `args.mimeType = "multipart/alternative"` so the original
 *     plain-text body remains the text/plain alternative for clients
 *     that prefer it.
 *
 * The plain-text promotion is the right default for this MCP because:
 *   1. Rob's documented bug: plain `body` with `\n\n` renders with
 *      doubled spacing on send (Gmail's text-to-HTML converter emits
 *      `<br><br>` per `\n`).
 *   2. Signatures from Gmail Settings are HTML and include logos as
 *      hosted `<img>` tags — they only render correctly in an HTML
 *      part.
 *
 * Callers that explicitly want plain-text-only output should set the
 * env var `GMAIL_MCP_DISABLE_SIGNATURE=true`, which makes
 * `resolveSignature` return undefined and skips this entire path.
 */
export function injectSignature(
  args: {
    body: string;
    htmlBody?: string;
    mimeType?: string;
  },
  signature: string | undefined,
): void {
  if (!signature) return;
  const wrapped = `<div ${SIGNATURE_MARKER}>${signature}</div>`;

  if (args.htmlBody) {
    if (args.htmlBody.includes(SIGNATURE_MARKER)) return;
    args.htmlBody = `${args.htmlBody}<br><br>--<br>${wrapped}`;
    return;
  }

  // Plain-text-only: promote to HTML, keep the plain text as the
  // text/plain alternative. Each blank-line-separated chunk becomes a
  // <p>; trailing newlines inside a paragraph become <br>. This is a
  // minimal converter — anything fancier (Markdown, lists) should be
  // expressed as htmlBody by the caller.
  const escaped = escapeHtml(args.body);
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  args.htmlBody = `${paragraphs}<br>--<br>${wrapped}`;
  args.mimeType = "multipart/alternative";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
