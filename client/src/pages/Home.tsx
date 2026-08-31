import { createElement, useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Headphones,
  Languages,
  LoaderCircle,
  Mic2,
  MoreHorizontal,
  Music2,
  Play,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Split,
  Trash2,
  Upload,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { EnhancedProduction } from "@/components/EnhancedProduction";
import { CastingReview, type CastingCharacter } from "@/components/CastingReview";
import { PodcastImportDialog, type PodcastImport } from "@/components/PodcastImportDialog";
import { PodcastScriptEditor } from "@/components/PodcastScriptEditor";
import { ProviderSettings, type CloudflareConnectionDraft } from "@/components/ProviderSettings";
import { projectReadiness, projectSetupSchema, type ProjectSetup } from "@shared/bookx";

type Screen = "dashboard" | "workspace";
type WorkspaceTab = "manuscript" | "cast" | "pronunciation" | "generation" | "studio" | "review" | "export" | "settings";
type Project = ProjectSetup & { id: string; progress: number; updated: string; chapters: number; duration: string; cover: string; localCastOverrides?: Record<string, { voice: string; voiceId: string }> };
type Character = CastingCharacter;
type Rule = { word: string; alias: string; phoneme: string };
type ProviderCapability = "text-to-speech" | "speech-to-text" | "language-model";
type ProviderCatalog = { id: string; label: string; configured: boolean; status: "connected" | "available" | "optional"; capabilities: ProviderCapability[]; models: { id: string; label: string; capabilities: ProviderCapability[]; detail?: string }[] };
type VoiceChoice = { id: string; name: string; detail: string; color: string };

const initialProjects: Project[] = [
  { id: "quiet-current", title: "A Quiet Current", author: "Mira Ellis", kind: "audiobook", narrationStyle: "cast", voiceProvider: "ElevenLabs", voiceModel: "eleven_v3", languageModelProvider: "Cloudflare", languageModel: "@cf/openai/gpt-oss-120b", language: "English", manuscriptName: "quiet-current.epub", progress: 72, updated: "Edited today", chapters: 18, duration: "06h 42m", cover: "linear-gradient(145deg,#112a33,#49737b 55%,#c9d4bd)" },
  { id: "field-notes", title: "Field Notes from Elsewhere", author: "Nadia Chen", kind: "podcast", narrationStyle: "single", voiceProvider: "Deepgram", voiceModel: "aura-2-thalia-en", languageModelProvider: "Cloudflare", languageModel: "@cf/openai/gpt-oss-120b", language: "English", progress: 38, updated: "Edited yesterday", chapters: 4, duration: "42m", cover: "linear-gradient(145deg,#492f4c,#9c6f68 55%,#e9cfa9)" },
  { id: "daylight", title: "Daylight at the Edge", author: "Jonas Hale", kind: "audiobook", narrationStyle: "narrator-cast", voiceProvider: "ElevenLabs", voiceModel: "eleven_multilingual_v2", languageModelProvider: "Cloudflare", languageModel: "@cf/openai/gpt-oss-120b", language: "English", progress: 94, updated: "Edited 3 days ago", chapters: 31, duration: "11h 08m", cover: "linear-gradient(145deg,#25362c,#77905c 55%,#e6d583)" },
];

const demoProjectIds = new Set(initialProjects.map((project) => project.id));

const defaultCharacters: Character[] = [
  { name: "Mara Vale", role: "Narrator", voice: "Iris", voiceId: "iris-narrative", accent: "Warm · Neutral", color: "#d8a665", confidence: 92, rationale: "Steady and intimate for close third-person narration.", sampleLine: "The house was still awake when Mara returned." },
  { name: "Elias", role: "Lead character", voice: "Theo", voiceId: "theo-dramatic", accent: "Measured · British", color: "#89b5c2", confidence: 88, rationale: "Reserved, reflective delivery differentiates Elias from the narrator.", sampleLine: "You promised you would not come back here." },
  { name: "June", role: "Supporting character", voice: "Sage", voiceId: "sage-conversational", accent: "Bright · American", color: "#b7a0c8", confidence: 84, rationale: "Clear, energetic cadence adds contrast in dialogue scenes.", sampleLine: "Then we stop waiting and make the call ourselves." },
];

const chapterRows = [
  ["Opening: The Still House", "6 / 6", "Ready"],
  ["Chapter 02: Undertow", "8 / 8", "Ready"],
  ["Chapter 03: The Missing Light", "7 / 8", "Needs 1"],
  ["Chapter 04: What Remains", "0 / 9", "Draft"],
];

const voiceLibrary: VoiceChoice[] = [
  { id: "iris-narrative", name: "Iris", detail: "Narrative · Warm · intimate", color: "#d8a665" },
  { id: "theo-dramatic", name: "Theo", detail: "Dramatic · British · measured", color: "#89b5c2" },
  { id: "sage-conversational", name: "Sage", detail: "Conversational · American · bright", color: "#b7a0c8" },
  { id: "noor-global", name: "Noor", detail: "Velvet · Global · reflective", color: "#8cab91" },
  { id: "rowan-deep", name: "Rowan", detail: "Measured · Deep · grounded", color: "#d48a7e" },
];

const previewProviders: ProviderCatalog[] = [
  { id: "ElevenLabs", label: "ElevenLabs", configured: true, status: "connected", capabilities: ["text-to-speech", "speech-to-text"], models: [{ id: "eleven_multilingual_v2", label: "Multilingual v2", capabilities: ["text-to-speech"], detail: "Long-form narration" }, { id: "eleven_v3", label: "Eleven v3", capabilities: ["text-to-speech"], detail: "Expressive dialogue" }, { id: "scribe_v2", label: "Scribe v2", capabilities: ["speech-to-text"], detail: "Timed transcripts" }] },
  { id: "Deepgram", label: "Deepgram", configured: true, status: "connected", capabilities: ["text-to-speech", "speech-to-text"], models: [{ id: "aura-2-thalia-en", label: "Aura-2 Thalia", capabilities: ["text-to-speech"], detail: "Natural voice" }, { id: "nova-3", label: "Nova-3", capabilities: ["speech-to-text"], detail: "Podcast transcription" }] },
  { id: "Cloudflare", label: "Cloudflare Workers AI", configured: true, status: "connected", capabilities: ["text-to-speech", "speech-to-text", "language-model"], models: [{ id: "@cf/deepgram/aura-2-en", label: "Aura-2", capabilities: ["text-to-speech"], detail: "Cloudflare-hosted voice" }, { id: "@cf/openai/gpt-oss-120b", label: "GPT OSS 120B", capabilities: ["language-model"], detail: "Story organisation" }, { id: "@cf/openai/whisper", label: "Whisper", capabilities: ["speech-to-text"], detail: "Audio transcription" }] },
  { id: "OpenAI", label: "OpenAI", configured: true, status: "connected", capabilities: ["text-to-speech", "speech-to-text", "language-model"], models: [{ id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS", capabilities: ["text-to-speech"], detail: "Narration" }, { id: "gpt-5", label: "GPT-5", capabilities: ["language-model"], detail: "Editorial planning" }] },
  { id: "Fish Audio", label: "Fish Audio", configured: false, status: "optional", capabilities: ["text-to-speech", "speech-to-text"], models: [{ id: "s2.1-pro", label: "S2.1 Pro", capabilities: ["text-to-speech"], detail: "Connect when ready" }] },
];

const nav: Array<{ id: WorkspaceTab; label: string; icon: typeof FileText; group: string }> = [
  { id: "manuscript", label: "Write", icon: FileText, group: "CREATE" },
  { id: "cast", label: "Cast voices", icon: Users, group: "CREATE" },
  { id: "pronunciation", label: "Pronunciation", icon: Languages, group: "CREATE" },
  { id: "generation", label: "Generate", icon: Sparkles, group: "PRODUCE" },
  { id: "studio", label: "Audio studio", icon: Music2, group: "PRODUCE" },
  { id: "review", label: "Review", icon: CheckCircle2, group: "FINISH" },
  { id: "export", label: "Publish & export", icon: Download, group: "FINISH" },
  { id: "settings", label: "Settings", icon: Settings2, group: "SYSTEM" },
];

const initialDraft: ProjectSetup = { title: "", author: "", kind: "audiobook", narrationStyle: "single", voiceProvider: "ElevenLabs", voiceModel: "eleven_multilingual_v2", languageModelProvider: "Cloudflare", languageModel: "@cf/openai/gpt-oss-120b", language: "Auto-detect", manuscriptName: "" };

function IconButton({ children, label, onClick }: { children: React.ReactNode; label: string; onClick?: () => void }) {
  const enabled = Boolean(onClick);
  return <button type="button" onClick={onClick} disabled={!enabled} aria-label={label} title={enabled ? label : `${label} is unavailable`} className="grid h-9 w-9 place-items-center rounded-xl border border-[#dce1d9] bg-white text-[#526065] transition enabled:hover:border-[#a9c9c4] enabled:hover:text-[#1d6a69] enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-45">{children}</button>;
}

function StatusDot({ tone = "sage" }: { tone?: "sage" | "gold" | "slate" | "rose" }) {
  const color = { sage: "bg-[#75a997]", gold: "bg-[#d7a648]", slate: "bg-[#94a3a6]", rose: "bg-[#d78475]" }[tone];
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

export default function Home() {
  const { isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const persistedProjects = trpc.bookx.listProjects.useQuery(undefined, { enabled: isAuthenticated });
  const providerCatalogQuery = trpc.providers.catalog.useQuery(undefined, { enabled: isAuthenticated });
  const providerPreferencesQuery = trpc.providers.listPreferences.useQuery(undefined, { enabled: isAuthenticated });
  const providers: ProviderCatalog[] = providerCatalogQuery.data?.length ? providerCatalogQuery.data : previewProviders;
  const savedCloudflare = providerPreferencesQuery.data?.find((preference) => preference.provider === "Cloudflare") || null;
  const saveProviderPreference = trpc.providers.savePreference.useMutation();
  const validateProvider = trpc.providers.validate.useMutation();
  const recommendCast = trpc.providers.recommendCast.useMutation();
  const replaceCharacters = trpc.bookx.replaceCharacters.useMutation();
  const updateCharacter = trpc.bookx.updateCharacter.useMutation();
  const updateCharacterByName = trpc.bookx.updateCharacterByName.useMutation();
  const previewCharacterVoice = trpc.bookx.previewCharacterVoice.useMutation();
  const previewVoice = trpc.bookx.previewVoice.useMutation();
  const createPersistedProject = trpc.bookx.createProject.useMutation();
  const createChapter = trpc.bookx.createChapter.useMutation();
  const importPodcastSource = trpc.bookx.importPodcastSource.useMutation();
  const transcribeAudio = trpc.bookx.transcribeAudioClip.useMutation();
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [projects, setProjects] = useState<Project[]>(() => {
    if (typeof window === "undefined") return initialProjects;
    try {
      const stored = window.localStorage.getItem("bookx-projects");
      const parsed = stored ? JSON.parse(stored) as Project[] : initialProjects;
      return parsed.filter((project) => project.title.trim().toLowerCase() !== "test");
    } catch {
      return initialProjects;
    }
  });
  const [activeProject, setActiveProject] = useState<Project>(initialProjects[0]);
  const [tab, setTab] = useState<WorkspaceTab>("manuscript");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [draft, setDraft] = useState<ProjectSetup>(initialDraft);
  const [characters, setCharacters] = useState<Character[]>(defaultCharacters);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [libraryPreviewUrls, setLibraryPreviewUrls] = useState<Record<string, string>>({});
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voicePrompt, setVoicePrompt] = useState("");
  const [manuscriptText, setManuscriptText] = useState("The house was still awake when Mara returned.\n\nNot alive in any way that could be explained, but listening. The old windows held the rain in their frames, and the corridor hummed with a current that seemed to know her name.\n\nShe set the key on the hall table. It rolled once, then stopped.");
  const [pendingPodcastImport, setPendingPodcastImport] = useState<PodcastImport | null>(null);
  const [rules, setRules] = useState<Rule[]>([{ word: "Aurelia", alias: "aw-REE-lee-ah", phoneme: "ɔːˈriːliə" }, { word: "Kestrel", alias: "KES-truhl", phoneme: "ˈkɛstrəl" }]);
  const [ruleDraft, setRuleDraft] = useState<Rule>({ word: "", alias: "", phoneme: "" });
  const [selectedChapters, setSelectedChapters] = useState(new Set(["Opening: The Still House", "Chapter 01: Undertow"]));
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(72);
  const [toolOpen, setToolOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [exported, setExported] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [providerChecks, setProviderChecks] = useState<Record<string, { status: string; detail?: string }>>({});
  const [isCasting, setIsCasting] = useState(false);
  const discoveredVoiceQuery = trpc.providers.voiceCatalog.useQuery({ provider: "ElevenLabs", query: voiceSearch }, { enabled: isAuthenticated });
  const activeProjectIsSaved = Boolean(isAuthenticated && persistedProjects.data?.some((project) => project.id === activeProject.id));
  const activeProjectCanPersist = Boolean(isAuthenticated && activeProject.id && !activeProject.id.startsWith("project-"));
  const workspaceQuery = trpc.bookx.getWorkspace.useQuery({ projectId: activeProject.id }, { enabled: activeProjectIsSaved });

  const discoveredVoices: VoiceChoice[] = discoveredVoiceQuery.data?.length
    ? discoveredVoiceQuery.data.map((voice, index) => ({ id: voice.id, name: voice.label, detail: voice.description, color: ["#d8a665", "#89b5c2", "#b7a0c8", "#8cab91", "#d48a7e"][index % 5]! }))
    : voiceLibrary;
  const filteredVoices = useMemo(() => {
    const terms = voiceSearch.toLowerCase().match(/[a-z0-9]+/g) || [];
    if (!terms.length || isAuthenticated) return discoveredVoices;
    return discoveredVoices
      .map((voice) => {
        const haystack = `${voice.id} ${voice.name} ${voice.detail}`.toLowerCase();
        return { voice, score: terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0) };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.voice.name.localeCompare(right.voice.name))
      .map(({ voice }) => voice);
  }, [discoveredVoices, isAuthenticated, voiceSearch]);
  const readiness = projectReadiness({ chapterCount: 4, generatedChapters: progress >= 94 ? 4 : 3, hasCast: characters.length >= 3, hasTimeline: true });

  useEffect(() => {
    window.localStorage.setItem("bookx-projects", JSON.stringify(projects));
  }, [projects]);

  useEffect(() => {
    if (!persistedProjects.data?.length) return;
    const remoteProjects: Project[] = persistedProjects.data.map((project) => ({
      id: project.id,
      title: project.title,
      author: project.author || "Independent creator",
      kind: project.kind,
      narrationStyle: project.narrationStyle,
      voiceProvider: project.voiceProvider,
      voiceModel: project.voiceModel,
      languageModelProvider: project.languageModelProvider,
      languageModel: project.languageModel,
      language: project.language,
      manuscriptName: project.manuscriptName || "",
      progress: project.status === "published" ? 100 : project.status === "review" ? 88 : project.status === "producing" ? 56 : 8,
      updated: "Synced just now",
      chapters: 0,
      duration: "—",
      cover: project.kind === "podcast" ? "linear-gradient(145deg,#412f49,#966b91 58%,#e6b47b)" : "linear-gradient(145deg,#183d43,#5e9a96 56%,#d8c886)",
    }));
    setProjects((current) => {
      const localOnly = current.filter((project) => !remoteProjects.some((remote) => remote.id === project.id) && !project.id.startsWith("project-"));
      return [...remoteProjects, ...localOnly];
    });
  }, [persistedProjects.data]);

  useEffect(() => {
    const savedCharacters = workspaceQuery.data?.characters;
    if (!activeProjectIsSaved || !savedCharacters?.length) return;
    let localOverrides: Record<string, { voice: string; voiceId: string }> = activeProject.localCastOverrides || {};
    try {
      localOverrides = Object.keys(localOverrides).length ? localOverrides : JSON.parse(
        window.localStorage.getItem(`bookx-cast-overrides:${activeProject.id}`)
        || window.localStorage.getItem(`bookx-cast-overrides-title:${activeProject.title}`)
        || "{}",
      ) as Record<string, { voice: string; voiceId: string }>;
    } catch {
      localOverrides = {};
    }
    setCharacters(savedCharacters.map((character, index) => {
      const localOverride = localOverrides[character.name];
      return {
        name: character.name,
        role: character.role,
        voice: localOverride?.voice || character.voiceName || character.voiceId || "Iris",
        voiceId: localOverride?.voiceId || character.voiceId || undefined,
        accent: character.accent || "Neutral",
        rationale: localOverride ? "Manually selected by the creator." : character.voiceRationale || undefined,
        sampleLine: character.sampleLine || undefined,
        confidence: localOverride ? undefined : character.assignmentConfidence ?? undefined,
        color: ["#d8a665", "#89b5c2", "#b7a0c8", "#8cab91", "#d48a7e"][index % 5]!,
      };
    }));
    setPreviewUrls(Object.fromEntries(savedCharacters
      .filter((character) => Boolean(character.previewUrl))
      .map((character) => [character.name, character.previewUrl!])),
    );
  }, [activeProjectIsSaved, workspaceQuery.data?.characters]);

  useEffect(() => {
    if (activeProjectIsSaved) return;
    try {
      const stored = window.localStorage.getItem(`bookx-cast-overrides:${activeProject.id}`)
        || window.localStorage.getItem(`bookx-cast-overrides-title:${activeProject.title}`);
      const overrides = activeProject.localCastOverrides || (stored ? JSON.parse(stored) as Record<string, { voice: string; voiceId: string }> : {});
      if (!Object.keys(overrides).length) return;
      setCharacters((previous) => previous.map((character) => {
        const override = overrides[character.name];
        return override ? { ...character, ...override, confidence: undefined, rationale: "Manually selected by the creator." } : character;
      }));
    } catch {
      // A malformed local preference should never block the audio workspace.
    }
  }, [activeProject.id, activeProject.title, activeProjectIsSaved]);

  const updateDraft = <K extends keyof ProjectSetup>(key: K, value: ProjectSetup[K]) => setDraft((previous) => ({ ...previous, [key]: value }));
  const handleManuscript = (event: ChangeEvent<HTMLInputElement>) => updateDraft("manuscriptName", event.target.files?.[0]?.name || "");
  const persistProviderDefaults = (customEndpoint?: string) => {
    providers.filter((provider) => provider.configured).forEach((provider) => {
      const voice = provider.models.find((model) => model.capabilities.includes("text-to-speech"))?.id;
      const stt = provider.models.find((model) => model.capabilities.includes("speech-to-text"))?.id;
      const llm = provider.models.find((model) => model.capabilities.includes("language-model"))?.id;
      saveProviderPreference.mutate({ provider: provider.id as "ElevenLabs" | "Deepgram" | "Cloudflare" | "OpenAI" | "Fish Audio", defaultTtsModel: voice, defaultSttModel: stt, defaultLlmModel: llm, fallbackProvider: provider.id === "Cloudflare" ? "OpenAI" : "Cloudflare", fallbackEnabled: true, apiBaseUrl: provider.id === "OpenAI" ? customEndpoint : undefined });
    });
    setSettingsSaved(true); window.setTimeout(() => setSettingsSaved(false), 1800);
    toast.success("Routing defaults saved for new projects.");
  };
  const checkProvider = (provider: string) => validateProvider.mutate({ provider: provider as "ElevenLabs" | "Deepgram" | "Cloudflare" | "OpenAI" | "Fish Audio" }, { onSuccess: (result) => setProviderChecks((current) => ({ ...current, [provider]: { status: result.status, detail: "detail" in result ? result.detail : undefined } })) });
  const persistCloudflareConnection = (connection: CloudflareConnectionDraft) => {
    if (!isAuthenticated) { notify("Sign in to save your Cloudflare connection."); return; }
    saveProviderPreference.mutate({
      provider: "Cloudflare",
      apiBaseUrl: connection.apiBaseUrl.trim() || undefined,
      apiKey: connection.apiKey.trim() || undefined,
      defaultTtsModel: connection.ttsModel.trim() || undefined,
      defaultSttModel: connection.sttModel.trim() || undefined,
      defaultLlmModel: connection.llmModel.trim() || undefined,
      fallbackProvider: "OpenAI",
      fallbackEnabled: true,
    }, {
      onSuccess: () => {
        utils.providers.catalog.invalidate();
        utils.providers.listPreferences.invalidate();
        toast.success("Cloudflare connection saved.");
      },
      onError: (error) => toast.error(error.message || "Bookx could not save the Cloudflare connection."),
    });
  };

  const resetWizard = () => {
    setWizardOpen(false);
    setWizardStep(1);
    setDraft(initialDraft);
  };
  const createProject = async () => {
    const parsed = projectSetupSchema.safeParse(draft);
    if (!parsed.success) return;
    let project: Project = { ...parsed.data, id: `project-${Date.now()}`, progress: 0, updated: "Just now", chapters: 0, duration: "—", cover: parsed.data.kind === "podcast" ? "linear-gradient(145deg,#412f49,#966b91 58%,#e6b47b)" : "linear-gradient(145deg,#183d43,#5e9a96 56%,#d8c886)" };
    if (isAuthenticated) {
      try {
        const saved = await createPersistedProject.mutateAsync(parsed.data);
        project = { ...project, id: saved.id };
        if (parsed.data.kind === "podcast" && pendingPodcastImport) {
          if (pendingPodcastImport.text.trim()) {
            await createChapter.mutateAsync({ projectId: saved.id, title: "Episode script", body: pendingPodcastImport.text.trim(), orderIndex: 0 });
          }
          if (pendingPodcastImport.file) {
            await importPodcastSource.mutateAsync({ projectId: saved.id, filename: pendingPodcastImport.file.name, mimeType: pendingPodcastImport.file.mimeType, base64: pendingPodcastImport.file.base64 });
          }
        }
        await utils.bookx.listProjects.invalidate();
      } catch (error) {
        notify(error instanceof Error ? error.message : "Bookx could not save this project yet. You can keep working in the local preview.");
      }
    }
    setProjects((previous) => [project, ...previous]);
    setActiveProject(project);
    resetWizard();
    setScreen("workspace");
    setTab("manuscript");
    setPendingPodcastImport(null);
  };

  const readLocalCastOverrides = (project: Project) => {
    if (project.localCastOverrides) return project.localCastOverrides;
    try {
      return JSON.parse(
        window.localStorage.getItem(`bookx-cast-overrides:${project.id}`)
        || window.localStorage.getItem(`bookx-cast-overrides-title:${project.title}`)
        || "{}",
      ) as Record<string, { voice: string; voiceId: string }>;
    } catch {
      return {} as Record<string, { voice: string; voiceId: string }>;
    }
  };
  const openProject = (project: Project) => {
    const overrides = readLocalCastOverrides(project);
    if (Object.keys(overrides).length) setCharacters((previous) => previous.map((character) => {
      const override = overrides[character.name];
      return override ? { ...character, ...override, confidence: undefined, rationale: "Manually selected by the creator." } : character;
    }));
    setActiveProject(project);
    setScreen("workspace");
    setTab("manuscript");
  };
  const sampleCastText = "Mara Vale returned to the still house after midnight. Elias warned her not to open the red door. June refused to leave either of them behind.";
  const autoCast = () => {
    const applyFallback = (message: string) => {
      setCharacters((previous) => previous.map((character, index) => {
        const voice = voiceLibrary[index] || voiceLibrary[3]!;
        return { ...character, voice: voice.name, voiceId: voice.id, confidence: 72, rationale: "A distinct fallback assignment was created from the current cast order." };
      }));
      notify(message);
    };
    if (!isAuthenticated) { applyFallback("Preview casting assigned distinct voices. Sign in to analyze your manuscript with the selected language model."); return; }
    const manuscript = workspaceQuery.data?.chapters.map((chapter) => chapter.body || "").filter(Boolean).join("\n\n") || sampleCastText;
    setIsCasting(true);
    recommendCast.mutate({ provider: activeProject.languageModelProvider === "OpenAI" ? "OpenAI" : "Cloudflare", model: activeProject.languageModel || "@cf/openai/gpt-oss-120b", text: manuscript.slice(0, 16_000), voices: voiceLibrary.map((voice) => ({ id: voice.id, label: voice.name, description: voice.detail })) }, {
      onSuccess: (result) => {
        const next: Character[] = result.characters.map((character, index) => ({ name: character.name, role: character.role, voice: character.voiceName, voiceId: character.voiceId, accent: character.accent, rationale: character.rationale, sampleLine: character.sampleLine, confidence: character.confidence, color: ["#d8a665", "#89b5c2", "#b7a0c8", "#8cab91", "#d48a7e"][index % 5]! }));
        setCharacters(next);
        if (activeProjectIsSaved) replaceCharacters.mutate({ projectId: activeProject.id, characters: result.characters.map((character) => ({ name: character.name, role: character.role, voiceId: character.voiceId, voiceName: character.voiceName, accent: character.accent, voiceRationale: character.rationale, sampleLine: character.sampleLine, assignmentConfidence: Math.round(character.confidence), assignmentSource: "llm" })) }, {
          onSuccess: () => utils.bookx.getWorkspace.invalidate({ projectId: activeProject.id }),
          onError: () => notify("Voice recommendations are ready, but Bookx could not save them yet."),
        });
        toast.success(`${next.length} characters analyzed with ${result.model}.`, { description: "Review or override any voice before generation." });
      },
      onError: () => applyFallback("The language model was unavailable, so Bookx created a distinct fallback cast. You can still adjust every voice."),
      onSettled: () => setIsCasting(false),
    });
  };
  const generate = () => { setGenerating(true); window.setTimeout(() => { setProgress(94); setGenerating(false); }, 850); };
  const addRule = () => { if (!ruleDraft.word.trim()) return; setRules((previous) => [...previous, ruleDraft]); setRuleDraft({ word: "", alias: "", phoneme: "" }); };
  const notify = (message: string) => toast(message);
  const addCharacter = () => setCharacters((previous) => [...previous, { name: `Character ${previous.length + 1}`, role: "Supporting character", voice: "Noor", voiceId: "noor-global", accent: "Velvet · Global", color: "#8cab91" }]);
  const deleteRule = (word: string) => setRules((previous) => previous.filter((rule) => rule.word !== word));
  const storeLocalCastOverride = (name: string, voice: VoiceChoice) => {
    try {
      const key = `bookx-cast-overrides:${activeProject.id}`;
      const current = JSON.parse(window.localStorage.getItem(key) || "{}") as Record<string, { voice: string; voiceId: string }>;
      const next = JSON.stringify({ ...current, [name]: { voice: voice.name, voiceId: voice.id } });
      window.localStorage.setItem(key, next);
      window.localStorage.setItem(`bookx-cast-overrides-title:${activeProject.title}`, next);
      const localCastOverrides = { ...(activeProject.localCastOverrides || {}), [name]: { voice: voice.name, voiceId: voice.id } };
      setProjects((previous) => {
        const nextProjects = previous.map((project) => project.id === activeProject.id ? { ...project, localCastOverrides } : project);
        window.localStorage.setItem("bookx-projects", JSON.stringify(nextProjects));
        return nextProjects;
      });
      setActiveProject((previous) => previous.id === activeProject.id ? { ...previous, localCastOverrides } : previous);
      return true;
    } catch {
      return false;
    }
  };
  const changeCharacterVoice = (name: string, voice: VoiceChoice) => {
    const storedLocally = storeLocalCastOverride(name, voice);
    setCharacters((previous) => previous.map((character) => character.name === name ? { ...character, voice: voice.name, voiceId: voice.id, confidence: undefined, rationale: "Manually selected by the creator." } : character));
    const persisted = workspaceQuery.data?.characters.find((character) => character.name === name);
    if (activeProjectCanPersist && persisted) updateCharacter.mutate({ projectId: activeProject.id, characterId: persisted.id, voiceId: voice.id, voiceName: voice.name, assignmentSource: "manual" }, {
      onSuccess: () => utils.bookx.getWorkspace.invalidate({ projectId: activeProject.id }),
      onError: () => { storeLocalCastOverride(name, voice); notify("Your voice change is saved in this browser until the project can sync."); },
    });
    else if (activeProjectCanPersist) updateCharacterByName.mutate({ projectId: activeProject.id, name, voiceId: voice.id, voiceName: voice.name, assignmentSource: "manual" }, {
      onSuccess: () => utils.bookx.getWorkspace.invalidate({ projectId: activeProject.id }),
      onError: () => { storeLocalCastOverride(name, voice); notify("Your voice change is saved in this browser until the project can sync."); },
    });
    else if (!storedLocally) notify("Your voice change is active for this session.");
  };
  const previewCharacter = (character: Character) => {
    const persisted = workspaceQuery.data?.characters.find((value) => value.name === character.name);
    const provider = activeProject.voiceProvider === "Fish Audio" ? undefined : activeProject.voiceProvider;
    if (!activeProjectIsSaved || !persisted || !provider) { playBrowserSample(character.voice); notify(`${character.name} browser preview is playing.`); return; }
    previewCharacterVoice.mutate({ projectId: activeProject.id, characterId: persisted.id, provider: provider as "ElevenLabs" | "OpenAI" | "Deepgram" | "Cloudflare", voiceId: character.voiceId, model: activeProject.voiceModel }, {
      onSuccess: (result) => { setPreviewUrls((current) => ({ ...current, [character.name]: result.audioUrl })); toast.success(`${character.name} preview is ready.`); },
      onError: () => toast.error("Bookx could not generate that preview.", { description: "You can choose another voice or provider." }),
    });
  };
  const playBrowserSample = (voiceName: string) => {
    if (!("speechSynthesis" in window)) { notify("This browser does not support local speech samples. Sign in to generate a provider voice preview."); return; }
    window.speechSynthesis.cancel();
    const sample = new SpeechSynthesisUtterance(`This is a Bookx sample for ${voiceName}. A clear voice helps listeners follow every moment.`);
    sample.rate = 0.96;
    window.speechSynthesis.speak(sample);
    notify(`Playing a browser sample for ${voiceName}. Sign in to render the selected provider voice.`);
  };
  const previewLibraryVoice = (voice: VoiceChoice) => {
    const provider = activeProject.voiceProvider === "Fish Audio" ? undefined : activeProject.voiceProvider;
    if (!activeProjectIsSaved || !provider) { playBrowserSample(voice.name); notify(`${voice.name} browser preview is playing.`); return; }
    previewVoice.mutate({ projectId: activeProject.id, provider: provider as "ElevenLabs" | "OpenAI" | "Deepgram" | "Cloudflare", voiceId: voice.id, model: activeProject.voiceModel, text: `This is a Bookx sample for ${voice.name}. A clear voice helps listeners follow every moment.` }, {
      onSuccess: (result) => { setLibraryPreviewUrls((current) => ({ ...current, [voice.id]: result.audioUrl })); toast.success(`${voice.name} provider preview is ready.`); },
      onError: () => toast.error("Bookx could not generate that provider preview.", { description: "Try another voice or provider." }),
    });
  };
  const findSimilarVoices = () => {
    const request = voicePrompt.trim();
    if (!request) return;
    setVoiceSearch(request);
    notify(isAuthenticated ? "Searching the connected voice catalog for that description." : "Showing starter voices that best match that description. Sign in to search the connected catalog.");
  };
  const beginPodcastSetup = (podcastImport: PodcastImport) => {
    const filename = podcastImport.file?.name || (podcastImport.text.trim() ? "Pasted episode script" : "");
    const script = podcastImport.text.trim() || (podcastImport.file ? `Audio source attached: ${podcastImport.file.name}. Add or paste an episode transcript here to edit it, assign voices, and generate previews.` : manuscriptText);
    setManuscriptText(script);
    setPendingPodcastImport(podcastImport);
    setImportOpen(false);
    setDraft({ ...initialDraft, kind: "podcast", narrationStyle: "cast", manuscriptName: filename });
    setWizardOpen(true);
    setWizardStep(1);
  };

  return (
    <main className="min-h-screen bg-[#f7f5ef] text-[#203038] noise-bg">
      {screen === "dashboard" ? (
        <Dashboard projects={isAuthenticated ? projects.filter((project) => !demoProjectIds.has(project.id)) : projects} loading={isAuthenticated && persistedProjects.isLoading} isAuthenticated={isAuthenticated} onNew={() => { setDraft(initialDraft); setWizardOpen(true); setWizardStep(1); }} onImport={() => setImportOpen(true)} onOpen={openProject} />
      ) : (
        <Workspace project={activeProject} tab={tab} setTab={setTab} onBack={() => setScreen("dashboard")} onShare={() => notify("Preview link prepared for sharing.")} onSettings={() => setTab("settings")}>
          {tab === "manuscript" && (activeProject.kind === "podcast" ? <PodcastScriptEditor text={manuscriptText} setText={setManuscriptText} onNext={() => setTab("cast")} /> : <Manuscript toolOpen={toolOpen} setToolOpen={setToolOpen} onNext={() => setTab("cast")} onFeedback={notify} />)}
          {tab === "cast" && <CastingReview characters={characters.map((character) => ({ ...character, previewUrl: previewUrls[character.name] }))} voices={filteredVoices} voicesLoading={isAuthenticated && discoveredVoiceQuery.isLoading} query={voiceSearch} setQuery={setVoiceSearch} prompt={voicePrompt} setPrompt={setVoicePrompt} onFindSimilar={findSimilarVoices} onAutoCast={autoCast} onAddCharacter={addCharacter} isCasting={isCasting} modelLabel={`${activeProject.languageModelProvider || "Cloudflare"} · ${activeProject.languageModel || "@cf/openai/gpt-oss-120b"}`} onPreview={previewCharacter} onPreviewVoice={previewLibraryVoice} onVoiceChange={changeCharacterVoice} libraryPreviewUrls={libraryPreviewUrls} />}
          {tab === "pronunciation" && <Pronunciation rules={rules} draft={ruleDraft} setDraft={setRuleDraft} onAdd={addRule} onDelete={deleteRule} />}
          {tab === "generation" && <Generation chapters={selectedChapters} setChapters={setSelectedChapters} generating={generating} progress={progress} onGenerate={generate} />}
          {tab === "studio" && <EnhancedProduction kind={activeProject.kind} playing={playing} setPlaying={setPlaying} />}
          {tab === "review" && <Review readiness={readiness} onOpenGeneration={() => setTab("generation")} />}
          {tab === "export" && <Export readiness={readiness} exported={exported} onExport={() => setExported(true)} />}
          {tab === "settings" && <ProviderSettings providers={providers} saved={settingsSaved} checks={providerChecks} onSave={persistProviderDefaults} onValidate={checkProvider} cloudflareSaved={savedCloudflare} onSaveCloudflare={persistCloudflareConnection} />}
        </Workspace>
      )}

      {wizardOpen && <ProjectWizard step={wizardStep} setStep={setWizardStep} draft={draft} updateDraft={updateDraft} providers={providers} onClose={resetWizard} onCreate={createProject} onFile={handleManuscript} />}
      {importOpen && <PodcastImportDialog onClose={() => setImportOpen(false)} onFinish={beginPodcastSetup} />}
    </main>
  );
}

function Dashboard({ projects, loading, isAuthenticated, onNew, onImport, onOpen }: { projects: Project[]; loading: boolean; isAuthenticated: boolean; onNew: () => void; onImport: () => void; onOpen: (project: Project) => void }) {
  return <div className="mx-auto min-h-screen max-w-[1440px] px-5 pb-12 pt-5 md:px-10">
    <header className="flex items-center justify-between border-b border-[#e2e4dd] pb-5">
      <button className="flex items-center gap-3 text-left" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><span className="grid h-10 w-10 place-items-center rounded-[14px] bg-[#245f63] text-white shadow-[0_8px_20px_rgba(36,95,99,.22)]"><Headphones size={19} /></span><span><span className="block text-[17px] font-bold tracking-[-.04em]">Bookx</span><span className="block text-[10px] tracking-[.14em] text-[#718084]">AUDIO WORKSPACE</span></span></button>
      <nav aria-label="Workspace context" className="hidden items-center gap-2 md:flex"><button onClick={() => document.getElementById("recent-work")?.scrollIntoView({ behavior: "smooth" })} className="rounded-full bg-[#e3f0ed] px-4 py-2 text-sm font-semibold text-[#256d69]">Projects</button><span className="rounded-full px-4 py-2 text-sm text-[#6f7d80]">Library</span><span className="rounded-full px-4 py-2 text-sm text-[#6f7d80]">Series</span></nav>
      <div className="flex items-center gap-2"><IconButton label="Search"><Search size={16} /></IconButton>{isAuthenticated ? <div className="flex items-center gap-2" title="Signed in"><span className="rounded-full bg-[#edf4ef] px-2.5 py-1.5 text-[11px] font-bold text-[#3d716a]">Signed in</span><div className="grid h-9 w-9 place-items-center rounded-full bg-[#d9b66b] text-xs font-bold text-[#2a3537]">ME</div></div> : <button onClick={() => startLogin()} className="btn-primary">Sign in</button>}</div>
    </header>

    <section className="brand-wave fade-up grid gap-8 py-12 lg:grid-cols-[1.25fr_.75fr] lg:items-end">
      <div><div className="mb-5 flex items-center gap-2 text-[11px] font-bold tracking-[.18em] text-[#49827d]"><span className="h-2 w-2 rounded-full bg-[#72aa95]" /> YOUR STUDIO</div><h1 className="serif max-w-3xl text-5xl leading-[.98] tracking-[-.055em] text-[#203438] md:text-7xl">Make something<br />people can hear.</h1><p className="mt-6 max-w-xl text-base leading-7 text-[#647276]">A considered workspace for turning manuscripts, ideas, and performances into finished audiobooks and podcasts.</p></div>
      <div className="panel-shadow rounded-[26px] border border-[#dfe5dd] bg-[#fbfaf6] p-5"><div className="mb-5 flex items-center justify-between"><span className="mono text-[10px] tracking-[.12em] text-[#7c8988]">THE BOOKX METHOD</span><Sparkles size={17} className="text-[#ba8c43]" /></div><div className="grid grid-cols-3 gap-2">{[["01", "Shape"], ["02", "Voice"], ["03", "Publish"]].map(([number, label]) => <div key={label} className="rounded-2xl bg-[#f0f3ed] p-3"><span className="mono block text-[10px] text-[#7b8a88]">{number}</span><strong className="mt-5 block text-sm">{label}</strong></div>)}</div></div>
    </section>

    <section className="mb-10 grid gap-3 md:grid-cols-2"><button onClick={onNew} className="lift group flex min-h-30 items-center justify-between rounded-[24px] bg-[#225d60] p-6 text-left text-white"><span><span className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-white/12"><Plus size={19} /></span><strong className="block text-lg">New project</strong><span className="mt-1 block text-sm text-[#d5e8e5]">Start with a manuscript or fresh idea</span></span><ArrowRight className="transition group-hover:translate-x-1" /></button><button onClick={onImport} className="lift group flex min-h-30 items-center justify-between rounded-[24px] border border-[#d9dfd7] bg-[#fffefa] p-6 text-left"><span><span className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-[#e9f0ea] text-[#40766f]"><Upload size={18} /></span><strong className="block text-lg">Import audio</strong><span className="mt-1 block text-sm text-[#718083]">Bring in an existing mix or recording</span></span><ArrowRight className="text-[#65817e] transition group-hover:translate-x-1" /></button></section>

    <section id="recent-work"><div className="mb-5 flex items-end justify-between"><div><p className="mono text-[10px] tracking-[.14em] text-[#7a8889]">YOUR SHELF</p><h2 className="serif mt-2 text-3xl tracking-[-.04em]">Recent work</h2></div><button onClick={() => document.getElementById("recent-work")?.scrollIntoView({ behavior: "smooth" })} className="text-sm font-semibold text-[#2d7470]">View all projects <ChevronRight className="inline" size={15} /></button></div><div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{loading ? [0, 1, 2].map((index) => <ProjectCardSkeleton key={index} />) : projects.length === 0 ? <EmptyShelf onNew={onNew} onImport={onImport} /> : projects.map((project) => <ProjectCard key={project.id} project={project} onOpen={() => onOpen(project)} />)}</div></section>
  </div>;
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) { return <button onClick={onOpen} className="lift group overflow-hidden rounded-[25px] border border-[#dfe4dd] bg-[#fffefa] text-left"><div className="cover-wave relative h-48 p-5 text-white" style={{ background: project.cover }}><div className="flex items-start justify-between"><span className="rounded-full bg-black/15 px-3 py-1 text-[10px] font-bold tracking-[.12em] backdrop-blur-sm">{project.kind === "audiobook" ? "AUDIOBOOK" : "PODCAST"}</span><MoreHorizontal size={18} /></div><div className="absolute bottom-5"><span className="mono text-[10px] tracking-[.12em] text-white/70">{project.chapters} {project.kind === "audiobook" ? "CHAPTERS" : "EPISODES"} · {project.duration}</span><h3 className="serif mt-1 text-2xl leading-none tracking-[-.04em]">{project.title}</h3></div></div><div className="p-5"><div className="flex justify-between text-xs text-[#748084]"><span>{project.author || "Independent creator"}</span><span>{project.updated}</span></div><div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#ebeeea]"><div className="h-full rounded-full bg-[#4e9287] transition-[width] duration-700 ease-out" style={{ width: `${project.progress}%` }} /></div><div className="mt-2 flex justify-between text-xs"><span className="font-medium text-[#426c69]">{project.progress}% complete</span><span className="text-[#7b8789]">Open project <ArrowRight className="inline" size={13} /></span></div></div></button>; }

function ProjectCardSkeleton() {
  return <div aria-hidden="true" className="overflow-hidden rounded-[25px] border border-[#e4e7e0] bg-[#fffefa]"><div className="skeleton h-48" /><div className="space-y-3 p-5"><div className="skeleton h-3 w-2/3" /><div className="skeleton h-3 w-1/3" /><div className="skeleton h-1.5" /></div></div>;
}

function EmptyShelf({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  return <div className="fade-up flex flex-col items-center justify-center rounded-[25px] border border-dashed border-[#b9cdc4] bg-[#fbfaf5] px-6 py-16 text-center md:col-span-2 xl:col-span-3"><span className="grid h-14 w-14 place-items-center rounded-2xl bg-[#e7f2ee] text-[#3d7f75]"><BookOpen size={24} /></span><h3 className="serif mt-5 text-2xl tracking-[-.03em] text-[#25393c]">Your shelf is waiting</h3><p className="mt-2 max-w-sm text-sm leading-6 text-[#718084]">Start a new project or import an existing recording — it only takes a moment.</p><div className="mt-6 flex flex-wrap items-center justify-center gap-3"><button onClick={onNew} className="btn-primary btn-lg">Create your first project</button><button onClick={onImport} className="btn-soft btn-lg">Import audio</button></div></div>;
}

function ProjectWizard({ step, setStep, draft, updateDraft, providers, onClose, onCreate, onFile }: { step: number; setStep: (next: number) => void; draft: ProjectSetup; updateDraft: <K extends keyof ProjectSetup>(key: K, value: ProjectSetup[K]) => void; providers: ProviderCatalog[]; onClose: () => void; onCreate: () => void; onFile: (event: ChangeEvent<HTMLInputElement>) => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const canContinue = step !== 1 || Boolean(draft.title.trim());
  const modelsFor = (capability: ProviderCapability, providerId: string) => providers.find((provider) => provider.id === providerId)?.models.filter((model) => model.capabilities.includes(capability)) || [];
  const voiceModels = modelsFor("text-to-speech", draft.voiceProvider);
  const languageModels = modelsFor("language-model", draft.languageModelProvider);
  const chooseProvider = (key: "voiceProvider" | "languageModelProvider", capability: ProviderCapability, providerId: string) => {
    updateDraft(key, providerId);
    const firstModel = modelsFor(capability, providerId)[0];
    if (firstModel) updateDraft(key === "voiceProvider" ? "voiceModel" : "languageModel", firstModel.id);
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#173034]/35 p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="soft-shadow flex h-[calc(100dvh-2rem)] max-h-[800px] w-full max-w-3xl flex-col overflow-hidden rounded-[30px] border border-white/70 bg-[#fffefa]"><div className="shrink-0 flex items-start justify-between px-7 pb-5 pt-7"><div><p className="mono text-[10px] tracking-[.16em] text-[#5d918b]">START A NEW PROJECT</p><h2 className="serif mt-2 text-3xl tracking-[-.045em]">{step === 1 ? "Begin with the story." : step === 2 ? "Set the vocal character." : "Review the intent."}</h2></div><IconButton label="Close" onClick={onClose}><X size={17} /></IconButton></div><div className="shrink-0 px-7"><div className="grid grid-cols-3 border-y border-[#e3e7df] py-3">{[[1, "Basics"], [2, "Narration"], [3, "Review"]].map(([number, label]) => <div key={number} className="flex items-center gap-2 text-sm"><span className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold ${step >= Number(number) ? "bg-[#286b69] text-white" : "bg-[#edf0eb] text-[#7a8787]"}`}>{step > Number(number) ? <Check size={13} /> : number}</span><span className={step >= Number(number) ? "font-semibold text-[#2b494b]" : "text-[#859093]"}>{label}</span></div>)}</div></div><div className="min-h-0 flex-1 overflow-y-auto px-7 py-7">
    {step === 1 && <div className="space-y-6"><div className="grid gap-3 sm:grid-cols-2">{[["audiobook", BookOpen, "Audiobook", "Long-form, chaptered narration"], ["podcast", Mic2, "Podcast", "Episodes, interviews, conversations"]].map(([kind, Icon, title, description]) => <button key={kind as string} onClick={() => updateDraft("kind", kind as "audiobook" | "podcast")} className={`rounded-2xl border p-4 text-left ${draft.kind === kind ? "border-[#7aa9a2] bg-[#edf7f4]" : "border-[#dfe5dc] bg-white"}`}>{createElement(Icon as typeof BookOpen, { size: 18, className: "mb-5 text-[#3c7d76]" })}<strong className="block">{title as string}</strong><span className="mt-1 block text-sm text-[#788588]">{description as string}</span></button>)}</div><div className="grid gap-4 sm:grid-cols-2"><Field label={draft.kind === "audiobook" ? "Book title" : "Episode / show title"}><input autoFocus value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder="e.g. The quiet morning" className="input" /></Field><Field label={draft.kind === "audiobook" ? "Author" : "Host"} optional><input value={draft.author || ""} onChange={(event) => updateDraft("author", event.target.value)} placeholder="Add a name" className="input" /></Field></div><Field label="Narration style"><div className="grid gap-2 sm:grid-cols-3">{[["single", "Single narrator"], ["cast", "Full cast"], ["narrator-cast", "Narrator + cast"]].map(([value, label]) => <button key={value} onClick={() => updateDraft("narrationStyle", value as ProjectSetup["narrationStyle"])} className={`rounded-xl border px-3 py-3 text-left text-sm ${draft.narrationStyle === value ? "border-[#7aa9a2] bg-[#eaf4f0] text-[#2d6e69]" : "border-[#e1e5de] bg-white text-[#667477]"}`}>{label}</button>)}</div></Field></div>}
    {step === 2 && <div className="space-y-6"><div className="rounded-[22px] border border-[#dbe6df] bg-[#f6faf7] p-4"><div className="mb-4 flex items-center justify-between"><div><p className="mono text-[10px] tracking-[.14em] text-[#5b8b84]">MODEL ROUTING</p><p className="mt-1 text-sm text-[#596a6d]">Choose models by task. Bookx keeps the creative workflow independent of any one vendor.</p></div><span className="rounded-full bg-white px-3 py-1 text-[10px] font-bold text-[#4b7d76]">MODEL-AGNOSTIC</span></div><div className="grid gap-4 sm:grid-cols-2"><Field label="Voice provider"><select value={draft.voiceProvider} onChange={(event) => chooseProvider("voiceProvider", "text-to-speech", event.target.value)} className="input select">{providers.filter((provider) => provider.capabilities.includes("text-to-speech")).map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{provider.configured ? " · Connected" : ""}</option>)}</select></Field><Field label="Voice model"><select value={draft.voiceModel} onChange={(event) => updateDraft("voiceModel", event.target.value)} className="input select">{voiceModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.detail ? ` · ${model.detail}` : ""}</option>)}</select></Field><Field label="Language-model provider"><select value={draft.languageModelProvider} onChange={(event) => chooseProvider("languageModelProvider", "language-model", event.target.value)} className="input select">{providers.filter((provider) => provider.capabilities.includes("language-model")).map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{provider.configured ? " · Connected" : ""}</option>)}</select></Field><Field label="Language model"><select value={draft.languageModel} onChange={(event) => updateDraft("languageModel", event.target.value)} className="input select">{languageModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.detail ? ` · ${model.detail}` : ""}</option>)}</select></Field><Field label="Language"><select value={draft.language} onChange={(event) => updateDraft("language", event.target.value)} className="input select"><option>Auto-detect</option><option>English</option><option>Spanish</option><option>French</option><option>German</option></select></Field></div></div><label className="group flex cursor-pointer flex-col items-center justify-center rounded-[22px] border border-dashed border-[#87ada6] bg-[#f1f8f6] px-6 py-8 text-center"><Upload size={22} className="mb-3 text-[#3b7b75]" /><strong>{draft.manuscriptName || "Upload your manuscript"}</strong><span className="mt-2 text-sm text-[#718083]">EPUB, DOCX, TXT, Markdown, or HTML</span><input type="file" accept=".epub,.docx,.txt,.md,.html,.htm" onChange={onFile} className="hidden" /></label><p className="rounded-xl bg-[#fbf4e5] px-4 py-3 text-sm leading-6 text-[#8a6b37]"><Sparkles className="mr-2 inline" size={15} />Bookx will prepare chapters and narration paragraphs for your review. You can also add a manuscript later.</p></div>}
    {step === 3 && <div className="overflow-hidden rounded-[22px] border border-[#e0e5de] bg-[#fcfcf8]">{[["Project", draft.title || "Untitled project"], ["Type", `${draft.kind === "audiobook" ? "Audiobook" : "Podcast"} · ${draft.narrationStyle.replace("-", " ")}`], ["Voice model", draft.voiceModel], ["Language", draft.language], ["Manuscript", draft.manuscriptName || "Add later from Write"]].map(([label, value]) => <div key={label} className="flex items-center justify-between border-b border-[#e6e9e3] px-5 py-4 text-sm last:border-0"><span className="text-[#798689]">{label}</span><strong className="max-w-[62%] text-right capitalize text-[#334649]">{value}</strong></div>)}</div>}
  </div><div className="flex items-center justify-between border-t border-[#e4e7e0] bg-[#fafaf5] px-7 py-5"><button onClick={() => step === 1 ? onClose() : setStep(step - 1)} className="inline-flex items-center gap-2 text-sm font-semibold text-[#667477] transition hover:text-[#3c5052]"><ArrowLeft size={15} /> {step === 1 ? "Cancel" : "Back"}</button><button disabled={!canContinue} onClick={() => step < 3 ? setStep(step + 1) : onCreate()} className="btn-primary btn-lg disabled:opacity-40">{step < 3 ? "Continue" : `Create ${draft.kind === "audiobook" ? "audiobook" : "podcast"}`} <ArrowRight size={16} /></button></div></div></div>;
}

function Field({ label, optional, children }: { label: string; optional?: boolean; children: React.ReactNode }) { return <label className="block"><span className="mb-2 block text-[12px] font-bold tracking-[.02em] text-[#526267]">{label} {optional && <em className="ml-1 font-normal not-italic text-[#97a0a1]">optional</em>}</span>{children}</label>; }

function Workspace({ project, tab, setTab, onBack, onShare, onSettings, children }: { project: Project; tab: WorkspaceTab; setTab: (tab: WorkspaceTab) => void; onBack: () => void; onShare: () => void; onSettings: () => void; children: React.ReactNode }) { return <div className="min-h-screen bg-[#f4f5ef]"><header className="flex h-[68px] items-center justify-between border-b border-[#dfe4dd] bg-[#fffefa] px-4 md:px-6"><div className="flex items-center gap-3"><button onClick={onBack} className="grid h-9 w-9 place-items-center rounded-xl border border-[#e0e4df] bg-white text-[#637477] transition hover:border-[#a9c9c4] hover:text-[#1d6a69]"><ArrowLeft size={16} /></button><div className="hidden h-7 w-px bg-[#e0e3dd] sm:block" /><div><p className="mono text-[9px] tracking-[.13em] text-[#7b8889]">{project.kind === "audiobook" ? "AUDIOBOOK" : "PODCAST"}</p><div className="flex items-center gap-2"><h1 className="text-sm font-bold tracking-[-.02em]">{project.title}</h1><ChevronDown size={13} className="text-[#7d898a]" /></div></div></div><div className="hidden items-center gap-5 lg:flex"><span className="text-xs text-[#7b898b]">{project.progress}% ready</span><div className="h-1.5 w-28 overflow-hidden rounded-full bg-[#e6ebe5]"><div className="h-full bg-[#67a194] transition-[width] duration-700 ease-out" style={{ width: `${project.progress}%` }} /></div><button onClick={onShare} className="btn-primary">Share preview</button></div><div className="flex items-center gap-2"><IconButton label="Project settings" onClick={onSettings}><Settings2 size={16} /></IconButton><div className="grid h-9 w-9 place-items-center rounded-full bg-[#d6b36b] text-[10px] font-bold">ME</div></div></header><div className="flex min-h-[calc(100vh-68px)]"><aside className="hidden w-[236px] shrink-0 border-r border-[#dfe4dd] bg-[#fbfbf7] p-4 md:block"><button onClick={onBack} className="mb-5 flex items-center gap-2 px-2 text-xs font-semibold text-[#5f7e7b]"><Headphones size={14} /> Bookx workspace</button>{["CREATE", "PRODUCE", "FINISH", "SYSTEM"].map((group) => <div key={group} className="mb-5"><p className="mono mb-2 px-2 text-[9px] tracking-[.14em] text-[#9aa3a2]">{group}</p>{nav.filter((item) => item.group === group).map((item) => { const Icon = item.icon; return <button key={item.id} onClick={() => setTab(item.id)} className={`mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] transition ${tab === item.id ? "bg-[#e8f2ee] font-bold text-[#276b67]" : "text-[#667477] hover:bg-[#f0f2ed]"}`}><Icon size={16} />{item.label}{item.id === "generation" && <span className="ml-auto rounded-full bg-[#dceae4] px-2 py-0.5 text-[9px]">1</span>}</button>})}</div>)}</aside><div className="flex min-w-0 flex-1 flex-col"><div aria-label="Workspace sections" className="flex overflow-x-auto border-b border-[#dfe4dd] bg-[#fbfbf8] px-3 py-2 md:hidden">{nav.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`shrink-0 rounded-lg px-3 py-2 text-xs ${tab === item.id ? "bg-[#e4f0ec] font-bold text-[#2b706c]" : "text-[#718083]"}`}>{item.label}</button>)}</div><div key={tab} className="fade-up flex min-h-0 flex-1 flex-col">{children}</div></div></div></div>; }

function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) { return <div className="flex flex-col gap-5 border-b border-[#e1e5de] bg-[#fffefa] px-6 py-6 md:flex-row md:items-end md:justify-between md:px-9"><div><p className="mono text-[10px] tracking-[.15em] text-[#5a918b]">{eyebrow}</p><h2 className="serif mt-2 text-3xl tracking-[-.04em] text-[#25393c]">{title}</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[#738084]">{description}</p></div>{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}</div>; }

function Manuscript({ toolOpen, setToolOpen, onNext, onFeedback }: { toolOpen: boolean; setToolOpen: (value: boolean) => void; onNext: () => void; onFeedback: (message: string) => void }) {
  const [selected, setSelected] = useState(1);
  const chapterContent = [
    { title: "Opening: The Still House", text: "The house had been waiting for its name to be spoken again. Rain collected along the ledge, and the porch light sighed in the dark.", words: "318 words · ~2 min read", segments: ["The house had been waiting for its name to be spoken again.", "Rain collected along the ledge.", "The porch light sighed in the dark."] },
    { title: "Undertow", text: "The house was still awake when Mara returned.\n\nNot alive in any way that could be explained, but listening. The old windows held the rain in their frames, and the corridor hummed with a current that seemed to know her name.\n\nShe set the key on the hall table. It rolled once, then stopped.", words: "487 words · ~3 min read", segments: ["The house was still awake when Mara returned.", "Not alive in any way that could be explained, but listening.", "She set the key on the hall table."] },
    { title: "The Missing Light", text: "Elias found the lantern in the empty kitchen. Its glass was cold, but a pale light moved beneath the wick like a small, patient tide.", words: "402 words · ~3 min read", segments: ["Elias found the lantern in the empty kitchen.", "Its glass was cold.", "A pale light moved beneath the wick like a patient tide."] },
    { title: "What Remains", text: "By morning, the hall was quiet. Mara kept the key in her palm and listened for the house to decide whether it would let her leave.", words: "276 words · ~2 min read", segments: ["By morning, the hall was quiet.", "Mara kept the key in her palm.", "The house decided whether it would let her leave."] },
  ];
  const activeChapter = chapterContent[selected] || chapterContent[0];
  return <div className="flex min-h-0 flex-1 flex-col"><PageHeader eyebrow="01 · WRITE" title="The manuscript" description="Shape the narrative, split it into narration paragraphs, and give every line a clear voice." actions={<><button onClick={() => setToolOpen(!toolOpen)} className="btn-soft"><SlidersHorizontal className="mr-1 inline" size={14} /> Tools</button><button onClick={onNext} className="btn-primary">Continue to cast <ArrowRight className="ml-1 inline" size={13} /></button></>} />{toolOpen && <div className="flex flex-wrap gap-2 border-b border-[#dde5dd] bg-[#edf6f2] px-6 py-3 md:px-9"><button className="rounded-lg bg-white px-3 py-1.5 text-xs text-[#51706e]">Mood: Calm narration</button><button className="rounded-lg bg-white px-3 py-1.5 text-xs text-[#51706e]">Pacing: Natural</button><button onClick={() => onFeedback("A delivery tag has been added to this local draft.")} className="rounded-lg bg-white px-3 py-1.5 text-xs text-[#51706e] transition hover:bg-[#eef4f0]">Add delivery tag</button><button onClick={() => onFeedback("Bookx added a suggested delivery direction.")} className="rounded-lg bg-white px-3 py-1.5 text-xs text-[#51706e] transition hover:bg-[#eef4f0]"><Wand2 className="mr-1 inline" size={12} /> Suggest direction</button></div>}<div className="grid min-h-0 flex-1 lg:grid-cols-[230px_minmax(0,1fr)_300px]"><aside className="border-b border-[#e1e5de] bg-[#fafbf7] p-4 lg:border-b-0 lg:border-r"><div className="mb-3 flex items-center justify-between"><span className="mono text-[10px] tracking-[.12em] text-[#899494]">CHAPTERS</span><button onClick={() => onFeedback("A new chapter is ready to configure in this local draft.")} aria-label="Add chapter" className="rounded-lg bg-[#e5f0ec] p-1.5 text-[#36746e] transition hover:bg-[#d9ebe4]"><Plus size={14} /></button></div>{chapterRows.map(([name, count, status], index) => <button key={name} onClick={() => setSelected(index)} className={`mb-1 w-full rounded-xl p-3 text-left ${selected === index ? "bg-[#e5f0ed]" : "hover:bg-[#f0f2ee]"}`}><span className="line-clamp-2 text-xs font-semibold text-[#3c5052]">{index + 1}. {name}</span><span className="mt-2 flex items-center justify-between text-[10px] text-[#7f8a8c]"><span>{count} segments</span><span className={status === "Ready" ? "text-[#4a8e7b]" : status === "Needs 1" ? "text-[#bd8432]" : "text-[#829092]"}>{status}</span></span></button>)}</aside><section className="min-w-0 border-b border-[#e1e5de] bg-[#fffefa] p-5 lg:border-b-0 lg:p-7"><div className="mb-5 flex items-center justify-between"><div><span className="mono text-[10px] tracking-[.12em] text-[#90a0a0]">CHAPTER {String(selected + 1).padStart(2, "0")}</span><h3 className="mt-1 text-base font-bold">{activeChapter.title}</h3></div><span className="rounded-full bg-[#eef2ed] px-3 py-1 text-[10px] text-[#6f7f7f]">Auto-saved</span></div><textarea value={activeChapter.text} readOnly className="h-[360px] w-full resize-none border-0 bg-transparent text-[16px] leading-8 text-[#35474a] outline-none" /><div className="mt-3 flex justify-between border-t border-[#edf0eb] pt-3 text-[11px] text-[#849092]"><span>{activeChapter.words}</span><span>English · Natural pacing</span></div></section><aside className="bg-[#fafbf7] p-4"><div className="mb-4 flex items-center justify-between"><span className="mono text-[10px] tracking-[.12em] text-[#899494]">NARRATION SEGMENTS</span><button className="rounded-lg bg-[#e5f0ec] p-1.5 text-[#36746e]"><Split size={14} /></button></div><button onClick={() => onFeedback("Narration paragraphs are ready for review.")} className="btn-primary mb-3 w-full"><Sparkles size={14} /> Split into paragraphs</button>{activeChapter.segments.map((text, index) => <div key={text} className="mb-2 rounded-xl border border-[#e1e5de] bg-white p-3"><div className="mb-2 flex items-center justify-between"><span className="mono text-[10px] text-[#899494]">{String(index + 1).padStart(2, "0")}</span><span className={`rounded-full px-2 py-0.5 text-[9px] ${index === 2 ? "bg-[#fbefd9] text-[#9e722c]" : "bg-[#e7f3ef] text-[#397b70]"}`}>{index === 2 ? "Needs voice" : "Iris"}</span></div><p className="text-xs leading-5 text-[#516064]">{text}</p><button onClick={() => onFeedback("Preview is ready in the current workspace.")} className="mt-3 flex items-center gap-1 text-[10px] font-bold text-[#457b77] transition hover:text-[#2d615c]"><Play size={11} /> Preview</button></div>)}</aside></div></div>; }

function Pronunciation({ rules, draft, setDraft, onAdd, onDelete }: { rules: Rule[]; draft: Rule; setDraft: (rule: Rule) => void; onAdd: () => void; onDelete: (word: string) => void }) { return <div className="flex min-h-0 flex-1 flex-col"><PageHeader eyebrow="02 · CAST" title="Pronounce every detail." description="Create word rules and phoneme overrides so names, places, and technical language sound exactly right." /><div className="grid flex-1 gap-6 p-6 md:grid-cols-[1fr_360px] md:p-9"><section><div className="rounded-[22px] border border-[#e0e5de] bg-[#fffefa] p-5"><div className="flex items-center justify-between"><div><h3 className="font-bold">Project dictionary</h3><p className="mt-1 text-sm text-[#788689]">Applied anywhere the term appears in this project.</p></div><span className="rounded-full bg-[#e8f3ef] px-3 py-1 text-xs font-bold text-[#3c776f]">{rules.length} rules</span></div><div className="mt-5 overflow-hidden rounded-xl border border-[#e4e8e2]"><div className="grid grid-cols-[1.2fr_1fr_1fr_36px] bg-[#f4f6f1] px-4 py-3 mono text-[9px] tracking-[.12em] text-[#899594]"><span>WORD</span><span>ALIAS</span><span>PHONEME</span><span /></div>{rules.map((rule) => <div key={rule.word} className="grid grid-cols-[1.2fr_1fr_1fr_36px] items-center border-t border-[#edf0ea] px-4 py-4 text-sm"><strong>{rule.word}</strong><span className="text-[#5f7274]">{rule.alias}</span><span className="mono text-[11px] text-[#6f7e81]">{rule.phoneme || "—"}</span><button onClick={() => onDelete(rule.word)} aria-label={`Delete ${rule.word}`} className="text-[#9aa2a3] hover:text-[#af5d5d]"><Trash2 size={14} /></button></div>)}</div></div></section><aside className="rounded-[22px] border border-[#dfe5de] bg-[#fbfbf7] p-5"><span className="mono text-[10px] tracking-[.13em] text-[#658c87]">ADD A RULE</span><h3 className="serif mt-2 text-2xl">Teach Bookx a name.</h3><div className="mt-5 space-y-4"><Field label="Word"><input value={draft.word} onChange={(event) => setDraft({ ...draft, word: event.target.value })} placeholder="e.g. Aurelia" className="input" /></Field><Field label="Say it as"><input value={draft.alias} onChange={(event) => setDraft({ ...draft, alias: event.target.value })} placeholder="e.g. aw-REE-lee-ah" className="input" /></Field><Field label="Phoneme override" optional><input value={draft.phoneme} onChange={(event) => setDraft({ ...draft, phoneme: event.target.value })} placeholder="e.g. ɔːˈriːliə" className="input mono" /></Field><button onClick={onAdd} className="btn-primary btn-lg w-full">Add pronunciation rule</button></div></aside></div></div>; }

function Generation({ chapters, setChapters, generating, progress, onGenerate }: { chapters: Set<string>; setChapters: (chapters: Set<string>) => void; generating: boolean; progress: number; onGenerate: () => void }) { const toggle = (name: string) => { const next = new Set(chapters); next.has(name) ? next.delete(name) : next.add(name); setChapters(next); }; return <div className="flex min-h-0 flex-1 flex-col"><PageHeader eyebrow="03 · PRODUCE" title="Generate narration." description="Choose the scope, create fresh audio, and keep a clear record of every generation pass." actions={<button disabled={generating} onClick={onGenerate} className="btn-primary">{generating ? <LoaderCircle className="mr-1 inline animate-spin" size={14} /> : <Sparkles className="mr-1 inline" size={14} />}{generating ? "Generating narration" : "Generate full audiobook"}</button>} /><div className="grid flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_330px] md:p-9"><section><div className="grid gap-3 sm:grid-cols-4">{[["34", "Paragraphs"], ["31", "Audio ready"], ["3", "Needs audio"], [`${progress}%`, "Project ready"]].map(([value, label]) => <div key={label} className="rounded-2xl border border-[#e0e5de] bg-[#fffefa] p-4"><span className="mono text-[10px] text-[#819092]">{label.toUpperCase()}</span><strong className="mt-3 block text-2xl tracking-[-.04em] text-[#304548]">{value}</strong></div>)}</div><div className="mt-6 rounded-[22px] border border-[#e0e5de] bg-[#fffefa] p-5"><div className="mb-4 flex items-center justify-between"><div><h3 className="font-bold">Chapter scope</h3><p className="mt-1 text-sm text-[#7b888a]">Select chapters, or generate the entire audiobook.</p></div><button onClick={() => setChapters(new Set(chapterRows.map(([name]) => name)))} className="text-xs font-bold text-[#34736d]">Select all</button></div>{chapterRows.map(([name, count, status]) => <label key={name} className="flex cursor-pointer items-center gap-3 border-t border-[#edf0eb] py-4"><input checked={chapters.has(name)} onChange={() => toggle(name)} type="checkbox" className="h-4 w-4 accent-[#3f827a]" /><div className="min-w-0 flex-1"><strong className="block text-sm">{name}</strong><span className="text-xs text-[#7e8b8d]">{count} narration segments</span></div><span className={`rounded-full px-2.5 py-1 text-[10px] ${status === "Ready" ? "bg-[#e7f2ec] text-[#428174]" : status === "Needs 1" ? "bg-[#fff1dc] text-[#a87528]" : "bg-[#eef0ed] text-[#819091]"}`}>{status}</span></label>)}</div></section><aside className="space-y-4"><div className="rounded-[22px] bg-[#225f61] p-5 text-white"><span className="mono text-[10px] tracking-[.13em] text-[#b7d9d2]">CURRENT PASS</span><h3 className="serif mt-3 text-2xl">Full audiobook<br />narration</h3><div className="mt-6 h-2 overflow-hidden rounded-full bg-white/15"><div className="h-full bg-[#d9c47a] transition-[width] duration-700 ease-out" style={{ width: `${progress}%` }} /></div><div className="mt-2 flex justify-between text-xs text-[#d4e7e1]"><span>{progress}% complete</span><span>31 of 34</span></div><button onClick={onGenerate} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-white/12 py-2.5 text-xs font-bold"><Play size={13} /> {generating ? "Working…" : "Run selected chapters"}</button></div><div className="rounded-[22px] border border-[#e0e5de] bg-[#fffefa] p-5"><div className="mb-4 flex items-center gap-2"><Clock3 size={15} className="text-[#5b8b86]" /><h3 className="font-bold">Generation history</h3></div>{[["Full audiobook", "31 / 34 complete", "Now"], ["Chapter 01", "8 / 8 complete", "Today"], ["Opening", "6 / 6 complete", "Yesterday"]].map(([name, detail, when]) => <div key={name} className="flex items-start gap-3 border-t border-[#edf0eb] py-3"><StatusDot tone={name === "Full audiobook" ? "gold" : "sage"} /><div className="flex-1"><strong className="block text-xs">{name}</strong><span className="block text-[11px] text-[#7e8a8c]">{detail}</span></div><span className="text-[10px] text-[#98a1a1]">{when}</span></div>)}</div></aside></div></div>; }

function Review({ readiness, onOpenGeneration }: { readiness: ReturnType<typeof projectReadiness>; onOpenGeneration: () => void }) { const checks = [["Manuscript structure", "4 chapters divided into narration paragraphs", true], ["Voice casting", "Narrator and 2 characters have assigned voices", true], ["Audio generation", "31 of 34 paragraphs are ready", false], ["Timeline arrangement", "Narration and ambience are aligned", true], ["Export readiness", "Resolve remaining narration before package creation", false]]; return <div className="flex min-h-0 flex-1 flex-col"><PageHeader eyebrow="05 · REVIEW" title="Give it a final listen." description="Bookx runs a calm, visible pre-flight before you deliver the finished work." /><div className="grid flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_330px] md:p-9"><section className="rounded-[24px] border border-[#dfe5de] bg-[#fffefa] p-5"><div className="mb-5 flex items-center justify-between"><div><h3 className="font-bold">Pre-flight validation</h3><p className="mt-1 text-sm text-[#7a8789]">Review every production stage before publishing.</p></div><span className="rounded-full bg-[#e8f3ef] px-3 py-1 text-xs font-bold text-[#3d796f]">{readiness.completed} of {readiness.total} complete</span></div>{checks.map(([name, detail, passed]) => <div key={name as string} className="flex items-start gap-4 border-t border-[#edf0eb] py-4"><span className={`mt-0.5 grid h-6 w-6 place-items-center rounded-full ${passed ? "bg-[#e3f1eb] text-[#3e826f]" : "bg-[#fff0dc] text-[#af7b2e]"}`}>{passed ? <Check size={14} /> : <AlertCircle size={14} />}</span><div className="flex-1"><strong className="block text-sm">{name}</strong><span className="mt-1 block text-xs leading-5 text-[#788689]">{detail}</span></div><ChevronRight size={16} className="text-[#99a3a3]" /></div>)}</section><aside className="rounded-[24px] bg-[#294f50] p-6 text-white"><span className="mono text-[10px] tracking-[.13em] text-[#c1d9d4]">REVIEW NOTE</span><h3 className="serif mt-3 text-3xl leading-tight">One final pass makes it yours.</h3><p className="mt-4 text-sm leading-6 text-[#d2e2df]">Listen in context. Resolve the remaining lines, then return here to prepare your package.</p><button onClick={onOpenGeneration} className="mt-6 rounded-xl bg-white/12 px-4 py-3 text-xs font-bold">Open unresolved narration</button></aside></div></div>; }

function Export({ readiness, exported, onExport }: { readiness: ReturnType<typeof projectReadiness>; exported: boolean; onExport: () => void }) { const [format, setFormat] = useState("ACX"); const packageLabel = format === "InAudio package" ? format : `${format} package`; return <div className="flex min-h-0 flex-1 flex-col"><PageHeader eyebrow="06 · PUBLISH" title="Publish & export." description="Package audio, metadata, and chapter structure for the way your audience listens." /><div className="grid flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_330px] md:p-9"><section><div className="grid gap-3 md:grid-cols-3">{[["ACX", "Audiobook delivery", BookOpen], ["Podcast", "Episode package", Mic2], ["InAudio package", "Chaptered distribution", Headphones]].map(([name, detail, Icon]) => <button key={name as string} onClick={() => setFormat(name as string)} className={`rounded-[20px] border p-5 text-left ${format === name ? "border-[#8eb8ae] bg-[#edf7f3]" : "border-[#dfe5de] bg-[#fffefa]"}`}>{createElement(Icon as typeof BookOpen, { size: 18, className: "mb-5 text-[#4d887f]" })}<strong className="block text-sm">{name as string}</strong><span className="mt-1 block text-xs text-[#788688]">{detail as string}</span></button>)}</div><div className="mt-5 rounded-[22px] border border-[#dfe5de] bg-[#fffefa] p-5"><span className="mono text-[10px] tracking-[.13em] text-[#7e8d8e]">{packageLabel.toUpperCase()}</span><h3 className="serif mt-2 text-2xl">Ready when the last line is.</h3><div className="mt-5 space-y-3 text-sm text-[#5d6f71]">{["Chapter audio in a consistent final mix", "Delivery-ready file naming and metadata", "Cover art and chapter sequence", "Validation report included with the package"].map((line) => <div key={line} className="flex items-center gap-3"><CheckCircle2 size={16} className="text-[#5c9688]" />{line}</div>)}</div></div></section><aside className="rounded-[24px] border border-[#dfe5de] bg-[#fbfbf7] p-6"><span className="mono text-[10px] tracking-[.13em] text-[#688f8a]">DELIVERY STATUS</span><div className="mt-4 flex items-center gap-3"><span className={`grid h-10 w-10 place-items-center rounded-full ${readiness.readyToExport ? "bg-[#e2f1eb] text-[#3d806f]" : "bg-[#fff0da] text-[#ae7b2d]"}`}>{readiness.readyToExport ? <Check size={19} /> : <AlertCircle size={19} />}</span><div><strong className="block text-sm">{readiness.readyToExport ? "Ready to package" : "One item remains"}</strong><span className="block text-xs text-[#7c898a]">{readiness.completed} of {readiness.total} pre-flight checks</span></div></div><button onClick={onExport} className="btn-primary btn-lg mt-6 w-full"><Download size={15} /> Create {packageLabel}</button>{exported && <div className="mt-4 rounded-xl bg-[#e7f4ef] p-3 text-xs font-semibold text-[#3f7e70]"><CheckCircle2 className="mr-1 inline" size={14} /> Package prepared. Download is ready in your library.</div>}<p className="mt-5 text-xs leading-5 text-[#7c898a]">The exact delivery label is preserved for every export: ACX, Podcast, and InAudio package.</p></aside></div></div>; }
