# Notes

## How to run

Follow the [Quickstart in the README](README.md#quickstart-docker). In short: copy `.env.example` to `.env`, write a read-only GitHub token in it, and run `docker compose up --build`. Then open http://localhost:3000.

## Architecture

A data request goes through four steps. First, `params.ts` checks the owner, the repository name and the dates. This happens before any I/O. Second, `sync.ts` makes sure that SQLite holds every PR that changed since the start of the previous period. It calls GitHub only when the local data is older than 5 minutes, and then it reads only the PRs that changed since the last sync. One GraphQL query gets 50 PRs with their authors, draft history and reviews. Third, `db.ts` stores the rows and loads them again. Fourth, `metrics.ts` calculates the numbers. It is a pure function that takes rows and a time window. The same function gives the current and the previous period, and the audit rows use the same per-PR logic. So the three data views cannot disagree.

The narrative is a layer on top of the numbers. `narrative.ts` changes the review-flow response into a flat map of fact keys and values. It sends only this map to Claude, as JSON data. The model never sees a PR title, body or comment, because the service never reads them from GitHub. Claude answers in a fixed JSON schema (structured outputs), and the server checks the answer again with zod. Then the server compares each evidence value with its own facts and marks the item `verified` or not. The narrative is stored under a hash of all call inputs, so the same numbers do not cause a second model call. `app.ts` holds the HTTP rules: problem+json errors, rate limits, security headers and cache headers.

## Why this metric

The wait for a first review is the delay that a contributor feels most. A long wait often has one cause: a small group of people does most of the reviews. So the service shows the wait and the review load together, with the previous period as a baseline. With these three signals, the model can give a cause that the numbers support, for example "the median wait doubled while one reviewer did 64% of the reviews". The clock starts when a PR is ready for review, so time as a draft does not count against the reviewers. The median shows the normal case, and p90 shows the slow tail.

## Decisions and trade-offs

- **GraphQL, not REST.** One GraphQL call gets 50 PRs and their reviews. With REST, each PR needs one more call for its reviews.
- **Sync on request, not a background worker.** One curl call gives a result, with no job to poll. Fixed limits keep the cost small: 40 pages (2,000 PRs) for each sync, a period of 90 days or less, and a start date in the last 365 days. A request above the page limit gets 422 at once, not a long wait. A repeat of that request in the next 5 minutes makes no GitHub call.
- **Incremental sync.** After the first sync, the service reads PRs in order of last update. It stops at the time of the last sync, minus 5 minutes. The 5 minutes cover a clock difference between GitHub and this server.
- **SQLite with better-sqlite3.** The queries are small and indexed, so the synchronous driver does not block the event loop for long. A page write is one transaction.
- **A GitHub rate limit gives 503, not 429.** The client did not go over our limit. Our own limit gives 429.
- **The narrative is a GET.** It reads a derived resource, and the cache makes it repeatable. HEAD is off on this route, and its rate limit is lower (10 for each minute), because each new call costs money.
- **Only cited evidence is checked.** The server does not parse numbers in the summary text. The prompt tells the model to use only numbers from the facts.
- **No server-side refusal fallback.** It needs a beta API surface, and the input is only numbers and logins. A refusal gives 502 `llm_error`.
- **No build step for the server.** Node 22.18 runs TypeScript directly. `tsc` only checks types.
- **`ignore-scripts=true` in `.npmrc`.** No dependency needs an install script. The setting removes a compile step for the SQLite driver (which then needs Python and a C compiler), and it stops third-party install scripts.
- **Rate limits are in memory and per client address.** Behind Docker or a proxy, all clients can share one address. A shared deployment must set Fastify `trustProxy` to the real proxy.

## Known limits

- During the first sync of a repository, a PR can change and move above the cursor. Then it is not in that first response. The next sync gets it.
- Bot detection uses the GitHub actor type `Bot`. A bot that uses a normal user account counts as a person.
- The service reads the first 100 reviews of each PR. The response counts the PRs with more.
- A login that does not match GitHub's login rules counts as a deleted user. This makes sure that only safe strings go to the model.
- Times are wall-clock hours. They do not remove nights or weekends.

## Things I chose not to do

- A background worker, or `POST /sync` with 202 and a status endpoint.
- A REST fallback, a second integration and webhooks.
- PR titles, bodies and comments. No metric needs them, and they are the main prompt-injection risk.
- ETag and 304. `data_as_of` changes on each sync, and the cache headers and the server cache cover the common case.
- Authentication and a repository allowlist. This is a local tool. An allowlist is the first change before the service is shared.
- Old data when GitHub fails. Now the service returns 502 or 503.
- An evaluation suite for the prompt.

## What I would do next with one more day

1. Add a small evaluation suite for the narrative prompt. Use fixture data with known patterns, and check the share of verified evidence, the confidence range and the schema.
2. Add a background sync with a job status, for large repositories.
3. Add a weekly trend inside the period, so the model can see when a change started.
4. Add API keys and a repository allowlist before anyone shares the service.
5. Move rate limits and the store behind a shared backend (for example Postgres or Redis) for more than one instance.

## Things built beyond the brief

- The previous period in every response, as a baseline for "unusual".
- A server check of each evidence item, with `verified: true` or `false`.
- The audit endpoint `/review-flow/pulls`, so a reviewer can check a median by hand.
- A one-page React UI.
- A container that runs as a non-root user with a read-only file system.

## AI usage

I used Claude Code for most of the work. It asked me questions about scope first. Then it wrote three independent designs, had them reviewed for overengineering and for correctness, and merged the result into a plan. I made the main decisions: GitHub as the source, review flow as the metric, sync on request, the previous-period baseline and the audit endpoint. Claude Code wrote most of the code, the tests and these documents. It checked the Anthropic SDK API in the installed package and did not rely on memory. I reviewed the code and the plan.

Its build environment could not reach the GitHub GraphQL API or the Claude API. So the tests use fake clients and fixtures in the documented GitHub response shape. The live checks are in the README, in the section "Check the numbers".
