/**
 * Content-proportional table column widths for docs_write_tab (v0.35).
 *
 * Port of the Confluence `md-to-confluence` `_estimate_col_widths`
 * heuristic, recalibrated from px/16px-system-font to pt/Arial-11pt.
 * Google Docs (like Confluence) has no "fit to content" flag in its API;
 * the editor bakes fixed widths per column, so we compute them from cell
 * content and apply them via `updateTableColumnProperties` (FIXED_WIDTH).
 *
 * The algorithm, unchanged from the Confluence original:
 *   1. Measure each column's distinct single-line cell widths and its
 *      longest unbreakable word (the floor — words never wrap mid-token).
 *   2. Start every column at one line; pre-wrap any column whose widest
 *      cell exceeds MAX_TEXT.
 *   3. Under width pressure (total > TOTAL_CAP), wrap the widest column
 *      one line deeper, repeatedly.
 *   4. Orphan handling: a wrapped column's target width snaps UP to a
 *      real cell's single-line width when one sits within SNAP_MARGIN,
 *      so whole cells land on one line instead of stranding a word.
 *   5. If everything is at floor and still over cap, scale proportionally.
 *   6. Reclaim slack: wrapping is discrete, so spend any leftover budget
 *      buying the cheapest whole-cell fits.
 */

// All units are points (pt). Arial 11pt body text averages ~5.6pt/char;
// the unbreakable-word floor uses a higher per-char estimate because a
// single long token has no spaces (which average narrower than letters).
const CHAR_PT = 5.6;
const WORD_CHAR_PT = 6.2;
// Header row renders bold (wider); a column must never be so narrow that
// its single-word header wraps, so the header's longest word sets a hard
// floor at a bold-width per-char estimate.
const HEADER_CHAR_PT = 7.0;
const PAD = 12; // cell padding (5pt each side) + border slack
const MIN_TEXT_PT = 12; // column floor incl. pad is MIN_TEXT_PT+PAD (24pt > API's 5pt minimum)
const MAX_TEXT_PT = 420;
const TOTAL_CAP_PT = 960; // pageless viewport-ish reading width
const SAFETY = 1.05; // word boundaries mean a wrapped line needs slack
const SNAP_MARGIN = 1.3; // snap up to a cell edge only if within 30%
// A LAST column whose body cells are all empty at generation time is a
// fill-in column (the checklist's Action column, hand-filled by the
// reviewer in the doc). Reserve room to write into instead of collapsing
// to the header's width. Only the last column qualifies: mid-table empty
// columns (From/Age on new items) are empty from sourcing, not by
// construction, and should stay narrow.
const EMPTY_FILL_PT = 100;

function cellLines(text: string): string[] {
  const lines = text.split("\n").map((s) => s.trim());
  return lines.filter((s) => s.length > 0).length ? lines.filter((s) => s.length > 0) : [text];
}

// Width a cell needs for its widest rendered line (pt, no padding).
function cellPt(text: string): number {
  return Math.max(...cellLines(text).map((s) => s.length * CHAR_PT));
}

// Width of the longest unbreakable token (pt, no padding).
function longestWordPt(text: string, perChar: number = WORD_CHAR_PT): number {
  let best = 0;
  for (const line of cellLines(text)) {
    for (const w of line.split(/\s+/)) {
      best = Math.max(best, w.length * perChar);
    }
  }
  return best;
}

interface Col {
  widths: number[]; // distinct single-line cell widths, descending
  max: number;
  floor: number;
}

