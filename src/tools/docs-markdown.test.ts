import { describe, it, expect } from "vitest";
import type { docs_v1 } from "googleapis";
import {
  buildMarkdownRequests,
  listMarkerFor,
  paragraphMarkdown,
  parseInline,
  parseMarkdownBlock,
} from "./docs-markdown.js";

describe("parseInline", () => {
  it("keeps bold and code as before", () => {
    expect(parseInline("a **b** `c`")).toEqual({
      text: "a b c",
      spans: [
        { start: 2, end: 3, type: "bold" },
        { start: 4, end: 5, type: "code" },
      ],
    });
  });

  it("turns [text](url) into a link span", () => {
    expect(parseInline("See [the docs](https://example.com/a?b=1) now")).toEqual({
      text: "See the docs now",
      spans: [{ start: 4, end: 12, type: "link", url: "https://example.com/a?b=1" }],
    });
  });

  it("accepts a mailto link", () => {
    expect(parseInline("[mail](mailto:a@b.com)").spans[0]).toMatchObject({
      type: "link",
      url: "mailto:a@b.com",
    });
  });

  it("leaves a link with another scheme, no url, or no closing paren as literal text", () => {
    for (const s of [
      "[x](javascript:alert(1))",
      "[x]()",
      "[x](https://a.com",
      "[x] (https://a.com)",
    ]) {
      const { text, spans } = parseInline(s);
      expect(spans.filter((sp) => sp.type === "link")).toEqual([]);
      expect(text).toBe(s);
    }
  });

  it("turns *x* and _x_ into italic spans", () => {
    expect(parseInline("an *important* point")).toEqual({
      text: "an important point",
      spans: [{ start: 3, end: 12, type: "italic" }],
    });
    expect(parseInline("_quoted words_")).toEqual({
      text: "quoted words",
      spans: [{ start: 0, end: 12, type: "italic" }],
    });
  });

  it("leaves snake_case, arithmetic, and lone markers alone", () => {
    for (const s of [
      "use snake_case_names here",
      "2 * 3 * 4",
      "a * b",
      "file_name.md and other_file",
      "*",
      "_",
    ]) {
      expect(parseInline(s)).toEqual({ text: s, spans: [] });
    }
  });

  it("does not read bold as italic", () => {
    expect(parseInline("**bold** and *it*").spans).toEqual([
      { start: 0, end: 4, type: "bold" },
      { start: 9, end: 11, type: "italic" },
    ]);
  });

  it("keeps markers inside code literal", () => {
    expect(parseInline("`a*b*c_d_`")).toEqual({
      text: "a*b*c_d_",
      spans: [{ start: 0, end: 8, type: "code" }],
    });
  });

  it("leaves an unclosed marker as literal text", () => {
    expect(parseInline("an *open marker")).toEqual({ text: "an *open marker", spans: [] });
    expect(parseInline("an **open marker")).toEqual({ text: "an **open marker", spans: [] });
  });
});

describe("parseMarkdownBlock", () => {
  it("marks 1. and 1) lines as numbered and strips the marker", () => {
    const { text, paras } = parseMarkdownBlock("1. one\n2) two\n10. ten");
    expect(text).toBe("one\ntwo\nten\n");
    expect(paras.map((p) => p.numbered)).toEqual([true, true, true]);
  });

  it("keeps a year or a decimal at a line start as text", () => {
    const { paras } = parseMarkdownBlock("2026. A year\n1.5 is a number");
    expect(paras.map((p) => !!p.numbered)).toEqual([false, false]);
  });

  it("parses inline markers inside a numbered item", () => {
    const { paras } = parseMarkdownBlock("1. see [x](https://a.com)");
    expect(paras[0]?.spans).toEqual([{ start: 4, end: 5, type: "link", url: "https://a.com" }]);
  });
});

function bulletRequests(reqs: docs_v1.Schema$Request[]) {
  return reqs.flatMap((r) => (r.createParagraphBullets ? [r.createParagraphBullets] : []));
}

