import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openStore } from "../src/db.ts";
import { HttpError } from "../src/errors.ts";
import type { GithubClient, Page, PrRow } from "../src/github.ts";
import type { RepoRef } from "../src/params.ts";
import { createSyncer, MAX_PAGES, SYNC_TTL_MS } from "../src/sync.ts";
import { DAY, HOUR, NOW, pr, review, silentLog } from "./fixtures.ts";

const REPO: RepoRef = { owner: "o", name: "r", key: "o/r" };

// Five pages of two PRs each. PR n was last updated n days before NOW, so the list is newest first.
function fakeGithub(pages = 5, perPage = 2) {
  const calls: (string | null)[] = [];
  const github: GithubClient = {
    async fetchPage(_owner, _name, cursor) {
      calls.push(cursor);
      const index = cursor === null ? 0 : Number(cursor);
      const rows: PrRow[] = [];
      for (let i = 0; i < perPage; i++) {
        const n = index * perPage + i + 1;
        rows.push(pr({ number: n, updatedAt: NOW - n * DAY, createdAt: NOW - n * DAY }));
      }
      const page: Page = {
        rows,
        hasNextPage: index + 1 < pages,
        endCursor: String(index + 1),
        cost: 1,
        remaining: 4999,
      };
      return page;
    },
  };
  return { github, calls };
}

function setup(github: GithubClient) {
  const store = openStore(":memory:");
  let clock = NOW;
  const syncer = createSyncer({ store, github, now: () => clock });
  return {
    store,
    sync: (since: number) => syncer.ensureSynced(REPO, since, silentLog),
    advance: (ms: number) => (clock += ms),
    syncer,
  };
}

describe("sync stop rule and freshness", () => {
  it("walks only until it passes the requested start", async () => {
    const { github, calls } = fakeGithub();
    const { store, sync } = setup(github);
    await sync(NOW - 3.5 * DAY);
    assert.equal(calls.length, 2);
    assert.deepEqual(store.getRepoState("o/r"), { coveredSince: NOW - 3.5 * DAY, syncedAt: NOW });
    assert.equal(store.loadPrs("o/r", 0).length, 4);
  });

  it("makes no call while the data is fresh, then fetches only what changed", async () => {
    const { github, calls } = fakeGithub();
    const { store, sync, advance } = setup(github);
    await sync(NOW - 3.5 * DAY);
    await sync(NOW - 3.5 * DAY);
    assert.equal(calls.length, 2);

    advance(SYNC_TTL_MS + 1);
    await sync(NOW - 3.5 * DAY);
    assert.equal(calls.length, 3, "the walk stops on page 1, near the last sync");
    assert.equal(store.getRepoState("o/r")?.coveredSince, NOW - 3.5 * DAY);
    assert.equal(store.getRepoState("o/r")?.syncedAt, NOW + SYNC_TTL_MS + 1);
  });

  it("walks further back when an earlier start is requested", async () => {
    const { github, calls } = fakeGithub();
    const { store, sync } = setup(github);
    await sync(NOW - 1.5 * DAY);
    assert.equal(calls.length, 1);
    await sync(NOW - 7.5 * DAY);
    assert.equal(calls.length, 1 + 4);
    assert.equal(store.getRepoState("o/r")?.coveredSince, NOW - 7.5 * DAY);
  });

  it("does not walk deeper than the request after a long idle time", async () => {
    const { github, calls } = fakeGithub();
    const { store, sync, advance } = setup(github);
    await sync(NOW - 9.5 * DAY);
    advance(30 * DAY);
    calls.length = 0;
    await sync(NOW + 29.5 * DAY - 3.5 * DAY);
    assert.equal(calls.length, 1);
    assert.equal(store.getRepoState("o/r")?.coveredSince, NOW + 26 * DAY);
  });
});

describe("sync safety", () => {
  it("runs one walk for concurrent requests", async () => {
    const { github, calls } = fakeGithub();
    const { sync } = setup(github);
    await Promise.all([sync(NOW - 3.5 * DAY), sync(NOW - 3.5 * DAY), sync(NOW - 3.5 * DAY)]);
    assert.equal(calls.length, 2);
  });

  it("stops at the page cap, keeps coverage unchanged and remembers the failure", async () => {
    const { github, calls } = fakeGithub(1000, 1);
    const { store, sync } = setup(github);
    await assert.rejects(sync(NOW - 300 * DAY), (err: HttpError) => err.status === 422 && err.code === "sync_too_large");
    assert.equal(calls.length, MAX_PAGES);
    assert.equal(store.getRepoState("o/r"), undefined);
    await assert.rejects(sync(NOW - 300 * DAY), (err: HttpError) => err.status === 422);
    assert.equal(calls.length, MAX_PAGES, "the repeat makes no GitHub call");
  });

  it("writes no state when a page fails", async () => {
    let n = 0;
    const github: GithubClient = {
      async fetchPage() {
        if (n++ > 0) throw new HttpError(502, "upstream_error", "bad");
        return { rows: [pr({ number: 1, updatedAt: NOW })], hasNextPage: true, endCursor: "1", cost: 1, remaining: 1 };
      },
    };
    const { store, sync } = setup(github);
    await assert.rejects(sync(NOW - DAY), (err: HttpError) => err.status === 502);
    assert.equal(store.getRepoState("o/r"), undefined);
  });

  it("replaces reviews on a new sync, so nothing counts twice", () => {
    const store = openStore(":memory:");
    const first = pr({ number: 1, reviews: [review("bob", NOW - HOUR), review("carol", NOW)] });
    store.upsertPage("o/r", [first]);
    store.upsertPage("o/r", [first]);
    store.upsertPage("o/r", [{ ...first, reviews: [review("bob", NOW - HOUR)] }]);
    const rows = store.loadPrs("o/r", 0);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.reviews, [review("bob", NOW - HOUR)]);
  });
});
