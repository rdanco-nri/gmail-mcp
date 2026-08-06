/**
 * Calendar tool registrar (v0.35). Two read-only tools backed by
 * calendar_v3:
 *
 *   - `calendar_list_events`     — what is ON a calendar (events.list)
 *   - `calendar_find_free_slots` — when a set of people are all open
 *                                  (freebusy.query + local slot math)
 *
 * Why two tools and not one: `events.list` needs full read access to
 * the target calendar, which coworkers rarely grant. `freebusy.query`
 * needs only free/busy sharing, which is the Workspace default inside
 * a domain. Splitting them means the cross-person case (the whole
 * point of the second tool) keeps working even where the first 403s.
 *
 * The slot math lives here rather than in the handler because it is
 * the only non-trivial logic in the file and is worth testing without
 * a Google client — see `calendar.test.ts`. Everything below the
 * registrar is pure and exported for that reason.
 *
 * TIME ZONES. Google returns busy blocks as absolute RFC3339 instants,
 * but "working hours" are wall-clock in somebody's zone, so the two
 * have to be reconciled. We do that with the runtime's own IANA
 * database via `Intl.DateTimeFormat` (no date library): read the wall
 * time an instant shows in a zone, and invert that to turn a wall time
 * back into an instant. The inversion is a two-pass fixpoint, which is
 * exact everywhere except inside a DST spring-forward gap — a wall
 * time that does not exist (2:30am on a US spring-forward Sunday)
 * resolves to the instant just after the jump. Working hours never
 * start at 2:30am, so this does not bite in practice.
 */

import type { calendar_v3 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, pullToolMeta as pull } from "./_shared.js";
import { CalendarListEventsSchema, CalendarFindFreeSlotsSchema } from "../tools.js";
import { asGmailApiError } from "../gmail-errors.js";

function structuredError(message: string): {
  content: { type: string; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * A 403 from Calendar means one of two things whose remedies do not
 * overlap: the Cloud project has the Calendar API switched off (no
 * token change fixes it), or the token really is missing the scope.
 * Google reports the first with a "has not been used in project" /
 * "is disabled" message. Branching on that matters — sending a
 * disabled-API failure to a "you need the calendar scope" hint sends
 * the reader to re-run `auth` forever while the actual cause sits in
 * the Cloud Console.
 */
function isServiceDisabled(message: string): boolean {
  return /has not been used in project|is disabled/i.test(message);
}

// Phrased as something the account owner does, not as an instruction to
// whatever agent reads this error: enabling a Google Cloud API is a
// console action outside this process, and an agent that treats it as a
// command to execute will flail.
const SERVICE_DISABLED_HINT =
  "This is a project-level setting rather than a token problem, so re-running `auth` will not change it. The Google Calendar API has to be switched on for this OAuth project in the Google Cloud Console by the account owner before any calendar_* tool can work, and it takes a few minutes to propagate.";

/** A half-open time range in epoch milliseconds: [start, end). */
export interface Interval {
  start: number;
  end: number;
}

/** The wall-clock reading an instant shows in a given IANA zone. */
export function wallPartsInZone(
  instant: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
} {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // Some ICU builds render midnight as "24" under hour12:false.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: p.weekday ?? "",
  };
}

/** Milliseconds a zone is ahead of UTC at a given instant. */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const w = wallPartsInZone(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - instant.getTime();
}

/**
 * Invert `wallPartsInZone`: given a wall-clock time in a zone, return
 * the absolute instant. Two passes because the offset depends on the
 * very instant being solved for — the first guess can land on the far
 * side of a DST transition, and re-reading the offset there converges.
 * Day/month overflow is intentional and relied upon by the day walker
 * (`day + 1` past the end of a month rolls forward via Date.UTC).
 */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = naive - tzOffsetMs(new Date(naive), timeZone);
  const settled = naive - tzOffsetMs(new Date(firstGuess), timeZone);
  return new Date(settled);
}

/** Collapse overlapping/adjacent busy blocks into a sorted disjoint set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

/**
 * Everything inside `window` not covered by `busy`. `busy` must already
 * be merged and sorted (mergeIntervals output).
 */
