import { and, desc, eq, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { bookxProjects, bookxUsageEvents } from "../drizzle/schema";
import { getDb } from "./db";
import { keyHint, providerKeyStates } from "./providerCredentials";
import type { BuiltInProviderId } from "../shared/providers";
import type { AccountBalance, UsageCapability, UsageSummary } from "../shared/usage";

/**
 * Usage: what Prosecast spent on each provider, and what is left in the
 * connected account.
 *
 * Every successful provider call is written to a ledger (characters for
 * voices, tokens for language models, seconds for transcription), so the
 * numbers are Prosecast's own and survive a provider without a usage API.
 * Remaining balances come from each provider's account endpoint where one
 * exists; those calls are free and cached for a few minutes.
 */

export type UsageEvent = {
  ownerId?: number | null;
  projectId?: string | null;
  provider: string;
  capability: UsageCapability;
  model?: string | null;
  purpose?: string | null;
  characters?: number;
  inputTokens?: number;
  outputTokens?: number;
  audioMs?: number;
  providerCost?: number | null;
};

const whole = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

/**
 * Writes one ledger entry. Never throws: a failed write must not fail the
 * render or the analysis it describes.
 */
export async function recordUsage(event: UsageEvent): Promise<void> {
  if (event.ownerId == null) return;
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(bookxUsageEvents).values({
      id: nanoid(),
      ownerId: event.ownerId,
      projectId: event.projectId ?? null,
      provider: event.provider.slice(0, 80),
      capability: event.capability,
      model: event.model?.slice(0, 160) ?? null,
      purpose: event.purpose?.slice(0, 40) ?? null,
      characters: whole(event.characters),
      inputTokens: whole(event.inputTokens),
      outputTokens: whole(event.outputTokens),
      audioMs: whole(event.audioMs),
      providerCost: typeof event.providerCost === "number" && Number.isFinite(event.providerCost) ? event.providerCost : null,
    });
  } catch (error) {
    console.warn("[Usage] Could not record usage:", error instanceof Error ? error.message : error);
  }
}

/** The characters a provider says it billed, from response headers, when it says. */
export function billedCharacters(headers: Headers): number | null {
  for (const name of ["x-character-count", "character-cost"]) {
    const value = Number.parseFloat(headers.get(name) || "");
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/** Totals over the last `days` days, by provider and model, plus by project. */
export async function usageSummary(ownerId: number, days = 30): Promise<UsageSummary> {
  const db = await getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  if (!db) return { days, since: since.toISOString(), rows: [], projects: [], recent: [] };

  const totals = {
    calls: sql<number>`count(*)`,
    characters: sql<number>`coalesce(sum(${bookxUsageEvents.characters}), 0)`,
    inputTokens: sql<number>`coalesce(sum(${bookxUsageEvents.inputTokens}), 0)`,
    outputTokens: sql<number>`coalesce(sum(${bookxUsageEvents.outputTokens}), 0)`,
    audioMs: sql<number>`coalesce(sum(${bookxUsageEvents.audioMs}), 0)`,
    providerCost: sql<number | null>`sum(${bookxUsageEvents.providerCost})`,
  };
  const inWindow = and(eq(bookxUsageEvents.ownerId, ownerId), gte(bookxUsageEvents.createdAt, since));

  const rows = await db
    .select({ provider: bookxUsageEvents.provider, capability: bookxUsageEvents.capability, model: bookxUsageEvents.model, ...totals })
    .from(bookxUsageEvents)
    .where(inWindow)
    .groupBy(bookxUsageEvents.provider, bookxUsageEvents.capability, bookxUsageEvents.model);

  const projects = await db
    .select({ projectId: bookxUsageEvents.projectId, title: bookxProjects.title, ...totals })
    .from(bookxUsageEvents)
    .leftJoin(bookxProjects, and(eq(bookxProjects.id, bookxUsageEvents.projectId), eq(bookxProjects.ownerId, ownerId)))
    .where(inWindow)
    .groupBy(bookxUsageEvents.projectId, bookxProjects.title);

  const recent = await db
    .select()
    .from(bookxUsageEvents)
    .where(inWindow)
    .orderBy(desc(bookxUsageEvents.createdAt))
    .limit(25);

  const numbers = <T extends Record<string, unknown>>(row: T) => ({
    ...row,
    calls: Number(row.calls ?? 0),
    characters: Number(row.characters ?? 0),
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    audioMs: Number(row.audioMs ?? 0),
    providerCost: row.providerCost == null ? null : Number(row.providerCost),
  });

  return {
    days,
    since: since.toISOString(),
    rows: rows.map(row => ({ ...numbers(row), capability: row.capability as UsageCapability })),
    projects: projects.map(row => ({ ...numbers(row), projectId: row.projectId, title: row.title ?? null })),
    recent: recent.map(row => ({
      at: new Date(row.createdAt).toISOString(),
      provider: row.provider,
      capability: row.capability as UsageCapability,
      model: row.model,
      purpose: row.purpose,
      characters: row.characters,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      audioMs: row.audioMs,
      providerCost: row.providerCost,
    })),
  };
}

// ---------------------------------------------------------------------------
// Account balances
// ---------------------------------------------------------------------------

const BALANCE_TTL_MS = 5 * 60_000;
const BALANCE_TIMEOUT_MS = 10_000;
const balanceCache = new Map<string, { at: number; value: AccountBalance }>();

type Fetched = Omit<AccountBalance, "provider" | "keySource" | "checkedAt">;

async function getJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; body: unknown }> {
  // Official addresses only, and never followed elsewhere.
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS), redirect: "manual" });
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 200);
  }
  return { ok: response.ok, status: response.status, body };
}

