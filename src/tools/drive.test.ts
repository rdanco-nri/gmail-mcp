/**
 * Tests for `drive_upload_file`, the first Drive tool with registrar
 * coverage (the rest of the Drive/Slides/Docs/Sheets family still ships
 * without one; see docs/ROADMAP.md).
 *
 * End-to-end over the real MCP round-trip (Client → SDK → defineTool →
 * handler → mock Drive client), mirroring `calendar.test.ts`. The Drive
 * client is a plain object recording every `files.create` /
 * `files.update` call, so each case asserts both the local gate (jail,
 * size cap, extension map) and the exact request shape the handler
 * sends.
 *
 * Both jails are pinned to per-test tempdirs so the host's real
 * ~/GmailAttachments and ~/GmailDownloads are never read.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { resetJailDirCache, assertReadablePathInJail } from "../utl.js";
import { UPLOAD_MAX_BYTES } from "./drive.js";

const PRES_MIME = "application/vnd.google-apps.presentation";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

interface MockData {
  created?: Record<string, unknown>;
  updated?: Record<string, unknown>;
  throws?: Error;
}

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

function mockDrive(data: MockData) {
  const calls: RecordedCall[] = [];
  const client = {
    files: {
      create: async (params: Record<string, unknown>) => {
        calls.push({ method: "files.create", params });
        if (data.throws) throw data.throws;
        return {
          data: data.created ?? {
            id: "new1",
            name: "deck",
            mimeType: PRES_MIME,
            webViewLink: "https://docs.google.com/presentation/d/new1/edit",
            parents: ["root"],
          },
        };
      },
      update: async (params: Record<string, unknown>) => {
        calls.push({ method: "files.update", params });
        if (data.throws) throw data.throws;
        return {
          data: data.updated ?? {
            id: "old1",
            name: "deck",
            mimeType: PRES_MIME,
            webViewLink: "https://docs.google.com/presentation/d/old1/edit",
          },
        };
      },
    },
  };
  return { calls, client };
}

function apiError(code: number, message: string): Error {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

async function connect(scopes: string[], data: MockData = {}) {
  const { calls, client: drive } = mockDrive(data);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const server = createServer({ drive, authorizedScopes: scopes } as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "drive-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    calls,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
};

async function callUpload(
  fix: Awaited<ReturnType<typeof connect>>,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await fix.client.callTool({ name: "drive_upload_file", arguments: args })) as ToolResult;
}

function textOf(r: ToolResult): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}

let attachmentDir: string;
let downloadDir: string;
let outsideDir: string;
const originalEnv = { ...process.env };

function writeFile(dir: string, name: string, bytes = 1024): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

beforeEach(() => {
  attachmentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-upload-attach-"));
  downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-upload-download-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-upload-outside-"));
  process.env.GMAIL_MCP_ATTACHMENT_DIR = attachmentDir;
  process.env.GMAIL_MCP_DOWNLOAD_DIR = downloadDir;
  process.env.GMAIL_MCP_RATE_LIMIT_DISABLE = "1";
  delete process.env.GMAIL_MCP_DRY_RUN;
  resetJailDirCache();
});

afterEach(() => {
  for (const d of [attachmentDir, downloadDir, outsideDir]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  process.env = { ...originalEnv };
  resetJailDirCache();
});

describe("assertReadablePathInJail", () => {
  it("accepts a file in the attachment jail and returns its realpath", () => {
    const p = writeFile(attachmentDir, "a.pptx");
    expect(assertReadablePathInJail(p, { jails: ["attachment", "download"] })).toBe(
      fs.realpathSync(p),
    );
  });

  it("accepts a file in the download jail only when that jail is listed", () => {
    const p = writeFile(downloadDir, "b.pptx");
    expect(assertReadablePathInJail(p, { jails: ["attachment", "download"] })).toBe(
      fs.realpathSync(p),
    );
    expect(() => assertReadablePathInJail(p, { jails: ["attachment"] })).toThrow(
      /outside the allowed directory/,
    );
  });

  it("refuses a symlink inside the jail that points outside it", () => {
    const target = writeFile(outsideDir, "secret.pptx");
    const link = path.join(attachmentDir, "link.pptx");
    fs.symlinkSync(target, link);
    expect(() => assertReadablePathInJail(link, { jails: ["attachment", "download"] })).toThrow(
      /outside every allowed directory/,
    );
  });

  it("refuses a relative path and a missing file", () => {
    expect(() => assertReadablePathInJail("deck.pptx", { jails: ["attachment"] })).toThrow(
      /must be absolute/,
    );
    expect(() =>
      assertReadablePathInJail(path.join(attachmentDir, "nope.pptx"), { jails: ["attachment"] }),
    ).toThrow(/does not exist/);
  });
});

describe("drive_upload_file", () => {
  it("is advertised on a drive token and hidden on drive.readonly", async () => {
    const full = await connect(["drive"]);
    expect((await full.client.listTools()).tools.map((t) => t.name)).toContain("drive_upload_file");
    await full.close();
    const ro = await connect(["drive.readonly"]);
    expect((await ro.client.listTools()).tools.map((t) => t.name)).not.toContain(
      "drive_upload_file",
    );
    await ro.close();
  });

  it("converts a pptx in the attachment jail to Google Slides with the extension dropped", async () => {
    const fix = await connect(["drive"]);
    const p = writeFile(attachmentDir, "havas-demo.pptx");
    const r = await callUpload(fix, { path: p, parentFolderId: "folder9" });
    expect(r.isError).toBeFalsy();
    expect(fix.calls).toHaveLength(1);
    const call = fix.calls[0]!;
    expect(call.method).toBe("files.create");
    const requestBody = call.params.requestBody as Record<string, unknown>;
    expect(requestBody.name).toBe("havas-demo");
    expect(requestBody.mimeType).toBe(PRES_MIME);
    expect(requestBody.parents).toEqual(["folder9"]);
    const media = call.params.media as { mimeType: string; body: unknown };
    expect(media.mimeType).toBe(PPTX_MIME);
    expect(media.body).toBeInstanceOf(Readable);
    expect(call.params.supportsAllDrives).toBe(true);
    expect(r.structuredContent).toMatchObject({
      status: "uploaded",
      fileId: "new1",
      mimeType: PRES_MIME,
      converted: true,
      size: 1024,
    });
    // The result text carries Drive's returned name, not the local one.
    expect(textOf(r)).toContain("Uploaded deck (converted to");
    expect(textOf(r)).toContain("https://docs.google.com/presentation/d/new1/edit");
    await fix.close();
  });

  it("keeps the source mime and full name with convert=false", async () => {
    const fix = await connect(["drive"], {
      created: { id: "raw1", name: "havas-demo.pptx", mimeType: PPTX_MIME },
    });
    const p = writeFile(attachmentDir, "havas-demo.pptx");
    const r = await callUpload(fix, { path: p, convert: false });
    expect(r.isError).toBeFalsy();
    const requestBody = fix.calls[0]!.params.requestBody as Record<string, unknown>;
    expect(requestBody.name).toBe("havas-demo.pptx");
    expect(requestBody.mimeType).toBeUndefined();
    expect(requestBody.parents).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ converted: false, fileId: "raw1" });
    await fix.close();
  });

  it("honours an explicit name", async () => {
    const fix = await connect(["drive"]);
    const p = writeFile(attachmentDir, "x.docx");
    await callUpload(fix, { path: p, name: "Pilot brief" });
    const requestBody = fix.calls[0]!.params.requestBody as Record<string, unknown>;
    expect(requestBody.name).toBe("Pilot brief");
    expect(requestBody.mimeType).toBe("application/vnd.google-apps.document");
    await fix.close();
  });

  it("accepts a file from the download jail", async () => {
    const fix = await connect(["drive"]);
    const p = writeFile(downloadDir, "pulled.xlsx");
    const r = await callUpload(fix, { path: p });
    expect(r.isError).toBeFalsy();
    const requestBody = fix.calls[0]!.params.requestBody as Record<string, unknown>;
    expect(requestBody.mimeType).toBe("application/vnd.google-apps.spreadsheet");
    await fix.close();
  });

  it("refuses a path outside both jails before any API call", async () => {
    const fix = await connect(["drive"]);
    const p = writeFile(outsideDir, "leak.pptx");
    const r = await callUpload(fix, { path: p });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/outside every allowed directory/);
    expect(fix.calls).toHaveLength(0);
    await fix.close();
  });

  it("refuses an extension with no conversion target when convert is on", async () => {
    const fix = await connect(["drive"]);
    const p = writeFile(attachmentDir, "scan.pdf");
    const r = await callUpload(fix, { path: p });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no Google-native target for "\.pdf"/);
    expect(fix.calls).toHaveLength(0);
    await fix.close();
  });

  it("uploads a pdf raw with convert=false", async () => {
    const fix = await connect(["drive"], {
      created: { id: "pdf1", name: "scan.pdf", mimeType: "application/pdf" },
    });
    const p = writeFile(attachmentDir, "scan.pdf");
    const r = await callUpload(fix, { path: p, convert: false });
    expect(r.isError).toBeFalsy();
    const media = fix.calls[0]!.params.media as { mimeType: string };
    expect(media.mimeType).toBe("application/pdf");
    await fix.close();
  });

  it("refuses a file over the 5 MB multipart cap before any API call", async () => {
    const fix = await connect(["drive"]);
    const p = writeFile(attachmentDir, "big.pptx", UPLOAD_MAX_BYTES + 1);
    const r = await callUpload(fix, { path: p });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/over the .* multipart upload cap/);
    expect(fix.calls).toHaveLength(0);
    await fix.close();
  });

  it("replaces an existing file with files.update, keeping its id", async () => {
    const fix = await connect(["drive"]);
    const p = writeFile(attachmentDir, "havas-demo.pptx");
    const r = await callUpload(fix, { path: p, replaceFileId: "old1" });
    expect(r.isError).toBeFalsy();
    const call = fix.calls[0]!;
    expect(call.method).toBe("files.update");
    expect(call.params.fileId).toBe("old1");
    expect(call.params.requestBody).toEqual({ mimeType: PRES_MIME });
    expect((call.params.media as { mimeType: string }).mimeType).toBe(PPTX_MIME);
    expect(r.structuredContent).toMatchObject({ status: "replaced", fileId: "old1" });
    expect(textOf(r)).toContain("Replaced");
    await fix.close();
  });

  it("refuses replaceFileId together with parentFolderId", async () => {
    const fix = await connect(["drive"]);
    const p = writeFile(attachmentDir, "havas-demo.pptx");
    const r = await callUpload(fix, { path: p, replaceFileId: "old1", parentFolderId: "f" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/cannot be combined/);
    expect(fix.calls).toHaveLength(0);
    await fix.close();
  });

  it("maps a 403 to the permissions message and a 404 to not-found", async () => {
    const p = writeFile(attachmentDir, "havas-demo.pptx");
    const forbidden = await connect(["drive"], { throws: apiError(403, "no access") });
    const r1 = await callUpload(forbidden, { path: p });
    expect(r1.isError).toBe(true);
    expect(textOf(r1)).toMatch(/Insufficient permissions to upload: no access/);
    await forbidden.close();
    const missing = await connect(["drive"], { throws: apiError(404, "folder gone") });
    const r2 = await callUpload(missing, { path: p, parentFolderId: "nope" });
    expect(textOf(r2)).toMatch(/File or folder not found: folder gone/);
    await missing.close();
    const other = await connect(["drive"], { throws: apiError(500, "boom") });
    const r3 = await callUpload(other, { path: p });
    expect(textOf(r3)).toMatch(/drive_upload_file failed \(HTTP 500\): boom/);
    await other.close();
  });

  it("short-circuits under GMAIL_MCP_DRY_RUN without calling Drive", async () => {
    process.env.GMAIL_MCP_DRY_RUN = "true";
    const fix = await connect(["drive"]);
    const p = writeFile(attachmentDir, "havas-demo.pptx");
    const r = await callUpload(fix, { path: p });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ dryRun: true, tool: "drive_upload_file" });
    expect(fix.calls).toHaveLength(0);
    await fix.close();
  });
});
