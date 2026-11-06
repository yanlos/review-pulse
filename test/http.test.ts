import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { buildApp } from "../src/app.ts";
import { openStore } from "../src/db.ts";
import { createGithubClient } from "../src/github.ts";
import { createNarrator, type Narrator } from "../src/narrative.ts";
import { createSyncer, type Syncer } from "../src/sync.ts";
import { DAY, HOUR, NOW, fakeFetch, graphqlPage, json, logCollector, node } from "./fixtures.ts";

const GITHUB_SECRET = "ghp_SENTINEL_GITHUB_0001";
const LLM_SECRET = "sk-ant-SENTINEL_LLM_0002";
const BASE = "/api/repos/fastify/fastify/review-flow";

const SAMPLE_PAGE = graphqlPage([
  node({ number: 4, author: { __typename: "Bot", login: "renovate" }, createdAt: NOW - DAY, mergedAt: NOW - DAY + HOUR }),
  node({ number: 3, author: { __typename: "User", login: "dave" }, createdAt: NOW - 2 * DAY }),
  node({
    number: 1,
    createdAt: NOW - 3 * DAY,
    mergedAt: NOW - 3 * DAY + 5 * HOUR,
    reviews: [{ login: "bob", at: NOW - 3 * DAY + 2 * HOUR }],
  }),
  node({
    number: 2,
    author: { __typename: "User", login: "carol" },
    createdAt: NOW - 4 * DAY,
    reviews: [
      { login: "bob", at: NOW - 4 * DAY + 4 * HOUR },
      { login: "dave", at: NOW - 4 * DAY + 6 * HOUR },
    ],
  }),
  node({
    number: 5,
    author: { __typename: "User", login: "erin" },
    createdAt: NOW - 5 * DAY,
    isDraft: false,
    timeline: [{ __typename: "ReadyForReviewEvent", createdAt: NOW - 4 * DAY }],
    reviews: [{ login: "alice", at: NOW - 4 * DAY + HOUR }],
    mergedAt: NOW - 3 * DAY,
  }),
]);

type Options = {
  fetch?: typeof fetch;
  narrator?: (store: ReturnType<typeof openStore>) => Narrator;
  syncer?: Syncer;
  logStream?: NodeJS.WritableStream;
};

async function makeApp(options: Options = {}) {
  const store = openStore(":memory:");
  const github = createGithubClient({ token: GITHUB_SECRET, fetch: options.fetch ?? fakeFetch(() => json(SAMPLE_PAGE)).fetch });
  return buildApp({
    store,
    syncer: options.syncer ?? createSyncer({ store, github, now: () => NOW }),
    narrator: options.narrator ? options.narrator(store) : null,
    now: () => NOW,
    logLevel: options.logStream ? "info" : "silent",
    logStream: options.logStream,
  });
}

describe("input validation", () => {
  const badPaths = [
    "/api/repos/a%2Fb/c/review-flow",
    "/api/repos/-abc/x/review-flow",
    "/api/repos/abc-/x/review-flow",
    `/api/repos/${"a".repeat(40)}/x/review-flow`,
    `/api/repos/a/${"b".repeat(101)}/review-flow`,
    "/api/repos/a%20b/c/review-flow",
    "/api/repos/%C3%A9/c/review-flow",
    "/api/repos/a/b%3Fx/review-flow",
  ];
  const badQueries = [
    "from=2026-02-30",
    "from=2026-1-1",
    "from=2026-11-01&to=2026-10-01",
    "from=2026-08-01&to=2026-10-30",
    "from=2025-01-01&to=2025-01-31",
    "to=2026-11-07",
    "form=2026-11-01",
    "from=2026-11-01&from=2026-11-02",
  ];

  it("rejects bad names, paths and dates before any GitHub call", async () => {
    const { fetch, calls } = fakeFetch(() => json(SAMPLE_PAGE));
    const app = await makeApp({ fetch });
    for (const url of [...badPaths, ...badQueries.map((q) => `${BASE}?${q}`)]) {
      const res = await app.inject({ url });
      assert.equal(res.statusCode, 400, url);
      assert.equal(res.headers["content-type"], "application/problem+json; charset=utf-8", url);
      assert.equal(res.json().code, "invalid_parameter", url);
    }
    // The router resolves dot segments first, so these paths match no route.
    for (const url of ["/api/repos/a/../review-flow", "/api/repos/a/%2E%2E/review-flow", "/api/repos/%2E%2E/x/review-flow", "/api/repos/a/%2E/review-flow"]) {
      const res = await app.inject({ url });
      assert.equal(res.statusCode, 404, url);
      assert.equal(res.json().code, "not_found", url);
    }
    assert.equal(calls.length, 0);
  });
});

