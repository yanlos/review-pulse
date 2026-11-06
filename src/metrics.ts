import type { PrRow, ReviewRow } from "./github.ts";
import type { Period } from "./params.ts";

const HOUR_MS = 3_600_000;
export const TOP_N = 10;

// [from, to): an event at "from" is in the window, an event at "to" is not.
export type Window = { from: number; to: number };

export type FlowStats = {
  pull_requests: { opened: number; merged: number; closed_unmerged: number };
  time_to_first_review: { count: number; unreviewed: number; median_hours: number | null; p90_hours: number | null };
  time_to_merge: { count: number; median_hours: number | null; p90_hours: number | null; merged_without_review: number };
  reviewers: {
    active: number;
    review_pairs: number;
    for_half: number | null;
    top: { login: string; prs_reviewed: number; share: number }[];
  };
  contributors: { active: number; top: { login: string; prs_merged: number; prs_opened: number }[] };
  excluded: { bot_prs_opened: number; bot_prs_merged: number };
};

export type ReviewFlowReport = {
  repo: string;
  period: { from: string; to: string; complete: boolean };
  previous_period: { from: string; to: string };
  data_as_of: string;
  current: FlowStats;
  previous: FlowStats;
  prs_with_truncated_reviews: number;
};

export type PullRow = {
  number: number;
  url: string;
  author: string | null;
  created_at: string;
  ready_at: string | null;
  first_review_at: string | null;
  merged_at: string | null;
  hours_to_first_review: number | null;
  hours_to_merge: number | null;
  in: { opened: boolean; first_review: boolean; merge: boolean };
};

export type PullsReport = {
  repo: string;
  period: { from: string; to: string; complete: boolean };
  data_as_of: string;
  pulls: PullRow[];
};

type Derived = { firstReviewAt: number | null; firstReviewMs: number | null; mergeMs: number | null };

function inWindow(time: number | null, w: Window): time is number {
  return time !== null && time >= w.from && time < w.to;
}

function sameLogin(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

function qualifies(review: ReviewRow, pr: PrRow): boolean {
  return !review.reviewerIsBot && !sameLogin(review.reviewer, pr.author);
}

// A review counts only before the PR closes and before the window ends. So the current and the
// previous period give each PR the same chance, and old periods do not collect late reviews.
function derive(pr: PrRow, end: number): Derived {
  const limit = pr.mergedAt ?? pr.closedAt ?? Infinity;
  let first: number | null = null;
  for (const review of pr.reviews) {
    const counts = qualifies(review, pr) && review.submittedAt <= limit && review.submittedAt < end;
    if (counts && (first === null || review.submittedAt < first)) {
      first = review.submittedAt;
    }
  }
  return {
    firstReviewAt: first,
    // The clock starts when the PR is ready for review, so time as a draft does not count.
    firstReviewMs: first !== null && pr.readyAt !== null ? Math.max(0, first - pr.readyAt) : null,
    mergeMs: pr.mergedAt !== null ? Math.max(0, pr.mergedAt - (pr.readyAt ?? pr.createdAt)) : null,
  };
}

// Linear interpolation between the closest ranks (the same as PERCENTILE.INC in a spreadsheet).
export function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const low = sorted[lo]!;
  const high = sorted[Math.ceil(h)]!;
  return low + (h - lo) * (high - low);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function hours(ms: number | null, digits = 2): number | null {
  return ms === null ? null : round(ms / HOUR_MS, digits);
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function isoOrNull(time: number | null): string | null {
  return time === null ? null : iso(time);
}

export function computeReviewFlow(prs: PrRow[], w: Window): FlowStats {
  let opened = 0;
  let merged = 0;
  let closedUnmerged = 0;
  let botOpened = 0;
  let botMerged = 0;
  let unreviewed = 0;
  let mergedWithoutReview = 0;
  const firstReview: number[] = [];
  const merge: number[] = [];
  const prsPerReviewer = new Map<string, number>();
  const authors = new Map<string, { merged: number; opened: number }>();
  const bump = (login: string | null, field: "merged" | "opened") => {
    if (login === null) return;
    const stats = authors.get(login) ?? { merged: 0, opened: 0 };
    stats[field]++;
    authors.set(login, stats);
  };

  for (const pr of prs) {
    if (pr.authorIsBot) {
      if (inWindow(pr.createdAt, w)) botOpened++;
      if (inWindow(pr.mergedAt, w)) botMerged++;
      continue;
    }
    const d = derive(pr, w.to);
    if (inWindow(pr.createdAt, w)) {
      opened++;
      bump(pr.author, "opened");
    }
    if (inWindow(pr.mergedAt, w)) {
      merged++;
      bump(pr.author, "merged");
      merge.push(d.mergeMs!);
      if (d.firstReviewAt === null) mergedWithoutReview++;
    }
    if (pr.mergedAt === null && inWindow(pr.closedAt, w)) closedUnmerged++;
    if (inWindow(pr.readyAt, w)) {
      if (d.firstReviewMs === null) unreviewed++;
      else firstReview.push(d.firstReviewMs);
    }

    const reviewers = new Set<string>();
    for (const review of pr.reviews) {
      if (review.reviewer !== null && qualifies(review, pr) && inWindow(review.submittedAt, w)) {
        reviewers.add(review.reviewer);
      }
    }
    for (const login of reviewers) prsPerReviewer.set(login, (prsPerReviewer.get(login) ?? 0) + 1);
  }

  firstReview.sort((a, b) => a - b);
  merge.sort((a, b) => a - b);

  const ranked = [...prsPerReviewer].sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]));
  const pairs = ranked.reduce((sum, [, n]) => sum + n, 0);
  let forHalf: number | null = null;
  for (let i = 0, sum = 0; i < ranked.length; i++) {
    sum += ranked[i]![1];
    if (sum * 2 >= pairs) {
      forHalf = i + 1;
      break;
    }
  }

  const contributors = [...authors].sort(
    (a, b) => b[1].merged - a[1].merged || b[1].opened - a[1].opened || byCodePoint(a[0], b[0]),
  );

  return {
    pull_requests: { opened, merged, closed_unmerged: closedUnmerged },
    time_to_first_review: {
      count: firstReview.length,
      unreviewed,
      median_hours: hours(quantile(firstReview, 0.5)),
      p90_hours: hours(quantile(firstReview, 0.9)),
    },
    time_to_merge: {
      count: merge.length,
      median_hours: hours(quantile(merge, 0.5)),
      p90_hours: hours(quantile(merge, 0.9)),
      merged_without_review: mergedWithoutReview,
    },
    reviewers: {
      active: ranked.length,
      review_pairs: pairs,
      for_half: forHalf,
      top: ranked
        .slice(0, TOP_N)
        .map(([login, n]) => ({ login, prs_reviewed: n, share: round(n / pairs, 3) })),
    },
    contributors: {
      active: contributors.length,
      top: contributors
        .slice(0, TOP_N)
        .map(([login, s]) => ({ login, prs_merged: s.merged, prs_opened: s.opened })),
    },
    excluded: { bot_prs_opened: botOpened, bot_prs_merged: botMerged },
  };
}

