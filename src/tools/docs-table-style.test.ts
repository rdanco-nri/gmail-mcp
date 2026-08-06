import { describe, expect, it } from "vitest";
import {
  buildTableStyleRequests,
  hexToOptionalColor,
  type TableStyleSpec,
} from "./docs-table-style.js";

const TAB = "t.0";
const START = 100;

function build(spec: TableStyleSpec, rows = 8, columns = 2) {
  return buildTableStyleRequests({
    spec,
    tableStart: START,
    tabId: TAB,
    rows,
    columns,
    headerCellRanges: [
      { startIndex: 105, endIndex: 110 },
      { startIndex: 115, endIndex: 133 },
    ],
  });
}

describe("hexToOptionalColor", () => {
  it("parses #rrggbb into normalized rgb", () => {
    const c = hexToOptionalColor("#131166");
    expect(c.color?.rgbColor?.red).toBeCloseTo(0x13 / 255);
    expect(c.color?.rgbColor?.green).toBeCloseTo(0x11 / 255);
    expect(c.color?.rgbColor?.blue).toBeCloseTo(0x66 / 255);
  });

  it("rejects malformed input", () => {
    expect(() => hexToOptionalColor("131166")).toThrow();
    expect(() => hexToOptionalColor("#fff")).toThrow();
    expect(() => hexToOptionalColor("#gggggg")).toThrow();
  });
});

describe("buildTableStyleRequests", () => {
  it("returns nothing for an empty spec", () => {
    expect(build({})).toEqual([]);
  });

  it("fills the header row across all columns", () => {
    const reqs = build({ headerFill: "#131166", headerBold: false });
    const fill = reqs.find(
      (r) => r.updateTableCellStyle?.fields === "backgroundColor",
    )?.updateTableCellStyle;
    expect(fill?.tableRange?.tableCellLocation?.rowIndex).toBe(0);
    expect(fill?.tableRange?.rowSpan).toBe(1);
    expect(fill?.tableRange?.columnSpan).toBe(2);
    expect(fill?.tableRange?.tableCellLocation?.tableStartLocation).toEqual({
      index: START,
      tabId: TAB,
    });
  });

  it("shades even table rows >= 2, never the header or first data row", () => {
    const reqs = build({ zebraFill: "#f5f6f8" }, 8, 2);
    const rows = reqs
      .filter((r) => r.updateTableCellStyle?.fields === "backgroundColor")
      .map((r) => r.updateTableCellStyle?.tableRange?.tableCellLocation?.rowIndex);
    expect(rows).toEqual([2, 4, 6]);
  });

  it("applies uniform borders over the whole table with the 0.5pt default", () => {
    const reqs = build({ borderColor: "#ececee" });
    const b = reqs[0]?.updateTableCellStyle;
    expect(b?.fields).toBe("borderLeft,borderRight,borderTop,borderBottom");
    expect(b?.tableRange?.rowSpan).toBe(8);
    expect(b?.tableRange?.columnSpan).toBe(2);
    expect(b?.tableCellStyle?.borderTop?.width).toEqual({ magnitude: 0.5, unit: "PT" });
    expect(b?.tableCellStyle?.borderTop?.dashStyle).toBe("SOLID");
  });

  it("styles header text bold + white per cell range, defaulting bold on", () => {
    const reqs = build({ headerFill: "#131166", headerTextColor: "#ffffff" });
    const text = reqs.filter((r) => r.updateTextStyle);
    expect(text).toHaveLength(2);
    expect(text[0]?.updateTextStyle?.fields).toBe("bold,foregroundColor");
    expect(text[0]?.updateTextStyle?.textStyle?.bold).toBe(true);
    expect(text[0]?.updateTextStyle?.range).toEqual({
      startIndex: 105,
      endIndex: 110,
      tabId: TAB,
    });
  });

  it("skips empty header cells", () => {
    const reqs = buildTableStyleRequests({
      spec: { headerTextColor: "#ffffff" },
      tableStart: START,
      tabId: TAB,
      rows: 3,
      columns: 2,
      headerCellRanges: [
        { startIndex: 105, endIndex: 105 },
        { startIndex: 115, endIndex: 120 },
      ],
    });
    expect(reqs.filter((r) => r.updateTextStyle)).toHaveLength(1);
  });
});
