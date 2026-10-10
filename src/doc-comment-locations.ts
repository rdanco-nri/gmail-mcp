/**
 * Locate Google Doc comments from the Doc's HTML export.
 *
 * Drive's `files.export(text/html)` marks every open comment and reply
 * with an inline anchor at its current position, and appends each body
 * at the end of the document:
 *
 *   <td><p><span>Drop</span><sup><a href="#cmnt1" id="cmnt_ref1">[a]</a></sup></p></td>
 *   ...
 *   <div><p><a href="#cmnt_ref1" id="cmnt1">[a]</a><span>comment text</span></p>
 *        <p><span>_Assigned to someone@example.com_</span></p></div>
 *
 * The export carries no comment IDs, authors, or thread grouping, and
 * omits resolved threads. `joinThreads` matches each Drive API thread to
 * its markers by text so the API supplies those fields and the export
 * supplies the position.
 *
 * Pure: no API calls.
 */

import type { drive_v3 } from "googleapis";
import { Parser } from "htmlparser2";

export interface ExportMarker {
  /** The N in `cmnt_refN`; keys the body. */
  n: number;
  /** Position in document order. */
  seq: number;
  tab: string | null;
  headingPath: string[];
  kind: "table_cell" | "paragraph";
  tableIndex?: number;
  rowIndex?: number;
  colIndex?: number;
  /** The enclosing paragraph's text, for markers outside tables. */
  paragraphText?: string;
}

export interface ExportTable {
  index: number;
  tab: string | null;
  headingPath: string[];
  rows: string[][];
}

export interface ExportBody {
  n: number;
  text: string;
  status?: "resolve" | "reopen";
  assignee?: string;
}

export interface ParsedExport {
  markers: ExportMarker[];
  tables: ExportTable[];
  bodies: Map<number, ExportBody>;
  /** Tab titles found in the export, in order. */
  tabsSeen: string[];
}

const BLOCK_TAGS = new Set(["p", "br", "li", "div", "tr", "h1", "h2", "h3", "h4", "h5", "h6"]);
const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Collapse whitespace (incl. U+00A0, U+202F) and trim. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

/** Letters and digits only, lowercased — the fallback join key. */
export function looseKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Split a comment body's paragraphs into the comment text and the
 * export's status lines (assignment, resolve/reopen, reactions).
 */
function classifyBody(n: number, paragraphs: string[]): ExportBody {
  const body: ExportBody = { n, text: "" };
  const kept: string[] = [];
  let inReactions = false;
  for (const raw of paragraphs) {
    const p = normalizeText(raw);
    if (!p) continue;
    const assigned = /^_Assigned to (.+)_$/u.exec(p);
    if (assigned?.[1]) {
      body.assignee = assigned[1];
      continue;
    }
    if (p === "_Marked as resolved_") {
      body.status = "resolve";
      continue;
    }
    if (p === "_Re-opened_") {
      body.status = "reopen";
      continue;
    }
    if (/^\d+ total reactions?$/u.test(p)) {
      inReactions = true;
      continue;
    }
    if (inReactions && / reacted with .+ at /u.test(p)) continue;
    inReactions = false;
    kept.push(p);
  }
  body.text = kept.join(" ");
  return body;
}

/**
 * Walk the export once. `tabTitles` (from the Docs API, in order) marks
 * tab boundaries: the export writes each tab title as a `<p class="title">`,
 * and a Title-styled paragraph in the body uses the same class, so only a
 * title paragraph whose text equals the next expected tab title counts.
 */
