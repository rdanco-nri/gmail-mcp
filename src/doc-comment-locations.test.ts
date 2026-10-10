/**
 * Tests for the HTML-export comment locator. Fixtures are synthetic but
 * follow the shape Drive's `files.export(text/html)` produces: a
 * `<p class="title">` per tab, inline `<sup><a id="cmnt_refN">` markers,
 * and comment bodies appended as `<div><p><a id="cmntN">` blocks.
 */

import { describe, it, expect } from "vitest";
import {
  parseExportMarkers,
  joinThreads,
  locateComments,
  normalizeText,
  type ApiThread,
  type LocateOptions,
} from "./doc-comment-locations.js";

const letter = (n: number) => {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) {
    s = String.fromCharCode(97 + ((x - 1) % 26)) + s;
  }
  return s;
};

const ref = (n: number) => `<sup><a href="#cmnt${n}" id="cmnt_ref${n}">[${letter(n)}]</a></sup>`;

function cell(text: string, ...refs: number[]): string {
  return `<td colspan="1" rowspan="1" style="padding:5pt"><p style="margin:0"><span style="x">${text}</span>${refs.map(ref).join("")}</p></td>`;
}

function row(...cells: string[]): string {
  return `<tr style="height:0">${cells.join("")}</tr>`;
}

function body(n: number, ...paragraphs: string[]): string {
  const [first = "", ...rest] = paragraphs;
  return (
    `<div style="x"><p style="y"><a href="#cmnt_ref${n}" id="cmnt${n}">[${letter(n)}]</a><span>${first}</span></p>` +
    rest.map((p) => `<p style="y"><span>${p}</span></p>`).join("") +
    `</div>`
  );
}

function doc(content: string, bodies: string[] = []): string {
  return `<html><head><meta content="text/html; charset=UTF-8"><style>.lst > li:before{content:"[z] "}</style></head><body class="doc-content">${content}<hr>${bodies.join("")}</body></html>`;
}

const tabTitle = (t: string) => `<p class="title" id="h.x"><span>${t}</span></p>`;

const CHECKLIST = doc(
  tabTitle("Checklist") +
    `<h1 id="h.a"><span>Release Review Checklist</span></h1>` +
    `<h2 id="h.b"><span>Widgets</span></h2>` +
    `<table>` +
    row(cell("#"), cell("Title"), cell("Action")) +
    row(cell("D2"), cell("Bulk edit"), cell("Drop", 1)) +
    row(cell("1"), cell("Quick start"), cell("Discuss", 2, 3)) +
    row(cell("2"), cell("Health check", 4, 5, 6), cell("Announce")) +
    `</table>` +
    `<h2 id="h.c"><span>Account &amp; Access</span></h2>` +
    `<table>` +
    row(cell("#"), cell("Title"), cell("Action")) +
    row(cell("D1"), cell("Usage export"), cell("Announce", 7, 8)) +
    `</table>` +
    tabTitle("Draft") +
    `<p><span>Intro paragraph with a note</span>${ref(9)}</p>`,
  [
    body(1, "@alex@example.com not a specific feature"),
    body(2, "This will only confuse users"),
    body(3, "since the button is still on stage -- is it &quot;either works&quot;?"),
    body(4, "How does a user prompt this?"),
    body(5, "_Marked as resolved_"),
    body(6, "_Re-opened_"),
    body(7, "is this going to GA?", "_Assigned to sam@example.com_"),
    body(
      8,
      "I&#39;m going to make a couple of changes.",
      "1 total reaction",
      "Pat reacted with &#128293; at 10/08/2026, 4:55&#8239;PM UTC",
    ),
    body(9, "Tighten&nbsp;this intro"),
  ],
);

const THREADS: ApiThread[] = [
  // Newest first, as comments.list returns them.
  { id: "draft", content: "Tighten this intro", replies: [] },
  {
    id: "usage",
    content: "is this going to GA?",
    assigneeEmailAddress: "sam@example.com",
    mentionedEmailAddresses: ["sam@example.com"],
    replies: [{ id: "r1", content: "I'm going to make a couple of changes." }],
  },
  {
    id: "health",
    content: "How does a user prompt this?",
    replies: [
      { id: "r2", content: "", action: "resolve" },
      { id: "r3", content: "", action: "reopen" },
    ],
  },
  {
    id: "chat",
    content: "This will only confuse users",
    replies: [{ id: "r4", content: 'since the button is still on stage -- is it "either works"?' }],
  },
  {
    id: "bulk",
    content: "@alex@example.com not a specific feature",
    mentionedEmailAddresses: ["alex@example.com"],
    replies: [],
  },
  { id: "old", content: "confirm: \n1. ready?\n2. flagged?", resolved: true, replies: [] },
];

