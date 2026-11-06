import { Writable } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import type { PrRow, RawPrNode, ReviewRow } from "../src/github.ts";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const NOW = Date.parse("2026-11-06T12:00:00Z");

export function pr(fields: Partial<PrRow> & { number: number }): PrRow {
  const createdAt = fields.createdAt ?? NOW - 2 * DAY;
  return {
    author: "alice",
    authorIsBot: false,
    createdAt,
    readyAt: createdAt,
    mergedAt: null,
    closedAt: null,
    updatedAt: createdAt,
    reviewsTruncated: false,
    reviews: [],
    ...fields,
  };
}

export function review(reviewer: string | null, submittedAt: number, reviewerIsBot = false): ReviewRow {
  return { reviewer, reviewerIsBot, submittedAt };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

type NodeFields = {
  number: number;
  author?: { __typename: string; login: string } | null;
  createdAt?: number;
  updatedAt?: number;
  mergedAt?: number | null;
  closedAt?: number | null;
  state?: "OPEN" | "CLOSED" | "MERGED";
  isDraft?: boolean;
  timeline?: { __typename: string; createdAt?: number }[];
  reviews?: { login: string | null; at: number | null; typename?: string }[];
  totalReviews?: number;
};

export function node(f: NodeFields): RawPrNode {
  const createdAt = f.createdAt ?? NOW - 2 * DAY;
  const reviews = (f.reviews ?? []).map((r) => ({
    submittedAt: r.at === null ? null : iso(r.at),
    author: r.login === null ? null : { __typename: r.typename ?? "User", login: r.login },
  }));
  return {
    number: f.number,
    state: f.state ?? (f.mergedAt ? "MERGED" : "OPEN"),
    isDraft: f.isDraft ?? false,
    createdAt: iso(createdAt),
    updatedAt: iso(f.updatedAt ?? createdAt),
    mergedAt: f.mergedAt ? iso(f.mergedAt) : null,
    closedAt: f.closedAt ? iso(f.closedAt) : f.mergedAt ? iso(f.mergedAt) : null,
    author: f.author === undefined ? { __typename: "User", login: "alice" } : f.author,
    timelineItems: {
      nodes: (f.timeline ?? []).map((t) => ({
        __typename: t.__typename,
        ...(t.createdAt === undefined ? {} : { createdAt: iso(t.createdAt) }),
      })),
    },
    reviews: { totalCount: f.totalReviews ?? reviews.length, nodes: reviews },
  };
}

export function graphqlPage(nodes: RawPrNode[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      rateLimit: { cost: 1, remaining: 4999, resetAt: iso(NOW + HOUR) },
      repository: { isPrivate: false, pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } },
    },
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export type FetchCall = { url: string; init: RequestInit; variables: Record<string, unknown> };

export function fakeFetch(handler: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: Record<string, unknown> };
    const call = { url: String(input), init: init ?? {}, variables: body.variables ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export function logCollector() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
}

const noop = () => undefined;
export const silentLog = {
  level: "silent",
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  silent: noop,
  child() {
    return silentLog;
  },
} as unknown as FastifyBaseLogger;
