import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Cloud, Cpu, KeyRound, Mic2, RefreshCw, Sparkles, Waves } from "lucide-react";

type ProviderCapability = "text-to-speech" | "speech-to-text" | "language-model";
type ProviderCatalog = {
  id: string;
  label: string;
  configured: boolean;
  status: "connected" | "available" | "optional";
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

type SavedCloudflarePreference = {
  apiBaseUrl?: string | null;
  apiKeyConfigured?: boolean | null;
  defaultTtsModel?: string | null;
  defaultSttModel?: string | null;
  defaultLlmModel?: string | null;
} | null;

type ProviderSettingsProps = {
  providers: ProviderCatalog[];
  saved: boolean;
  onSave: (customEndpoint?: string) => void;
  onSaveCloudflare: (connection: CloudflareConnectionDraft) => void;
  cloudflareSaved: SavedCloudflarePreference;
  checks: Record<string, { status: string; detail?: string }>;
  onValidate: (provider: string) => void;
};

const capabilityLabel: Record<ProviderCapability, string> = {
  "text-to-speech": "Voice",
  "speech-to-text": "Transcribe",
  "language-model": "LLM",
};

function capabilityIcon(capability: ProviderCapability) {
  if (capability === "text-to-speech") return <Waves size={13} />;
  if (capability === "speech-to-text") return <Mic2 size={13} />;
  return <Sparkles size={13} />;
}

export function ProviderSettings({ providers, saved, onSave, onSaveCloudflare, cloudflareSaved, checks, onValidate }: ProviderSettingsProps) {
  const connected = providers.filter((provider) => provider.status === "connected");
  const cloudflare = providers.find((provider) => provider.id === "Cloudflare");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [cloudflareConnection, setCloudflareConnection] = useState<CloudflareConnectionDraft>({ apiBaseUrl: "", apiKey: "", ttsModel: "", sttModel: "", llmModel: "" });
  const hydratedCloudflare = useRef(false);

  useEffect(() => {
    if (hydratedCloudflare.current || !cloudflareSaved) return;
    hydratedCloudflare.current = true;
    setCloudflareConnection((current) => ({
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[#d8e2dc] bg-[radial-gradient(circle_at_top_left,#eaf5ef,transparent_42%),#fffefa] px-6 py-7 md:px-9">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="mono text-[10px] tracking-[.18em] text-[#4f8980]">SYSTEM · MODEL ROUTING</p>
            <h2 className="serif mt-2 text-3xl tracking-[-.045em] text-[#203a3d]">Connections that follow your craft.</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#6f7e80]">Choose models by capability, not by vendor. Every connection stays private; your project simply sees the options it can use.</p>
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-[#cbe1d8] bg-white/80 px-4 py-3 text-xs font-semibold text-[#386f69] shadow-sm">
            <Cpu size={16} /> {connected.length} connected providers · {providers.reduce((total, provider) => total + provider.models.length, 0)} models available
          </div>
        </div>
      </div>

      <div className="grid flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_340px] md:p-9">
        <section>
          <div className="mb-4 flex items-center justify-between">
            <div><h3 className="font-bold text-[#34484a]">Provider layer</h3><p className="mt-1 text-xs text-[#778689]">Connection state and model capability are discovered server-side.</p></div>
            <span className="mono rounded-full bg-[#edf5f0] px-3 py-1 text-[9px] tracking-[.12em] text-[#50837b]">MODEL-AGNOSTIC</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {providers.map((provider) => (
              <article key={provider.id} className={`relative overflow-hidden rounded-[22px] border p-5 transition ${provider.status === "connected" ? "border-[#c9dfd5] bg-[#fffefa] shadow-[0_14px_34px_rgba(37,91,89,.07)]" : "border-[#e1e5de] bg-[#fbfbf7]"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3"><span className={`grid h-10 w-10 place-items-center rounded-xl ${provider.id === "Cloudflare" ? "bg-[#f2a337] text-white" : "bg-[#e7f2ee] text-[#3c7e75]"}`}>{provider.id === "Cloudflare" ? <Cloud size={19} /> : <KeyRound size={18} />}</span><div><h4 className="text-sm font-bold text-[#35494b]">{provider.label}</h4><p className="mt-0.5 text-[11px] text-[#7d898a]">{provider.models.length} compatible models</p></div></div>
                  <span className={`rounded-full px-2.5 py-1 text-[9px] font-bold ${provider.status === "connected" ? "bg-[#e4f2eb] text-[#397868]" : provider.status === "optional" ? "bg-[#f0f1ed] text-[#7b8584]" : "bg-[#fff0dc] text-[#9b712f]"}`}>{provider.status === "connected" ? "CONNECTED" : provider.status === "optional" ? "OPTIONAL" : "READY"}</span>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">{provider.capabilities.map((capability) => <span key={capability} className="inline-flex items-center gap-1 rounded-full border border-[#e1e8e1] bg-white px-2.5 py-1 text-[10px] font-semibold text-[#607476]">{capabilityIcon(capability)} {capabilityLabel[capability]}</span>)}</div>
                <div className="mt-4 flex items-end justify-between gap-3 border-t border-[#ebeeea] pt-3"><p className="line-clamp-2 text-xs leading-5 text-[#6d7c7f]">{checks[provider.id]?.status === "degraded" ? "Temporarily unavailable — Bookx will ask before using a compatible fallback." : provider.models.slice(0, 2).map((model) => model.label).join(" · ") || "No compatible models discovered yet."}</p>{provider.configured && <button onClick={() => onValidate(provider.id)} className={`shrink-0 text-[10px] font-bold ${checks[provider.id]?.status === "degraded" ? "text-[#a76749] hover:text-[#824c33]" : "text-[#37766e] hover:text-[#204f51]"}`}>{checks[provider.id]?.status === "connected" ? "Checked" : checks[provider.id]?.status === "degraded" ? "Try again" : "Check"}</button>}</div>
              </article>
            ))}
          </div>
        </section>

        <aside className="space-y-5">
          <div className="rounded-[24px] bg-[#244f50] p-6 text-white shadow-[0_18px_45px_rgba(31,78,78,.20)]">
            <Cloud className="text-[#efc976]" size={22} />
            <p className="mono mt-5 text-[10px] tracking-[.15em] text-[#b8d8d3]">CLOUDFLARE WORKERS AI</p>
            <h3 className="serif mt-2 text-3xl leading-tight">Your live model catalog.</h3>
            <p className="mt-4 text-sm leading-6 text-[#d2e2de]">Bookx reads the models available in your connected Cloudflare account, then only shows compatible options for voice, transcription, and language work.</p>
            <div className="mt-5 rounded-2xl bg-white/10 p-4"><span className="block text-xs font-bold">{cloudflare?.models.filter((model) => model.capabilities.includes("language-model")).length || 0} language models · {cloudflare?.models.filter((model) => model.capabilities.includes("text-to-speech")).length || 0} voice models</span><span className="mt-1 block text-[11px] text-[#bad8d4]">Save the connection below, then refresh a project setup screen to pull the latest model choices.</span></div>
          </div>
          <div className="rounded-[22px] border border-[#cfe0db] bg-[#fffefa] p-5">
            <span className="mono text-[10px] tracking-[.14em] text-[#547d77]">CLOUDFLARE CONNECTION</span>
            <h3 className="mt-2 font-bold text-[#3a5052]">Add the URL, key, and models.</h3>
            <p className="mt-2 text-xs leading-5 text-[#748285]">Paste a Cloudflare account URL (<strong>…/accounts/&lt;id&gt;/ai</strong>) or any OpenAI-compatible endpoint (AI Gateway <strong>/compat</strong>, self-hosted proxy) plus its API key. Bookx detects the mode and routes voice, transcription, and language requests there.</p>
            <label className="mt-4 block"><span className="mb-1.5 block text-[11px] font-bold text-[#526267]">Endpoint URL</span><input className="input text-xs" value={cloudflareConnection.apiBaseUrl} onChange={(event) => setCloudflareConnection((current) => ({ ...current, apiBaseUrl: event.target.value }))} placeholder="https://api.cloudflare.com/client/v4/accounts/<account>/ai" aria-label="Cloudflare endpoint URL" /></label>
            <label className="mt-3 block"><span className="mb-1.5 block text-[11px] font-bold text-[#526267]">API key</span><input type="password" autoComplete="off" className="input text-xs" value={cloudflareConnection.apiKey} onChange={(event) => setCloudflareConnection((current) => ({ ...current, apiKey: event.target.value }))} placeholder={cloudflareSaved?.apiKeyConfigured ? "Saved — leave blank to keep the current key" : "Cloudflare API token"} aria-label="Cloudflare API key" /></label>
            <div className="mt-3 grid gap-2">
              <label className="block"><span className="mb-1.5 block text-[11px] font-bold text-[#526267]">Voice (TTS) model</span><input className="input text-xs" value={cloudflareConnection.ttsModel} onChange={(event) => setCloudflareConnection((current) => ({ ...current, ttsModel: event.target.value }))} placeholder="@cf/deepgram/aura-2-en" aria-label="Cloudflare voice model" /></label>
              <label className="block"><span className="mb-1.5 block text-[11px] font-bold text-[#526267]">Transcription (STT) model</span><input className="input text-xs" value={cloudflareConnection.sttModel} onChange={(event) => setCloudflareConnection((current) => ({ ...current, sttModel: event.target.value }))} placeholder="@cf/openai/whisper" aria-label="Cloudflare transcription model" /></label>
              <label className="block"><span className="mb-1.5 block text-[11px] font-bold text-[#526267]">Language (LLM) model</span><input className="input text-xs" value={cloudflareConnection.llmModel} onChange={(event) => setCloudflareConnection((current) => ({ ...current, llmModel: event.target.value }))} placeholder="@cf/openai/gpt-oss-120b" aria-label="Cloudflare language model" /></label>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[#748285]">Leave a model blank to use the default. Custom names you type here appear in project setup.</p>
            {endpointMode && <p className="mt-2 rounded-lg bg-[#eef5f1] px-3 py-2 text-[11px] font-semibold text-[#3f776f]">{endpointMode}</p>}
            <div className="mt-4 flex gap-2">
              <button onClick={() => onSaveCloudflare(cloudflareConnection)} className="btn-primary btn-lg flex-1"><RefreshCw size={15} /> Save connection</button>
              <button onClick={() => onValidate("Cloudflare")} className="btn-soft btn-lg">Test</button>
            </div>
          </div>
          <div className="rounded-[22px] border border-[#dfe5de] bg-[#fffefa] p-5"><span className="mono text-[10px] tracking-[.14em] text-[#658d87]">DEFAULT BEHAVIOUR</span><h3 className="mt-2 font-bold text-[#3a5052]">Keep choices intentional.</h3><p className="mt-2 text-xs leading-5 text-[#748285]">Bookx will ask before changing providers when a model becomes unavailable. Your cast, manuscript, and timeline never move without context.</p><button onClick={() => onSave(customEndpoint.trim() || undefined)} className="btn-primary btn-lg mt-5 w-full">{saved ? <><Check size={15} /> Defaults saved</> : <><RefreshCw size={15} /> Save routing defaults</>}</button></div>
          <div className="rounded-[22px] border border-[#cfe0db] bg-[#f5fbf8] p-5"><span className="mono text-[10px] tracking-[.14em] text-[#547d77]">CUSTOM LLM ROUTE</span><h3 className="mt-2 font-bold text-[#3a5052]">OpenAI-compatible endpoint</h3><p className="mt-2 text-xs leading-5 text-[#748285]">Optionally enter the base URL ending in <strong>/v1</strong>. Bookx stores this routing metadata with your OpenAI preference; the matching credential remains in managed secrets.</p><input className="input mt-4 text-xs" value={customEndpoint} onChange={(event) => setCustomEndpoint(event.target.value)} placeholder="https://llm.example.com/v1" aria-label="Custom OpenAI-compatible base URL" /><p className="mt-2 text-[11px] leading-5 text-[#748285]">For a new or rotated key, use Management UI → <strong>Settings → Secrets</strong> and update <strong>OPENAI_API_KEY</strong>. Do not paste keys here.</p></div>
          <div className="rounded-[22px] border border-[#eddabf] bg-[#fff9ee] p-4 text-xs leading-5 text-[#8d6b35]"><CircleAlert className="mr-1 inline" size={14} /> Cloudflare credentials saved here stay server-side and are never returned to your browser. To connect or rotate ElevenLabs, Deepgram, or OpenAI keys, use the project Management UI: <strong>Settings → Secrets</strong>.</div>
        </aside>
      </div>
    </div>
  );
}
