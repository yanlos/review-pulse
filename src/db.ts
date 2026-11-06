import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { PrRow, ReviewRow } from "./github.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  repo TEXT PRIMARY KEY,
  covered_since INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pull_requests (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  author TEXT,
  author_is_bot INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  merged_at INTEGER,
  closed_at INTEGER,
  updated_at INTEGER NOT NULL,
  reviews_truncated INTEGER NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS pull_requests_updated ON pull_requests (repo, updated_at);
CREATE TABLE IF NOT EXISTS reviews (
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  reviewer TEXT,
  reviewer_is_bot INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_pr ON reviews (repo, pr_number);
CREATE TABLE IF NOT EXISTS narratives (
  cache_key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// covered_since: every PR with updated_at >= covered_since is stored, current as of synced_at.
export type RepoState = { coveredSince: number; syncedAt: number };

type PrRecord = {
  number: number;
  author: string | null;
  author_is_bot: number;
  created_at: number;
  ready_at: number | null;
  merged_at: number | null;
  closed_at: number | null;
  updated_at: number;
  reviews_truncated: number;
};

type ReviewRecord = { pr_number: number; reviewer: string | null; reviewer_is_bot: number; submitted_at: number };

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const getRepo = db.prepare<[string], { covered_since: number; synced_at: number }>(
    "SELECT covered_since, synced_at FROM repos WHERE repo = ?",
  );
  const setRepo = db.prepare(
    `INSERT INTO repos (repo, covered_since, synced_at) VALUES (?, ?, ?)
     ON CONFLICT (repo) DO UPDATE SET covered_since = excluded.covered_since, synced_at = excluded.synced_at`,
  );
  const upsertPr = db.prepare(
    `INSERT INTO pull_requests
       (repo, number, author, author_is_bot, created_at, ready_at, merged_at, closed_at, updated_at, reviews_truncated)
     VALUES (@repo, @number, @author, @author_is_bot, @created_at, @ready_at, @merged_at, @closed_at, @updated_at, @reviews_truncated)
     ON CONFLICT (repo, number) DO UPDATE SET
       author = excluded.author, author_is_bot = excluded.author_is_bot, created_at = excluded.created_at,
       ready_at = excluded.ready_at, merged_at = excluded.merged_at, closed_at = excluded.closed_at,
       updated_at = excluded.updated_at, reviews_truncated = excluded.reviews_truncated`,
  );
  const deleteReviews = db.prepare("DELETE FROM reviews WHERE repo = ? AND pr_number = ?");
  const insertReview = db.prepare(
    "INSERT INTO reviews (repo, pr_number, reviewer, reviewer_is_bot, submitted_at) VALUES (?, ?, ?, ?, ?)",
  );
  const selectPrs = db.prepare<[string, number], PrRecord>(
    `SELECT number, author, author_is_bot, created_at, ready_at, merged_at, closed_at, updated_at, reviews_truncated
     FROM pull_requests WHERE repo = ? AND updated_at >= ?`,
  );
  const selectReviews = db.prepare<[string, number], ReviewRecord>(
    `SELECT r.pr_number, r.reviewer, r.reviewer_is_bot, r.submitted_at
     FROM reviews r JOIN pull_requests p ON p.repo = r.repo AND p.number = r.pr_number
     WHERE r.repo = ? AND p.updated_at >= ?`,
  );
  const getNarrative = db.prepare<[string], { body: string }>("SELECT body FROM narratives WHERE cache_key = ?");
  const putNarrative = db.prepare(
    "INSERT INTO narratives (cache_key, body, created_at) VALUES (?, ?, ?) ON CONFLICT (cache_key) DO NOTHING",
  );

  const upsertPage = db.transaction((repo: string, rows: PrRow[]) => {
    for (const pr of rows) {
      upsertPr.run({
        repo,
        number: pr.number,
        author: pr.author,
        author_is_bot: pr.authorIsBot ? 1 : 0,
        created_at: pr.createdAt,
        ready_at: pr.readyAt,
        merged_at: pr.mergedAt,
        closed_at: pr.closedAt,
        updated_at: pr.updatedAt,
        reviews_truncated: pr.reviewsTruncated ? 1 : 0,
      });
      deleteReviews.run(repo, pr.number);
      for (const review of pr.reviews) {
        insertReview.run(repo, pr.number, review.reviewer, review.reviewerIsBot ? 1 : 0, review.submittedAt);
      }
    }
  });

  return {
    getRepoState(repo: string): RepoState | undefined {
      const row = getRepo.get(repo);
      return row && { coveredSince: row.covered_since, syncedAt: row.synced_at };
    },
    setRepoState(repo: string, state: RepoState): void {
      setRepo.run(repo, state.coveredSince, state.syncedAt);
    },
    upsertPage(repo: string, rows: PrRow[]): void {
      upsertPage(repo, rows);
    },
    loadPrs(repo: string, since: number): PrRow[] {
      const byNumber = new Map<number, PrRow>();
      for (const r of selectPrs.all(repo, since)) {
        byNumber.set(r.number, {
          number: r.number,
          author: r.author,
          authorIsBot: r.author_is_bot === 1,
          createdAt: r.created_at,
          readyAt: r.ready_at,
          mergedAt: r.merged_at,
          closedAt: r.closed_at,
          updatedAt: r.updated_at,
          reviewsTruncated: r.reviews_truncated === 1,
          reviews: [],
        });
      }
      for (const r of selectReviews.all(repo, since)) {
        const review: ReviewRow = {
          reviewer: r.reviewer,
          reviewerIsBot: r.reviewer_is_bot === 1,
          submittedAt: r.submitted_at,
        };
        byNumber.get(r.pr_number)?.reviews.push(review);
      }
      return [...byNumber.values()];
    },
    getNarrative(key: string): string | undefined {
      return getNarrative.get(key)?.body;
    },
    putNarrative(key: string, body: string, now: number): void {
      putNarrative.run(key, body, now);
    },
    close(): void {
      db.close();
    },
  };
}
