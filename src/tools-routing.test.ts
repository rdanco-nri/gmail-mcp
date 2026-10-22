import { describe, it, expect } from "vitest";
import { toolDefinitions } from "./tools.js";

// The descriptions are what a model reads when it picks a tool, so they carry the routing.
function section(name: string, label: "USE WHEN" | "DO NOT USE"): string {
  const t = toolDefinitions.find((d) => d.name === name);
  expect(t).toBeDefined();
  const line = t!.description.split("\n").find((l) => l.startsWith(`${label}:`));
  expect(line).toBeDefined();
  return line!;
}

describe("tool descriptions route docs and decks to the native builders", () => {
  it("drive_upload_file sends a doc written from text to the Docs tools", () => {
    const doNot = section("drive_upload_file", "DO NOT USE");
    expect(doNot).toMatch(/\.docx/);
    expect(doNot).toMatch(/docs_create_release_doc/);
    expect(section("drive_upload_file", "USE WHEN")).not.toMatch(/deck, doc, or sheet/);
  });

  it("docs_create_release_doc covers any new doc and names single-tab use", () => {
    const use = section("docs_create_release_doc", "USE WHEN");
    expect(use).toMatch(/any new Google Doc/);
    expect(use).toMatch(/tabTitles/);
  });

  it("slides_create_deck_from_outline is for unbranded decks only", () => {
    expect(section("slides_create_deck_from_outline", "USE WHEN")).toMatch(/unbranded/);
    expect(section("slides_create_deck_from_outline", "DO NOT USE")).toMatch(/drive_upload_file/);
  });

  it("slides_append_to_deck no longer points every new deck at the outline tool", () => {
    expect(section("slides_append_to_deck", "DO NOT USE")).toMatch(/drive_upload_file/);
  });
});
