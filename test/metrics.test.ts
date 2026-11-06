import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeReviewFlow, pullsReport, quantile } from "../src/metrics.ts";
import { DAY, HOUR, NOW, pr, review } from "./fixtures.ts";

const W = { from: NOW - 10 * DAY, to: NOW };
const inside = NOW - 5 * DAY;

describe("windows and exclusions", () => {
  it("counts an event at the start of the window and not one at the end", () => {
    const stats = computeReviewFlow(
      [
        pr({ number: 1, createdAt: W.from }),
        pr({ number: 2, createdAt: W.to }),
        pr({ number: 3, createdAt: inside, mergedAt: W.to - 1, closedAt: W.to - 1 }),
        pr({ number: 4, createdAt: inside, closedAt: inside + DAY }),
      ],
      W,
    );
    assert.deepEqual(stats.pull_requests, { opened: 3, merged: 1, closed_unmerged: 1 });
  });

  it("leaves bot PRs out and counts them apart", () => {
    const stats = computeReviewFlow(
      [pr({ number: 1, authorIsBot: true, author: "renovate", createdAt: inside, mergedAt: inside + HOUR })],
      W,
    );
    assert.equal(stats.pull_requests.opened, 0);
    assert.equal(stats.time_to_merge.count, 0);
    assert.deepEqual(stats.excluded, { bot_prs_opened: 1, bot_prs_merged: 1 });
  });

  it("ignores bot reviews and self reviews, but counts reviews by deleted users", () => {
    const stats = computeReviewFlow(
      [
        pr({ number: 1, createdAt: inside, reviews: [review("ci-bot", inside + HOUR, true), review("Alice", inside + HOUR)] }),
        pr({ number: 2, createdAt: inside, author: null, reviews: [review(null, inside + 2 * HOUR)] }),
      ],
      W,
    );
    assert.equal(stats.time_to_first_review.count, 1, "only the deleted user's review counts");
    assert.equal(stats.time_to_first_review.unreviewed, 1);
    assert.equal(stats.time_to_first_review.median_hours, 2);
    assert.equal(stats.reviewers.review_pairs, 0, "a deleted user is not ranked");
  });
});

describe("first review and merge clocks", () => {
  it("starts the clock when the PR is ready for review", () => {
    const ready = inside + 10 * HOUR;
    const stats = computeReviewFlow(
      [
        pr({ number: 1, createdAt: inside, readyAt: ready, reviews: [review("bob", ready + 3 * HOUR)], mergedAt: ready + 5 * HOUR }),
        pr({ number: 2, createdAt: inside, readyAt: ready, reviews: [review("bob", inside + HOUR)] }),
        pr({ number: 3, createdAt: inside, readyAt: null, reviews: [review("bob", inside + HOUR)] }),
      ],
      W,
    );
    assert.equal(stats.time_to_first_review.count, 2);
    assert.equal(stats.time_to_first_review.median_hours, 1.5, "a review on a draft counts as 0 hours");
    assert.equal(stats.time_to_merge.median_hours, 5);
  });

  it("counts a review at the close time, but not a review after it", () => {
    const closed = inside + 4 * HOUR;
    const stats = computeReviewFlow(
      [
        pr({ number: 1, createdAt: inside, closedAt: closed, reviews: [review("bob", closed)] }),
        pr({ number: 2, createdAt: inside, closedAt: closed, reviews: [review("bob", closed + 1)] }),
        pr({ number: 3, createdAt: inside, mergedAt: closed, closedAt: closed, reviews: [review("bob", closed + HOUR)] }),
      ],
      W,
    );
    assert.equal(stats.time_to_first_review.count, 1);
    assert.equal(stats.time_to_first_review.unreviewed, 2);
    assert.equal(stats.time_to_merge.merged_without_review, 1);
  });
});

describe("percentiles", () => {
  it("interpolates between ranks", () => {
    assert.equal(quantile([], 0.5), null);
    assert.equal(quantile([7], 0.9), 7);
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
    assert.ok(Math.abs(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)! - 9.1) < 1e-9);
    assert.equal(quantile([9, 10, 100], 0.5), 10);
  });
});

describe("reviewer load", () => {
  const reviewed = (number: number, ...logins: string[]) =>
    pr({ number, createdAt: inside, reviews: logins.map((login) => review(login, inside + HOUR)) });

  it("counts one pair per reviewer and PR", () => {
    const stats = computeReviewFlow([reviewed(1, "bob", "bob", "bob"), reviewed(2, "bob", "carol"), reviewed(3, "dave")], W);
    assert.equal(stats.reviewers.review_pairs, 4);
    assert.deepEqual(stats.reviewers.top, [
      { login: "bob", prs_reviewed: 2, share: 0.5 },
      { login: "carol", prs_reviewed: 1, share: 0.25 },
      { login: "dave", prs_reviewed: 1, share: 0.25 },
    ]);
    assert.equal(stats.reviewers.for_half, 1);
  });

  it("finds the smallest group that did half the reviews", () => {
    const logins = Array.from({ length: 25 }, (_, i) => `user${String(i).padStart(2, "0")}`);
    const stats = computeReviewFlow(logins.map((login, i) => reviewed(i + 1, login)), W);
    assert.equal(stats.reviewers.for_half, 13);
    assert.equal(stats.reviewers.active, 25);
    assert.equal(stats.reviewers.top.length, 10);
    assert.equal(stats.reviewers.top[0]!.login, "user00");
  });

  it("returns nulls, not NaN, for an empty window", () => {
    const stats = computeReviewFlow([], W);
    assert.equal(stats.reviewers.for_half, null);
    assert.equal(stats.time_to_first_review.median_hours, null);
    assert.equal(stats.time_to_merge.p90_hours, null);
    assert.deepEqual(stats.reviewers.top, []);
  });
});

describe("audit rows", () => {
  it("give the same counts and median as the summary", () => {
    const prs = [];
    for (let n = 1; n <= 9; n++) {
      prs.push(
        pr({
          number: n,
          author: n % 3 === 0 ? "bot" : `dev${n}`,
          authorIsBot: n % 3 === 0,
          createdAt: inside - n * HOUR,
          mergedAt: n % 2 === 0 ? inside + n * HOUR : null,
          closedAt: n % 2 === 0 ? inside + n * HOUR : null,
          reviews: n === 5 ? [] : [review("rev", inside - n * HOUR + (n * 37 + 11) * 60_000)],
        }),
      );
    }
    const period = { from: W.from, to: W.to, prevFrom: W.from - 10 * DAY };
    const rows = pullsReport("o/r", period, prs, NOW).pulls;
    const stats = computeReviewFlow(prs, W);

    assert.equal(rows.filter((r) => r.in.opened).length, stats.pull_requests.opened);
    assert.equal(rows.filter((r) => r.in.merge).length, stats.pull_requests.merged);
    const waits = rows
      .filter((r) => r.in.first_review && r.hours_to_first_review !== null)
      .map((r) => r.hours_to_first_review!)
      .sort((a, b) => a - b);
    assert.equal(waits.length, stats.time_to_first_review.count);
    assert.equal(Math.round(quantile(waits, 0.5)! * 100) / 100, stats.time_to_first_review.median_hours);
    assert.equal(rows[0]!.url, "https://github.com/o/r/pull/8");
  });
});
