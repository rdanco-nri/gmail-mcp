/**
 * Markdown ↔ Google Docs for docs_write_tab and docs_read_tab.
 *
 * Writing: `parseMarkdownBlock` turns the narrative into one text blob plus
 * per-paragraph descriptors, and `buildMarkdownRequests` turns those into the
 * batchUpdate requests that style it. Reading: `paragraphMarkdown` and
 * `listMarkerFor` reflect the same styles back as markdown, so a write then a
 * read shows the markers that were written.
 *
 * The subset: `#`/`##`/`###` headings, `- `/`* ` bullets, `1. ` numbered lists,
 * ``` fenced code, and inline `**bold**`, `*italic*`/`_italic_`, `` `code` ``,
 * and `[text](url)` links. Inline markers do not nest: the inside of a bold,
 * italic, code, or link span is literal text.
 */
import type { docs_v1 } from "googleapis";

// Monospace font + light background used for inline `code` and fenced
// code blocks (Docs has no native code style; this is the convention).
export const CODE_FONT = "Courier New";
export const CODE_BG: docs_v1.Schema$OptionalColor = {
  color: { rgbColor: { red: 0.94, green: 0.94, blue: 0.94 } },
};

// Google Docs' own link look, so a written link matches one made in the editor.
const LINK_COLOR: docs_v1.Schema$OptionalColor = {
  color: { rgbColor: { red: 0x11 / 255, green: 0x55 / 255, blue: 0xcc / 255 } },
};

const BULLET_PRESET = "BULLET_DISC_CIRCLE_SQUARE";
const NUMBERED_PRESET = "NUMBERED_DECIMAL_ALPHA_ROMAN";
const LINK_SCHEMES = /^(https?:\/\/|mailto:)\S+$/;

export type InlineSpanType = "bold" | "italic" | "code" | "link";
export interface InlineSpan {
  start: number; // offset within the paragraph content (stripped text)
  end: number; // exclusive
  type: InlineSpanType;
  url?: string; // for a link
}

export interface ParsedParagraph {
  start: number; // offset within the inserted text block
  len: number; // content length (excluding the trailing newline)
  style?: string; // named style type for a heading
  bullet?: boolean;
  numbered?: boolean;
  code?: boolean; // a fenced-code line — whole paragraph rendered monospace
  spans?: InlineSpan[];
}

const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}_]/u.test(ch);
const isSpace = (ch: string | undefined): boolean => !ch || /\s/.test(ch);

// A single `*` or `_` opens italics only at a word start and closes only at a
// word end, so `snake_case`, `2 * 3`, and a lone asterisk stay literal.
function italicClose(content: string, open: number, marker: string): number {
  if (isWordChar(content[open - 1]) || isSpace(content[open + 1])) return -1;
  for (let j = open + 2; j < content.length; j++) {
    if (content[j] !== marker) continue;
    if (marker === "*" && content[j + 1] === "*") return -1;
    if (!isSpace(content[j - 1]) && !isWordChar(content[j + 1])) return j;
  }
  return -1;
}

// `[text](url)` with an http(s) or mailto URL; anything else stays literal.
function linkAt(content: string, i: number): { text: string; url: string; next: number } | null {
  const closeText = content.indexOf("]", i + 1);
  if (closeText === -1 || content[closeText + 1] !== "(") return null;
  const closeUrl = content.indexOf(")", closeText + 2);
  if (closeUrl === -1) return null;
  const text = content.slice(i + 1, closeText);
  const url = content.slice(closeText + 2, closeUrl).trim();
  if (!text || !LINK_SCHEMES.test(url)) return null;
  return { text, url, next: closeUrl + 1 };
}

// Strip inline markers from one line of content, returning the clean text
// plus the character ranges (relative to that clean text) that need
// character-level styling. A marker that never closes is left as literal text.
export function parseInline(content: string): { text: string; spans: InlineSpan[] } {
  const spans: InlineSpan[] = [];
  let out = "";
  let i = 0;
  const take = (inner: string, type: InlineSpanType, next: number, url?: string): void => {
    const start = out.length;
    out += inner;
    spans.push(url ? { start, end: out.length, type, url } : { start, end: out.length, type });
    i = next;
  };
  while (i < content.length) {
    const ch = content[i];
    if (content.startsWith("**", i)) {
      const close = content.indexOf("**", i + 2);
      if (close !== -1) {
        take(content.slice(i + 2, close), "bold", close + 2);
        continue;
      }
    } else if (ch === "`") {
      const close = content.indexOf("`", i + 1);
      if (close !== -1) {
        take(content.slice(i + 1, close), "code", close + 1);
        continue;
      }
    } else if (ch === "[") {
      const link = linkAt(content, i);
      if (link) {
        take(link.text, "link", link.next, link.url);
        continue;
      }
    } else if (ch === "*" || ch === "_") {
      const close = italicClose(content, i, ch);
      if (close !== -1) {
        take(content.slice(i + 1, close), "italic", close + 1);
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return { text: out, spans };
}

// Turn the markdown-ish narrative into one text blob plus per-paragraph
// descriptors (offsets relative to the blob start). Every line, blank ones
// included, becomes its own paragraph.
export function parseMarkdownBlock(markdown: string): { text: string; paras: ParsedParagraph[] } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let text = "";
  const paras: ParsedParagraph[] = [];
  let inCode = false;
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      inCode = !inCode;
      continue; // the fence line itself is not emitted
    }
    if (inCode) {
      const start = text.length;
      text += `${raw}\n`;
      paras.push({ start, len: raw.length, code: true });
      continue;
    }
    let content = raw;
    let style: string | undefined;
    let bullet = false;
    let numbered = false;
    const number = /^\d{1,3}[.)] /.exec(raw);
    if (raw.startsWith("### ")) {
      content = raw.slice(4);
      style = "HEADING_3";
    } else if (raw.startsWith("## ")) {
      content = raw.slice(3);
      style = "HEADING_2";
    } else if (raw.startsWith("# ")) {
      content = raw.slice(2);
      style = "HEADING_1";
    } else if (raw.startsWith("- ") || raw.startsWith("* ")) {
      content = raw.slice(2);
      bullet = true;
    } else if (number) {
      content = raw.slice(number[0].length);
      numbered = true;
    }
    const { text: stripped, spans } = parseInline(content);
    const start = text.length;
    text += `${stripped}\n`;
    paras.push({
      start,
      len: stripped.length,
      style,
      bullet,
      numbered: numbered || undefined,
      spans: spans.length ? spans : undefined,
    });
  }
  return { text, paras };
}