describe("buildMarkdownRequests", () => {
  it("inserts the text first, at the anchor", () => {
    const reqs = buildMarkdownRequests(parseMarkdownBlock("hello"), 10, "t.0");
    expect(reqs[0]).toEqual({
      insertText: { text: "hello\n", location: { index: 10, tabId: "t.0" } },
    });
  });

  it("numbers a run of items with one request over the whole run", () => {
    const reqs = buildMarkdownRequests(parseMarkdownBlock("Intro\n1. a\n2. bb\n3. c"), 1, "t.0");
    // Intro\n = 1..7, a\n = 7..9, bb\n = 9..12, c\n = 12..14
    expect(bulletRequests(reqs)).toEqual([
      {
        range: { startIndex: 7, endIndex: 14, tabId: "t.0" },
        bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN",
      },
    ]);
  });

  it("keeps two runs apart when a paragraph separates them", () => {
    const reqs = buildMarkdownRequests(parseMarkdownBlock("1. a\n\n1. b"), 1, "t.0");
    expect(bulletRequests(reqs).map((b) => b.range)).toEqual([
      { startIndex: 1, endIndex: 3, tabId: "t.0" },
      { startIndex: 4, endIndex: 6, tabId: "t.0" },
    ]);
  });

  it("still bullets each - line on its own", () => {
    const reqs = buildMarkdownRequests(parseMarkdownBlock("- a\n- b"), 1, "t.0");
    expect(bulletRequests(reqs)).toEqual([
      {
        range: { startIndex: 1, endIndex: 3, tabId: "t.0" },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
      {
        range: { startIndex: 3, endIndex: 5, tabId: "t.0" },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    ]);
  });

  it("styles a link with its url, an underline, and the Docs link color", () => {
    const reqs = buildMarkdownRequests(parseMarkdownBlock("go [here](https://a.com)"), 5, "t.0");
    const link = reqs.find((r) => r.updateTextStyle?.textStyle?.link);
    expect(link?.updateTextStyle).toMatchObject({
      range: { startIndex: 8, endIndex: 12, tabId: "t.0" },
      textStyle: { link: { url: "https://a.com" }, underline: true },
      fields: "link,underline,foregroundColor",
    });
  });

  it("styles an italic span", () => {
    const reqs = buildMarkdownRequests(parseMarkdownBlock("an *x* y"), 1, "t.0");
    expect(reqs.find((r) => r.updateTextStyle?.textStyle?.italic)?.updateTextStyle).toEqual({
      range: { startIndex: 4, endIndex: 5, tabId: "t.0" },
      textStyle: { italic: true },
      fields: "italic",
    });
  });
});

function run(
  content: string,
  textStyle?: docs_v1.Schema$TextStyle,
): docs_v1.Schema$ParagraphElement {
  return { textRun: { content, textStyle } };
}

describe("read-back", () => {
  it("writes links, bold, code, and italics back as markdown", () => {
    const p: docs_v1.Schema$Paragraph = {
      elements: [
        run("See "),
        run("docs", { link: { url: "https://a.com" }, underline: true }),
        run(", "),
        run("bold", { bold: true }),
        run(", "),
        run("x", { weightedFontFamily: { fontFamily: "Courier New" } }),
        run(", "),
        run("it", { italic: true }),
        run("\n"),
      ],
    };
    expect(paragraphMarkdown(p)).toBe("See [docs](https://a.com), **bold**, `x`, *it*");
  });

  it("numbers items of a numbered list and dashes bullets", () => {
    const lists: Record<string, docs_v1.Schema$List> = {
      num: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
      dot: {
        listProperties: {
          nestingLevels: [{ glyphSymbol: "●", glyphType: "GLYPH_TYPE_UNSPECIFIED" }],
        },
      },
    };
    const counters = new Map<string, number>();
    expect(listMarkerFor({ listId: "num" }, lists, counters)).toBe("1. ");
    expect(listMarkerFor({ listId: "dot" }, lists, counters)).toBe("- ");
    expect(listMarkerFor({ listId: "num" }, lists, counters)).toBe("2. ");
    expect(listMarkerFor({ listId: "missing" }, lists, counters)).toBe("- ");
  });

  it("round-trips a written block's markers through the parser", () => {
    const source = "go [here](https://a.com) *now*";
    const { text, paras } = parseMarkdownBlock(source);
    const spans = paras[0]?.spans ?? [];
    const plain = text.replace(/\n$/, "");
    const elements: docs_v1.Schema$ParagraphElement[] = [];
    let at = 0;
    for (const s of spans) {
      if (s.start > at) elements.push(run(plain.slice(at, s.start)));
      const style: docs_v1.Schema$TextStyle =
        s.type === "link"
          ? { link: { url: s.url } }
          : s.type === "italic"
            ? { italic: true }
            : { bold: true };
      elements.push(run(plain.slice(s.start, s.end), style));
      at = s.end;
    }
    if (at < plain.length) elements.push(run(plain.slice(at)));
    expect(paragraphMarkdown({ elements })).toBe(source);
  });
});
