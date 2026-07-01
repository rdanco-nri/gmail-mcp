/**
 * Docs tool registrars (v0.32).
 *
 * Three tools backed by docs_v1 (and drive_v3 for file placement):
 *   - docs_create_release_doc  (documents.create + batchUpdate: rename
 *                               default tab, addDocumentTab, set pageless)
 *   - docs_write_tab           (batchUpdate into a specific tabId — a
 *                               native table and/or markdown narrative)
 *   - docs_read_tab            (documents.get?includeTabsContent → markdown)
 *
 * Implementation notes (honest complexity):
 *
 * 1. Tabs are the Docs sidebar tabs, addressed by the Docs API's
 *    `tabId`. Every write Location/Range carries `tabId` so content
 *    lands in the intended tab. Reads pass `includeTabsContent: true`
 *    so `document.tabs[].documentTab.body` is populated per tab (the
 *    legacy `document.body` only ever holds the first tab).
 *
 * 2. Native tables are filled in two passes, mirroring the Slides
 *    placeholder dance: insert the empty R×C table, GET the doc back to
 *    discover each cell's paragraph start index, then insert each cell's
 *    text in DESCENDING index order so earlier (smaller) indices stay
 *    valid as later inserts grow the document.
 *
 * 3. Pageless is best-effort: it runs in its own try/catch after the
 *    essential tab structure is in place, so a pageless failure never
 *    aborts doc creation — the doc is still usable, just paged.
 */