export function parseExportMarkers(html: string, tabTitles: readonly string[] = []): ParsedExport {
  const markers: ExportMarker[] = [];
  const tables: ExportTable[] = [];
  const bodies = new Map<number, ExportBody>();
  const tabsSeen: string[] = [];

  let skipDepth = 0; // inside <head>/<style>/<script>

  // A single-tab Doc may carry no title paragraph, so its one tab holds
  // everything from the start.
  let tab: string | null = tabTitles.length === 1 ? (tabTitles[0] ?? null) : null;
  let nextTab = 0;
  if (tab !== null) tabsSeen.push(tab);
  const headings: string[] = [];
  const headingPath = () => headings.filter((h) => h);

  // Heading or tab-title paragraph being collected, and markers inside it.
  let headingLevel = 0;
  let titleDepth = 0;
  let collect: string | null = null;
  let headingMarkers: ExportMarker[] = [];

  // Tables nest. Each open table tracks its current cell's text and grid
  // column, and the cells a rowspan carries into later rows.
  interface OpenTable {
    table: ExportTable;
    cell: string | null;
    cellCol: number;
    colSpan: number;
    rowSpan: number;
    carry: ({ left: number; text: string } | undefined)[];
  }
  const tableStack: OpenTable[] = [];

  // Top-level paragraph text, for markers outside tables.
  let blockDepth = 0;
  let blockText = "";
  let blockMarkers: ExportMarker[] = [];

  // Inline anchor being read, and the comment body being collected.
  let anchor: "ref" | "body" | null = null;
  let bodyN: number | null = null;
  let bodyDivDepth = 0;
  let divDepth = 0;
  let bodyParas: string[] = [];
  let bodyPara: string | null = null;

  const appendText = (t: string) => {
    if (collect !== null) collect += t;
    const top = tableStack[tableStack.length - 1];
    if (top && top.cell !== null) top.cell += t;
    else if (blockDepth > 0) blockText += t;
  };

  const appendBreak = () => appendText(" ");

  const saveBody = () => {
    if (bodyN === null) return;
    if (bodyPara) bodyParas.push(bodyPara);
    bodies.set(bodyN, classifyBody(bodyN, bodyParas));
    bodyN = null;
    bodyPara = null;
  };

  const spanOf = (v: string | undefined) => Math.max(1, Number.parseInt(v ?? "1", 10) || 1);

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === "head" || name === "style" || name === "script") {
          skipDepth++;
          return;
        }
        if (skipDepth) return;
        if (name === "div") divDepth++;

        if (name === "a") {
          const id = attribs.id ?? "";
          const ref = /^cmnt_ref(\d+)$/.exec(id);
          const body = /^cmnt(\d+)$/.exec(id);
          if (ref?.[1]) {
            anchor = "ref";
            const top = tableStack[tableStack.length - 1];
            const m: ExportMarker = {
              n: Number(ref[1]),
              seq: markers.length,
              tab,
              headingPath: headingPath(),
              kind: top ? "table_cell" : "paragraph",
            };
            if (top) {
              m.tableIndex = top.table.index;
              m.rowIndex = top.table.rows.length - 1;
              m.colIndex = top.cellCol;
            } else {
              blockMarkers.push(m);
            }
            if (headingLevel && collect !== null) headingMarkers.push(m);
            markers.push(m);
            return;
          }
          if (body?.[1]) {
            if (bodyN !== null) saveBody();
            anchor = "body";
            bodyN = Number(body[1]);
            bodyDivDepth = divDepth;
            bodyParas = [];
            bodyPara = "";
            return;
          }
        }

        if (bodyN !== null) {
          if (name === "p") bodyPara = "";
          return;
        }

        if (HEADING_LEVEL[name] && tableStack.length === 0) {
          headingLevel = HEADING_LEVEL[name];
          collect = "";
        } else if (name === "p" && attribs.class?.split(/\s+/).includes("title")) {
          titleDepth = 1;
          collect = "";
        }

        if (name === "table") {
          const table: ExportTable = {
            index: tables.length,
            tab,
            headingPath: headingPath(),
            rows: [],
          };
          tableStack.push({ table, cell: null, cellCol: 0, colSpan: 1, rowSpan: 1, carry: [] });
          tables.push(table);
          return;
        }
        const top = tableStack[tableStack.length - 1];
        if (top) {
          if (name === "tr") {
            // Cells a rowspan carries down fill their columns first.
            const row: string[] = [];
            top.carry.forEach((c, i) => {
              if (!c) return;
              row[i] = c.text;
              top.carry[i] = c.left > 1 ? { left: c.left - 1, text: c.text } : undefined;
            });
            top.table.rows.push(row);
          } else if (name === "td" || name === "th") {
            const row = top.table.rows[top.table.rows.length - 1] ?? [];
            let col = 0;
            while (row[col] !== undefined) col++;
            top.cellCol = col;
            top.colSpan = spanOf(attribs.colspan);
            top.rowSpan = spanOf(attribs.rowspan);
            top.cell = "";
          } else if (BLOCK_TAGS.has(name)) {
            appendBreak();
          }
          return;
        }
        if (name === "p" || name === "li" || HEADING_LEVEL[name]) {
          if (blockDepth === 0) {
            blockText = "";
            blockMarkers = [];
          }
          blockDepth++;
        } else if (name === "br") {
          appendBreak();
        }
      },

      ontext(text) {
        if (skipDepth || anchor) return;
        if (bodyN !== null) {
          if (bodyPara !== null) bodyPara += text;
          return;
        }
        appendText(text);
      },

      onclosetag(name) {
        if (name === "head" || name === "style" || name === "script") {
          skipDepth = Math.max(0, skipDepth - 1);
          return;
        }
        if (skipDepth) return;
        if (name === "a" && anchor) {
          anchor = null;
          return;
        }

        if (bodyN !== null) {
          if (name === "p" && bodyPara !== null) {
            bodyParas.push(bodyPara);
            bodyPara = null;
          }
          if (name === "div") {
            divDepth--;
            if (divDepth < bodyDivDepth) saveBody();
          }
          return;
        }
        if (name === "div") divDepth--;

        if (HEADING_LEVEL[name] && headingLevel === HEADING_LEVEL[name] && collect !== null) {
          headings.length = headingLevel - 1;
          headings[headingLevel - 1] = normalizeText(collect);
          // A comment on the heading itself belongs under that heading.
          for (const m of headingMarkers) m.headingPath = headingPath();
          headingMarkers = [];
          headingLevel = 0;
          collect = null;
        } else if (name === "p" && titleDepth && collect !== null) {
          const title = normalizeText(collect);
          if (title && title === tabTitles[nextTab]) {
            tab = title;
            if (!tabsSeen.includes(title)) tabsSeen.push(title);
            nextTab++;
            headings.length = 0;
          }
          titleDepth = 0;
          collect = null;
        }

        const top = tableStack[tableStack.length - 1];
        if (top) {
          if (name === "table") {
            tableStack.pop();
            return;
          }
          if ((name === "td" || name === "th") && top.cell !== null) {
            // A merged cell fills every grid column it covers, and a rowspan
            // carries its text into the rows below.
            const row = top.table.rows[top.table.rows.length - 1];
            const text = normalizeText(top.cell);
            for (let k = 0; k < top.colSpan; k++) {
              const col = top.cellCol + k;
              if (row) row[col] = text;
              if (top.rowSpan > 1) top.carry[col] = { left: top.rowSpan - 1, text };
            }
            top.cell = null;
          }
          if (name === "tr") {
            const row = top.table.rows[top.table.rows.length - 1];
            if (row) for (let i = 0; i < row.length; i++) row[i] ??= "";
          }
          return;
        }
        if ((name === "p" || name === "li" || HEADING_LEVEL[name]) && blockDepth > 0) {
          blockDepth--;
          if (blockDepth === 0) {
            const text = normalizeText(blockText);
            for (const m of blockMarkers) m.paragraphText = text;
            blockMarkers = [];
          }
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  saveBody();

  return { markers, tables, bodies, tabsSeen };
}

// ---- Join ----------------------------------------------------------------

export type ApiReply = drive_v3.Schema$Reply;
export type ApiThread = drive_v3.Schema$Comment;

export type UnplacedCode = "resolved_not_in_export" | "not_found_in_export";

export interface ThreadPlacement {
  /** The top comment's marker, or null when unplaced. */
  marker: ExportMarker | null;
  /** Other equally good markers when the match is ambiguous. */
  candidates: ExportMarker[];
  unplaced?: UnplacedCode;
}

export interface JoinResult {
  placements: Map<string, ThreadPlacement>;
  unmatchedMarkers: ExportMarker[];
}

function positionKey(m: ExportMarker): string {
  return m.kind === "table_cell"
    ? `t${m.tableIndex}:${m.rowIndex}:${m.colIndex}`
    : `p${m.tab ?? ""}:${m.paragraphText ?? ""}`;
}

function textMatches(apiText: string | null | undefined, body: ExportBody | undefined): boolean {
  if (!body) return false;
  const a = normalizeText(apiText ?? "");
  if (a === body.text) return true;
  const la = looseKey(a);
  return la.length > 0 && la === looseKey(body.text);
}

function replyMatches(reply: ApiReply, body: ExportBody | undefined): boolean {
  if (!body) return false;
  if (reply.action && body.status === reply.action) {
    return !normalizeText(reply.content ?? "") || textMatches(reply.content, body);
  }
  return !body.status && textMatches(reply.content, body);
}

/**
 * Place each API thread on the marker of its top comment.
 *
 * Text decides every match, never position alone: two threads can share
 * a cell, and the API lists threads newest-first. When several markers
 * carry the top comment's text, the one followed (in the same cell) by
 * the most of the thread's replies wins; a tie is ambiguous and claims
 * nothing. Threads with more replies are placed first, so a longer thread
 * cannot lose its markers to a shorter one with the same opening text.
 * Resolved threads skip the match: the export never contains them, so
 * any marker they matched would belong to an open thread.
 */
export function joinThreads(parsed: ParsedExport, threads: readonly ApiThread[]): JoinResult {
  const claimed = new Set<number>();
  const placements = new Map<string, ThreadPlacement>();
  const liveReplies = (t: ApiThread) => (t.replies ?? []).filter((r) => !r.deleted);
  const order = threads
    .map((t, i) => ({ t, i }))
    .sort((a, b) => liveReplies(b.t).length - liveReplies(a.t).length || a.i - b.i);

  for (const { t } of order) {
    const id = t.id ?? "";
    if (t.resolved) {
      placements.set(id, { marker: null, candidates: [], unplaced: "resolved_not_in_export" });
      continue;
    }
    const tops = parsed.markers.filter(
      (m) => !claimed.has(m.n) && textMatches(t.content, parsed.bodies.get(m.n)),
    );
    if (tops.length === 0) {
      placements.set(id, { marker: null, candidates: [], unplaced: "not_found_in_export" });
      continue;
    }

    const scored = tops.map((top) => {
      const replyMarkers: ExportMarker[] = [];
      const key = positionKey(top);
      let next = top.seq + 1;
      for (const reply of liveReplies(t)) {
        const m = parsed.markers[next];
        if (!m || claimed.has(m.n) || positionKey(m) !== key) break;
        if (!replyMatches(reply, parsed.bodies.get(m.n))) break;
        replyMarkers.push(m);
        next++;
      }
      return { top, replyMarkers };
    });
    const best = Math.max(...scored.map((s) => s.replyMarkers.length));
    const winners = scored.filter((s) => s.replyMarkers.length === best);

    if (winners.length > 1) {
      placements.set(id, { marker: null, candidates: winners.map((w) => w.top) });
      continue;
    }
    const win = winners[0]!;
    claimed.add(win.top.n);
    for (const m of win.replyMarkers) claimed.add(m.n);
    placements.set(id, { marker: win.top, candidates: [] });
  }

  const ambiguousTops = new Set(
    [...placements.values()].flatMap((p) => p.candidates.map((c) => c.n)),
  );
  const unmatchedMarkers = parsed.markers.filter(
    (m) => !claimed.has(m.n) && !ambiguousTops.has(m.n),
  );
  return { placements, unmatchedMarkers };
}

// ---- Result assembly -----------------------------------------------------

export interface LocateOptions {
  /** A tab title already resolved against the Doc's tabs. */
  tab?: string;
  mentions?: string;
  includeResolved: boolean;
  includeFullRow: boolean;
  includeReplies: boolean;
  maxCellChars: number;
  maxCommentChars: number;
  /** Budget for the serialized result; see `fitToBudget`. */
  maxTotalChars: number;
}

export interface LocateInput {
  fileId: string;
  name: string;
  modifiedTime: string | null;
  html: string;
  /** Tab titles in order, or null when the Docs API call failed. */
  tabTitles: string[] | null;
  threads: ApiThread[];
  /** Set when comment paging stopped at its cap. */
  commentsTruncated: boolean;
}

type Location =
  | {
      kind: "table_cell";
      tab: string | null;
      headingPath: string[];
      tableIndex: number;
      rowIndex: number;
      rowKey: string;
      column: string;
      cellText: string;
      rowRef?: string;
    }
  | { kind: "paragraph"; tab: string | null; headingPath: string[]; text: string };

export interface LocatedThread {
  commentId: string;
  author: { name: string | null; me: boolean };
  createdTime: string | null;
  resolved: boolean;
  content: string;
  highlightAtCommentTime: string | null;
  assignee: string | null;
  mentions: string[];
  location: Location | null;
  unplaced?: { code: UnplacedCode; reason: string };
  ambiguous?: true;
  candidates?: Location[];
  replies?: {
    id: string;
    author: { name: string | null; me: boolean };
    createdTime: string | null;
    content: string;
    action?: string;
  }[];
}

export interface LocateResult {
  fileId: string;
  name: string;
  modifiedTime: string | null;
  threads: LocatedThread[];
  rows?: {
    rowRef: string;
    tab: string | null;
    headingPath: string[];
    cells: Record<string, string>;
  }[];
  unmatchedMarkers: { location: Location; text: string; status?: string; assignee?: string }[];
  coverage: {
    placed: number;
    unplaced: number;
    ambiguous: number;
    unmatchedMarkers: number;
    tabsSeen: string[];
    tabs: string[] | null;
    notes: string[];
  };
}

const UNPLACED_REASON: Record<UnplacedCode, string> = {
  resolved_not_in_export:
    "The thread is resolved, and the HTML export omits resolved threads, so its position is unknown.",
  not_found_in_export:
    "The comment's text was not found in the HTML export; the text it was attached to may have been deleted.",
};

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Column names for a table: the header row, or `col N` when it is unusable. */
function columnNames(table: ExportTable): string[] {
  const header = table.rows[0] ?? [];
  const width = Math.max(0, ...table.rows.map((r) => r.length));
  const filled = header.filter((h) => h);
  const usable = filled.length > 0 && new Set(filled).size === filled.length;
  return Array.from({ length: width }, (_, i) => (usable && header[i]) || `col ${i + 1}`);
}

function toLocation(m: ExportMarker, parsed: ParsedExport, opts: LocateOptions): Location {
  if (m.kind === "paragraph") {
    return {
      kind: "paragraph",
      tab: m.tab,
      headingPath: m.headingPath,
      text: clip(m.paragraphText ?? "", opts.maxCellChars),
    };
  }
  const table = parsed.tables[m.tableIndex ?? -1];
  const row = table?.rows[m.rowIndex ?? -1] ?? [];
  const col = m.colIndex ?? 0;
  const loc: Location = {
    kind: "table_cell",
    tab: m.tab,
    headingPath: m.headingPath,
    tableIndex: m.tableIndex ?? -1,
    rowIndex: m.rowIndex ?? -1,
    rowKey: clip(row.find((c) => c) ?? "", opts.maxCellChars),
    column: table ? (columnNames(table)[col] ?? `col ${col + 1}`) : `col ${col + 1}`,
    cellText: clip(row[col] ?? "", opts.maxCellChars),
  };
  if (opts.includeFullRow) loc.rowRef = `${loc.tableIndex}:${loc.rowIndex}`;
  return loc;
}

function mentionsOf(t: ApiThread): string[] {
  const all = [
    ...(t.mentionedEmailAddresses ?? []),
    ...(t.replies ?? []).flatMap((r) => r.mentionedEmailAddresses ?? []),
  ];
  return [...new Set(all.map((e) => e.toLowerCase()))];
}

function threadTagsEmail(t: ApiThread, email: string): boolean {
  const e = email.toLowerCase();
  if (mentionsOf(t).includes(e)) return true;
  const assignees = [
    t.assigneeEmailAddress,
    ...(t.replies ?? []).map((r) => r.assigneeEmailAddress),
  ];
  if (assignees.some((a) => a?.toLowerCase() === e)) return true;
  const texts = [t.content, ...(t.replies ?? []).map((r) => r.content)];
  return texts.some((s) => {
    const lower = (s ?? "").toLowerCase();
    return lower.includes(`@${e}`) || lower.includes(`+${e}`);
  });
}

// Room kept for the notes `fitToBudget` adds after measuring.
const BUDGET_NOTE_RESERVE = 1_000;

/** Keep the longest prefix of `items` whose JSON fits in `room` characters. */
function keepPrefix<T>(items: T[], room: number): number {
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    used += JSON.stringify(items[i]).length + 1;
    if (used > room) return i;
  }
  return items.length;
}

