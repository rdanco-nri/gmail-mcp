import emailAddresses from "email-addresses";
import { z } from "zod";

// Gmail API IDs (messageId, threadId, labelId, attachmentId) are base64url
// strings. Bounding them (non-empty, ≤ 256 chars, base64url charset) stops
// a prompt-injected agent from forging megabyte-sized IDs that would burn
// a round-trip and then leak their prefix through batch error logs.
const GmailIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

// User-supplied filesystem paths. The attachment jail in `src/utl.ts`
// (assertAttachmentPathAllowed) is the load-bearing check at runtime,
// but a schema-level guard rejects the worst shapes before Zod would
// otherwise accept them — empty strings, absurdly long payloads,
// CRLF/NUL injection into a downstream filename log. 4096 chars is the
// effective filesystem path limit on every Linux we ship to; macOS is
// 1024 but we accept the wider bound rather than special-casing.
const FilePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !/[\0\r\n]/.test(p), "Path must not contain NUL or newline characters");

// Some MCP clients (Claude Code SDK is the one that put the bug in sharp
// relief — upstream GongRzhe#95/#96) serialize tool arguments with strict
// JSON so an `array` parameter arrives as the literal string `'["a","b"]'`
// and a `number` parameter as `'10'`. A bare `z.array(...)` / `z.number()`
// then rejects the call with "Expected array, received string".
//
// Workaround: preprocess to accept the JSON-stringified form too.
// `z.coerce.number()` already handles strings natively in Zod 4, so we only
// need a helper for array-like fields.
// `z.preprocess(..., z.array(inner))` returns a ZodPipe whose output type
// is a plain array and which does NOT expose `.max()` / `.min()` on the
// pipe itself. Pushing the length bound into the inner schema keeps the
// preprocess wrapper transparent to the call site, so fields can still
// declare `coerceArray(X, { max: 1000 })`.
const coerceArrayPreprocess = (val: unknown) => {
  if (typeof val !== "string") return val;
  // Only try JSON.parse on a value that at least looks like an array
  // literal, otherwise `"foo,bar"` would not round-trip and the error
  // from z.array() would shift from "Expected array, received string"
  // to the equally-misleading "Unexpected token f in JSON".
  const trimmed = val.trim();
  if (!trimmed.startsWith("[")) return val;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : val;
  } catch {
    return val;
  }
};

const coerceArray = <T extends z.ZodTypeAny>(inner: T, opts?: { max?: number }) => {
  const arr = opts?.max !== undefined ? z.array(inner).max(opts.max) : z.array(inner);
  return z.preprocess(coerceArrayPreprocess, arr);
};

// Scoped integer coercion. `z.coerce.number()` is too permissive — it
// converts `true → 1`, `false → 0`, `null → 0`, `[] → 0`, which silently
// accepts malformed JSON from a loosely-typed caller. We only want to
// rescue string-encoded integers from strict-JSON clients (Claude Code
// SDK), not cross the type barrier.
//
// Preprocess passes numbers through untouched, coerces strings that
// parse as finite numbers, and leaves every other type alone so the
// inner `z.number().int()` rejects it with the expected "Expected
// number" error rather than silently widening.
//
// Bounds are declared via the options bag (same pattern as coerceArray)
// because `z.preprocess(fn, z.number().int())` returns a ZodPipe whose
// `.min()` / `.max()` are not directly chainable.
const coerceIntPreprocess = (val: unknown): unknown => {
  if (typeof val === "string") {
    // Strict decimal-integer match only. The naive `Number(trimmed)`
    // would silently accept scientific notation (`"1e2"` → 100) and
    // hex (`"0x10"` → 16), both well beyond the "stringified digits
    // from a strict-JSON client" contract we advertise. A regex keeps
    // the coercion surface narrow and predictable.
    const trimmed = val.trim();
    if (!/^-?\d+$/.test(trimmed)) return val;
    return Number(trimmed);
  }
  return val;
};

const coerceInt = (opts?: { min?: number; max?: number }) => {
  let inner = z.number().int();
  if (opts?.min !== undefined) inner = inner.min(opts.min);
  if (opts?.max !== undefined) inner = inner.max(opts.max);
  return z.preprocess(coerceIntPreprocess, inner);
};

// Schema definitions
export const SendEmailSchema = z.object({
  to: coerceArray(z.string()).describe("List of recipient email addresses"),
  subject: z.string().describe("Email subject"),
  body: z
    .string()
    .describe("Email body content (used for text/plain or when htmlBody not provided)"),
  from: z
    .string()
    .optional()
    .describe(
      "Sender email address (must be a configured send-as alias in Gmail settings). Defaults to account's default send-as address if not specified.",
    ),
  htmlBody: z.string().optional().describe("HTML version of the email body"),
  mimeType: z
    .enum(["text/plain", "text/html", "multipart/alternative"])
    .optional()
    .default("text/plain")
    .describe("Email content type"),
  cc: coerceArray(z.string()).optional().describe("List of CC recipients"),
  bcc: coerceArray(z.string()).optional().describe("List of BCC recipients"),
  threadId: GmailIdSchema.optional().describe("Thread ID to reply to"),
  // inReplyTo is an RFC 5322 Message-ID (e.g. `<abc@host>`), not a
  // Gmail API ID — different charset, kept out of GmailIdSchema. Bound
  // the length at the RFC's line limit (998 chars) to block unbounded
  // z.string() DoS without constraining the legitimate form.
  inReplyTo: z
    .string()
    .max(998)
    .optional()
    .describe("RFC 5322 Message-ID being replied to (e.g. <abc@host>, max 998 chars)"),
  attachments: coerceArray(FilePathSchema)
    .optional()
    .describe("List of file paths to attach to the email"),
});

// Gmail's own web UI clips message bodies at ~102 KB of combined text/HTML
// (images excluded). Matching that threshold means the LLM sees the same
// payload a human opening the message would see — identical UX. The
// `[Message clipped]` marker we emit matches Gmail's own label verbatim.
const GMAIL_CLIP_BYTES = 102 * 1024; // 104_448

export const ReadEmailSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to retrieve"),
  format: z
    .enum(["full", "summary", "headers_only"])
    .optional()
    .default("full")
    .describe(
      "Response depth: 'full' (default — headers + body + attachment list), 'summary' (headers + first 500 bytes of body, no attachments), 'headers_only' (no body, no attachments). Pick the lightest format that answers your question to keep the conversation's context budget for other calls.",
    ),
  maxBodyLength: coerceInt({ min: 0, max: 1_048_576 })
    .optional()
    .default(GMAIL_CLIP_BYTES)
    .describe(
      "Maximum body size in bytes. 0 disables truncation. Default 104448 (102 KB) matches Gmail's web UI clipping threshold so the response mirrors what a human opening the message would see, and the emitted '[Message clipped]' marker matches Gmail's own label. Lower the cap (e.g. 10000) when sampling many messages in a single conversation to preserve the LLM's context budget; raise it (up to 1 MB) or set 0 when you specifically need the unredacted payload.",
    ),
  includeAttachments: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Include the attachment metadata list (filename / MIME / size / ID). Set to false to shrink the response when you already know the message has many attachments and aren't going to act on them.",
    ),
});

export const SearchEmailsSchema = z.object({
  query: z.string().describe("Gmail search query (e.g., 'from:example@gmail.com')"),
  maxResults: coerceInt({ min: 1, max: 500 })
    .optional()
    .describe("Maximum number of results to return (1-500, default 10)"),
});

export const ModifyEmailSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to modify"),
  labelIds: coerceArray(GmailIdSchema).optional().describe("List of label IDs to apply"),
  addLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to add to the message"),
  removeLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to remove from the message"),
});

export const DeleteEmailSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to delete"),
});

export const ListEmailLabelsSchema = z.object({}).describe("Retrieves all available Gmail labels");

