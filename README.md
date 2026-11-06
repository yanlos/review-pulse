# review-pulse

review-pulse is a small web service. It shows how code review flows in a public GitHub repository.

For a date range, it tells you:

- How long a pull request (PR) waits for its first review.
- How long a PR takes to merge.
- How many people do most of the reviews.
- Who reviews and who contributes the most.

Each number comes with the same number for the previous period of the same length. A second endpoint sends the numbers to Claude. Claude writes a short explanation with a possible cause, a confidence score and evidence. The server checks each evidence value against its own numbers.

The service reads data from the GitHub GraphQL API. It keeps the data in SQLite, so a repeated request does not call GitHub again.

## Quickstart (Docker)

You need Docker with Docker Compose and a GitHub token.

1. Create a fine-grained personal access token on GitHub. Give it read-only access to public repositories.
2. Copy the file `.env.example` to `.env`.
3. Write the token after `GITHUB_TOKEN=` in `.env`.
4. Optional: write an Anthropic API key after `ANTHROPIC_API_KEY=`. The narrative endpoint needs it.
5. Start the service:

   ```bash
   docker compose up --build
   ```

6. Get the review flow for the last 30 days:

   ```bash
   curl -s localhost:3000/api/repos/fastify/fastify/review-flow | jq
   ```

7. Get the narrative:

   ```bash
   curl -s localhost:3000/api/repos/fastify/fastify/review-flow/narrative | jq
   ```

8. Open http://localhost:3000 to use the web page.

The first request for a repository gets data from GitHub. This takes some seconds. For the next 5 minutes, requests for that repository use only the local data, if their period does not start earlier.

## Run without Docker

You need Node.js 22.18 or later.

```bash
npm ci
```

```bash
npm run build
```

```bash
npm start
```

The server reads `.env` and listens on `127.0.0.1:3000`. For UI work, run `npm run dev` and `npm run dev:ui` in two terminals. Vite then serves the page on port 5173.

The file `.npmrc` sets `ignore-scripts=true`. No dependency needs an install script. With this setting, npm does not compile the SQLite driver. The driver uses its prebuilt binary, so you do not need Python or a C compiler.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | Yes | | GitHub token with read-only access to public repositories |
| `ANTHROPIC_API_KEY` | No | | Turns on the narrative endpoint |
| `ANTHROPIC_MODEL` | No | `claude-opus-5-5` | Claude model for the narrative |
| `PORT` | No | `3000` | HTTP port |
| `HOST` | No | `127.0.0.1` | Listen address. The Docker image uses `0.0.0.0` |

The database file is `data/review-pulse.db`. It is a cache. You can delete it at any time.

## API

All routes use `GET`. The query parameters `from` and `to` are optional. They are UTC dates in the format `YYYY-MM-DD`, and both days are in the period. The default period is the last 30 days, today included.

| Route | Returns |
|---|---|
| `/api/repos/{owner}/{repo}/review-flow` | The review flow numbers for the period and the previous period |
| `/api/repos/{owner}/{repo}/review-flow/pulls` | One row for each PR opened, ready or merged in the period. Use the rows to check the counts and the times |
| `/api/repos/{owner}/{repo}/review-flow/narrative` | A short explanation from Claude, with checked evidence |
| `/healthz` | `{"status":"ok"}` |

The service answers only for public repositories. For a private repository, it returns 404, also when the token can read it.

Rules for the period:

- `from` must be on or before `to`.
- `to` must not be after today.
- The period must not be longer than 90 days.
- `from` must not be more than 365 days before today.

The previous period has the same length and ends where the period starts. For example, `from=2026-10-01&to=2026-10-31` includes October 31. It has 31 days, so its previous period is August 31 to September 30.

### Example

```bash
curl -s "localhost:3000/api/repos/fastify/fastify/review-flow?from=2026-10-08&to=2026-11-06" | jq
```

Example output (shortened):

```json
{
  "repo": "fastify/fastify",
  "period": { "from": "2026-10-08T00:00:00.000Z", "to": "2026-11-07T00:00:00.000Z", "complete": false },
  "previous_period": { "from": "2026-09-08T00:00:00.000Z", "to": "2026-10-08T00:00:00.000Z" },
  "data_as_of": "2026-11-06T12:00:00.000Z",
  "current": {
    "pull_requests": { "opened": 53, "merged": 44, "closed_unmerged": 0 },
    "time_to_first_review": { "count": 46, "unreviewed": 7, "median_hours": 37.38, "p90_hours": 54.97 },
    "time_to_merge": { "count": 44, "median_hours": 50.45, "p90_hours": 73.49, "merged_without_review": 0 },
    "reviewers": {
      "active": 7, "review_pairs": 47, "for_half": 1,
      "top": [{ "login": "alice", "prs_reviewed": 30, "share": 0.638 }]
    },
    "contributors": { "active": 7, "top": [{ "login": "bob", "prs_merged": 7, "prs_opened": 8 }] },
    "excluded": { "bot_prs_opened": 7, "bot_prs_merged": 3 }
  },
  "previous": { "...": "the same fields" },
  "prs_with_truncated_reviews": 0
}
```

The period `to` time is exclusive: `2026-11-07T00:00:00Z` is the end of November 6. `period.complete` is `false` while the period has not ended.

