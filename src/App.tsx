import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
  ArrowDown,
  Camera,
  Check,
  ChevronDown,
  CircleStop,
  Copy,
  Download,
  ExternalLink,
  Globe2,
  ImagePlus,
  Maximize2,
  Menu,
  MessageSquarePlus,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Trash2,
  UserRound,
  X,
  Zap
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  answerNth,
  type AnswerPhase,
  type Attachment,
  checkOllamaHealth,
  classifyNthError,
  MODEL_BY_MODE,
  needsWeb,
  type NthMode,
  type OllamaHealth,
  pingSearXNG,
  type Route,
  type SearchSource
} from "./lib/nth";
import {
  createConversation,
  groupConversations,
  loadConversations,
  relativeTime,
  rebuildTopicState,
  saveConversations,
  titleForMessage,
  type Conversation,
  type UiMessage
} from "./lib/history";
import { deriveTopicState, isConversationHistoryIntent } from "./lib/context";
import { rebuildConversationMemory } from "./lib/memory";
import {
  checkNthUpdate,
  installNthUpdate,
  type NthUpdateInfo
} from "./lib/updater";
import { logDiagnostic } from "./lib/diagnostics";

const SETTINGS_KEY = "nth.settings.v2";
const MODE_KEY = "nth.mode.v1";
const modes: NthMode[] = ["RUN", "JOG", "WALK"];

type SettingsState = {
  searxngUrl: string;
  profileAvatar: string;
};

const defaultSettings: SettingsState = {
  searxngUrl: "http://127.0.0.1:8888",
  profileAvatar: ""
};

type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "error";
type GlyphState = "idle" | "thinking" | "generating" | "web" | "vision" | "error" | "offline";
type OperationState = "idle" | AnswerPhase | "cancelled" | "error";

const ACTIVE_OPERATIONS = new Set<OperationState>([
  "resolving_context",
  "searching",
  "verifying",
  "generating",
  "vision"
]);
const CHAT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_CHAT_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_CHAT_IMAGE_PIXELS = 32_000_000;

const NTH_GLYPH_DOTS = [
  "100011111110001",
  "110010010010001",
  "101010010011111",
  "100110010010001",
  "100010010010001"
].flatMap((row, y) => [...row].flatMap((value, x) => {
  if (value !== "1") return [];
  const angle = Math.atan2(y - 2, x - 7) + Math.PI;
  const sweep = Math.round((angle / (Math.PI * 2)) * 11) % 12;
  const wave = x < 5 ? 0 : x < 10 ? 1 : 2;
  const focus = Math.min(6, Math.round(Math.hypot((x - 7) * 0.55, y - 2)));
  return [{
    x,
    y,
    style: {
      "--thinking-delay": `${(11 - sweep) * -75}ms`,
      "--wave-delay": `${wave * -233}ms`,
      "--scan-delay": `${(14 - x) * -59}ms`,
      "--focus-delay": `${focus * 45}ms`
    } as CSSProperties
  }];
}));

function loadSettings(): SettingsState {
  try {
    const saved = { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") } as SettingsState;
    return {
      ...saved,
      searxngUrl: typeof saved.searxngUrl === "string" ? saved.searxngUrl : defaultSettings.searxngUrl,
      profileAvatar: typeof saved.profileAvatar === "string" && saved.profileAvatar.startsWith("data:image/")
        ? saved.profileAvatar
        : ""
    };
  } catch {
    return defaultSettings;
  }
}

function loadMode(): NthMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return modes.includes(saved as NthMode) ? saved as NthMode : "RUN";
  } catch { return "RUN"; }
}

function dataUrlFor(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function avatarDataUrlFor(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 15 * 1024 * 1024) throw new Error("Choose an image smaller than 15 MB.");

  const source = await dataUrlFor(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("NTH could not read that image."));
    element.src = source;
  });

  const size = Math.min(image.naturalWidth, image.naturalHeight);
  if (!size) throw new Error("NTH could not read that image.");

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("NTH could not prepare that image.");

  context.drawImage(
    image,
    Math.floor((image.naturalWidth - size) / 2),
    Math.floor((image.naturalHeight - size) / 2),
    size,
    size,
    0,
    0,
    256,
    256
  );

  return canvas.toDataURL("image/webp", 0.88);
}

async function chatAttachmentFor(file: File): Promise<Attachment> {
  if (!CHAT_IMAGE_TYPES.has(file.type)) {
    throw new Error("Use a PNG, JPEG, WebP, or GIF image.");
  }
  if (!file.size || file.size > MAX_CHAT_IMAGE_BYTES) {
    throw new Error("Use an image smaller than 12 MB.");
  }

  const dataUrl = await dataUrlFor(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    const timer = window.setTimeout(() => reject(new Error("Image validation timed out.")), 8_000);
    element.onload = () => {
      window.clearTimeout(timer);
      resolve(element);
    };
    element.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("That image is corrupt or unsupported."));
    };
    element.src = dataUrl;
  });
  const pixels = image.naturalWidth * image.naturalHeight;
  if (!pixels || pixels > MAX_CHAT_IMAGE_PIXELS || image.naturalWidth > 8192 || image.naturalHeight > 8192) {
    throw new Error("That image is too large to process safely.");
  }

  return {
    id: crypto.randomUUID(),
    name: file.name || "pasted-image.png",
    mime: file.type,
    dataUrl
  };
}

function predictedRoute(text: string, hasVision: boolean, forceWeb: boolean, context: UiMessage[] = []): Route {
  const useWeb = !isConversationHistoryIntent(text) && (forceWeb || needsWeb(text, context.filter(message => !message.error)));
  if (hasVision && useWeb) return "vision+web";
  if (hasVision) return "vision";
  if (useWeb) return "web";
  return "local";
}

