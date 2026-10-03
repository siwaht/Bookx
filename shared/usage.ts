/** Usage and balance shapes shared by the server and the Settings screen. */

export type UsageCapability = "tts" | "stt" | "llm" | "sfx" | "music";

export type UsageTotals = {
  calls: number;
  characters: number;
  inputTokens: number;
  outputTokens: number;
  audioMs: number;
  /** Sum of provider-reported costs, in the provider's own unit, when it reports any. */
  providerCost: number | null;
};

export type UsageSummary = {
  days: number;
  since: string;
  rows: Array<UsageTotals & { provider: string; capability: UsageCapability; model: string | null }>;
  projects: Array<UsageTotals & { projectId: string | null; title: string | null }>;
  recent: Array<{
    at: string;
    provider: string;
    capability: UsageCapability;
    model: string | null;
    purpose: string | null;
    characters: number;
    inputTokens: number;
    outputTokens: number;
    audioMs: number;
    providerCost: number | null;
  }>;
};

export type AccountBalance = {
  provider: string;
  /** "hidden": a deployment key, whose balance only an admin sees. */
  status: "ok" | "unsupported" | "error" | "not-connected" | "hidden";
  unit?: "credits" | "usd" | "hours";
  used?: number;
  limit?: number;
  remaining?: number;
  resetsAt?: string | null;
  plan?: string | null;
  detail?: string;
  keySource?: "app" | "environment";
  checkedAt: string;
};

export const CAPABILITY_LABEL: Record<UsageCapability, string> = {
  tts: "Text to speech",
  stt: "Speech to text",
  llm: "Language model",
  sfx: "Sound effects",
  music: "Music",
};

/** "412,300 credits", "$3.20", "2.5 h". */
export function formatBalance(value: number | undefined, unit: AccountBalance["unit"]): string {
  if (value === undefined) return "—";
  if (unit === "usd") return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
  if (unit === "hours") return `${value.toFixed(1)} h`;
  return `${Math.round(value).toLocaleString()} credits`;
}