export function subtractIntervals(window: Interval, busy: Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = window.start;
  for (const b of busy) {
    if (b.end <= window.start) continue;
    if (b.start >= window.end) break;
    if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, window.end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free.filter((f) => f.end > f.start);
}

/**
 * Walk each calendar day in the target zone, clip it to working hours
 * and to the requested window, subtract busy time, and keep the gaps
 * long enough to hold a meeting.
 */
export function computeFreeSlots(opts: {
  timeMin: Date;
  timeMax: Date;
  busy: Interval[];
  timeZone: string;
  workdayStartHour: number;
  workdayEndHour: number;
  durationMinutes: number;
  includeWeekends: boolean;
  maxSlots: number;
}): Interval[] {
  const merged = mergeIntervals(opts.busy);
  const minMs = opts.durationMinutes * 60_000;
  const slots: Interval[] = [];
  const DAY_MS = 24 * 60 * 60 * 1000;

  let probe = new Date(opts.timeMin.getTime());
  // Bound the walk independently of the window so a caller passing a
  // decade cannot spin here; 400 days covers every realistic scheduling
  // horizon and the loop also breaks on timeMax below.
  for (let i = 0; i < 400; i++) {
    const w = wallPartsInZone(probe, opts.timeZone);
    const dayStart = zonedWallTimeToUtc(
      w.year,
      w.month,
      w.day,
      opts.workdayStartHour,
      0,
      opts.timeZone,
    );
    // hour 24 means midnight ending this day, not midnight starting it.
    const dayEnd =
      opts.workdayEndHour >= 24
        ? zonedWallTimeToUtc(w.year, w.month, w.day + 1, 0, 0, opts.timeZone)
        : zonedWallTimeToUtc(w.year, w.month, w.day, opts.workdayEndHour, 0, opts.timeZone);

    if (dayStart.getTime() >= opts.timeMax.getTime()) break;

    const isWeekend = w.weekday === "Sat" || w.weekday === "Sun";
    if (opts.includeWeekends || !isWeekend) {
      const window: Interval = {
        start: Math.max(dayStart.getTime(), opts.timeMin.getTime()),
        end: Math.min(dayEnd.getTime(), opts.timeMax.getTime()),
      };
      if (window.end > window.start) {
        for (const f of subtractIntervals(window, merged)) {
          if (f.end - f.start >= minMs) slots.push(f);
        }
      }
    }

    // Advance one local day. Stepping from local noon (rather than from
    // `probe` + 24h) keeps a DST day from landing back on itself or
    // skipping a date.
    const noon = zonedWallTimeToUtc(w.year, w.month, w.day, 12, 0, opts.timeZone);
    probe = new Date(noon.getTime() + DAY_MS);
  }

  slots.sort((a, b) => a.start - b.start);
  return slots.slice(0, opts.maxSlots);
}

/** "Wed Jul 29, 9:00 AM - 10:30 AM PDT" */
export function formatSlotLabel(slot: Interval, timeZone: string): string {
  // Weekday and date are formatted separately: asking Intl for all
  // three at once yields "Wed, Jul 29", and the trailing comma collides
  // with the one before the time range ("Wed, Jul 29, 9:00 AM").
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
  const monthDay = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  });
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const zoneName =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(new Date(slot.start))
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  return `${weekday.format(start)} ${monthDay.format(start)}, ${time.format(start)} - ${time.format(end)} ${zoneName}`.trim();
}

/**
 * Widen a bare `YYYY-MM-DD` to an instant. `zone` picks the reference
 * frame: the availability tool resolves a bare date to local midnight
 * in the caller's working zone (so "2026-07-29" means that person's
 * Wednesday), while the events tool has no working zone and uses UTC.
 * A value that already carries a time is returned as-is.
 */
export function resolveBoundary(value: string, zone: string | null): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value);
  if (!zone) return new Date(`${value}T00:00:00Z`);
  const parts = value.split("-");
  return zonedWallTimeToUtc(Number(parts[0]), Number(parts[1]), Number(parts[2]), 0, 0, zone);
}

/** Google returns all-day events as `date`, timed ones as `dateTime`. */
function eventEdge(edge: calendar_v3.Schema$EventDateTime | undefined): {
  iso: string | null;
  allDay: boolean;
} {
  if (!edge) return { iso: null, allDay: false };
  if (edge.dateTime) return { iso: edge.dateTime, allDay: false };
  if (edge.date) return { iso: edge.date, allDay: true };
  return { iso: null, allDay: false };
}

