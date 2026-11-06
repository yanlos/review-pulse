import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { HttpError } from "./errors.ts";

export const GRAPHQL_URL = "https://api.github.com/graphql";
export const PAGE_SIZE = 50;
const RETRY_PAGE_SIZE = 25;
const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 1_000;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

export const QUERY = `
query ReviewPulse($owner: String!, $name: String!, $first: Int!, $cursor: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    isPrivate
    pullRequests(first: $first, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number state isDraft createdAt updatedAt mergedAt closedAt
        author { __typename login }
        timelineItems(first: 1, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) {
          nodes { __typename ... on ReadyForReviewEvent { createdAt } }
        }
        reviews(first: 100) {
          totalCount
          nodes { submittedAt author { __typename login } }
        }
      }
    }
  }
}`;

export type ReviewRow = { reviewer: string | null; reviewerIsBot: boolean; submittedAt: number };

export type PrRow = {
  number: number;
  author: string | null;
  authorIsBot: boolean;
  createdAt: number;
  readyAt: number | null;
  mergedAt: number | null;
  closedAt: number | null;
  updatedAt: number;
  reviewsTruncated: boolean;
  reviews: ReviewRow[];
};

export type Page = {
  rows: PrRow[];
  hasNextPage: boolean;
  endCursor: string | null;
  cost: number | null;
  remaining: number | null;
};

export type GithubClient = {
  fetchPage(owner: string, name: string, cursor: string | null): Promise<Page>;
};

const Time = z.iso.datetime().transform((value) => Date.parse(value));
const Actor = z.object({ __typename: z.string(), login: z.string() }).nullable();

const PrNode = z.object({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  createdAt: Time,
  updatedAt: Time,
  mergedAt: Time.nullable(),
  closedAt: Time.nullable(),
  author: Actor,
  timelineItems: z.object({
    nodes: z.array(z.object({ __typename: z.string(), createdAt: Time.optional() }).nullable()),
  }),
  reviews: z.object({
    totalCount: z.number().int(),
    nodes: z.array(z.object({ submittedAt: Time.nullable(), author: Actor }).nullable()),
  }),
});

export type RawPrNode = z.input<typeof PrNode>;

const PageBody = z.object({
  data: z.object({
    rateLimit: z.object({ cost: z.number(), remaining: z.number() }).nullable(),
    repository: z
      .object({
        isPrivate: z.boolean(),
        pullRequests: z.object({
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          nodes: z.array(PrNode),
        }),
      })
      .nullable(),
  }),
});

const ErrorBody = z.object({
  errors: z.array(z.object({ type: z.string().optional() })).min(1),
});

class Retryable extends Error {}