const num = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** A key the provider rejects outright, as opposed to one that is valid but limited. */
const INVALID_KEY = /invalid[\s_-]*(api[\s_-]*)?(key|token|credentials?|auth)/i;

const refused = (result: { status: number; body: unknown }, what: string): Fetched => {
  const { status } = result;
  if (status !== 401 && status !== 403) return { status: "error", detail: `The provider answered HTTP ${status} when asked for ${what}.` };
  const said = typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? "");
  return {
    status: "error",
    detail: INVALID_KEY.test(said)
      ? "The provider does not accept this key. Check it in the connection settings."
      : `This key cannot read ${what}. Give it account (user) read access, or check the balance in the provider's dashboard.`,
  };
};

async function elevenLabsBalance(key: string): Promise<Fetched> {
  const result = await getJson("https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": key });
  if (!result.ok) return refused(result, "its subscription");
  const body = result.body as { tier?: string; status?: string; character_count?: number; character_limit?: number; next_character_count_reset_unix?: number };
  const used = num(body.character_count);
  const limit = num(body.character_limit);
  return {
    status: "ok",
    unit: "credits",
    used,
    limit,
    remaining: used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined,
    resetsAt: body.next_character_count_reset_unix ? new Date(body.next_character_count_reset_unix * 1000).toISOString() : null,
    plan: body.tier ?? null,
    detail: "Text to speech costs about one credit per character; some models cost less.",
  };
}

async function openRouterBalance(key: string): Promise<Fetched> {
  const headers = { Authorization: `Bearer ${key}` };
  const result = await getJson("https://openrouter.ai/api/v1/key", headers);
  if (!result.ok) return refused(result, "its key limits");
  const data = (result.body as { data?: { label?: string; usage?: number; limit?: number | null; limit_remaining?: number | null; is_free_tier?: boolean } }).data ?? {};
  const used = num(data.usage);
  const limit = num(data.limit);
  let remaining = num(data.limit_remaining);
  let detail = limit !== undefined ? "Spend limit set on this key." : "This key has no spend limit; the remaining figure is the account balance when OpenRouter reports it.";
  if (remaining === undefined) {
    // Account credits need a management key; an ordinary key is refused, which is fine.
    const credits = await getJson("https://openrouter.ai/api/v1/credits", headers).catch(() => null);
    const totals = (credits?.ok ? (credits.body as { data?: { total_credits?: number; total_usage?: number } }).data : undefined) ?? {};
    const total = num(totals.total_credits);
    const spent = num(totals.total_usage);
    if (total !== undefined && spent !== undefined) remaining = Math.max(0, total - spent);
    else detail = "OpenRouter only shows the account balance to a management key; this is what the key has spent.";
  }
  return { status: "ok", unit: "usd", used, limit, remaining, resetsAt: null, plan: data.is_free_tier ? "Free tier" : null, detail };
}