export function estimateColWidthsPt(
  rows: string[][],
  colCount: number,
): { widths: number[]; total: number } {
  const cols: Col[] = [];
  const fillIn = new Array<boolean>(colCount).fill(false);
  for (let i = 0; i < colCount; i++) {
    const cells = rows.map((r) => r[i]).filter((c): c is string => !!c);
    const bodyEmpty = rows.slice(1).every((r) => !(r[i] ?? "").trim());
    fillIn[i] = rows.length > 1 && bodyEmpty && i === colCount - 1;
    const source = cells.length ? cells : ["x"];
    const widths = [...new Set(source.map(cellPt))].sort((a, b) => b - a);
    let floor = Math.max(...source.map((c) => longestWordPt(c)));
    // Bold header words must fit on one line, whatever the body holds.
    const header = rows[0]?.[i];
    if (header) floor = Math.max(floor, longestWordPt(header, HEADER_CHAR_PT));
    floor = Math.min(MAX_TEXT_PT, Math.max(MIN_TEXT_PT, floor));
    cols.push({ widths, max: widths[0]!, floor });
  }
  // Fill-in columns: raise both floor and target so the reserved width
  // survives the compression loop (floor is never compressed below).
  for (let i = 0; i < colCount; i++) {
    if (fillIn[i]) {
      const c = cols[i]!;
      c.floor = Math.max(c.floor, EMPTY_FILL_PT - PAD);
      c.max = Math.max(c.max, EMPTY_FILL_PT - PAD);
    }
  }

  // Text pt (no padding) for the widest cell laid across n lines,
  // snapped up to a nearby cell edge, clamped to [floor, MAX_TEXT_PT].
  function textWidth(col: Col, n: number): number {
    let target = n <= 1 ? col.max : (col.max / n) * SAFETY;
    target = Math.max(col.floor, target);
    for (let k = col.widths.length - 1; k >= 0; k--) {
      const cw = col.widths[k]!; // ascending cell widths
      if (cw >= target && cw <= target * SNAP_MARGIN) {
        target = cw;
        break;
      }
    }
    return Math.min(MAX_TEXT_PT, Math.max(col.floor, target));
  }

  const colWidth = (col: Col, n: number): number => textWidth(col, n) + PAD;

  const lines = new Array<number>(colCount).fill(1);
  for (let i = 0; i < colCount; i++) {
    while (cols[i]!.max / lines[i]! > MAX_TEXT_PT) lines[i]! += 1;
  }
  const w = cols.map((c, i) => colWidth(c, lines[i]!));
  const total = () => w.reduce((a, b) => a + b, 0);

  let guard = 0;
  while (total() > TOTAL_CAP_PT && guard < 200) {
    guard += 1;
    const cand: number[] = [];
    for (let i = 0; i < colCount; i++) {
      if (colWidth(cols[i]!, lines[i]! + 1) < w[i]! - 1) cand.push(i);
    }
    if (!cand.length) break;
    const i = cand.reduce((a, b) => (w[a]! >= w[b]! ? a : b)); // wrap widest deeper
    lines[i]! += 1;
    w[i] = colWidth(cols[i]!, lines[i]!);
  }

  if (total() > TOTAL_CAP_PT) {
    // Last resort: everything already at floor; scale proportionally.
    const scale = TOTAL_CAP_PT / total();
    const scaled = w.map((x) => Math.max(MIN_TEXT_PT + PAD, x * scale));
    const out = scaled.map((x) => Math.round(x));
    return { widths: out, total: out.reduce((a, b) => a + b, 0) };
  }

  // Reclaim slack: buy the cheapest whole-cell fits with what's left.
  guard = 0;
  while (guard < 200) {
    guard += 1;
    const slack = TOTAL_CAP_PT - total();
    let best: { i: number; cand: number; cost: number } | null = null;
    for (let i = 0; i < colCount; i++) {
      const ascending = [...cols[i]!.widths].sort((a, b) => a - b);
      for (const cw of ascending) {
        const cand = Math.min(MAX_TEXT_PT, cw) + PAD;
        const cost = cand - w[i]!;
        if (cost > 0 && cost <= slack && (best === null || cost < best.cost)) {
          best = { i, cand, cost };
          break;
        }
      }
    }
    if (best === null) break;
    w[best.i] = best.cand;
  }

  const out = w.map((x) => Math.round(x));
  return { widths: out, total: out.reduce((a, b) => a + b, 0) };
}