function spanStyle(span: InlineSpan): { textStyle: docs_v1.Schema$TextStyle; fields: string } {
  switch (span.type) {
    case "bold":
      return { textStyle: { bold: true }, fields: "bold" };
    case "italic":
      return { textStyle: { italic: true }, fields: "italic" };
    case "link":
      return {
        textStyle: { link: { url: span.url }, underline: true, foregroundColor: LINK_COLOR },
        fields: "link,underline,foregroundColor",
      };
    case "code":
      return {
        textStyle: { weightedFontFamily: { fontFamily: CODE_FONT }, backgroundColor: CODE_BG },
        fields: "weightedFontFamily,backgroundColor",
      };
  }
}

// The batchUpdate requests that insert and style a parsed block at `insertAt`.
// A run of consecutive numbered paragraphs gets one createParagraphBullets, so
// it numbers as one list.
export function buildMarkdownRequests(
  parsed: { text: string; paras: ParsedParagraph[] },
  insertAt: number,
  tabId: string,
): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = [
    { insertText: { text: parsed.text, location: { index: insertAt, tabId } } },
  ];
  const { paras } = parsed;
  for (const [k, p] of paras.entries()) {
    const startIndex = insertAt + p.start;
    const endIndex = startIndex + p.len + 1; // include the trailing newline
    const contentEnd = startIndex + p.len; // excludes the trailing newline
    if (p.style) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex, endIndex, tabId },
          paragraphStyle: { namedStyleType: p.style },
          fields: "namedStyleType",
        },
      });
    } else if (p.bullet) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex, endIndex, tabId },
          bulletPreset: BULLET_PRESET,
        },
      });
    } else if (p.numbered && !paras[k - 1]?.numbered) {
      let last = p;
      for (let next = paras[k + 1], j = k + 1; next?.numbered; next = paras[++j]) last = next;
      const runEnd = insertAt + last.start + last.len + 1;
      requests.push({
        createParagraphBullets: {
          range: { startIndex, endIndex: runEnd, tabId },
          bulletPreset: NUMBERED_PRESET,
        },
      });
    }
    // Fenced code line: monospace the run and shade the paragraph.
    if (p.code && p.len > 0) {
      requests.push({
        updateTextStyle: {
          range: { startIndex, endIndex: contentEnd, tabId },
          textStyle: { weightedFontFamily: { fontFamily: CODE_FONT } },
          fields: "weightedFontFamily",
        },
      });
      requests.push({
        updateParagraphStyle: {
          range: { startIndex, endIndex, tabId },
          paragraphStyle: { shading: { backgroundColor: CODE_BG } },
          fields: "shading.backgroundColor",
        },
      });
    }
    for (const span of p.spans ?? []) {
      const s = startIndex + span.start;
      const e = startIndex + span.end;
      if (e <= s) continue;
      requests.push({
        updateTextStyle: { range: { startIndex: s, endIndex: e, tabId }, ...spanStyle(span) },
      });
    }
  }
  return requests;
}

// Reflect inline styling back into markdown: a link wraps as `[text](url)`,
// bold in `**`, monospace in backticks, italic in `*`.
export function paragraphMarkdown(p: docs_v1.Schema$Paragraph): string {
  let out = "";
  for (const e of p.elements ?? []) {
    const stripped = (e.textRun?.content ?? "").replace(/\n$/, "");
    if (!stripped) continue;
    const style = e.textRun?.textStyle;
    if (style?.link?.url) {
      out += `[${stripped}](${style.link.url})`;
    } else if (style?.bold) {
      out += `**${stripped}**`;
    } else if (style?.weightedFontFamily?.fontFamily === CODE_FONT) {
      out += `\`${stripped}\``;
    } else if (style?.italic) {
      out += `*${stripped}*`;
    } else {
      out += stripped;
    }
  }
  return out;
}

// The markdown marker for a list paragraph: `1. `, `2. `, … for a numbered list
// (counted per list, in document order through `counters`), `- ` otherwise.
export function listMarkerFor(
  bullet: docs_v1.Schema$Bullet,
  lists: Record<string, docs_v1.Schema$List> | undefined,
  counters: Map<string, number>,
): string {
  const listId = bullet.listId ?? "";
  const level = bullet.nestingLevel ?? 0;
  const glyph = lists?.[listId]?.listProperties?.nestingLevels?.[level];
  const numbered =
    !!glyph?.glyphType &&
    glyph.glyphType !== "GLYPH_TYPE_UNSPECIFIED" &&
    glyph.glyphType !== "NONE";
  if (!numbered) return "- ";
  const key = `${listId}:${level}`;
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  return `${n}. `;
}
