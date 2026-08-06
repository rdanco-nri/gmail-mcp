/**
 * Tests for the calendar slot math. The Google-facing handlers are
 * thin (call the API, map fields); the logic worth pinning is the
 * zone-aware working-hours arithmetic underneath, which is pure.
 *
 * Fixed dates on purpose: 2026-07-29 is a Wednesday in US Pacific
 * daylight time (UTC-7) and 2026-01-14 is a Wednesday in standard
 * time (UTC-8), so the pair covers both sides of a DST boundary
 * without depending on when the suite runs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import {
  mergeIntervals,
  subtractIntervals,
  zonedWallTimeToUtc,
  wallPartsInZone,
  computeFreeSlots,
  formatSlotLabel,
  resolveBoundary,
} from "./calendar.js";

const LA = "America/Los_Angeles";
const ms = (iso: string) => new Date(iso).getTime();

describe("zonedWallTimeToUtc", () => {
  it("resolves a summer wall time at the daylight offset (UTC-7)", () => {
    expect(zonedWallTimeToUtc(2026, 7, 29, 9, 0, LA).toISOString()).toBe(
      "2026-07-29T16:00:00.000Z",
    );
  });

  it("resolves a winter wall time at the standard offset (UTC-8)", () => {
    expect(zonedWallTimeToUtc(2026, 1, 14, 9, 0, LA).toISOString()).toBe(
      "2026-01-14T17:00:00.000Z",
    );
  });

  it("round-trips through wallPartsInZone", () => {
    const instant = zonedWallTimeToUtc(2026, 7, 29, 14, 30, LA);
    const parts = wallPartsInZone(instant, LA);
    expect([parts.year, parts.month, parts.day, parts.hour, parts.minute]).toEqual([
      2026, 7, 29, 14, 30,
    ]);
    expect(parts.weekday).toBe("Wed");
  });

  it("rolls a day-overflow forward into the next month", () => {
    // Day 32 of July is 1 August — relied on by the workdayEndHour=24 path.
    expect(zonedWallTimeToUtc(2026, 7, 32, 0, 0, LA).toISOString()).toBe(
      "2026-08-01T07:00:00.000Z",
    );
  });
});

describe("mergeIntervals", () => {
  it("merges overlapping and touching blocks, leaves gaps alone", () => {
    const merged = mergeIntervals([
      { start: 30, end: 40 },
      { start: 0, end: 10 },
      { start: 5, end: 20 },
      { start: 20, end: 25 },
    ]);
    expect(merged).toEqual([
      { start: 0, end: 25 },
      { start: 30, end: 40 },
    ]);
  });

  it("drops zero-length and inverted blocks", () => {
    expect(
      mergeIntervals([
        { start: 5, end: 5 },
        { start: 10, end: 3 },
      ]),
    ).toEqual([]);
  });

  it("collapses a block fully contained in another", () => {
    expect(
      mergeIntervals([
        { start: 0, end: 100 },
        { start: 20, end: 30 },
      ]),
    ).toEqual([{ start: 0, end: 100 }]);
  });
});

describe("subtractIntervals", () => {
  const window = { start: 0, end: 100 };

  it("splits the window around a busy block", () => {
    expect(subtractIntervals(window, [{ start: 40, end: 60 }])).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
  });

  it("returns nothing when the window is fully covered", () => {
    expect(subtractIntervals(window, [{ start: -10, end: 200 }])).toEqual([]);
  });

  it("clips busy blocks that straddle the edges", () => {
    expect(
      subtractIntervals(window, [
        { start: -50, end: 20 },
        { start: 80, end: 300 },
      ]),
    ).toEqual([{ start: 20, end: 80 }]);
  });

  it("ignores busy blocks entirely outside the window", () => {
    expect(subtractIntervals(window, [{ start: 200, end: 300 }])).toEqual([window]);
  });
});

describe("computeFreeSlots", () => {
  const base = {
    timeZone: LA,
    workdayStartHour: 9,
    workdayEndHour: 17,
    durationMinutes: 30,
    includeWeekends: false,
    maxSlots: 20,
  };

  it("subtracts meetings from a single working day", () => {
    const slots = computeFreeSlots({
      ...base,
      timeMin: new Date("2026-07-29T00:00:00-07:00"),
      timeMax: new Date("2026-07-30T00:00:00-07:00"),
      // 10:00-11:00 and 14:00-15:00 Pacific
      busy: [
        { start: ms("2026-07-29T17:00:00Z"), end: ms("2026-07-29T18:00:00Z") },
        { start: ms("2026-07-29T21:00:00Z"), end: ms("2026-07-29T22:00:00Z") },
      ],
    });
    expect(slots.map((s) => formatSlotLabel(s, LA))).toEqual([
      "Wed Jul 29, 9:00 AM - 10:00 AM PDT",
      "Wed Jul 29, 11:00 AM - 2:00 PM PDT",
      "Wed Jul 29, 3:00 PM - 5:00 PM PDT",
    ]);
  });

  it("never offers time outside working hours", () => {
    const slots = computeFreeSlots({
      ...base,
      timeMin: new Date("2026-07-29T00:00:00-07:00"),
      timeMax: new Date("2026-07-30T00:00:00-07:00"),
      busy: [],
    });
    expect(slots).toHaveLength(1);
    expect(formatSlotLabel(slots[0], LA)).toBe("Wed Jul 29, 9:00 AM - 5:00 PM PDT");
  });

  it("skips weekends unless asked", () => {
    // Fri 2026-07-31 through Mon 2026-08-03.
    const window = {
      timeMin: new Date("2026-07-31T00:00:00-07:00"),
      timeMax: new Date("2026-08-04T00:00:00-07:00"),
      busy: [],
    };
    const weekdaysOnly = computeFreeSlots({ ...base, ...window });
    expect(weekdaysOnly.map((s) => formatSlotLabel(s, LA))).toEqual([
      "Fri Jul 31, 9:00 AM - 5:00 PM PDT",
      "Mon Aug 3, 9:00 AM - 5:00 PM PDT",
    ]);

    const withWeekend = computeFreeSlots({ ...base, ...window, includeWeekends: true });
    expect(withWeekend).toHaveLength(4);
  });

  it("drops gaps shorter than the requested duration", () => {
    const slots = computeFreeSlots({
      ...base,
      durationMinutes: 60,
      timeMin: new Date("2026-07-29T00:00:00-07:00"),
      timeMax: new Date("2026-07-30T00:00:00-07:00"),
      // Leaves a 30-min gap 9:00-9:30, then a 7h block after 10:00.
      busy: [{ start: ms("2026-07-29T16:30:00Z"), end: ms("2026-07-29T17:00:00Z") }],
    });
    expect(slots.map((s) => formatSlotLabel(s, LA))).toEqual([
      "Wed Jul 29, 10:00 AM - 5:00 PM PDT",
    ]);
  });

  it("clips the first day to timeMin rather than starting at 9am", () => {
    const slots = computeFreeSlots({
      ...base,
      timeMin: new Date("2026-07-29T13:00:00-07:00"),
      timeMax: new Date("2026-07-30T00:00:00-07:00"),
      busy: [],
    });
    expect(formatSlotLabel(slots[0], LA)).toBe("Wed Jul 29, 1:00 PM - 5:00 PM PDT");
  });

  it("holds working hours at 9am local across a DST change", () => {
    // Window spans the 2026-11-01 fall-back: both days must start 9am
    // local even though their UTC offsets differ (-7 then -8).
    const slots = computeFreeSlots({
      ...base,
      timeMin: new Date("2026-10-30T00:00:00-07:00"),
      timeMax: new Date("2026-11-04T00:00:00-08:00"),
      busy: [],
    });
    const labels = slots.map((s) => formatSlotLabel(s, LA));
    expect(labels).toContain("Fri Oct 30, 9:00 AM - 5:00 PM PDT");
    expect(labels).toContain("Mon Nov 2, 9:00 AM - 5:00 PM PST");
  });

  it("honours maxSlots, earliest first", () => {
    const slots = computeFreeSlots({
      ...base,
      maxSlots: 2,
      timeMin: new Date("2026-07-29T00:00:00-07:00"),
      timeMax: new Date("2026-08-07T00:00:00-07:00"),
      busy: [],
    });
    expect(slots).toHaveLength(2);
    expect(formatSlotLabel(slots[0], LA)).toBe("Wed Jul 29, 9:00 AM - 5:00 PM PDT");
    expect(slots[0].start).toBeLessThan(slots[1].start);
  });

  it("treats an all-hours workday (0-24) as the full local day", () => {
    const slots = computeFreeSlots({
      ...base,
      workdayStartHour: 0,
      workdayEndHour: 24,
      timeMin: new Date("2026-07-29T00:00:00-07:00"),
      timeMax: new Date("2026-07-30T00:00:00-07:00"),
      busy: [],
    });
    expect(slots).toHaveLength(1);
    expect(slots[0].end - slots[0].start).toBe(24 * 60 * 60 * 1000);
  });
});

/**
 * End-to-end over the real MCP round-trip (Client → SDK → defineTool →
 * handler → mock Calendar client), mirroring `registrars.test.ts`.
 * Rate limiting is disabled rather than sandboxed per-test: none of
 * these assertions concern the limiter, and the ledger is shared state.
 */
