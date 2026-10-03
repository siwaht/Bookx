import { useEffect, useMemo, useState } from "react";
import { Cpu, LoaderCircle, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { DEFAULT_VOICE_SETTINGS, DIRECTION_LIMITS, VOICE_SETTING_RANGES, ttsTraits, type VoiceSettings } from "@shared/direction";
import { isBuiltInProvider, type ProviderId } from "@shared/providers";
import { formatBalance } from "@shared/usage";
import { Badge, RangeField, ui } from "./studioUi";

const SETTING_LABEL = { stability: "Stability", similarity: "Similarity", style: "Style", speed: "Speed" } as const;
const SETTING_HINT = {
  stability: "Lower is more expressive and varied; higher is steadier.",
  similarity: "How closely the voice follows the original.",
  style: "Exaggerates the voice's style. Slower to render.",
  speed: "1.0 is the voice's natural pace.",
} as const;

/**
 * The narration model and its settings, with only the controls the model
 * understands: Eleven v4 shows Stability and Similarity, v2 adds Style, Speed
 * and Speaker boost, GPT-4o mini TTS takes standing instructions.
 */
export function NarrationVoicePanel({ projectId, disabled }: { projectId: string; disabled?: boolean }) {
  const utils = trpc.useUtils();
  const workspace = trpc.bookx.getWorkspace.useQuery({ projectId });
  const catalog = trpc.providers.catalog.useQuery();
  const project = workspace.data?.project;
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [filter, setFilter] = useState("");
  const [settings, setSettings] = useState<VoiceSettings>({});

  useEffect(() => {
    if (!project) return;
    setProvider(project.voiceProvider);
    setModel(project.voiceModel);
    setSettings(project.voiceSettings ?? {});
  }, [project?.voiceProvider, project?.voiceModel, project?.voiceSettings]);

  const balances = trpc.providers.balances.useQuery(
    provider && isBuiltInProvider(provider) ? { provider } : undefined,
    { enabled: Boolean(provider && isBuiltInProvider(provider)) },
  );
  const balance = balances.data?.find(entry => entry.provider === provider);

  const ttsProviders = (catalog.data ?? []).filter(item => item.capabilities.includes("text-to-speech"));
  const current = ttsProviders.find(item => item.id === provider);
  const models = useMemo(() => {
    const all = (current?.models ?? []).filter(item => item.capabilities.includes("text-to-speech"));
    const needle = filter.trim().toLowerCase();
    return needle ? all.filter(item => `${item.id} ${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle)) : all;
  }, [current?.models, filter]);

  const traits = ttsTraits(provider, model);
  const modelChanged = Boolean(project) && (provider !== project!.voiceProvider || model !== project!.voiceModel);
  const settingsChanged = Boolean(project) && JSON.stringify(settings) !== JSON.stringify(project!.voiceSettings ?? {});

  const invalidate = () => {
    void utils.bookx.getWorkspace.invalidate({ projectId });
    void utils.bookx.narrationStatus.invalidate({ projectId });
    void utils.bookx.auditNarration.invalidate({ projectId });
    void utils.studio.invalidate();
    void utils.providers.inUse.invalidate();
  };
  const saveModel = trpc.studio.setNarrationModel.useMutation({
    onSuccess: result => { toast.success(`Narration now uses ${result.provider} · ${result.traits.label}. Existing audio keeps its model until you regenerate it.`); invalidate(); },
    onError: error => toast.error(error.message || "Prosecast could not change the model."),
  });
  const saveSettings = trpc.studio.setVoiceSettings.useMutation({
    onSuccess: () => { toast.success("Voice settings saved. They apply to the next lines rendered."); invalidate(); },
    onError: error => toast.error(error.message || "Prosecast could not save the voice settings."),
  });
  const refresh = trpc.providers.refreshModels.useMutation({
    onSuccess: result => {
      void utils.providers.catalog.invalidate();
      toast(result.live ? `${result.models} models listed by ${result.provider}.` : `Showing Prosecast's list for ${result.provider}${result.error ? `: ${result.error}` : ""}.`);
    },
    onError: error => toast.error(error.message || "Prosecast could not refresh the models."),
  });

  const value = (key: keyof typeof SETTING_LABEL) => settings[key] ?? DEFAULT_VOICE_SETTINGS[key];

  return (
    <div className={`${ui.card} min-w-0`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className={`flex items-center gap-2 ${ui.title}`}><Cpu aria-hidden="true" size={15} className="text-brand-600" /> Narration model</h3>
        {provider && isBuiltInProvider(provider) && current?.liveCatalog && (
          <button type="button" className={ui.linkButton} onClick={() => refresh.mutate({ provider })} disabled={refresh.isPending} title="Ask the provider for its current models (free)">
            {refresh.isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" size={11} /> : <RefreshCw aria-hidden="true" size={11} />}<span className={ui.linkText}>Refresh models</span>
          </button>
        )}
      </div>
      <p className={`mt-1 text-xs ${ui.muted}`}>
        {project ? <>In use: <strong className={ui.strong}>{project.voiceProvider} · {ttsTraits(project.voiceProvider, project.voiceModel).label}</strong> <span className="mono text-3xs">({project.voiceModel})</span></> : "Loading…"}
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 text-sm">
        <label className="block">
          <span className={ui.label}>Provider</span>
          <select className="input select py-2 text-sm" value={provider} disabled={disabled} onChange={event => { setProvider(event.target.value); setModel(ttsProviders.find(item => item.id === event.target.value)?.models.find(item => item.capabilities.includes("text-to-speech"))?.id ?? ""); setFilter(""); }}>
            {ttsProviders.map(item => <option key={item.id} value={item.id}>{item.label}{item.configured ? "" : " (not connected)"}</option>)}
            {provider && !ttsProviders.some(item => item.id === provider) && <option value={provider}>{provider}</option>}
          </select>
        </label>
        {(current?.models.length ?? 0) > 10 && (
          <input className="input py-2 text-xs" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter models" aria-label="Filter models" />
        )}
        <label className="block">
          <span className={ui.label}>Model</span>
          <select className="input select py-2 text-sm" value={model} disabled={disabled} onChange={event => setModel(event.target.value)}>
            {models.map(item => <option key={item.id} value={item.id}>{item.label}{item.recommended ? " · recommended" : ""}{item.direction === "audio-tags" ? " · audio tags" : item.direction === "instructions" ? " · instructions" : ""}</option>)}
            {model && !models.some(item => item.id === model) && <option value={model}>{model}</option>}
          </select>
        </label>
        <div className="flex flex-wrap gap-1.5 text-3xs">
          {current?.modelsLive ? <Badge tone="good">Live list from {current.label}</Badge> : current?.configured ? <Badge>Prosecast's list</Badge> : null}
          {traits.audioTags && <Badge tone="info">Audio tags</Badge>}
          {traits.instructions && <Badge tone="info">Instructions</Badge>}
          {traits.ipaInText && <Badge>IPA pronunciation</Badge>}
          <Badge>{traits.maxChars.toLocaleString()} chars per request</Badge>
        </div>
        {current?.discoveryError && <p className="text-2xs text-gold-700 [overflow-wrap:anywhere]">Live list unavailable: {current.discoveryError.slice(0, 140)}</p>}
        <ul className={`space-y-1 text-2xs leading-5 ${ui.muted}`}>
          {traits.notes.map(note => <li key={note}>· {note}</li>)}
        </ul>
        {modelChanged && (
          <button type="button" className="btn-primary" disabled={disabled || saveModel.isPending || !model} onClick={() => saveModel.mutate({ projectId, provider: provider as ProviderId, model })}>
            {saveModel.isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" size={14} /> : <Save aria-hidden="true" size={14} />} Use {traits.label}
          </button>
        )}
      </div>

      {(traits.settings.length > 0 || traits.instructions) && (
        <div className={`mt-4 space-y-3 pt-4 ${ui.divider}`}>
          <span className={ui.eyebrow}>Voice settings · {traits.label}</span>
          {(["stability", "similarity", "style", "speed"] as const).filter(key => traits.settings.includes(key)).map(key => (
            <RangeField
              key={key}
              id={`voice-${key}`}
              label={SETTING_LABEL[key]}
              value={key === "stability" && traits.stabilitySteps ? traits.stabilitySteps.reduce((best, step) => (Math.abs(step - value(key)) < Math.abs(best - value(key)) ? step : best), traits.stabilitySteps[0]!) : value(key)}
              min={VOICE_SETTING_RANGES[key].min}
              max={VOICE_SETTING_RANGES[key].max}
              step={key === "stability" && traits.stabilitySteps ? 0.5 : VOICE_SETTING_RANGES[key].step}
              format={number => key === "stability" && traits.stabilitySteps ? ({ 0: "Creative", 0.5: "Natural", 1: "Robust" } as Record<number, string>)[number] ?? number.toFixed(2) : number.toFixed(2)}
              hint={SETTING_HINT[key]}
              disabled={disabled}
              onChange={number => setSettings(currentSettings => ({ ...currentSettings, [key]: number }))}
            />
          ))}
          {traits.settings.includes("speakerBoost") && (
            <label className="flex items-center justify-between gap-3 text-2xs font-semibold text-ink-600">
              Speaker boost
              <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={settings.speakerBoost ?? DEFAULT_VOICE_SETTINGS.speakerBoost} disabled={disabled} onChange={event => setSettings(currentSettings => ({ ...currentSettings, speakerBoost: event.target.checked }))} />
            </label>
          )}
          {traits.instructions && (
            <label className="block">
              <span className={ui.label}>Standing instructions</span>
              <textarea className="input min-h-20 text-xs" maxLength={DIRECTION_LIMITS.instructions} value={settings.instructions ?? ""} disabled={disabled} onChange={event => setSettings(currentSettings => ({ ...currentSettings, instructions: event.target.value }))} placeholder="A warm, unhurried storyteller with a low voice." />
            </label>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-soft flex-1" disabled={disabled || !settingsChanged || saveSettings.isPending} onClick={() => saveSettings.mutate({ projectId, settings: { ...settings, instructions: settings.instructions?.trim() || undefined } })}>
              {saveSettings.isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" size={13} /> : <Save aria-hidden="true" size={13} />} Save settings
            </button>
            <button type="button" className="btn-soft" disabled={disabled || !project?.voiceSettings || saveSettings.isPending} onClick={() => saveSettings.mutate({ projectId, settings: null })}>Defaults</button>
          </div>
        </div>
      )}

      {balance && balance.status !== "not-connected" && (
        <div className={`mt-4 pt-4 text-2xs leading-5 ${ui.divider} ${ui.muted}`}>
          <span className={ui.eyebrow}>Account</span>
          {balance.status === "ok" ? (
            <p className="mt-1">
              <strong className={`${ui.strong} ${ui.numbers}`}>{formatBalance(balance.remaining, balance.unit)}</strong> left
              {balance.limit !== undefined && <span className={ui.numbers}> of {formatBalance(balance.limit, balance.unit)}</span>}
              {balance.resetsAt && <> · resets {new Date(balance.resetsAt).toLocaleDateString()}</>}
              {balance.plan && <> · {balance.plan}</>}
            </p>
          ) : <p className="mt-1">{balance.detail}</p>}
        </div>
      )}
    </div>
  );
}