function routeLabels(route?: Route, contextReused = false): string[] {
  if (contextReused) return ["CONTEXT"];
  if (!route || route === "local") return ["LOCAL"];
  if (route === "vision+web") return ["VISION", "WEB"];
  return [route.toUpperCase()];
}

function DotLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`dot-logo ${compact ? "compact" : ""}`} aria-label="NTH">
      <span>NTH</span><b>.</b>
    </div>
  );
}

const NthGlyphAvatar = memo(function NthGlyphAvatar({ state }: { state: GlyphState }) {
  const label = state === "web" ? "web search" : state;
  return (
    <svg
      className={`nth-glyph state-${state}`}
      viewBox="0 0 34 12"
      role="img"
      aria-label={`NTH assistant — ${label}`}
    >
      <title>{`NTH assistant — ${label}`}</title>
      <g className="nth-glyph-matrix">
        {NTH_GLYPH_DOTS.map(({ x, y, style }) => (
          <circle
            className="nth-glyph-dot"
            cx={2 + x * 2}
            cy={2 + y * 2}
            r="0.72"
            key={`${x}-${y}`}
            style={style}
          />
        ))}
      </g>
      <circle className="nth-glyph-accent" cx="32.1" cy="9.8" r="0.72" />
    </svg>
  );
});

function ProfileAvatar({ source, compact = false }: { source: string; compact?: boolean }) {
  return (
    <span className={`profile-avatar ${compact ? "compact" : ""} ${source ? "has-image" : ""}`}>
      {source ? <img src={source} alt="Your profile" /> : <UserRound size={compact ? 14 : 22} />}
    </span>
  );
}

function glyphStateFor(message: UiMessage, phase: AnswerPhase | null, ready: boolean): GlyphState {
  if (message.error) return ready ? "error" : "offline";
  if (!ready) return "offline";
  if (!message.streaming) return "idle";
  if (phase === "searching") return "web";
  if (phase === "vision") return "vision";
  if (message.content) return "generating";
  return "thinking";
}

