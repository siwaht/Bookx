import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Cloud, Cpu, Eye, EyeOff, KeyRound, Mic2, Pencil, Plus, RefreshCw, Sparkles, Trash2, TriangleAlert, Waves } from "lucide-react";
import { CUSTOM_PROVIDER_LIMITS, parseVoiceList } from "@shared/providers";

type ProviderCapability = "text-to-speech" | "speech-to-text" | "language-model";

export type ProviderCatalog = {
  id: string;
  label: string;
  configured: boolean;
  status: "connected" | "available" | "optional";
  /** Where the key came from, when there is one. */
  keySource?: "app" | "environment";
  /** The last characters of the key in use. */
  keyHint?: string;
  /** Whether the deployment also provides a key, which applies if the saved one is removed. */
  environmentKey?: boolean;
  /** Set when live model discovery failed. */
  discoveryError?: string;
  capabilities: ProviderCapability[];
  models: { id: string; label: string; capabilities: ProviderCapability[]; detail?: string }[];
  /** Cloudflare: the account in use and where it came from. */
  accountId?: string;
  accountSource?: "app" | "environment";
  /** Set for a provider the user added: its settings, never its key. */
  custom?: { baseUrl: string; ttsModel: string; sttModel: string; voices: string[] };
};

export type CloudflareConnectionDraft = {
  apiBaseUrl: string;
  apiKey: string;
  ttsModel: string;
  sttModel: string;
  llmModel: string;
};

export type CustomProviderDraft = {
  /** Set when editing an existing provider. */
  id?: string;
  label: string;
  baseUrl: string;
  /** Blank keeps the saved key when editing. */
  apiKey: string;
  removeKey: boolean;
  ttsModel: string;
  sttModel: string;
  voices: string;
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
  saved: boolean;
  onSave: (customEndpoint?: string) => void;
  onSaveKey: (provider: string, apiKey: string) => void;
  onRemoveKey: (provider: string) => void;
  onSaveCloudflareAccount: (accountId: string, apiToken: string) => void;
  onSaveCloudflare: (connection: CloudflareConnectionDraft) => void;
  /** Resolves to true once saved, so the form can close. */
  onSaveCustomProvider: (draft: CustomProviderDraft) => Promise<boolean>;
  onRemoveCustomProvider: (id: string) => void;
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
  OpenRouter: { help: "openrouter.ai → Keys. One key reaches hundreds of models.", prefix: "starts with sk-or-" },
  Cloudflare: { help: "A Workers AI token from Cloudflare → AI → Workers AI. The account ID is on the same page.", prefix: "" },
  "Fish Audio": { help: "fish.audio → API keys. Your own cloned voices appear in the cast list.", prefix: "" },
  Gradium: { help: "Create a key in Gradium Studio (studio.gradium.ai). Custom voices appear in the cast list.", prefix: "" },
};

const CLOUDFLARE_ACCOUNT_ID = /^[a-f0-9]{32}$/i;

const emptyCustomDraft: CustomProviderDraft = { label: "", baseUrl: "", apiKey: "", removeKey: false, ttsModel: "", sttModel: "", voices: "" };

/** Which key a card is showing: saved here, or supplied by the deployment. */
function keySummary(provider: ProviderCatalog): string | null {
  if (!provider.keySource) return null;
  const hint = provider.keyHint && provider.keyHint !== "…" ? ` ${provider.keyHint}` : "";
  return provider.keySource === "environment" ? `key from deployment${hint}` : `key saved in app${hint}`;
}

