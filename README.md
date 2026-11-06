# review-pulse

Shows how code review flows in a public GitHub repo: how long PRs wait for a first review, how long they take to merge, and who does the reviewing. Each number is compared with the previous period of the same length. An optional endpoint asks Claude what stands out, and the server checks every number it cites.

## Run

You need a GitHub fine-grained token with read-only access to public repos. An Anthropic key is optional and only used for the narrative.

```bash
cp .env.example .env   # add GITHUB_TOKEN, optionally ANTHROPIC_API_KEY
docker compose up --build
```

Open http://localhost:3000.

Without Docker (Node 22.18+): `npm ci && npm run build && npm start`.

## API

```
GET /api/repos/{owner}/{repo}/review-flow?from=YYYY-MM-DD&to=YYYY-MM-DD
GET /api/repos/{owner}/{repo}/review-flow/narrative
GET /api/repos/{owner}/{repo}/review-flow/pulls
GET /healthz
```

Dates are UTC and inclusive. The default is the last 30 days, the maximum is 90. Errors use `application/problem+json`.

```bash
curl -s localhost:3000/api/repos/fastify/fastify/review-flow | jq
```

## Metrics

- **Time to first review:** from ready for review to the first review by someone other than the author. Reviews after the PR closed or after the period ended do not count.
- **Time to merge:** from ready for review to merge.
- **Review load:** `for_half` is the number of reviewers who did half of all reviews.
- Bot PRs and bot reviews are left out.

Median and p90 use linear interpolation (like `PERCENTILE.INC`).

## Checking the numbers

`opened + excluded.bot_prs_opened` should match the GitHub search `repo:owner/name is:pr created:FROM..TO`. The `/pulls` endpoint lists the PRs behind the times.

## Tests

```bash
npm test
```