const OPTS: LocateOptions = {
  includeResolved: false,
  includeFullRow: false,
  includeReplies: true,
  maxCellChars: 200,
  maxCommentChars: 1000,
  maxTotalChars: 80_000,
};

function input(
  html: string,
  threads: ApiThread[],
  tabTitles: string[] | null = ["Checklist", "Draft"],
) {
  return {
    fileId: "f1",
    name: "Checklist doc",
    modifiedTime: "2026-10-09T00:00:00Z",
    html,
    tabTitles,
    threads,
    commentsTruncated: false,
  };
}

describe("normalizeText", () => {
  it("collapses ASCII, no-break, and narrow no-break spaces", () => {
    expect(normalizeText("  a b c\n\td  ")).toBe("a b c d");
  });
});

describe("parseExportMarkers", () => {
  const parsed = parseExportMarkers(CHECKLIST, ["Checklist", "Draft"]);

  it("finds every marker and body, keyed by number", () => {
    expect(parsed.markers.map((m) => m.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([...parsed.bodies.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("places table markers on their table, row, and column", () => {
    const m = parsed.markers.find((x) => x.n === 7)!;
    expect(m).toMatchObject({ kind: "table_cell", tableIndex: 1, rowIndex: 1, colIndex: 2 });
    expect(m.headingPath).toEqual(["Release Review Checklist", "Account & Access"]);
    expect(parsed.markers.find((x) => x.n === 4)).toMatchObject({ rowIndex: 3, colIndex: 1 });
  });

  it("keeps marker letters out of cell text", () => {
    expect(parsed.tables[0]!.rows[1]).toEqual(["D2", "Bulk edit", "Drop"]);
  });

  it("treats only expected tab titles as tab boundaries, not the doc's h1", () => {
    expect(parsed.tabsSeen).toEqual(["Checklist", "Draft"]);
    expect(parsed.markers.find((x) => x.n === 1)!.tab).toBe("Checklist");
    const draft = parsed.markers.find((x) => x.n === 9)!;
    expect(draft).toMatchObject({ tab: "Draft", kind: "paragraph", headingPath: [] });
    expect(draft.paragraphText).toBe("Intro paragraph with a note");
  });

  it("ignores a title paragraph that is not the next expected tab", () => {
    const html = doc(tabTitle("Checklist") + tabTitle("A styled title") + `<p>x${ref(1)}</p>`, [
      body(1, "hi"),
    ]);
    const p = parseExportMarkers(html, ["Checklist", "Draft"]);
    expect(p.tabsSeen).toEqual(["Checklist"]);
    expect(p.markers[0]!.tab).toBe("Checklist");
  });

  it("splits status lines out of comment bodies", () => {
    expect(parsed.bodies.get(5)).toMatchObject({ text: "", status: "resolve" });
    expect(parsed.bodies.get(6)).toMatchObject({ text: "", status: "reopen" });
    expect(parsed.bodies.get(7)).toMatchObject({
      text: "is this going to GA?",
      assignee: "sam@example.com",
    });
    expect(parsed.bodies.get(8)!.text).toBe("I'm going to make a couple of changes.");
    expect(parsed.bodies.get(9)!.text).toBe("Tighten this intro");
  });

  it("joins a multi-paragraph body with spaces", () => {
    const html = doc(`<p>x${ref(1)}</p>`, [body(1, "confirm:", "1. ready?", "2. flagged?")]);
    expect(parseExportMarkers(html).bodies.get(1)!.text).toBe("confirm: 1. ready? 2. flagged?");
  });

  it("keys bodies past [z] by number", () => {
    const refs = Array.from({ length: 30 }, (_, i) => i + 1);
    const html = doc(
      `<p>x${refs.map(ref).join("")}</p>`,
      refs.map((n) => body(n, `c${n}`)),
    );
    const p = parseExportMarkers(html);
    expect(p.markers).toHaveLength(30);
    expect(p.bodies.get(28)!.text).toBe("c28");
  });

  it("decodes entities and keeps emoji", () => {
    const html = doc(`<p>x${ref(1)}</p>`, [body(1, "it&#39;s &quot;ok&quot; &#128293;")]);
    expect(parseExportMarkers(html).bodies.get(1)!.text).toBe('it\'s "ok" 🔥');
  });

  it("keeps every body when several share one div", () => {
    const html = doc(`<p>x${ref(1)}${ref(2)}</p>`, [
      `<div><p><a href="#cmnt_ref1" id="cmnt1">[a]</a><span>first</span></p>` +
        `<p><a href="#cmnt_ref2" id="cmnt2">[b]</a><span>second</span></p></div>`,
    ]);
    const p = parseExportMarkers(html);
    expect(p.bodies.get(1)!.text).toBe("first");
    expect(p.bodies.get(2)!.text).toBe("second");
  });

  it("maps merged cells to grid columns and carries rowspans down", () => {
    const span = (attrs: string, text: string, ...refs: number[]) =>
      `<td ${attrs}><p><span>${text}</span>${refs.map(ref).join("")}</p></td>`;
    const html = doc(
      `<table>` +
        row(cell("Section"), span('colspan="2"', "Owner"), cell("Status")) +
        row(span('rowspan="2"', "Alpha"), cell("Ann"), cell("Bo"), cell("Open")) +
        row(cell("Cy"), cell("Di"), cell("Done", 1)) +
        `</table>`,
      [body(1, "why done?")],
    );
    const p = parseExportMarkers(html);
    expect(p.tables[0]!.rows).toEqual([
      ["Section", "Owner", "Owner", "Status"],
      ["Alpha", "Ann", "Bo", "Open"],
      ["Alpha", "Cy", "Di", "Done"],
    ]);
    expect(p.markers[0]).toMatchObject({ rowIndex: 2, colIndex: 3 });
  });

  it("puts a comment on a heading under that heading", () => {
    const html = doc(
      `<h1><span>Spec</span></h1><h2><span>Section A</span></h2>` +
        `<h2><span>Section B</span>${ref(1)}</h2>`,
      [body(1, "rename this")],
    );
    const m = parseExportMarkers(html).markers[0]!;
    expect(m.headingPath).toEqual(["Spec", "Section B"]);
    expect(m.paragraphText).toBe("Section B");
  });

  it("gives a single-tab Doc's markers its tab without a title paragraph", () => {
    const html = doc(`<p>x${ref(1)}</p>`, [body(1, "hi")]);
    const p = parseExportMarkers(html, ["Tab 1"]);
    expect(p.tabsSeen).toEqual(["Tab 1"]);
    expect(p.markers[0]!.tab).toBe("Tab 1");
  });
});

describe("joinThreads", () => {
  const parsed = parseExportMarkers(CHECKLIST, ["Checklist", "Draft"]);

  it("places every open thread on its top comment's marker", () => {
    const { placements, unmatchedMarkers } = joinThreads(parsed, THREADS);
    expect(placements.get("bulk")!.marker!.n).toBe(1);
    expect(placements.get("chat")!.marker!.n).toBe(2);
    expect(placements.get("health")!.marker!.n).toBe(4);
    expect(placements.get("usage")!.marker!.n).toBe(7);
    expect(placements.get("draft")!.marker!.n).toBe(9);
    expect(unmatchedMarkers).toEqual([]);
  });

  it("leaves a resolved thread unplaced with its reason", () => {
    const { placements } = joinThreads(parsed, THREADS);
    expect(placements.get("old")).toMatchObject({
      marker: null,
      unplaced: "resolved_not_in_export",
    });
  });

  it("reports export markers with no API thread", () => {
    const { unmatchedMarkers } = joinThreads(parsed, THREADS.slice(1));
    expect(unmatchedMarkers.map((m) => m.n)).toEqual([9]);
  });

  it("separates two threads in one cell that open with the same text", () => {
    const html = doc(`<table>${row(cell("k"), cell("v", 1, 2, 3))}</table>`, [
      body(1, "ok"),
      body(2, "ok"),
      body(3, "agreed"),
    ]);
    const p = parseExportMarkers(html);
    const { placements, unmatchedMarkers } = joinThreads(p, [
      { id: "short", content: "ok", replies: [] },
      { id: "long", content: "ok", replies: [{ content: "agreed" }] },
    ]);
    expect(placements.get("long")!.marker!.n).toBe(2);
    expect(placements.get("short")!.marker!.n).toBe(1);
    expect(unmatchedMarkers).toEqual([]);
  });

  it("marks identical threads in two places as ambiguous", () => {
    const html = doc(`<table>${row(cell("a", 1))}${row(cell("b", 2))}</table>`, [
      body(1, "same"),
      body(2, "same"),
    ]);
    const p = parseExportMarkers(html);
    const { placements } = joinThreads(p, [{ id: "t", content: "same", replies: [] }]);
    expect(placements.get("t")!.marker).toBeNull();
    expect(placements.get("t")!.candidates.map((c) => c.n)).toEqual([1, 2]);
  });

  it("matches a resolve reply that carries text", () => {
    const html = doc(`<p>x${ref(1)}${ref(2)}</p>`, [
      body(1, "fix this"),
      body(2, "done", "_Marked as resolved_"),
    ]);
    const p = parseExportMarkers(html);
    expect(p.bodies.get(2)).toMatchObject({ text: "done", status: "resolve" });
    const { unmatchedMarkers } = joinThreads(p, [
      { id: "t", content: "fix this", replies: [{ content: "done", action: "resolve" }] },
    ]);
    expect(unmatchedMarkers).toEqual([]);
  });

  it("never lets a resolved thread take an open thread's marker", () => {
    const html = doc(`<table>${row(cell("k"), cell("v", 1))}</table>`, [body(1, "Drop")]);
    const p = parseExportMarkers(html);
    const { placements } = joinThreads(p, [
      { id: "open", content: "Drop", replies: [] },
      { id: "done", content: "Drop", resolved: true, replies: [{ content: "ok" }] },
    ]);
    expect(placements.get("open")!.marker!.n).toBe(1);
    expect(placements.get("done")).toMatchObject({
      marker: null,
      unplaced: "resolved_not_in_export",
    });
  });

  it("skips deleted replies when matching a thread's reply markers", () => {
    const html = doc(`<p>x${ref(1)}${ref(2)}${ref(3)}</p>`, [
      body(1, "q"),
      body(2, "a1"),
      body(3, "a2"),
    ]);
    const p = parseExportMarkers(html);
    const { unmatchedMarkers } = joinThreads(p, [
      {
        id: "t",
        content: "q",
        replies: [{ content: "gone", deleted: true }, { content: "a1" }, { content: "a2" }],
      },
    ]);
    expect(unmatchedMarkers).toEqual([]);
  });

  it("falls back to a letters-and-digits match when punctuation differs", () => {
    const html = doc(`<p>x${ref(1)}</p>`, [body(1, "see https://example.com/a?b=1 now")]);
    const p = parseExportMarkers(html);
    const { placements } = joinThreads(p, [
      { id: "t", content: "see https://example.com/a?b=1  now!", replies: [] },
    ]);
    expect(placements.get("t")!.marker!.n).toBe(1);
  });
});

describe("locateComments", () => {
  it("returns threads in document order with row key and column", () => {
    const r = locateComments(input(CHECKLIST, THREADS), OPTS);
    expect(r.threads.map((t) => t.commentId)).toEqual(["bulk", "chat", "health", "usage", "draft"]);
    expect(r.threads[0]!.location).toMatchObject({
      kind: "table_cell",
      tab: "Checklist",
      rowKey: "D2",
      column: "Action",
      cellText: "Drop",
      rowIndex: 1,
    });
    expect(r.threads[2]!.replies!.map((x) => x.action)).toEqual(["resolve", "reopen"]);
    expect(r.coverage).toMatchObject({ placed: 5, unplaced: 0, ambiguous: 0, unmatchedMarkers: 0 });
    expect(r.coverage.notes.join(" ")).toMatch(/1 resolved thread/);
  });

  it("lists resolved threads last, unplaced, when asked", () => {
    const r = locateComments(input(CHECKLIST, THREADS), { ...OPTS, includeResolved: true });
    const last = r.threads.at(-1)!;
    expect(last.commentId).toBe("old");
    expect(last.location).toBeNull();
    expect(last.unplaced!.code).toBe("resolved_not_in_export");
  });

  it("filters by tab and by mention", () => {
    expect(
      locateComments(input(CHECKLIST, THREADS), { ...OPTS, tab: "Draft" }).threads.map(
        (t) => t.commentId,
      ),
    ).toEqual(["draft"]);
    expect(
      locateComments(input(CHECKLIST, THREADS), {
        ...OPTS,
        mentions: "SAM@example.com",
      }).threads.map((t) => t.commentId),
    ).toEqual(["usage"]);
  });

  it("emits each commented row once when full rows are requested", () => {
    const r = locateComments(input(CHECKLIST, THREADS), { ...OPTS, includeFullRow: true });
    expect(r.rows!.map((x) => x.rowRef)).toEqual(["0:1", "0:2", "0:3", "1:1"]);
    expect(r.rows![3]!.cells).toEqual({ "#": "D1", Title: "Usage export", Action: "Announce" });
    expect(r.threads[3]!.location).toMatchObject({ rowRef: "1:1" });
  });

  it("names columns by number when the header row is unusable", () => {
    const html = doc(`<table>${row(cell(""), cell(""))}${row(cell("a"), cell("b", 1))}</table>`, [
      body(1, "hi"),
    ]);
    const r = locateComments(input(html, [{ id: "t", content: "hi" }], []), OPTS);
    expect(r.threads[0]!.location).toMatchObject({ column: "col 2", rowKey: "a" });
  });

  it("says so when tab titles are unavailable", () => {
    const r = locateComments(input(CHECKLIST, THREADS, null), OPTS);
    expect(r.threads[0]!.location!.tab).toBeNull();
    expect(r.coverage.notes.join(" ")).toMatch(/tab titles could not be read/);
  });

  it("shrinks to the size budget and says what it dropped", () => {
    const many: ApiThread[] = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      content: "x".repeat(900),
    }));
    const r = locateComments(input(CHECKLIST, many), { ...OPTS, maxTotalChars: 5_000 });
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(5_000);
    expect(r.coverage.notes.join(" ")).toMatch(/shortened/);
    expect(r.coverage.notes.join(" ")).toMatch(/dropped/);
  });

  it("keeps threads with an unknown tab when filtering by tab", () => {
    const html = doc(`<p>before${ref(1)}</p>` + tabTitle("A") + `<p>in A${ref(2)}</p>`, [
      body(1, "early"),
      body(2, "later"),
    ]);
    const r = locateComments(
      input(
        html,
        [
          { id: "early", content: "early" },
          { id: "later", content: "later" },
        ],
        ["A", "B"],
      ),
      { ...OPTS, tab: "A" },
    );
    expect(r.threads.map((t) => t.commentId)).toEqual(["early", "later"]);
    expect(r.threads[0]!.location!.tab).toBeNull();
  });

  it("fits the budget when unmatched markers alone overflow it", () => {
    const refs = Array.from({ length: 60 }, (_, i) => i + 1);
    const html = doc(
      `<p>x${refs.map(ref).join("")}</p>`,
      refs.map((n) => body(n, `${n} ${"y".repeat(900)}`)),
    );
    const r = locateComments(input(html, [{ id: "t", content: "1 " + "y".repeat(900) }]), {
      ...OPTS,
      maxTotalChars: 8_000,
    });
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(8_000);
    expect(r.threads.map((t) => t.commentId)).toEqual(["t"]);
    expect(r.coverage.notes.join(" ")).toMatch(/unmatched marker\(s\) were dropped/);
  });

  it("clears rowRef on candidates when full rows are dropped", () => {
    const html = doc(`<table>${row(cell("a", 1))}${row(cell("b", 2))}</table>`, [
      body(1, "same"),
      body(2, "same"),
    ]);
    const many: ApiThread[] = [
      { id: "amb", content: "same" },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, content: "z".repeat(400) })),
    ];
    const r = locateComments(input(html, many, []), {
      ...OPTS,
      includeFullRow: true,
      maxTotalChars: 6_000,
    });
    expect(r.rows).toBeUndefined();
    const amb = r.threads.find((t) => t.commentId === "amb")!;
    expect(amb.candidates!.every((c) => !("rowRef" in c))).toBe(true);
  });

  it("truncates long comments and cells", () => {
    const r = locateComments(input(CHECKLIST, THREADS), {
      ...OPTS,
      maxCellChars: 20,
      maxCommentChars: 50,
    });
    expect(
      r.threads.find((t) => t.commentId === "chat")!.replies![0]!.content.length,
    ).toBeLessThanOrEqual(51);
  });
});
