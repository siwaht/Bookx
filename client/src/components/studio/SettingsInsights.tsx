import { useMemo, useState } from "react";
import { AudioLines, BrainCircuit, Gauge, LoaderCircle, Mic2, RefreshCw, Search, Wallet } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ttsTraits } from "@shared/direction";
import { isBuiltInProvider, type BuiltInProviderId } from "@shared/providers";
import { CAPABILITY_LABEL, formatBalance, type AccountBalance } from "@shared/usage";
import { Badge, count, ui } from "./studioUi";

/**
 * The top of Settings: which model does what right now, what each account has
 * left and what Prosecast has used, and every model the connected providers
 * offer today, with a way to make one the default.
 */
export function SettingsInsights() {
  const me = trpc.auth.me.useQuery();
  if (!me.data) return null;
  return (
    <div className="mb-6 min-w-0 space-y-4">
      <ModelsInUse />
      <UsageAndBalance />
      <ModelBrowser />
    </div>
  );
}

const IN_USE_ROWS = [
  { key: "tts", label: "Narration (text to speech)", icon: Mic2 },
  { key: "stt", label: "Transcription (speech to text)", icon: AudioLines },
  { key: "llm", label: "Casting, scenes and direction (LLM)", icon: BrainCircuit },
  { key: "sound", label: "Sound effects and music", icon: AudioLines },
] as const;

