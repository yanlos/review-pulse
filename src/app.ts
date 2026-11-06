import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyBaseLogger, type FastifyReply, type FastifyRequest } from "fastify";
import type { Store } from "./db.ts";
import { HttpError, problem } from "./errors.ts";
import { pullsReport, reviewFlowReport } from "./metrics.ts";
import type { Narrator } from "./narrative.ts";
import { parsePeriod, parseRepo, type Period, type RepoRef } from "./params.ts";
import type { Syncer } from "./sync.ts";

export type AppDeps = {
  store: Store;
  syncer: Syncer;
  narrator: Narrator | null;
  now: () => number;
  uiDir?: string;
  logLevel?: string;
  logStream?: NodeJS.WritableStream;
};

const ROUTE = "/api/repos/:owner/:repo/review-flow";
const CACHE_OK = "private, max-age=60";
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export async function buildApp(deps: AppDeps) {
  const { store, syncer, narrator, now } = deps;
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie"],
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    genReqId: () => randomUUID(),
    routerOptions: { maxParamLength: 256 },
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.headers(SECURITY_HEADERS);
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) {
      if (err.status >= 500) req.log.warn({ code: err.code, reason: err.reason }, err.message);
      return sendProblem(reply, req, err.status, err.code, err.message, err.retryAfter);
    }
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      return sendProblem(reply, req, err.statusCode, "bad_request", "The request is not valid.");
    }
    req.log.error({ err }, "unhandled error");
    return sendProblem(reply, req, 500, "internal", "An unexpected error occurred.");
  });

  app.setNotFoundHandler((req, reply) => sendProblem(reply, req, 404, "not_found", "No resource has this path."));

  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) =>
      new HttpError(429, "rate_limited", "Too many requests. Try again later.", Math.ceil(context.ttl / 1000)),
  });

  if (deps.uiDir && existsSync(deps.uiDir)) {
    await app.register(fastifyStatic, { root: deps.uiDir, wildcard: false });
  }

  async function load(repo: RepoRef, period: Period, log: FastifyBaseLogger) {
    await syncer.ensureSynced(repo, period.prevFrom, log);
    const state = store.getRepoState(repo.key);
    if (state === undefined) throw new Error("No repository state after a sync.");
    return { prs: store.loadPrs(repo.key, period.prevFrom), dataAsOf: state.syncedAt };
  }

  function input(req: FastifyRequest) {
    return { repo: parseRepo(req.params), period: parsePeriod(req.query, now()) };
  }

  app.get("/healthz", { config: { rateLimit: false } }, async () => ({ status: "ok" }));

  app.get(ROUTE, async (req, reply) => {
    const { repo, period } = input(req);
    const { prs, dataAsOf } = await load(repo, period, req.log);
    reply.header("cache-control", CACHE_OK);
    return reviewFlowReport(repo.key, period, prs, dataAsOf);
  });

  app.get(`${ROUTE}/pulls`, async (req, reply) => {
    const { repo, period } = input(req);
    const { prs, dataAsOf } = await load(repo, period, req.log);
    reply.header("cache-control", CACHE_OK);
    return pullsReport(repo.key, period, prs, dataAsOf);
  });

  // Each call can cost money, so HEAD is off and the rate limit is lower.
  app.get(
    `${ROUTE}/narrative`,
    { exposeHeadRoute: false, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { repo, period } = input(req);
      if (narrator === null) {
        throw new HttpError(503, "llm_not_configured", "The narrative needs ANTHROPIC_API_KEY. The server does not have it.");
      }
      const { prs, dataAsOf } = await load(repo, period, req.log);
      const narrative = await narrator.explain(reviewFlowReport(repo.key, period, prs, dataAsOf), req.log);
      reply.header("cache-control", CACHE_OK);
      return narrative;
    },
  );

  return app;
}

function sendProblem(
  reply: FastifyReply,
  req: FastifyRequest,
  status: number,
  code: string,
  detail: string,
  retryAfter?: number,
) {
  reply.code(status).type("application/problem+json").header("cache-control", "no-store");
  if (retryAfter !== undefined) reply.header("retry-after", String(retryAfter));
  return reply.send(problem(status, code, detail, req.id));
}
