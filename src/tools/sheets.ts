/**
 * Sheets tool registrar (v0.33).
 *
 * One tool — `sheets_write_tab` — backed by sheets_v4. Full-tab
 * overwrite only (clear + values.update at A1): no partial-range
 * patching, no tab creation. Pairs with `drive_read_file`'s existing
 * Sheets-read path (per-tab CSV export) for a read/edit/write loop on
 * an external copy of a tab's data.
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
        const tabExists = (sheetMeta.data.sheets ?? []).some(
          (s) => s.properties?.title === args.tabTitle,
        );
        if (!tabExists) {
          const available = (sheetMeta.data.sheets ?? [])
            .map((s) => s.properties?.title)
            .filter((t): t is string => typeof t === "string");
          return structuredError(
            `Tab "${args.tabTitle}" not found in spreadsheet ${args.fileId}. Available tabs: ${available.join(", ") || "(none)"}. sheets_write_tab does not create new tabs.`,
          );
        }

        const existing = await sheets.spreadsheets.values.get({
          spreadsheetId: args.fileId,
          range: args.tabTitle,
        });
        const previousRows = (existing.data.values ?? []) as unknown[][];

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

        const result = {
          status: "written" as const,
          fileId: args.fileId,
          tabTitle: args.tabTitle,
          previousRowCount: previousRows.length,
          updatedRange: updateRes.data.updatedRange ?? null,
          updatedRows: updateRes.data.updatedRows ?? args.rows.length,
          updatedColumns: updateRes.data.updatedColumns ?? null,
        };
        return {
          content: [
            {
              type: "text",
              text: `Tab "${args.tabTitle}" overwritten: cleared ${previousRows.length} existing row(s), wrote ${result.updatedRows} new row(s) (range ${result.updatedRange ?? "unknown"}).`,
            },
          ],
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
