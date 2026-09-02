import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Cloud, Cpu, Eye, EyeOff, KeyRound, Mic2, RefreshCw, Sparkles, TriangleAlert, Waves } from "lucide-react";

type ProviderCapability = "text-to-speech" | "speech-to-text" | "language-model";

export type ProviderCatalog = {
  id: string;
  label: string;
  configured: boolean;
  status: "connected" | "available" | "optional";
  /** Where the key came from, when there is one. */
  keySource?: "app" | "environment";
  /** Set when live model discovery failed. */
  discoveryError?: string;
  capabilities: ProviderCapability[];
  models: { id: string; label: string; capabilities: ProviderCapability[]; detail?: string }[];
};

export type CloudflareConnectionDraft = {
  apiBaseUrl: string;
  apiKey: string;
  ttsModel: string;
  sttModel: string;
  llmModel: string;
};

type SavedPreference = {
  provider: string;
  apiBaseUrl?: string | null;
  apiKeyConfigured?: boolean | null;
  defaultTtsModel?: string | null;
  defaultSttModel?: string | null;
  defaultLlmModel?: string | null;
};

type ProviderSettingsProps = {
  providers: ProviderCatalog[];
  preferences: SavedPreference[];
  saved: boolean;
  onSave: (customEndpoint?: string) => void;
  onSaveKey: (provider: string, apiKey: string) => void;
  onSaveCloudflare: (connection: CloudflareConnectionDraft) => void;
  cloudflareSaved: SavedPreference | null;
  checks: Record<string, { status: string; detail?: string }>;
  onValidate: (provider: string) => void;
  savingKey: string | null;
};

const capabilityLabel: Record<ProviderCapability, string> = {
  "text-to-speech": "Voice",
  "speech-to-text": "Transcribe",
  "language-model": "LLM",
};

function capabilityIcon(capability: ProviderCapability) {
  if (capability === "text-to-speech") return <Waves aria-hidden="true" size={13} />;
  if (capability === "speech-to-text") return <Mic2 aria-hidden="true" size={13} />;
  return <Sparkles aria-hidden="true" size={13} />;
}

/** Where each provider's key is created, so the user knows what to paste. */
const KEY_HINTS: Record<string, { help: string; prefix?: string }> = {
  ElevenLabs: { help: "Profile → API Keys in the ElevenLabs dashboard.", prefix: "starts with sk_" },
  Deepgram: { help: "Deepgram Console → API Keys.", prefix: "" },
  OpenAI: { help: "platform.openai.com → API keys.", prefix: "starts with sk-" },
  Cloudflare: { help: "A Workers AI token from Cloudflare → AI → Workers AI.", prefix: "" },
  "Fish Audio": { help: "fish.audio → API keys.", prefix: "" },
};

