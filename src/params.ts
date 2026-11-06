import { z } from "zod";
import { badRequest } from "./errors.ts";

export const DAY_MS = 86_400_000;
export const MAX_SPAN_DAYS = 90;
export const MAX_LOOKBACK_DAYS = 365;
const DEFAULT_SPAN_DAYS = 30;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const RepoParams = z.object({
  owner: z.string().regex(OWNER),
  repo: z.string().regex(NAME).refine((name) => name !== "." && name !== ".."),
});

const PeriodQuery = z.strictObject({
  from: z.string().optional(),
  to: z.string().optional(),
});

export type RepoRef = { owner: string; name: string; key: string };

// All times are epoch ms in UTC. The window is [from, to): "to" is the start of the day after the last day.
export type Period = { from: number; to: number; prevFrom: number };

export function parseRepo(params: unknown): RepoRef {
  const result = RepoParams.safeParse(params);
  if (!result.success) {
    throw badRequest("The owner or repository name is not a valid GitHub name.");
  }
  const { owner, repo } = result.data;
  return { owner, name: repo, key: `${owner}/${repo}`.toLowerCase() };
}

export function parsePeriod(query: unknown, now: number): Period {
  const result = PeriodQuery.safeParse(query);
  if (!result.success) {
    throw badRequest("Use only the query parameters 'from' and 'to', each one time.");
  }
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const lastDay = result.data.to === undefined ? today : parseDay(result.data.to, "to");
  const firstDay =
    result.data.from === undefined
      ? lastDay - (DEFAULT_SPAN_DAYS - 1) * DAY_MS
      : parseDay(result.data.from, "from");

  if (firstDay > lastDay) throw badRequest("'from' must be on or before 'to'.");
  if (lastDay > today) throw badRequest("'to' must not be after today (UTC).");
  const spanDays = (lastDay - firstDay) / DAY_MS + 1;
  if (spanDays > MAX_SPAN_DAYS) throw badRequest(`The period must not be longer than ${MAX_SPAN_DAYS} days.`);
  if (firstDay < today - MAX_LOOKBACK_DAYS * DAY_MS) {
    throw badRequest(`'from' must not be more than ${MAX_LOOKBACK_DAYS} days before today.`);
  }
  return { from: firstDay, to: lastDay + DAY_MS, prevFrom: firstDay - spanDays * DAY_MS };
}

function parseDay(value: string, name: string): number {
  if (!DATE.test(value)) throw badRequest(`'${name}' must be a date in the format YYYY-MM-DD.`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw badRequest(`'${name}' is not a real calendar date.`);
  }
  return ms;
}
