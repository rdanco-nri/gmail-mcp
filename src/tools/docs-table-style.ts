/**
 * Pure request-builder for native-table styling in docs_write_tab.
 *
 * Turns a TableStyleSpec (header fill, header text color/bold, alternating
 * row shading, uniform hairline borders) into the Docs API batchUpdate
 * requests that implement it: `updateTableCellStyle` for fills and borders,
 * `updateTextStyle` for the header text. Pure — no API calls — so the
 * index math and request shapes are unit-testable like docs-table-widths.
 *
 * Zebra convention: the header is row 0; data rows are 1..rows-1. The
 * shaded rows are the EVEN table rows >= 2 (the 2nd, 4th, ... data row),
 * so the row directly under the header stays white and shading alternates
 * from there — the standard report-table look.
 */

import type { docs_v1 } from "googleapis";

export interface TableStyleSpec {
  headerFill?: string; // #rrggbb
  headerTextColor?: string; // #rrggbb
  headerBold?: boolean; // defaults true when headerFill or headerTextColor set
  zebraFill?: string; // #rrggbb
  borderColor?: string; // #rrggbb
  borderWidthPt?: number; // defaults 0.5 when borderColor set
}

export interface HeaderCellRange {
  startIndex: number;
  endIndex: number; // exclusive
}

/** Parse "#rrggbb" into the Docs API's OptionalColor. Throws on bad input. */
export function hexToOptionalColor(hex: string): docs_v1.Schema$OptionalColor {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m || !m[1]) throw new Error(`Not a #rrggbb hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return {
    color: {
      rgbColor: {
        red: ((n >> 16) & 0xff) / 255,
        green: ((n >> 8) & 0xff) / 255,
        blue: (n & 0xff) / 255,
      },
    },
  };
}

function cellRange(
  tableStart: number,
  tabId: string,
  rowIndex: number,
  rowSpan: number,
  columnSpan: number,
): docs_v1.Schema$TableRange {
  return {
    tableCellLocation: {
      tableStartLocation: { index: tableStart, tabId },
      rowIndex,
      columnIndex: 0,
    },
    rowSpan,
    columnSpan,
  };
}

/**
 * Build the styling requests for one just-inserted table.
 *
 * `headerCellRanges` are the content ranges (startIndex..endIndex) of each
 * header-row cell's paragraphs, read back AFTER the cell text was inserted
 * (indices from any earlier read are stale). Empty cells are skipped.
 */
export function buildTableStyleRequests(opts: {
  spec: TableStyleSpec;
  tableStart: number;
  tabId: string;
  rows: number;
  columns: number;
  headerCellRanges: HeaderCellRange[];
}): docs_v1.Schema$Request[] {
  const { spec, tableStart, tabId, rows, columns, headerCellRanges } = opts;
  const requests: docs_v1.Schema$Request[] = [];

  // Uniform borders across every cell edge (the hairline grid).
  if (spec.borderColor) {
    const border: docs_v1.Schema$TableCellBorder = {
      color: hexToOptionalColor(spec.borderColor),
      width: { magnitude: spec.borderWidthPt ?? 0.5, unit: "PT" },
      dashStyle: "SOLID",
    };
    requests.push({
      updateTableCellStyle: {
        tableRange: cellRange(tableStart, tabId, 0, rows, columns),
        tableCellStyle: {
          borderLeft: border,
          borderRight: border,
          borderTop: border,
          borderBottom: border,
        },
        fields: "borderLeft,borderRight,borderTop,borderBottom",
      },
    });
  }

  // Header-row fill.
  if (spec.headerFill) {
    requests.push({
      updateTableCellStyle: {
        tableRange: cellRange(tableStart, tabId, 0, 1, columns),
        tableCellStyle: { backgroundColor: hexToOptionalColor(spec.headerFill) },
        fields: "backgroundColor",
      },
    });
  }

  // Alternating data-row fill (even table rows >= 2).
  if (spec.zebraFill) {
    const zebra = hexToOptionalColor(spec.zebraFill);
    for (let r = 2; r < rows; r += 2) {
      requests.push({
        updateTableCellStyle: {
          tableRange: cellRange(tableStart, tabId, r, 1, columns),
          tableCellStyle: { backgroundColor: zebra },
          fields: "backgroundColor",
        },
      });
    }
  }

  // Header text: color and/or bold, per header cell's content range.
  const wantBold = spec.headerBold ?? Boolean(spec.headerFill || spec.headerTextColor);
  if (wantBold || spec.headerTextColor) {
    const textStyle: docs_v1.Schema$TextStyle = {};
    const fields: string[] = [];
    if (wantBold) {
      textStyle.bold = true;
      fields.push("bold");
    }
    if (spec.headerTextColor) {
      textStyle.foregroundColor = hexToOptionalColor(spec.headerTextColor);
      fields.push("foregroundColor");
    }
    for (const range of headerCellRanges) {
      if (range.endIndex <= range.startIndex) continue; // empty cell
      requests.push({
        updateTextStyle: {
          range: { startIndex: range.startIndex, endIndex: range.endIndex, tabId },
          textStyle,
          fields: fields.join(","),
        },
      });
    }
  }

  return requests;
}
