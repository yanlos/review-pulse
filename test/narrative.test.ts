import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APIConnectionTimeoutError, OverloadedError, RateLimitError } from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { openStore } from "../src/db.ts";
import { HttpError } from "../src/errors.ts";
import { reviewFlowReport } from "../src/metrics.ts";
import { createNarrator, toFacts, verifyEvidence, type LlmClient } from "../src/narrative.ts";
import { DAY, HOUR, NOW, pr, review, silentLog } from "./fixtures.ts";

const PERIOD = { from: NOW - 10 * DAY, to: NOW, prevFrom: NOW - 20 * DAY };

function report(prs = [pr({ number: 1, createdAt: NOW - 2 * DAY, reviews: [review("bob", NOW - 2 * DAY + 3 * HOUR)] })], dataAsOf = NOW) {
  return reviewFlowReport("o/r", PERIOD, prs, dataAsOf);
}

const GOOD = {
  summary: "One PR waited three hours for review.",
  hypothesis: null,
  confidence: 0.3,
  evidence: [
    { fact: "current.time_to_first_review.median_hours", value: 3, note: "short wait" },
    { fact: "current.pull_requests.opened", value: 99, note: "wrong value" },
  ],
};

function message(fields: Partial<Anthropic.Message> & { text?: string }): Anthropic.Message {
  const { text = JSON.stringify(GOOD), ...rest } = fields;
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_details: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...rest,
  } as Anthropic.Message;
}

function fakeClient(answer: () => Anthropic.Message | Promise<Anthropic.Message>) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params);
        return answer();
      },
    },
  } as unknown as LlmClient;
  return { client, calls };
}

function narrator(answer: () => Anthropic.Message | Promise<Anthropic.Message>) {
  const { client, calls } = fakeClient(answer);
  return { narrator: createNarrator({ client, model: "test-model", store: openStore(":memory:"), now: () => NOW }), calls };
}

function walk(body: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], body);
}

describe("facts and evidence", () => {
  it("uses keys that point to the same value in the review-flow body", () => {
    const body = report();
    const facts = toFacts(body);
    assert.ok(Object.keys(facts).length > 20);
    for (const [key, value] of Object.entries(facts)) {
      assert.strictEqual(walk(body, key), value, key);
      assert.ok(value === null || typeof value === "string" || Number.isFinite(value), key);
    }
  });

  it("verifies only exact numeric matches on real keys", () => {
    const facts = toFacts(report());
    assert.equal(verifyEvidence(facts, { fact: "current.time_to_first_review.median_hours", value: 3 }), true);
    assert.equal(verifyEvidence(facts, { fact: "current.time_to_first_review.median_hours", value: 3.01 }), false);
    assert.equal(verifyEvidence(facts, { fact: "current.unknown", value: 0 }), false);
    assert.equal(verifyEvidence(facts, { fact: "previous.time_to_first_review.median_hours", value: 0 }), false);
    assert.equal(verifyEvidence(facts, { fact: "current.reviewers.top.0.login", value: 0 }), false);
    for (const key of ["__proto__", "constructor", "toString"]) {
      assert.equal(verifyEvidence(facts, { fact: key, value: 0 }), false, key);
    }
  });
});

describe("narrative call", () => {
  it("sends only the facts as JSON and flags evidence that does not match", async () => {
    const { narrator: n, calls } = narrator(() => message({}));
    const result = await n.explain(report(), silentLog);

    assert.equal(calls.length, 1);
    const params = calls[0]!;
    assert.equal(params.model, "test-model");
    assert.equal("thinking" in params, false);
    assert.equal("temperature" in params, false);
    assert.equal((params.output_config as { effort: string }).effort, "low");
    const content = JSON.parse((params.messages as { content: string }[])[0]!.content) as Record<string, unknown>;
    assert.deepEqual(Object.keys(content), ["repo", "period", "previous_period", "facts"]);

    assert.equal(result.cached, false);
    assert.deepEqual(
      result.evidence.map((e) => e.verified),
      [true, false],
    );
  });

  it("caches by content, so a new sync with the same numbers makes no call", async () => {
    const { narrator: n, calls } = narrator(() => message({}));
    await n.explain(report(), silentLog);
    const second = await n.explain(report(undefined, NOW + HOUR), silentLog);
    assert.equal(calls.length, 1);
    assert.equal(second.cached, true);
    assert.equal(second.data_as_of, new Date(NOW + HOUR).toISOString());
  });

  it("maps model failures to clear HTTP errors", async () => {
    const cases: [() => Anthropic.Message | Promise<Anthropic.Message>, number, string, number?][] = [
      [() => message({ stop_reason: "refusal", text: "" }), 502, "llm_error"],
      [() => message({ stop_reason: "max_tokens", text: '{"summary":' }), 502, "llm_error"],
      [() => message({ text: "not json" }), 502, "llm_error"],
      [() => message({ text: JSON.stringify({ ...GOOD, confidence: 2 }) }), 502, "llm_error"],
      [() => Promise.reject(new RateLimitError(429, undefined, "busy", new Headers({ "retry-after": "7" }))), 503, "llm_rate_limited", 7],
      [() => Promise.reject(new OverloadedError(529, undefined, "overloaded", new Headers())), 503, "llm_rate_limited", 30],
      [() => Promise.reject(new APIConnectionTimeoutError()), 504, "llm_timeout"],
      [() => Promise.reject(new TypeError("boom")), 502, "llm_error"],
    ];
    for (const [answer, status, code, retryAfter] of cases) {
      const { narrator: n } = narrator(answer);
      await assert.rejects(n.explain(report(), silentLog), (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, status);
        assert.equal(err.code, code);
        assert.equal(err.retryAfter, retryAfter);
        return true;
      });
    }
  });

  it("returns a fixed narrative for an empty period without a call", async () => {
    const { narrator: n, calls } = narrator(() => message({}));
    const result = await n.explain(report([]), silentLog);
    assert.equal(calls.length, 0);
    assert.equal(result.model, null);
    assert.equal(result.evidence[0]!.verified, verifyEvidence(result.facts, result.evidence[0]!));
  });

  it("calls the model when the only activity is a PR that waits for review", async () => {
    const { narrator: n, calls } = narrator(() => message({}));
    const waiting = pr({ number: 1, createdAt: NOW - 30 * DAY, readyAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY });
    await n.explain(report([waiting]), silentLog);
    assert.equal(calls.length, 1);
  });
});
