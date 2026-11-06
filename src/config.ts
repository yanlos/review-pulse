import { z } from "zod";

const blankToUndefined = (value: unknown) => (value === "" ? undefined : value);

const EnvSchema = z.object({
  GITHUB_TOKEN: z.preprocess(blankToUndefined, z.string()),
  ANTHROPIC_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  ANTHROPIC_MODEL: z.preprocess(blankToUndefined, z.string().default("claude-opus-5-5")),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(3000)),
  HOST: z.preprocess(blankToUndefined, z.string().default("127.0.0.1")),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Missing or incorrect environment variables: ${names.join(", ")}`);
  }
  return result.data;
}
