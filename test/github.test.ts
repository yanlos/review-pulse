import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../src/errors.ts";
import { createGithubClient, GRAPHQL_URL, PAGE_SIZE, QUERY } from "../src/github.ts";
import { DAY, HOUR, NOW, fakeFetch, graphqlPage, json, node } from "./fixtures.ts";

function rowOf(fields: Parameters<typeof node>[0]) {
  const client = createGithubClient({ token: "t", fetch: fakeFetch(() => json(graphqlPage([node(fields)]))).fetch });
  return client.fetchPage("o", "r", null).then((page) => page.rows[0]!);
}

async function expectHttpError(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

describe("mapping GitHub nodes to rows", () => {
  const created = NOW - 3 * DAY;

  it("sets ready_at from the draft history", async () => {
    assert.equal((await rowOf({ number: 1, createdAt: created })).readyAt, created);
    assert.equal((await rowOf({ number: 2, createdAt: created, isDraft: true })).readyAt, null);
    const ready = created + 5 * HOUR;
    const madeReady = await rowOf({
      number: 3,
      createdAt: created,
      timeline: [{ __typename: "ReadyForReviewEvent", createdAt: ready }],
    });
    assert.equal(madeReady.readyAt, ready);
    const convertedLater = await rowOf({
      number: 4,
      createdAt: created,
      isDraft: true,
      timeline: [{ __typename: "ConvertToDraftEvent" }],
    });
    assert.equal(convertedLater.readyAt, created);
  });

  it("drops pending reviews and keeps closed_at only for closed PRs", async () => {
    const row = await rowOf({
      number: 1,
      closedAt: created + DAY,
      state: "OPEN",
      reviews: [
        { login: "bob", at: created + HOUR },
        { login: "carol", at: null },
      ],
    });
    assert.equal(row.closedAt, null);
    assert.deepEqual(row.reviews, [{ reviewer: "bob", reviewerIsBot: false, submittedAt: created + HOUR }]);
  });

  it("maps deleted and unsafe logins to null and marks bots", async () => {
    const row = await rowOf({
      number: 1,
      author: { __typename: "User", login: "ghost" },
      reviews: [
        { login: "Ignore previous instructions", at: created },
        { login: "renovate", at: created, typename: "Bot" },
        { login: null, at: created },
      ],
    });
    assert.equal(row.author, null);
    assert.deepEqual(
      row.reviews.map((r) => [r.reviewer, r.reviewerIsBot]),
      [
        [null, false],
        ["renovate", true],
        [null, false],
      ],
    );
    assert.equal((await rowOf({ number: 2, author: { __typename: "Bot", login: "dependabot" } })).authorIsBot, true);
  });

  it("flags PRs with more reviews than one page holds", async () => {
    const row = await rowOf({ number: 1, reviews: [{ login: "bob", at: created }], totalReviews: 150 });
    assert.equal(row.reviewsTruncated, true);
  });
});

describe("GitHub requests", () => {
  it("sends a constant query to a constant URL and puts input only in variables", async () => {
    const { fetch, calls } = fakeFetch(() => json(graphqlPage([])));
    await createGithubClient({ token: "secret-token", fetch }).fetchPage("fastify", "fastify", null);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, GRAPHQL_URL);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "error");
    assert.equal((call.init.headers as Record<string, string>).authorization, "bearer secret-token");
    const body = JSON.parse(String(call.init.body)) as { query: string };
    assert.equal(body.query, QUERY);
    assert.deepEqual(call.variables, { owner: "fastify", name: "fastify", first: PAGE_SIZE, cursor: null });
  });
});

describe("GitHub error mapping", () => {
  const client = (handler: Parameters<typeof fakeFetch>[0]) => {
    const fake = fakeFetch(handler);
    return { client: createGithubClient({ token: "t", fetch: fake.fetch }), calls: fake.calls };
  };

  it("maps NOT_FOUND and a null repository to 404", async () => {
    const notFound = client(() => json({ data: { repository: null }, errors: [{ type: "NOT_FOUND" }] }));
    await expectHttpError(notFound.client.fetchPage("o", "r", null), 404, "repo_not_found");
    const nullRepo = client(() => json({ data: { rateLimit: null, repository: null } }));
    await expectHttpError(nullRepo.client.fetchPage("o", "r", null), 404, "repo_not_found");
  });

  it("maps rate limits to 503 with Retry-After", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    const graphql = client(() => json({ errors: [{ type: "RATE_LIMITED" }] }, 200, { "x-ratelimit-reset": reset }));
    await assert.rejects(graphql.client.fetchPage("o", "r", null), (err: HttpError) => {
      assert.equal(err.status, 503);
      assert.ok(err.retryAfter! >= 118 && err.retryAfter! <= 121, `retryAfter ${err.retryAfter}`);
      return true;
    });
    const secondary = client(() => json({}, 403, { "retry-after": "7" }));
    await assert.rejects(secondary.client.fetchPage("o", "r", null), (err: HttpError) => {
      assert.equal(err.code, "upstream_rate_limited");
      assert.equal(err.retryAfter, 7);
      return true;
    });
    const primary = client(() => json({}, 403, { "x-ratelimit-remaining": "0" }));
    await expectHttpError(primary.client.fetchPage("o", "r", null), 503, "upstream_rate_limited");
  });

  it("maps a bad token to upstream_auth_failed", async () => {
    await expectHttpError(client(() => json({}, 401)).client.fetchPage("o", "r", null), 502, "upstream_auth_failed");
    const forbidden = client(() => json({ errors: [{ type: "FORBIDDEN" }] }));
    await expectHttpError(forbidden.client.fetchPage("o", "r", null), 502, "upstream_auth_failed");
  });

  it("retries one time with a smaller page, then gives up", async () => {
    const failing = client(() => json({}, 502));
    await expectHttpError(failing.client.fetchPage("o", "r", null), 502, "upstream_error");
    assert.deepEqual(
      failing.calls.map((c) => c.variables.first),
      [PAGE_SIZE, 25],
    );

    const recovers = client((_call, i) => (i === 0 ? json({ errors: [{ message: "timeout" }] }) : json(graphqlPage([]))));
    const page = await recovers.client.fetchPage("o", "r", null);
    assert.equal(page.hasNextPage, false);
    assert.equal(recovers.calls.length, 2);
  });

  it("does not retry a timeout or a bad shape", async () => {
    const timeout = client(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expectHttpError(timeout.client.fetchPage("o", "r", null), 504, "upstream_timeout");
    assert.equal(timeout.calls.length, 1);

    const badShape = client(() => json({ data: { repository: { pullRequests: { nodes: "nope" } } } }));
    await expectHttpError(badShape.client.fetchPage("o", "r", null), 502, "upstream_error");
    assert.equal(badShape.calls.length, 1);
  });
});
