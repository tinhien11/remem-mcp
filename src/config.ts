import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Configuration for the remem-mcp server.
 * All fields have sensible defaults. A configuration file is not required.
 */
export interface Config {
  /** Storage backend. Default: "sqlite". */
  storage: "sqlite" | "pgvector" | "file" | "remem-gateway";

  /** Pipeline stage. Default: "noop". */
  pipeline: "noop" | "atom" | "scenario" | "mermaid";

  /** SQLite database file path. */
  dbPath: string;

  /** Audit log file path. */
  auditLogPath: string;

  /** LLM configuration. Undefined if no API key is set. */
  llm?: LlmConfig;

  /** Security configuration. */
  security: SecurityConfig;
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface SecurityConfig {
  /** Redact secrets on capture. Default: true. */
  redactSecrets: boolean;

  /** Maximum tokens per recall response. Default: 4000. */
  maxTokensRecall: number;

  /** Maximum tokens per search response. Default: 8000. */
  maxTokensSearch: number;

  /** Maximum content length for capture. Default: 50000 characters. */
  maxContentLength: number;

  /** Write audit log. Default: true. */
  auditLog: boolean;
}

/** Current schema version. Increment when the schema changes. */
export const SCHEMA_VERSION = 3;

/** Default data directory. */
function defaultDataDir(): string {
  const home = homedir();
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData) return join(xdgData, "remem-mcp");
  return join(home, ".local", "share", "remem-mcp");
}

/** Default config directory. */
function defaultConfigDir(): string {
  const home = homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) return join(xdgConfig, "remem-mcp");
  return join(home, ".config", "remem-mcp");
}

/** Parse a boolean environment variable. "false", "0", "" = false. Everything else = true. */
function parseBool(val: string | undefined, defaultVal: boolean): boolean {
  if (val === undefined) return defaultVal;
  const lower = val.toLowerCase();
  if (lower === "false" || lower === "0" || lower === "") return false;
  return true;
}

/** Parse an integer environment variable. */
function parseEnvInt(val: string | undefined, defaultVal: number): number {
  if (val === undefined) return defaultVal;
  const num = Number.parseInt(val, 10);
  return Number.isNaN(num) ? defaultVal : num;
}

/** Load the configuration file from disk, if it exists. */
function loadConfigFile(): Record<string, unknown> | null {
  const configDir = defaultConfigDir();
  const configPath = join(configDir, "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const content = readFileSync(configPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Load the configuration from environment variables and the config file. */
export function loadConfig(): Config {
  const file = loadConfigFile();

  const dataDir = defaultDataDir();
  const defaultDbPath = join(dataDir, "memory.db");
  const defaultAuditPath = join(dataDir, "audit.jsonl");

  const env = process.env;

  const apiKey =
    env.TDAI_LLM_API_KEY ?? ((file?.llm as Record<string, unknown>)?.apiKey as string | undefined);
  const baseUrl =
    env.TDAI_LLM_BASE_URL ??
    ((file?.llm as Record<string, unknown>)?.baseUrl as string | undefined);
  const model =
    env.TDAI_LLM_MODEL ?? ((file?.llm as Record<string, unknown>)?.model as string | undefined);

  const llm: LlmConfig | undefined = apiKey
    ? {
        apiKey,
        baseUrl: baseUrl ?? "https://api.openai.com/v1",
        model: model ?? "gpt-4o-mini",
      }
    : undefined;

  const fileSecurity = (file?.security as Record<string, unknown>) ?? {};

  return {
    storage: (env.TDAI_STORAGE ?? (file?.storage as string) ?? "sqlite") as Config["storage"],
    pipeline: (env.TDAI_PIPELINE ?? (file?.pipeline as string) ?? "noop") as Config["pipeline"],
    dbPath: env.TDAI_DB_PATH ?? (file?.dbPath as string) ?? defaultDbPath,
    auditLogPath: env.TDAI_AUDIT_LOG_PATH ?? (file?.auditLogPath as string) ?? defaultAuditPath,
    llm,
    security: {
      redactSecrets: parseBool(
        env.TDAI_REDACT_SECRETS,
        (fileSecurity.redactSecrets as boolean) ?? true,
      ),
      maxTokensRecall: parseEnvInt(
        env.TDAI_MAX_TOKENS_RECALL,
        (fileSecurity.maxTokensRecall as number) ?? 4000,
      ),
      maxTokensSearch: parseEnvInt(
        env.TDAI_MAX_TOKENS_SEARCH,
        (fileSecurity.maxTokensSearch as number) ?? 8000,
      ),
      maxContentLength: parseEnvInt(
        env.TDAI_MAX_CONTENT_LENGTH,
        (fileSecurity.maxContentLength as number) ?? 50000,
      ),
      auditLog: parseBool(env.TDAI_AUDIT_LOG, (fileSecurity.auditLog as boolean) ?? true),
    },
  };
}
