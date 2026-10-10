/**
 * Registrar tests for `docs_locate_comments` and the `drive_list_comments`
 * fields it depends on, over the real MCP round-trip (Client → SDK →
 * defineTool → handler → mock Drive and Docs clients).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

const DOC_MIME = "application/vnd.google-apps.document";

const HTML =
  `<html><head><style>p{}</style></head><body>` +
  `<p class="title"><span>Checklist</span></p>` +
  `<h2><span>Connectors</span></h2>` +
  `<table><tr><td><p><span>#</span></p></td><td><p><span>Action</span></p></td></tr>` +
  `<tr><td><p><span>26</span></p></td><td><p><span>Drop</span><sup><a href="#cmnt1" id="cmnt_ref1">[a]</a></sup></p></td></tr></table>` +
  `<p class="title"><span>Draft</span></p>` +
  `<p><span>Intro</span><sup><a href="#cmnt2" id="cmnt_ref2">[b]</a></sup></p>` +
  `<div><p><a href="#cmnt_ref1" id="cmnt1">[a]</a><span>why drop?</span></p></div>` +
  `<div><p><a href="#cmnt_ref2" id="cmnt2">[b]</a><span>tighten</span></p></div>` +
  `</body></html>`;

interface MockData {
  mimeType?: string;
  html?: unknown;
  exportError?: Error;
  getError?: Error;
  docsError?: Error;
  pages?: Record<string, unknown>[][];
}

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

function apiError(code: number, message: string): Error {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

// The over-cap shape Drive sends: a plain message, with the reason only
// in the response body.
function sizeError(): Error {
  const err = apiError(403, "This file is too large to be exported.") as Error & {
    response: unknown;
  };
  err.response = {
    status: 403,
    data: { error: { errors: [{ reason: "exportSizeLimitExceeded" }] } },
  };
  err.message = "Forbidden";
  return err;
}

function mocks(data: MockData) {
  const calls: RecordedCall[] = [];
  const pages = data.pages ?? [
    [{ id: "c2", content: "tighten", replies: [] }],
    [
      {
        id: "c1",
        content: "why drop?",
        mentionedEmailAddresses: ["pm@example.com"],
        replies: [{ id: "r1", content: "", action: "resolve" }],
      },
    ],
  ];
  const drive = {
    files: {
      get: async (params: Record<string, unknown>) => {
        calls.push({ method: "files.get", params });
        if (data.getError) throw data.getError;
        return {
          data: {
            id: params.fileId,
            name: "Review doc",
            mimeType: data.mimeType ?? DOC_MIME,
            modifiedTime: "2026-10-09T00:00:00Z",
          },
        };
      },
      export: async (params: Record<string, unknown>, opts: Record<string, unknown>) => {
        calls.push({ method: "files.export", params: { ...params, ...opts } });
        if (data.exportError) throw data.exportError;
        return { data: data.html ?? HTML };
      },
    },
    comments: {
      list: async (params: Record<string, unknown>) => {
        calls.push({ method: "comments.list", params });
        const i = params.pageToken ? Number(params.pageToken) : 0;
        return {
          data: {
            comments: pages[i] ?? [],
            nextPageToken: i + 1 < pages.length ? String(i + 1) : undefined,
          },
        };
      },
    },
  };
  const docs = {
    documents: {
      get: async (params: Record<string, unknown>) => {
        calls.push({ method: "documents.get", params });
        if (data.docsError) throw data.docsError;
        return {
          data: {
            tabs: [
              { tabProperties: { title: "Checklist" } },
              { tabProperties: { title: "Draft" } },
            ],
          },
        };
      },
    },
  };
  return { calls, drive, docs };
}

async function connect(scopes: string[], data: MockData = {}) {
  const { calls, drive, docs } = mocks(data);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const server = createServer({ drive, docs, authorizedScopes: scopes } as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "docs-test", version: "0.0.0" });
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

async function locate(
  fix: Awaited<ReturnType<typeof connect>>,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await fix.client.callTool({
    name: "docs_locate_comments",
    arguments: { documentId: "doc1", ...args },
  })) as ToolResult;
}

const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

/* eslint-disable @typescript-eslint/no-explicit-any */
const threadsOf = (r: ToolResult) => (r.structuredContent as any).threads as any[];
/* eslint-enable @typescript-eslint/no-explicit-any */

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.GMAIL_MCP_RATE_LIMIT_DISABLE = "1";
  delete process.env.GMAIL_MCP_DRY_RUN;
});
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("docs_locate_comments", () => {
  it("is advertised on drive and drive.readonly tokens, with an output schema", async () => {
    for (const scope of ["drive", "drive.readonly"]) {
      const fix = await connect([scope]);
      const tool = (await fix.client.listTools()).tools.find(
        (t) => t.name === "docs_locate_comments",
      );
      expect(tool?.outputSchema).toBeDefined();
      await fix.close();
    }
    const docsOnly = await connect(["documents"]);
    const names = (await docsOnly.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("docs_locate_comments");
    await docsOnly.close();
  });

  it("exports HTML, reads every comment page, and places each thread", async () => {
    const fix = await connect(["drive.readonly"]);
    const r = await locate(fix, {});
    expect(r.isError).toBeFalsy();
    const threads = threadsOf(r);
    expect(threads.map((t) => t.commentId)).toEqual(["c1", "c2"]);
    expect(threads[0].location).toMatchObject({
      kind: "table_cell",
      tab: "Checklist",
      headingPath: ["Connectors"],
      rowKey: "26",
      column: "Action",
      cellText: "Drop",
    });
    expect(threads[0].replies[0].action).toBe("resolve");
    expect(threads[1].location).toMatchObject({ kind: "paragraph", tab: "Draft", text: "Intro" });

    const exp = fix.calls.find((c) => c.method === "files.export")!;
    expect(exp.params).toMatchObject({ mimeType: "text/html", responseType: "text" });
    const pages = fix.calls.filter((c) => c.method === "comments.list");
    expect(pages).toHaveLength(2);
    expect(String(pages[0]!.params.fields)).toContain("replies(");
    expect(String(pages[0]!.params.fields)).toContain("action");
    const tabsCall = fix.calls.find((c) => c.method === "documents.get")!;
    expect(String(tabsCall.params.fields)).toContain("tabProperties(title)");
    expect(textOf(r)).toContain('"commentId":"c1"');
    await fix.close();
  });

  it("filters by tab and mention", async () => {
    const fix = await connect(["drive"]);
    expect(threadsOf(await locate(fix, { tabTitle: "draft" })).map((t) => t.commentId)).toEqual([
      "c2",
    ]);
    expect(
      threadsOf(await locate(fix, { mentions: "pm@example.com" })).map((t) => t.commentId),
    ).toEqual(["c1"]);
    const bad = await locate(fix, { tabTitle: "Nope" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/Available tabs: Checklist, Draft/);
    await fix.close();
  });

  it("still locates comments when the Docs API refuses the tab read", async () => {
    const fix = await connect(["drive.readonly"], {
      docsError: apiError(403, "no documents scope"),
    });
    const r = await locate(fix, {});
    expect(r.isError).toBeFalsy();
    expect(threadsOf(r)[0].location).toMatchObject({ rowKey: "26", tab: null });
    expect(JSON.stringify(r.structuredContent)).toMatch(/tab titles could not be read/);
    const tabFilter = await locate(fix, { tabTitle: "Draft" });
    expect(tabFilter.isError).toBe(true);
    await fix.close();
  });

  it("refuses a file that is not a Google Doc and points to drive_list_comments", async () => {
    const fix = await connect(["drive"], {
      mimeType: "application/vnd.google-apps.spreadsheet",
    });
    const r = await locate(fix, {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/drive_list_comments/);
    expect(fix.calls.some((c) => c.method === "files.export")).toBe(false);
    await fix.close();
  });

  it("maps Drive errors to plain messages", async () => {
    const cases: [MockData, RegExp][] = [
      [{ getError: apiError(404, "File not found: doc1") }, /Document not found/],
      [{ getError: apiError(403, "forbidden") }, /Insufficient permissions/],
      [
        {
          exportError: apiError(
            403,
            "This file is too large to be exported. exportSizeLimitExceeded",
          ),
        },
        /exportSizeLimitExceeded[\s\S]*drive_list_comments/,
      ],
      [{ exportError: sizeError() }, /exportSizeLimitExceeded[\s\S]*drive_list_comments/],
      [{ exportError: apiError(500, "backend") }, /HTTP 500/],
      [{ html: { not: "text" } }, /did not return text/],
    ];
    for (const [data, pattern] of cases) {
      const fix = await connect(["drive"], data);
      const r = await locate(fix, {});
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(pattern);
      await fix.close();
    }
  });
});

describe("drive_list_comments", () => {
  it("requests reply actions, assignees, and mentions", async () => {
    const fix = await connect(["drive.readonly"]);
    const r = (await fix.client.callTool({
      name: "drive_list_comments",
      arguments: { fileId: "doc1" },
    })) as ToolResult;
    expect(r.isError).toBeFalsy();
    const fields = String(fix.calls.find((c) => c.method === "comments.list")!.params.fields);
    expect(fields.slice(fields.indexOf("replies("))).toMatch(/\baction\b/);
    expect(fields).toContain("assigneeEmailAddress");
    expect(fields).toContain("mentionedEmailAddresses");
    await fix.close();
  });
});
