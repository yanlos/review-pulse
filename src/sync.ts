import type { FastifyBaseLogger } from "fastify";
import type { Store } from "./db.ts";
import { HttpError } from "./errors.ts";
import { PAGE_SIZE, type GithubClient } from "./github.ts";
import type { RepoRef } from "./params.ts";

export const SYNC_TTL_MS = 5 * 60_000;
// GitHub and this server use different clocks. The overlap makes sure that no update falls between two syncs.
const OVERLAP_MS = 5 * 60_000;
export const MAX_PAGES = 40;

export type Syncer = {
  ensureSynced(repo: RepoRef, since: number, log: FastifyBaseLogger): Promise<void>;
};

export function createSyncer(deps: { store: Store; github: GithubClient; now: () => number }): Syncer {
  const { store, github, now } = deps;
  const running = new Map<string, Promise<void>>();
  const failedWalks = new Map<string, { stopAt: number; at: number }>();

  function isFresh(key: string, since: number): boolean {
    const state = store.getRepoState(key);
    return state !== undefined && state.coveredSince <= since && now() - state.syncedAt < SYNC_TTL_MS;
  }

  async function walk(repo: RepoRef, since: number, log: FastifyBaseLogger): Promise<void> {
    const state = store.getRepoState(repo.key);
    const covered = state !== undefined && state.coveredSince <= since ? state : undefined;
    const stopAt = covered ? Math.max(since, covered.syncedAt - OVERLAP_MS) : since;

    const failed = failedWalks.get(repo.key);
    if (failed && now() - failed.at < SYNC_TTL_MS && failed.stopAt >= stopAt) throw tooLarge(stopAt);

    const startedAt = now();
    let cursor: string | null = null;
    let oldestSeen = Infinity;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        failedWalks.set(repo.key, { stopAt, at: now() });
        // The stored pages still cover everything updated after the oldest row, so a shorter period can use them.
        if (state === undefined) store.setRepoState(repo.key, { coveredSince: oldestSeen + 1, syncedAt: startedAt });
        throw tooLarge(stopAt);
      }
      const t0 = performance.now();
      const result = await github.fetchPage(repo.owner, repo.name, cursor);
      store.upsertPage(repo.key, result.rows);
      log.info(
        {
          repo: repo.key,
          page,
          nodes: result.rows.length,
          cost: result.cost,
          remaining: result.remaining,
          ms: Math.round(performance.now() - t0),
        },
        "github page",
      );
      const last = result.rows.at(-1);
      if (last !== undefined) oldestSeen = last.updatedAt;
      if (!result.hasNextPage || last === undefined || last.updatedAt < stopAt) break;
      cursor = result.endCursor;
    }

    // Keep the old coverage only when this walk reached back to the last sync.
    const coveredSince = covered && stopAt > since ? covered.coveredSince : since;
    store.setRepoState(repo.key, { coveredSince, syncedAt: startedAt });
    failedWalks.delete(repo.key);
  }

  return {
    async ensureSynced(repo, since, log) {
      for (let current = running.get(repo.key); current; current = running.get(repo.key)) {
        await current.catch(() => undefined);
      }
      if (isFresh(repo.key, since)) return;
      const job = walk(repo, since, log).finally(() => running.delete(repo.key));
      running.set(repo.key, job);
      return job;
    },
  };
}

function tooLarge(stopAt: number): HttpError {
  const since = new Date(stopAt).toISOString().slice(0, 10);
  return new HttpError(
    422,
    "sync_too_large",
    `More than ${MAX_PAGES * PAGE_SIZE} pull requests changed since ${since}. Choose a shorter or more recent period.`,
  );
}
