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
  MODEL_BY_MODE,
  needsWeb,
  type NthMode,
  pingOllama,
  type Route,
  type SearchSource
} from "./lib/nth";
import {
  createConversation,
  groupConversations,
  loadConversations,
  relativeTime,
  saveConversations,
  titleForMessage,
  type Conversation,
  type UiMessage
} from "./lib/history";
import {
  checkNthUpdate,
  installNthUpdate,
  type NthUpdateInfo
} from "./lib/updater";

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
      profileAvatar: typeof saved.profileAvatar === "string" && saved.profileAvatar.startsWith("data:image/")
        ? saved.profileAvatar
        : ""
    };
  } catch {
    return defaultSettings;
  }
}

function loadMode(): NthMode {
  const saved = localStorage.getItem(MODE_KEY);
  return modes.includes(saved as NthMode) ? saved as NthMode : "RUN";
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

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/searxng|searches failed|search query/i.test(raw)) {
    return "Web search could not reach your local SearXNG service. Check its URL in Settings and try again.";
  }
  if (/ollama|11434|connection refused|failed to fetch/i.test(raw)) {
    return "Ollama is unavailable. Start Ollama, confirm the local model is installed, and try again.";
  }
  if (/decode|json/i.test(raw)) {
    return "NTH received an unexpected local service response. Check Ollama and SearXNG, then try again.";
  }
  return "NTH could not finish that response. Please try again.";
}