export function ProviderSettings({
  providers,
  saved,
  onSave,
  onSaveKey,
  onRemoveKey,
  onSaveCloudflareAccount,
  onSaveCloudflare,
  onSaveCustomProvider,
  onRemoveCustomProvider,
  cloudflareSaved,
  checks,
  onValidate,
  savingKey,
}: ProviderSettingsProps) {
  const connected = providers.filter(provider => provider.configured);
  const builtIn = providers.filter(provider => !provider.custom);
  const custom = providers.filter(provider => provider.custom);
  const cloudflare = providers.find(provider => provider.id === "Cloudflare");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [cloudflareConnection, setCloudflareConnection] = useState<CloudflareConnectionDraft>({ apiBaseUrl: "", apiKey: "", ttsModel: "", sttModel: "", llmModel: "" });
  const hydratedCloudflare = useRef(false);
  /** The custom provider being edited, or "new" while adding one. */
  const [editing, setEditing] = useState<string | null>(null);

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
              Paste, replace or remove a key for any provider below, or add your own. Keys are stored server-side, never returned to the browser, and take effect immediately.
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
            {builtIn.map(provider =>
              provider.id === "Cloudflare" ? (
                <CloudflareCard
                  key={provider.id}
                  provider={provider}
                  check={checks[provider.id]}
                  onValidate={() => onValidate(provider.id)}
                  onSave={onSaveCloudflareAccount}
                  onRemove={() => onRemoveKey(provider.id)}
                  saving={savingKey === provider.id}
                />
              ) : (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  check={checks[provider.id]}
                  onValidate={() => onValidate(provider.id)}
                  onSaveKey={apiKey => onSaveKey(provider.id, apiKey)}
                  onRemoveKey={() => onRemoveKey(provider.id)}
                  saving={savingKey === provider.id}
                />
              ),
            )}
          </div>

          <div className="mb-4 mt-9 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="font-bold text-[#34484a]">Your providers</h3>
              <p className="mt-1 max-w-xl text-xs leading-5 text-[#778689]">
                Add any other service with an OpenAI-compatible speech API (it answers <strong>POST …/audio/speech</strong>). Give it the voices it offers and it appears in project setup and the cast list like any other provider.
              </p>
            </div>
            {editing !== "new" && (
              <button type="button" onClick={() => setEditing("new")} className="btn-soft btn-lg shrink-0">
                <Plus aria-hidden="true" size={15} /> Add a provider
              </button>
            )}
          </div>

          <div className="grid gap-4">
            {editing === "new" && (
              <CustomProviderForm
                initial={emptyCustomDraft}
                onCancel={() => setEditing(null)}
                onSave={async draft => {
                  const ok = await onSaveCustomProvider(draft);
                  if (ok) setEditing(null);
                  return ok;
                }}
              />
            )}
            {custom.map(provider =>
              editing === provider.id ? (
                <CustomProviderForm
                  key={provider.id}
                  initial={{
                    id: provider.id,
                    label: provider.label,
                    baseUrl: provider.custom?.baseUrl ?? "",
                    apiKey: "",
                    removeKey: false,
                    ttsModel: provider.custom?.ttsModel ?? "",
                    sttModel: provider.custom?.sttModel ?? "",
                    voices: (provider.custom?.voices ?? []).join(", "),
                  }}
                  savedKeyHint={provider.keySource ? provider.keyHint ?? "…" : undefined}
                  onCancel={() => setEditing(null)}
                  onSave={async draft => {
                    const ok = await onSaveCustomProvider(draft);
                    if (ok) setEditing(null);
                    return ok;
                  }}
                />
              ) : (
                <CustomProviderCard
                  key={provider.id}
                  provider={provider}
                  check={checks[provider.id]}
                  onValidate={() => onValidate(provider.id)}
                  onEdit={() => setEditing(provider.id)}
                  onRemove={() => onRemoveCustomProvider(provider.id)}
                />
              ),
            )}
            {!custom.length && editing !== "new" && (
              <p className="rounded-[22px] border border-dashed border-[#d5ded6] bg-[#fbfbf7] px-5 py-4 text-xs leading-5 text-[#7d898a]">
                No providers of your own yet.
              </p>
            )}
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
            <h3 className="mt-2 font-bold text-[#3a5052]">Advanced: endpoint and default models.</h3>
            <p className="mt-2 text-xs leading-5 text-[#748285]">
              Only needed for an AI Gateway or another OpenAI-compatible endpoint, or to change the default models. The account ID and token go in the Cloudflare card on the left.
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
            Keys are write-only: once saved, the server never returns them to your browser, only their last four characters so you can tell them apart. Removing a saved key switches back to the deployment's key, where there is one.
          </div>
        </aside>
      </div>
    </div>
  );
}

