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
      <div className="border-b border-stone-150 bg-[radial-gradient(circle_at_top_left,var(--color-brand-50),transparent_42%),var(--color-paper)] px-6 py-7 md:px-9">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="eyebrow text-brand-600">SYSTEM · MODEL ROUTING</p>
            <h2 className="serif mt-2 text-[34px] leading-[1.1] tracking-[-.02em] text-ink-950">Connections that follow your craft.</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-500">
              Paste, replace or remove a key for any provider below, or add your own. Keys are stored server-side, never returned to the browser, and take effect immediately.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-brand-100 bg-white/80 px-4 py-3 text-xs font-semibold text-brand-700 shadow-soft">
            <Cpu aria-hidden="true" size={16} /> {connected.length} of {providers.length} connected · {modelCount} models
          </div>
        </div>
      </div>

      <div className="grid flex-1 grid-cols-1 content-start gap-6 overflow-auto p-6 lg:grid-cols-[minmax(0,1fr)_340px] md:p-9">
        <section>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="serif text-[24px] leading-tight text-ink-950">Provider layer</h3>
              <p className="mt-1 text-xs text-ink-500">Add a key to enable a provider. Model lists are discovered server-side.</p>
            </div>
            <span className="eyebrow rounded-full bg-brand-50 px-3 py-1 text-brand-600">MODEL-AGNOSTIC</span>
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
              <h3 className="serif text-[24px] leading-tight text-ink-950">Your providers</h3>
              <p className="mt-1 max-w-xl text-xs leading-5 text-ink-500">
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
              <p className="rounded-card border border-dashed border-stone-300 bg-paper/70 px-5 py-4 text-xs leading-5 text-ink-500">
                No providers of your own yet.
              </p>
            )}
          </div>
        </section>

        <aside className="space-y-5">
          <div className="relative overflow-hidden rounded-card bg-[linear-gradient(160deg,var(--color-brand-800),var(--color-brand-950))] p-7 text-paper shadow-lift">
            <Cloud aria-hidden="true" className="text-gold-300" size={22} />
            <p className="eyebrow mt-5 text-brand-200">CLOUDFLARE WORKERS AI</p>
            <h3 className="serif mt-2 text-[32px] leading-[1.1] tracking-[-.015em]">Your live model catalog.</h3>
            <p className="mt-4 text-sm leading-6 text-brand-100">
              Prosecast reads the models available in your account, then shows only the ones that fit each task.
            </p>
            <div className="mt-6 rounded-2xl bg-white/[.07] p-4 ring-1 ring-white/10">
              <span className="block text-xs font-semibold">
                {cloudflare?.models.filter(model => model.capabilities.includes("language-model")).length || 0} language ·{" "}
                {cloudflare?.models.filter(model => model.capabilities.includes("text-to-speech")).length || 0} voice ·{" "}
                {cloudflare?.models.filter(model => model.capabilities.includes("speech-to-text")).length || 0} transcription
              </span>
              <span className="mt-1 block text-2xs text-brand-200">
                {cloudflare?.discoveryError
                  ? "Showing built-in defaults only — see the warning below."
                  : "Discovered from your account."}
              </span>
            </div>
            {cloudflare?.discoveryError && (
              <p className="mt-4 rounded-xl bg-clay-700/40 px-3 py-2.5 text-2xs leading-5 text-clay-200">
                <TriangleAlert className="mr-1 inline" aria-hidden="true" size={13} />
                Model discovery failed: {cloudflare.discoveryError}
              </p>
            )}
          </div>

          <div className="rounded-card border border-brand-100 bg-paper p-6 shadow-hairline">
            <span className="eyebrow text-brand-600">CLOUDFLARE ENDPOINT</span>
            <h3 className="serif mt-1.5 text-[21px] leading-tight text-ink-950">Advanced: endpoint and default models.</h3>
            <p className="mt-2 text-xs leading-5 text-ink-500">
              Only needed for an AI Gateway or another OpenAI-compatible endpoint, or to change the default models. The account ID and token go in the Cloudflare card on the left.
            </p>
            <label className="mt-4 block">
              <span className="mb-1.5 block text-2xs font-semibold text-ink-600">Endpoint URL</span>
              <input className="input text-xs" value={cloudflareConnection.apiBaseUrl} onChange={event => setCloudflareConnection(current => ({ ...current, apiBaseUrl: event.target.value }))} placeholder="https://api.cloudflare.com/client/v4/accounts/<account>/ai" aria-label="Cloudflare endpoint URL" />
            </label>
            <div className="mt-3 grid gap-2">
              <label className="block">
                <span className="mb-1.5 block text-2xs font-semibold text-ink-600">Voice (TTS) model</span>
                <input className="input text-xs" value={cloudflareConnection.ttsModel} onChange={event => setCloudflareConnection(current => ({ ...current, ttsModel: event.target.value }))} placeholder="@cf/deepgram/aura-2-en" aria-label="Cloudflare voice model" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-2xs font-semibold text-ink-600">Transcription (STT) model</span>
                <input className="input text-xs" value={cloudflareConnection.sttModel} onChange={event => setCloudflareConnection(current => ({ ...current, sttModel: event.target.value }))} placeholder="@cf/deepgram/nova-3" aria-label="Cloudflare transcription model" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-2xs font-semibold text-ink-600">Language (LLM) model</span>
                <input className="input text-xs" value={cloudflareConnection.llmModel} onChange={event => setCloudflareConnection(current => ({ ...current, llmModel: event.target.value }))} placeholder="@cf/zai-org/glm-5.3-flash" aria-label="Cloudflare language model" />
              </label>
            </div>
            <p className="mt-2 text-2xs leading-5 text-ink-500">Leave a model blank to use the default. Custom names appear in project setup.</p>
            {endpointMode && <p className="mt-2 rounded-lg bg-brand-50 px-3 py-2 text-2xs font-semibold text-brand-600">{endpointMode}</p>}
            <div className="mt-4 flex gap-2">
              <button onClick={() => onSaveCloudflare(cloudflareConnection)} className="btn-primary btn-lg flex-1">
                <RefreshCw aria-hidden="true" size={15} /> Save endpoint
              </button>
              <button onClick={() => onValidate("Cloudflare")} className="btn-soft btn-lg">Test</button>
            </div>
          </div>

          <div className="rounded-card border border-stone-150 bg-paper p-6 shadow-hairline">
            <span className="eyebrow text-brand-600">ROUTING DEFAULTS</span>
            <h3 className="serif mt-1.5 text-[21px] leading-tight text-ink-950">Keep choices intentional.</h3>
            <p className="mt-2 text-xs leading-5 text-ink-500">
              Prosecast asks before changing providers when a model becomes unavailable. Saving defaults seeds a model per task for any provider that has none.
            </p>
            <button onClick={() => onSave(customEndpoint.trim() || undefined)} className="btn-primary btn-lg mt-5 w-full">
              {saved ? <><Check aria-hidden="true" size={15} /> Defaults saved</> : <><RefreshCw aria-hidden="true" size={15} /> Save routing defaults</>}
            </button>
          </div>

          <div className="rounded-card border border-brand-100 bg-brand-50/50 p-6">
            <span className="eyebrow text-brand-600">CUSTOM OPENAI ROUTE</span>
            <h3 className="serif mt-1.5 text-[21px] leading-tight text-ink-950">OpenAI-compatible endpoint</h3>
            <p className="mt-2 text-xs leading-5 text-ink-500">
              Optional base URL ending in <strong>/v1</strong> for a proxy or self-hosted gateway. Saved with your OpenAI preference when you save routing defaults.
            </p>
            <input className="input mt-4 text-xs" value={customEndpoint} onChange={event => setCustomEndpoint(event.target.value)} placeholder="https://llm.example.com/v1" aria-label="Custom OpenAI-compatible base URL" />
          </div>

          <div className="rounded-card border border-gold-200 bg-gold-50 p-4 text-xs leading-5 text-gold-700">
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
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-500 hover:text-ink-600"
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
      <button type="button" onClick={() => setAsking(true)} className="inline-flex items-center gap-1 text-3xs font-semibold text-clay-600 hover:text-clay-700">
        <Trash2 aria-hidden="true" size={12} /> {label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-3xs font-semibold" role="group" aria-label={confirmLabel}>
      <span className="text-gold-700">{confirmLabel}</span>
      <button type="button" onClick={() => { setAsking(false); onConfirm(); }} className="rounded-md bg-clay-500 px-2 py-1 text-white hover:bg-clay-700">Remove</button>
      <button type="button" onClick={() => setAsking(false)} className="text-ink-500 hover:text-ink-700">Cancel</button>
    </span>
  );
}