### Narrative

The narrative response has `summary`, `hypothesis` (or `null`), `confidence` (0 to 1) and `evidence`. Each evidence item names a fact key and a value. The server sets `verified` to `true` only when the value is equal to its own number. The response also contains `facts`: the exact data that the server sent to Claude.

A fact key is a path into the review-flow response. For example, `current.reviewers.top.0.share` is the same value as `jq '.current.reviewers.top[0].share'`.

When the period has no activity, the server does not call Claude. It sends a fixed text, and `model` is `null`.

The server keeps each narrative. The same numbers with the same model and prompt give the stored narrative, with `cached: true`.

### Errors

Errors use `application/problem+json` (RFC 9457):

```json
{ "type": "about:blank", "title": "Bad Request", "status": 400,
  "detail": "'from' is not a real calendar date.", "code": "invalid_parameter", "request_id": "..." }
```

| Status | `code` | Cause |
|---|---|---|
| 400 | `invalid_parameter` | Incorrect owner, repository name, date, period or URL |
| 404 | `repo_not_found` | GitHub has no public repository with this name |
| 404 | `not_found` | No route has this path |
| 422 | `sync_too_large` | More than 2,000 PRs changed between the start of the previous period and now. Use a more recent period |
| 429 | `rate_limited` | More than 60 requests in a minute, or more than 10 narrative requests. See `Retry-After` |
| 502 | `upstream_error` | GitHub sent an error or an unexpected response |
| 502 | `upstream_auth_failed` | GitHub did not accept the token |
| 502 | `llm_error` | Claude did not give a usable answer |
| 503 | `upstream_rate_limited` | The GitHub rate limit is used up. See `Retry-After` |
| 503 | `llm_not_configured` | The server has no `ANTHROPIC_API_KEY` |
| 503 | `llm_rate_limited` | Claude is busy. See `Retry-After` |
| 504 | `upstream_timeout`, `llm_timeout` | GitHub or Claude did not answer in time |
| 500 | `internal` | An unexpected error on the server. The log has the details |

## Metric definitions

All times are UTC. A period starts at 00:00 on `from` and ends before 00:00 on the day after `to`.

- **Bots.** A PR from a bot account is not in any metric. The `excluded` block counts these PRs. A review from a bot does not count.
- **Review.** A submitted PR review of any state counts: approved, changes requested, commented or dismissed. A plain issue comment is not a review. The PR author cannot review their own PR.
- **Ready time.** A PR is ready when it opens as a non-draft PR, or when it leaves draft for the first time.
- **`pull_requests`.** `opened` counts PRs created in the period. `merged` counts PRs merged in the period. `closed_unmerged` counts PRs closed in the period without a merge.
- **`time_to_first_review`.** This uses the PRs that became ready in the period. The time is from ready time to the first review. A review before ready time gives 0 hours. A review after the PR closed does not count. A review after the end of the period does not count. This gives the PRs in the current and the previous period the same chance. `count` is the number of reviewed PRs. `unreviewed` is the number of PRs with no review. The median and p90 use the reviewed PRs only.
- **`time_to_merge`.** This uses the PRs merged in the period. The time is from ready time to merge. `merged_without_review` counts merges with no review before the merge.
- **`reviewers`.** The unit is one reviewer on one PR. Five review rounds by one person on one PR count one time. `review_pairs` is the total of these units in the period. `share` is the part of the total for one reviewer. `for_half` is the smallest number of reviewers who together did half of all reviews.
- **`contributors`.** PRs merged and PRs opened in the period, for each author.
- **Percentiles.** The median and p90 use linear interpolation. This is the same as `PERCENTILE.INC` in a spreadsheet.
- **Deleted users.** GitHub shows deleted users as `ghost`. Their PRs count in `pull_requests`, and their reviews count in the times. They are not in `reviewers` or `contributors`, so `review_pairs` and `share` do not include their reviews.
- **More than 100 reviews.** The service reads the first 100 reviews of each PR. `prs_with_truncated_reviews` counts PRs with more. The first review time is still correct for these PRs.

## Check the numbers

1. Compare the PR counts with GitHub search. For the period 2026-10-08 to 2026-11-06, search for `repo:fastify/fastify is:pr created:2026-10-08T00:00:00Z..2026-11-06T23:59:59Z`. The result must be equal to `opened + excluded.bot_prs_opened`.
2. Do the same check for merges. Search for `repo:fastify/fastify is:pr merged:2026-10-08T00:00:00Z..2026-11-06T23:59:59Z`. The result must be equal to `merged + excluded.bot_prs_merged`.
3. Get the rows behind the times:

   ```bash
   curl -s "localhost:3000/api/repos/fastify/fastify/review-flow/pulls?from=2026-10-08&to=2026-11-06" | jq '.pulls[:5]'
   ```

4. Open some PRs from the rows on GitHub. Compare the first review time and the merge time with the PR page.
5. Calculate the median of `hours_to_first_review` for the rows with `in.first_review` equal to `true`. Do not use the rows where the value is `null`. Round the result to 2 decimal places. It must be equal to `current.time_to_first_review.median_hours`. A difference of 0.01 is possible, because each row is rounded to 4 decimal places.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

The tests use fake GitHub and Claude clients and a real SQLite database in memory. They do not need a network connection.