export const CreateLabelSchema = z
  .object({
    name: z.string().describe("Name for the new label"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Creates a new Gmail label");

export const UpdateLabelSchema = z
  .object({
    id: GmailIdSchema.describe("ID of the label to update"),
    name: z.string().optional().describe("New name for the label"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Updates an existing Gmail label");

export const DeleteLabelSchema = z
  .object({
    id: GmailIdSchema.describe("ID of the label to delete"),
  })
  .describe("Deletes a Gmail label");

export const GetOrCreateLabelSchema = z
  .object({
    name: z.string().describe("Name of the label to get or create"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Gets an existing label by name or creates it if it doesn't exist");

export const BatchModifyEmailsSchema = z.object({
  messageIds: coerceArray(GmailIdSchema, { max: 1000 }).describe(
    "List of message IDs to modify (max 1000 per call)",
  ),
  addLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to add to all messages"),
  removeLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to remove from all messages"),
  batchSize: coerceInt({ min: 1, max: 100 })
    .optional()
    .default(50)
    .describe("Messages per batch (1-100, default 50)"),
});

export const BatchDeleteEmailsSchema = z.object({
  messageIds: coerceArray(GmailIdSchema, { max: 1000 }).describe(
    "List of message IDs to delete (max 1000 per call)",
  ),
  batchSize: coerceInt({ min: 1, max: 100 })
    .optional()
    .default(50)
    .describe("Messages per batch (1-100, default 50)"),
});

export const CreateFilterSchema = z
  .object({
    criteria: z
      .object({
        from: z.string().optional().describe("Sender email address to match"),
        to: z.string().optional().describe("Recipient email address to match"),
        subject: z.string().optional().describe("Subject text to match"),
        query: z.string().optional().describe("Gmail search query (e.g., 'has:attachment')"),
        negatedQuery: z.string().optional().describe("Text that must NOT be present"),
        hasAttachment: z.boolean().optional().describe("Whether to match emails with attachments"),
        excludeChats: z.boolean().optional().describe("Whether to exclude chat messages"),
        size: coerceInt({ min: 0 }).optional().describe("Email size in bytes"),
        sizeComparison: z
          .enum(["unspecified", "smaller", "larger"])
          .optional()
          .describe("Size comparison operator"),
      })
      .describe("Criteria for matching emails"),
    action: z
      .object({
        addLabelIds: coerceArray(GmailIdSchema)
          .optional()
          .describe("Label IDs to add to matching emails"),
        removeLabelIds: coerceArray(GmailIdSchema)
          .optional()
          .describe("Label IDs to remove from matching emails"),
        forward: z.string().optional().describe("Email address to forward matching emails to"),
      })
      .describe("Actions to perform on matching emails"),
  })
  .describe("Creates a new Gmail filter");

export const ListFiltersSchema = z.object({}).describe("Retrieves all Gmail filters");

export const GetFilterSchema = z
  .object({
    filterId: GmailIdSchema.describe("ID of the filter to retrieve"),
  })
  .describe("Gets details of a specific Gmail filter");

export const DeleteFilterSchema = z
  .object({
    filterId: GmailIdSchema.describe("ID of the filter to delete"),
  })
  .describe("Deletes a Gmail filter");

export const CreateFilterFromTemplateSchema = z
  .object({
    template: z
      .enum([
        "fromSender",
        "withSubject",
        "withAttachments",
        "largeEmails",
        "containingText",
        "mailingList",
      ])
      .describe("Pre-defined filter template to use"),
    parameters: z
      .object({
        senderEmail: z.string().optional().describe("Sender email (for fromSender template)"),
        subjectText: z.string().optional().describe("Subject text (for withSubject template)"),
        searchText: z
          .string()
          .optional()
          .describe("Text to search for (for containingText template)"),
        listIdentifier: z
          .string()
          .optional()
          .describe("Mailing list identifier (for mailingList template)"),
        sizeInBytes: coerceInt({ min: 0 })
          .optional()
          .describe("Size threshold in bytes (for largeEmails template)"),
        labelIds: coerceArray(GmailIdSchema).optional().describe("Label IDs to apply"),
        archive: z.boolean().optional().describe("Whether to archive (skip inbox)"),
        markAsRead: z.boolean().optional().describe("Whether to mark as read"),
        markImportant: z.boolean().optional().describe("Whether to mark as important"),
      })
      .describe("Template-specific parameters"),
  })
  .describe("Creates a filter using a pre-defined template");

export const DownloadAttachmentSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message containing the attachment"),
  attachmentId: GmailIdSchema.describe("ID of the attachment to download"),
  filename: z
    .string()
    .optional()
    .describe("Filename to save the attachment as (if not provided, uses original filename)"),
  savePath: z
    .string()
    .optional()
    .describe("Directory path to save the attachment (defaults to current directory)"),
});

export const DownloadEmailSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to download"),
  savePath: z.string().describe("Directory path to save the email file"),
  format: z
    .enum(["json", "eml", "txt", "html"])
    .optional()
    .default("json")
    .describe(
      "Output format: json (structured data), eml (raw RFC822), txt (plain text), html (formatted HTML)",
    ),
});

export const ModifyThreadSchema = z.object({
  threadId: GmailIdSchema.describe("ID of the Gmail thread to modify"),
  addLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to add to all messages in the thread"),
  removeLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to remove from all messages in the thread"),
});

// Thread-level schemas
export const GetThreadSchema = z.object({
  threadId: GmailIdSchema.describe("ID of the email thread to retrieve"),
  format: z
    .enum(["full", "metadata", "minimal"])
    .optional()
    .default("full")
    .describe("Format of the email messages returned (default: full)"),
});

export const ListInboxThreadsSchema = z.object({
  query: z
    .string()
    .optional()
    .default("in:inbox")
    .describe("Gmail search query (default: 'in:inbox')"),
  maxResults: coerceInt({ min: 1, max: 500 })
    .optional()
    .default(50)
    .describe("Maximum number of threads to return (1-500, default 50)"),
});

export const GetInboxWithThreadsSchema = z
  .object({
    query: z
      .string()
      .optional()
      .default("in:inbox")
      .describe("Gmail search query (default: 'in:inbox')"),
    maxResults: coerceInt({ min: 1, max: 500 })
      .optional()
      .default(50)
      .describe(
        "Maximum number of threads to return. Up to 500 when expandThreads=false (lightweight summary); capped at 100 when expandThreads=true because each thread triggers a full-body fetch.",
      ),
    expandThreads: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to fetch full thread content for each thread (default: true)"),
  })
  .refine((args) => !args.expandThreads || args.maxResults <= 100, {
    message:
      "maxResults cannot exceed 100 when expandThreads is true (body fetches). Set expandThreads=false to request up to 500.",
    path: ["maxResults"],
  });

// Recipient pairing gate schema — opt-in allowlist ops (add/remove/list).
// Gate itself is enforced in handleEmailAction + reply_all when
// GMAIL_MCP_RECIPIENT_PAIRING=true. See src/recipient-pairing.ts.
//
// `email` is shape-checked at the schema layer with the same RFC 5322
// parser (`email-addresses.parseOneAddress`) used by send/reply/draft —
// so a malformed address is rejected pre-dispatch instead of bubbling
// out of `addPairedAddress` at runtime, and the agent sees a Zod
// validation error rather than a generic Error.
export const PairRecipientSchema = z.object({
  action: z
    .enum(["add", "remove", "list"])
    .describe("Operation on the paired-recipients allowlist"),
  email: z
    .string()
    .max(512)
    .refine((addr) => {
      // `parseOneAddress` may return a `group` node (RFC 5322 syntax
      // `"team: a@b, c@d;"`) — a group parses fine but is NOT a single
      // mailbox. Accepting one here would let `team: …;` past the
      // pairing allowlist while none of the contained mailboxes have
      // been individually approved. Restrict to `type === "mailbox"`.
      const parsed = emailAddresses.parseOneAddress(addr);
      return parsed !== null && parsed.type === "mailbox";
    }, "Must be a parseable RFC 5322 mailbox address (e.g. user@example.com — RFC 5322 groups are rejected).")
    .optional()
    .describe("Email address to add or remove. Required when action is add or remove."),
});

// Reply All schema - fetches original email and builds recipient list automatically
export const ReplyAllSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to reply to"),
  body: z
    .string()
    .describe("Reply body content (used for text/plain or when htmlBody not provided)"),
  htmlBody: z.string().optional().describe("HTML version of the reply body"),
  mimeType: z
    .enum(["text/plain", "text/html", "multipart/alternative"])
    .optional()
    .default("text/plain")
    .describe("Email content type"),
  attachments: coerceArray(FilePathSchema)
    .optional()
    .describe("List of file paths to attach to the reply"),
});

// Reply To Email schema — sender-only reply (no Cc broadcast). Same
// surface as ReplyAllSchema; the difference lives in the handler that
// picks the original `From:` as the sole recipient. Kept distinct from
// ReplyAllSchema so the JSON-Schema description in `tools/list` reads
// "the sender" and not "every original recipient" — the agent picks
// the right tool from the description, not the shape.
export const ReplyToEmailSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to reply to"),
  body: z
    .string()
    .describe("Reply body content (used for text/plain or when htmlBody not provided)"),
  htmlBody: z.string().optional().describe("HTML version of the reply body"),
  mimeType: z
    .enum(["text/plain", "text/html", "multipart/alternative"])
    .optional()
    .default("text/plain")
    .describe("Email content type"),
  attachments: coerceArray(FilePathSchema)
    .optional()
    .describe("List of file paths to attach to the reply"),
});

// Forward Email schema — relay an existing message to a fresh recipient
// list. The handler fetches the source, builds a Gmail-style quoted
// body (`---------- Forwarded message ---------` + headers + original
// text), and prepends the optional `body` preface. New thread (no
// `threadId` carry-over). Attachments from the source are NOT
// re-attached; the caller chains `download_attachment` + passes paths
// here when carry-over is desired.
export const ForwardEmailSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to forward"),
  to: coerceArray(z.string()).describe(
    "List of recipient email addresses to forward the message to",
  ),
  cc: coerceArray(z.string()).optional().describe("List of CC recipients"),
  bcc: coerceArray(z.string()).optional().describe("List of BCC recipients"),
  body: z
    .string()
    .optional()
    .describe(
      "Optional plain-text preface to prepend before the quoted forwarded message. When omitted the forward stands on its own with the standard '---------- Forwarded message ---------' separator.",
    ),
  attachments: coerceArray(FilePathSchema)
    .optional()
    .describe(
      "Additional file paths to attach. Attachments from the source message are NOT re-attached automatically — chain `download_attachment` and pass the resulting paths here if carry-over is needed.",
    ),
});

