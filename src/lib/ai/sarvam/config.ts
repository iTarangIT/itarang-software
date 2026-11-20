// Sarvam voice-agent configuration, read from the environment.
//
// Spec: "Sarvam Priya → iTarang CRM Developer Handoff Spec" (20 Nov 2026),
// section Configuration. Every value is read lazily so a box without Sarvam
// keys still boots; the trigger refuses to dial until the required ones exist.

export const SARVAM_API_BASE = "https://apps.sarvam.ai/api";

/** The committed Priya agent (Hindi, outbound). Overridable per environment. */
export const DEFAULT_SARVAM_APP_ID = "Priya---iTa-44bf0300-67c5";

export type SarvamConfig = {
  apiKey: string;
  orgId: string;
  workspaceId: string;
  appId: string;
  appVersion: number;
  connectionId: string;
  agentPhoneNumber: string;
  webhookToken: string;
  webhookBaseUrl: string;
};

const REQUIRED = [
  "SARVAM_API_KEY",
  "SARVAM_ORG_ID",
  "SARVAM_WORKSPACE_ID",
  "SARVAM_CONNECTION_ID",
  "SARVAM_AGENT_PHONE_NUMBER",
  "SARVAM_WEBHOOK_TOKEN",
  "SARVAM_WEBHOOK_BASE_URL",
] as const;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function sarvamAppId(): string {
  return env("SARVAM_APP_ID") || DEFAULT_SARVAM_APP_ID;
}

/**
 * The full config, or the list of env vars still missing. Callers that place
 * calls must refuse when anything is missing — a call without a webhook URL
 * would never report back and the campaign row would sit in `calling`.
 */
export function readSarvamConfig():
  | { ok: true; config: SarvamConfig }
  | { ok: false; missing: string[] } {
  const missing: string[] = REQUIRED.filter((k) => !env(k));
  const rawVersion = env("SARVAM_APP_VERSION") || "1";
  const appVersion = Number.parseInt(rawVersion, 10);
  if (!Number.isFinite(appVersion) || appVersion < 1) {
    missing.push("SARVAM_APP_VERSION (must be a committed version number)");
  }
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: {
      apiKey: env("SARVAM_API_KEY"),
      orgId: env("SARVAM_ORG_ID"),
      workspaceId: env("SARVAM_WORKSPACE_ID"),
      appId: sarvamAppId(),
      appVersion,
      connectionId: env("SARVAM_CONNECTION_ID"),
      agentPhoneNumber: env("SARVAM_AGENT_PHONE_NUMBER"),
      webhookToken: env("SARVAM_WEBHOOK_TOKEN"),
      webhookBaseUrl: env("SARVAM_WEBHOOK_BASE_URL").replace(/\/+$/, ""),
    },
  };
}

/** Only the parts needed to read Sarvam's analytics API (recordings). */
export function readSarvamReadConfig(): {
  apiKey: string;
  orgId: string;
  workspaceId: string;
  appId: string;
} | null {
  const apiKey = env("SARVAM_API_KEY");
  const orgId = env("SARVAM_ORG_ID");
  const workspaceId = env("SARVAM_WORKSPACE_ID");
  if (!apiKey || !orgId || !workspaceId) return null;
  return { apiKey, orgId, workspaceId, appId: sarvamAppId() };
}

export function outboundUrl(c: Pick<SarvamConfig, "orgId" | "workspaceId">): string {
  return `${SARVAM_API_BASE}/outbounds/v1/orgs/${encodeURIComponent(c.orgId)}/workspaces/${encodeURIComponent(c.workspaceId)}/outbounds`;
}

export function webhookUrl(c: Pick<SarvamConfig, "webhookBaseUrl" | "webhookToken">): string {
  return `${c.webhookBaseUrl}/api/sarvam/webhook?token=${encodeURIComponent(c.webhookToken)}`;
}

/**
 * Per-minute rate used to cost a call — the webhook carries no cost field
 * (spec, unverified point 5). INR. Null when not configured.
 */
export function sarvamCostPerMinuteInr(): number | null {
  const raw = env("SARVAM_COST_PER_MIN_INR");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
