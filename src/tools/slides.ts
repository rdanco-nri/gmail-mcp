/**
 * Slides tool registrars (v0.31).
 *
 * Two write tools backed by slides_v1 (and drive_v3 for file moves):
 *   - slides_create_deck_from_outline (presentations.create + batchUpdate)
 *   - slides_append_to_deck            (batchUpdate)
 *
 * Implementation notes (honest complexity from the plan):
 *
 * 1. We do NOT use `placeholderIdMappings` on `createSlide`. Empirically,
 *    Google's default theme exposes its TITLE/BODY placeholders only on
 *    the master, not on the layout — and `placeholderIdMappings`
 *    requires the placeholder to live on the layout itself, otherwise
 *    you get HTTP 400 "The placeholder is not on the page". This breaks
 *    the placeholderIdMappings pattern that the official docs describe
 *    as the standard way to populate placeholder text in one
 *    batchUpdate, because every freshly-created deck inherits placeholders
 *    transitively from the master.
 *
 *    Workaround: create the slides first (no mappings, no insertText),
 *    then GET the deck to discover each new slide's actual placeholder
 *    objectIds, then run a SECOND batchUpdate that inserts text into
 *    those discovered IDs. Three round trips per call (create + create-
 *    slides + get + insert-text), but reliable across themes.
 *
 * 2. All slides use `TITLE_AND_BODY` predefined layout. Theme styling
 *    (fonts, colors, positioning) is whatever the deck's theme provides
 *    — users who want a styled cover slide can re-style the first slide
 *    manually after open.
 *
 * 3. Speaker notes are received via `drive_read_file` on a Slides deck
 *    but not WRITTEN by the create/append tools in this first version.
 *    Out of scope.
 */