/**
 * Shrink the result until its JSON fits `max` characters: drop full rows,
 * then shorten comment text, then drop unmatched markers, then threads,
 * from the end. Each step adds a note so the caller knows what is missing.
 */
function fitToBudget(result: LocateResult, max: number): void {
  const size = () => JSON.stringify(result).length;
  if (size() <= max) return;
  const notes = result.coverage.notes;

  if (result.rows) {
    delete result.rows;
    for (const t of result.threads) {
      for (const loc of [t.location, ...(t.candidates ?? [])]) {
        if (loc?.kind === "table_cell") delete loc.rowRef;
      }
    }
    for (const u of result.unmatchedMarkers) {
      if (u.location.kind === "table_cell") delete u.location.rowRef;
    }
    notes.push("Full rows were dropped to fit the response size limit.");
    if (size() <= max) return;
  }

  for (const t of result.threads) {
    t.content = clip(t.content, 200);
    for (const r of t.replies ?? []) r.content = clip(r.content, 200);
  }
  for (const u of result.unmatchedMarkers) u.text = clip(u.text, 200);
  notes.push(
    "Comment and reply text was shortened to 200 characters to fit the response size limit.",
  );
  if (size() <= max) return;

  const { threads, unmatchedMarkers } = result;
  result.threads = [];
  result.unmatchedMarkers = [];
  const room = max - size() - BUDGET_NOTE_RESERVE;

  const keepThreads = keepPrefix(threads, room);
  result.threads = threads.slice(0, keepThreads);
  const left = room - JSON.stringify(result.threads).length;
  const keepMarkers = keepPrefix(unmatchedMarkers, left);
  result.unmatchedMarkers = unmatchedMarkers.slice(0, keepMarkers);

  if (keepMarkers < unmatchedMarkers.length) {
    notes.push(
      `${unmatchedMarkers.length - keepMarkers} unmatched marker(s) were dropped to fit the response size limit.`,
    );
  }
  if (keepThreads < threads.length) {
    notes.push(
      `${threads.length - keepThreads} thread(s) at the end of the list were dropped to fit the response size limit. Narrow the call with \`tabTitle\` or \`mentions\` to see them.`,
    );
  }
}

