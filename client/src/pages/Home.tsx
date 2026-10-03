import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
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
  Sparkles,
  Trash2,
  Upload,
  Users,
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
import { ProviderSettings, type CloudflareConnectionDraft, type CustomProviderDraft, type ProviderCatalog } from "@/components/ProviderSettings";
import { NarrationRun } from "@/components/NarrationRun";
import { ExportPackage } from "@/components/ExportPackage";
import { SoundDesign } from "@/components/SoundDesign";
import { ManuscriptEditor } from "@/components/ManuscriptEditor";
import { MANUSCRIPT_ACCEPT, readManuscriptFile, type ManuscriptUpload } from "@/lib/files";
import { projectReadiness, projectSetupSchema, type ProjectSetup } from "@shared/bookx";
import { isBuiltInProvider, isCustomProviderId, isProviderId, parseVoiceList, type BuiltInProviderId, type ProviderId } from "@shared/providers";

type Screen = "dashboard" | "workspace";
type WorkspaceTab = "manuscript" | "cast" | "pronunciation" | "generation" | "studio" | "review" | "export" | "settings";
type CastOverrides = Record<string, { voice: string; voiceId: string }>;
type Project = ProjectSetup & { id: string; progress: number; updated: string; chapters: number; duration: string; cover: string; localCastOverrides?: CastOverrides };
type Character = CastingCharacter;
type Rule = { word: string; alias: string; phoneme: string };
type ProviderCapability = "text-to-speech" | "speech-to-text" | "language-model";
type VoiceChoice = { id: string; name: string; detail: string; color: string };

/**
 * `Project.voiceProvider` is free-form text (see `projectSetupSchema`), so narrow
 * it before using it as a provider id.
 */
function voiceCatalogProvider(voiceProvider: string): ProviderId {
  return isProviderId(voiceProvider) ? voiceProvider : "ElevenLabs";
}

/**
 * The project's provider when the server can narrate with it: every built-in
 * provider, and the user's own ones once they have a voice model and voices.
 */
function narrationProvider(voiceProvider: string, providers: ProviderCatalog[]): ProviderId | undefined {
  if (!isProviderId(voiceProvider)) return undefined;
  const entry = providers.find((provider) => provider.id === voiceProvider);
  if (!entry) return isBuiltInProvider(voiceProvider) ? voiceProvider : undefined;
  return entry.capabilities.includes("text-to-speech") ? voiceProvider : undefined;
}

const voicePalette = ["#d8a665", "#89b5c2", "#b7a0c8", "#8cab91", "#d48a7e"] as const;
const paletteColor = (index: number) => voicePalette[index % voicePalette.length]!;

/**
 * Browser-local voice overrides for a project. Tolerates a missing or malformed
 * entry: a bad local preference must never block the audio workspace.
 */
function readCastOverrides(project: { id: string; title: string; localCastOverrides?: CastOverrides }): CastOverrides {
  if (project.localCastOverrides && Object.keys(project.localCastOverrides).length) return project.localCastOverrides;
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(`bookx-cast-overrides:${project.id}`)
      || window.localStorage.getItem(`bookx-cast-overrides-title:${project.title}`);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CastOverrides) : {};
  } catch {
    return {};
  }
}

const applyCastOverrides = (characters: Character[], overrides: CastOverrides) =>
  characters.map((character) => {
    const override = overrides[character.name];
    return override
      ? { ...character, ...override, confidence: undefined, rationale: "Manually selected by the creator." }
      : character;
  });

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

const voiceLibrary: VoiceChoice[] = [
  { id: "iris-narrative", name: "Iris", detail: "Narrative · Warm · intimate", color: "#d8a665" },
  { id: "theo-dramatic", name: "Theo", detail: "Dramatic · British · measured", color: "#89b5c2" },
  { id: "sage-conversational", name: "Sage", detail: "Conversational · American · bright", color: "#b7a0c8" },
  { id: "noor-global", name: "Noor", detail: "Velvet · Global · reflective", color: "#8cab91" },
  { id: "rowan-deep", name: "Rowan", detail: "Measured · Deep · grounded", color: "#d48a7e" },
];

/**
 * Model options shown before sign-in, so the wizard is usable without a session.
 * Every entry is `configured: false` on purpose: nothing is actually connected
 * until the server says so, and claiming otherwise made the wizard read
 * "Connected" for providers that had no key at all.
 */