/** A masked key field with a show/hide toggle. */
function KeyInput({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="relative flex-1">
      <input
        type={reveal ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        className="input w-full pr-9 text-xs"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
      <button
        type="button"
        onClick={() => setReveal(current => !current)}
        aria-label={reveal ? "Hide the key" : "Show the key"}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[#8a9492] hover:text-[#4e6063]"
      >
        {reveal ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
      </button>
    </div>
  );
}

/** A remove button that asks once before acting. */
function ConfirmRemove({ label, confirmLabel, onConfirm }: { label: string; confirmLabel: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)} className="inline-flex items-center gap-1 text-[10px] font-bold text-[#a76749] hover:text-[#824c33]">
        <Trash2 aria-hidden="true" size={12} /> {label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-[10px] font-bold" role="group" aria-label={confirmLabel}>
      <span className="text-[#8a6a4f]">{confirmLabel}</span>
      <button type="button" onClick={() => { setAsking(false); onConfirm(); }} className="rounded-md bg-[#a76749] px-2 py-1 text-white hover:bg-[#824c33]">Remove</button>
      <button type="button" onClick={() => setAsking(false)} className="text-[#607476] hover:text-[#34484a]">Cancel</button>
    </span>
  );
}

function StatusBadge({ provider }: { provider: ProviderCatalog }) {
  const tone = provider.configured ? "bg-[#e4f2eb] text-[#397868]" : "bg-[#fff0dc] text-[#9b712f]";
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[9px] font-bold ${tone}`}>{provider.configured ? "CONNECTED" : provider.custom ? "INCOMPLETE" : "NEEDS A KEY"}</span>;
}

function CapabilityChips({ capabilities }: { capabilities: ProviderCapability[] }) {
  if (!capabilities.length) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {capabilities.map(capability => (
        <span key={capability} className="inline-flex items-center gap-1 rounded-full border border-[#e1e8e1] bg-white px-2.5 py-1 text-[10px] font-semibold text-[#607476]">
          {capabilityIcon(capability)} {capabilityLabel[capability]}
        </span>
      ))}
    </div>
  );
}

function CheckFooter({ provider, check, onValidate, extra }: { provider: ProviderCatalog; check?: { status: string; detail?: string }; onValidate: () => void; extra?: React.ReactNode }) {
  return (
    <div className="mt-4 flex items-end justify-between gap-3 border-t border-[#ebeeea] pt-3">
      <p className="line-clamp-2 text-xs leading-5 text-[#6d7c7f]" aria-live="polite">
        {check?.status === "degraded"
          ? check.detail || "Temporarily unavailable — Bookx will ask before using a fallback."
          : check?.status === "connected"
            ? "Connection verified."
            : provider.models.slice(0, 2).map(model => model.label).join(" · ") || "No models discovered yet."}
      </p>
      <div className="flex shrink-0 items-center gap-3">
        {extra}
        <button
          onClick={onValidate}
          disabled={!provider.configured}
          className={`shrink-0 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40 ${check?.status === "degraded" ? "text-[#a76749] hover:text-[#824c33]" : "text-[#37766e] hover:text-[#204f51]"}`}
        >
          {check?.status === "connected" ? "Checked" : check?.status === "degraded" ? "Try again" : "Check"}
        </button>
      </div>
    </div>
  );
}

/** One provider: status, capabilities, key entry, and a live connection test. */
function ProviderCard({
  provider,
  check,
  onValidate,
  onSaveKey,
  onRemoveKey,
  saving,
}: {
  provider: ProviderCatalog;
  check?: { status: string; detail?: string };
  onValidate: () => void;
  onSaveKey: (apiKey: string) => void;
  onRemoveKey: () => void;
  saving: boolean;
}) {
  const [apiKey, setApiKey] = useState("");
  const hint = KEY_HINTS[provider.id];
  const hasKey = provider.configured;
  const summary = keySummary(provider);

  return (
    <article className={`relative overflow-hidden rounded-[22px] border p-5 transition ${provider.configured ? "border-[#c9dfd5] bg-[#fffefa] shadow-[0_14px_34px_rgba(37,91,89,.07)]" : "border-[#e1e5de] bg-[#fbfbf7]"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e7f2ee] text-[#3c7e75]">
            <KeyRound aria-hidden="true" size={18} />
          </span>
          <div>
            <h4 className="text-sm font-bold text-[#35494b]">{provider.label}</h4>
            <p className="mt-0.5 text-[11px] text-[#7d898a]">
              {provider.models.length} model{provider.models.length === 1 ? "" : "s"}
              {summary && <> · {summary}</>}
            </p>
          </div>
        </div>
        <StatusBadge provider={provider} />
      </div>

      <CapabilityChips capabilities={provider.capabilities} />

      <div className="mt-4 border-t border-[#ebeeea] pt-4">
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-bold text-[#526267]">API key</span>
          <div className="flex gap-2">
            <KeyInput
              value={apiKey}
              onChange={setApiKey}
              placeholder={hasKey ? "Paste a new key to replace the current one" : hint?.prefix || "Paste the API key"}
              label={`${provider.label} API key`}
            />
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
        {provider.keySource === "environment" && (
          <p className="mt-2 text-[11px] leading-5 text-[#8a9492]">
            Using the deployment's key. Saving one here overrides it for your account.
          </p>
        )}
      </div>

      <CheckFooter
        provider={provider}
        check={check}
        onValidate={onValidate}
        extra={provider.keySource === "app" && (
          <ConfirmRemove
            label="Remove key"
            confirmLabel={provider.environmentKey ? "Switch back to the deployment's key?" : "Remove this key?"}
            onConfirm={onRemoveKey}
          />
        )}
      />
    </article>
  );
}

/** Cloudflare needs an account ID as well as a token. */
function CloudflareCard({
  provider,
  check,
  onValidate,
  onSave,
  onRemove,
  saving,
}: {
  provider: ProviderCatalog;
  check?: { status: string; detail?: string };
  onValidate: () => void;
  onSave: (accountId: string, apiToken: string) => void;
  onRemove: () => void;
  saving: boolean;
}) {
  const [accountId, setAccountId] = useState(provider.accountSource === "app" ? provider.accountId ?? "" : "");
  const [token, setToken] = useState("");
  const trimmedAccount = accountId.trim();
  const accountInvalid = Boolean(trimmedAccount) && !CLOUDFLARE_ACCOUNT_ID.test(trimmedAccount);
  const accountChanged = Boolean(trimmedAccount) && trimmedAccount !== (provider.accountSource === "app" ? provider.accountId : undefined);
  const canSave = !saving && !accountInvalid && (accountChanged || Boolean(token.trim()));
  const summary = keySummary(provider);
  const savedHere = provider.keySource === "app" || provider.accountSource === "app";

  useEffect(() => {
    if (provider.accountSource === "app" && provider.accountId) setAccountId(provider.accountId);
  }, [provider.accountSource, provider.accountId]);

  return (
    <article className={`relative overflow-hidden rounded-[22px] border p-5 transition ${provider.configured ? "border-[#c9dfd5] bg-[#fffefa] shadow-[0_14px_34px_rgba(37,91,89,.07)]" : "border-[#e1e5de] bg-[#fbfbf7]"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f2a337] text-white">
            <Cloud aria-hidden="true" size={19} />
          </span>
          <div>
            <h4 className="text-sm font-bold text-[#35494b]">{provider.label}</h4>
            <p className="mt-0.5 text-[11px] text-[#7d898a]">
              {provider.models.length} model{provider.models.length === 1 ? "" : "s"}
              {summary && <> · {summary}</>}
            </p>
          </div>
        </div>
        <StatusBadge provider={provider} />
      </div>

      <CapabilityChips capabilities={provider.capabilities} />

      <div className="mt-4 grid gap-3 border-t border-[#ebeeea] pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-bold text-[#526267]">Account ID</span>
          <input
            className={`input text-xs ${accountInvalid ? "border-[#d59a80]" : ""}`}
            value={accountId}
            onChange={event => setAccountId(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder={provider.accountSource === "environment" && provider.accountId ? `Deployment's: ${provider.accountId.slice(0, 6)}…` : "32-character account ID"}
            aria-label="Cloudflare account ID"
            aria-invalid={accountInvalid}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-bold text-[#526267]">API token</span>
          <KeyInput
            value={token}
            onChange={setToken}
            placeholder={provider.keySource ? "Paste a new token to replace the current one" : "Workers AI API token"}
            label="Cloudflare API token"
          />
        </label>
      </div>
      {accountInvalid && <p className="mt-2 text-[11px] text-[#a76749]">An account ID is 32 letters and digits (0–9, a–f).</p>}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] leading-5 text-[#8a9492]">{KEY_HINTS.Cloudflare?.help}</p>
        <button
          onClick={() => { onSave(accountChanged ? trimmedAccount : "", token.trim()); setToken(""); }}
          disabled={!canSave}
          className="btn-primary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {provider.accountSource === "environment" && (
        <p className="mt-2 text-[11px] leading-5 text-[#8a9492]">
          Using the deployment's account{provider.keySource === "environment" ? " and token" : ""}. Anything saved here overrides it for your account.
        </p>
      )}

      <CheckFooter
        provider={provider}
        check={check}
        onValidate={onValidate}
        extra={savedHere && (
          <ConfirmRemove
            label="Remove saved"
            confirmLabel={provider.environmentKey ? "Switch back to the deployment's account?" : "Remove the saved account and token?"}
            onConfirm={onRemove}
          />
        )}
      />
    </article>
  );
}

/** A provider the user added. */
function CustomProviderCard({
  provider,
  check,
  onValidate,
  onEdit,
  onRemove,
}: {
  provider: ProviderCatalog;
  check?: { status: string; detail?: string };
  onValidate: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const settings = provider.custom;
  let host = settings?.baseUrl ?? "";
  try {
    host = new URL(host).host;
  } catch {
    // Shown as saved.
  }
  const voices = settings?.voices ?? [];
  return (
    <article className={`relative overflow-hidden rounded-[22px] border p-5 transition ${provider.configured ? "border-[#c9dfd5] bg-[#fffefa] shadow-[0_14px_34px_rgba(37,91,89,.07)]" : "border-[#e1e5de] bg-[#fbfbf7]"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#ece8f4] text-[#6c5a8e]">
            <Waves aria-hidden="true" size={18} />
          </span>
          <div className="min-w-0">
            <h4 className="truncate text-sm font-bold text-[#35494b]">{provider.label}</h4>
            <p className="mt-0.5 truncate text-[11px] text-[#7d898a]">
              {host}
              {provider.keySource ? <> · {keySummary(provider)}</> : " · no key"}
            </p>
          </div>
        </div>
        <StatusBadge provider={provider} />
      </div>

      <CapabilityChips capabilities={provider.capabilities} />

      <dl className="mt-4 grid gap-2 border-t border-[#ebeeea] pt-4 text-[11px] text-[#607476] sm:grid-cols-2">
        <div><dt className="font-bold text-[#526267]">Voice model</dt><dd className="mt-0.5 break-all">{settings?.ttsModel || "—"}</dd></div>
        <div><dt className="font-bold text-[#526267]">Transcription model</dt><dd className="mt-0.5 break-all">{settings?.sttModel || "—"}</dd></div>
        <div className="sm:col-span-2"><dt className="font-bold text-[#526267]">Voices</dt><dd className="mt-0.5 line-clamp-2">{voices.length ? voices.join(", ") : "—"}</dd></div>
      </dl>

      <CheckFooter
        provider={provider}
        check={check}
        onValidate={onValidate}
        extra={
          <>
            <button type="button" onClick={onEdit} className="inline-flex items-center gap-1 text-[10px] font-bold text-[#37766e] hover:text-[#204f51]">
              <Pencil aria-hidden="true" size={12} /> Edit
            </button>
            <ConfirmRemove label="Remove" confirmLabel="Remove this provider?" onConfirm={onRemove} />
          </>
        }
      />
    </article>
  );
}

/** Adds or edits one of the user's providers. */
function CustomProviderForm({
  initial,
  savedKeyHint,
  onSave,
  onCancel,
}: {
  initial: CustomProviderDraft;
  /** Set when editing a provider that has a saved key. */
  savedKeyHint?: string;
  onSave: (draft: CustomProviderDraft) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CustomProviderDraft>(initial);
  const [submitting, setSubmitting] = useState(false);
  const set = <K extends keyof CustomProviderDraft>(key: K, value: CustomProviderDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const voices = parseVoiceList(draft.voices);
  const missing = !draft.label.trim()
    ? "Give the provider a name."
    : !draft.baseUrl.trim()
      ? "Add the provider's API address."
      : !draft.ttsModel.trim() && !draft.sttModel.trim()
        ? "Add a voice model, a transcription model, or both."
        : draft.ttsModel.trim() && !voices.length
          ? "Add at least one voice for the voice model."
          : null;
  const editingExisting = Boolean(initial.id);
  const formId = initial.id ?? "new";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (missing || submitting) return;
    setSubmitting(true);
    try {
      await onSave(draft);
    } finally {
      setSubmitting(false);
    }
  };

  const field = (key: "label" | "baseUrl" | "ttsModel" | "sttModel", label: string, placeholder: string, maxLength: number, help?: string) => (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-bold text-[#526267]">{label}</span>
      <input className="input text-xs" value={draft[key]} onChange={event => set(key, event.target.value)} placeholder={placeholder} maxLength={maxLength} spellCheck={false} autoComplete="off" id={`${formId}-${key}`} />
      {help && <span className="mt-1 block text-[11px] leading-5 text-[#8a9492]">{help}</span>}
    </label>
  );

  return (
    <form onSubmit={submit} className="rounded-[22px] border border-[#b9d6cd] bg-[#fffefa] p-5 shadow-[0_14px_34px_rgba(37,91,89,.07)]" aria-label={editingExisting ? `Edit ${initial.label}` : "Add a provider"}>
      <h4 className="text-sm font-bold text-[#35494b]">{editingExisting ? `Edit ${initial.label}` : "Add a provider"}</h4>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {field("label", "Name", "e.g. My speech server", CUSTOM_PROVIDER_LIMITS.label)}
        {field("baseUrl", "API address", "https://api.example.com/v1", CUSTOM_PROVIDER_LIMITS.url, "The part before /audio/speech.")}
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-[11px] font-bold text-[#526267]">API key</span>
          <KeyInput
            value={draft.apiKey}
            onChange={value => set("apiKey", value)}
            placeholder={savedKeyHint ? `Saved (${savedKeyHint}) — paste a new key to replace it` : "Optional, if the service needs one"}
            label="Provider API key"
          />
          {savedKeyHint && (
            <span className="mt-2 flex items-center gap-2 text-[11px] text-[#607476]">
              <input type="checkbox" checked={draft.removeKey} onChange={event => set("removeKey", event.target.checked)} id={`${formId}-remove-key`} />
              <label htmlFor={`${formId}-remove-key`}>Remove the saved key</label>
            </span>
          )}
        </label>
        {field("ttsModel", "Voice model", "e.g. tts-1", CUSTOM_PROVIDER_LIMITS.model)}
        {field("sttModel", "Transcription model (optional)", "e.g. whisper-1", CUSTOM_PROVIDER_LIMITS.model)}
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-[11px] font-bold text-[#526267]">Voices</span>
          <textarea
            className="input min-h-[64px] text-xs"
            value={draft.voices}
            onChange={event => set("voices", event.target.value)}
            placeholder="Comma-separated voice names, e.g. alloy, nova, onyx"
            spellCheck={false}
            id={`${formId}-voices`}
          />
          <span className="mt-1 block text-[11px] leading-5 text-[#8a9492]">
            {voices.length ? `${voices.length} voice${voices.length === 1 ? "" : "s"}: the first is the default narrator.` : "The voice names the service accepts."}
          </span>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-[#a76749]" aria-live="polite">{missing ?? ""}</p>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="btn-soft btn-lg">Cancel</button>
          <button type="submit" disabled={Boolean(missing) || submitting} className="btn-primary btn-lg">
            {submitting ? "Saving…" : editingExisting ? "Save changes" : "Add provider"}
          </button>
        </div>
      </div>
    </form>
  );
}