export function ProviderSettings({
  providers,
  preferences,
  saved,
  onSave,
  onSaveKey,
  onSaveCloudflare,
  cloudflareSaved,
  checks,
  onValidate,
  savingKey,
}: ProviderSettingsProps) {
  const connected = providers.filter(provider => provider.configured);
  const cloudflare = providers.find(provider => provider.id === "Cloudflare");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [cloudflareConnection, setCloudflareConnection] = useState<CloudflareConnectionDraft>({ apiBaseUrl: "", apiKey: "", ttsModel: "", sttModel: "", llmModel: "" });
  const hydratedCloudflare = useRef(false);

  useEffect(() => {
    if (hydratedCloudflare.current || !cloudflareSaved) return;
    hydratedCloudflare.current = true;
    setCloudflareConnection(current => ({
      ...current,
      apiBaseUrl: cloudflareSaved.apiBaseUrl || "",
      ttsModel: cloudflareSaved.defaultTtsModel || "",
      sttModel: cloudflareSaved.defaultSttModel || "",
      llmModel: cloudflareSaved.defaultLlmModel || "",
    }));
  }, [cloudflareSaved]);

  const trimmedEndpoint = cloudflareConnection.apiBaseUrl.trim();
  const endpointMode = trimmedEndpoint
    ? trimmedEndpoint.includes("api.cloudflare.com")
      ? "Detected: Cloudflare Workers AI (native)"
      : "Detected: OpenAI-compatible endpoint"
    : null;

  const modelCount = providers.reduce((total, provider) => total + provider.models.length, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[#d8e2dc] bg-[radial-gradient(circle_at_top_left,#eaf5ef,transparent_42%),#fffefa] px-6 py-7 md:px-9">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="mono text-[10px] tracking-[.18em] text-[#4f8980]">SYSTEM · MODEL ROUTING</p>
            <h2 className="serif mt-2 text-3xl tracking-[-.045em] text-[#203a3d]">Connections that follow your craft.</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#6f7e80]">
              Paste a key for any provider below. Keys are stored server-side, never returned to the browser, and take effect immediately.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-[#cbe1d8] bg-white/80 px-4 py-3 text-xs font-semibold text-[#386f69] shadow-sm">
            <Cpu aria-hidden="true" size={16} /> {connected.length} of {providers.length} connected · {modelCount} models
          </div>
        </div>
      </div>

      <div className="grid flex-1 gap-6 overflow-auto p-6 lg:grid-cols-[minmax(0,1fr)_340px] md:p-9">
        <section>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="font-bold text-[#34484a]">Provider layer</h3>
              <p className="mt-1 text-xs text-[#778689]">Add a key to enable a provider. Model lists are discovered server-side.</p>
            </div>
            <span className="mono rounded-full bg-[#edf5f0] px-3 py-1 text-[9px] tracking-[.12em] text-[#50837b]">MODEL-AGNOSTIC</span>
          </div>

          <div className="grid gap-4">
            {providers.map(provider => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                preference={preferences.find(item => item.provider === provider.id) ?? null}
                check={checks[provider.id]}
                onValidate={() => onValidate(provider.id)}
                onSaveKey={apiKey => onSaveKey(provider.id, apiKey)}
                saving={savingKey === provider.id}
              />
            ))}
          </div>
        </section>

        <aside className="space-y-5">
          <div className="rounded-[24px] bg-[#244f50] p-6 text-white shadow-[0_18px_45px_rgba(31,78,78,.20)]">
            <Cloud aria-hidden="true" className="text-[#efc976]" size={22} />
            <p className="mono mt-5 text-[10px] tracking-[.15em] text-[#b8d8d3]">CLOUDFLARE WORKERS AI</p>
            <h3 className="serif mt-2 text-3xl leading-tight">Your live model catalog.</h3>
            <p className="mt-4 text-sm leading-6 text-[#d2e2de]">
              Bookx reads the models available in your account, then shows only the ones that fit each task.
            </p>
            <div className="mt-5 rounded-2xl bg-white/10 p-4">
              <span className="block text-xs font-bold">
                {cloudflare?.models.filter(model => model.capabilities.includes("language-model")).length || 0} language ·{" "}
                {cloudflare?.models.filter(model => model.capabilities.includes("text-to-speech")).length || 0} voice ·{" "}
                {cloudflare?.models.filter(model => model.capabilities.includes("speech-to-text")).length || 0} transcription
              </span>
              <span className="mt-1 block text-[11px] text-[#bad8d4]">
                {cloudflare?.discoveryError
                  ? "Showing built-in defaults only — see the warning below."
                  : "Discovered from your account."}
              </span>
            </div>
            {cloudflare?.discoveryError && (
              <p className="mt-4 rounded-xl bg-[#7c3b2f]/40 px-3 py-2.5 text-[11px] leading-5 text-[#ffd9cd]">
                <TriangleAlert className="mr-1 inline" aria-hidden="true" size={13} />
                Model discovery failed: {cloudflare.discoveryError}
              </p>
            )}
          </div>

          <div className="rounded-[22px] border border-[#cfe0db] bg-[#fffefa] p-5">
            <span className="mono text-[10px] tracking-[.14em] text-[#547d77]">CLOUDFLARE ENDPOINT</span>
            <h3 className="mt-2 font-bold text-[#3a5052]">Account URL and default models.</h3>
            <p className="mt-2 text-xs leading-5 text-[#748285]">
              Paste your account URL (<strong>…/accounts/&lt;id&gt;/ai</strong>) or any OpenAI-compatible endpoint. The key goes in the Cloudflare card on the left.
            </p>
            <label className="mt-4 block">
              <span className="mb-1.5 block text-[11px] font-bold text-[#526267]">Endpoint URL</span>
              <input className="input text-xs" value={cloudflareConnection.apiBaseUrl} onChange={event => setCloudflareConnection(current => ({ ...current, apiBaseUrl: event.target.value }))} placeholder="https://api.cloudflare.com/client/v4/accounts/<account>/ai" aria-label="Cloudflare endpoint URL" />
            </label>
            <div className="mt-3 grid gap-2">
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-bold text-[#526267]">Voice (TTS) model</span>
                <input className="input text-xs" value={cloudflareConnection.ttsModel} onChange={event => setCloudflareConnection(current => ({ ...current, ttsModel: event.target.value }))} placeholder="@cf/deepgram/aura-2-en" aria-label="Cloudflare voice model" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-bold text-[#526267]">Transcription (STT) model</span>
                <input className="input text-xs" value={cloudflareConnection.sttModel} onChange={event => setCloudflareConnection(current => ({ ...current, sttModel: event.target.value }))} placeholder="@cf/deepgram/nova-3" aria-label="Cloudflare transcription model" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-bold text-[#526267]">Language (LLM) model</span>
                <input className="input text-xs" value={cloudflareConnection.llmModel} onChange={event => setCloudflareConnection(current => ({ ...current, llmModel: event.target.value }))} placeholder="@cf/zai-org/glm-5.3-flash" aria-label="Cloudflare language model" />
              </label>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[#748285]">Leave a model blank to use the default. Custom names appear in project setup.</p>
            {endpointMode && <p className="mt-2 rounded-lg bg-[#eef5f1] px-3 py-2 text-[11px] font-semibold text-[#3f776f]">{endpointMode}</p>}
            <div className="mt-4 flex gap-2">
              <button onClick={() => onSaveCloudflare(cloudflareConnection)} className="btn-primary btn-lg flex-1">
                <RefreshCw aria-hidden="true" size={15} /> Save endpoint
              </button>
              <button onClick={() => onValidate("Cloudflare")} className="btn-soft btn-lg">Test</button>
            </div>
          </div>

          <div className="rounded-[22px] border border-[#dfe5de] bg-[#fffefa] p-5">
            <span className="mono text-[10px] tracking-[.14em] text-[#658d87]">ROUTING DEFAULTS</span>
            <h3 className="mt-2 font-bold text-[#3a5052]">Keep choices intentional.</h3>
            <p className="mt-2 text-xs leading-5 text-[#748285]">
              Bookx asks before changing providers when a model becomes unavailable. Saving defaults seeds a model per task for any provider that has none.
            </p>
            <button onClick={() => onSave(customEndpoint.trim() || undefined)} className="btn-primary btn-lg mt-5 w-full">
              {saved ? <><Check aria-hidden="true" size={15} /> Defaults saved</> : <><RefreshCw aria-hidden="true" size={15} /> Save routing defaults</>}
            </button>
          </div>

          <div className="rounded-[22px] border border-[#cfe0db] bg-[#f5fbf8] p-5">
            <span className="mono text-[10px] tracking-[.14em] text-[#547d77]">CUSTOM OPENAI ROUTE</span>
            <h3 className="mt-2 font-bold text-[#3a5052]">OpenAI-compatible endpoint</h3>
            <p className="mt-2 text-xs leading-5 text-[#748285]">
              Optional base URL ending in <strong>/v1</strong> for a proxy or self-hosted gateway. Saved with your OpenAI preference when you save routing defaults.
            </p>
            <input className="input mt-4 text-xs" value={customEndpoint} onChange={event => setCustomEndpoint(event.target.value)} placeholder="https://llm.example.com/v1" aria-label="Custom OpenAI-compatible base URL" />
          </div>

          <div className="rounded-[22px] border border-[#eddabf] bg-[#fff9ee] p-4 text-xs leading-5 text-[#8d6b35]">
            <CircleAlert className="mr-1 inline" aria-hidden="true" size={14} />
            Keys are write-only: once saved, the server never returns the value to your browser. Saving a blank key leaves the current one in place.
          </div>
        </aside>
      </div>
    </div>
  );
}

/** One provider: status, capabilities, key entry, and a live connection test. */
function ProviderCard({
  provider,
  preference,
  check,
  onValidate,
  onSaveKey,
  saving,
}: {
  provider: ProviderCatalog;
  preference: SavedPreference | null;
  check?: { status: string; detail?: string };
  onValidate: () => void;
  onSaveKey: (apiKey: string) => void;
  saving: boolean;
}) {
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const hint = KEY_HINTS[provider.id];
  const hasKey = provider.configured;
  const fromEnvironment = provider.keySource === "environment";

  const statusTone = provider.configured
    ? "bg-[#e4f2eb] text-[#397868]"
    : "bg-[#fff0dc] text-[#9b712f]";

  return (
    <article className={`relative overflow-hidden rounded-[22px] border p-5 transition ${provider.configured ? "border-[#c9dfd5] bg-[#fffefa] shadow-[0_14px_34px_rgba(37,91,89,.07)]" : "border-[#e1e5de] bg-[#fbfbf7]"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${provider.id === "Cloudflare" ? "bg-[#f2a337] text-white" : "bg-[#e7f2ee] text-[#3c7e75]"}`}>
            {provider.id === "Cloudflare" ? <Cloud aria-hidden="true" size={19} /> : <KeyRound aria-hidden="true" size={18} />}
          </span>
          <div>
            <h4 className="text-sm font-bold text-[#35494b]">{provider.label}</h4>
            <p className="mt-0.5 text-[11px] text-[#7d898a]">
              {provider.models.length} model{provider.models.length === 1 ? "" : "s"}
              {hasKey && <> · key {fromEnvironment ? "from environment" : "saved in app"}</>}
            </p>
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[9px] font-bold ${statusTone}`}>
          {provider.configured ? "CONNECTED" : "NEEDS A KEY"}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {provider.capabilities.map(capability => (
          <span key={capability} className="inline-flex items-center gap-1 rounded-full border border-[#e1e8e1] bg-white px-2.5 py-1 text-[10px] font-semibold text-[#607476]">
            {capabilityIcon(capability)} {capabilityLabel[capability]}
          </span>
        ))}
      </div>

      <div className="mt-4 border-t border-[#ebeeea] pt-4">
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-bold text-[#526267]">API key</span>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={reveal ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                className="input w-full pr-9 text-xs"
                value={apiKey}
                onChange={event => setApiKey(event.target.value)}
                placeholder={hasKey ? "Saved — paste a new key to replace it" : hint?.prefix || "Paste the API key"}
                aria-label={`${provider.label} API key`}
              />
              <button
                type="button"
                onClick={() => setReveal(value => !value)}
                aria-label={reveal ? "Hide the key" : "Show the key"}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[#8a9492] hover:text-[#4e6063]"
              >
                {reveal ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
              </button>
            </div>
            <button
              onClick={() => { onSaveKey(apiKey.trim()); setApiKey(""); }}
              disabled={!apiKey.trim() || saving}
              className="btn-primary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : hasKey ? "Replace" : "Save key"}
            </button>
          </div>
        </label>
        {hint && <p className="mt-2 text-[11px] leading-5 text-[#8a9492]">{hint.help}</p>}
        {fromEnvironment && (
          <p className="mt-2 text-[11px] leading-5 text-[#8a9492]">
            Currently using the deployment's environment key. Saving one here overrides it for your account.
          </p>
        )}
      </div>

      <div className="mt-4 flex items-end justify-between gap-3 border-t border-[#ebeeea] pt-3">
        <p className="line-clamp-2 text-xs leading-5 text-[#6d7c7f]">
          {check?.status === "degraded"
            ? check.detail || "Temporarily unavailable — Bookx will ask before using a fallback."
            : check?.status === "connected"
              ? "Connection verified."
              : provider.models.slice(0, 2).map(model => model.label).join(" · ") || "No models discovered yet."}
        </p>
        <button
          onClick={onValidate}
          disabled={!provider.configured}
          className={`shrink-0 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40 ${check?.status === "degraded" ? "text-[#a76749] hover:text-[#824c33]" : "text-[#37766e] hover:text-[#204f51]"}`}
        >
          {check?.status === "connected" ? "Checked" : check?.status === "degraded" ? "Try again" : "Check"}
        </button>
      </div>
    </article>
  );
}