async function deepgramBalance(key: string): Promise<Fetched> {
  const headers = { Authorization: `Token ${key}` };
  const projects = await getJson("https://api.deepgram.com/v1/projects", headers);
  if (!projects.ok) return refused(projects, "its projects");
  const project = ((projects.body as { projects?: Array<{ project_id?: string; name?: string }> }).projects ?? [])[0];
  if (!project?.project_id) return { status: "error", detail: "This key has no Deepgram project." };
  const balances = await getJson(`https://api.deepgram.com/v1/projects/${encodeURIComponent(project.project_id)}/balances`, headers);
  if (!balances.ok) return refused(balances, "the project balance");
  const entries = (balances.body as { balances?: Array<{ amount?: number; units?: string }> }).balances ?? [];
  const remaining = entries.reduce((total, entry) => total + (num(entry.amount) ?? 0), 0);
  const units = entries[0]?.units?.toLowerCase();
  return {
    status: "ok",
    unit: units === "hour" || units === "hours" ? "hours" : "usd",
    remaining,
    plan: project.name ?? null,
    resetsAt: null,
    detail: "Balance of the key's first project.",
  };
}

async function fishAudioBalance(key: string): Promise<Fetched> {
  const result = await getJson("https://api.fish.audio/wallet/self/api-credit", { Authorization: `Bearer ${key}` });
  if (!result.ok) return refused(result, "its API credit");
  const body = result.body as { credit?: string | number };
  return { status: "ok", unit: "usd", remaining: num(body.credit), resetsAt: null, plan: null, detail: "Prepaid API credit." };
}

const UNSUPPORTED: Partial<Record<BuiltInProviderId, string>> = {
  OpenAI: "OpenAI does not show the remaining balance to API keys. The figures below are what Prosecast used; see platform.openai.com/usage for the account.",
  Cloudflare: "Workers AI is billed in neurons (10,000 free a day) and has no balance endpoint. The figures below are what Prosecast used.",
  Gradium: "Gradium has no balance endpoint Prosecast can read. Check the Gradium dashboard; the figures below are what Prosecast used.",
};

const FETCHERS: Partial<Record<BuiltInProviderId, (key: string) => Promise<Fetched>>> = {
  ElevenLabs: elevenLabsBalance,
  OpenRouter: openRouterBalance,
  Deepgram: deepgramBalance,
  "Fish Audio": fishAudioBalance,
};

/**
 * What is left in each connected account.
 *
 * A key from the deployment's environment belongs to whoever runs the
 * deployment, so its balance is shown to admins only.
 */
export async function accountBalances(input: { ownerId: number; isAdmin: boolean; refresh?: boolean; provider?: BuiltInProviderId }): Promise<AccountBalance[]> {
  const states = await providerKeyStates(input.ownerId);
  const providers = (Object.keys(states) as BuiltInProviderId[]).filter(provider => !input.provider || provider === input.provider);
  const now = Date.now();

  return Promise.all(providers.map(async provider => {
    const state = states[provider];
    const base = { provider, keySource: state.source ?? undefined, checkedAt: new Date(now).toISOString() };
    if (!state.apiKey) return { ...base, status: "not-connected" as const };
    if (state.source === "environment" && !input.isAdmin) {
      return { ...base, status: "hidden" as const, detail: "This uses the deployment's shared key. Its balance is visible to the admin; add your own key to see yours." };
    }
    const fetcher = FETCHERS[provider];
    if (!fetcher) return { ...base, status: "unsupported" as const, detail: UNSUPPORTED[provider] ?? "No balance endpoint." };

    const cacheKey = `${input.ownerId}:${provider}:${state.source}:${keyHint(state.apiKey) ?? ""}`;
    const cached = balanceCache.get(cacheKey);
    if (cached && !input.refresh && now - cached.at < BALANCE_TTL_MS) return cached.value;
    let value: AccountBalance;
    try {
      value = { ...base, ...(await fetcher(state.apiKey)) };
    } catch (error) {
      value = { ...base, status: "error", detail: error instanceof Error && error.name === "TimeoutError" ? "The provider did not answer in time." : "Could not reach the provider." };
    }
    balanceCache.set(cacheKey, { at: now, value });
    if (balanceCache.size > 500) balanceCache.delete(balanceCache.keys().next().value!);
    return value;
  }));
}
