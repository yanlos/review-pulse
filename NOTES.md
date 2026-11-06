# Notes

## How to run

See the [README](README.md#run): add a GitHub token to `.env`, run `docker compose up --build`, open http://localhost:3000.

## Architecture

A request is validated first (`params.ts`). Then `sync.ts` makes sure SQLite has every PR that changed since the start of the previous period. It only calls GitHub when the data is older than 5 minutes, and then only for PRs updated since the last sync. One GraphQL query returns 50 PRs with their reviews. `metrics.ts` is a pure function over the stored rows, used for the current period, the previous period and the `/pulls` rows, so the three views always agree.

The narrative sends only the computed numbers to Claude as JSON. PR titles and bodies are never fetched, so there is no prompt injection path through them. Claude answers in a fixed schema, the server checks each cited value against its own numbers and marks it `verified`, and the result is cached by a hash of the inputs.

## Why this metric

The wait for a first review is the delay contributors feel most, and a common cause is a few people doing most of the reviews. Showing both, next to the previous period, gives the model enough to suggest a cause the numbers actually support.

## Trade-offs

- Sync on request instead of a background worker. Simple to run and demo, but large repos hit a 2,000 PR limit and get a 422.
- GraphQL instead of REST, to avoid one extra call per PR for reviews.
- better-sqlite3 is synchronous, but the queries are small and indexed.
- Reviews only count before the period ends, so the current and previous periods are compared fairly.
- Only the cited evidence is checked, not numbers in the summary text.
- Rate limits are in memory and per IP. Fine for one instance, not for a shared deployment.
- Only the first 100 reviews per PR are read. Times are wall-clock hours.

## Next steps

- A small eval suite for the narrative prompt.
- A background sync for large repos.
- A weekly trend inside the period.
- API keys and a repo allowlist before sharing it.

Built beyond the brief: the previous-period baseline, evidence verification, the `/pulls` audit endpoint, the React UI and a hardened container.

## AI usage

I used Claude Code for most of the work: planning, design review, code, tests and docs. I made the main decisions (GitHub, the review flow metric, sync on request, the baseline, the audit endpoint) and reviewed the code. Its sandbox could not reach GitHub or Claude, so I ran the live checks against `fastify/fastify` on my machine.