/** Parse, join, filter, and shape the tool's result. */
export function locateComments(input: LocateInput, opts: LocateOptions): LocateResult {
  const parsed = parseExportMarkers(input.html, input.tabTitles ?? []);
  const open = input.threads.filter((t) => !t.deleted && (opts.includeResolved || !t.resolved));
  const join = joinThreads(parsed, open);
  const notes: string[] = [];

  const author = (a: drive_v3.Schema$User | undefined) => ({
    name: a?.displayName ?? null,
    me: a?.me === true,
  });

  const located: { thread: LocatedThread; seq: number }[] = [];
  for (const t of open) {
    const p = join.placements.get(t.id ?? "");
    const thread: LocatedThread = {
      commentId: t.id ?? "",
      author: author(t.author),
      createdTime: t.createdTime ?? null,
      resolved: t.resolved === true,
      content: clip(normalizeText(t.content ?? ""), opts.maxCommentChars),
      highlightAtCommentTime: t.quotedFileContent?.value
        ? clip(normalizeText(t.quotedFileContent.value), opts.maxCellChars)
        : null,
      // The API leaves some assignments empty that the export shows.
      assignee:
        t.assigneeEmailAddress ??
        [...(t.replies ?? [])].reverse().find((r) => r.assigneeEmailAddress)
          ?.assigneeEmailAddress ??
        (p?.marker ? parsed.bodies.get(p.marker.n)?.assignee : undefined) ??
        null,
      mentions: mentionsOf(t),
      location: p?.marker ? toLocation(p.marker, parsed, opts) : null,
    };
    if (p && !p.marker && p.candidates.length > 0) {
      thread.ambiguous = true;
      thread.candidates = p.candidates.map((c) => toLocation(c, parsed, opts));
    } else if (p?.unplaced) {
      thread.unplaced = { code: p.unplaced, reason: UNPLACED_REASON[p.unplaced] };
    }
    if (opts.includeReplies) {
      thread.replies = (t.replies ?? [])
        .filter((r) => !r.deleted)
        .map((r) => ({
          id: r.id ?? "",
          author: author(r.author),
          createdTime: r.createdTime ?? null,
          content: clip(normalizeText(r.content ?? ""), opts.maxCommentChars),
          ...(r.action ? { action: r.action } : {}),
        }));
    }
    const seq = p?.marker?.seq ?? p?.candidates[0]?.seq ?? Number.MAX_SAFE_INTEGER;
    located.push({ thread, seq });
  }

  // Document order; unplaced threads last, oldest first.
  located.sort(
    (a, b) =>
      a.seq - b.seq || (a.thread.createdTime ?? "").localeCompare(b.thread.createdTime ?? ""),
  );
  let threads = located.map((l) => l.thread);

  if (opts.tab) {
    const tab = opts.tab;
    threads = threads.filter((t) => {
      const tabs = t.location ? [t.location.tab] : (t.candidates ?? []).map((c) => c.tab);
      return tabs.length === 0 || tabs.includes(tab) || tabs.includes(null);
    });
    notes.push(
      `Filtered to tab "${tab}". Threads whose tab is unknown (unplaced, or before the first tab title in the export) are kept.`,
    );
  }
  if (opts.mentions) {
    const email = opts.mentions;
    const byId = new Map(open.map((o) => [o.id ?? "", o]));
    threads = threads.filter((t) => {
      const src = byId.get(t.commentId);
      return src ? threadTagsEmail(src, email) : false;
    });
    notes.push(`Filtered to threads that assign or mention ${email}.`);
  }

  const resolvedCount = input.threads.filter((t) => !t.deleted && t.resolved).length;
  if (!opts.includeResolved && resolvedCount > 0) {
    notes.push(
      `${resolvedCount} resolved thread(s) are not listed. Pass includeResolved: true to list them; they come back unplaced, because the HTML export omits resolved threads.`,
    );
  }
  if (input.tabTitles === null) {
    notes.push(
      "The Doc's tab titles could not be read, so locations carry no tab and tab filtering is unavailable.",
    );
  } else {
    const missing = input.tabTitles.filter((t) => !parsed.tabsSeen.includes(t));
    if (missing.length > 0 && input.tabTitles.length > 1) {
      notes.push(
        `Tab(s) not found in the export: ${missing.join(", ")}. Comments in those tabs may be attributed to the tab before them.`,
      );
    }
  }
  if (input.commentsTruncated) {
    notes.push("Comment paging stopped at its page cap, so the oldest threads may be missing.");
  }

  const unmatchedMarkers = join.unmatchedMarkers.map((m) => {
    const body = parsed.bodies.get(m.n);
    return {
      location: toLocation(m, parsed, opts),
      text: clip(body?.text ?? "", opts.maxCommentChars),
      ...(body?.status ? { status: body.status } : {}),
      ...(body?.assignee ? { assignee: body.assignee } : {}),
    };
  });
  if (unmatchedMarkers.length > 0) {
    notes.push(
      "unmatchedMarkers lists comments found in the export with no matching API thread (for example a comment edited since the export, or text Google renders differently).",
    );
  }

  const result: LocateResult = {
    fileId: input.fileId,
    name: input.name,
    modifiedTime: input.modifiedTime,
    threads,
    unmatchedMarkers,
    coverage: {
      placed: 0,
      unplaced: 0,
      ambiguous: 0,
      unmatchedMarkers: unmatchedMarkers.length,
      tabsSeen: parsed.tabsSeen,
      tabs: input.tabTitles,
      notes,
    },
  };

  if (opts.includeFullRow) {
    const refs = new Set<string>();
    for (const t of threads) {
      for (const loc of [t.location, ...(t.candidates ?? [])]) {
        if (loc?.kind === "table_cell" && loc.rowRef) refs.add(loc.rowRef);
      }
    }
    result.rows = [...refs].map((ref) => {
      const [ti, ri] = ref.split(":").map(Number);
      const table = parsed.tables[ti ?? -1];
      const names = table ? columnNames(table) : [];
      const row = table?.rows[ri ?? -1] ?? [];
      const cells: Record<string, string> = {};
      row.forEach((cell, i) => {
        cells[names[i] ?? `col ${i + 1}`] = clip(cell, opts.maxCellChars);
      });
      return { rowRef: ref, tab: table?.tab ?? null, headingPath: table?.headingPath ?? [], cells };
    });
  }

  fitToBudget(result, opts.maxTotalChars);
  result.coverage.placed = result.threads.filter((t) => t.location).length;
  result.coverage.unplaced = result.threads.filter((t) => t.unplaced).length;
  result.coverage.ambiguous = result.threads.filter((t) => t.ambiguous).length;
  return result;
}