import type { docs_v1, drive_v3 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import {
  DocsCreateReleaseDocSchema,
  DocsWriteTabSchema,
  DocsReadTabSchema,
} from "../tools.js";
import { asGmailApiError } from "../gmail-errors.js";

const DEFAULT_TAB_TITLES = ["Checklist", "Draft"];

// Monospace font + light background used for inline `code` and fenced
// code blocks (Docs has no native code style; this is the convention).
const CODE_FONT = "Courier New";
const CODE_BG: docs_v1.Schema$OptionalColor = {
  color: { rgbColor: { red: 0.94, green: 0.94, blue: 0.94 } },
};

function structuredError(message: string): {
  content: { type: string; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function docWebViewLink(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

// Flatten root tabs + any nested child tabs into a single ordered list.
function flattenTabs(tabs: docs_v1.Schema$Tab[] | undefined): docs_v1.Schema$Tab[] {
  const out: docs_v1.Schema$Tab[] = [];
  for (const t of tabs ?? []) {
    out.push(t);
    if (t.childTabs?.length) out.push(...flattenTabs(t.childTabs));
  }
  return out;
}

async function getDocWithTabs(
  docs: docs_v1.Docs,
  documentId: string,
): Promise<docs_v1.Schema$Document> {
  const resp = await docs.documents.get({ documentId, includeTabsContent: true });
  return resp.data;
}

// Resolve a tab by exact title, then case-insensitive, then prefix
// (so a forked "Checklist v2" still resolves for `tabTitle: "Checklist"`).
// The LAST match wins — the latest forked tab is the reviewed one.
function resolveTabByTitle(
  doc: docs_v1.Schema$Document,
  title: string,
): docs_v1.Schema$Tab | undefined {
  const tabs = flattenTabs(doc.tabs);
  const titleOf = (t: docs_v1.Schema$Tab) => t.tabProperties?.title ?? "";
  const exact = tabs.filter((t) => titleOf(t) === title);
  if (exact.length) return exact[exact.length - 1];
  const lower = title.toLowerCase();
  const ci = tabs.filter((t) => titleOf(t).toLowerCase() === lower);
  if (ci.length) return ci[ci.length - 1];
  const prefix = tabs.filter((t) => titleOf(t).toLowerCase().startsWith(lower));
  if (prefix.length) return prefix[prefix.length - 1];
  return undefined;
}

function getTabById(
  doc: docs_v1.Schema$Document,
  tabId: string,
): docs_v1.Schema$Tab | undefined {
  return flattenTabs(doc.tabs).find((t) => t.tabProperties?.tabId === tabId);
}

// The endIndex of the last structural element in a tab's body — i.e.
// the body length. The final character is always the trailing newline.
function tabBodyEndIndex(tab: docs_v1.Schema$Tab): number {
  const content = tab.documentTab?.body?.content ?? [];
  let end = 1;
  for (const el of content) {
    if (typeof el.endIndex === "number") end = el.endIndex;
  }
  return end;
}

// Plain text of a paragraph's text runs, trailing newline stripped.
function paragraphText(p: docs_v1.Schema$Paragraph): string {
  return (p.elements ?? [])
    .map((e) => e.textRun?.content ?? "")
    .join("")
    .replace(/\n$/, "");
}

// Like paragraphText, but reflects inline styling back into markdown so a
// round-trip read shows the same `**bold**` / `` `code` `` markers that
// were written — bold runs wrap in `**`, monospace runs wrap in backticks.
function paragraphMarkdown(p: docs_v1.Schema$Paragraph): string {
  let out = "";
  for (const e of p.elements ?? []) {
    const stripped = (e.textRun?.content ?? "").replace(/\n$/, "");
    if (!stripped) continue;
    const style = e.textRun?.textStyle;
    if (style?.bold) {
      out += `**${stripped}**`;
    } else if (style?.weightedFontFamily?.fontFamily === CODE_FONT) {
      out += `\`${stripped}\``;
    } else {
      out += stripped;
    }
  }
  return out;
}

const HEADING_PREFIX: Record<string, string> = {
  TITLE: "# ",
  HEADING_1: "# ",
  HEADING_2: "## ",
  HEADING_3: "### ",
  HEADING_4: "#### ",
};

// Serialize one tab's body to markdown: headings via named style,
// bullets via `- `, and native tables as markdown tables (first row
// rendered as the header, with a separator row). Enough fidelity for a
// downstream parser to recover a checklist table or read the narrative.
function serializeTabBody(tab: docs_v1.Schema$Tab): string {
  const content = tab.documentTab?.body?.content ?? [];
  const lines: string[] = [];
  for (const el of content) {
    if (el.paragraph) {
      const text = paragraphMarkdown(el.paragraph);
      const named = el.paragraph.paragraphStyle?.namedStyleType ?? "";
      if (el.paragraph.bullet) {
        lines.push(`- ${text}`);
      } else if (HEADING_PREFIX[named]) {
        lines.push(`${HEADING_PREFIX[named]}${text}`);
      } else {
        lines.push(text);
      }
    } else if (el.table) {
      const rows = el.table.tableRows ?? [];
      rows.forEach((row, rowIdx) => {
        const cells = (row.tableCells ?? []).map((cell) => {
          const cellText = (cell.content ?? [])
            .map((c) => (c.paragraph ? paragraphText(c.paragraph) : ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .replace(/\|/g, "\\|")
            .trim();
          return cellText;
        });
        lines.push(`| ${cells.join(" | ")} |`);
        if (rowIdx === 0) {
          lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
        }
      });
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

type InlineSpanType = "bold" | "code";
interface InlineSpan {
  start: number; // offset within the paragraph content (stripped text)
  end: number; // exclusive
  type: InlineSpanType;
}

interface ParsedParagraph {
  start: number; // offset within the inserted text block
  len: number; // content length (excluding the trailing newline)
  style?: string; // named style type for a heading
  bullet?: boolean;
  code?: boolean; // a fenced-code line — whole paragraph rendered monospace
  spans?: InlineSpan[]; // inline bold / code ranges within the content
}

// Strip inline `**bold**` and `` `code` `` markers from one line of
// content, returning the clean text plus the character ranges (relative
// to that clean text) that need character-level styling. A marker that
// never closes is left as literal text.
function parseInline(content: string): { text: string; spans: InlineSpan[] } {
  const spans: InlineSpan[] = [];
  let out = "";
  let i = 0;
  while (i < content.length) {
    if (content.startsWith("**", i)) {
      const close = content.indexOf("**", i + 2);
      if (close !== -1) {
        const inner = content.slice(i + 2, close);
        const start = out.length;
        out += inner;
        spans.push({ start, end: out.length, type: "bold" });
        i = close + 2;
        continue;
      }
    }
    if (content[i] === "`") {
      const close = content.indexOf("`", i + 1);
      if (close !== -1) {
        const inner = content.slice(i + 1, close);
        const start = out.length;
        out += inner;
        spans.push({ start, end: out.length, type: "code" });
        i = close + 1;
        continue;
      }
    }
    out += content[i];
    i += 1;
  }
  return { text: out, spans };
}

// Turn the markdown-ish narrative into one text blob plus per-paragraph
// descriptors (offsets relative to the blob start). '# '/'## '/'### ' →
// heading, '- '/'* ' → bullet, a ``` fence toggles a monospace code
// block, and inline '**bold**' / '`code`' become styled spans.
function parseMarkdownBlock(markdown: string): { text: string; paras: ParsedParagraph[] } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let text = "";
  const paras: ParsedParagraph[] = [];
  let inCode = false;
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      inCode = !inCode;
      continue; // the fence line itself is not emitted
    }
    if (inCode) {
      const start = text.length;
      text += `${raw}\n`;
      paras.push({ start, len: raw.length, code: true });
      continue;
    }
    let content = raw;
    let style: string | undefined;
    let bullet = false;
    if (raw.startsWith("### ")) {
      content = raw.slice(4);
      style = "HEADING_3";
    } else if (raw.startsWith("## ")) {
      content = raw.slice(3);
      style = "HEADING_2";
    } else if (raw.startsWith("# ")) {
      content = raw.slice(2);
      style = "HEADING_1";
    } else if (raw.startsWith("- ") || raw.startsWith("* ")) {
      content = raw.slice(2);
      bullet = true;
    }
    const { text: stripped, spans } = parseInline(content);
    const start = text.length;
    text += `${stripped}\n`;
    paras.push({
      start,
      len: stripped.length,
      style,
      bullet,
      spans: spans.length ? spans : undefined,
    });
  }
  return { text, paras };
}

export function registerDocsTools(
  server: McpServer,
  docs: docs_v1.Docs,
  drive: drive_v3.Drive,
  authorizedScopes: readonly string[],
): void {
  // ---- docs_create_release_doc ----
  const createMeta = pull("docs_create_release_doc");
  defineTool(
    server,
    "docs_create_release_doc",
    createMeta.description,
    DocsCreateReleaseDocSchema.shape,
    async (args) => {
      try {
        const tabTitles =
          args.tabTitles && args.tabTitles.length > 0 ? args.tabTitles : DEFAULT_TAB_TITLES;
        const pageless = args.pageless ?? true;

        // Step 1 — create the doc (one default tab).
        const created = await docs.documents.create({ requestBody: { title: args.title } });
        const documentId = created.data.documentId;
        if (!documentId) {
          return structuredError(
            "Docs create returned no documentId — document creation failed silently.",
          );
        }

        // Step 2 — read the default tab's id.
        const afterCreate = await getDocWithTabs(docs, documentId);
        const defaultTabId = flattenTabs(afterCreate.tabs)[0]?.tabProperties?.tabId;
        if (!defaultTabId) {
          return structuredError(
            "Created document exposed no default tab id (includeTabsContent returned no tabs).",
          );
        }

        // Step 3 — rename the default tab to the first requested title,
        // then add the remaining tabs in order.
        const structureRequests: docs_v1.Schema$Request[] = [
          {
            updateDocumentTabProperties: {
              tabProperties: { tabId: defaultTabId, title: tabTitles[0] },
              fields: "title",
            },
          },
        ];
        for (const title of tabTitles.slice(1)) {
          structureRequests.push({ addDocumentTab: { tabProperties: { title } } });
        }
        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: structureRequests },
        });

        // Step 4 — collect every tab id, in order, for the result + pageless.
        const afterTabs = await getDocWithTabs(docs, documentId);
        const resolvedTabs = flattenTabs(afterTabs.tabs).map((t) => ({
          title: t.tabProperties?.title ?? "",
          tabId: t.tabProperties?.tabId ?? "",
        }));

        // Step 5 — pageless (best-effort, per tab; never fatal).
        let pagelessApplied = false;
        if (pageless) {
          try {
            const pagelessRequests: docs_v1.Schema$Request[] = resolvedTabs
              .filter((t) => t.tabId)
              .map((t) => ({
                updateDocumentStyle: {
                  documentStyle: { documentFormat: { documentMode: "PAGELESS" } },
                  fields: "documentFormat",
                  tabId: t.tabId,
                },
              }));
            if (pagelessRequests.length) {
              await docs.documents.batchUpdate({
                documentId,
                requestBody: { requests: pagelessRequests },
              });
              pagelessApplied = true;
            }
          } catch {
            pagelessApplied = false;
          }
        }

        // Step 6 — move into the requested folder / shared drive.
        if (args.parentFolderId) {
          const fileMeta = await drive.files.get({
            fileId: documentId,
            fields: "parents",
            supportsAllDrives: true,
          });
          const currentParents = (fileMeta.data.parents ?? []).join(",");
          await drive.files.update({
            fileId: documentId,
            addParents: args.parentFolderId,
            removeParents: currentParents || undefined,
            fields: "id,parents",
            supportsAllDrives: true,
          });
        }

        const webViewLink = docWebViewLink(documentId);
        const result = {
          status: "created" as const,
          documentId,
          title: args.title,
          tabs: resolvedTabs,
          pageless: pagelessApplied,
          parentFolderId: args.parentFolderId ?? null,
          webViewLink,
        };
        return {
          content: [
            {
              type: "text",
              text: `Doc "${args.title}" created with ${resolvedTabs.length} tab(s): ${resolvedTabs
                .map((t) => t.title)
                .join(", ")}${pagelessApplied ? " (pageless)" : ""}.\nID: ${documentId}\nLink: ${webViewLink}`,
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 403)
          return structuredError(
            `Insufficient permissions to create a Doc: ${message}. The Docs API needs the 'documents' scope; folder placement also needs 'drive'. If the scope was only just added, re-run the OAuth consent so the token actually carries it.`,
          );
        const prefix =
          code !== undefined
            ? `docs_create_release_doc failed (HTTP ${code})`
            : "docs_create_release_doc failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    createMeta.annotations,
    createMeta.scopes,
    authorizedScopes,
  );

  // ---- docs_write_tab ----
  const writeMeta = pull("docs_write_tab");
  defineTool(
    server,
    "docs_write_tab",
    writeMeta.description,
    DocsWriteTabSchema.shape,
    async (args) => {
      try {
        if (!args.table && !args.markdown) {
          return structuredError(
            "docs_write_tab requires at least one of `table` or `markdown`.",
          );
        }
        const mode = args.mode ?? "replace";

        // Resolve the target tab to a concrete id.
        const doc = await getDocWithTabs(docs, args.documentId);
        let tabId = args.tabId;
        if (!tabId && args.tabTitle) {
          const tab = resolveTabByTitle(doc, args.tabTitle);
          if (!tab?.tabProperties?.tabId) {
            return structuredError(
              `No tab titled "${args.tabTitle}" found in document ${args.documentId}.`,
            );
          }
          tabId = tab.tabProperties.tabId;
        }
        if (!tabId) {
          tabId = flattenTabs(doc.tabs)[0]?.tabProperties?.tabId ?? undefined;
          if (!tabId) {
            return structuredError(
              `Document ${args.documentId} exposed no tabs to write to.`,
            );
          }
        }

        // replace: clear the tab body before writing.
        if (mode === "replace") {
          const tab = getTabById(doc, tabId);
          if (tab) {
            const end = tabBodyEndIndex(tab);
            if (end - 1 > 1) {
              await docs.documents.batchUpdate({
                documentId: args.documentId,
                requestBody: {
                  requests: [
                    { deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId } } },
                  ],
                },
              });
            }
          }
        }

        let tableRows = 0;
        let markdownParas = 0;

        // ---- table (Checklist) ----
        if (args.table && args.table.length > 0) {
          const rows = args.table.length;
          const columns = Math.max(...args.table.map((r) => r.cells.length));
          // Pass 1 — insert the empty table at the end of the tab body.
          await docs.documents.batchUpdate({
            documentId: args.documentId,
            requestBody: {
              requests: [{ insertTable: { rows, columns, endOfSegmentLocation: { tabId } } }],
            },
          });
          // Pass 2 — re-read, find the table we just inserted (the last
          // table in this tab), collect each cell's paragraph start index.
          const reread = await getDocWithTabs(docs, args.documentId);
          const tab = getTabById(reread, tabId);
          const tables = (tab?.documentTab?.body?.content ?? []).filter((el) => el.table);
          const inserted = tables[tables.length - 1]?.table;
          if (!inserted) {
            return structuredError(
              "Inserted table could not be located on re-read; aborting cell fill.",
            );
          }
          const cellInserts: { index: number; text: string }[] = [];
          const trows = inserted.tableRows ?? [];
          for (let r = 0; r < trows.length; r++) {
            const tcells = trows[r]?.tableCells ?? [];
            const rowCells = args.table[r]?.cells ?? [];
            for (let c = 0; c < tcells.length; c++) {
              const text = rowCells[c];
              if (!text) continue;
              const startIndex = tcells[c]?.content?.[0]?.startIndex;
              if (typeof startIndex === "number") {
                cellInserts.push({ index: startIndex, text });
              }
            }
          }
          // Insert in DESCENDING index order so earlier indices stay valid.
          cellInserts.sort((a, b) => b.index - a.index);
          if (cellInserts.length) {
            await docs.documents.batchUpdate({
              documentId: args.documentId,
              requestBody: {
                requests: cellInserts.map((ci) => ({
                  insertText: { text: ci.text, location: { index: ci.index, tabId } },
                })),
              },
            });
          }
          tableRows = rows;
        }

        // ---- markdown (Draft) ----
        if (args.markdown && args.markdown.trim().length > 0) {
          // Recompute the insertion anchor (the table insert above moved it).
          const reread = await getDocWithTabs(docs, args.documentId);
          const tab = getTabById(reread, tabId);
          const insertAt = tab ? Math.max(1, tabBodyEndIndex(tab) - 1) : 1;
          const { text, paras } = parseMarkdownBlock(args.markdown);
          const requests: docs_v1.Schema$Request[] = [
            { insertText: { text, location: { index: insertAt, tabId } } },
          ];
          for (const p of paras) {
            const startIndex = insertAt + p.start;
            const endIndex = startIndex + p.len + 1; // include the trailing newline
            const contentEnd = startIndex + p.len; // excludes the trailing newline
            if (p.style) {
              requests.push({
                updateParagraphStyle: {
                  range: { startIndex, endIndex, tabId },
                  paragraphStyle: { namedStyleType: p.style },
                  fields: "namedStyleType",
                },
              });
            } else if (p.bullet) {
              requests.push({
                createParagraphBullets: {
                  range: { startIndex, endIndex, tabId },
                  bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
                },
              });
            }
            // Fenced code line: monospace the run and shade the paragraph.
            if (p.code && p.len > 0) {
              requests.push({
                updateTextStyle: {
                  range: { startIndex, endIndex: contentEnd, tabId },
                  textStyle: { weightedFontFamily: { fontFamily: CODE_FONT } },
                  fields: "weightedFontFamily",
                },
              });
              requests.push({
                updateParagraphStyle: {
                  range: { startIndex, endIndex, tabId },
                  paragraphStyle: { shading: { backgroundColor: CODE_BG } },
                  fields: "shading.backgroundColor",
                },
              });
            }
            // Inline bold / code spans within the paragraph content.
            for (const span of p.spans ?? []) {
              const s = startIndex + span.start;
              const e = startIndex + span.end;
              if (e <= s) continue;
              if (span.type === "bold") {
                requests.push({
                  updateTextStyle: {
                    range: { startIndex: s, endIndex: e, tabId },
                    textStyle: { bold: true },
                    fields: "bold",
                  },
                });
              } else {
                requests.push({
                  updateTextStyle: {
                    range: { startIndex: s, endIndex: e, tabId },
                    textStyle: {
                      weightedFontFamily: { fontFamily: CODE_FONT },
                      backgroundColor: CODE_BG,
                    },
                    fields: "weightedFontFamily,backgroundColor",
                  },
                });
              }
            }
          }
          await docs.documents.batchUpdate({
            documentId: args.documentId,
            requestBody: { requests },
          });
          markdownParas = paras.length;
        }

        const webViewLink = docWebViewLink(args.documentId);
        const result = {
          status: "written" as const,
          documentId: args.documentId,
          tabId,
          mode,
          tableRows,
          markdownParagraphs: markdownParas,
          webViewLink,
        };
        return {
          content: [
            {
              type: "text",
              text: `Wrote to tab ${tabId} in ${args.documentId} (mode: ${mode}; ${tableRows} table row(s), ${markdownParas} narrative paragraph(s)).\nLink: ${webViewLink}`,
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 404) return structuredError(`Document not found: ${message}`);
        if (code === 403)
          return structuredError(`Insufficient permissions on this document: ${message}`);
        const prefix =
          code !== undefined ? `docs_write_tab failed (HTTP ${code})` : "docs_write_tab failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    writeMeta.annotations,
    writeMeta.scopes,
    authorizedScopes,
  );

  // ---- docs_read_tab ----
  const readMeta = pull("docs_read_tab");
  defineTool(
    server,
    "docs_read_tab",
    readMeta.description,
    DocsReadTabSchema.shape,
    async (args) => {
      try {
        const doc = await getDocWithTabs(docs, args.documentId);
        const allTabs = flattenTabs(doc.tabs);
        if (allTabs.length === 0) {
          return structuredError(
            `Document ${args.documentId} has no tab content (is it a Google Doc?).`,
          );
        }

        let selected: docs_v1.Schema$Tab[];
        if (args.tabTitle) {
          const tab = resolveTabByTitle(doc, args.tabTitle);
          if (!tab) {
            const titles = allTabs.map((t) => t.tabProperties?.title ?? "").join(", ");
            return structuredError(
              `No tab titled "${args.tabTitle}" found. Available tabs: ${titles}.`,
            );
          }
          selected = [tab];
        } else {
          selected = allTabs;
        }

        const sections = selected.map((t) => {
          const title = t.tabProperties?.title ?? "(untitled tab)";
          const body = serializeTabBody(t);
          return { title, tabId: t.tabProperties?.tabId ?? "", markdown: body };
        });

        const combined =
          sections.length === 1
            ? (sections[0]?.markdown ?? "")
            : sections.map((s) => `# ${s.title}\n\n${s.markdown}`).join("\n\n");

        const result = {
          status: "read" as const,
          documentId: args.documentId,
          tabCount: sections.length,
          tabs: sections,
        };
        return {
          content: [{ type: "text", text: combined }],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 404) return structuredError(`Document not found: ${message}`);
        if (code === 403)
          return structuredError(
            `Insufficient permissions to read this document: ${message}. Per-tab reads need the 'documents' scope.`,
          );
        const prefix =
          code !== undefined ? `docs_read_tab failed (HTTP ${code})` : "docs_read_tab failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    readMeta.annotations,
    readMeta.scopes,
    authorizedScopes,
  );
}
