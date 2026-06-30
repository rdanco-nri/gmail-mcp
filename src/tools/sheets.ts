/**
 * Sheets tool registrar (v0.33, formatting pass v0.34).
 *
 * One tool — `sheets_write_tab` — backed by sheets_v4. Full-tab
 * overwrite only (clear + values.update at A1): no partial-range
 * patching, no tab creation. Pairs with `drive_read_file`'s existing
 * Sheets-read path (per-tab CSV export) for a read/edit/write loop on
 * an external copy of a tab's data.
 *
 * `values.clear` / `values.update` never touch cell formatting or
 * row/column sizing — that is a separate `batchUpdate` surface. A
 * values-only write can silently desync a tab's look from its data:
 * adding a column leaves the new column unstyled (formatting was
 * pinned to the old column range), and stale row heights (sized for
 * the previous content) don't shrink or grow to fit the new content.
 * Real incident: a 5→6 column write left the new column unstyled and
 * every row stuck at its old (oversized) height — see commit history
 * around v0.34 for the live repro. The post-write `batchUpdate` below
 * fixes both, default-on, no flag — there is no real scenario where
 * stale formatting is wanted on purpose.
 */

import type { sheets_v4 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import { SheetsWriteTabSchema } from "../tools.js";
import { asGmailApiError } from "../gmail-errors.js";

function structuredError(message: string): {
  content: { type: string; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Build the post-write formatting `batchUpdate` requests:
 *   1. Explicit WRAP strategy across the full written range — new
 *      cells (especially a newly-added column) get Sheets' default
 *      formatting, not whatever wrap mode the rest of the tab uses.
 *   2. If the new data has MORE columns than the tab previously had,
 *      copy the last existing header cell's format + the last
 *      existing column's pixel width onto the new column(s), so a
 *      column split/add doesn't leave a visibly unstyled gap.
 *   3. Auto-fit row heights to the new content — fixes stale heights
 *      left over from the previous (longer or shorter) content.
 * Order matters: wrap strategy must be set BEFORE the row auto-resize
 * request, since auto-resize computes height from the current wrap
 * mode.
 */
function buildFormattingRequests(opts: {
  sheetId: number;
  newRowCount: number;
  newColCount: number;
  oldColCount: number;
  headerFormats: (sheets_v4.Schema$CellFormat | undefined)[];
  columnWidths: (number | null | undefined)[];
}): sheets_v4.Schema$Request[] {
  const { sheetId, newRowCount, newColCount, oldColCount, headerFormats, columnWidths } = opts;
  const requests: sheets_v4.Schema$Request[] = [
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: newRowCount,
          startColumnIndex: 0,
          endColumnIndex: newColCount,
        },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
        fields: "userEnteredFormat.wrapStrategy",
      },
    },
  ];

  if (newColCount > oldColCount && oldColCount > 0) {
    const templateFormat = headerFormats[oldColCount - 1];
    if (templateFormat) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: oldColCount,
            endColumnIndex: newColCount,
          },
          cell: { userEnteredFormat: templateFormat },
          fields: "userEnteredFormat",
        },
      });
    }
    const templateWidth = columnWidths[oldColCount - 1];
    if (templateWidth) {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: oldColCount, endIndex: newColCount },
          properties: { pixelSize: templateWidth },
          fields: "pixelSize",
        },
      });
    }
  }

  requests.push({
    autoResizeDimensions: {
      dimensions: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: newRowCount },
    },
  });

  return requests;
}