export function createGithubClient(options: { token: string; fetch?: typeof fetch }): GithubClient {
  const fetchImpl = options.fetch ?? fetch;

  async function attempt(owner: string, name: string, cursor: string | null, first: number): Promise<Page> {
    let res: Response;
    let body: unknown;
    try {
      res = await fetchImpl(GRAPHQL_URL, {
        method: "POST",
        headers: {
          authorization: `bearer ${options.token}`,
          "content-type": "application/json",
          "user-agent": "review-pulse",
        },
        body: JSON.stringify({ query: QUERY, variables: { owner, name, first, cursor } }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      body = res.ok ? await res.json() : await res.text();
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new HttpError(504, "upstream_timeout", "GitHub did not answer in time.");
      }
      const code = err instanceof Error && err.cause instanceof Error ? (err.cause as { code?: string }).code : undefined;
      throw new Retryable(`network error ${code ?? ""}`.trim());
    }

    if (!res.ok) throw statusError(res, String(body));

    const errors = ErrorBody.safeParse(body);
    if (errors.success) throw graphqlError(errors.data.errors.map((e) => e.type), res.headers);

    const page = PageBody.safeParse(body);
    if (!page.success) {
      throw new HttpError(502, "upstream_error", "GitHub sent a response in an unexpected format.", undefined, "bad shape");
    }
    const { rateLimit, repository } = page.data.data;
    // The service is for public data only, even when the token can read more.
    if (repository === null || repository.isPrivate) throw notFound();

    return {
      rows: repository.pullRequests.nodes.map(toRow),
      hasNextPage: repository.pullRequests.pageInfo.hasNextPage,
      endCursor: repository.pullRequests.pageInfo.endCursor,
      cost: rateLimit?.cost ?? null,
      remaining: rateLimit?.remaining ?? null,
    };
  }

  return {
    async fetchPage(owner, name, cursor) {
      try {
        return await attempt(owner, name, cursor, PAGE_SIZE);
      } catch (err) {
        if (!(err instanceof Retryable)) throw err;
      }
      await sleep(RETRY_DELAY_MS);
      try {
        return await attempt(owner, name, cursor, RETRY_PAGE_SIZE);
      } catch (err) {
        if (err instanceof Retryable) {
          throw new HttpError(502, "upstream_error", "GitHub did not answer correctly.", undefined, err.message);
        }
        throw err;
      }
    },
  };
}

function statusError(res: Response, text: string): Error {
  const rateLimited =
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after") || /rate limit/i.test(text)));
  if (rateLimited) return rateLimitedError(res.headers);
  if (res.status === 401 || res.status === 403) return authError();
  if (res.status === 502 || res.status === 503 || res.status === 504) return new Retryable(`status ${res.status}`);
  return new HttpError(502, "upstream_error", "GitHub did not answer correctly.", undefined, `status ${res.status}`);
}

function graphqlError(types: (string | undefined)[], headers: Headers): Error {
  if (types.includes("NOT_FOUND")) return notFound();
  if (types.includes("RATE_LIMITED")) return rateLimitedError(headers);
  if (types.includes("FORBIDDEN")) return authError();
  // GitHub reports query timeouts as errors with no known type. A smaller page usually works.
  return new Retryable("graphql error");
}

function notFound(): HttpError {
  return new HttpError(404, "repo_not_found", "GitHub has no public repository with this name.");
}

function authError(): HttpError {
  return new HttpError(502, "upstream_auth_failed", "GitHub did not accept the token. Check GITHUB_TOKEN.");
}

function rateLimitedError(headers: Headers): HttpError {
  let seconds = Number(headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    const reset = Number(headers.get("x-ratelimit-reset"));
    seconds = Number.isFinite(reset) && reset > 0 ? Math.ceil(reset - Date.now() / 1000) : 60;
  }
  const retryAfter = Math.min(3600, Math.max(1, seconds));
  return new HttpError(503, "upstream_rate_limited", "The GitHub rate limit is used up. Try again later.", retryAfter);
}

type ParsedNode = z.output<typeof PrNode>;
type ParsedActor = z.output<typeof Actor>;

function cleanLogin(actor: ParsedActor): string | null {
  if (actor === null || actor.login === "ghost" || !LOGIN.test(actor.login)) return null;
  return actor.login;
}

function readyAt(node: ParsedNode): number | null {
  const first = node.timelineItems.nodes[0];
  if (first?.__typename === "ReadyForReviewEvent" && first.createdAt !== undefined) return first.createdAt;
  if (first?.__typename === "ConvertToDraftEvent") return node.createdAt;
  return node.isDraft ? null : node.createdAt;
}

function toRow(node: ParsedNode): PrRow {
  const reviews: ReviewRow[] = [];
  for (const review of node.reviews.nodes) {
    // A pending review has no submittedAt. It is not visible to other people yet.
    if (review === null || review.submittedAt === null) continue;
    reviews.push({
      reviewer: cleanLogin(review.author),
      reviewerIsBot: review.author?.__typename === "Bot",
      submittedAt: review.submittedAt,
    });
  }
  return {
    number: node.number,
    author: cleanLogin(node.author),
    authorIsBot: node.author?.__typename === "Bot",
    createdAt: node.createdAt,
    readyAt: readyAt(node),
    mergedAt: node.mergedAt,
    closedAt: node.state === "OPEN" ? null : node.closedAt,
    updatedAt: node.updatedAt,
    reviewsTruncated: node.reviews.totalCount > node.reviews.nodes.length,
    reviews,
  };
}