export function registerCalendarTools(
  server: McpServer,
  calendar: calendar_v3.Calendar,
  authorizedScopes: readonly string[],
): void {
  // ---- calendar_list_events ----
  const listMeta = pull("calendar_list_events");
  defineTool(
    server,
    "calendar_list_events",
    listMeta.description,
    CalendarListEventsSchema.shape,
    async (args) => {
      try {
        const timeMin = resolveBoundary(args.timeMin, null);
        const timeMax = resolveBoundary(args.timeMax, null);
        if (timeMax.getTime() <= timeMin.getTime()) {
          return structuredError(
            `timeMax (${args.timeMax}) must be after timeMin (${args.timeMin}). A bare date resolves to 00:00:00Z, so a single-day window needs the NEXT day as timeMax.`,
          );
        }

        const res = await calendar.events.list({
          calendarId: args.calendarId,
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          q: args.query,
          maxResults: args.maxResults,
          // Expand recurrences into occurrences; orderBy=startTime is
          // only legal alongside singleEvents.
          singleEvents: true,
          orderBy: "startTime",
          timeZone: args.timeZone,
        });

        const events = (res.data.items ?? [])
          .filter((e) => e.status !== "cancelled")
          .map((e) => {
            const start = eventEdge(e.start ?? undefined);
            const end = eventEdge(e.end ?? undefined);
            return {
              id: e.id ?? null,
              summary: e.summary ?? "(no title)",
              start: start.iso,
              end: end.iso,
              allDay: start.allDay,
              location: e.location ?? null,
              organizer: e.organizer?.email ?? null,
              attendees: (e.attendees ?? []).map((a) => ({
                email: a.email ?? null,
                responseStatus: a.responseStatus ?? null,
                optional: a.optional ?? false,
              })),
              conferenceLink: e.hangoutLink ?? null,
              htmlLink: e.htmlLink ?? null,
              status: e.status ?? null,
            };
          });

        const zone = args.timeZone ?? res.data.timeZone ?? "UTC";
        const lines = events.map((e) => {
          if (e.allDay || !e.start) return `  ${e.start ?? "?"} (all day) — ${e.summary}`;
          const slot = {
            start: new Date(e.start).getTime(),
            end: new Date(e.end ?? e.start).getTime(),
          };
          return `  ${formatSlotLabel(slot, zone)} — ${e.summary}`;
        });

        const result = {
          calendarId: args.calendarId,
          timeZone: zone,
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          eventCount: events.length,
          events,
        };
        return {
          content: [
            {
              type: "text",
              text:
                events.length === 0
                  ? `No events on ${args.calendarId} between ${args.timeMin} and ${args.timeMax}.`
                  : `${events.length} event(s) on ${args.calendarId} (${zone}):\n${lines.join("\n")}`,
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 404)
          return structuredError(
            `Calendar not found: ${args.calendarId}. ${message}. If this is a coworker, their calendar is likely not shared with full read access — calendar_find_free_slots works with free/busy sharing alone.`,
          );
        if (code === 403)
          return structuredError(
            isServiceDisabled(message)
              ? `calendar_list_events cannot run: ${message} ${SERVICE_DISABLED_HINT}`
              : `Not permitted to read ${args.calendarId}: ${message}. Free/busy-only sharing is enough for calendar_find_free_slots but not for reading event details.`,
          );
        const prefix =
          code !== undefined
            ? `calendar_list_events failed (HTTP ${code})`
            : "calendar_list_events failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    listMeta.annotations,
    listMeta.scopes,
    authorizedScopes,
  );

  // ---- calendar_find_free_slots ----
  const slotsMeta = pull("calendar_find_free_slots");
  defineTool(
    server,
    "calendar_find_free_slots",
    slotsMeta.description,
    CalendarFindFreeSlotsSchema.shape,
    async (args) => {
      try {
        const zone = args.timeZone;
        if (args.workdayEndHour <= args.workdayStartHour) {
          return structuredError(
            `workdayEndHour (${args.workdayEndHour}) must be greater than workdayStartHour (${args.workdayStartHour}).`,
          );
        }
        const timeMin = resolveBoundary(args.timeMin, zone);
        const timeMax = resolveBoundary(args.timeMax, zone);
        if (timeMax.getTime() <= timeMin.getTime()) {
          return structuredError(
            `timeMax (${args.timeMax}) must be after timeMin (${args.timeMin}).`,
          );
        }

        const requested = args.attendees?.length ? args.attendees : ["primary"];
        const res = await calendar.freebusy.query({
          requestBody: {
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            timeZone: zone,
            items: requested.map((id) => ({ id })),
          },
        });

        // A calendar we cannot see comes back with an `errors` array and
        // an empty `busy`. Treating that as "free all week" is the one
        // failure mode that silently produces a wrong answer, so those
        // calendars are pulled out of the intersection and reported.
        const calendars = res.data.calendars ?? {};
        const busy: Interval[] = [];
        const calendarsQueried: string[] = [];
        const calendarErrors: { calendarId: string; reason: string }[] = [];
        for (const id of requested) {
          const entry = calendars[id];
          if (!entry) {
            calendarErrors.push({ calendarId: id, reason: "no response from Calendar API" });
            continue;
          }
          if (entry.errors?.length) {
            calendarErrors.push({
              calendarId: id,
              reason: entry.errors.map((e) => e.reason ?? "unknown").join(", "),
            });
            continue;
          }
          calendarsQueried.push(id);
          for (const b of entry.busy ?? []) {
            if (!b.start || !b.end) continue;
            busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
          }
        }

        if (calendarsQueried.length === 0) {
          return structuredError(
            `None of the requested calendars could be queried: ${calendarErrors
              .map((e) => `${e.calendarId} (${e.reason})`)
              .join("; ")}. No availability can be inferred from this.`,
          );
        }

        const slots = computeFreeSlots({
          timeMin,
          timeMax,
          busy,
          timeZone: zone,
          workdayStartHour: args.workdayStartHour,
          workdayEndHour: args.workdayEndHour,
          durationMinutes: args.durationMinutes,
          includeWeekends: args.includeWeekends,
          maxSlots: args.maxSlots,
        });

        const rendered = slots.map((s) => ({
          start: new Date(s.start).toISOString(),
          end: new Date(s.end).toISOString(),
          durationMinutes: Math.round((s.end - s.start) / 60_000),
          label: formatSlotLabel(s, zone),
        }));

        const result = {
          timeZone: zone,
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          durationMinutes: args.durationMinutes,
          workingHours: `${args.workdayStartHour}:00-${args.workdayEndHour}:00`,
          calendarsQueried,
          calendarErrors,
          partial: calendarErrors.length > 0,
          slotCount: rendered.length,
          slots: rendered,
        };

        const header =
          rendered.length === 0
            ? `No free ${args.durationMinutes}-minute slots for ${calendarsQueried.join(", ")} in that window (working hours ${result.workingHours} ${zone}).`
            : `${rendered.length} free slot(s) of at least ${args.durationMinutes} min for ${calendarsQueried.join(", ")} (working hours ${result.workingHours} ${zone}):\n${rendered
                .map((s) => `  ${s.label}  [${s.durationMinutes} min]`)
                .join("\n")}`;
        const warning = calendarErrors.length
          ? `\n\nWARNING — these calendars could NOT be read and are excluded from the result: ${calendarErrors
              .map((e) => `${e.calendarId} (${e.reason})`)
              .join("; ")}. The slots above do NOT account for them.`
          : "";

        return {
          content: [{ type: "text", text: header + warning }],
          structuredContent: result,
        };
      } catch (err) {
        const { code, message } = asGmailApiError(err);
        if (code === 403)
          return structuredError(
            isServiceDisabled(message)
              ? `calendar_find_free_slots cannot run: ${message} ${SERVICE_DISABLED_HINT}`
              : `Not permitted to run a freeBusy query: ${message}. The token needs the calendar.freebusy or calendar.readonly scope.`,
          );
        const prefix =
          code !== undefined
            ? `calendar_find_free_slots failed (HTTP ${code})`
            : "calendar_find_free_slots failed";
        return structuredError(`${prefix}: ${message}`);
      }
    },
    slotsMeta.annotations,
    slotsMeta.scopes,
    authorizedScopes,
  );
}