// =====================================================================
// Drive / Slides schemas (v0.31 — extends MCP beyond Gmail)
// =====================================================================
//
// Drive file IDs are URL-safe strings (Drive uses base64url-ish chars
// plus underscores) but vary in length more than Gmail IDs. Bound at
// 256 chars (well above realistic max — Drive IDs are typically
// 33-44 chars).
const DriveIdSchema = z.string().min(1).max(256);

export const DriveSearchSchema = z.object({
  query: z
    .string()
    .describe(
      "Drive search query string (Drive 'q' syntax). Examples: \"name contains 'budget'\", \"fullText contains 'quarterly review'\", \"mimeType = 'application/vnd.google-apps.document' and modifiedTime > '2024-01-01T00:00:00'\", \"sharedWithMe = true\". Defaults exclude trashed.",
    ),
  pageSize: coerceInt({ min: 1, max: 1000 })
    .optional()
    .default(20)
    .describe("Max results per page (1-1000, default 20)."),
  includeSharedDrives: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include items from shared drives (default true)."),
  fields: z
    .string()
    .optional()
    .describe(
      "Override partial-response fields. Default: 'files(id,name,mimeType,owners(displayName,emailAddress),modifiedTime,parents,webViewLink),nextPageToken'.",
    ),
  pageToken: z
    .string()
    .optional()
    .describe("Continuation token from a previous response's nextPageToken."),
});

export const DriveGetMetadataSchema = z.object({
  fileId: DriveIdSchema.describe("Drive file ID."),
  fields: z
    .string()
    .optional()
    .describe(
      "Override partial-response fields. Default returns id, name, mimeType, owners, parents, modifiedTime, capabilities, webViewLink, shortcutDetails, size.",
    ),
  followShortcut: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), shortcuts resolve to the target file's metadata."),
});

export const DriveReadFileSchema = z.object({
  fileId: DriveIdSchema.describe("Drive file ID."),
  maxChars: coerceInt({ min: 1000, max: 5_000_000 })
    .optional()
    .default(200_000)
    .describe(
      "Maximum text-body size to return inline. Default 200000 (~50 KB UTF-8). Output beyond the cap is truncated with a marker; binary files ignore this and always save to disk.",
    ),
  savePath: z
    .string()
    .optional()
    .describe(
      "For binary files only — directory inside GMAIL_MCP_DOWNLOAD_DIR to save to. Defaults to the download dir root.",
    ),
});

export const DriveDownloadFileSchema = z.object({
  fileId: DriveIdSchema.describe(
    "Drive file ID. Native Workspace types (Docs/Sheets/Slides) cannot be downloaded raw — use drive_read_file instead, which exports them.",
  ),
  filename: z
    .string()
    .optional()
    .describe("Filename to save as. Defaults to the Drive file's name."),
  savePath: z
    .string()
    .optional()
    .describe("Directory inside GMAIL_MCP_DOWNLOAD_DIR. Defaults to the download dir root."),
});

export const DriveListSharedDrivesSchema = z.object({
  pageSize: coerceInt({ min: 1, max: 100 })
    .optional()
    .default(50)
    .describe("Max shared drives per page (1-100, default 50)."),
  pageToken: z.string().optional().describe("Continuation token."),
});

export const DriveListCommentsSchema = z.object({
  fileId: DriveIdSchema.describe("Drive file ID to list comments on."),
  includeResolved: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include resolved comments (default false to suppress historical noise)."),
  pageSize: coerceInt({ min: 1, max: 100 })
    .optional()
    .default(50)
    .describe("Max comments per page (1-100, default 50). Replies are inline-expanded per comment."),
  pageToken: z.string().optional().describe("Continuation token."),
});

export const DriveReplyToCommentSchema = z.object({
  fileId: DriveIdSchema.describe("Drive file ID containing the comment."),
  commentId: DriveIdSchema.describe("Comment ID to reply to (from drive_list_comments)."),
  content: z.string().min(1).max(50_000).describe("Reply text content. Plain text."),
});

export const DriveTrashFileSchema = z.object({
  fileId: DriveIdSchema.describe("Drive file ID to move to Trash."),
});

// Slides outline shape — one slide.
export const SlideOutlineSchema = z.object({
  title: z.string().max(500).describe("Slide title (rendered in the TITLE placeholder)."),
  bullets: coerceArray(z.string().max(2000), { max: 50 })
    .optional()
    .describe("Bullet points for the BODY placeholder. Optional. Each entry becomes one bullet."),
  speakerNotes: z
    .string()
    .max(20000)
    .optional()
    .describe("Optional speaker notes for the slide."),
});

export const SlidesCreateDeckFromOutlineSchema = z.object({
  title: z.string().min(1).max(255).describe("Deck title (also becomes the Drive file name)."),
  slides: coerceArray(SlideOutlineSchema, { max: 100 }).describe(
    "Ordered list of slide outlines. The first item renders as a TITLE+SUBTITLE slide; remaining items use TITLE_AND_BODY layout.",
  ),
  parentFolderId: DriveIdSchema.optional().describe(
    "Optional Drive folder ID to create the deck in. Defaults to My Drive root.",
  ),
});

export const SlidesAppendToDeckSchema = z.object({
  presentationId: DriveIdSchema.describe("Existing Slides deck ID to append slides to."),
  slides: coerceArray(SlideOutlineSchema, { max: 100 }).describe(
    "Ordered list of slide outlines to append at the end (TITLE_AND_BODY layout).",
  ),
});

// Docs operations (v0.32) — multi-tab release-notes docs backed by docs_v1.
// One row of a native Docs table; `cells` are the left-to-right cell values.
export const DocsTableRowSchema = z.object({
  cells: coerceArray(z.string().max(4000), { max: 30 }).describe(
    "Ordered cell values for one table row, left to right.",
  ),
});

export const DocsCreateReleaseDocSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(255)
    .describe("Doc title and Drive file name, e.g. '[draft] Release Notes 2026-06-25'."),
  parentFolderId: DriveIdSchema.optional().describe(
    "Drive folder or shared-drive ID to create the doc in. Defaults to My Drive root.",
  ),
  tabTitles: coerceArray(z.string().min(1).max(200), { max: 10 })
    .optional()
    .describe(
      "Tab titles to create, in order. Defaults to ['Checklist','Draft']. The doc's default tab is renamed to the first title; remaining titles are added as new tabs.",
    ),
  pageless: z
    .boolean()
    .optional()
    .describe("Set the document to pageless mode (best-effort). Defaults to true."),
});

export const DocsWriteTabSchema = z.object({
  documentId: DriveIdSchema.describe("Target Google Doc ID."),
  tabId: z
    .string()
    .min(1)
    .optional()
    .describe("Target tab ID. If omitted, `tabTitle` is resolved to a tab ID; if both omitted, the first tab is used."),
  tabTitle: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Target tab by title (resolved to a tab ID). Ignored when `tabId` is provided."),
  mode: z
    .enum(["replace", "append"])
    .optional()
    .describe("replace: clear the tab body before writing. append: add after existing content. Defaults to replace."),
  table: coerceArray(DocsTableRowSchema, { max: 500 })
    .optional()
    .describe("Rows of a native Docs table to insert (the first row is the header). Use for the Checklist tab."),
  markdown: z
    .string()
    .max(200000)
    .optional()
    .describe("Narrative text to insert: '# '/'## ' lines become headings, '- ' lines become bullets, blank-line-separated blocks become paragraphs. Use for the Draft tab."),
});

export const DocsReadTabSchema = z.object({
  documentId: DriveIdSchema.describe("Target Google Doc ID."),
  tabTitle: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Read only the tab with this exact title (e.g. 'Checklist'). If omitted, every tab is returned, each under its own heading."),
});

// Sheets operations (v0.33) — full-tab overwrite.
export const SheetsWriteTabSchema = z.object({
  fileId: DriveIdSchema.describe("Target Google Sheets spreadsheet ID."),
  tabTitle: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Exact title of an existing tab to overwrite. The tab must already exist — this tool does not create new tabs.",
    ),
  rows: coerceArray(coerceArray(z.string().max(50000), { max: 2000 }), { max: 5000 }).describe(
    "Full replacement content for the tab: an ordered list of rows, each an ordered list of cell values (left to right). The entire existing tab is cleared first, then these rows are written starting at A1 with USER_ENTERED input (numbers/dates parse the same as a manual paste). This is a full overwrite, not a patch — there is no partial-range mode.",
  ),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, returns the tab's current rows alongside the rows that would be written, without calling the Sheets write API. Use to preview the diff before committing. Independent of the global GMAIL_MCP_DRY_RUN env var, which only echoes back the call args without reading the live sheet.",
    ),
});

// Tool definition type
export interface ToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  // zod-to-json-schema@3's public signature widens to `z.ZodType<any>`;
  // using a tighter generic here causes a structural mismatch at the
  // consumer call site. The `any` is fenced inside ToolDefinition only.
  schema: z.ZodType<unknown>;
  scopes: string[]; // Any of these scopes grants access
  annotations: ToolAnnotations;
}

