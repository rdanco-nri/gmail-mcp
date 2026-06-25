/**
 * Tool registrar barrel. Wires every per-domain registrar
 * (`messages`, `labels`, `filters`, `threads`, `downloads`,
 * `messaging`, `drive`, `slides`) into the supplied `McpServer`.
 * Called by `createServer` in `src/server.ts`.
 *
 * Once invoked, the SDK's `tools/list` auto-emit returns every
 * scope-eligible tool. Drive + Slides registrars consume their own
 * Google API clients (drive_v3, sheets_v4, slides_v1) injected
 * alongside the gmail client.
 */

import type { gmail_v1, drive_v3, sheets_v4, slides_v1, docs_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMessageTools } from "./messages.js";
import { registerLabelTools } from "./labels.js";
import { registerFilterTools } from "./filters.js";
import { registerThreadTools } from "./threads.js";
import { registerDownloadTools } from "./downloads.js";
import { registerMessagingTools } from "./messaging.js";
import { registerDriveTools } from "./drive.js";
import { registerSlidesTools } from "./slides.js";
import { registerDocsTools } from "./docs.js";

export interface RegisterAllToolsOpts {
  gmail: gmail_v1.Gmail;
  drive: drive_v3.Drive;
  sheets: sheets_v4.Sheets;
  slides: slides_v1.Slides;
  docs: docs_v1.Docs;
  authorizedScopes: readonly string[];
}

export function registerAllTools(server: McpServer, opts: RegisterAllToolsOpts): void {
  registerMessageTools(server, opts.gmail, opts.authorizedScopes);
  registerLabelTools(server, opts.gmail, opts.authorizedScopes);
  registerFilterTools(server, opts.gmail, opts.authorizedScopes);
  registerThreadTools(server, opts.gmail, opts.authorizedScopes);
  registerDownloadTools(server, opts.gmail, opts.authorizedScopes);
  registerMessagingTools(server, opts.gmail, opts.authorizedScopes);
  registerDriveTools(server, opts.drive, opts.sheets, opts.slides, opts.authorizedScopes);
  registerSlidesTools(server, opts.drive, opts.slides, opts.authorizedScopes);
  registerDocsTools(server, opts.docs, opts.drive, opts.authorizedScopes);
}
