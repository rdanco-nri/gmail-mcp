/**
 * Drive tool registrars (v0.31).
 *
 * Seven tools backed by drive_v3 + sheets_v4 + slides_v1:
 *   - drive_search          (files.list with q syntax)
 *   - drive_get_metadata    (files.get with shortcut resolution)
 *   - drive_read_file       (mimeType dispatch — Docs→md, Sheets→CSV per tab,
 *                            Slides→structured outline, binaries→download jail)
 *   - drive_download_file   (files.get alt=media)
 *   - drive_list_shared_drives
 *   - drive_list_comments   (comments.list with inline replies)
 *   - drive_reply_to_comment (replies.create — full `drive` scope only)
 *
 * All seven flow through `defineTool()` for free middleware
 * (audit, rate-limit, sanitize, dry-run, scope-filter).
 *
 * Sheets API is used for multi-tab CSV reads — Drive's
 * `files.export(text/csv)` returns only the first/active tab.
 *
 * Slides API is used for structured outline reads (richer than the
 * `text/plain` export, which loses slide structure entirely).
 */

import path from "path";
import type { drive_v3, sheets_v4, slides_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import {
  DriveSearchSchema,
  DriveGetMetadataSchema,
  DriveReadFileSchema,
  DriveDownloadFileSchema,
  DriveListSharedDrivesSchema,
  DriveListCommentsSchema,
  DriveReplyToCommentSchema,
  DriveTrashFileSchema,
} from "../tools.js";
import {
  resolveDownloadSavePath,
  getDownloadDir,
  safeWriteFile,
  sanitizeAttachmentFilename,
} from "../utl.js";
import { asGmailApiError } from "../gmail-errors.js";

const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const PRES_MIME = "application/vnd.google-apps.presentation";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

// Workspace types we explicitly do NOT have a useful text export for.
// Better to fail loud than silently dump an empty binary in the jail.
const UNREADABLE_WORKSPACE_MIMES = new Set([
  "application/vnd.google-apps.drawing",
  "application/vnd.google-apps.jam",
  "application/vnd.google-apps.site",
  "application/vnd.google-apps.form",
  "application/vnd.google-apps.map",
  "application/vnd.google-apps.fusiontable",
]);

const DEFAULT_SEARCH_FIELDS =
  "files(id,name,mimeType,owners(displayName,emailAddress),modifiedTime,parents,webViewLink,size,shortcutDetails),nextPageToken";
const DEFAULT_METADATA_FIELDS =
  "id,name,mimeType,owners(displayName,emailAddress),parents,modifiedTime,capabilities,webViewLink,size,shortcutDetails";

async function getResolvedFileMeta(
  drive: drive_v3.Drive,
  fileId: string,
  fields: string,
  followShortcut: boolean,
): Promise<{ meta: drive_v3.Schema$File; resolvedId: string; followed: boolean }> {
  const initial = await drive.files.get({
    fileId,
    fields,
    supportsAllDrives: true,
  });
  const data = initial.data;
  if (followShortcut && data.mimeType === SHORTCUT_MIME && data.shortcutDetails?.targetId) {
    const target = await drive.files.get({
      fileId: data.shortcutDetails.targetId,
      fields,
      supportsAllDrives: true,
    });
    return { meta: target.data, resolvedId: data.shortcutDetails.targetId, followed: true };
  }
  return { meta: data, resolvedId: fileId, followed: false };
}

function structuredError(message: string): {
  content: { type: string; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function csvEscape(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  const s = String(cell);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n");
}

function truncateForLlm(
  text: string,
  maxChars: number,
): { body: string; truncated: boolean; originalLength: number } {
  if (text.length <= maxChars) {
    return { body: text, truncated: false, originalLength: text.length };
  }
  const cut = text.slice(0, maxChars);
  const marker = `\n\n[…truncated at ${maxChars} chars; original length ${text.length} chars. Pass a higher \`maxChars\` to drive_read_file to read more.]`;
  return { body: cut + marker, truncated: true, originalLength: text.length };
}

// Walk a Slides Page and extract concatenated plain text from any
// shape's textElements. Used for speaker notes (and any unanchored
// shapes outside the title/body placeholders).
function extractPageText(page: slides_v1.Schema$Page | undefined | null): string {
  if (!page?.pageElements) return "";
  const parts: string[] = [];
  for (const el of page.pageElements) {
    const textElements = el.shape?.text?.textElements;
    if (!textElements) continue;
    for (const te of textElements) {
      const content = te.textRun?.content;
      if (typeof content === "string") parts.push(content);
    }
  }
  return parts.join("").trim();
}

interface SlideOutlineExtract {
  index: number;
  title: string;
  body: string;
  speakerNotes: string;
}

function extractSlideOutline(
  presentation: slides_v1.Schema$Presentation,
): SlideOutlineExtract[] {
  const out: SlideOutlineExtract[] = [];
  const slides = presentation.slides ?? [];
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    if (!slide) continue;
    let title = "";
    const bodyParts: string[] = [];
    for (const el of slide.pageElements ?? []) {
      const placeholderType = el.shape?.placeholder?.type;
      const text = (el.shape?.text?.textElements ?? [])
        .map((te) => te.textRun?.content ?? "")
        .join("")
        .trim();
      if (!text) continue;
      if (placeholderType === "TITLE" || placeholderType === "CENTERED_TITLE") {
        if (!title) title = text;
      } else {
        bodyParts.push(text);
      }
    }
    const speakerNotes = extractPageText(slide.slideProperties?.notesPage);
    out.push({
      index: i + 1,
      title,
      body: bodyParts.join("\n").trim(),
      speakerNotes,
    });
  }
  return out;
}

export function registerDriveTools(
  server: McpServer,
  drive: drive_v3.Drive,
  sheets: sheets_v4.Sheets,
  slides: slides_v1.Slides,
  authorizedScopes: readonly string[],
): void {
  // ---- drive_search ----
  const searchMeta = pull("drive_search");
  defineTool(
    server,
    "drive_search",
    searchMeta.description,
    DriveSearchSchema.shape,
    async (args) => {
      try {
        const fields = args.fields ?? DEFAULT_SEARCH_FIELDS;
        const res = await drive.files.list({
          q: args.query,
          pageSize: args.pageSize,
          fields,
          pageToken: args.pageToken,
          includeItemsFromAllDrives: args.includeSharedDrives,
          supportsAllDrives: args.includeSharedDrives,
          corpora: args.includeSharedDrives ? "allDrives" : "user",
        });
        const result = {
          files: res.data.files ?? [],
          nextPageToken: res.data.nextPageToken ?? null,
          count: (res.data.files ?? []).length,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        const prefix =
          code !== undefined ? `drive_search failed (HTTP ${code})` : "drive_search failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    searchMeta.annotations,
    searchMeta.scopes,
    authorizedScopes,
  );

  // ---- drive_get_metadata ----
  const metaMeta = pull("drive_get_metadata");
  defineTool(
    server,
    "drive_get_metadata",
    metaMeta.description,
    DriveGetMetadataSchema.shape,
    async (args) => {
      try {
        const fields = args.fields ?? DEFAULT_METADATA_FIELDS;
        const { meta, resolvedId, followed } = await getResolvedFileMeta(
          drive,
          args.fileId,
          fields,
          args.followShortcut,
        );
        const result = {
          ...meta,
          requestedFileId: args.fileId,
          resolvedFileId: resolvedId,
          shortcutFollowed: followed,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 404) return structuredError(`File not found: ${message}`);
        if (code === 403)
          return structuredError(`Insufficient permissions on this file: ${message}`);
        const prefix =
          code !== undefined
            ? `drive_get_metadata failed (HTTP ${code})`
            : "drive_get_metadata failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    metaMeta.annotations,
    metaMeta.scopes,
    authorizedScopes,
  );

  // ---- drive_read_file ----
  const readMeta = pull("drive_read_file");
  defineTool(
    server,
    "drive_read_file",
    readMeta.description,
    DriveReadFileSchema.shape,
    async (args) => {
      try {
        const { meta, resolvedId, followed } = await getResolvedFileMeta(
          drive,
          args.fileId,
          DEFAULT_METADATA_FIELDS,
          true,
        );
        const mimeType = meta.mimeType ?? "";
        const name = meta.name ?? resolvedId;

        // Folders are not readable as content.
        if (mimeType === FOLDER_MIME) {
          return structuredError(
            `Cannot read a Drive folder as a file (id=${resolvedId}). To list folder contents, call drive_search with q="'${resolvedId}' in parents and trashed = false".`,
          );
        }
        // Workspace types we don't support exporting from.
        if (UNREADABLE_WORKSPACE_MIMES.has(mimeType)) {
          return structuredError(
            `Drive file "${name}" has mimeType "${mimeType}" which has no useful text export. Drive does not support exporting drawings, jamboards, sites, forms, etc. to text. Open in the Drive UI manually.`,
          );
        }

        // Google Docs → markdown export, with text/plain fallback on failure.
        if (mimeType === DOC_MIME) {
          let text: string;
          let exportMime = "text/markdown";
          try {
            const resp = await drive.files.export(
              { fileId: resolvedId, mimeType: "text/markdown" },
              { responseType: "text" },
            );
            text = typeof resp.data === "string" ? resp.data : String(resp.data ?? "");
          } catch (mdErr) {
            const { code: mdCode, message: mdMsg } = asGmailApiError(mdErr);
            if (mdCode === 403 && /exportSizeLimitExceeded/i.test(mdMsg)) {
              return structuredError(
                `exportSizeLimitExceeded: Drive Doc "${name}" exceeds the 10 MB export cap. Open in the Docs UI to read it.`,
              );
            }
            if (mdCode === 400 || mdCode === 403) {
              const resp = await drive.files.export(
                { fileId: resolvedId, mimeType: "text/plain" },
                { responseType: "text" },
              );
              text = typeof resp.data === "string" ? resp.data : String(resp.data ?? "");
              exportMime = "text/plain";
            } else {
              throw mdErr;
            }
          }
          const { body, truncated, originalLength } = truncateForLlm(text, args.maxChars);
          const result = {
            kind: "doc" as const,
            fileId: resolvedId,
            requestedFileId: args.fileId,
            shortcutFollowed: followed,
            name,
            mimeType,
            exportMimeType: exportMime,
            originalLength,
            truncated,
            body,
          };
          return {
            content: [{ type: "text", text: body }],
            structuredContent: result,
          };
        }

        // Google Sheets → enumerate tabs via Sheets API, then read each.
        if (mimeType === SHEET_MIME) {
          const sheetMeta = await sheets.spreadsheets.get({
            spreadsheetId: resolvedId,
            fields: "sheets.properties(title,sheetId,gridProperties)",
          });
          const tabTitles = (sheetMeta.data.sheets ?? [])
            .map((s) => s.properties?.title)
            .filter((t): t is string => typeof t === "string" && t.length > 0);
          const sections: string[] = [];
          for (const title of tabTitles) {
            const values = await sheets.spreadsheets.values.get({
              spreadsheetId: resolvedId,
              range: title,
            });
            const rows = (values.data.values ?? []) as unknown[][];
            sections.push(`# ${title}\n${rowsToCsv(rows)}`);
          }
          const text = sections.join("\n\n");
          const { body, truncated, originalLength } = truncateForLlm(text, args.maxChars);
          const result = {
            kind: "sheet" as const,
            fileId: resolvedId,
            requestedFileId: args.fileId,
            shortcutFollowed: followed,
            name,
            mimeType,
            tabs: tabTitles,
            originalLength,
            truncated,
            body,
          };
          return {
            content: [{ type: "text", text: body }],
            structuredContent: result,
          };
        }

        // Google Slides → structured outline via Slides API.
        if (mimeType === PRES_MIME) {
          const presResp = await slides.presentations.get({ presentationId: resolvedId });
          const outline = extractSlideOutline(presResp.data);
          const lines: string[] = [];
          lines.push(`# ${presResp.data.title ?? name}`);
          lines.push("");
          for (const s of outline) {
            lines.push(`## Slide ${s.index}: ${s.title || "(untitled)"}`);
            if (s.body) {
              lines.push("");
              lines.push(s.body);
            }
            if (s.speakerNotes) {
              lines.push("");
              lines.push(`**Speaker notes:** ${s.speakerNotes}`);
            }
            lines.push("");
          }
          const text = lines.join("\n");
          const { body, truncated, originalLength } = truncateForLlm(text, args.maxChars);
          const result = {
            kind: "slides" as const,
            fileId: resolvedId,
            requestedFileId: args.fileId,
            shortcutFollowed: followed,
            name,
            mimeType,
            slideCount: outline.length,
            slides: outline,
            originalLength,
            truncated,
            body,
          };
          return {
            content: [{ type: "text", text: body }],
            structuredContent: result,
          };
        }

        // Other Workspace types we don't handle — explicit reject so the
        // failure surfaces instead of producing a useless empty binary.
        if (mimeType.startsWith("application/vnd.google-apps.")) {
          return structuredError(
            `Drive file "${name}" has unsupported Workspace mimeType "${mimeType}". drive_read_file supports Docs, Sheets, and Slides for native types.`,
          );
        }

        // Binary fallback: any non-Workspace file (PDF, image, Office doc,
        // arbitrary binary) goes via alt=media into the download jail.
        const savePath = resolveDownloadSavePath(args.savePath ?? getDownloadDir());
        const buf = await drive.files.get(
          { fileId: resolvedId, alt: "media", supportsAllDrives: true },
          { responseType: "arraybuffer" },
        );
        const buffer = Buffer.from(buf.data as ArrayBuffer);
        const filename = path.basename(sanitizeAttachmentFilename(name || `drive-${resolvedId}`));
        const fullPath = path.resolve(savePath, filename);
        const writtenPath = safeWriteFile(fullPath, buffer, { onCollision: "suffix" });
        const result = {
          kind: "binary" as const,
          fileId: resolvedId,
          requestedFileId: args.fileId,
          shortcutFollowed: followed,
          name,
          mimeType,
          path: writtenPath,
          size: buffer.length,
        };
        return {
          content: [
            {
              type: "text",
              text: `Drive file "${name}" (${mimeType}) downloaded.\nPath: ${writtenPath}\nSize: ${buffer.length} bytes`,
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 404) return structuredError(`File not found or trashed: ${message}`);
        if (code === 403 && /exportSizeLimitExceeded/i.test(message)) {
          return structuredError(
            `exportSizeLimitExceeded: Drive's 10 MB export cap was hit. Use drive_download_file for the raw bytes if it's not a Workspace native type.`,
          );
        }
        if (code === 403)
          return structuredError(`Insufficient permissions on this file: ${message}`);
        const prefix =
          code !== undefined ? `drive_read_file failed (HTTP ${code})` : "drive_read_file failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    readMeta.annotations,
    readMeta.scopes,
    authorizedScopes,
  );

  // ---- drive_download_file ----
  const dlMeta = pull("drive_download_file");
  defineTool(
    server,
    "drive_download_file",
    dlMeta.description,
    DriveDownloadFileSchema.shape,
    async (args) => {
      try {
        const meta = await drive.files.get({
          fileId: args.fileId,
          fields: "id,name,mimeType,size",
          supportsAllDrives: true,
        });
        const mimeType = meta.data.mimeType ?? "";
        if (mimeType.startsWith("application/vnd.google-apps.") && mimeType !== SHORTCUT_MIME) {
          return structuredError(
            `Cannot download Workspace file with mimeType "${mimeType}" via alt=media. Use drive_read_file instead — it routes Docs/Sheets/Slides through files.export / Sheets API / Slides API.`,
          );
        }
        const buf = await drive.files.get(
          { fileId: args.fileId, alt: "media", supportsAllDrives: true },
          { responseType: "arraybuffer" },
        );
        const buffer = Buffer.from(buf.data as ArrayBuffer);
        const savePath = resolveDownloadSavePath(args.savePath ?? getDownloadDir());
        const baseName = args.filename ?? meta.data.name ?? `drive-${args.fileId}`;
        const filename = path.basename(sanitizeAttachmentFilename(baseName));
        const fullPath = path.resolve(savePath, filename);
        const writtenPath = safeWriteFile(fullPath, buffer, { onCollision: "suffix" });
        const result = {
          status: "saved" as const,
          fileId: args.fileId,
          name: meta.data.name ?? null,
          mimeType,
          path: writtenPath,
          size: buffer.length,
        };
        return {
          content: [
            {
              type: "text",
              text: `Drive file downloaded.\nPath: ${writtenPath}\nSize: ${buffer.length} bytes`,
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 404) return structuredError(`File not found: ${message}`);
        if (code === 403) return structuredError(`Insufficient permissions: ${message}`);
        const prefix =
          code !== undefined
            ? `drive_download_file failed (HTTP ${code})`
            : "drive_download_file failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    dlMeta.annotations,
    dlMeta.scopes,
    authorizedScopes,
  );

  // ---- drive_list_shared_drives ----
  const sdMeta = pull("drive_list_shared_drives");
  defineTool(
    server,
    "drive_list_shared_drives",
    sdMeta.description,
    DriveListSharedDrivesSchema.shape,
    async (args) => {
      try {
        const res = await drive.drives.list({
          pageSize: args.pageSize,
          pageToken: args.pageToken,
          fields: "drives(id,name,createdTime,capabilities),nextPageToken",
        });
        const result = {
          drives: res.data.drives ?? [],
          nextPageToken: res.data.nextPageToken ?? null,
          count: (res.data.drives ?? []).length,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        const prefix =
          code !== undefined
            ? `drive_list_shared_drives failed (HTTP ${code})`
            : "drive_list_shared_drives failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    sdMeta.annotations,
    sdMeta.scopes,
    authorizedScopes,
  );

  // ---- drive_list_comments ----
  const commentsMeta = pull("drive_list_comments");
  defineTool(
    server,
    "drive_list_comments",
    commentsMeta.description,
    DriveListCommentsSchema.shape,
    async (args) => {
      try {
        // Drive v3 comments.list requires `fields` to be specified
        // (returns 400 otherwise). Inline-expand replies via the
        // `replies(...)` selection to avoid an N+1 replies.list loop.
        const res = await drive.comments.list({
          fileId: args.fileId,
          pageSize: args.pageSize,
          pageToken: args.pageToken,
          includeDeleted: false,
          fields:
            "comments(id,author(displayName,emailAddress),content,createdTime,modifiedTime,resolved,deleted,anchor,quotedFileContent,replies(id,author(displayName,emailAddress),content,createdTime,modifiedTime,deleted)),nextPageToken",
        });
        const all = res.data.comments ?? [];
        const filtered = args.includeResolved ? all : all.filter((c) => !c.resolved);
        const result = {
          fileId: args.fileId,
          comments: filtered,
          nextPageToken: res.data.nextPageToken ?? null,
          count: filtered.length,
          totalCount: all.length,
          excludedResolved: args.includeResolved ? 0 : all.length - filtered.length,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 404) return structuredError(`File not found: ${message}`);
        if (code === 403)
          return structuredError(`Insufficient permissions on this file: ${message}`);
        const prefix =
          code !== undefined
            ? `drive_list_comments failed (HTTP ${code})`
            : "drive_list_comments failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    commentsMeta.annotations,
    commentsMeta.scopes,
    authorizedScopes,
  );

  // ---- drive_trash_file ----
  const trashMeta = pull("drive_trash_file");
  defineTool(
    server,
    "drive_trash_file",
    trashMeta.description,
    DriveTrashFileSchema.shape,
    async (args) => {
      try {
        const res = await drive.files.update({
          fileId: args.fileId,
          requestBody: { trashed: true },
          fields: "id,name,mimeType,trashed",
          supportsAllDrives: true,
        });
        const result = {
          status: "trashed" as const,
          fileId: args.fileId,
          name: res.data.name ?? null,
          mimeType: res.data.mimeType ?? null,
          trashed: res.data.trashed ?? true,
          recovery_window_days: 30,
        };
        return {
          content: [
            {
              type: "text",
              text: `Drive file moved to Trash: ${res.data.name ?? args.fileId}. Recoverable from Drive Trash for ~30 days.`,
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 404) return structuredError(`File not found: ${message}`);
        if (code === 403)
          return structuredError(`Insufficient permissions to trash this file: ${message}`);
        const prefix =
          code !== undefined
            ? `drive_trash_file failed (HTTP ${code})`
            : "drive_trash_file failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    trashMeta.annotations,
    trashMeta.scopes,
    authorizedScopes,
  );

  // ---- drive_reply_to_comment ----
  const replyMeta = pull("drive_reply_to_comment");
  defineTool(
    server,
    "drive_reply_to_comment",
    replyMeta.description,
    DriveReplyToCommentSchema.shape,
    async (args) => {
      try {
        const res = await drive.replies.create({
          fileId: args.fileId,
          commentId: args.commentId,
          fields: "id,author(displayName,emailAddress),content,createdTime,modifiedTime,deleted",
          requestBody: { content: args.content },
        });
        const result = {
          status: "posted" as const,
          fileId: args.fileId,
          commentId: args.commentId,
          reply: res.data,
        };
        return {
          content: [
            {
              type: "text",
              text: `Reply posted to comment ${args.commentId} on file ${args.fileId}.\nReply id: ${res.data.id ?? "(unknown)"}\nContent: ${args.content}`,
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 404) return structuredError(`File or comment not found: ${message}`);
        if (code === 403)
          return structuredError(
            `Insufficient permissions to reply on this file: ${message}`,
          );
        const prefix =
          code !== undefined
            ? `drive_reply_to_comment failed (HTTP ${code})`
            : "drive_reply_to_comment failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    replyMeta.annotations,
    replyMeta.scopes,
    authorizedScopes,
  );
}
