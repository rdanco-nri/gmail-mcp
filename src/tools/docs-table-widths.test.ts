import { describe, it, expect } from "vitest";
import { estimateColWidthsPt } from "./docs-table-widths.js";

const CAP = 960;
const PAD = 12;
const MAX_TEXT = 420;

describe("estimateColWidthsPt", () => {
  it("gives a short column its content width, not an even share", () => {
    const rows = [
      ["#", "Description"],
      ["D1", "A specialist guides users through prerequisites for Snowflake and BigQuery"],
      ["12", "Short"],
    ];
    const { widths } = estimateColWidthsPt(rows, 2);
    // "#"/"D1"/"12" column: two chars max -> near floor, far below an even split.
    expect(widths[0]).toBeLessThan(60);
    expect(widths[1]).toBeGreaterThan(widths[0] * 3);
  });

  it("never exceeds the total cap", () => {
    const long = "word ".repeat(80).trim();
    const rows = [
      [long, long, long, long, long, long, long],
      [long, long, long, long, long, long, long],
    ];
    const { widths, total } = estimateColWidthsPt(rows, 7);
    expect(total).toBeLessThanOrEqual(CAP + widths.length); // rounding slack only
  });

  it("respects the longest-word floor so tokens never wrap mid-word", () => {
    const rows = [
      ["a", "Supercalifragilisticexpialidocious plus prose around it ".repeat(6)],
      ["b", "short"],
    ];
    const { widths } = estimateColWidthsPt(rows, 2);
    const floor = "Supercalifragilisticexpialidocious".length * 6.2;
    expect(widths[1]).toBeGreaterThanOrEqual(Math.min(MAX_TEXT, floor));
  });

  it("clamps a single huge column to MAX_TEXT + PAD", () => {
    const rows = [["x".repeat(400)]];
    const { widths } = estimateColWidthsPt(rows, 1);
    expect(widths[0]).toBeLessThanOrEqual(MAX_TEXT + PAD);
  });

  it("handles empty cells and ragged rows", () => {
    const rows = [["a", "", "c"], ["a"]];
    const { widths } = estimateColWidthsPt(rows, 3);
    expect(widths).toHaveLength(3);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(5); // Docs API 5pt minimum
  });

  it("keeps every width at or above the API 5pt minimum under extreme pressure", () => {
    const long = "antidisestablishmentarianism ".repeat(30).trim();
    const rows = [Array<string>(12).fill(long)];
    const { widths } = estimateColWidthsPt(rows, 12);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(5);
  });

  it("reserves ~100pt for fill-in columns (header present, body empty)", () => {
    const rows = [
      ["#", "Title", "Action"],
      ["1", "Guided connector setup wizard", ""],
      ["2", "Trade Desk connector setup", ""],
    ];
    const { widths } = estimateColWidthsPt(rows, 3);
    expect(widths[2]).toBeGreaterThanOrEqual(100);
    // A populated narrow column is NOT inflated.
    expect(widths[0]).toBeLessThan(60);
  });

  it("does not treat a single-row (header-only) table's columns as fill-in", () => {
    const rows = [["A", "B"]];
    const { widths } = estimateColWidthsPt(rows, 2);
    expect(widths[0]).toBeLessThan(60);
  });

  it("only the LAST body-empty column gets the fill-in reserve (mid-table empties stay narrow)", () => {
    const rows = [
      ["#", "Title", "From", "Age", "Action"],
      ["1", "Guided connector setup wizard", "", "", ""],
      ["2", "Trade Desk connector setup", "", "", ""],
    ];
    const { widths } = estimateColWidthsPt(rows, 5);
    expect(widths[4]).toBeGreaterThanOrEqual(100); // Action (last) reserved
    expect(widths[2]).toBeLessThan(60); // From: sourcing-empty, stays narrow
    expect(widths[3]).toBeLessThan(60); // Age: sourcing-empty, stays narrow
  });

  it("never lets a single-word header wrap (bold-width floor)", () => {
    const rows = [
      ["#", "Confidence", "Description"],
      ["C1", "high", "Teams support Can view / Can edit per-member access in the team Access tab"],
      ["C2", "med", "Export the usage dashboard to a multi-sheet Excel file"],
    ];
    const { widths } = estimateColWidthsPt(rows, 3);
    // "Confidence" = 10 chars * 7.0 bold + 12 pad = 82pt minimum.
    expect(widths[1]).toBeGreaterThanOrEqual(82);
  });

  it("is deterministic", () => {
    const rows = [
      ["#", "Title", "Description", "Sources", "From", "Age", "Action"],
      [
        "D1",
        "Connector Setup specialist",
        "A specialist guides users through prerequisites for Snowflake, BigQuery, Redshift, Databricks, and MCP connections",
        "v1.28 agent highlights, PR #1077, PR #1711",
        "v1.26-v1.28",
        "19 weeks",
        "",
      ],
    ];
    const a = estimateColWidthsPt(rows, 7);
    const b = estimateColWidthsPt(rows, 7);
    expect(a).toEqual(b);
  });
});
