import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { buildApp } from "./app.ts";
import { type Config, loadConfig } from "./config.ts";
import { openStore } from "./db.ts";
import { createGithubClient } from "./github.ts";
import { createNarrator } from "./narrative.ts";
import { createSyncer } from "./sync.ts";

const DB_PATH = fileURLToPath(new URL("../data/review-pulse.db", import.meta.url));
const UI_DIR = fileURLToPath(new URL("../ui/dist", import.meta.url));
const LLM_TIMEOUT_MS = 60_000;

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : "Configuration error");
  process.exit(1);
}

const now = () => Date.now();
const store = openStore(DB_PATH);
const github = createGithubClient({ token: config.GITHUB_TOKEN });
const narrator = config.ANTHROPIC_API_KEY
  ? createNarrator({
      client: new Anthropic({
        apiKey: config.ANTHROPIC_API_KEY,
        baseURL: "https://api.anthropic.com",
        timeout: LLM_TIMEOUT_MS,
        maxRetries: 1,
      }),
      model: config.ANTHROPIC_MODEL,
      store,
      now,
    })
  : null;

const app = await buildApp({ store, syncer: createSyncer({ store, github, now }), narrator, now, uiDir: UI_DIR });

async function shutdown() {
  await app.close();
  store.close();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