function ModelsInUse() {
  const inUse = trpc.providers.inUse.useQuery({});
  return (
    <div className={ui.card}>
      <h3 className={ui.heading}>Models in use</h3>
      <p className={`mt-1 text-xs ${ui.muted}`}>Account defaults. A project can choose its own narration and language models; the Generate tab shows the project's.</p>
      {!inUse.data ? <div className="skeleton mt-3 h-24 w-full" /> : (
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          {IN_USE_ROWS.map(row => {
            const entry = inUse.data[row.key];
            const Icon = row.icon;
            const label = row.key === "tts" && entry.provider && entry.model ? ttsTraits(entry.provider, entry.model).label : entry.model;
            return (
              <div key={row.key} className={ui.cardQuiet}>
                <dt className="flex items-center gap-1.5 text-[11px] font-bold text-[#526267]"><Icon aria-hidden="true" size={13} /> {row.label}</dt>
                <dd className="mt-1 text-sm font-bold text-[#304548]">{entry.provider ? `${entry.provider} · ${label}` : "Not set"}</dd>
                <dd className="mt-1 flex flex-wrap gap-1.5">
                  {entry.model && entry.model !== label && <span className="mono text-[10px] text-[#7d8a8c]">{entry.model}</span>}
                  {entry.source === "fallback" && <Badge tone="warn">Fallback</Badge>}
                  {entry.provider && !entry.connected && <Badge tone="bad">Not connected</Badge>}
                </dd>
                {entry.note && <dd className={`mt-1 text-[11px] leading-4 ${ui.faint}`}>{entry.note}</dd>}
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

function BalanceRow({ balance }: { balance: AccountBalance }) {
  const used = balance.limit && balance.remaining !== undefined ? Math.max(0, Math.min(100, Math.round(((balance.limit - balance.remaining) / balance.limit) * 100))) : null;
  return (
    <li className={`py-3 ${ui.divider}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm text-[#34484b]">{balance.provider}</strong>
        {balance.status === "ok" ? (
          <span className={`text-sm font-bold text-[#2d6f6a] ${ui.numbers}`}>{formatBalance(balance.remaining, balance.unit)} left</span>
        ) : balance.status === "hidden" ? <Badge>Shared key</Badge> : balance.status === "unsupported" ? <Badge>No balance API</Badge> : <Badge tone="warn">Unavailable</Badge>}
      </div>
      {used !== null && (
        <div className={`${ui.bar} mt-2 h-1.5`} role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={100} aria-label={`${balance.provider} quota used`}>
          <div className={used > 90 ? "h-full rounded-full bg-[#b5654c]" : used > 70 ? "h-full rounded-full bg-[#c89a3a]" : ui.barFill} style={{ width: `${used}%` }} />
        </div>
      )}
      <p className={`mt-1 text-[11px] leading-5 ${ui.muted} ${ui.numbers}`}>
        {balance.status === "ok" && balance.used !== undefined && <>Used {formatBalance(balance.used, balance.unit)}{balance.limit !== undefined && <> of {formatBalance(balance.limit, balance.unit)}</>}. </>}
        {balance.resetsAt && <>Resets {new Date(balance.resetsAt).toLocaleDateString()}. </>}
        {balance.plan && <>{balance.plan}. </>}
        {balance.detail}
      </p>
    </li>
  );
}

function UsageAndBalance() {
  const utils = trpc.useUtils();
  const [days, setDays] = useState(30);
  const balances = trpc.providers.balances.useQuery(undefined);
  const usage = trpc.providers.usage.useQuery({ days });
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await utils.providers.balances.fetch({ refresh: true });
      utils.providers.balances.setData(undefined, fresh);
      await utils.providers.usage.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Prosecast could not refresh the balances.");
    } finally {
      setRefreshing(false);
    }
  };

  const connected = (balances.data ?? []).filter(balance => balance.status !== "not-connected");
  const byProvider = useMemo(() => {
    const map = new Map<string, { characters: number; inputTokens: number; outputTokens: number; audioMs: number; calls: number; cost: number | null; capabilities: Set<string> }>();
    for (const row of usage.data?.rows ?? []) {
      const entry = map.get(row.provider) ?? { characters: 0, inputTokens: 0, outputTokens: 0, audioMs: 0, calls: 0, cost: null, capabilities: new Set<string>() };
      entry.characters += row.characters;
      entry.inputTokens += row.inputTokens;
      entry.outputTokens += row.outputTokens;
      entry.audioMs += row.audioMs;
      entry.calls += row.calls;
      if (row.providerCost !== null) entry.cost = (entry.cost ?? 0) + row.providerCost;
      entry.capabilities.add(CAPABILITY_LABEL[row.capability] ?? row.capability);
      map.set(row.provider, entry);
    }
    return [...map.entries()].sort((left, right) => right[1].calls - left[1].calls);
  }, [usage.data?.rows]);

  return (
    <div className={ui.card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className={`flex items-center gap-2 ${ui.heading}`}><Wallet aria-hidden="true" size={15} className="text-[#5b8b86]" /> Usage and balance</h3>
          <p className={`mt-1 text-xs ${ui.muted}`}>What is left in each connected account, and what Prosecast has used. Checking a balance is free.</p>
        </div>
        <button type="button" className="btn-soft px-3 py-2" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? <LoaderCircle aria-hidden="true" className="animate-spin" size={13} /> : <RefreshCw aria-hidden="true" size={13} />} Refresh
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section aria-label="Account balances" className="min-w-0">
          <span className={ui.eyebrow}>LEFT IN EACH ACCOUNT</span>
          {!balances.data ? <div className="skeleton mt-2 h-20 w-full" /> : connected.length === 0 ? (
            <p className={`mt-2 text-xs ${ui.muted}`}>No provider is connected yet.</p>
          ) : <ul className="mt-1">{connected.map(balance => <BalanceRow key={balance.provider} balance={balance} />)}</ul>}
        </section>

        <section aria-label="Usage by Prosecast" className="min-w-0">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className={ui.eyebrow}>USED BY PROSECAST</span>
            <select className="rounded-lg border border-[#dce4dd] bg-white px-2 py-1 text-[#4b5d60]" value={days} onChange={event => setDays(Number(event.target.value))} aria-label="Usage period">
              <option value={1}>Today</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </div>
          {!usage.data ? <div className="skeleton mt-2 h-20 w-full" /> : byProvider.length === 0 ? (
            <p className={`mt-2 text-xs ${ui.muted}`}>Nothing recorded in this period. Every narration, preview, transcription, analysis and sound is counted from now on.</p>
          ) : (
            <ul className="mt-1">
              {byProvider.map(([provider, totals]) => (
                <li key={provider} className={`py-3 ${ui.divider}`}>
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-sm text-[#34484b]">{provider}</strong>
                    <span className={`text-[11px] ${ui.faint} ${ui.numbers}`}>{count(totals.calls)} calls</span>
                  </div>
                  <p className={`mt-1 text-[11px] leading-5 ${ui.muted} ${ui.numbers}`}>
                    {[
                      totals.characters ? `${count(totals.characters)} characters` : null,
                      totals.inputTokens || totals.outputTokens ? `${count(totals.inputTokens)} in / ${count(totals.outputTokens)} out tokens` : null,
                      totals.audioMs ? `${Math.round(totals.audioMs / 60_000).toLocaleString()} min of audio` : null,
                      totals.cost !== null ? `${provider === "OpenRouter" ? `$${totals.cost.toFixed(2)}` : `${count(totals.cost)} credits`} reported` : null,
                    ].filter(Boolean).join(" · ")}
                  </p>
                  <p className={`text-[10px] ${ui.faint}`}>{[...totals.capabilities].join(", ")}</p>
                </li>
              ))}
            </ul>
          )}
          {(usage.data?.projects.length ?? 0) > 1 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-bold text-[#34736d]">By book</summary>
              <ul className="mt-1 space-y-1">
                {usage.data!.projects.map(project => (
                  <li key={project.projectId ?? "none"} className={`flex justify-between gap-2 text-[11px] ${ui.muted} ${ui.numbers}`}>
                    <span className="truncate">{project.title ?? (project.projectId ? "Deleted book" : "Not tied to a book")}</span>
                    <span>{count(project.characters)} chars · {count(project.inputTokens + project.outputTokens)} tokens</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </div>
    </div>
  );
}

const CAPABILITIES = [
  { id: "text-to-speech", label: "Text to speech", preference: "defaultTtsModel" },
  { id: "speech-to-text", label: "Speech to text", preference: "defaultSttModel" },
  { id: "language-model", label: "Language models", preference: "defaultLlmModel" },
] as const;

function ModelBrowser() {
  const utils = trpc.useUtils();
  const catalog = trpc.providers.catalog.useQuery();
  const preferences = trpc.providers.listPreferences.useQuery();
  const [capability, setCapability] = useState<(typeof CAPABILITIES)[number]["id"]>("text-to-speech");
  const [query, setQuery] = useState("");
  const savePreference = trpc.providers.savePreference.useMutation({
    onSuccess: () => {
      void utils.providers.listPreferences.invalidate();
      void utils.providers.inUse.invalidate();
      toast.success("Default saved.");
    },
    onError: error => toast.error(error.message || "Prosecast could not save the default."),
  });
  const refresh = trpc.providers.refreshModels.useMutation({
    onSuccess: result => {
      void utils.providers.catalog.invalidate();
      toast(result.live ? `${result.provider}: ${result.models} models listed live.` : `${result.provider}: showing Prosecast's list${result.error ? ` (${result.error})` : ""}.`);
    },
    onError: error => toast.error(error.message || "Prosecast could not refresh that provider."),
  });

  const meta = CAPABILITIES.find(item => item.id === capability)!;
  const needle = query.trim().toLowerCase();
  const limit = needle ? 60 : 12;
  const groups = (catalog.data ?? [])
    .filter(provider => provider.capabilities.includes(capability))
    .map(provider => ({
      provider,
      models: provider.models.filter(model => model.capabilities.includes(capability) && (!needle || `${model.id} ${model.label} ${model.detail ?? ""}`.toLowerCase().includes(needle))),
    }))
    .filter(group => group.models.length || !needle);

  return (
    <div className={ui.card}>
      <h3 className={`flex items-center gap-2 ${ui.heading}`}><Gauge aria-hidden="true" size={15} className="text-[#5b8b86]" /> Available models</h3>
      <p className={`mt-1 text-xs ${ui.muted}`}>Listed live by each connected provider (cached for half an hour), so new models such as Eleven v4 appear without an update.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Capability" className="flex flex-wrap gap-1.5">
          {CAPABILITIES.map(item => (
            <button key={item.id} type="button" role="tab" aria-selected={capability === item.id} className={capability === item.id ? ui.chipOn : ui.chip} onClick={() => setCapability(item.id)}>
              <span className={ui.chipText}>{item.label}</span>
            </button>
          ))}
        </div>
        <label className="relative ml-auto min-w-[180px] flex-1 text-sm sm:flex-none">
          <Search aria-hidden="true" size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8b9697]" />
          <input className="input" style={{ paddingLeft: "2rem" }} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search models" aria-label="Search models" />
        </label>
      </div>

      <div className="mt-3 max-h-[460px] space-y-3 overflow-auto pr-1">
        {!catalog.data ? <div className="skeleton h-24 w-full" /> : groups.map(({ provider, models }) => {
          const preference = preferences.data?.find(row => row.provider === provider.id);
          const chosen = preference?.[meta.preference] ?? null;
          return (
            <section key={provider.id} className={ui.cardQuiet} aria-label={`${provider.label} models`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm text-[#34484b]">{provider.label}</strong>
                  {provider.configured ? <Badge tone="good">Connected</Badge> : <Badge>Not connected</Badge>}
                  {provider.modelsLive ? <Badge tone="info">Live list</Badge> : provider.liveCatalog && provider.configured ? <Badge tone="warn">Prosecast's list</Badge> : null}
                </div>
                {provider.liveCatalog && provider.configured && isBuiltInProvider(provider.id) && (
                  <button type="button" className={ui.linkButton} disabled={refresh.isPending} onClick={() => refresh.mutate({ provider: provider.id as BuiltInProviderId })}>
                    <RefreshCw aria-hidden="true" size={11} /><span className={ui.linkText}>Refresh</span>
                  </button>
                )}
              </div>
              {provider.discoveryError && <p className="mt-1 text-[11px] text-[#8a5f1c] [overflow-wrap:anywhere]">Live list unavailable: {provider.discoveryError.slice(0, 160)}</p>}
              <ul className="mt-2 divide-y divide-[#edf0eb]">
                {models.slice(0, limit).map(model => (
                  <li key={model.id} className="flex flex-wrap items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <span className="text-[13px] font-semibold text-[#34484b]">{model.label}</span>
                      <span className="mono ml-2 text-[10px] text-[#8b9697]">{model.id}</span>
                      <span className={`block truncate text-[11px] ${ui.muted}`}>{model.detail}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {model.recommended && <Badge tone="good">Recommended</Badge>}
                      {model.direction === "audio-tags" && <Badge tone="info">Audio tags</Badge>}
                      {model.direction === "instructions" && <Badge tone="info">Instructions</Badge>}
                      {model.maxChars && <Badge>{model.maxChars.toLocaleString()} chars</Badge>}
                      {model.costMultiplier && model.costMultiplier !== 1 && <Badge>×{model.costMultiplier} credits</Badge>}
                      {model.deprecated && <Badge tone="warn">Deprecated</Badge>}
                    </div>
                    {isBuiltInProvider(provider.id) && (
                      chosen === model.id ? <Badge tone="good">Default</Badge> : (
                        <button
                          type="button"
                          className={ui.linkButton}
                          disabled={savePreference.isPending}
                          onClick={() => savePreference.mutate({ provider: provider.id as BuiltInProviderId, [meta.preference]: model.id })}
                        >
                          <span className={ui.linkText}>Make default</span>
                        </button>
                      )
                    )}
                  </li>
                ))}
              </ul>
              {models.length > limit && <p className={`mt-1 text-[11px] ${ui.faint}`}>{models.length - limit} more; search to narrow the list.</p>}
              {!models.length && <p className={`mt-1 text-[11px] ${ui.faint}`}>No {meta.label.toLowerCase()} models.</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
