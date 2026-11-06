import { useState, type FormEvent } from "react";
import type { FlowStats, PullsReport, ReviewFlowReport } from "../../src/metrics.ts";
import type { Narrative } from "../../src/narrative.ts";

const DAY_MS = 86_400_000;
const day = (offset: number) => new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);

class ApiError extends Error {}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.detail ?? `The request failed with status ${res.status}.`);
  return body as T;
}

function hours(value: number | null): string {
  if (value === null) return "n/a";
  return value >= 48 ? `${(value / 24).toFixed(1)} d` : `${value.toFixed(1)} h`;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function Tile(props: { label: string; value: string; detail: string; previous: string }) {
  return (
    <section className="tile">
      <h3>{props.label}</h3>
      <p className="value">{props.value}</p>
      <p className="detail">{props.detail}</p>
      <p className="previous">Previous period: {props.previous}</p>
    </section>
  );
}

function Tiles({ current: c, previous: p }: { current: FlowStats; previous: FlowStats }) {
  const top = (s: FlowStats) => s.reviewers.top[0];
  return (
    <div className="tiles">
      <Tile
        label="Pull requests"
        value={`${c.pull_requests.opened} opened`}
        detail={`${c.pull_requests.merged} merged, ${c.pull_requests.closed_unmerged} closed without merge`}
        previous={`${p.pull_requests.opened} opened, ${p.pull_requests.merged} merged`}
      />
      <Tile
        label="Time to first review (median)"
        value={hours(c.time_to_first_review.median_hours)}
        detail={`p90 ${hours(c.time_to_first_review.p90_hours)}. ${c.time_to_first_review.count} reviewed, ${c.time_to_first_review.unreviewed} not reviewed`}
        previous={`${hours(p.time_to_first_review.median_hours)}, p90 ${hours(p.time_to_first_review.p90_hours)}`}
      />
      <Tile
        label="Time to merge (median)"
        value={hours(c.time_to_merge.median_hours)}
        detail={`p90 ${hours(c.time_to_merge.p90_hours)}. ${c.time_to_merge.merged_without_review} merged without review`}
        previous={`${hours(p.time_to_merge.median_hours)}, p90 ${hours(p.time_to_merge.p90_hours)}`}
      />
      <Tile
        label="Reviewers who did half the reviews"
        value={c.reviewers.for_half === null ? "n/a" : `${c.reviewers.for_half} of ${c.reviewers.active}`}
        detail={`Top reviewer: ${top(c) ? percent(top(c)!.share) : "n/a"} of reviews`}
        previous={p.reviewers.for_half === null ? "n/a" : `${p.reviewers.for_half} of ${p.reviewers.active}`}
      />
    </div>
  );
}

function Tables({ stats }: { stats: FlowStats }) {
  return (
    <div className="tables">
      <section>
        <h2>Top reviewers</h2>
        <table>
          <thead>
            <tr><th>Login</th><th className="num">PRs reviewed</th><th>Share of reviews</th></tr>
          </thead>
          <tbody>
            {stats.reviewers.top.map((r) => (
              <tr key={r.login}>
                <td>{r.login}</td>
                <td className="num">{r.prs_reviewed}</td>
                <td>
                  <span className="bar" aria-hidden="true"><span style={{ width: percent(r.share) }} /></span>
                  {percent(r.share)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Top contributors</h2>
        <table>
          <thead>
            <tr><th>Login</th><th className="num">PRs merged</th><th className="num">PRs opened</th></tr>
          </thead>
          <tbody>
            {stats.contributors.top.map((c) => (
              <tr key={c.login}>
                <td>{c.login}</td>
                <td className="num">{c.prs_merged}</td>
                <td className="num">{c.prs_opened}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function NarrativePanel({ narrative }: { narrative: Narrative }) {
  return (
    <div className="narrative">
      <p>{narrative.summary}</p>
      <p><strong>Possible cause:</strong> {narrative.hypothesis ?? "No clear root cause."}</p>
      <p><strong>Confidence:</strong> {percent(narrative.confidence)}{narrative.cached ? " (cached)" : ""}</p>
      <table>
        <thead>
          <tr><th>Fact</th><th className="num">Value</th><th>Note</th><th>Check</th></tr>
        </thead>
        <tbody>
          {narrative.evidence.map((e) => (
            <tr key={e.fact + e.value}>
              <td><code>{e.fact}</code></td>
              <td className="num">{e.value}</td>
              <td>{e.note}</td>
              <td className={e.verified ? "ok" : "bad"}>
                {e.verified ? "Verified" : `Not verified (actual ${String(narrative.facts[e.fact] ?? "none")})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PullsTable({ pulls }: { pulls: PullsReport["pulls"] }) {
  return (
    <table>
      <thead>
        <tr><th>PR</th><th>Author</th><th className="num">Hours to first review</th><th className="num">Hours to merge</th></tr>
      </thead>
      <tbody>
        {pulls.map((p) => (
          <tr key={p.number}>
            <td><a href={p.url} rel="noreferrer" target="_blank">#{p.number}</a></td>
            <td>{p.author ?? "deleted user"}</td>
            <td className="num">{p.in.first_review ? (p.hours_to_first_review ?? "none") : ""}</td>
            <td className="num">{p.in.merge ? p.hours_to_merge : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function App() {
  const [repo, setRepo] = useState("fastify/fastify");
  const [from, setFrom] = useState(day(29));
  const [to, setTo] = useState(day(0));
  const [target, setTarget] = useState<{ path: string; query: string } | null>(null);
  const [report, setReport] = useState<ReviewFlowReport | null>(null);
  const [narrative, setNarrative] = useState<Narrative | null>(null);
  const [pulls, setPulls] = useState<PullsReport | null>(null);
  const [busy, setBusy] = useState<"" | "load" | "explain" | "pulls">("");
  const [error, setError] = useState("");

  async function run<T>(kind: "load" | "explain" | "pulls", url: string, done: (value: T) => void) {
    setBusy(kind);
    setError("");
    try {
      done(await getJson<T>(url));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The server did not answer.");
    } finally {
      setBusy("");
    }
  }

  function load(event: FormEvent) {
    event.preventDefault();
    const parts = repo.trim().split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      setError("Write the repository as owner/name.");
      return;
    }
    const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const path = `/api/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/review-flow`;
    setNarrative(null);
    setPulls(null);
    void run<ReviewFlowReport>("load", `${path}?${query}`, (value) => {
      setReport(value);
      setTarget({ path, query });
    });
  }

  const url = (suffix: string) => (target ? `${target.path}${suffix}?${target.query}` : "");

  return (
    <main>
      <h1>review-pulse</h1>
      <p className="lead">See how fast pull requests get reviewed and merged, and who does the review work.</p>
      <form onSubmit={load}>
        <label>Repository<input value={repo} onChange={(e) => setRepo(e.target.value)} /></label>
        <label>From (UTC)<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To (UTC)<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="submit" disabled={busy !== ""}>Load</button>
      </form>

      {busy === "load" && <p className="status">The service gets data from GitHub. This can take some seconds.</p>}
      {error && <p className="status error" role="alert">{error}</p>}

      {report && (
        <>
          <p className="status">Data as of {report.data_as_of.slice(0, 16).replace("T", " ")} UTC.{report.period.complete ? "" : " The period has not ended."}</p>
          <Tiles current={report.current} previous={report.previous} />
          <Tables stats={report.current} />
          <p className="note">
            Bot PRs are not in the numbers: {report.current.excluded.bot_prs_opened} opened,{" "}
            {report.current.excluded.bot_prs_merged} merged.
            {report.prs_with_truncated_reviews > 0 &&
              ` ${report.prs_with_truncated_reviews} PRs have more than 100 reviews. Only the first 100 count.`}
          </p>

          <section>
            <h2>What stands out</h2>
            <button disabled={busy !== ""} onClick={() => run<Narrative>("explain", url("/narrative"), setNarrative)}>
              {busy === "explain" ? "Asking the model..." : "Explain"}
            </button>
            {narrative && <NarrativePanel narrative={narrative} />}
          </section>

          <section>
            <h2>Pull requests in the period</h2>
            <button disabled={busy !== ""} onClick={() => run<PullsReport>("pulls", url("/pulls"), setPulls)}>
              Show PRs
            </button>
            {pulls && <PullsTable pulls={pulls.pulls} />}
          </section>
        </>
      )}
    </main>
  );
}