function StatusBadge({ provider }: { provider: ProviderCatalog }) {
  const tone = provider.configured ? "bg-brand-50 text-brand-600" : "bg-gold-100 text-gold-700";
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-3xs font-semibold tracking-[.1em] ring-1 ring-inset ring-current/15 ${tone}`}>{provider.configured ? "CONNECTED" : provider.custom ? "INCOMPLETE" : "NEEDS A KEY"}</span>;
}

function CapabilityChips({ capabilities }: { capabilities: ProviderCapability[] }) {
  if (!capabilities.length) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {capabilities.map(capability => (
        <span key={capability} className="inline-flex items-center gap-1 rounded-full border border-stone-150 bg-white px-2.5 py-1 text-3xs font-semibold text-ink-600">
          {capabilityIcon(capability)} {capabilityLabel[capability]}
        </span>
      ))}
    </div>
  );
}

function CheckFooter({ provider, check, onValidate, extra }: { provider: ProviderCatalog; check?: { status: string; detail?: string }; onValidate: () => void; extra?: React.ReactNode }) {
  return (
    <div className="mt-4 flex items-end justify-between gap-3 border-t border-stone-100 pt-3">
      <p className="line-clamp-2 text-xs leading-5 text-ink-500" aria-live="polite">
        {check?.status === "degraded"
          ? check.detail || "Temporarily unavailable — Prosecast will ask before using a fallback."
          : check?.status === "connected"
            ? "Connection verified."
            : provider.models.slice(0, 2).map(model => model.label).join(" · ") || "No models discovered yet."}
      </p>
      <div className="flex shrink-0 items-center gap-3">
        {extra}
        <button
          onClick={onValidate}
          disabled={!provider.configured}
          className={`shrink-0 text-3xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${check?.status === "degraded" ? "text-clay-600 hover:text-clay-700" : "text-brand-600 hover:text-brand-800"}`}
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
    <article className={`relative overflow-hidden rounded-card border p-6 transition ${provider.configured ? "border-brand-100 bg-paper shadow-soft" : "border-stone-150 bg-paper-50"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
            <KeyRound aria-hidden="true" size={18} />
          </span>
          <div>
            <h4 className="text-[15px] font-semibold text-ink-900">{provider.label}</h4>
            <p className="mt-0.5 text-2xs text-ink-500">
              {provider.models.length} model{provider.models.length === 1 ? "" : "s"}
              {summary && <> · {summary}</>}
            </p>
          </div>
        </div>
        <StatusBadge provider={provider} />
      </div>

      <CapabilityChips capabilities={provider.capabilities} />

      <div className="mt-4 border-t border-stone-100 pt-4">
        <label className="block">
          <span className="mb-1.5 block text-2xs font-semibold text-ink-600">API key</span>
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
        {hint && <p className="mt-2 text-2xs leading-5 text-ink-500">{hint.help}</p>}
        {provider.keySource === "environment" && (
          <p className="mt-2 text-2xs leading-5 text-ink-500">
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

  // Follows the saved account both ways: after "Remove saved" the removed ID
  // used to stay in the field and re-enable Save.
  useEffect(() => {
    setAccountId(provider.accountSource === "app" ? provider.accountId ?? "" : "");
  }, [provider.accountSource, provider.accountId]);

  return (
    <article className={`relative overflow-hidden rounded-card border p-6 transition ${provider.configured ? "border-brand-100 bg-paper shadow-soft" : "border-stone-150 bg-paper-50"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gold-400 text-white">
            <Cloud aria-hidden="true" size={19} />
          </span>
          <div>
            <h4 className="text-[15px] font-semibold text-ink-900">{provider.label}</h4>
            <p className="mt-0.5 text-2xs text-ink-500">
              {provider.models.length} model{provider.models.length === 1 ? "" : "s"}
              {summary && <> · {summary}</>}
            </p>
          </div>
        </div>
        <StatusBadge provider={provider} />
      </div>

      <CapabilityChips capabilities={provider.capabilities} />

      <div className="mt-4 grid gap-3 border-t border-stone-100 pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <label className="block">
          <span className="mb-1.5 block text-2xs font-semibold text-ink-600">Account ID</span>
          <input
            className={`input text-xs ${accountInvalid ? "border-clay-300" : ""}`}
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
          <span className="mb-1.5 block text-2xs font-semibold text-ink-600">API token</span>
          <KeyInput
            value={token}
            onChange={setToken}
            placeholder={provider.keySource ? "Paste a new token to replace the current one" : "Workers AI API token"}
            label="Cloudflare API token"
          />
        </label>
      </div>
      {accountInvalid && <p className="mt-2 text-2xs text-clay-600">An account ID is 32 letters and digits (0–9, a–f).</p>}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-2xs leading-5 text-ink-500">{KEY_HINTS.Cloudflare?.help}</p>
        <button
          onClick={() => { onSave(accountChanged ? trimmedAccount : "", token.trim()); setToken(""); }}
          disabled={!canSave}
          className="btn-primary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {provider.accountSource === "environment" && (
        <p className="mt-2 text-2xs leading-5 text-ink-500">
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
    <article className={`relative overflow-hidden rounded-card border p-6 transition ${provider.configured ? "border-brand-100 bg-paper shadow-soft" : "border-stone-150 bg-paper-50"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600 ring-1 ring-sky-100">
            <Waves aria-hidden="true" size={18} />
          </span>
          <div className="min-w-0">
            <h4 className="truncate text-[15px] font-semibold text-ink-900">{provider.label}</h4>
            <p className="mt-0.5 truncate text-2xs text-ink-500">
              {host}
              {provider.keySource ? <> · {keySummary(provider)}</> : " · no key"}
            </p>
          </div>
        </div>
        <StatusBadge provider={provider} />
      </div>

      <CapabilityChips capabilities={provider.capabilities} />

      <dl className="mt-4 grid gap-2 border-t border-stone-100 pt-4 text-2xs text-ink-500 sm:grid-cols-2">
        <div><dt className="font-semibold text-ink-600">Voice model</dt><dd className="mt-0.5 break-all">{settings?.ttsModel || "—"}</dd></div>
        <div><dt className="font-semibold text-ink-600">Transcription model</dt><dd className="mt-0.5 break-all">{settings?.sttModel || "—"}</dd></div>
        <div className="sm:col-span-2"><dt className="font-semibold text-ink-600">Voices</dt><dd className="mt-0.5 line-clamp-2">{voices.length ? voices.join(", ") : "—"}</dd></div>
      </dl>

      <CheckFooter
        provider={provider}
        check={check}
        onValidate={onValidate}
        extra={
          <>
            <button type="button" onClick={onEdit} className="inline-flex items-center gap-1 text-3xs font-semibold text-brand-600 hover:text-brand-800">
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
      <span className="mb-1.5 block text-2xs font-semibold text-ink-600">{label}</span>
      <input className="input text-xs" value={draft[key]} onChange={event => set(key, event.target.value)} placeholder={placeholder} maxLength={maxLength} spellCheck={false} autoComplete="off" id={`${formId}-${key}`} />
      {help && <span className="mt-1 block text-2xs leading-5 text-ink-500">{help}</span>}
    </label>
  );

  return (
    <form onSubmit={submit} className="rounded-card border border-brand-200 bg-paper p-6 shadow-soft" aria-label={editingExisting ? `Edit ${initial.label}` : "Add a provider"}>
      <h4 className="text-[15px] font-semibold text-ink-900">{editingExisting ? `Edit ${initial.label}` : "Add a provider"}</h4>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {field("label", "Name", "e.g. My speech server", CUSTOM_PROVIDER_LIMITS.label)}
        {field("baseUrl", "API address", "https://api.example.com/v1", CUSTOM_PROVIDER_LIMITS.url, "The part before /audio/speech.")}
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-2xs font-semibold text-ink-600">API key</span>
          <KeyInput
            value={draft.apiKey}
            onChange={value => set("apiKey", value)}
            placeholder={savedKeyHint ? `Saved (${savedKeyHint}) — paste a new key to replace it` : "Optional, if the service needs one"}
            label="Provider API key"
          />
          {savedKeyHint && (
            <span className="mt-2 flex items-center gap-2 text-2xs text-ink-500">
              <input type="checkbox" checked={draft.removeKey} onChange={event => set("removeKey", event.target.checked)} id={`${formId}-remove-key`} />
              <label htmlFor={`${formId}-remove-key`}>Remove the saved key</label>
            </span>
          )}
        </label>
        {field("ttsModel", "Voice model", "e.g. tts-1", CUSTOM_PROVIDER_LIMITS.model)}
        {field("sttModel", "Transcription model (optional)", "e.g. whisper-1", CUSTOM_PROVIDER_LIMITS.model)}
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-2xs font-semibold text-ink-600">Voices</span>
          <textarea
            className="input min-h-[64px] text-xs"
            value={draft.voices}
            onChange={event => set("voices", event.target.value)}
            placeholder="Comma-separated voice names, e.g. alloy, nova, onyx"
            spellCheck={false}
            id={`${formId}-voices`}
          />
          <span className="mt-1 block text-2xs leading-5 text-ink-500">
            {voices.length ? `${voices.length} voice${voices.length === 1 ? "" : "s"}: the first is the default narrator.` : "The voice names the service accepts."}
          </span>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-2xs text-clay-600" aria-live="polite">{missing ?? ""}</p>
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