import { randomBytes } from "crypto";
import type { drive_v3, slides_v1 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import {
  SlidesCreateDeckFromOutlineSchema,
  SlidesAppendToDeckSchema,
} from "../tools.js";
import { asGmailApiError } from "../gmail-errors.js";

interface SlideOutlineInput {
  title: string;
  bullets?: string[];
  speakerNotes?: string;
}

function structuredError(message: string): {
  content: { type: string; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

// Slides object IDs must be 5-50 chars, alphanumeric/underscore/hyphen.
// 8-byte hex prefix (16 chars) per call keeps appended slides from
// colliding with prior IDs in the same deck.
function makeIdPrefix(): string {
  return randomBytes(8).toString("hex");
}

interface CreateSlideRequestArgs {
  slideObjectId: string;
  insertionIndex: number;
}

function buildCreateSlideRequest(args: CreateSlideRequestArgs): slides_v1.Schema$Request {
  return {
    createSlide: {
      objectId: args.slideObjectId,
      insertionIndex: args.insertionIndex,
      slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
    },
  };
}

interface DiscoveredPlaceholders {
  titleObjectId: string | null;
  bodyObjectId: string | null;
}

// Walk a slide's pageElements and return the title + body placeholder
// objectIds. The first matching placeholder of each kind wins; a
// well-formed TITLE_AND_BODY slide has exactly one of each.
function discoverPlaceholders(slide: slides_v1.Schema$Page): DiscoveredPlaceholders {
  let titleObjectId: string | null = null;
  let bodyObjectId: string | null = null;
  for (const el of slide.pageElements ?? []) {
    const type = el.shape?.placeholder?.type;
    const id = el.objectId ?? null;
    if (!type || !id) continue;
    if (!titleObjectId && (type === "TITLE" || type === "CENTERED_TITLE")) {
      titleObjectId = id;
    } else if (!bodyObjectId && type === "BODY") {
      bodyObjectId = id;
    }
  }
  return { titleObjectId, bodyObjectId };
}

interface PopulateArgs {
  outline: SlideOutlineInput;
  placeholders: DiscoveredPlaceholders;
}

function buildPopulateRequests(args: PopulateArgs): slides_v1.Schema$Request[] {
  const requests: slides_v1.Schema$Request[] = [];
  const { titleObjectId, bodyObjectId } = args.placeholders;
  if (titleObjectId && args.outline.title) {
    requests.push({
      insertText: {
        objectId: titleObjectId,
        text: args.outline.title,
        insertionIndex: 0,
      },
    });
  }
  const bullets = args.outline.bullets ?? [];
  if (bodyObjectId && bullets.length > 0) {
    const bodyText = bullets.join("\n");
    requests.push({
      insertText: {
        objectId: bodyObjectId,
        text: bodyText,
        insertionIndex: 0,
      },
    });
    requests.push({
      createParagraphBullets: {
        objectId: bodyObjectId,
        textRange: { type: "ALL" },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
  }
  return requests;
}

// Run the create-then-discover-then-populate flow common to both
// create_deck_from_outline and append_to_deck. Returns the slide
// objectIds (in the order the outlines were passed) and the discovered
// placeholder mapping per slide.
async function createAndPopulateSlides(
  slides: slides_v1.Slides,
  presentationId: string,
  outlines: SlideOutlineInput[],
  startIndex: number,
  prefix: string,
  defaultSlideObjectIdToDelete: string | null,
): Promise<{
  slideObjectIds: string[];
  populatedTitles: number;
  populatedBodies: number;
}> {
  // Phase A — create the slides (and delete the old default first slide
  // if the caller asked us to). No mappings, no text.
  const slideObjectIds: string[] = [];
  const phaseARequests: slides_v1.Schema$Request[] = [];
  for (let i = 0; i < outlines.length; i++) {
    const slideObjectId = `s_${prefix}_${i}`;
    slideObjectIds.push(slideObjectId);
    phaseARequests.push(
      buildCreateSlideRequest({ slideObjectId, insertionIndex: startIndex + i }),
    );
  }
  if (defaultSlideObjectIdToDelete) {
    phaseARequests.push({ deleteObject: { objectId: defaultSlideObjectIdToDelete } });
  }
  await slides.presentations.batchUpdate({
    presentationId,
    requestBody: { requests: phaseARequests },
  });

  // Phase B — get the deck back so we can discover the new slides'
  // placeholder objectIds. The previously-known objectIds for the new
  // slides are deterministic; their inner placeholder ids are not.
  const presResp = await slides.presentations.get({
    presentationId,
    fields: "slides(objectId,pageElements(objectId,shape(placeholder(type,index))))",
  });
  const slideById = new Map<string, slides_v1.Schema$Page>();
  for (const s of presResp.data.slides ?? []) {
    if (s.objectId) slideById.set(s.objectId, s);
  }

  // Phase C — for each new slide, build insertText + bullets requests
  // against the discovered placeholder ids.
  const phaseCRequests: slides_v1.Schema$Request[] = [];
  let populatedTitles = 0;
  let populatedBodies = 0;
  for (let i = 0; i < outlines.length; i++) {
    const slideObjectId = slideObjectIds[i] as string;
    const outline = outlines[i] as SlideOutlineInput;
    const slide = slideById.get(slideObjectId);
    if (!slide) continue;
    const placeholders = discoverPlaceholders(slide);
    const populate = buildPopulateRequests({ outline, placeholders });
    if (placeholders.titleObjectId && outline.title) populatedTitles += 1;
    if (placeholders.bodyObjectId && (outline.bullets ?? []).length > 0) populatedBodies += 1;
    phaseCRequests.push(...populate);
  }
  if (phaseCRequests.length > 0) {
    await slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: phaseCRequests },
    });
  }

  return { slideObjectIds, populatedTitles, populatedBodies };
}

export function registerSlidesTools(
  server: McpServer,
  drive: drive_v3.Drive,
  slides: slides_v1.Slides,
  authorizedScopes: readonly string[],
): void {
  // ---- slides_create_deck_from_outline ----
  const createMeta = pull("slides_create_deck_from_outline");
  defineTool(
    server,
    "slides_create_deck_from_outline",
    createMeta.description,
    SlidesCreateDeckFromOutlineSchema.shape,
    async (args) => {
      try {
        if (args.slides.length === 0) {
          return structuredError(
            "slides_create_deck_from_outline requires at least one slide in `slides`.",
          );
        }
        // Step 1 — create the empty deck with the requested title.
        const created = await slides.presentations.create({
          requestBody: { title: args.title },
        });
        const presentationId = created.data.presentationId;
        if (!presentationId) {
          return structuredError(
            "Slides create returned no presentationId — deck creation failed silently.",
          );
        }
        const defaultSlideObjectId = created.data.slides?.[0]?.objectId ?? null;
        const prefix = makeIdPrefix();

        // Step 2 — create + populate. Each new slide is inserted at
        // index i + 1 (after the default slide), then the default slide
        // is deleted in the same batchUpdate so the user-visible order
        // is exactly the outline order.
        const outlines = args.slides as SlideOutlineInput[];
        const { slideObjectIds, populatedTitles, populatedBodies } = await createAndPopulateSlides(
          slides,
          presentationId,
          outlines,
          1, // insertionIndex starts AFTER the default first slide
          prefix,
          defaultSlideObjectId,
        );

        // Step 3 (optional) — move into requested folder.
        if (args.parentFolderId) {
          const fileMeta = await drive.files.get({
            fileId: presentationId,
            fields: "parents",
            supportsAllDrives: true,
          });
          const currentParents = (fileMeta.data.parents ?? []).join(",");
          await drive.files.update({
            fileId: presentationId,
            addParents: args.parentFolderId,
            removeParents: currentParents || undefined,
            fields: "id,parents",
            supportsAllDrives: true,
          });
        }

        const result = {
          status: "created" as const,
          presentationId,
          title: args.title,
          slideCount: args.slides.length,
          slideObjectIds,
          populatedTitles,
          populatedBodies,
          parentFolderId: args.parentFolderId ?? null,
          webViewLink: `https://docs.google.com/presentation/d/${presentationId}/edit`,
        };
        return {
          content: [
            {
              type: "text",
              text: `Slides deck "${args.title}" created with ${args.slides.length} slide${args.slides.length === 1 ? "" : "s"} (${populatedTitles} titles, ${populatedBodies} bullet groups populated).\nID: ${presentationId}\nLink: ${result.webViewLink}`,
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 403)
          return structuredError(
            `Insufficient permissions to create a Slides deck: ${message}. The Slides API needs the 'presentations' scope; folder placement also needs 'drive'.`,
          );
        const prefix =
          code !== undefined
            ? `slides_create_deck_from_outline failed (HTTP ${code})`
            : "slides_create_deck_from_outline failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    createMeta.annotations,
    createMeta.scopes,
    authorizedScopes,
  );

  // ---- slides_append_to_deck ----
  const appendMeta = pull("slides_append_to_deck");
  defineTool(
    server,
    "slides_append_to_deck",
    appendMeta.description,
    SlidesAppendToDeckSchema.shape,
    async (args) => {
      try {
        if (args.slides.length === 0) {
          return structuredError(
            "slides_append_to_deck requires at least one slide in `slides`.",
          );
        }
        // Discover current slide count so insertionIndex appends at end.
        const presResp = await slides.presentations.get({
          presentationId: args.presentationId,
          fields: "slides.objectId",
        });
        const startIndex = (presResp.data.slides ?? []).length;
        const prefix = makeIdPrefix();
        const outlines = args.slides as SlideOutlineInput[];

        const { slideObjectIds, populatedTitles, populatedBodies } = await createAndPopulateSlides(
          slides,
          args.presentationId,
          outlines,
          startIndex,
          prefix,
          null, // append-only — never delete an existing slide
        );

        const result = {
          status: "appended" as const,
          presentationId: args.presentationId,
          appendedCount: args.slides.length,
          slideObjectIds,
          populatedTitles,
          populatedBodies,
          insertedAtIndex: startIndex,
          webViewLink: `https://docs.google.com/presentation/d/${args.presentationId}/edit`,
        };
        return {
          content: [
            {
              type: "text",
              text: `Appended ${args.slides.length} slide${args.slides.length === 1 ? "" : "s"} to deck ${args.presentationId} (starting at index ${startIndex}; ${populatedTitles} titles, ${populatedBodies} bullet groups populated).\nLink: ${result.webViewLink}`,
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 404) return structuredError(`Presentation not found: ${message}`);
        if (code === 403)
          return structuredError(`Insufficient permissions on this deck: ${message}`);
        const prefix =
          code !== undefined
            ? `slides_append_to_deck failed (HTTP ${code})`
            : "slides_append_to_deck failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    appendMeta.annotations,
    appendMeta.scopes,
    authorizedScopes,
  );
}