describe("review flow", () => {
  it("returns numbers that match the source data", async () => {
    const app = await makeApp();
    const res = await app.inject({ url: BASE });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "private, max-age=60");
    const body = res.json();
    assert.equal(body.period.from, "2026-10-08T00:00:00.000Z");
    assert.equal(body.period.to, "2026-11-07T00:00:00.000Z");
    assert.equal(body.period.complete, false);
    assert.deepEqual(body.current.pull_requests, { opened: 4, merged: 2, closed_unmerged: 0 });
    assert.deepEqual(body.current.time_to_first_review, { count: 3, unreviewed: 1, median_hours: 2, p90_hours: 3.6 });
    assert.equal(body.current.reviewers.review_pairs, 4);
    assert.equal(body.current.reviewers.for_half, 1);
    assert.deepEqual(body.current.reviewers.top[0], { login: "bob", prs_reviewed: 2, share: 0.5 });
    assert.deepEqual(body.current.excluded, { bot_prs_opened: 1, bot_prs_merged: 1 });

    const pulls = (await app.inject({ url: `${BASE}/pulls` })).json();
    assert.deepEqual(
      pulls.pulls.map((p: { number: number }) => p.number),
      [5, 3, 2, 1],
    );
  });

  it("hides internal errors", async () => {
    const syncer: Syncer = {
      async ensureSynced() {
        throw new Error("SQLITE_CANTOPEN /data/review-pulse.db");
      },
    };
    const app = await makeApp({ syncer });
    const res = await app.inject({ url: BASE });
    assert.equal(res.statusCode, 500);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.json().detail, "An unexpected error occurred.");
    assert.ok(res.json().request_id);
    assert.doesNotMatch(res.body, /SQLITE|\/data\//);
  });

  it("answers unknown paths with a problem body and sets security headers", async () => {
    const app = await makeApp();
    const res = await app.inject({ url: "/nope" });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, "not_found");
    for (const r of [res, await app.inject({ url: "/healthz" })]) {
      assert.match(String(r.headers["content-security-policy"]), /default-src 'self'/);
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.equal(r.headers["referrer-policy"], "no-referrer");
    }
  });
});

describe("narrative endpoint", () => {
  const fakeNarrator = () => {
    let calls = 0;
    const make = (): Narrator => ({
      async explain(report) {
        calls++;
        return { ...report, model: "m", cached: false, generated_at: "", summary: "", hypothesis: null, confidence: 0, evidence: [], facts: {} };
      },
    });
    return { make, calls: () => calls };
  };

  it("returns 503 without a key, while review flow still works", async () => {
    const app = await makeApp();
    const res = await app.inject({ url: `${BASE}/narrative` });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "llm_not_configured");
    assert.equal((await app.inject({ url: BASE })).statusCode, 200);
  });

  it("has no HEAD route and a lower rate limit", async () => {
    const fake = fakeNarrator();
    const app = await makeApp({ narrator: fake.make });
    assert.equal((await app.inject({ method: "HEAD", url: `${BASE}/narrative` })).statusCode, 404);
    assert.equal(fake.calls(), 0);
    for (let i = 0; i < 10; i++) {
      assert.equal((await app.inject({ url: `${BASE}/narrative` })).statusCode, 200);
    }
    const limited = await app.inject({ url: `${BASE}/narrative` });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, "rate_limited");
    assert.ok(Number(limited.headers["retry-after"]) > 0);
    assert.equal(fake.calls(), 10);
  });
});

describe("secrets", () => {
  it("never puts a token or key in logs or response bodies", async () => {
    const logs = logCollector();
    const bodies: string[] = [];

    const unauthorized = await makeApp({ fetch: fakeFetch(() => json({ message: "Bad credentials" }, 401)).fetch, logStream: logs.stream });
    const res = await unauthorized.inject({ url: BASE, headers: { authorization: `Bearer ${LLM_SECRET}`, cookie: `s=${GITHUB_SECRET}` } });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().code, "upstream_auth_failed");
    bodies.push(res.body);

    const llmFails = await makeApp({
      logStream: logs.stream,
      narrator: (store) =>
        createNarrator({
          client: new Anthropic({
            apiKey: LLM_SECRET,
            baseURL: "https://api.anthropic.com",
            maxRetries: 0,
            fetch: async () => json({ type: "error", error: { type: "api_error", message: "Internal" } }, 500),
          }),
          model: "claude-opus-5-5",
          store,
          now: () => NOW,
        }),
    });
    const llmRes = await llmFails.inject({ url: `${BASE}/narrative` });
    assert.equal(llmRes.statusCode, 502);
    assert.equal(llmRes.json().code, "llm_error");
    bodies.push(llmRes.body);

    const all = logs.text() + bodies.join("");
    assert.ok(logs.text().includes("llm call failed"), "the failure is logged");
    assert.equal(all.includes(GITHUB_SECRET), false);
    assert.equal(all.includes(LLM_SECRET), false);
  });
});