const previewProviders: ProviderCatalog[] = [
  { id: "ElevenLabs", label: "ElevenLabs", configured: false, status: "available", capabilities: ["text-to-speech", "speech-to-text"], models: [{ id: "eleven_multilingual_v2", label: "Multilingual v2", capabilities: ["text-to-speech"], detail: "Long-form narration" }, { id: "eleven_v3", label: "Eleven v3", capabilities: ["text-to-speech"], detail: "Expressive dialogue" }, { id: "scribe_v2", label: "Scribe v2", capabilities: ["speech-to-text"], detail: "Timed transcripts" }] },
  { id: "Deepgram", label: "Deepgram", configured: false, status: "available", capabilities: ["text-to-speech", "speech-to-text"], models: [{ id: "aura-2-thalia-en", label: "Aura-2 Thalia", capabilities: ["text-to-speech"], detail: "Natural voice" }, { id: "nova-3", label: "Nova-3", capabilities: ["speech-to-text"], detail: "Podcast transcription" }] },
  { id: "Cloudflare", label: "Cloudflare Workers AI", configured: false, status: "available", capabilities: ["text-to-speech", "speech-to-text", "language-model"], models: [{ id: "@cf/deepgram/aura-2-en", label: "Aura-2", capabilities: ["text-to-speech"], detail: "Cloudflare-hosted voice" }, { id: "@cf/zai-org/glm-5.3-flash", label: "GLM-5.3 Flash", capabilities: ["language-model"], detail: "Story organisation" }, { id: "@cf/deepgram/nova-3", label: "Nova-3", capabilities: ["speech-to-text"], detail: "Audio transcription" }] },
  { id: "OpenAI", label: "OpenAI", configured: false, status: "available", capabilities: ["text-to-speech", "speech-to-text", "language-model"], models: [{ id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS", capabilities: ["text-to-speech"], detail: "Narration" }, { id: "gpt-5", label: "GPT-5", capabilities: ["language-model"], detail: "Editorial planning" }] },
  { id: "OpenRouter", label: "OpenRouter", configured: false, status: "available", capabilities: ["language-model"], models: [{ id: "openai/gpt-4o-mini", label: "GPT-4o mini", capabilities: ["language-model"], detail: "Fast editorial planning" }, { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet", capabilities: ["language-model"], detail: "Thoughtful analysis" }] },
  { id: "Fish Audio", label: "Fish Audio", configured: false, status: "available", capabilities: ["text-to-speech", "speech-to-text"], models: [{ id: "s2.1-pro", label: "S2.1 Pro", capabilities: ["text-to-speech"], detail: "Expressive multilingual narration" }, { id: "transcribe-1", label: "Transcribe 1", capabilities: ["speech-to-text"], detail: "File transcription" }] },
  { id: "Gradium", label: "Gradium", configured: false, status: "available", capabilities: ["text-to-speech"], models: [{ id: "default", label: "Gradium TTS", capabilities: ["text-to-speech"], detail: "Natural multilingual narration" }] },
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

const initialDraft: ProjectSetup = { title: "", author: "", kind: "audiobook", narrationStyle: "narrator-cast", voiceProvider: "ElevenLabs", voiceModel: "eleven_multilingual_v2", languageModelProvider: "Cloudflare", languageModel: "@cf/openai/gpt-oss-120b", language: "Auto-detect", manuscriptName: "" };

function IconButton({ children, label, onClick }: { children: React.ReactNode; label: string; onClick?: () => void }) {
  const enabled = Boolean(onClick);
  return <button type="button" onClick={onClick} disabled={!enabled} aria-label={label} title={enabled ? label : `${label} is unavailable`} className="grid h-9 w-9 place-items-center rounded-xl border border-[#dce1d9] bg-white text-[#526065] transition enabled:hover:border-[#a9c9c4] enabled:hover:text-[#1d6a69] enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-45">{children}</button>;
}

export default function Home() {
  const { isAuthenticated, offline } = useAuth();
  const utils = trpc.useUtils();
  const persistedProjects = trpc.bookx.listProjects.useQuery(undefined, { enabled: isAuthenticated });
  const providerCatalogQuery = trpc.providers.catalog.useQuery(undefined, { enabled: isAuthenticated });
  const providerPreferencesQuery = trpc.providers.listPreferences.useQuery(undefined, { enabled: isAuthenticated });
  const providers: ProviderCatalog[] = providerCatalogQuery.data?.length ? providerCatalogQuery.data : previewProviders;
  const savedCloudflare = providerPreferencesQuery.data?.find((preference) => preference.provider === "Cloudflare") || null;
  const saveProviderPreference = trpc.providers.savePreference.useMutation();
  const removeProviderKey = trpc.providers.removeKey.useMutation();
  const saveCustomProviderMutation = trpc.providers.saveCustomProvider.useMutation();
  const removeCustomProviderMutation = trpc.providers.removeCustomProvider.useMutation();
  const validateProvider = trpc.providers.validate.useMutation();
  const startCastAnalysis = trpc.bookx.startCastAnalysis.useMutation();
  const cancelAnalysis = trpc.bookx.cancelAnalysis.useMutation();
  const assignDefaultVoices = trpc.bookx.assignDefaultVoices.useMutation();
  const createCharacterMutation = trpc.bookx.createCharacter.useMutation();
  const deleteCharacterMutation = trpc.bookx.deleteCharacter.useMutation();
  const createPronunciationMutation = trpc.bookx.createPronunciation.useMutation();
  const updatePronunciationMutation = trpc.bookx.updatePronunciation.useMutation();
  const deletePronunciationMutation = trpc.bookx.deletePronunciation.useMutation();
  const updateProjectMutation = trpc.bookx.updateProject.useMutation();
  const updateCharacter = trpc.bookx.updateCharacter.useMutation();
  const updateCharacterByName = trpc.bookx.updateCharacterByName.useMutation();
  const previewCharacterVoice = trpc.bookx.previewCharacterVoice.useMutation();
  const previewVoice = trpc.bookx.previewVoice.useMutation();
  const createPersistedProject = trpc.bookx.createProject.useMutation();
  const createChapter = trpc.bookx.createChapter.useMutation();
  const importPodcastSource = trpc.bookx.importPodcastSource.useMutation();
  const importManuscript = trpc.bookx.importManuscript.useMutation();
  const [manuscriptUpload, setManuscriptUpload] = useState<ManuscriptUpload | null>(null);
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
  const [rules, setRules] = useState<Rule[]>([]);
  const [ruleDraft, setRuleDraft] = useState<Rule>({ word: "", alias: "", phoneme: "" });
  // Manuscript, generation and export state all live on the server now, so a long
  // book survives a closed tab.
  const [playing, setPlaying] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [providerChecks, setProviderChecks] = useState<Record<string, { status: string; detail?: string }>>({});
  const [savingKeyFor, setSavingKeyFor] = useState<string | null>(null);
  const [isCasting, setIsCasting] = useState(false);
  // Timers are held in refs so unmounting (switching tab or leaving the
  // workspace) cannot fire a setState or a toast against a dead component.
  const settingsSavedTimer = useRef<number | undefined>(undefined);
  // Debounced so the catalog is queried once the user stops typing rather than
  // once per keystroke.
  const [voiceQuery, setVoiceQuery] = useState("");
  const catalogProvider = voiceCatalogProvider(activeProject.voiceProvider);
  const discoveredVoiceQuery = trpc.providers.voiceCatalog.useQuery({ provider: catalogProvider, query: voiceQuery }, { enabled: isAuthenticated });
  const creatingProject = createPersistedProject.isPending || createChapter.isPending || importPodcastSource.isPending || importManuscript.isPending;
  const activeProjectIsSaved = Boolean(isAuthenticated && persistedProjects.data?.some((project) => project.id === activeProject.id));
  const activeProjectCanPersist = Boolean(isAuthenticated && activeProject.id && !activeProject.id.startsWith("project-"));
  const workspaceQuery = trpc.bookx.getWorkspace.useQuery({ projectId: activeProject.id }, { enabled: activeProjectIsSaved });
  // Cast analysis runs in the background; poll only while it is in flight.
  const castAnalysisQuery = trpc.bookx.analysisStatus.useQuery({ projectId: activeProject.id, kind: "cast" }, {
    enabled: activeProjectIsSaved,
    refetchInterval: (query) => (["queued", "running"].includes(query.state.data?.status ?? "idle") ? 1500 : false),
  });
  const castRunning = ["queued", "running"].includes(castAnalysisQuery.data?.status ?? "idle");
  const narrationStyle = (workspaceQuery.data?.project.narrationStyle ?? activeProject.narrationStyle) as ProjectSetup["narrationStyle"];

  // An empty catalog response is a real "no match" answer while signed in, so
  // only fall back to the starter library when there is no connected catalog to
  // read from. Previously an empty search result silently presented the five
  // starter voices as matches, and previewing one failed against the provider.
  const catalogVoices: VoiceChoice[] | null = isAuthenticated && discoveredVoiceQuery.data
    ? discoveredVoiceQuery.data.map((voice, index) => ({ id: voice.id, name: voice.label, detail: voice.description, color: paletteColor(index) }))
    : null;
  const discoveredVoices: VoiceChoice[] = catalogVoices ?? voiceLibrary;
  const filteredVoices = useMemo(() => {
    const terms = voiceSearch.toLowerCase().match(/[a-z0-9]+/g) || [];
    // The server already ranks and filters a connected catalog; only the local
    // starter library needs client-side matching.
    if (!terms.length || catalogVoices) return discoveredVoices;
    return discoveredVoices
      .map((voice) => {
        const haystack = `${voice.id} ${voice.name} ${voice.detail}`.toLowerCase();
        return { voice, score: terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0) };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.voice.name.localeCompare(right.voice.name))
      .map(({ voice }) => voice);
  }, [catalogVoices, discoveredVoices, voiceSearch]);
  // Readiness is derived from rendered audio, not from a simulated progress value,
  // so Review and Export cannot report a book as ready before it is.
  const narrationStatusQuery = trpc.bookx.narrationStatus.useQuery({ projectId: activeProject.id }, { enabled: activeProjectIsSaved });
  const narrationAuditQuery = trpc.bookx.auditNarration.useQuery({ projectId: activeProject.id }, { enabled: activeProjectIsSaved });
  const narrationChapters = narrationStatusQuery.data?.chapters ?? [];
  const readiness = projectReadiness({
    chapterCount: narrationChapters.length || workspaceQuery.data?.chapters.length || 0,
    generatedChapters: narrationChapters.filter((chapter) => chapter.totalSegments > 0 && chapter.renderedSegments === chapter.totalSegments).length,
    hasCast: characters.length >= 1 && characters.every((character) => Boolean(character.voiceId)),
    hasTimeline: (workspaceQuery.data?.chapters.length ?? 0) > 0,
  });

  useEffect(() => {
    // A quota error or Safari private mode would otherwise throw during commit
    // and replace the whole workspace with the error boundary.
    try {
      window.localStorage.setItem("bookx-projects", JSON.stringify(projects));
    } catch {
      // The shelf is a convenience cache; failing to persist it is not fatal.
    }
  }, [projects]);

  useEffect(() => {
    const handle = window.setTimeout(() => setVoiceQuery(voiceSearch.trim()), 250);
    return () => window.clearTimeout(handle);
  }, [voiceSearch]);

  useEffect(() => () => {
    window.clearTimeout(settingsSavedTimer.current);
    // Leaving the workspace should stop a running browser voice sample.
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

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

  // Rendered audio is addressed by character name and voice id, so it belongs to
  // one project only. Without this reset, switching projects kept the previous
  // project's `<audio>` sources under identically named characters.
  useEffect(() => {
    setPreviewUrls({});
    setLibraryPreviewUrls({});
  }, [activeProject.id]);

  // Deliberately keyed on the project *id* rather than the `activeProject`
  // object: `storeLocalCastOverride` replaces that object on every voice change,
  // and re-running this would discard locally added speakers. Voice changes
  // already update `characters` directly, so this only needs to run when the
  // open project changes or its workspace finishes loading.
  useEffect(() => {
    const overrides = readCastOverrides(activeProject);

    // Not a persisted project (or the workspace has not loaded yet): keep the
    // starter cast and just apply any browser-local voice choices.
    if (!activeProjectIsSaved || !workspaceQuery.data) {
      setCharacters(applyCastOverrides(defaultCharacters, overrides));
      return;
    }

    // A saved project shows exactly its own cast, which is empty until the book
    // is analysed. The demo cast only ever belongs to the local preview.
    const savedCharacters = [...workspaceQuery.data.characters].sort((left, right) =>
      Number(right.isNarrator) - Number(left.isNarrator) || right.lineCount - left.lineCount || left.name.localeCompare(right.name));

    setCharacters(savedCharacters.map((character, index) => {
      const localOverride = overrides[character.name];
      return {
        id: character.id,
        name: character.name,
        role: character.role,
        voice: localOverride?.voice || character.voiceName || character.voiceId || "No voice yet",
        voiceId: localOverride?.voiceId || character.voiceId || undefined,
        accent: character.accent || "",
        rationale: localOverride ? "Manually selected by the creator." : character.voiceRationale || undefined,
        sampleLine: character.sampleLine || undefined,
        confidence: localOverride ? undefined : character.assignmentConfidence ?? undefined,
        color: paletteColor(index),
        isNarrator: Boolean(character.isNarrator),
        lineCount: character.lineCount,
        gender: character.gender,
        ageGroup: character.ageGroup,
        description: character.description,
        assignmentSource: localOverride ? "manual" : character.assignmentSource,
      };
    }));
    setPreviewUrls(Object.fromEntries(savedCharacters
      .filter((character) => Boolean(character.previewUrl))
      .map((character) => [character.name, character.previewUrl!])),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see note above
  }, [activeProject.id, activeProjectIsSaved, workspaceQuery.data]);

  // Pronunciation rules live on the server; the local list mirrors them so the
  // dictionary is empty for a fresh project and survives a reload.
  useEffect(() => {
    if (!activeProjectIsSaved || !workspaceQuery.data) return;
    setRules(workspaceQuery.data.pronunciations.map(rule => ({
      word: rule.word,
      alias: rule.alias ?? "",
      phoneme: rule.phoneme ?? "",
    })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject.id, activeProjectIsSaved, workspaceQuery.data?.pronunciations]);

  // When a cast analysis finishes, reload the cast and segment speakers and say
  // how it went. Keyed on the transition, so it fires once per run.
  const lastCastStatus = useRef<{ projectId: string; status: string } | null>(null);
  useEffect(() => {
    const status = castAnalysisQuery.data?.status;
    if (!status) return;
    const previous = lastCastStatus.current;
    lastCastStatus.current = { projectId: activeProject.id, status };
    if (!previous || previous.projectId !== activeProject.id || previous.status === status) return;
    if (previous.status !== "running" && previous.status !== "queued") return;
    utils.bookx.getWorkspace.invalidate({ projectId: activeProject.id });
    utils.bookx.narrationStatus.invalidate({ projectId: activeProject.id });
    utils.bookx.auditNarration.invalidate({ projectId: activeProject.id });
    const message = castAnalysisQuery.data?.message || undefined;
    if (status === "completed") toast.success("The cast is ready.", { description: message });
    else if (status === "cancelled") toast("Cast analysis stopped.", { description: message });
    else if (status === "failed") toast.error("The cast analysis did not finish.", { description: message });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to status transitions only
  }, [castAnalysisQuery.data?.status, activeProject.id]);

  const updateDraft = <K extends keyof ProjectSetup>(key: K, value: ProjectSetup[K]) => setDraft((previous) => ({ ...previous, [key]: value }));
  // The file itself is kept (not just its name) so the book can be imported as
  // soon as the project exists.
  const handleManuscript = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const upload = await readManuscriptFile(file);
      setManuscriptUpload(upload);
      updateDraft("manuscriptName", upload.name);
    } catch (error) {
      setManuscriptUpload(null);
      updateDraft("manuscriptName", "");
      notify(error instanceof Error ? error.message : "Prosecast could not read that file.");
    }
  };
  const persistProviderDefaults = (customEndpoint?: string) => {
    if (!isAuthenticated) { notify("Sign in to save your routing defaults."); return; }
    // The user's own providers keep their models on their own settings.
    const targets = providers.filter((provider) => provider.configured && isBuiltInProvider(provider.id));
    if (!targets.length) { notify("Connect a provider before saving routing defaults."); return; }
    const savedPreferences = providerPreferencesQuery.data || [];
    const firstModel = (provider: ProviderCatalog, capability: ProviderCapability) =>
      provider.models.find((model) => model.capabilities.includes(capability))?.id;

    Promise.all(targets.map((provider) => {
      const saved = savedPreferences.find((preference) => preference.provider === provider.id);
      return saveProviderPreference.mutateAsync({
        provider: provider.id as BuiltInProviderId,
        // Seed a default only where none is stored. Sending a catalog model for a
        // provider that already has one would replace the custom model names
        // typed into the connection panel above.
        defaultTtsModel: saved?.defaultTtsModel ? undefined : firstModel(provider, "text-to-speech"),
        defaultSttModel: saved?.defaultSttModel ? undefined : firstModel(provider, "speech-to-text"),
        defaultLlmModel: saved?.defaultLlmModel ? undefined : firstModel(provider, "language-model"),
        fallbackProvider: provider.id === "Cloudflare" ? "OpenAI" : "Cloudflare",
        fallbackEnabled: true,
        // Only the OpenAI row owns the custom base URL field; omitting the key
        // for every other provider leaves their saved endpoint untouched.
        ...(provider.id === "OpenAI" && customEndpoint ? { apiBaseUrl: customEndpoint } : {}),
      });
    }))
      .then(() => {
        utils.providers.listPreferences.invalidate();
        setSettingsSaved(true);
        window.clearTimeout(settingsSavedTimer.current);
        settingsSavedTimer.current = window.setTimeout(() => setSettingsSaved(false), 1800);
        toast.success("Routing defaults saved for new projects.");
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Prosecast could not save the routing defaults."));
  };
  const checkProvider = (provider: string) => validateProvider.mutate({ provider: provider as ProviderId }, {
    onSuccess: (result) => setProviderChecks((current) => ({ ...current, [provider]: { status: result.status, detail: "detail" in result ? result.detail : undefined } })),
    // Without this the button sat on "Check" forever with no explanation.
    onError: (error) => setProviderChecks((current) => ({ ...current, [provider]: { status: "degraded", detail: error.message || "Connection test failed" } })),
  });
  /**
   * Saves an API key for any provider. The key is write-only server-side, so the
   * only feedback is the provider flipping to "connected" once the catalog
   * refreshes.
   */
  const refreshProviders = () => Promise.all([
    utils.providers.catalog.invalidate(),
    utils.providers.listPreferences.invalidate(),
    utils.providers.voiceCatalog.invalidate(),
  ]);
  /** A new key's result replaces any earlier check for the provider. */
  const forgetCheck = (provider: string) => setProviderChecks((current) => {
    const { [provider]: _dropped, ...rest } = current;
    return rest;
  });
  const persistProviderKey = (provider: string, apiKey: string) => {
    if (!isAuthenticated) { notify("Sign in to save provider keys."); return; }
    if (!apiKey || !isBuiltInProvider(provider)) return;
    setSavingKeyFor(provider);
    saveProviderPreference.mutate({ provider, apiKey }, {
      onSuccess: async () => {
        await refreshProviders();
        forgetCheck(provider);
        toast.success(`${provider} key saved.`, { description: "Checking it against the provider now." });
        // Verify straight away, so a mistyped key shows up here rather than mid-book.
        checkProvider(provider);
      },
      onError: (error) => toast.error(error.message || `Prosecast could not save the ${provider} key.`),
      onSettled: () => setSavingKeyFor(null),
    });
  };
  const forgetProviderKey = (provider: string) => {
    if (!isAuthenticated) { notify("Sign in to manage provider keys."); return; }
    if (!isBuiltInProvider(provider)) return;
    removeProviderKey.mutate({ provider }, {
      onSuccess: async (result) => {
        await refreshProviders();
        forgetCheck(provider);
        toast.success(result.removed ? `${provider} key removed.` : `No ${provider} key was saved here.`);
      },
      onError: (error) => toast.error(error.message || `Prosecast could not remove the ${provider} key.`),
    });
  };
  /** Saves the Cloudflare account ID and/or token from the Cloudflare card. */
  const persistCloudflareAccount = (accountId: string, apiToken: string) => {
    if (!isAuthenticated) { notify("Sign in to save your Cloudflare connection."); return; }
    if (!accountId && !apiToken) return;
    setSavingKeyFor("Cloudflare");
    saveProviderPreference.mutate({
      provider: "Cloudflare",
      ...(accountId ? { apiBaseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai` } : {}),
      ...(apiToken ? { apiKey: apiToken } : {}),
    }, {
      onSuccess: async () => {
        await refreshProviders();
        forgetCheck("Cloudflare");
        toast.success("Cloudflare connection saved.", { description: "Checking it now." });
        checkProvider("Cloudflare");
      },
      onError: (error) => toast.error(error.message || "Prosecast could not save the Cloudflare connection."),
      onSettled: () => setSavingKeyFor(null),
    });
  };
  const persistCustomProvider = async (draft: CustomProviderDraft): Promise<boolean> => {
    if (!isAuthenticated) { notify("Sign in to add providers."); return false; }
    const apiKey = draft.removeKey ? "" : draft.apiKey.trim() || undefined;
    try {
      const saved = await saveCustomProviderMutation.mutateAsync({
        ...(draft.id && isCustomProviderId(draft.id) ? { id: draft.id } : {}),
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        // Adding: the key if one was typed. Editing: blank keeps the saved key.
        ...(apiKey !== undefined ? { apiKey } : {}),
        ttsModel: draft.ttsModel.trim(),
        sttModel: draft.sttModel.trim(),
        voices: parseVoiceList(draft.voices),
      });
      await refreshProviders();
      forgetCheck(saved.id);
      toast.success(draft.id ? `${draft.label.trim()} updated.` : `${draft.label.trim()} added.`, { description: "Checking the connection now." });
      checkProvider(saved.id);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Prosecast could not save that provider.");
      return false;
    }
  };
  const forgetCustomProvider = (id: string) => {
    if (!isAuthenticated || !isCustomProviderId(id)) return;
    const label = providers.find((provider) => provider.id === id)?.label || "Provider";
    removeCustomProviderMutation.mutate({ id }, {
      onSuccess: async () => {
        await refreshProviders();
        forgetCheck(id);
        toast.success(`${label} removed.`, { description: "Projects that used it need another voice provider." });
      },
      onError: (error) => toast.error(error.message || `Prosecast could not remove ${label}.`),
    });
  };
  const persistCloudflareConnection = (connection: CloudflareConnectionDraft) => {
    if (!isAuthenticated) { notify("Sign in to save your Cloudflare connection."); return; }
    saveProviderPreference.mutate({
      provider: "Cloudflare",
      // This panel owns these fields, so an emptied input must clear the stored
      // value. `savePreference` treats "" as clear and omission as leave-alone.
      apiBaseUrl: connection.apiBaseUrl.trim(),
      defaultTtsModel: connection.ttsModel.trim(),
      defaultSttModel: connection.sttModel.trim(),
      defaultLlmModel: connection.llmModel.trim(),
      // A blank key means "keep the saved one", per the field's placeholder.
      apiKey: connection.apiKey.trim() || undefined,
      fallbackProvider: "OpenAI",
      fallbackEnabled: true,
    }, {
      onSuccess: () => {
        utils.providers.catalog.invalidate();
        utils.providers.listPreferences.invalidate();
        toast.success("Cloudflare connection saved.");
      },
      onError: (error) => toast.error(error.message || "Prosecast could not save the Cloudflare connection."),
    });
  };

  const resetWizard = () => {
    setWizardOpen(false);
    setWizardStep(1);
    setDraft(initialDraft);
    // Cancelling the wizard has to drop the staged import too. Keeping it meant
    // the next podcast project silently inherited an abandoned script and
    // re-uploaded its audio, and held up to 25 MB of base64 in memory.
    setPendingPodcastImport(null);
    setManuscriptUpload(null);
  };
  const createProject = async () => {
    // The wizard button is only disabled by `canContinue`, so without this a
    // second click while the first save is in flight created two projects.
    if (creatingProject) return;
    const parsed = projectSetupSchema.safeParse(draft);
    if (!parsed.success) {
      notify(parsed.error.issues[0]?.message || "Check the project details before continuing.");
      return;
    }
    let project: Project = { ...parsed.data, id: `project-${Date.now()}`, progress: 0, updated: "Just now", chapters: 0, duration: "—", cover: parsed.data.kind === "podcast" ? "linear-gradient(145deg,#412f49,#966b91 58%,#e6b47b)" : "linear-gradient(145deg,#183d43,#5e9a96 56%,#d8c886)" };
    if (!isAuthenticated && manuscriptUpload) {
      notify("Sign in to import the manuscript. This preview project only lives in your browser.");
    }
    if (isAuthenticated) {
      try {
        const saved = await createPersistedProject.mutateAsync(parsed.data);
        project = { ...project, id: saved.id };
        if (manuscriptUpload) {
          try {
            const imported = await importManuscript.mutateAsync({ projectId: saved.id, filename: manuscriptUpload.name, base64: manuscriptUpload.base64, mode: "replace" });
            project = { ...project, chapters: imported.included };
            toast.success(`Imported ${imported.imported} section${imported.imported === 1 ? "" : "s"}; ${imported.included} are in the audiobook.`, {
              description: imported.excluded
                ? `${imported.excluded} front- or back-matter section${imported.excluded === 1 ? " was" : "s were"} left out. Review the chapter list in Write.`
                : "Review the chapter list in Write.",
            });
          } catch (error) {
            notify(error instanceof Error ? `The project was created, but the manuscript could not be imported: ${error.message}` : "The project was created, but the manuscript could not be imported.");
          }
        }
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
        notify(error instanceof Error ? error.message : "Prosecast could not save this project yet. You can keep working in the local preview.");
      }
    }
    setProjects((previous) => [project, ...previous]);
    setActiveProject(project);
    resetWizard();
    setScreen("workspace");
    setTab("manuscript");
  };

  const openProject = (project: Project) => {
    const overrides = readCastOverrides(project);
    if (Object.keys(overrides).length) setCharacters((previous) => applyCastOverrides(previous, overrides));
    setActiveProject(project);
    setScreen("workspace");
    setTab("manuscript");
  };
  const invalidateCast = () => {
    utils.bookx.getWorkspace.invalidate({ projectId: activeProject.id });
    utils.bookx.narrationStatus.invalidate({ projectId: activeProject.id });
    utils.bookx.auditNarration.invalidate({ projectId: activeProject.id });
  };
  /**
   * Starts the whole-book cast analysis. It runs on the server (finding the
   * cast, attributing every line, picking default voices), so the button only
   * starts it and the status banner follows it.
   */
  const autoCast = () => {
    const applyFallback = (message: string) => {
      setCharacters((previous) => previous.map((character, index) => {
        // Wrap around the library instead of collapsing every character past the
        // fifth onto `voiceLibrary[3]`, which contradicted the "distinct
        // assignment" the message promises.
        const voice = voiceLibrary[index % voiceLibrary.length]!;
        return { ...character, voice: voice.name, voiceId: voice.id, confidence: 72, rationale: "A distinct fallback assignment was created from the current cast order." };
      }));
      notify(message);
    };
    if (!isAuthenticated) { applyFallback("Preview casting assigned distinct voices. Sign in to analyze your manuscript with the selected language model."); return; }
    if (!activeProjectIsSaved) { notify("This project only exists in this browser. Open a saved project to analyze its manuscript."); return; }
    setIsCasting(true);
    // A re-run after a finished analysis re-reads every chapter; your own voice
    // and speaker choices are kept either way.
    const force = castAnalysisQuery.data?.status === "completed";
    startCastAnalysis.mutate({ projectId: activeProject.id, force }, {
      onSuccess: (result) => {
        void castAnalysisQuery.refetch();
        toast(result.reused ? "The cast analysis is already running." : "Reading the whole book to find the cast…", { description: "You can keep working; the cast appears here when it is ready." });
      },
      onError: (error) => toast.error(error.message || "Prosecast could not start the cast analysis."),
      onSettled: () => setIsCasting(false),
    });
  };
  const cancelCastAnalysis = () => {
    const jobId = castAnalysisQuery.data?.jobId;
    if (!jobId) return;
    cancelAnalysis.mutate({ projectId: activeProject.id, jobId }, { onSuccess: () => { void castAnalysisQuery.refetch(); toast("Stopping after the current chapter."); } });
  };
  const assignDefaults = () => {
    if (!activeProjectIsSaved) { notify("Open a saved project to assign voices."); return; }
    assignDefaultVoices.mutate({ projectId: activeProject.id }, {
      onSuccess: (result) => { invalidateCast(); toast.success(result.assigned ? `Chose default voices for ${result.assigned} character${result.assigned === 1 ? "" : "s"}.` : "Every character already has the voice you chose."); },
      onError: (error) => toast.error(error.message || "Prosecast could not assign voices."),
    });
  };
  const changeNarrationStyle = (style: ProjectSetup["narrationStyle"]) => {
    if (!activeProjectIsSaved) { notify("Open a saved project to change how it is narrated."); return; }
    updateProjectMutation.mutate({ projectId: activeProject.id, narrationStyle: style }, {
      onSuccess: () => {
        setActiveProject((previous) => ({ ...previous, narrationStyle: style }));
        setProjects((previous) => previous.map((project) => project.id === activeProject.id ? { ...project, narrationStyle: style } : project));
        invalidateCast();
        utils.bookx.listProjects.invalidate();
        toast.success(style === "single" ? "One narrator will read everything." : "Characters will speak their own lines.", {
          description: style === "single" ? "Existing speaker choices are kept in case you switch back." : "Analyze the book to find the cast and attribute the dialogue.",
        });
      },
      onError: (error) => toast.error(error.message || "Prosecast could not change the narration style."),
    });
  };
  const removeCharacter = (character: Character) => {
    if (!character.id || !activeProjectIsSaved) { setCharacters((previous) => previous.filter((item) => item.name !== character.name)); return; }
    if (!window.confirm(`Remove ${character.name}? Their lines will be read by the narrator.`)) return;
    deleteCharacterMutation.mutate({ projectId: activeProject.id, characterId: character.id }, {
      onSuccess: () => { invalidateCast(); toast(`${character.name} removed. Their lines now use the narrator's voice.`); },
      onError: (error) => toast.error(error.message || "Prosecast could not remove that character."),
    });
  };
  const addRule = () => {
    const word = ruleDraft.word.trim();
    if (!word) return;
    const next = { word, alias: ruleDraft.alias.trim(), phoneme: ruleDraft.phoneme.trim() };
    setRules((previous) => [...previous, next]);
    setRuleDraft({ word: "", alias: "", phoneme: "" });
    if (activeProjectCanPersist) {
      createPronunciationMutation.mutate({ projectId: activeProject.id, word, alias: next.alias || undefined, phoneme: next.phoneme || undefined }, {
        onSuccess: () => utils.bookx.getWorkspace.invalidate({ projectId: activeProject.id }),
        onError: (error) => toast.error(error.message || "Prosecast could not save that rule."),
      });
    }
  };
  const notify = (message: string) => toast(message);
  const addCharacter = () => {
    if (!activeProjectIsSaved) {
      setCharacters((previous) => [...previous, { name: `Character ${previous.length + 1}`, role: "Supporting character", voice: "Noor", voiceId: "noor-global", accent: "Velvet · Global", color: "#8cab91" }]);
      return;
    }
    const name = window.prompt("Name of the new speaker, as the book calls them")?.trim();
    if (!name) return;
    createCharacterMutation.mutate({ projectId: activeProject.id, name: name.slice(0, 160), role: "Supporting character", assignmentSource: "manual" }, {
      onSuccess: () => { invalidateCast(); toast.success(`${name} added. Choose their voice, then assign lines to them from the Write screen.`); },
      onError: (error) => toast.error(error.message || "Prosecast could not add that speaker."),
    });
  };
  const deleteRule = (word: string) => {
    setRules((previous) => previous.filter((rule) => rule.word !== word));
    if (activeProjectCanPersist) {
      const persisted = workspaceQuery.data?.pronunciations.find((rule) => rule.word === word);
      if (persisted) {
        deletePronunciationMutation.mutate({ projectId: activeProject.id, ruleId: persisted.id }, {
          onSuccess: () => utils.bookx.getWorkspace.invalidate({ projectId: activeProject.id }),
          onError: (error) => toast.error(error.message || "Prosecast could not remove that rule."),
        });
      }
    }
  };
  /** What a disabled panel should say: reconnecting beats a bogus sign-in prompt. */
  const panelDisabledReason = (signedInReason: string, signedOutReason: string) =>
    offline
      ? "Prosecast cannot reach the server. Reconnecting… your session and work are safe; this recovers by itself once the server is back."
      : isAuthenticated
        ? signedInReason
        : signedOutReason;
  const storeLocalCastOverride = (name: string, voice: VoiceChoice) => {
    try {
      const key = `bookx-cast-overrides:${activeProject.id}`;
      const current = JSON.parse(window.localStorage.getItem(key) || "{}") as Record<string, { voice: string; voiceId: string }>;
      const next = JSON.stringify({ ...current, [name]: { voice: voice.name, voiceId: voice.id } });
      window.localStorage.setItem(key, next);
      window.localStorage.setItem(`bookx-cast-overrides-title:${activeProject.title}`, next);
      const localCastOverrides = { ...(activeProject.localCastOverrides || {}), [name]: { voice: voice.name, voiceId: voice.id } };
      // No `localStorage` write here: React may call a state updater more than
      // once, and it would run outside this try/catch. The effect on `projects`
      // already persists the shelf.
      setProjects((previous) => previous.map((project) => project.id === activeProject.id ? { ...project, localCastOverrides } : project));
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
    const provider = narrationProvider(activeProject.voiceProvider, providers);
    if (!activeProjectIsSaved || !persisted || !provider) { playBrowserSample(character.voice); notify(`${character.name} browser preview is playing.`); return; }
    // Each click is a paid provider request; one at a time.
    if (previewCharacterVoice.isPending) { notify("A voice preview is already being made."); return; }
    previewCharacterVoice.mutate({ projectId: activeProject.id, characterId: persisted.id, provider, voiceId: character.voiceId, model: activeProject.voiceModel }, {
      onSuccess: (result) => { setPreviewUrls((current) => ({ ...current, [character.name]: result.audioUrl })); toast.success(`${character.name} preview is ready.`); },
      onError: () => toast.error("Prosecast could not generate that preview.", { description: "You can choose another voice or provider." }),
    });
  };
  const playBrowserSample = (voiceName: string) => {
    if (!("speechSynthesis" in window)) { notify("This browser does not support local speech samples. Sign in to generate a provider voice preview."); return; }
    window.speechSynthesis.cancel();
    const sample = new SpeechSynthesisUtterance(`This is a Prosecast sample for ${voiceName}. A clear voice helps listeners follow every moment.`);
    sample.rate = 0.96;
    window.speechSynthesis.speak(sample);
    notify(`Playing a browser sample for ${voiceName}. Sign in to render the selected provider voice.`);
  };
  const previewLibraryVoice = (voice: VoiceChoice) => {
    const provider = narrationProvider(activeProject.voiceProvider, providers);
    if (!activeProjectIsSaved || !provider) { playBrowserSample(voice.name); notify(`${voice.name} browser preview is playing.`); return; }
    if (previewVoice.isPending) { notify("A voice preview is already being made."); return; }
    previewVoice.mutate({ projectId: activeProject.id, provider, voiceId: voice.id, model: activeProject.voiceModel, text: `This is a Prosecast sample for ${voice.name}. A clear voice helps listeners follow every moment.` }, {
      onSuccess: (result) => { setLibraryPreviewUrls((current) => ({ ...current, [voice.id]: result.audioUrl })); toast.success(`${voice.name} provider preview is ready.`); },
      onError: () => toast.error("Prosecast could not generate that provider preview.", { description: "Try another voice or provider." }),
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
        <Dashboard projects={isAuthenticated ? projects.filter((project) => !demoProjectIds.has(project.id)) : projects} loading={isAuthenticated && persistedProjects.isLoading} isAuthenticated={isAuthenticated} offline={offline} onNew={() => { setDraft(initialDraft); setPendingPodcastImport(null); setWizardOpen(true); setWizardStep(1); }} onImport={() => setImportOpen(true)} onOpen={openProject} />
      ) : (
        <Workspace project={activeProject} tab={tab} setTab={setTab} onBack={() => setScreen("dashboard")} onShare={() => notify("Preview link prepared for sharing.")} onSettings={() => setTab("settings")}>
          {tab === "manuscript" && (
            <ManuscriptEditor
              projectId={activeProject.id}
              canEdit={activeProjectIsSaved}
              disabledReason={panelDisabledReason(
                "This project only exists in this browser. Create or open a saved project to write chapters that Prosecast can narrate.",
                "Sign in to write chapters. The manuscript is stored server-side so narration and export can read it.")}
              onNext={() => setTab("cast")}
            />
          )}
          {tab === "cast" && <CastingReview characters={characters.map((character) => ({ ...character, previewUrl: previewUrls[character.name] }))} voices={filteredVoices} voicesLoading={isAuthenticated && discoveredVoiceQuery.isLoading} query={voiceSearch} setQuery={setVoiceSearch} prompt={voicePrompt} setPrompt={setVoicePrompt} onFindSimilar={findSimilarVoices} onAutoCast={autoCast} onAddCharacter={addCharacter} isCasting={isCasting || castRunning} modelLabel={`${activeProject.languageModelProvider || "Cloudflare"} · ${activeProject.languageModel || "@cf/openai/gpt-oss-120b"}`} onPreview={previewCharacter} onPreviewVoice={previewLibraryVoice} onVoiceChange={changeCharacterVoice} libraryPreviewUrls={libraryPreviewUrls} analysis={activeProjectIsSaved && castAnalysisQuery.data ? castAnalysisQuery.data : null} onCancelAnalysis={cancelCastAnalysis} narrationStyle={narrationStyle} onNarrationStyleChange={activeProjectIsSaved ? changeNarrationStyle : undefined} onAssignDefaults={activeProjectIsSaved ? assignDefaults : undefined} assigningDefaults={assignDefaultVoices.isPending} onRemoveCharacter={removeCharacter} />}
          {tab === "pronunciation" && <Pronunciation rules={rules} draft={ruleDraft} setDraft={setRuleDraft} onAdd={addRule} onDelete={deleteRule} />}
          {tab === "generation" && (
            <NarrationRun
              projectId={activeProject.id}
              canRender={activeProjectIsSaved}
              disabledReason={panelDisabledReason(
                "This project only exists in this browser. Create or open a saved project to render narration you can pause and resume.",
                "Sign in to render narration. Runs are checkpointed on the server so a long book survives a closed tab or a dropped connection.")}
            />
          )}
          {tab === "studio" && (activeProject.kind === "audiobook" ? (
            <SoundDesign
              projectId={activeProject.id}
              canEdit={activeProjectIsSaved}
              disabledReason={panelDisabledReason(
                "This project only exists in this browser. Create or open a saved project to add background sounds and music.",
                "Sign in to add background sounds and music. Sounds are planned, made and mixed on the server.")}
            />
          ) : (
            <EnhancedProduction kind={activeProject.kind} playing={playing} setPlaying={setPlaying} />
          ))}
          {tab === "review" && <Review readiness={readiness} chapters={narrationChapters} characters={characters} audit={narrationAuditQuery.data} onOpenGeneration={() => setTab("generation")} />}
          {tab === "export" && (
            <ExportPackage
              projectId={activeProject.id}
              canExport={activeProjectIsSaved}
              disabledReason={panelDisabledReason(
                "This project only exists in this browser. Create or open a saved project to assemble a package.",
                "Sign in to assemble a package. Prosecast joins the rendered segments server-side and verifies nothing is missing first.")}
            />
          )}
          {tab === "settings" && (
            <ProviderSettings
              providers={providers}
              saved={settingsSaved}
              checks={providerChecks}
              onSave={persistProviderDefaults}
              onSaveKey={persistProviderKey}
              onRemoveKey={forgetProviderKey}
              onSaveCloudflareAccount={persistCloudflareAccount}
              onSaveCustomProvider={persistCustomProvider}
              onRemoveCustomProvider={forgetCustomProvider}
              onValidate={checkProvider}
              cloudflareSaved={savedCloudflare}
              onSaveCloudflare={persistCloudflareConnection}
              savingKey={savingKeyFor}
            />
          )}
        </Workspace>
      )}

      {wizardOpen && <ProjectWizard step={wizardStep} setStep={setWizardStep} draft={draft} updateDraft={updateDraft} providers={providers} onClose={resetWizard} onCreate={createProject} onFile={handleManuscript} creating={creatingProject} />}
      {importOpen && <PodcastImportDialog onClose={() => setImportOpen(false)} onFinish={beginPodcastSetup} />}
    </main>
  );
}

function Dashboard({ projects, loading, isAuthenticated, offline, onNew, onImport, onOpen }: { projects: Project[]; loading: boolean; isAuthenticated: boolean; offline: boolean; onNew: () => void; onImport: () => void; onOpen: (project: Project) => void }) {
  return <div className="mx-auto min-h-screen max-w-[1440px] px-5 pb-12 pt-5 md:px-10">
    <header className="flex items-center justify-between border-b border-[#e2e4dd] pb-5">
      <button className="flex items-center gap-3 text-left" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><span className="grid h-10 w-10 place-items-center rounded-[14px] bg-[#245f63] text-white shadow-[0_8px_20px_rgba(36,95,99,.22)]"><Headphones size={19} /></span><span><span className="block text-[17px] font-bold tracking-[-.04em]">Prosecast</span><span className="block text-[10px] tracking-[.14em] text-[#718084]">AUDIO WORKSPACE</span></span></button>
      <nav aria-label="Workspace context" className="hidden items-center gap-2 md:flex"><button aria-current="page" onClick={() => document.getElementById("recent-work")?.scrollIntoView({ behavior: "smooth" })} className="rounded-full bg-[#e3f0ed] px-4 py-2 text-sm font-semibold text-[#256d69]">Projects</button><button type="button" disabled title="Library is not available yet" className="rounded-full px-4 py-2 text-sm text-[#6f7d80] disabled:cursor-not-allowed">Library</button><button type="button" disabled title="Series is not available yet" className="rounded-full px-4 py-2 text-sm text-[#6f7d80] disabled:cursor-not-allowed">Series</button></nav>
      <div className="flex items-center gap-2"><IconButton label="Search"><Search size={16} /></IconButton>{offline ? <span className="rounded-full bg-[#f3e8d3] px-2.5 py-1.5 text-[11px] font-bold text-[#9b712f]" title="The server cannot be reached; retrying automatically">Reconnecting…</span> : isAuthenticated ? <div className="flex items-center gap-2" title="Signed in"><span className="rounded-full bg-[#edf4ef] px-2.5 py-1.5 text-[11px] font-bold text-[#3d716a]">Signed in</span><div className="grid h-9 w-9 place-items-center rounded-full bg-[#d9b66b] text-xs font-bold text-[#2a3537]">ME</div></div> : <button onClick={() => startLogin()} className="btn-primary">Sign in</button>}</div>
    </header>

    <section className="brand-wave fade-up grid gap-8 py-12 lg:grid-cols-[1.25fr_.75fr] lg:items-end">
      <div><div className="mb-5 flex items-center gap-2 text-[11px] font-bold tracking-[.18em] text-[#49827d]"><span className="h-2 w-2 rounded-full bg-[#72aa95]" /> YOUR STUDIO</div><h1 className="serif max-w-3xl text-5xl leading-[.98] tracking-[-.055em] text-[#203438] md:text-7xl">Make something<br />people can hear.</h1><p className="mt-6 max-w-xl text-base leading-7 text-[#647276]">A considered workspace for turning manuscripts, ideas, and performances into finished audiobooks and podcasts.</p></div>
      <div className="panel-shadow rounded-[26px] border border-[#dfe5dd] bg-[#fbfaf6] p-5"><div className="mb-5 flex items-center justify-between"><span className="mono text-[10px] tracking-[.12em] text-[#7c8988]">THE PROSECAST METHOD</span><Sparkles size={17} className="text-[#ba8c43]" /></div><div className="grid grid-cols-3 gap-2">{[["01", "Shape"], ["02", "Voice"], ["03", "Publish"]].map(([number, label]) => <div key={label} className="rounded-2xl bg-[#f0f3ed] p-3"><span className="mono block text-[10px] text-[#7b8a88]">{number}</span><strong className="mt-5 block text-sm">{label}</strong></div>)}</div></div>
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

function ProjectWizard({ step, setStep, draft, updateDraft, providers, onClose, onCreate, onFile, creating }: { step: number; setStep: (next: number) => void; draft: ProjectSetup; updateDraft: <K extends keyof ProjectSetup>(key: K, value: ProjectSetup[K]) => void; providers: ProviderCatalog[]; onClose: () => void; onCreate: () => void; onFile: (event: ChangeEvent<HTMLInputElement>) => void; creating: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = "project-wizard-title";

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Move focus into the dialog so a keyboard user's next Tab stays inside it.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const canContinue = (step !== 1 || Boolean(draft.title.trim())) && !creating;
  const modelsFor = (capability: ProviderCapability, providerId: string) => providers.find((provider) => provider.id === providerId)?.models.filter((model) => model.capabilities.includes(capability)) || [];
  const voiceModels = modelsFor("text-to-speech", draft.voiceProvider);
  const languageModels = modelsFor("language-model", draft.languageModelProvider);
  const chooseProvider = (key: "voiceProvider" | "languageModelProvider", capability: ProviderCapability, providerId: string) => {
    updateDraft(key, providerId);
    const firstModel = modelsFor(capability, providerId)[0];
    if (firstModel) updateDraft(key === "voiceProvider" ? "voiceModel" : "languageModel", firstModel.id);
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#173034]/35 p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}><div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="soft-shadow flex h-[calc(100dvh-2rem)] max-h-[800px] w-full max-w-3xl flex-col overflow-hidden rounded-[30px] border border-white/70 bg-[#fffefa] outline-none"><div className="shrink-0 flex items-start justify-between px-7 pb-5 pt-7"><div><p className="mono text-[10px] tracking-[.16em] text-[#5d918b]">START A NEW PROJECT</p><h2 id={titleId} className="serif mt-2 text-3xl tracking-[-.045em]">{step === 1 ? "Begin with the story." : step === 2 ? "Set the vocal character." : "Review the intent."}</h2></div><IconButton label="Close" onClick={onClose}><X size={17} /></IconButton></div><div className="shrink-0 px-7"><div className="grid grid-cols-3 border-y border-[#e3e7df] py-3">{[[1, "Basics"], [2, "Narration"], [3, "Review"]].map(([number, label]) => <div key={number} className="flex items-center gap-2 text-sm"><span className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold ${step >= Number(number) ? "bg-[#286b69] text-white" : "bg-[#edf0eb] text-[#7a8787]"}`}>{step > Number(number) ? <Check size={13} /> : number}</span><span className={step >= Number(number) ? "font-semibold text-[#2b494b]" : "text-[#859093]"}>{label}</span></div>)}</div></div><div className="min-h-0 flex-1 overflow-y-auto px-7 py-7">
    {step === 1 && <div className="space-y-6"><div className="grid gap-3 sm:grid-cols-2">{[["audiobook", BookOpen, "Audiobook", "Long-form, chaptered narration"], ["podcast", Mic2, "Podcast", "Episodes, interviews, conversations"]].map(([kind, Icon, title, description]) => <button key={kind as string} onClick={() => updateDraft("kind", kind as "audiobook" | "podcast")} className={`rounded-2xl border p-4 text-left ${draft.kind === kind ? "border-[#7aa9a2] bg-[#edf7f4]" : "border-[#dfe5dc] bg-white"}`}>{createElement(Icon as typeof BookOpen, { size: 18, className: "mb-5 text-[#3c7d76]" })}<strong className="block">{title as string}</strong><span className="mt-1 block text-sm text-[#788588]">{description as string}</span></button>)}</div><div className="grid gap-4 sm:grid-cols-2"><Field label={draft.kind === "audiobook" ? "Book title" : "Episode / show title"}><input autoFocus value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder="e.g. The quiet morning" className="input" /></Field><Field label={draft.kind === "audiobook" ? "Author" : "Host"} optional><input value={draft.author || ""} onChange={(event) => updateDraft("author", event.target.value)} placeholder="Add a name" className="input" /></Field></div><Field label="Narration style"><div className="grid gap-2 sm:grid-cols-3">{[["single", "Single narrator"], ["cast", "Full cast"], ["narrator-cast", "Narrator + cast"]].map(([value, label]) => <button key={value} onClick={() => updateDraft("narrationStyle", value as ProjectSetup["narrationStyle"])} className={`rounded-xl border px-3 py-3 text-left text-sm ${draft.narrationStyle === value ? "border-[#7aa9a2] bg-[#eaf4f0] text-[#2d6e69]" : "border-[#e1e5de] bg-white text-[#667477]"}`}>{label}</button>)}</div></Field></div>}
    {step === 2 && <div className="space-y-6"><div className="rounded-[22px] border border-[#dbe6df] bg-[#f6faf7] p-4"><div className="mb-4 flex items-center justify-between"><div><p className="mono text-[10px] tracking-[.14em] text-[#5b8b84]">MODEL ROUTING</p><p className="mt-1 text-sm text-[#596a6d]">Choose models by task. Prosecast keeps the creative workflow independent of any one vendor.</p></div><span className="rounded-full bg-white px-3 py-1 text-[10px] font-bold text-[#4b7d76]">MODEL-AGNOSTIC</span></div><div className="grid gap-4 sm:grid-cols-2"><Field label="Voice provider"><select value={draft.voiceProvider} onChange={(event) => chooseProvider("voiceProvider", "text-to-speech", event.target.value)} className="input select">{providers.filter((provider) => provider.capabilities.includes("text-to-speech")).map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{provider.configured ? " · Connected" : ""}</option>)}</select></Field><Field label="Voice model"><select value={draft.voiceModel} onChange={(event) => updateDraft("voiceModel", event.target.value)} className="input select">{voiceModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.detail ? ` · ${model.detail}` : ""}</option>)}</select></Field><Field label="Language-model provider"><select value={draft.languageModelProvider} onChange={(event) => chooseProvider("languageModelProvider", "language-model", event.target.value)} className="input select">{providers.filter((provider) => provider.capabilities.includes("language-model")).map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{provider.configured ? " · Connected" : ""}</option>)}</select></Field><Field label="Language model"><select value={draft.languageModel} onChange={(event) => updateDraft("languageModel", event.target.value)} className="input select">{languageModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.detail ? ` · ${model.detail}` : ""}</option>)}</select></Field><Field label="Language"><select value={draft.language} onChange={(event) => updateDraft("language", event.target.value)} className="input select"><option>Auto-detect</option><option>English</option><option>Spanish</option><option>French</option><option>German</option></select></Field></div></div><label className="group flex cursor-pointer flex-col items-center justify-center rounded-[22px] border border-dashed border-[#87ada6] bg-[#f1f8f6] px-6 py-8 text-center"><Upload size={22} className="mb-3 text-[#3b7b75]" /><strong>{draft.manuscriptName || "Upload your manuscript"}</strong><span className="mt-2 text-sm text-[#718083]">EPUB, DOCX, TXT, Markdown, or HTML · up to 30 MB</span><input type="file" accept={MANUSCRIPT_ACCEPT} onChange={onFile} className="hidden" /></label><p className="rounded-xl bg-[#fbf4e5] px-4 py-3 text-sm leading-6 text-[#8a6b37]"><Sparkles className="mr-2 inline" size={15} />Prosecast will prepare chapters and narration paragraphs for your review. You can also add a manuscript later.</p></div>}
    {step === 3 && <div className="overflow-hidden rounded-[22px] border border-[#e0e5de] bg-[#fcfcf8]">{[["Project", draft.title || "Untitled project"], ["Type", `${draft.kind === "audiobook" ? "Audiobook" : "Podcast"} · ${draft.narrationStyle.replace("-", " ")}`], ["Voice model", draft.voiceModel], ["Language", draft.language], ["Manuscript", draft.manuscriptName || "Add later from Write"]].map(([label, value]) => <div key={label} className="flex items-center justify-between border-b border-[#e6e9e3] px-5 py-4 text-sm last:border-0"><span className="text-[#798689]">{label}</span><strong className="max-w-[62%] text-right capitalize text-[#334649]">{value}</strong></div>)}</div>}
  </div><div className="flex items-center justify-between border-t border-[#e4e7e0] bg-[#fafaf5] px-7 py-5"><button onClick={() => step === 1 ? onClose() : setStep(step - 1)} className="inline-flex items-center gap-2 text-sm font-semibold text-[#667477] transition hover:text-[#3c5052]"><ArrowLeft size={15} /> {step === 1 ? "Cancel" : "Back"}</button><button disabled={!canContinue} onClick={() => step < 3 ? setStep(step + 1) : onCreate()} className="btn-primary btn-lg disabled:opacity-40">{step < 3 ? "Continue" : creating ? "Creating…" : `Create ${draft.kind === "audiobook" ? "audiobook" : "podcast"}`} {creating ? <LoaderCircle className="animate-spin" size={16} /> : <ArrowRight size={16} />}</button></div></div></div>;
}

function Field({ label, optional, children }: { label: string; optional?: boolean; children: React.ReactNode }) { return <label className="block"><span className="mb-2 block text-[12px] font-bold tracking-[.02em] text-[#526267]">{label} {optional && <em className="ml-1 font-normal not-italic text-[#97a0a1]">optional</em>}</span>{children}</label>; }

function Workspace({ project, tab, setTab, onBack, onShare, onSettings, children }: { project: Project; tab: WorkspaceTab; setTab: (tab: WorkspaceTab) => void; onBack: () => void; onShare: () => void; onSettings: () => void; children: React.ReactNode }) { return <div className="min-h-screen bg-[#f4f5ef]"><header className="flex h-[68px] items-center justify-between border-b border-[#dfe4dd] bg-[#fffefa] px-4 md:px-6"><div className="flex items-center gap-3"><button onClick={onBack} className="grid h-9 w-9 place-items-center rounded-xl border border-[#e0e4df] bg-white text-[#637477] transition hover:border-[#a9c9c4] hover:text-[#1d6a69]"><ArrowLeft size={16} /></button><div className="hidden h-7 w-px bg-[#e0e3dd] sm:block" /><div><p className="mono text-[9px] tracking-[.13em] text-[#7b8889]">{project.kind === "audiobook" ? "AUDIOBOOK" : "PODCAST"}</p><div className="flex items-center gap-2"><h1 className="text-sm font-bold tracking-[-.02em]">{project.title}</h1><ChevronDown size={13} className="text-[#7d898a]" /></div></div></div><div className="hidden items-center gap-5 lg:flex"><span className="text-xs text-[#7b898b]">{project.progress}% ready</span><div className="h-1.5 w-28 overflow-hidden rounded-full bg-[#e6ebe5]"><div className="h-full bg-[#67a194] transition-[width] duration-700 ease-out" style={{ width: `${project.progress}%` }} /></div><button onClick={onShare} className="btn-primary">Share preview</button></div><div className="flex items-center gap-2"><IconButton label="Project settings" onClick={onSettings}><Settings2 size={16} /></IconButton><div className="grid h-9 w-9 place-items-center rounded-full bg-[#d6b36b] text-[10px] font-bold">ME</div></div></header><div className="flex min-h-[calc(100vh-68px)]"><aside className="hidden w-[236px] shrink-0 border-r border-[#dfe4dd] bg-[#fbfbf7] p-4 md:block"><button onClick={onBack} className="mb-5 flex items-center gap-2 px-2 text-xs font-semibold text-[#5f7e7b]"><Headphones size={14} /> Prosecast workspace</button>{["CREATE", "PRODUCE", "FINISH", "SYSTEM"].map((group) => <div key={group} className="mb-5"><p className="mono mb-2 px-2 text-[9px] tracking-[.14em] text-[#9aa3a2]">{group}</p>{nav.filter((item) => item.group === group).map((item) => { const Icon = item.icon; return <button key={item.id} onClick={() => setTab(item.id)} className={`mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] transition ${tab === item.id ? "bg-[#e8f2ee] font-bold text-[#276b67]" : "text-[#667477] hover:bg-[#f0f2ed]"}`}><Icon size={16} />{item.label}{item.id === "generation" && <span className="ml-auto rounded-full bg-[#dceae4] px-2 py-0.5 text-[9px]">1</span>}</button>})}</div>)}</aside><div className="flex min-w-0 flex-1 flex-col"><div aria-label="Workspace sections" className="flex overflow-x-auto border-b border-[#dfe4dd] bg-[#fbfbf8] px-3 py-2 md:hidden">{nav.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`shrink-0 rounded-lg px-3 py-2 text-xs ${tab === item.id ? "bg-[#e4f0ec] font-bold text-[#2b706c]" : "text-[#718083]"}`}>{item.label}</button>)}</div><div key={tab} className="fade-up flex min-h-0 flex-1 flex-col">{children}</div></div></div></div>; }

function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) { return <div className="flex flex-col gap-5 border-b border-[#e1e5de] bg-[#fffefa] px-6 py-6 md:flex-row md:items-end md:justify-between md:px-9"><div><p className="mono text-[10px] tracking-[.15em] text-[#5a918b]">{eyebrow}</p><h2 className="serif mt-2 text-3xl tracking-[-.04em] text-[#25393c]">{title}</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[#738084]">{description}</p></div>{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}</div>; }


function Pronunciation({ rules, draft, setDraft, onAdd, onDelete }: { rules: Rule[]; draft: Rule; setDraft: (rule: Rule) => void; onAdd: () => void; onDelete: (word: string) => void }) { return <div className="flex min-h-0 flex-1 flex-col"><PageHeader eyebrow="02 · CAST" title="Pronounce every detail." description="Create word rules and phoneme overrides so names, places, and technical language sound exactly right." /><div className="grid flex-1 gap-6 p-6 md:grid-cols-[1fr_360px] md:p-9"><section><div className="rounded-[22px] border border-[#e0e5de] bg-[#fffefa] p-5"><div className="flex items-center justify-between"><div><h3 className="font-bold">Project dictionary</h3><p className="mt-1 text-sm text-[#788689]">Applied anywhere the term appears in this project.</p></div><span className="rounded-full bg-[#e8f3ef] px-3 py-1 text-xs font-bold text-[#3c776f]">{rules.length} rules</span></div><div className="mt-5 overflow-hidden rounded-xl border border-[#e4e8e2]"><div className="grid grid-cols-[1.2fr_1fr_1fr_36px] bg-[#f4f6f1] px-4 py-3 mono text-[9px] tracking-[.12em] text-[#899594]"><span>WORD</span><span>ALIAS</span><span>PHONEME</span><span /></div>{rules.map((rule) => <div key={rule.word} className="grid grid-cols-[1.2fr_1fr_1fr_36px] items-center border-t border-[#edf0ea] px-4 py-4 text-sm"><strong>{rule.word}</strong><span className="text-[#5f7274]">{rule.alias}</span><span className="mono text-[11px] text-[#6f7e81]">{rule.phoneme || "—"}</span><button onClick={() => onDelete(rule.word)} aria-label={`Delete ${rule.word}`} className="text-[#9aa2a3] hover:text-[#af5d5d]"><Trash2 size={14} /></button></div>)}</div></div></section><aside className="rounded-[22px] border border-[#dfe5de] bg-[#fbfbf7] p-5"><span className="mono text-[10px] tracking-[.13em] text-[#658c87]">ADD A RULE</span><h3 className="serif mt-2 text-2xl">Teach Prosecast a name.</h3><div className="mt-5 space-y-4"><Field label="Word"><input value={draft.word} onChange={(event) => setDraft({ ...draft, word: event.target.value })} placeholder="e.g. Aurelia" className="input" /></Field><Field label="Say it as"><input value={draft.alias} onChange={(event) => setDraft({ ...draft, alias: event.target.value })} placeholder="e.g. aw-REE-lee-ah" className="input" /></Field><Field label="Phoneme override" optional><input value={draft.phoneme} onChange={(event) => setDraft({ ...draft, phoneme: event.target.value })} placeholder="e.g. ɔːˈriːliə" className="input mono" /></Field><button onClick={onAdd} className="btn-primary btn-lg w-full">Add pronunciation rule</button></div></aside></div></div>; }

/**
 * Pre-flight report. Every line is derived from stored state, so it cannot claim a
 * stage is done when it is not — which was the point of removing the hardcoded
 * "31 of 34 paragraphs are ready" that used to sit here.
 */
function Review({ readiness, chapters, characters, audit, onOpenGeneration }: {
  readiness: ReturnType<typeof projectReadiness>;
  chapters: Array<{ title: string; totalSegments: number; renderedSegments: number; failedSegments: number }>;
  characters: Character[];
  audit?: { totalSegments: number; renderedSegments: number; missingSegments: string[]; staleSegments: string[]; mismatchedVoiceSegments: string[]; suspectSegments: string[]; complete: boolean };
  onOpenGeneration: () => void;
}) {
  const totalSegments = chapters.reduce((total, chapter) => total + chapter.totalSegments, 0);
  const renderedSegments = chapters.reduce((total, chapter) => total + chapter.renderedSegments, 0);
  const failedSegments = chapters.reduce((total, chapter) => total + chapter.failedSegments, 0);
  const unvoiced = characters.filter((character) => !character.voiceId);
  const outstanding = audit
    ? audit.missingSegments.length + audit.staleSegments.length + audit.mismatchedVoiceSegments.length + audit.suspectSegments.length
    : Math.max(0, totalSegments - renderedSegments);

  const checks: Array<[string, string, boolean]> = [
    ["Manuscript structure",
      totalSegments ? `${chapters.length} chapter(s) split into ${totalSegments} narration segments` : "No chapter text has been split into segments yet",
      totalSegments > 0],
    ["Voice casting",
      unvoiced.length ? `${unvoiced.length} of ${characters.length} speaker(s) still need a voice` : `${characters.length} speaker(s) have an assigned voice`,
      characters.length > 0 && unvoiced.length === 0],
    ["Audio generation",
      totalSegments ? `${renderedSegments} of ${totalSegments} segments rendered${failedSegments ? `, ${failedSegments} failed` : ""}` : "Nothing rendered yet",
      totalSegments > 0 && renderedSegments === totalSegments],
    ["Audio matches the manuscript",
      audit
        ? audit.staleSegments.length || audit.mismatchedVoiceSegments.length
          ? `${audit.staleSegments.length} edited since rendering, ${audit.mismatchedVoiceSegments.length} in a different voice`
          : "Every rendered segment matches its current text and voice"
        : "Not checked yet",
      Boolean(audit && audit.staleSegments.length === 0 && audit.mismatchedVoiceSegments.length === 0)],
    ["Export readiness",
      outstanding ? `${outstanding} segment(s) must be resolved before packaging` : "Ready to assemble a package",
      outstanding === 0 && totalSegments > 0],
  ];

  const passed = checks.filter(([, , ok]) => ok).length;

  return <div className="flex min-h-0 flex-1 flex-col"><PageHeader eyebrow="05 · REVIEW" title="Give it a final listen." description="A visible pre-flight, computed from the stored audio rather than from a progress counter." /><div className="grid flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_330px] md:p-9"><section className="rounded-[24px] border border-[#dfe5de] bg-[#fffefa] p-5"><div className="mb-5 flex items-center justify-between"><div><h3 className="font-bold">Pre-flight validation</h3><p className="mt-1 text-sm text-[#7a8789]">Every stage is checked against what is actually stored.</p></div><span className="rounded-full bg-[#e8f3ef] px-3 py-1 text-xs font-bold text-[#3d796f]">{passed} of {checks.length} complete</span></div>{checks.map(([name, detail, ok]) => <div key={name} className="flex items-start gap-4 border-t border-[#edf0eb] py-4"><span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${ok ? "bg-[#e3f1eb] text-[#3e826f]" : "bg-[#fff0dc] text-[#af7b2e]"}`}>{ok ? <Check size={14} /> : <AlertCircle size={14} />}</span><div className="min-w-0 flex-1"><strong className="block text-sm">{name}</strong><span className="mt-1 block text-xs leading-5 text-[#788689]">{detail}</span></div></div>)}<p className="mt-4 border-t border-[#edf0eb] pt-4 text-xs text-[#8a9492]">Readiness score: {readiness.completed} of {readiness.total}.</p></section><aside className="rounded-[24px] bg-[#294f50] p-6 text-white"><span className="mono text-[10px] tracking-[.13em] text-[#c1d9d4]">REVIEW NOTE</span><h3 className="serif mt-3 text-3xl leading-tight">One final pass makes it yours.</h3><p className="mt-4 text-sm leading-6 text-[#d2e2df]">{outstanding ? `${outstanding} segment(s) still need attention. Resolving them re-renders only those, not the whole book.` : "Everything matches. Listen through, then assemble your package."}</p>{outstanding > 0 && <button onClick={onOpenGeneration} className="mt-6 rounded-xl bg-white/12 px-4 py-3 text-xs font-bold">Open unresolved narration</button>}</aside></div></div>;
}