// Tool registry with scope requirements
export const toolDefinitions: ToolDefinition[] = [
  // Read-only email operations
  {
    name: "read_email",
    description: [
      "Retrieve the full content of one Gmail message by `messageId`, including headers, body, and attachment metadata.",
      "",
      "USE WHEN: a `messageId` is already known (typically from `search_emails`, `list_inbox_threads`, or a webhook).",
      "",
      "DO NOT USE: to enumerate the inbox (use `search_emails` or `list_inbox_threads`). For an entire thread use `get_thread`. To save the message to a file without filling context, use `download_email`.",
    ].join("\n"),
    schema: ReadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Read Email", readOnlyHint: true },
  },
  {
    name: "search_emails",
    description: [
      "Search for messages using Gmail's native query syntax (e.g. `from:foo@bar.com after:2024/01/01 has:attachment`).",
      "",
      "USE WHEN: locating messages by sender, date, subject, label, or any Gmail operator. Returns a flat list of matches across the whole mailbox (not thread-grouped).",
      "",
      "DO NOT USE: to read one specific message whose ID is already known (use `read_email`). For thread-grouped browsing, use `list_inbox_threads`.",
    ].join("\n"),
    schema: SearchEmailsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Search Emails", readOnlyHint: true },
  },
  {
    name: "download_attachment",
    description: [
      "Download a Gmail attachment to a path on the host filesystem.",
      "",
      "USE WHEN: persisting an attachment locally for archival, OCR, or downstream processing. The filename is sanitized server-side (path-traversal blocked, control chars stripped).",
      "",
      "DO NOT USE: to inspect an attachment's metadata only — use `read_email` (returns attachment list with size + MIME type). The destination path must be writable by the MCP host process.",
    ].join("\n"),
    schema: DownloadAttachmentSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Attachment", readOnlyHint: true },
  },

  // Thread-level operations
  {
    name: "get_thread",
    description: [
      "Retrieve all messages in a thread in one call, ordered chronologically (oldest first) with full content, headers, labels, and attachment metadata.",
      "",
      "USE WHEN: reading a full conversation, building a reply that needs context, or analysing back-and-forth across multiple messages.",
      "",
      "DO NOT USE: to read one specific message (use `read_email`). To browse multiple threads at once with bodies expanded, use `get_inbox_with_threads`.",
    ].join("\n"),
    schema: GetThreadSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Thread", readOnlyHint: true },
  },
  {
    name: "list_inbox_threads",
    description: [
      "List email threads matching a Gmail query (default: inbox). Returns a thread-level view with snippet, message count, and latest message metadata.",
      "",
      "USE WHEN: browsing the inbox by conversation rather than by individual messages. Cheaper than fetching message bodies — useful for triage or finding a thread ID.",
      "",
      "DO NOT USE: to read individual messages (use `read_email`). For one specific thread you already know, use `get_thread`. To browse with bodies expanded, use `get_inbox_with_threads`.",
    ].join("\n"),
    schema: ListInboxThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "List Inbox Threads", readOnlyHint: true },
  },
  {
    name: "get_inbox_with_threads",
    description: [
      "List threads and optionally expand each with full message content in a single call.",
      "",
      "USE WHEN: bulk-reading a slice of the inbox (last N threads, daily digest). Saves a round-trip per thread compared to `list_inbox_threads` + `get_thread` × N.",
      "",
      "DO NOT USE: when only one thread is needed (use `get_thread`). For just thread metadata without bodies, use `list_inbox_threads` (cheaper). Returned payload can be large — bound `maxResults` to control context usage.",
    ].join("\n"),
    schema: GetInboxWithThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Inbox with Threads", readOnlyHint: true },
  },
  {
    name: "modify_thread",
    description: [
      "Modify labels on ALL messages in a thread atomically (Gmail `threads.modify` endpoint).",
      "",
      'USE WHEN: archiving a whole conversation (`removeLabelIds: ["INBOX"]`), marking a thread as read (`removeLabelIds: ["UNREAD"]`), applying a project label across all messages, etc. Atomic — either every message updates or none.',
      "",
      "DO NOT USE: to modify one specific message in a thread (use `modify_email`). To purge a thread, modify-to-trash + then `batch_delete_emails`. Filters are not retroactive — apply labels via this tool, not by creating a filter.",
      "",
      "SIDE EFFECTS: rewrites the label set on every message in the thread. **Reversible** — re-issue with the inverse `addLabelIds` / `removeLabelIds`. Idempotent (calling twice is a no-op). Visible in Gmail UI immediately.",
    ].join("\n"),
    schema: ModifyThreadSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Thread", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "download_email",
    description: [
      "Save one Gmail message to a file (json, eml, txt, or html).",
      "",
      "USE WHEN: persisting a message to disk for archival, evidence, or downstream processing. Returns metadata + the path written — bodies are NOT loaded into the LLM context, so this is the right choice for large messages.",
      "",
      "DO NOT USE: to read content into the LLM (use `read_email` or `get_thread`). The destination path must be writable by the MCP host process; filename traversal is blocked.",
    ].join("\n"),
    schema: DownloadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Email", readOnlyHint: true },
  },

  // Email write operations
  {
    name: "send_email",
    description: [
      "Send a new email from the authenticated Gmail account. **The email is delivered to the recipient(s) immediately.**",
      "",
      "USE WHEN: composing and dispatching a fresh outbound email. ALWAYS confirm recipients, subject, body, and attachments with the user before calling — there is no draft step.",
      "",
      "DO NOT USE: to reply to an existing thread (use `reply_all` for full-list replies; threading headers are set automatically). To stage a draft for later review, use `draft_email`. To send to a recipient that has not been pre-approved when `GMAIL_MCP_RECIPIENT_PAIRING` is enabled, the call will be rejected — pair the address first via `pair_recipient`.",
      "",
      "SIDE EFFECTS: real email leaves the account, recorded in the `Sent` mailbox, billed against the account's daily send quota. Audit log entry on the MCP host.",
    ].join("\n"),
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Email", destructiveHint: false },
  },
  {
    name: "pair_recipient",
    description: [
      "Manage the paired-recipient allowlist (`~/.gmail-mcp/paired.json`). Actions: `add`, `remove`, `list`. Only effective when `GMAIL_MCP_RECIPIENT_PAIRING` is enabled.",
      "",
      "USE WHEN: pre-approving a To/Cc/Bcc address so future `send_email` / `reply_all` / `draft_email` calls go through without per-call confirmation. Designed to cap the blast radius of a prompt-injected send.",
      "",
      "DO NOT USE: with the gate disabled — pairing has no effect there. ALWAYS confirm with the user before adding an address: paired addresses can be emailed without further approval.",
      "",
      "SIDE EFFECTS: writes to `~/.gmail-mcp/paired.json` on the MCP host. Persistent across runs. Idempotent on `add` (re-adding the same address is a no-op).",
    ].join("\n"),
    schema: PairRecipientSchema,
    // Exposed wherever the send surface is; an operator with a
    // readonly-only token has nothing to pair.
    scopes: ["gmail.modify", "gmail.compose", "gmail.send", "mail.google.com"],
    annotations: { title: "Pair Recipient", destructiveHint: false, idempotentHint: true },
  },
  {
    name: "draft_email",
    description: [
      "Save a new email as a draft in the Gmail Drafts folder. **No mail is sent.**",
      "",
      "USE WHEN: composing an email that the human should review and send manually from the Gmail UI. Useful for high-stakes outbound where the human-in-the-loop is required.",
      "",
      "DO NOT USE: to send immediately (use `send_email`). The draft remains visible in the user's Gmail Drafts folder until they send or delete it.",
      "",
      "SIDE EFFECTS: writes a draft to Gmail. Persistent. Counts toward the account's draft quota (rare to hit). Subject to the same recipient-pairing gate as `send_email` when enabled.",
    ].join("\n"),
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Draft Email", destructiveHint: false },
  },
  {
    name: "modify_email",
    description: [
      "Modify labels on one specific message (move between folders, mark read/unread, archive, trash).",
      "",
      'USE WHEN: changing the label set on a single message — archiving (`removeLabelIds: ["INBOX"]`), trashing (`addLabelIds: ["TRASH"]`), marking read, etc.',
      "",
      'DO NOT USE: to modify the entire thread (use `modify_thread` for atomic update). To delete permanently, use `delete_email` (`addLabelIds: ["TRASH"]` only moves to trash; messages stay there for 30 days). For multiple messages, use `batch_modify_emails`.',
      "",
      "SIDE EFFECTS: rewrites the label set on the message. **Reversible** by inverting `addLabelIds` / `removeLabelIds`. Idempotent. Visible in Gmail UI immediately.",
    ].join("\n"),
    schema: ModifyEmailSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Email", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_email",
    description: [
      "**PERMANENTLY DELETE** one Gmail message — bypasses Trash, no recovery.",
      "",
      "USE WHEN: purging a message that must not remain on Google's servers (compliance, data-leak response). ALWAYS confirm with the user before calling — Gmail offers no undo and does not send the message to Trash.",
      "",
      'DO NOT USE: for routine archival (use `modify_email` with `removeLabelIds: ["INBOX"]`). To move to Trash with the standard 30-day grace period, use `modify_email` with `addLabelIds: ["TRASH"]`. For multiple messages, use `batch_delete_emails`.',
      "",
      "SIDE EFFECTS: **irrecoverable deletion** server-side. Requires the full `mail.google.com` scope (the `gmail.modify` scope is rejected with HTTP 403 for this endpoint).",
    ].join("\n"),
    schema: DeleteEmailSchema,
    // Permanent delete requires the full mail.google.com scope.
    // gmail.modify is enough for trashing (modify_email) but the
    // users.messages.delete endpoint specifically rejects it with
    // HTTP 403 "Insufficient Permission".
    scopes: ["mail.google.com"],
    annotations: { title: "Delete Email", destructiveHint: true },
  },
  {
    name: "batch_modify_emails",
    description: [
      "Modify labels on a list of messages in chunked batches (Gmail's `batchModify` endpoint).",
      "",
      "USE WHEN: applying the same label change to many messages at once — bulk-archive 200 newsletters, mark a search-result set as read, label a project's worth of emails. Cheaper than calling `modify_email` N times.",
      "",
      "DO NOT USE: for one or two messages (use `modify_email`). All messages get the same `addLabelIds` / `removeLabelIds` — there is no per-message variation. The MCP chunks at Gmail's 1000-message limit; partial-batch failures may leave the operation half-applied.",
      "",
      "SIDE EFFECTS: rewrites labels across many messages. **Reversible** by re-running with the inverse. Idempotent. Audit log entry logs the message-ID list (truncated for readability).",
    ].join("\n"),
    schema: BatchModifyEmailsSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Modify Emails", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "batch_delete_emails",
    description: [
      "**PERMANENTLY DELETE** a list of messages in chunked batches (Gmail's `batchDelete` endpoint). Bypasses Trash, no recovery.",
      "",
      "USE WHEN: a compliance event or data-leak response requires purging many specific messages at once. ALWAYS confirm the message-ID list with the user — Gmail offers no undo at any point.",
      "",
      'DO NOT USE: to bulk-archive (use `batch_modify_emails` with `addLabelIds: ["TRASH"]`). For one message, use `delete_email`. The MCP chunks at Gmail\'s 1000-message limit; partial-batch failures may leave some deleted, some intact.',
      "",
      "SIDE EFFECTS: **irrecoverable deletion** of every listed message. Requires the full `mail.google.com` scope. Audit log entry logs the message-ID list (truncated for readability).",
    ].join("\n"),
    schema: BatchDeleteEmailsSchema,
    // Same scope requirement as delete_email — see comment above.
    scopes: ["mail.google.com"],
    annotations: { title: "Batch Delete Emails", destructiveHint: true },
  },

  // Label operations
  {
    name: "list_email_labels",
    description: [
      "List all Gmail labels (system + user-defined) available on the authenticated account.",
      "",
      "USE WHEN: discovering valid label IDs/names before calling `modify_email`, `modify_thread`, or any filter that targets labels. Also useful to confirm a label exists before `create_label`.",
      "",
      "DO NOT USE: to fetch one specific label by name — there is no get-single-label tool; call this and filter client-side.",
    ].join("\n"),
    schema: ListEmailLabelsSchema,
    scopes: ["gmail.readonly", "gmail.modify", "gmail.labels"],
    annotations: { title: "List Email Labels", readOnlyHint: true },
  },
  {
    name: "create_label",
    description: [
      "Create a new user label in the authenticated Gmail account.",
      "",
      "USE WHEN: setting up a new label for organisation (project name, status flag, custom inbox). The returned label `id` is what `modify_email` and `modify_thread` accept in `addLabelIds`.",
      "",
      "DO NOT USE: to create a label that may already exist — Gmail returns 409 on duplicate names. Use `get_or_create_label` for the idempotent variant.",
      "",
      "SIDE EFFECTS: writes a new label to the account. Persistent and visible in the Gmail UI immediately.",
    ].join("\n"),
    schema: CreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Create Label", destructiveHint: false },
  },
  {
    name: "update_label",
    description: [
      "Update an existing Gmail label (rename, change visibility, change colour).",
      "",
      "USE WHEN: renaming a label across the account or amending its visibility / colour. Existing messages keep the same label ID — no message reprocessing.",
      "",
      "DO NOT USE: to delete a label (use `delete_label`). Renaming a system label (`INBOX`, `SENT`, `DRAFT`, etc.) is rejected by Gmail.",
      "",
      "SIDE EFFECTS: overwrites the label record. The new name appears immediately in the Gmail UI on every message that had it. **Reversible** by calling again with the previous values. Idempotent.",
    ].join("\n"),
    schema: UpdateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Update Label", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_label",
    description: [
      "**Permanently delete** a Gmail label.",
      "",
      "USE WHEN: removing an obsolete label. Messages tagged with the label keep their other labels — only this association is removed. ALWAYS confirm with the user before calling.",
      "",
      "DO NOT USE: to rename a label (use `update_label`). System labels (`INBOX`, `SENT`, `DRAFT`, etc.) cannot be deleted — Gmail rejects the request.",
      "",
      "SIDE EFFECTS: the label disappears from the account. Messages that had it lose this association — re-tagging requires the original messages to be retrieved and re-modified individually. Not recoverable from API.",
    ].join("\n"),
    schema: DeleteLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Delete Label", destructiveHint: true },
  },
  {
    name: "get_or_create_label",
    description: [
      "Idempotent label lookup-or-create: returns the label if it already exists, otherwise creates it.",
      "",
      "USE WHEN: ensuring a label is available before `modify_email` / `modify_thread`, without caring whether it pre-existed. Safe to call repeatedly.",
      "",
      "DO NOT USE: to enumerate labels (use `list_email_labels`). Equivalent of `create_label` if you specifically want to fail on duplicates.",
      "",
      "SIDE EFFECTS: may create a new label (persistent) on first call; subsequent calls with the same name are no-ops at the API level.",
    ].join("\n"),
    schema: GetOrCreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Get or Create Label", destructiveHint: false, idempotentHint: true },
  },

  // Filter operations (require settings scope)
  {
    name: "list_filters",
    description: [
      "List all Gmail filters configured on the authenticated account.",
      "",
      "USE WHEN: auditing filter rules, finding a filter ID before update/delete, or confirming a rule already exists before creating a duplicate.",
      "",
      "DO NOT USE: to fetch one specific filter whose ID is known (use `get_filter`).",
    ].join("\n"),
    schema: ListFiltersSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "List Filters", readOnlyHint: true },
  },
  {
    name: "get_filter",
    description: [
      "Retrieve the full detail of one Gmail filter by ID (criteria + actions).",
      "",
      "USE WHEN: inspecting a specific filter's rules whose ID is already known (typically from `list_filters`).",
      "",
      "DO NOT USE: to enumerate filters (use `list_filters`).",
    ].join("\n"),
    schema: GetFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Get Filter", readOnlyHint: true },
  },
  {
    name: "create_filter",
    description: [
      "Create a new Gmail filter from custom criteria + actions (e.g. `from:newsletter@x.com` → archive + apply label).",
      "",
      "USE WHEN: automating inbox routing for a specific pattern not covered by Gmail's built-in templates. The filter applies to FUTURE messages only — past matching messages are not retroactively processed.",
      "",
      "DO NOT USE: for common patterns (newsletter routing, vendor invoices, etc.) — `create_filter_from_template` covers those with safer defaults. Filters are not idempotent — calling twice creates two filters firing duplicate actions.",
      "",
      "SIDE EFFECTS: writes a new filter rule on Gmail's side. Persistent. Affects every future incoming message that matches the criteria. The optional `action.forward` field installs a persistent forwarding rule and is therefore gated by the same recipient-pairing allowlist as `send_email` / `reply_all` / `draft_email` when `GMAIL_MCP_RECIPIENT_PAIRING=true` — pair the address via `pair_recipient` first. Requires `gmail.settings.basic` scope.",
    ].join("\n"),
    schema: CreateFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter", destructiveHint: true },
  },
  {
    name: "delete_filter",
    description: [
      "**Permanently delete** a Gmail filter. Future incoming messages stop being processed by the rule.",
      "",
      "USE WHEN: removing an obsolete or wrongly-configured filter. ALWAYS confirm with the user — there is no undo, and any incoming-mail automation that depended on the filter stops working.",
      "",
      "DO NOT USE: to temporarily disable a filter — Gmail offers no pause-state, only delete / recreate. To inspect first, fetch via `get_filter`.",
      "",
      "SIDE EFFECTS: filter rule is removed server-side. Past messages already processed by the filter are NOT reverted — only future messages are affected. Not recoverable from API. Requires `gmail.settings.basic` scope.",
    ].join("\n"),
    schema: DeleteFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Delete Filter", destructiveHint: true },
  },
  {
    name: "create_filter_from_template",
    description: [
      "Create a filter from a pre-defined template (`fromSender`, `withSubject`, `withAttachments`, `largeEmails`, `containingText`, `mailingList`). Safer than free-form filter creation — templates are vetted.",
      "",
      "USE WHEN: setting up routing for a common pattern. Templates encode tested combinations of criteria + actions, sparing the agent the burden of crafting a correct query.",
      "",
      "DO NOT USE: for one-off custom rules (use `create_filter`).",
      "",
      "SIDE EFFECTS: same as `create_filter` — writes a persistent filter rule, applies to future messages only. Requires `gmail.settings.basic` scope.",
    ].join("\n"),
    schema: CreateFilterFromTemplateSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter from Template", destructiveHint: false },
  },

  // Reply-all operation
  {
    name: "reply_all",
    description: [
      "Reply to a thread, addressing every original recipient (To + CC). The MCP fetches the source message, builds the recipient list, and sets `In-Reply-To` / `References` headers automatically. **The reply is sent immediately.**",
      "",
      "USE WHEN: replying to a multi-party thread where every original recipient should receive the response. ALWAYS confirm the recipient list with the user before calling — `reply_all` can broadcast to a much wider audience than expected.",
      "",
      "DO NOT USE: when the user only wants to reply to the sender — use `reply_to_email` for sender-only replies. To stage a draft for review, use `draft_email`.",
      "",
      "SIDE EFFECTS: real email leaves the account, recorded in the `Sent` mailbox, billed against daily send quota. Subject to the same `GMAIL_MCP_RECIPIENT_PAIRING` gate as `send_email`.",
    ].join("\n"),
    schema: ReplyAllSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Reply All", destructiveHint: false },
  },

  // Sender-only reply
  {
    name: "reply_to_email",
    description: [
      "Reply to a thread, addressing the original sender ONLY (no Cc, no broadcast). The MCP fetches the source message, picks the original `From:` as the sole recipient, preserves `Subject:` (with `Re:` prefix added if absent), and sets `In-Reply-To` / `References` headers automatically. **The reply is sent immediately.**",
      "",
      "USE WHEN: replying privately to the person who sent the message — the safe default for a sender-only follow-up where `reply_all` would over-broadcast to everyone on the original `To:`/`Cc:` list.",
      "",
      "DO NOT USE: when every original recipient should receive the response (use `reply_all`). To stage a draft for review instead of sending, use `draft_email`.",
      "",
      "SIDE EFFECTS: real email leaves the account, recorded in the `Sent` mailbox, billed against daily send quota. Subject to the same `GMAIL_MCP_RECIPIENT_PAIRING` gate as `send_email`.",
    ].join("\n"),
    schema: ReplyToEmailSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Reply To Email", destructiveHint: false },
  },

  // =====================================================================
  // Drive operations (v0.31)
  // =====================================================================
  {
    name: "drive_search",
    description: [
      "Search Google Drive by name, full-text content, mimeType, modifiedTime, parent, owner, or any other Drive `q=` operator.",
      "",
      "USE WHEN: locating a file by content (`fullText contains 'quarterly review'`), by name pattern (`name contains 'budget'`), by type (`mimeType = 'application/vnd.google-apps.document'`), or by sharing (`sharedWithMe = true`). Returns the lightweight metadata an agent needs to call drive_get_metadata, drive_read_file, or drive_list_comments next.",
      "",
      "DO NOT USE: to read file content (use `drive_read_file`). For one specific fileId, use `drive_get_metadata`. To list shared drives, use `drive_list_shared_drives`.",
    ].join("\n"),
    schema: DriveSearchSchema,
    scopes: ["drive", "drive.readonly"],
    annotations: { title: "Drive: Search", readOnlyHint: true },
  },
  {
    name: "drive_get_metadata",
    description: [
      "Retrieve metadata for one Drive file by ID — name, mimeType, owners, parents, modifiedTime, capabilities, webViewLink, size, shortcutDetails.",
      "",
      "USE WHEN: a fileId is already known and you need to inspect it (often to decide which `drive_read_file` branch will fire — Workspace doc vs PDF vs binary). On shortcuts, returns the target file's metadata by default.",
      "",
      "DO NOT USE: to read content (use `drive_read_file`). To enumerate files, use `drive_search`.",
    ].join("\n"),
    schema: DriveGetMetadataSchema,
    scopes: ["drive", "drive.readonly"],
    annotations: { title: "Drive: Get Metadata", readOnlyHint: true },
  },
  {
    name: "drive_read_file",
    description: [
      "Read a Drive file's content into the LLM context (or save it to disk if binary). Dispatches on mimeType: Google Docs → markdown (with text/plain fallback); Google Sheets → all tabs as CSV via Sheets API (multi-tab safe — Drive's files.export(text/csv) only returns the first tab); Google Slides → structured outline via Slides API (slide titles + bullets + speaker notes); PDFs / images / arbitrary binaries → saved under GMAIL_MCP_DOWNLOAD_DIR. Shortcuts resolve to their target before reading.",
      "",
      "USE WHEN: pulling Drive content into the conversation. The single tool covers every common filetype Rob touches; use `drive_download_file` only when you need the raw binary path without parsing.",
      "",
      "DO NOT USE: on Drive folders (returns a structured error suggesting drive_search with `'<folderId>' in parents`). Drawings / Forms / Jamboards have no useful text export and return a structured error rather than a silent empty file. Files exceeding Drive's 10 MB export cap return `exportSizeLimitExceeded` — fall back to `drive_download_file` for the raw bytes.",
      "",
      "SIDE EFFECTS: text content is returned inline (truncated with a marker if it exceeds `maxChars`). Binary files are written to GMAIL_MCP_DOWNLOAD_DIR via the same O_NOFOLLOW/O_EXCL jail used for Gmail attachments — destination path is returned in the response.",
    ].join("\n"),
    schema: DriveReadFileSchema,
    scopes: ["drive", "drive.readonly"],
    annotations: { title: "Drive: Read File", readOnlyHint: true },
  },
  {
    name: "drive_download_file",
    description: [
      "Download a non-Workspace Drive file (PDF, image, Office doc, arbitrary binary) to GMAIL_MCP_DOWNLOAD_DIR.",
      "",
      "USE WHEN: persisting a binary to disk for downstream tooling, or when `drive_read_file` returned an `exportSizeLimitExceeded` and you want the raw bytes anyway.",
      "",
      "DO NOT USE: on native Google Workspace types (Docs / Sheets / Slides) — Drive returns 403 on `alt=media` for those; use `drive_read_file` which routes through `files.export` / Sheets API / Slides API instead. To read inline content, use `drive_read_file`.",
      "",
      "SIDE EFFECTS: writes a file under GMAIL_MCP_DOWNLOAD_DIR using the same O_NOFOLLOW/O_EXCL jail as Gmail attachments. Returns the absolute path.",
    ].join("\n"),
    schema: DriveDownloadFileSchema,
    scopes: ["drive", "drive.readonly"],
    annotations: { title: "Drive: Download File", readOnlyHint: true },
  },
  {
    name: "drive_list_shared_drives",
    description: [
      "List the shared drives the authenticated user is a member of.",
      "",
      "USE WHEN: discovering shared-drive IDs to scope a `drive_search` (with `driveId`/`corpora` filters) or to confirm membership of a known shared drive.",
      "",
      "DO NOT USE: to list files in a shared drive (use `drive_search` with `includeItemsFromAllDrives` and a `'<driveId>' in parents` filter).",
    ].join("\n"),
    schema: DriveListSharedDrivesSchema,
    scopes: ["drive", "drive.readonly"],
    annotations: { title: "Drive: List Shared Drives", readOnlyHint: true },
  },
  {
    name: "drive_list_comments",
    description: [
      "List comments on a Drive file with reply threads inline-expanded in a single call.",
      "",
      "USE WHEN: reviewing comments left on a Doc / Sheet / Slides for response. The Drive API has no cross-file comment inbox endpoint — to discover *which* files have new comments addressed to you, use the existing Gmail tool `search_emails` with `from:comments-noreply@docs.google.com newer_than:7d`, extract the fileId from the notification email body or URL, then call this tool. By default resolved comments are excluded (set `includeResolved: true` to include them).",
      "",
      "DO NOT USE: to read the underlying file content (use `drive_read_file`).",
    ].join("\n"),
    schema: DriveListCommentsSchema,
    scopes: ["drive", "drive.readonly"],
    annotations: { title: "Drive: List Comments", readOnlyHint: true },
  },
  {
    name: "drive_trash_file",
    description: [
      "Move a Drive file to Trash. Reversible: the file stays in Trash for 30 days, after which Drive auto-purges it. **Not** a permanent delete.",
      "",
      "USE WHEN: cleaning up test artifacts or files the user explicitly asked to remove. Idempotent — calling on an already-trashed file is a no-op. Always confirm with the user before calling, even though the operation is reversible.",
      "",
      "DO NOT USE: as a permanent delete (Drive's hard-delete endpoint isn't exposed by this MCP — pull a file out of Trash via Drive UI if needed, or wait 30 days). On Drive folders, this trashes the folder AND every file underneath it; confirm folder contents first via `drive_search`.",
      "",
      "SIDE EFFECTS: file disappears from active Drive views, still recoverable from Trash for 30 days. Email-notify behavior depends on the file's sharing settings.",
    ].join("\n"),
    schema: DriveTrashFileSchema,
    scopes: ["drive"],
    annotations: { title: "Drive: Trash File", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "drive_reply_to_comment",
    description: [
      "Reply to an existing comment on a Drive file. **The reply is posted immediately and is visible to every collaborator on the file.**",
      "",
      "USE WHEN: responding to review feedback that was discovered via `drive_list_comments` (typically discovered via Gmail comment notifications first). ALWAYS confirm the reply text with the user before calling — the post is immediate, public to collaborators, and email-notifies them.",
      "",
      "DO NOT USE: to leave a brand-new comment anchor on a passage of text — Drive API supports `comments.create` for that, but this tool is intentionally restricted to threaded replies (lower blast radius for an LLM-driven workflow). To draft an unsent reply, paste it into the reply box manually in the Doc UI.",
      "",
      "SIDE EFFECTS: persistent comment reply on Drive, broadcast to all collaborators on the file via Google's notification settings. Requires the full `drive` scope — `drive.readonly` is rejected.",
    ].join("\n"),
    schema: DriveReplyToCommentSchema,
    scopes: ["drive"],
    annotations: { title: "Drive: Reply To Comment", destructiveHint: false },
  },

  // =====================================================================
  // Slides operations (v0.31)
  // =====================================================================
  {
    name: "slides_create_deck_from_outline",
    description: [
      "Create a new Google Slides deck from a structured outline. Takes a deck title and an ordered list of slides, each with a title, optional bullets, and optional speaker notes. The first slide renders as a TITLE+SUBTITLE cover slide; the rest use TITLE_AND_BODY layout. **The new deck is saved to Drive immediately.**",
      "",
      "USE WHEN: drafting a fresh deck from outline content (e.g. a structured outline produced by Claude). The returned `presentationId` + `webViewLink` lets the user open the deck for manual review/styling. Layout defaults to whatever the deck theme provides.",
      "",
      "DO NOT USE: to populate an existing deck — use `slides_append_to_deck` for that. Styling, layout selection, image insertion, and speaker-note formatting beyond plain text are out of scope.",
      "",
      "SIDE EFFECTS: writes a new presentation to Drive (in My Drive root or `parentFolderId` if specified). Persistent. Counts toward Drive storage quota. Two API round-trips per call (create + batchUpdate with placeholderIdMappings + insertText). Requires both `drive` (for Drive file creation / parent placement) and `presentations` scope.",
    ].join("\n"),
    schema: SlidesCreateDeckFromOutlineSchema,
    scopes: ["presentations"],
    annotations: { title: "Slides: Create Deck from Outline", destructiveHint: false },
  },
  {
    name: "slides_append_to_deck",
    description: [
      "Append slides to an existing Google Slides deck by ID. Same outline shape as `slides_create_deck_from_outline` (TITLE_AND_BODY layout). **Slides are appended immediately and are visible to every collaborator on the deck.**",
      "",
      "USE WHEN: iterating on a draft deck — adding more slides after the user reviewed the initial output, or programmatically extending an existing deck with new content. The deck must already exist (use `slides_create_deck_from_outline` to create one).",
      "",
      "DO NOT USE: to create a new deck (use `slides_create_deck_from_outline`). Editing existing slides' content is not supported — append-only.",
      "",
      "SIDE EFFECTS: persistent slide additions on the existing deck, visible to collaborators. Single batchUpdate call (createSlide with predefined placeholderIdMappings + insertText in the same request). Requires the `presentations` scope.",
    ].join("\n"),
    schema: SlidesAppendToDeckSchema,
    scopes: ["presentations"],
    annotations: { title: "Slides: Append To Deck", destructiveHint: false },
  },

  // =====================================================================
  // Docs operations (v0.32) — multi-tab release-notes docs
  // =====================================================================
  {
    name: "docs_create_release_doc",
    description: [
      "Create a new Google Doc with named tabs (the sidebar tabs, via the Docs API), optionally pageless, optionally placed in a shared drive. Defaults to two tabs: 'Checklist' and 'Draft'. **The new doc is written to Drive immediately.**",
      "",
      "USE WHEN: standing up a release-notes doc the team will review — one tab for the review checklist table, one for the narrative draft. Returns `documentId`, the resolved `{title, tabId}` for each tab, and a `webViewLink`. Populate the tabs afterward with `docs_write_tab`.",
      "",
      "DO NOT USE: to write content (use `docs_write_tab`) or to read a tab back (use `docs_read_tab`). Styling beyond pageless + headings/bullets/tables is out of scope.",
      "",
      "SIDE EFFECTS: writes a new document to Drive (My Drive root or `parentFolderId`). Persistent; counts toward Drive storage quota. Several API round-trips (create + get + batchUpdate to rename the default tab, add tabs, and set pageless). Requires both `documents` (Docs API) and `drive` (file creation / shared-drive placement) scopes.",
    ].join("\n"),
    schema: DocsCreateReleaseDocSchema,
    scopes: ["documents"],
    annotations: { title: "Docs: Create Release Doc", destructiveHint: false },
  },
  {
    name: "docs_write_tab",
    description: [
      "Write content into one tab of an existing Google Doc. Accepts a native `table` (rows of cells; first row is the header) and/or `markdown` narrative ('# '/'## ' headings, '- ' bullets, blank-line-separated paragraphs). Target the tab by `tabId` or `tabTitle`. **Edits are written immediately and visible to every collaborator.**",
      "",
      "USE WHEN: populating the Checklist tab with the review table (`table`) or the Draft tab with the narrative (`markdown`). `mode: replace` (default) clears the tab body first; `mode: append` adds after existing content.",
      "",
      "DO NOT USE: to create the doc or its tabs (use `docs_create_release_doc`). Rich formatting beyond headings, bullets, and a plain table is out of scope.",
      "",
      "SIDE EFFECTS: persistent edits to the named tab, visible to collaborators. Table fills run a multi-pass batchUpdate (insert table, re-read cell indices, fill cells in descending index order). Requires the `documents` scope.",
    ].join("\n"),
    schema: DocsWriteTabSchema,
    scopes: ["documents"],
    annotations: { title: "Docs: Write Tab", destructiveHint: false },
  },
  {
    name: "docs_read_tab",
    description: [
      "Read the content of one tab (or all tabs) of a Google Doc as markdown, using the Docs API with per-tab content. Paragraphs (with heading levels), bullets, and tables are serialized to markdown so the content can be parsed downstream. Read-only.",
      "",
      "USE WHEN: ingesting a reviewed tab back — e.g. reading the labeled 'Checklist' tab to recover the review table. `drive_read_file` flattens all tabs into one blob and cannot select a tab; this tool reads exactly the named tab.",
      "",
      "DO NOT USE: to read a non-tabbed Doc's whole body (use `drive_read_file`). Binary/exported formats are out of scope.",
      "",
      "SIDE EFFECTS: none — read-only. Requires the `documents` scope (`drive.readonly` is not sufficient for per-tab content).",
    ].join("\n"),
    schema: DocsReadTabSchema,
    scopes: ["documents"],
    annotations: { title: "Docs: Read Tab", readOnlyHint: true, destructiveHint: false },
  },

  // =====================================================================
  // Sheets operations (v0.33) — full-tab overwrite
  // =====================================================================
  {
    name: "sheets_write_tab",
    description: [
      "Overwrite the full contents of one tab in an existing Google Sheet. Clears the entire tab, then writes the given rows starting at A1 with USER_ENTERED semantics (same parsing as a manual paste). **Edits are written immediately and visible to every collaborator** unless `dryRun: true`.",
      "",
      "USE WHEN: pushing a fully-prepared replacement for a tab's contents — e.g. after editing a CSV/table externally and the complete new row set is ready. Call with `dryRun: true` first to see the tab's current rows alongside the rows that would be written, then call again with `dryRun: false` once confirmed.",
      "",
      "DO NOT USE: to create a new tab (the tab must already exist — call drive_read_file's `tabs` field or drive_get_metadata to confirm exact spelling first) or to patch a subset of cells (this tool always replaces the entire tab; there is no partial-range mode).",
      "",
      "SIDE EFFECTS: clears and rewrites the entire named tab. Not reversible through this MCP — recover via Google Sheets' built-in Version History (File > Version history) if needed. Requires the `spreadsheets` scope (full read-write; `spreadsheets.readonly` is rejected).",
    ].join("\n"),
    schema: SheetsWriteTabSchema,
    scopes: ["spreadsheets"],
    annotations: { title: "Sheets: Write Tab", destructiveHint: true, idempotentHint: true },
  },

  // Forward operation
  {
    name: "forward_email",
    description: [
      "Forward an existing message to a fresh recipient list. The MCP fetches the source, builds a Gmail-style quoted body (`---------- Forwarded message ---------` separator + From/Date/Subject/To headers + original text body), prepends the optional `body` preface, and sends in a NEW thread. **The forward is sent immediately.**",
      "",
      "USE WHEN: passing a message along to a recipient who was not on the original thread — the safe default for a relay handoff.",
      "",
      "DO NOT USE: to reply within the same thread (use `reply_to_email` or `reply_all`). To stage a draft for review, use `draft_email`. Attachments from the source message are NOT re-attached automatically — chain `download_attachment` then pass the resulting paths via `attachments` if you want them carried over.",
      "",
      "SIDE EFFECTS: real email leaves the account in a new thread, recorded in the `Sent` mailbox, billed against daily send quota. Subject to the same `GMAIL_MCP_RECIPIENT_PAIRING` gate as `send_email`.",
    ].join("\n"),
    schema: ForwardEmailSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Forward Email", destructiveHint: false },
  },
];

// Convert tool definitions to MCP tool format. Uses Zod v4's native
// `z.toJSONSchema()` (draft 2020-12). The external `zod-to-json-schema@3`
// library is incompatible with Zod v4's ZodType shape and silently emits
// `{"$schema": "..."}` with no `type`/`properties`, which fails MCP
// Inspector validation (the spec requires `inputSchema.type = "object"`).
export function toMcpTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema),
    annotations: tool.annotations,
  }));
}

// Get a tool definition by name
export function getToolByName(name: string): ToolDefinition | undefined {
  return toolDefinitions.find((t) => t.name === name);
}