function predictedRoute(text: string, hasVision: boolean, forceWeb: boolean, context: UiMessage[] = []): Route {
  const useWeb = forceWeb || needsWeb(text, context);
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
  if (!message.content && message.route?.includes("vision")) return "vision";
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
  const [ready, setReady] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<AnswerPhase | null>(null);
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
  const [appVersion, setAppVersion] = useState("0.5.6");
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
  const dragDepthRef = useRef(0);

  const activeConversation = useMemo(
    () => conversations.find(conversation => conversation.id === activeId) || conversations[0],
    [activeId, conversations]
  );
  const messages = activeConversation?.messages || [];
  const groups = useMemo(() => groupConversations(conversations), [conversations]);
  const autoWeb = needsWeb(input, messages);
  const canSend = ready && !busy && Boolean(input.trim() || attachments.length);

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
    const timer = window.setTimeout(() => saveConversations(conversations), 250);
    return () => window.clearTimeout(timer);
  }, [conversations]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
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

  async function refreshOllamaStatus() {
    setCheckingStatus(true);
    const online = await pingOllama().catch(() => false);
    setReady(online);
    setCheckingStatus(false);
  }

  async function refreshUpdate() {
    const inTauri = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (!inTauri) {
      setUpdateStatus("error");
      setUpdateMessage("Update checks are available in the installed desktop app.");
      return;
    }

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
      const raw = error instanceof Error ? error.message : String(error);
      setUpdateMessage(/https/i.test(raw) ? raw : "The signed release channel could not be reached. Try again shortly.");
    }
  }

  async function applyUpdate() {
    if (!updateInfo || updateStatus === "downloading") return;
    setUpdateStatus("downloading");
    setUpdatePercent(0);
    setUpdateMessage(`Downloading NTH ${updateInfo.version}…`);

    try {
      await installNthUpdate(progress => {
        setUpdatePercent(progress.percent ?? null);
        setUpdateMessage(progress.finished
          ? "Update verified. Restarting NTH…"
          : progress.percent === undefined
            ? "Downloading and verifying the signed update…"
            : `Downloading update… ${progress.percent}%`);
      });
      await relaunch();
    } catch (error) {
      setUpdateStatus("error");
      setUpdatePercent(null);
      const raw = error instanceof Error ? error.message : String(error);
      setUpdateMessage(/signature/i.test(raw)
        ? "The update signature could not be verified, so NTH refused to install it."
        : "NTH could not install that update. Check the release channel and try again.");
    }
  }

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const online = await pingOllama().catch(() => false);
      if (alive) {
        setReady(online);
        setCheckingStatus(false);
      }
    };
    void check();
    const timer = window.setInterval(check, 7000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

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
    if (!scroller || (!atBottom && !busy)) return;
    const frame = window.requestAnimationFrame(() => {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: busy ? "auto" : "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, busy, phase, atBottom]);

  function updateConversation(id: string, update: (conversation: Conversation) => Conversation) {
    setConversations(current => current.map(conversation => conversation.id === id ? update(conversation) : conversation));
  }

  async function addFiles(files: File[]) {
    const images = files.filter(file => file.type.startsWith("image/"));
    if (!images.length) {
      setComposerNotice("NTH accepts image attachments.");
      window.setTimeout(() => setComposerNotice(""), 2200);
      return;
    }

    const room = Math.max(0, 4 - attachments.length);
    if (!room) {
      setComposerNotice("You can attach up to four images.");
      window.setTimeout(() => setComposerNotice(""), 2200);
      return;
    }

    const next = await Promise.all(images.slice(0, room).map(async file => ({
      id: crypto.randomUUID(),
      name: file.name || "pasted-image.png",
      mime: file.type || "image/png",
      dataUrl: await dataUrlFor(file)
    })));
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
    setConversations([replacement]);
    setActiveId(replacement.id);
    setInput("");
    setAttachments([]);
    setClearConfirm(false);
    setSettingsOpen(false);
  }

  async function send() {
    if (!canSend || !activeConversation) return;

    const conversationId = activeConversation.id;
    const text = input.trim() || "Describe this image.";
    const sentAttachments = attachments;
    const userMessage: UiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      attachments: sentAttachments,
      createdAt: Date.now()
    };
    const assistantId = crypto.randomUUID();
    const route = predictedRoute(text, Boolean(sentAttachments.length), webForced, messages);
    const assistantMessage: UiMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      route,
      createdAt: Date.now(),
      streaming: true
    };
    const requestMessages = [...messages, userMessage];
    const hasPriorUserMessage = messages.some(message => message.role === "user");

    updateConversation(conversationId, conversation => ({
      ...conversation,
      title: hasPriorUserMessage ? conversation.title : titleForMessage(text, Boolean(sentAttachments.length)),
      updatedAt: Date.now(),
      messages: [...conversation.messages, userMessage, assistantMessage]
    }));

    setInput("");
    setAttachments([]);
    setBusy(true);
    setPhase(null);
    setAtBottom(true);
    const controller = new AbortController();
    generationRef.current = controller;

    try {
      const result = await answerNth({
        messages: requestMessages
          .filter(message => !message.error)
          .map(({ role, content, attachments: images, route: messageRoute, sources, searchQuery, contextReused }) => ({
            role,
            content,
            attachments: images,
            route: messageRoute,
            sources,
            searchQuery,
            contextReused
          })),
        mode,
        forceWeb: webForced,
        web: { searxngUrl: settings.searxngUrl },
        topicState: activeConversation.context,
        signal: controller.signal,
        onPhase: nextPhase => setPhase(nextPhase),
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

      updateConversation(conversationId, conversation => ({
        ...conversation,
        context: result.topicState,
        updatedAt: Date.now(),
        messages: conversation.messages.map(message =>
          message.id === assistantId
            ? {
                ...message,
                content: result.content,
                route: result.route,
                sources: result.sources,
                searchQuery: result.searchQuery,
                contextReused: result.contextReused,
                streaming: false
              }
            : message
        )
      }));
    } catch (error) {
      const stopped = error instanceof DOMException && error.name === "AbortError";
      updateConversation(conversationId, conversation => ({
        ...conversation,
        updatedAt: Date.now(),
        messages: conversation.messages.map(message => {
          if (message.id !== assistantId) return message;
          if (stopped) {
            return { ...message, content: message.content || "Generation stopped.", streaming: false };
          }
          return { ...message, content: friendlyError(error), streaming: false, error: true };
        })
      }));
    } finally {
      generationRef.current = null;
      setBusy(false);
      setPhase(null);
      void refreshOllamaStatus();
    }
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

  const phaseLabel = phase === "searching"
    ? "Searching web…"
    : phase === "verifying"
      ? "Checking sources…"
      : phase === "generating"
        ? "Answering…"
        : "Thinking…";

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
            <i /> {ready ? "LOCAL" : "OFFLINE"}
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
                placeholder={ready ? "Ask anything…" : "Start Ollama to use NTH."}
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
              <span className={composerNotice ? "notice" : ""}>{composerNotice || "ENTER TO SEND · SHIFT+ENTER FOR NEW LINE"}</span>
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
                <div><strong>Ollama</strong><span>{checkingStatus ? "Checking…" : ready ? "Connected at 127.0.0.1:11434" : "Not connected"}</span></div>
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
                  <button onClick={() => void applyUpdate()} disabled={updateStatus === "downloading"}>
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
            </section>

            <section className="settings-section">
              <h3>MODEL & MODE</h3>
              <div className="settings-mode"><ModeSelector mode={mode} onChange={setMode} /></div>
              <div className="model-card">
                <div><span>ACTIVE MODEL</span><strong>Gemma 4 12B Q4</strong></div>
                <code>{MODEL_BY_MODE[mode]}</code>
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