function ModeSelector({ mode, onChange }: { mode: NthMode; onChange: (mode: NthMode) => void }) {
  return (
    <div className="mode-selector" aria-label="Model mode">
      {modes.map(item => (
        <button
          key={item}
          className={mode === item ? "active" : ""}
          onClick={() => onChange(item)}
          aria-pressed={mode === item}
        >
          {item}
          {item === "RUN" && <span />}
        </button>
      ))}
    </div>
  );
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState(() => conversations[0]?.id || "");
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<NthMode>(loadMode);
  const [settings, setSettings] = useState<SettingsState>(loadSettings);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [ollamaHealth, setOllamaHealth] = useState<OllamaHealth | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [searxngOnline, setSearxngOnline] = useState<boolean | null>(null);
  const [checkingWebStatus, setCheckingWebStatus] = useState(false);
  const [operation, setOperation] = useState<OperationState>("idle");
  const [webForced, setWebForced] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState("");
  const [storageNotice, setStorageNotice] = useState("");
  const [appVersion, setAppVersion] = useState("0.5.9");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateInfo, setUpdateInfo] = useState<NthUpdateInfo | null>(null);
  const [updateMessage, setUpdateMessage] = useState("NTH checks the signed release channel automatically.");
  const [updatePercent, setUpdatePercent] = useState<number | null>(null);
  const [avatarNotice, setAvatarNotice] = useState("");
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatRef = useRef<HTMLElement | null>(null);
  const generationRef = useRef<AbortController | null>(null);
  const submissionRef = useRef(false);
  const lastSubmissionAtRef = useRef(0);
  const updateBusyRef = useRef(false);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const persistenceRef = useRef({ at: 0, structure: "" });
  const healthRef = useRef<{ health: OllamaHealth; checkedAt: number } | null>(null);
  const dragDepthRef = useRef(0);

  const activeConversation = useMemo(
    () => conversations.find(conversation => conversation.id === activeId) || conversations[0],
    [activeId, conversations]
  );
  const messages = activeConversation?.messages || [];
  const groups = useMemo(() => groupConversations(conversations), [conversations]);
  const autoWeb = needsWeb(input, messages.filter(message => !message.error));
  const ready = Boolean(ollamaHealth?.reachable && ollamaHealth.modelInstalled);
  const busy = ACTIVE_OPERATIONS.has(operation);
  const phase = busy ? operation as AnswerPhase : null;
  const canSend = !busy && updateStatus !== "downloading" && Boolean(input.trim() || attachments.length);

  async function chooseAvatar(file?: File) {
    if (!file) return;
    setAvatarNotice("Preparing image…");
    try {
      const profileAvatar = await avatarDataUrlFor(file);
      setSettings(current => ({ ...current, profileAvatar }));
      setAvatarNotice("Saved locally.");
    } catch (error) {
      setAvatarNotice(error instanceof Error ? error.message : "NTH could not use that image.");
    }
  }

  useEffect(() => {
    if (!activeConversation && conversations[0]) setActiveId(conversations[0].id);
  }, [activeConversation, conversations]);

  useEffect(() => {
    const structure = conversations.map(chat => `${chat.id}:${chat.messages.length}:${chat.messages.some(message => message.streaming)}`).join("|");
    const elapsed = Date.now() - persistenceRef.current.at;
    const persist = () => {
      persistChats();
      persistenceRef.current = { at: Date.now(), structure };
    };
    // Save new turns immediately; throttle (don't debounce) continuous tokens.
    if (structure !== persistenceRef.current.structure || elapsed >= 500) {
      persist();
      return;
    }
    const timer = window.setTimeout(persist, 500 - elapsed);
    return () => window.clearTimeout(timer);
  }, [conversations]);

  function persistChats(): boolean {
    const saved = saveConversations(conversationsRef.current);
    setStorageNotice(saved ? "" : "Chats could not be saved. Keep NTH open and check local storage.");
    if (!saved) logDiagnostic({ operation: "save_chats", serviceFailure: "persistence", errorClass: "StorageWriteFailed" });
    return saved;
  }

  useEffect(() => {
    const flush = () => { saveConversations(conversationsRef.current); };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      logDiagnostic({ operation: "save_settings", serviceFailure: "persistence", errorClass: "StorageWriteFailed" });
    }
  }, [settings]);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      logDiagnostic({ operation: "save_mode", serviceFailure: "persistence", errorClass: "StorageWriteFailed" });
    }
  }, [mode]);

  useEffect(() => {
    const disableBrowserMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("contextmenu", disableBrowserMenu);
    return () => window.removeEventListener("contextmenu", disableBrowserMenu);
  }, []);

  useEffect(() => {
    const inTauri = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (!inTauri) return;
    void getVersion().then(setAppVersion).catch(() => undefined);
    void refreshUpdate();
    // The signed release channel is checked once per launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshOllamaStatus(): Promise<OllamaHealth> {
    setCheckingStatus(true);
    const started = performance.now();
    let health: OllamaHealth;
    try {
      health = await checkOllamaHealth(MODEL_BY_MODE[mode]);
    } catch {
      health = { reachable: false, modelInstalled: false, expectedModel: MODEL_BY_MODE[mode], installedModels: [] };
    }
    healthRef.current = { health, checkedAt: Date.now() };
    setOllamaHealth(health);
    setCheckingStatus(false);
    logDiagnostic({
      operation: "health_ollama",
      durationMs: Math.round(performance.now() - started),
      serviceFailure: health.reachable ? health.modelInstalled ? undefined : "model" : "ollama",
      errorClass: health.reachable ? health.modelInstalled ? undefined : "MissingModel" : "ServiceUnavailable"
    });
    return health;
  }

  async function ensureOllamaReady(force = false): Promise<OllamaHealth> {
    const cached = healthRef.current;
    const health = !force && cached && Date.now() - cached.checkedAt < 30_000
      ? cached.health
      : await refreshOllamaStatus();
    if (!health.reachable) throw new Error("Ollama unavailable.");
    if (!health.modelInstalled) throw new Error(`Model missing: ${health.expectedModel}`);
    return health;
  }

  async function refreshSearXNGStatus() {
    if (checkingWebStatus) return;
    setCheckingWebStatus(true);
    const started = performance.now();
    const online = await pingSearXNG(settings.searxngUrl).catch(() => false);
    setSearxngOnline(online);
    setCheckingWebStatus(false);
    logDiagnostic({
      operation: "health_searxng",
      durationMs: Math.round(performance.now() - started),
      serviceFailure: online ? undefined : "searxng",
      errorClass: online ? undefined : "ServiceUnavailable"
    });
  }

  async function refreshUpdate() {
    if (updateBusyRef.current) return;
    const inTauri = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (!inTauri) {
      setUpdateStatus("error");
      setUpdateMessage("Update checks are available in the installed desktop app.");
      return;
    }

    updateBusyRef.current = true;
    setUpdateStatus("checking");
    setUpdateMessage("Checking the signed release channel…");
    try {
      const available = await checkNthUpdate();
      setUpdateInfo(available);
      if (available) {
        setUpdateStatus("available");
        setUpdateMessage(`NTH ${available.version} is ready to install.`);
      } else {
        setUpdateStatus("current");
        setUpdateMessage(`NTH ${appVersion} is up to date.`);
      }
    } catch (error) {
      setUpdateStatus("error");
      setUpdateMessage("The signed release channel could not be reached. NTH is still usable; try again shortly.");
      logDiagnostic({ operation: "check_update", serviceFailure: "updater", errorClass: error instanceof Error ? error.name : "UpdateError" });
    } finally {
      updateBusyRef.current = false;
    }
  }

  async function applyUpdate() {
    if (!updateInfo || updateBusyRef.current || busy || submissionRef.current) return;
    if (!persistChats()) {
      setUpdateMessage("Save recovery is needed before updating. Your current app remains open.");
      return;
    }
    updateBusyRef.current = true;
    setUpdateStatus("downloading");
    setUpdatePercent(0);
    setUpdateMessage(`Downloading NTH ${updateInfo.version}…`);

    let installed = false;
    try {
      await installNthUpdate(progress => {
        setUpdatePercent(progress.percent ?? null);
        setUpdateMessage(progress.finished
          ? "Download complete. Verifying and installing…"
          : progress.percent === undefined
            ? "Downloading and verifying the signed update…"
            : `Downloading update… ${progress.percent}%`);
      });
      installed = true;
      await relaunch();
    } catch (error) {
      setUpdateStatus("error");
      setUpdatePercent(null);
      const raw = error instanceof Error ? error.message : String(error);
      setUpdateMessage(installed
        ? "Update installed. Close and reopen NTH to finish."
        : /signature/i.test(raw)
        ? "The update signature could not be verified, so NTH refused to install it."
        : "The update could not finish. NTH is still usable; try checking again.");
      logDiagnostic({ operation: "install_update", serviceFailure: "updater", errorClass: error instanceof Error ? error.name : "UpdateError" });
    } finally {
      updateBusyRef.current = false;
    }
  }

  useEffect(() => {
    let alive = true;
    healthRef.current = null;
    const check = async () => {
      if (!alive || submissionRef.current) return;
      await refreshOllamaStatus();
    };
    void check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  // Health is cached and checked at a low cadence; requests force a check after failures.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (settingsOpen && searxngOnline === null) void refreshSearXNGStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  useEffect(() => {
    setSearxngOnline(null);
  }, [settings.searxngUrl]);

  useEffect(() => {
    const inTauri = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (!inTauri) return;
    const appWindow = getCurrentWindow();
    void appWindow.isMaximized().then(setMaximized).catch(() => undefined);
    const unlisten = appWindow.onResized(async () => {
      setMaximized(await appWindow.isMaximized());
    });
    return () => {
      void unlisten.then(dispose => dispose());
    };
  }, []);

  useEffect(() => {
    const onPaste = async (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith("image/"));
      if (!files.length) return;
      event.preventDefault();
      await addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [attachments.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        createNewChat();
      }
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setClearConfirm(false);
        setMobileSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, activeConversation?.id, activeConversation?.messages.length]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [input]);

  useEffect(() => {
    const scroller = chatRef.current;
    if (!scroller || !atBottom) return;
    const frame = window.requestAnimationFrame(() => {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: busy ? "auto" : "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, busy, phase, atBottom]);

  function updateConversation(id: string, update: (conversation: Conversation) => Conversation) {
    setConversations(current => current.map(conversation => conversation.id === id ? update(conversation) : conversation));
  }

  async function addFiles(files: File[]) {
    if (!files.length) return;
    const images = files.filter(file => CHAT_IMAGE_TYPES.has(file.type));
    if (!images.length) {
      setComposerNotice("Use a PNG, JPEG, WebP, or GIF image.");
      window.setTimeout(() => setComposerNotice(""), 2200);
      return;
    }

    const room = Math.max(0, 4 - attachments.length);
    if (!room) {
      setComposerNotice("You can attach up to four images.");
      window.setTimeout(() => setComposerNotice(""), 2200);
      return;
    }

    const settled = await Promise.allSettled(images.slice(0, room).map(chatAttachmentFor));
    const next = settled.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const failed = settled.find(result => result.status === "rejected");
    if (failed?.status === "rejected") {
      const message = failed.reason instanceof Error ? failed.reason.message : "NTH could not read that image.";
      setComposerNotice(message);
      window.setTimeout(() => setComposerNotice(""), 3200);
      logDiagnostic({ operation: "validate_vision", serviceFailure: "vision", errorClass: "InvalidImage" });
    }
    setAttachments(current => [...current, ...next].slice(0, 4));
    textareaRef.current?.focus();
  }

  function createNewChat() {
    if (busy) return;
    if (activeConversation?.messages.length === 0) {
      setInput("");
      setAttachments([]);
      textareaRef.current?.focus();
      setMobileSidebarOpen(false);
      return;
    }
    const conversation = createConversation();
    setConversations(current => [conversation, ...current]);
    setActiveId(conversation.id);
    setInput("");
    setAttachments([]);
    setWebForced(false);
    setMobileSidebarOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function selectConversation(id: string) {
    if (busy) return;
    setActiveId(id);
    setMobileSidebarOpen(false);
    setInput("");
    setAttachments([]);
  }

  function deleteConversation(id: string) {
    if (busy && id === activeId) return;
    setConversations(current => {
      const remaining = current.filter(conversation => conversation.id !== id);
      if (remaining.length) {
        if (id === activeId) setActiveId(remaining[0].id);
        return remaining;
      }
      const replacement = createConversation();
      setActiveId(replacement.id);
      return [replacement];
    });
  }

  function clearHistory() {
    if (busy) return;
    const replacement = createConversation();
    if (!saveConversations([replacement], true)) {
      setStorageNotice("Chat history could not be cleared. Check local storage and try again.");
      return;
    }
    setConversations([replacement]);
    setActiveId(replacement.id);
    setInput("");
    setAttachments([]);
    setClearConfirm(false);
    setSettingsOpen(false);
  }

  async function executeRequest({
    conversationId,
    userMessage,
    assistantId,
    requestMessages,
    requestTopicState,
    requestMemory,
    forceWeb,
    retryCount
  }: {
    conversationId: string;
    userMessage: UiMessage;
    assistantId: string;
    requestMessages: UiMessage[];
    requestTopicState: NonNullable<Conversation["context"]>;
    requestMemory: NonNullable<Conversation["memory"]>;
    forceWeb: boolean;
    retryCount: number;
  }) {
    const operationId = crypto.randomUUID();
    const controller = new AbortController();
    const started = performance.now();
    const progress: { phase: AnswerPhase } = { phase: "resolving_context" };
    const predicted = predictedRoute(userMessage.content, Boolean(userMessage.attachments?.length), forceWeb, requestMessages.slice(0, -1));
    generationRef.current = controller;
    setOperation("resolving_context");
    setAtBottom(true);

    try {
      await ensureOllamaReady(retryCount > 0);
      const result = await answerNth({
        operationId,
        messages: requestMessages
          .filter(message => !message.error)
          .map(({ role, content, attachments: images, route: messageRoute, sources, searchQuery, contextReused, createdAt }) => ({
            role,
            content,
            attachments: images,
            route: messageRoute,
            sources,
            searchQuery,
            contextReused,
            createdAt
          })),
        mode,
        forceWeb,
        web: { searxngUrl: settings.searxngUrl },
        topicState: requestTopicState,
        memory: requestMemory,
        signal: controller.signal,
        onPhase: nextPhase => {
          progress.phase = nextPhase;
          setOperation(nextPhase);
        },
        onToken: token => {
          updateConversation(conversationId, conversation => ({
            ...conversation,
            updatedAt: Date.now(),
            messages: conversation.messages.map(message =>
              message.id === assistantId ? { ...message, content: message.content + token } : message
            )
          }));
        }
      });

      updateConversation(conversationId, conversation => {
        const nextMessages = conversation.messages.map(message =>
          message.id === assistantId
            ? {
                ...message,
                content: result.content,
                route: result.route,
                sources: result.sources,
                searchQuery: result.searchQuery,
                contextReused: result.contextReused,
                streaming: false,
                error: false,
                failure: undefined
              }
            : message
        );
        const replyIndex = nextMessages.findIndex(message => message.id === assistantId);
        const hasLaterTurn = nextMessages.slice(replyIndex + 1).some(message => message.role === "user");
        const context = hasLaterTurn ? rebuildTopicState(nextMessages) : result.topicState;
        return {
          ...conversation,
          context,
          memory: rebuildConversationMemory(nextMessages, context, conversation.memory),
          updatedAt: Date.now(),
          messages: nextMessages
        };
      });
      setOperation("idle");
      logDiagnostic({
        operation: "answer",
        route: result.route,
        durationMs: Math.round(performance.now() - started),
        retryCount
      });
      if (import.meta.env.DEV) {
        (window as Window & { __NTH_CONTEXT_DEBUG__?: unknown }).__NTH_CONTEXT_DEBUG__ = result.diagnostics;
      }
    } catch (error) {
      const failure = classifyNthError(controller.signal.aborted ? new DOMException("Operation cancelled", "AbortError") : error, MODEL_BY_MODE[mode], Boolean(userMessage.attachments?.length));
      updateConversation(conversationId, conversation => ({
        ...conversation,
        updatedAt: Date.now(),
        messages: conversation.messages.map(message => {
          if (message.id !== assistantId) return message;
          const partial = message.content.trim();
          const content = failure.kind === "cancelled" && partial
            ? `${partial}\n\nResponse stopped. Retry?`
            : failure.message;
          return {
            ...message,
            content,
            streaming: false,
            error: true,
            failure: {
              kind: failure.kind,
              userMessageId: userMessage.id,
              forceWeb,
              retryCount
            }
          };
        })
      }));
      setOperation(failure.kind === "cancelled" ? "cancelled" : "error");
      const serviceFailure = failure.kind === "ollama" || failure.kind === "model" || failure.kind === "searxng" || failure.kind === "vision"
        ? failure.kind
        : failure.timeout ? progress.phase === "searching" ? "searxng" : progress.phase === "vision" ? "vision" : "ollama" : undefined;
      logDiagnostic({
        operation: progress.phase,
        route: predicted,
        durationMs: Math.round(performance.now() - started),
        timeout: failure.timeout,
        cancelled: failure.kind === "cancelled",
        serviceFailure,
        retryCount,
        errorClass: failure.kind
      });
      if (failure.kind === "ollama" || failure.kind === "model") void refreshOllamaStatus();
      if (failure.kind === "searxng") setSearxngOnline(false);
    } finally {
      if (generationRef.current === controller) generationRef.current = null;
      submissionRef.current = false;
    }
  }

  async function send() {
    if (!canSend || !activeConversation || submissionRef.current || Date.now() - lastSubmissionAtRef.current < 400) return;
    lastSubmissionAtRef.current = Date.now();
    submissionRef.current = true;

    const conversationId = activeConversation.id;
    const text = input.trim() || "Describe this image.";
    const sentAttachments = attachments;
    const forceWeb = webForced;
    const userMessage: UiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      attachments: sentAttachments,
      createdAt: Date.now()
    };
    const assistantId = crypto.randomUUID();
    const assistantMessage: UiMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      route: predictedRoute(text, Boolean(sentAttachments.length), forceWeb, messages),
      createdAt: Date.now(),
      streaming: true
    };
    const requestMessages = [...messages.filter(message => !message.error), userMessage];
    const requestTopicState = deriveTopicState(requestMessages, activeConversation.context);
    const requestMemory = rebuildConversationMemory(requestMessages, requestTopicState, activeConversation.memory);
    const hasPriorUserMessage = messages.some(message => message.role === "user");

    updateConversation(conversationId, conversation => ({
      ...conversation,
      context: requestTopicState,
      memory: requestMemory,
      title: hasPriorUserMessage ? conversation.title : titleForMessage(text, Boolean(sentAttachments.length)),
      updatedAt: Date.now(),
      messages: [...conversation.messages, userMessage, assistantMessage]
    }));
    setInput("");
    setAttachments([]);
    setWebForced(false);
    await executeRequest({
      conversationId,
      userMessage,
      assistantId,
      requestMessages,
      requestTopicState,
      requestMemory,
      forceWeb,
      retryCount: 0
    });
  }

  async function retryMessage(message: UiMessage) {
    if (busy || updateStatus === "downloading" || submissionRef.current || !activeConversation || !message.failure?.userMessageId || Date.now() - lastSubmissionAtRef.current < 400) return;
    const assistantIndex = activeConversation.messages.findIndex(item => item.id === message.id);
    const userIndex = activeConversation.messages.findIndex(item => item.id === message.failure?.userMessageId);
    if (assistantIndex < 0 || userIndex < 0 || userIndex >= assistantIndex) return;
    const userMessage = activeConversation.messages[userIndex];
    const requestMessages = activeConversation.messages
      .slice(0, assistantIndex)
      .filter(item => !item.error);
    const requestTopicState = rebuildTopicState(requestMessages);
    const requestMemory = rebuildConversationMemory(requestMessages, requestTopicState);
    const retryCount = message.failure.retryCount + 1;
    lastSubmissionAtRef.current = Date.now();
    submissionRef.current = true;
    updateConversation(activeConversation.id, conversation => ({
      ...conversation,
      updatedAt: Date.now(),
      messages: conversation.messages.map(item => item.id === message.id ? {
        ...item,
        content: "",
        streaming: true,
        error: false,
        failure: undefined
      } : item)
    }));
    await executeRequest({
      conversationId: activeConversation.id,
      userMessage,
      assistantId: message.id,
      requestMessages,
      requestTopicState,
      requestMemory,
      forceWeb: message.failure.forceWeb,
      retryCount
    });
  }

  function stopGeneration() {
    generationRef.current?.abort();
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) void send();
    }
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (event.dataTransfer.types.includes("Files")) setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setDragging(false);
    }
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    await addFiles(Array.from(event.dataTransfer.files));
  }

  function toggleSidebar() {
    if (window.matchMedia("(max-width: 860px)").matches) {
      setMobileSidebarOpen(current => !current);
    } else {
      setSidebarCollapsed(current => !current);
    }
  }

  async function toggleMaximize() {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.toggleMaximize();
      setMaximized(await appWindow.isMaximized());
    } catch {
      // Browser preview has no native window.
    }
  }

  async function openSource(url: string) {
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  async function copyMessage(message: UiMessage) {
    await navigator.clipboard.writeText(message.content);
    setCopiedId(message.id);
    window.setTimeout(() => setCopiedId(null), 1400);
  }

  async function copyModelInstallCommand() {
    await navigator.clipboard.writeText(`ollama pull ${MODEL_BY_MODE[mode]}`);
    setComposerNotice("Model install command copied.");
    window.setTimeout(() => setComposerNotice(""), 2200);
  }

  const phaseLabel = phase === "searching"
    ? "Searching web…"
    : phase === "verifying"
      ? "Checking sources…"
      : phase === "vision"
        ? "Processing image…"
      : phase === "generating"
        ? "Answering…"
        : "Resolving context…";

  return (
    <div
      className={`app ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={event => event.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="titlebar" data-tauri-drag-region onDoubleClick={toggleMaximize}>
        <div className="titlebar-brand" data-tauri-drag-region>
          <DotLogo compact />
          <span className={`local-state ${ready ? "online" : ""}`}>
            <i /> {ready ? "LOCAL" : ollamaHealth?.reachable ? "MODEL MISSING" : "LOCAL UNAVAILABLE"}
          </span>
          <button className="titlebar-sidebar-toggle" onClick={toggleSidebar} aria-label="Toggle sidebar">
            {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        </div>

        <div className="titlebar-context" data-tauri-drag-region>
          <span>{activeConversation?.messages.length ? activeConversation.title : "New chat"}</span>
        </div>

        <div className="window-controls">
          <button onClick={() => void getCurrentWindow().minimize().catch(() => undefined)} aria-label="Minimize">
            <Minus size={15} />
          </button>
          <button onClick={toggleMaximize} aria-label={maximized ? "Restore" : "Maximize"}>
            {maximized ? <Square className="restore-icon" size={13} /> : <Maximize2 size={13} />}
          </button>
          <button className="close" onClick={() => void getCurrentWindow().close().catch(() => undefined)} aria-label="Close">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="app-body">
        {mobileSidebarOpen && <button className="mobile-sidebar-shade" onClick={() => setMobileSidebarOpen(false)} aria-label="Close sidebar" />}

        <aside className={`sidebar ${mobileSidebarOpen ? "mobile-open" : ""}`}>
          <div className="sidebar-top">
            <button className="new-chat-button" onClick={createNewChat} disabled={busy}>
              <MessageSquarePlus size={16} />
              <span>New chat</span>
              <kbd>Ctrl N</kbd>
            </button>
          </div>

          <nav className="history" aria-label="Chat history">
            {groups.map(group => (
              <section className="history-group" key={group.label}>
                <h2>{group.label}</h2>
                {group.conversations.map(conversation => (
                  <div
                    className={`history-row ${conversation.id === activeConversation?.id ? "active" : ""} ${busy ? "locked" : ""}`}
                    key={conversation.id}
                  >
                    <button className="history-select" onClick={() => selectConversation(conversation.id)}>
                      <span>{conversation.title}</span>
                      <small>{relativeTime(conversation.updatedAt)}</small>
                    </button>
                    <button
                      className="history-delete"
                      onClick={() => deleteConversation(conversation.id)}
                      aria-label={`Delete ${conversation.title}`}
                      title="Delete chat"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </section>
            ))}
          </nav>

          <div className="sidebar-bottom">
            <button className={updateInfo ? "has-update" : ""} onClick={() => setSettingsOpen(true)}>
              <Settings2 size={15} />
              <span>Settings</span>
              {updateInfo ? <i>UPDATE</i> : null}
            </button>
            <button onClick={() => { setClearConfirm(true); setSettingsOpen(true); }} disabled={busy}>
              <Trash2 size={15} />
              <span>Clear history</span>
            </button>
          </div>
        </aside>

        <main className="workspace">
          <div className="workspace-header">
            <button className="mobile-menu" onClick={toggleSidebar} aria-label="Open sidebar"><Menu size={17} /></button>
            <div className="workspace-spacer" data-tauri-drag-region />
            <ModeSelector mode={mode} onChange={setMode} />
          </div>

          <section
            className="chat-scroll"
            ref={chatRef}
            onScroll={event => {
              const element = event.currentTarget;
              setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 90);
            }}
          >
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="dot-orb" aria-hidden="true"><div /></div>
                <DotLogo />
                <h1>What do you need?</h1>
                <p>Private local intelligence, with web and vision when you ask for it.</p>
                <div className="capability-row">
                  <span><Zap size={12} /> LOCAL</span>
                  <span><Globe2 size={12} /> WEB</span>
                  <span><ImagePlus size={12} /> VISION</span>
                </div>
              </div>
            ) : (
              <div className="message-list">
                {messages.map(message => (
                  <article className={`message ${message.role} ${message.error ? "error" : ""}`} key={message.id}>
                    <div className={`message-identity ${message.role === "assistant" ? "assistant-glyph-badge" : ""}`}>
                      {message.role === "assistant" ? <NthGlyphAvatar state={glyphStateFor(message, phase, ready)} /> : settings.profileAvatar
                        ? <img className="user-avatar" src={settings.profileAvatar} alt="Your profile" />
                        : <span className="you-mark">YOU</span>}
                    </div>
                    <div className="message-content">
                      <div className="message-meta">
                        <div className="message-author">
                          <span>{message.role === "assistant" ? "NTH." : "YOU"}</span>
                          {message.role === "assistant" && message.streaming ? (
                            <small>{phaseLabel}</small>
                          ) : null}
                        </div>
                        <div className="route-labels">
                          {message.role === "assistant" && !message.streaming && routeLabels(message.route, message.contextReused).map(label => (
                            <em className={label.toLowerCase()} key={label}>{label}</em>
                          ))}
                        </div>
                      </div>

                      {message.attachments?.length ? (
                        <div className="message-images">
                          {message.attachments.map(attachment => (
                            <img src={attachment.dataUrl} alt={attachment.name} key={attachment.id} />
                          ))}
                        </div>
                      ) : null}

                      <div className="message-text">
                        {message.content || (message.streaming && <span className="stream-wait"><i /><i /><i /> {phaseLabel}</span>)}
                        {message.streaming && message.content && <span className="stream-cursor" />}
                      </div>

                      {message.sources?.length ? (
                        <SourceCards
                          sources={message.sources}
                          expanded={Boolean(expandedSources[message.id])}
                          onToggle={() => setExpandedSources(current => ({ ...current, [message.id]: !current[message.id] }))}
                          onOpen={openSource}
                        />
                      ) : null}

                      {message.role === "assistant" && message.content && !message.streaming && !message.error ? (
                        <div className="message-actions">
                          <button onClick={() => void copyMessage(message)}>
                            {copiedId === message.id ? <Check size={13} /> : <Copy size={13} />}
                            {copiedId === message.id ? "Copied" : "Copy"}
                          </button>
                        </div>
                      ) : null}
                      {message.role === "assistant" && message.error && message.failure?.userMessageId ? (
                        <div className="message-actions error-actions">
                          <button onClick={() => void retryMessage(message)} disabled={busy}>
                            <RefreshCw size={13} /> Retry
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {!atBottom && messages.length > 0 && (
            <button
              className="scroll-bottom"
              onClick={() => chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" })}
              aria-label="Scroll to latest message"
            >
              <ArrowDown size={16} />
              <span>LATEST</span>
            </button>
          )}

          <div className="composer-zone">
            {attachments.length > 0 && (
              <div className="attachment-tray">
                {attachments.map(attachment => (
                  <div className="attachment-preview" key={attachment.id}>
                    <img src={attachment.dataUrl} alt={attachment.name} />
                    <span>{attachment.name}</span>
                    <button onClick={() => setAttachments(current => current.filter(item => item.id !== attachment.id))} aria-label={`Remove ${attachment.name}`}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className={`composer ${busy ? "busy" : ""}`}>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={event => {
                  void addFiles(Array.from(event.target.files || []));
                  event.target.value = "";
                }}
              />
              <button className="attach-button" onClick={() => fileInputRef.current?.click()} disabled={busy} aria-label="Attach image">
                <Plus size={19} />
              </button>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={event => setInput(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder="Ask anything…"
                rows={1}
                disabled={busy}
              />
              <button
                className={`web-toggle ${webForced ? "active" : ""} ${!webForced && autoWeb ? "auto" : ""}`}
                onClick={() => setWebForced(current => !current)}
                disabled={busy}
                aria-pressed={webForced}
                title={webForced ? "Web search is on" : autoWeb ? "Web search will turn on automatically" : "Use web search"}
              >
                <Search size={14} />
                <span>{webForced ? "WEB ON" : autoWeb ? "AUTO WEB" : "WEB"}</span>
                <i />
              </button>
              {busy ? (
                <button className="send-button stop" onClick={stopGeneration} aria-label="Stop generation">
                  <CircleStop size={19} />
                </button>
              ) : (
                <button className="send-button" onClick={() => void send()} disabled={!canSend} aria-label="Send message">
                  <ArrowDown className="send-arrow" size={19} />
                </button>
              )}
            </div>
            <div className="composer-footer">
              <span className={composerNotice || storageNotice ? "notice" : ""}>{storageNotice || composerNotice || "ENTER TO SEND · SHIFT+ENTER FOR NEW LINE"}</span>
              <span>{mode} · GEMMA 4 12B Q4 · THINK OFF</span>
            </div>
          </div>
        </main>
      </div>

      {dragging && (
        <div className="drop-overlay">
          <div><ImagePlus size={22} /><strong>Drop images here</strong><span>Up to four attachments</span></div>
        </div>
      )}

      {settingsOpen && (
        <div className="settings-shade" onMouseDown={() => setSettingsOpen(false)}>
          <aside className="settings-panel" onMouseDown={event => event.stopPropagation()}>
            <header className="settings-header">
              <div><span>SETTINGS</span><h2>Keep it simple.</h2></div>
              <button onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={17} /></button>
            </header>

            <section className="settings-section">
              <h3>PROFILE</h3>
              <div className="profile-card">
                <ProfileAvatar source={settings.profileAvatar} />
                <div className="profile-card-copy">
                  <strong>Your avatar</strong>
                  <span>Stored locally on this device.</span>
                  {avatarNotice ? <small>{avatarNotice}</small> : null}
                </div>
                <div className="profile-actions">
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    hidden
                    onChange={event => {
                      void chooseAvatar(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                  <button onClick={() => avatarInputRef.current?.click()}>
                    <Camera size={13} />
                    <span>{settings.profileAvatar ? "CHANGE" : "ADD"}</span>
                  </button>
                  {settings.profileAvatar ? (
                    <button
                      className="remove-avatar"
                      onClick={() => {
                        setSettings(current => ({ ...current, profileAvatar: "" }));
                        setAvatarNotice("Avatar removed.");
                      }}
                      aria-label="Remove profile avatar"
                    >
                      <Trash2 size={13} />
                    </button>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h3>LOCAL ENGINE</h3>
              <div className="status-card">
                <div className={`status-pulse ${ready ? "online" : ""}`}><i /></div>
                <div>
                  <strong>Ollama</strong>
                  <span>{checkingStatus
                    ? "Checking…"
                    : ready
                      ? "Ready · active model installed"
                      : ollamaHealth?.reachable
                        ? "Connected · required model missing"
                        : "LOCAL unavailable · Ollama is not running"}</span>
                </div>
                <button onClick={() => void refreshOllamaStatus()} aria-label="Refresh Ollama status"><RefreshCw size={14} /></button>
              </div>
            </section>

            <section className="settings-section">
              <h3>APP UPDATE</h3>
              <div className={`update-card ${updateStatus}`}>
                <div>
                  <span>INSTALLED</span>
                  <strong>NTH {appVersion}</strong>
                  <small>{updateMessage}</small>
                </div>
                {updateInfo && updateStatus !== "error" ? (
                  <button onClick={() => void applyUpdate()} disabled={busy || updateStatus === "downloading"}>
                    {updateStatus === "downloading" ? <RefreshCw className="spin" size={14} /> : <Download size={14} />}
                    <span>{updateStatus === "downloading" ? (updatePercent === null ? "INSTALLING" : `${updatePercent}%`) : `INSTALL ${updateInfo.version}`}</span>
                  </button>
                ) : (
                  <button onClick={() => void refreshUpdate()} disabled={updateStatus === "checking"}>
                    <RefreshCw className={updateStatus === "checking" ? "spin" : ""} size={14} />
                    <span>CHECK</span>
                  </button>
                )}
                {updateStatus === "downloading" ? <div className="update-progress"><i style={{ width: `${updatePercent || 4}%` }} /></div> : null}
              </div>
              <p className="settings-note">Updates are checked automatically and signature-verified before installation.</p>
            </section>

            <section className="settings-section">
              <h3>WEB SEARCH</h3>
              <label className="settings-field">
                <span>SearXNG URL</span>
                <input
                  value={settings.searxngUrl}
                  onChange={event => setSettings(current => ({ ...current, searxngUrl: event.target.value }))}
                  spellCheck={false}
                  placeholder="http://127.0.0.1:8888"
                />
                <small>Used only when WEB is selected or current information is needed.</small>
              </label>
              <div className="service-inline">
                <span>{checkingWebStatus
                  ? "STATUS · CHECKING"
                  : searxngOnline === true
                    ? "STATUS · READY"
                    : searxngOnline === false
                      ? "STATUS · UNAVAILABLE"
                      : "STATUS · NOT CHECKED"}</span>
                <button onClick={() => void refreshSearXNGStatus()} disabled={checkingWebStatus}>
                  <RefreshCw className={checkingWebStatus ? "spin" : ""} size={12} />
                  {searxngOnline === false ? "RETRY" : "CHECK"}
                </button>
              </div>
            </section>

            <section className="settings-section">
              <h3>MODEL & MODE</h3>
              <div className="settings-mode"><ModeSelector mode={mode} onChange={setMode} /></div>
              <div className="model-card">
                <div><span>ACTIVE MODEL</span><strong>Gemma 4 12B Q4</strong></div>
                <code>{MODEL_BY_MODE[mode]}</code>
                {ollamaHealth?.reachable && !ollamaHealth.modelInstalled ? (
                  <button className="model-recovery" onClick={() => void copyModelInstallCommand()}>
                    <Copy size={12} /> COPY INSTALL COMMAND
                  </button>
                ) : null}
              </div>
              <div className="frozen-grid">
                <div><span>POLICY</span><strong>NTH v2</strong></div>
                <div><span>THINK</span><strong>FALSE</strong></div>
                <div><span>TEMP</span><strong>0</strong></div>
              </div>
              <p className="settings-note">RUN, JOG, and WALK currently use the same Q4 model. Their model IDs are mapped independently for later changes.</p>
            </section>

            <section className="settings-section danger-section">
              <h3>LOCAL DATA</h3>
              {!clearConfirm ? (
                <button className="clear-history-button" onClick={() => setClearConfirm(true)} disabled={busy}>
                  <Trash2 size={14} /><span>Clear chat history</span>
                </button>
              ) : (
                <div className="clear-confirmation">
                  <div><strong>Clear all conversations?</strong><span>This cannot be undone.</span></div>
                  <div><button onClick={() => setClearConfirm(false)}>Cancel</button><button className="confirm" onClick={clearHistory}>Clear all</button></div>
                </div>
              )}
            </section>

            <footer className="settings-footer"><DotLogo compact /><span>NTH · PRIVATE · LOCAL FIRST</span></footer>
          </aside>
        </div>
      )}
    </div>
  );
}

function SourceCards({
  sources,
  expanded,
  onToggle,
  onOpen
}: {
  sources: SearchSource[];
  expanded: boolean;
  onToggle: () => void;
  onOpen: (url: string) => Promise<void>;
}) {
  return (
    <section className={`source-section ${expanded ? "expanded" : ""}`}>
      <button className="source-toggle" onClick={onToggle} aria-expanded={expanded}>
        <Globe2 size={13} />
        <span>SOURCES <i>·</i> {sources.length} verified results</span>
        <ChevronDown size={13} />
      </button>
      <div className="source-collapse" aria-hidden={!expanded}>
        <div className="source-grid">
          {sources.slice(0, 10).map((source, index) => (
            <button key={source.url} onClick={() => void onOpen(source.url)} className="source-card">
              <span className="source-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="source-copy">
                <strong>{source.title}</strong>
                <small>{source.domain}{source.official ? <em>OFFICIAL</em> : null}</small>
              </span>
              <ExternalLink size={12} />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export default App;