export function reviewFlowReport(repo: string, period: Period, prs: PrRow[], dataAsOf: number): ReviewFlowReport {
  return {
    repo,
    period: { from: iso(period.from), to: iso(period.to), complete: period.to <= dataAsOf },
    previous_period: { from: iso(period.prevFrom), to: iso(period.from) },
    data_as_of: iso(dataAsOf),
    current: computeReviewFlow(prs, { from: period.from, to: period.to }),
    previous: computeReviewFlow(prs, { from: period.prevFrom, to: period.from }),
    prs_with_truncated_reviews: prs.filter((pr) => pr.reviewsTruncated && !pr.authorIsBot && pr.createdAt < period.to).length,
  };
}

export function pullsReport(repo: string, period: Period, prs: PrRow[], dataAsOf: number): PullsReport {
  const w = { from: period.from, to: period.to };
  const pulls: PullRow[] = [];
  for (const pr of prs) {
    if (pr.authorIsBot) continue;
    const flags = {
      opened: inWindow(pr.createdAt, w),
      first_review: inWindow(pr.readyAt, w),
      merge: inWindow(pr.mergedAt, w),
    };
    if (!flags.opened && !flags.first_review && !flags.merge) continue;
    const d = derive(pr, w.to);
    pulls.push({
      number: pr.number,
      url: `https://github.com/${repo}/pull/${pr.number}`,
      author: pr.author,
      created_at: iso(pr.createdAt),
      ready_at: isoOrNull(pr.readyAt),
      first_review_at: isoOrNull(d.firstReviewAt),
      merged_at: isoOrNull(pr.mergedAt),
      hours_to_first_review: hours(d.firstReviewMs, 4),
      hours_to_merge: hours(d.mergeMs, 4),
      in: flags,
    });
  }
  pulls.sort((a, b) => b.number - a.number);
  return {
    repo,
    period: { from: iso(period.from), to: iso(period.to), complete: period.to <= dataAsOf },
    data_as_of: iso(dataAsOf),
    pulls,
  };
}