interface MockData {
  freebusy?: unknown;
  events?: unknown;
  /** Throw this instead of returning, to exercise the error branches. */
  throws?: Error;
}

function mockCalendar(data: MockData) {
  const calls: { method: string; params: unknown }[] = [];
  const client = {
    events: {
      list: async (params: unknown) => {
        calls.push({ method: "events.list", params });
        if (data.throws) throw data.throws;
        return { data: data.events ?? { items: [] } };
      },
    },
    freebusy: {
      query: async (params: unknown) => {
        calls.push({ method: "freebusy.query", params });
        if (data.throws) throw data.throws;
        return { data: data.freebusy ?? { calendars: {} } };
      },
    },
  };
  return { calls, client };
}

function apiError(code: number, message: string): Error {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

async function connect(scopes: string[], data: MockData = {}) {
  const { calls, client: calendar } = mockCalendar(data);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const server = createServer({ calendar, authorizedScopes: scopes } as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "calendar-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    calls,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

describe("calendar tool registration", () => {
  const original = process.env.GMAIL_MCP_RATE_LIMIT_DISABLE;
  beforeEach(() => {
    process.env.GMAIL_MCP_RATE_LIMIT_DISABLE = "1";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.GMAIL_MCP_RATE_LIMIT_DISABLE;
    else process.env.GMAIL_MCP_RATE_LIMIT_DISABLE = original;
  });

  it("advertises both tools on a calendar.readonly token", async () => {
    const fix = await connect(["calendar.readonly"]);
    const names = (await fix.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("calendar_list_events");
    expect(names).toContain("calendar_find_free_slots");
    await fix.close();
  });

  it("advertises only the freeBusy tool on a calendar.freebusy token", async () => {
    const fix = await connect(["calendar.freebusy"]);
    const names = (await fix.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("calendar_find_free_slots");
    expect(names).not.toContain("calendar_list_events");
    await fix.close();
  });

  it("hides both on a token with no calendar scope", async () => {
    const fix = await connect(["gmail.modify"]);
    const names = (await fix.client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("calendar_"))).toEqual([]);
    await fix.close();
  });
});

describe("calendar_find_free_slots handler", () => {
  const original = process.env.GMAIL_MCP_RATE_LIMIT_DISABLE;
  beforeEach(() => {
    process.env.GMAIL_MCP_RATE_LIMIT_DISABLE = "1";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.GMAIL_MCP_RATE_LIMIT_DISABLE;
    else process.env.GMAIL_MCP_RATE_LIMIT_DISABLE = original;
  });

  it("intersects busy blocks across two attendees", async () => {
    const fix = await connect(["calendar.readonly"], {
      freebusy: {
        calendars: {
          primary: { busy: [{ start: "2026-07-29T16:00:00Z", end: "2026-07-29T18:00:00Z" }] },
          "coworker@newtonresearch.ai": {
            busy: [{ start: "2026-07-29T20:00:00Z", end: "2026-07-30T00:00:00Z" }],
          },
        },
      },
    });
    const res = await fix.client.callTool({
      name: "calendar_find_free_slots",
      arguments: {
        attendees: ["primary", "coworker@newtonresearch.ai"],
        timeMin: "2026-07-29",
        timeMax: "2026-07-30",
        durationMinutes: 30,
      },
    });
    const out = res.structuredContent as {
      slots: { label: string }[];
      partial: boolean;
      calendarsQueried: string[];
    };
    // Rob busy 9-11, coworker busy 1-5 → the only shared gap is 11-1.
    expect(out.slots.map((s) => s.label)).toEqual(["Wed Jul 29, 11:00 AM - 1:00 PM PDT"]);
    expect(out.partial).toBe(false);
    expect(out.calendarsQueried).toHaveLength(2);
    await fix.close();
  });

  it("excludes an unreadable calendar and flags the result partial", async () => {
    const fix = await connect(["calendar.readonly"], {
      freebusy: {
        calendars: {
          primary: { busy: [] },
          "stranger@example.com": { errors: [{ reason: "notFound" }] },
        },
      },
    });
    const res = await fix.client.callTool({
      name: "calendar_find_free_slots",
      arguments: {
        attendees: ["primary", "stranger@example.com"],
        timeMin: "2026-07-29",
        timeMax: "2026-07-30",
      },
    });
    const out = res.structuredContent as {
      partial: boolean;
      calendarsQueried: string[];
      calendarErrors: { calendarId: string; reason: string }[];
    };
    expect(out.partial).toBe(true);
    expect(out.calendarsQueried).toEqual(["primary"]);
    expect(out.calendarErrors).toEqual([
      { calendarId: "stranger@example.com", reason: "notFound" },
    ]);
    // The warning has to reach the text channel too — an agent that
    // reads only `content` must still see that a calendar was skipped.
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("WARNING");
    expect(text).toContain("stranger@example.com");
    await fix.close();
  });

  it("errors rather than inventing availability when no calendar is readable", async () => {
    const fix = await connect(["calendar.readonly"], {
      freebusy: { calendars: { "stranger@example.com": { errors: [{ reason: "notFound" }] } } },
    });
    const res = await fix.client.callTool({
      name: "calendar_find_free_slots",
      arguments: {
        attendees: ["stranger@example.com"],
        timeMin: "2026-07-29",
        timeMax: "2026-07-30",
      },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain(
      "None of the requested calendars",
    );
    await fix.close();
  });

  it("blames the disabled Cloud API, not the token, on a SERVICE_DISABLED 403", async () => {
    // The live failure this pins: a token that DOES carry
    // calendar.readonly still 403s when the project has the Calendar
    // API switched off. Pointing that at "you need the scope" sends the
    // reader back to `auth` forever.
    const fix = await connect(["calendar.readonly"], {
      throws: apiError(
        403,
        "Google Calendar API has not been used in project 12345 before or it is disabled.",
      ),
    });
    const res = await fix.client.callTool({
      name: "calendar_find_free_slots",
      arguments: { timeMin: "2026-07-29", timeMax: "2026-07-30" },
    });
    const text = (res.content as { text: string }[])[0].text;
    expect(res.isError).toBe(true);
    expect(text).toContain("Google Cloud Console");
    expect(text).toContain("will not change it");
    expect(text).not.toContain("The token needs");
    await fix.close();
  });

  it("still blames the scope on a non-SERVICE_DISABLED 403", async () => {
    const fix = await connect(["calendar.readonly"], {
      throws: apiError(403, "Request had insufficient authentication scopes."),
    });
    const res = await fix.client.callTool({
      name: "calendar_find_free_slots",
      arguments: { timeMin: "2026-07-29", timeMax: "2026-07-30" },
    });
    const text = (res.content as { text: string }[])[0].text;
    expect(res.isError).toBe(true);
    expect(text).toContain("calendar.freebusy or calendar.readonly scope");
    expect(text).not.toContain("Google Cloud Console");
    await fix.close();
  });

  it("rejects a workday window that ends before it starts", async () => {
    const fix = await connect(["calendar.readonly"]);
    const res = await fix.client.callTool({
      name: "calendar_find_free_slots",
      arguments: {
        timeMin: "2026-07-29",
        timeMax: "2026-07-30",
        workdayStartHour: 17,
        workdayEndHour: 9,
      },
    });
    expect(res.isError).toBe(true);
    await fix.close();
  });
});

describe("resolveBoundary", () => {
  it("reads a bare date as local midnight when given a zone", () => {
    expect(resolveBoundary("2026-07-29", LA).toISOString()).toBe("2026-07-29T07:00:00.000Z");
  });

  it("reads a bare date as UTC midnight when given no zone", () => {
    expect(resolveBoundary("2026-07-29", null).toISOString()).toBe("2026-07-29T00:00:00.000Z");
  });

  it("passes an explicit instant through untouched", () => {
    expect(resolveBoundary("2026-07-29T09:30:00-07:00", LA).toISOString()).toBe(
      "2026-07-29T16:30:00.000Z",
    );
  });
});