export function registerSheetsTools(
  server: McpServer,
  sheets: sheets_v4.Sheets,
  authorizedScopes: readonly string[],
): void {
  // ---- sheets_write_tab ----
  const writeMeta = pull("sheets_write_tab");
  defineTool(
    server,
    "sheets_write_tab",
    writeMeta.description,
    SheetsWriteTabSchema.shape,
    async (args) => {
      try {
        const sheetMeta = await sheets.spreadsheets.get({
          spreadsheetId: args.fileId,
          fields: "sheets.properties(title,sheetId)",
        });
        const tab = (sheetMeta.data.sheets ?? []).find(
          (s) => s.properties?.title === args.tabTitle,
        );
        if (!tab || typeof tab.properties?.sheetId !== "number") {
          const available = (sheetMeta.data.sheets ?? [])
            .map((s) => s.properties?.title)
            .filter((t): t is string => typeof t === "string");
          return structuredError(
            `Tab "${args.tabTitle}" not found in spreadsheet ${args.fileId}. Available tabs: ${available.join(", ") || "(none)"}. sheets_write_tab does not create new tabs.`,
          );
        }
        const sheetId = tab.properties.sheetId;

        const existing = await sheets.spreadsheets.values.get({
          spreadsheetId: args.fileId,
          range: args.tabTitle,
        });
        const previousRows = (existing.data.values ?? []) as unknown[][];
        const oldColCount = previousRows[0]?.length ?? 0;

        if (args.dryRun) {
          const result = {
            status: "dry_run" as const,
            fileId: args.fileId,
            tabTitle: args.tabTitle,
            previousRowCount: previousRows.length,
            previousRows,
            newRowCount: args.rows.length,
            newRows: args.rows,
          };
          return {
            content: [
              {
                type: "text",
                text: `[dry run] Would clear ${previousRows.length} existing row(s) in tab "${args.tabTitle}" and write ${args.rows.length} new row(s). No changes made.`,
              },
            ],
            structuredContent: result,
          };
        }

        // Fetch the current header row's per-cell format + column pixel
        // widths BEFORE clearing — values.clear never touches formatting,
        // but we need a template to extend onto any newly-added columns.
        const fmtMeta = await sheets.spreadsheets.get({
          spreadsheetId: args.fileId,
          ranges: [`${args.tabTitle}!1:1`],
          fields: "sheets.data.rowData.values.userEnteredFormat,sheets.data.columnMetadata.pixelSize",
        });
        const fmtData = fmtMeta.data.sheets?.[0]?.data?.[0];
        const headerFormats = (fmtData?.rowData?.[0]?.values ?? []).map(
          (v) => v.userEnteredFormat ?? undefined,
        );
        const columnWidths = (fmtData?.columnMetadata ?? []).map((c) => c.pixelSize);

        await sheets.spreadsheets.values.clear({
          spreadsheetId: args.fileId,
          range: args.tabTitle,
          requestBody: {},
        });

        const updateRes = await sheets.spreadsheets.values.update({
          spreadsheetId: args.fileId,
          range: `${args.tabTitle}!A1`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: args.rows },
        });

        const newColCount = args.rows.reduce((m, r) => Math.max(m, r.length), 0);
        let formatWarning: string | null = null;
        try {
          const requests = buildFormattingRequests({
            sheetId,
            newRowCount: args.rows.length,
            newColCount,
            oldColCount,
            headerFormats,
            columnWidths,
          });
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: args.fileId,
            requestBody: { requests },
          });
        } catch (fmtErr) {
          // Values already wrote successfully — a formatting hiccup is a
          // soft warning, not a call failure. Surface it so the caller
          // knows to check the tab's look, but don't report isError.
          const { message } = asGmailApiError(fmtErr);
          formatWarning = `Values written successfully, but auto-formatting (wrap/header-style/row-height) failed: ${message}`;
        }

        const result = {
          status: "written" as const,
          fileId: args.fileId,
          tabTitle: args.tabTitle,
          previousRowCount: previousRows.length,
          updatedRange: updateRes.data.updatedRange ?? null,
          updatedRows: updateRes.data.updatedRows ?? args.rows.length,
          updatedColumns: updateRes.data.updatedColumns ?? null,
          formatWarning,
        };
        const baseText = `Tab "${args.tabTitle}" overwritten: cleared ${previousRows.length} existing row(s), wrote ${result.updatedRows} new row(s) (range ${result.updatedRange ?? "unknown"}).`;
        return {
          content: [{ type: "text", text: formatWarning ? `${baseText}\n${formatWarning}` : baseText }],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 404) return structuredError(`Spreadsheet not found: ${message}`);
        if (code === 403)
          return structuredError(`Insufficient permissions on this spreadsheet: ${message}`);
        const prefix =
          code !== undefined ? `sheets_write_tab failed (HTTP ${code})` : "sheets_write_tab failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    writeMeta.annotations,
    writeMeta.scopes,
    authorizedScopes,
  );
}
