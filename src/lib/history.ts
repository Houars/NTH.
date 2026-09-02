import type { NthFailureKind, NthMessage, Route, SearchSource } from "./nth";
import { deriveTopicState, emptyTopicState, normalizeTopicState, type TopicState } from "./context";
import {
  emptyConversationMemory,
  normalizeConversationMemory,
  rebuildConversationMemory,
  type ConversationMemory
} from "./memory";

export type UiMessage = NthMessage & {
  id: string;
  createdAt: number;
  route?: Route;
  sources?: SearchSource[];
  searchQuery?: string;
  contextReused?: boolean;
  error?: boolean;
  streaming?: boolean;
  failure?: {
    kind: NthFailureKind;
    userMessageId: string;
    forceWeb: boolean;
    retryCount: number;
  };
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UiMessage[];
  context?: TopicState;
  memory?: ConversationMemory;
};

export type ConversationGroup = {
  label: "TODAY" | "YESTERDAY" | "OLDER";
  conversations: Conversation[];
};

const HISTORY_KEY = "nth.conversations.v1";
const HISTORY_TEMP_KEY = "nth.conversations.v1.pending";
const LEGACY_CHAT_KEY = "nth.chat.v2";
let unreadableHistory = false;

export function rebuildTopicState(messages: UiMessage[]): TopicState {
  const stable = messages.filter(message => !message.error);
  let context = emptyTopicState();
  for (let index = 0; index < stable.length; index += 1) {
    if (stable[index].role === "user") context = deriveTopicState(stable.slice(0, index + 1), context);
  }
  return context;
}

export function createConversation(now = Date.now()): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    messages: [],
    context: emptyTopicState(),
    memory: emptyConversationMemory()
  };
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Conversation>;
  return typeof item.id === "string" && Array.isArray(item.messages);
}

function normalizeMessage(value: unknown, fallbackCreatedAt: number): UiMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as UiMessage;
  if (message.role !== "assistant" && message.role !== "user") return null;
  if (typeof message.content !== "string") message.content = "";
  const rawError = message.role === "assistant" && /^error:/i.test(message.content.trim());
  const interrupted = message.role === "assistant" && Boolean(message.streaming);
  let content = message.content;

  if (rawError) {
    if (/searxng|web search|127\.0\.0\.1:8888/i.test(content)) {
      content = "Web search was unavailable. Check the SearXNG URL in Settings and try again.";
    } else if (/ollama|decode|response body|connection/i.test(content)) {
      content = "Ollama could not complete that response. Check its status in Settings and try again.";
    } else {
      content = "NTH could not finish that response. Please try again.";
    }
  }

  if (interrupted) {
    content = content.trim()
      ? `${content.trim()}\n\nResponse interrupted. Retry?`
      : "The previous operation was interrupted. Retry?";
  }

  return {
    ...message,
    content,
    id: typeof message.id === "string" ? message.id : crypto.randomUUID(),
    route: ["local", "web", "vision", "vision+web"].includes(String(message.route)) ? message.route : undefined,
    createdAt: Number(message.createdAt) || fallbackCreatedAt,
    error: message.error || rawError || interrupted,
    attachments: Array.isArray(message.attachments) ? message.attachments.filter(image =>
      image && typeof image.dataUrl === "string" && typeof image.mime === "string"
    ).map(image => ({ ...image, id: image.id || crypto.randomUUID(), name: image.name || "Image" })) : undefined,
    sources: Array.isArray(message.sources) ? message.sources.filter(source =>
      source && typeof source.url === "string" && typeof source.title === "string"
      && typeof source.snippet === "string" && typeof source.domain === "string"
    ) : undefined,
    searchQuery: typeof message.searchQuery === "string" ? message.searchQuery : undefined,
    failure: interrupted || message.error || rawError ? {
      kind: interrupted ? "cancelled" : message.failure?.kind || "service",
      userMessageId: typeof message.failure?.userMessageId === "string" ? message.failure.userMessageId : "",
      forceWeb: typeof message.failure?.forceWeb === "boolean" ? message.failure.forceWeb : message.route === "web" || message.route === "vision+web",
      retryCount: Math.max(0, Number(message.failure?.retryCount) || 0)
    } : undefined,
    streaming: false
  };
}

function normalizeConversation(conversation: Conversation): Conversation {
  const createdAt = Number(conversation.createdAt) || Date.now();
  let previousUserId = "";
  const messages = conversation.messages.map(message => {
    const normalized = normalizeMessage(message, createdAt);
    if (!normalized) return null;
    if (normalized.role === "user") previousUserId = normalized.id;
    if (normalized.failure && !normalized.failure.userMessageId) {
      normalized.failure = { ...normalized.failure, userMessageId: previousUserId };
    }
    return normalized;
  }).filter((message): message is UiMessage => message !== null);
  // Metadata is expendable; visible messages are not. Rebuild only damaged
  // metadata and retain the v0.5.8 representation for healthy saved chats.
  const rawContext = conversation.context;
  const validContext = rawContext &&
    [rawContext.currentExplicitSubject, rawContext.lastMeaningfulUserTopic, rawContext.currentWebSubject, rawContext.focus].every(item => typeof item === "string") &&
    [rawContext.recentEntities, rawContext.recentVerifiedSubjects].every(items => Array.isArray(items) && items.every(item => typeof item === "string"));
  const context = validContext ? normalizeTopicState(rawContext) : rebuildTopicState(messages);
  let memory: ConversationMemory;
  try {
    memory = normalizeConversationMemory(conversation.memory, messages, context);
  } catch {
    memory = rebuildConversationMemory(messages, context);
  }
  return {
    ...conversation,
    title: typeof conversation.title === "string" && conversation.title.trim() ? conversation.title : "New conversation",
    createdAt,
    updatedAt: Number(conversation.updatedAt) || createdAt,
    messages,
    context,
    memory
  };
}

function readSavedConversations(key: string): Conversation[] {
  const saved = JSON.parse(localStorage.getItem(key) || "[]") as unknown;
  if (!Array.isArray(saved)) throw new Error("Unreadable chat history");
  return saved.filter(isConversation).map(normalizeConversation);
}

export function loadConversations(): Conversation[] {
  unreadableHistory = false;
  let primary: Conversation[] = [];
  let pending: Conversation[] = [];
  try {
    primary = readSavedConversations(HISTORY_KEY);
  } catch {
    // A broken history entry should never prevent NTH from starting.
    unreadableHistory = true;
  }

  try {
    pending = readSavedConversations(HISTORY_TEMP_KEY);
  } catch {
    // A pending write can also be corrupt; visible legacy history is tried next.
  }

  if (primary.length || pending.length) {
    const newest = (items: Conversation[]) => Math.max(0, ...items.map(item => item.updatedAt));
    if (pending.length && newest(pending) > newest(primary)) {
      unreadableHistory = false;
      try {
        localStorage.setItem(HISTORY_KEY, localStorage.getItem(HISTORY_TEMP_KEY) || "[]");
        localStorage.removeItem(HISTORY_TEMP_KEY);
      } catch {
        // Recovery remains available in the pending key for the next startup.
      }
      return pending;
    }
    try {
      localStorage.removeItem(HISTORY_TEMP_KEY);
    } catch {
      // Cleanup failure is harmless.
    }
    if (primary.length) return primary;
  }

  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_CHAT_KEY) || "[]") as UiMessage[];
    if (Array.isArray(legacy) && legacy.length) {
      const now = Date.now();
      const firstUser = legacy.find(message => message.role === "user");
      return [{
        id: crypto.randomUUID(),
        title: titleForMessage(firstUser?.content || "Imported conversation", Boolean(firstUser?.attachments?.length)),
        createdAt: now,
        updatedAt: now,
        messages: legacy.map(message => normalizeMessage(message, now)).filter((message): message is UiMessage => message !== null),
        context: emptyTopicState(),
        memory: emptyConversationMemory()
      }];
    }
  } catch {
    // Ignore invalid legacy data.
  }

  return [createConversation()];
}

export function saveConversations(conversations: Conversation[], explicitlyReplaceUnreadable = false): boolean {
  // Never overwrite an unreadable original with a freshly-created empty chat.
  // Keep it available for recovery; the UI reports that persistence is blocked.
  if (unreadableHistory && !explicitlyReplaceUnreadable) return false;
  try {
    // Persist the transient streaming marker. On the next startup it is turned
    // into a recoverable interrupted response rather than a stale busy state.
    const serialized = JSON.stringify(conversations);
    // One localStorage replacement is atomic in the WebView. Keeping a second
    // full copy would double quota pressure for chats containing pasted images.
    localStorage.setItem(HISTORY_KEY, serialized);
    unreadableHistory = false;
    localStorage.removeItem(HISTORY_TEMP_KEY);
    return true;
  } catch {
    // localStorage quotas vary. The active chat remains usable in memory.
    return false;
  }
}

export function titleForMessage(content: string, hasImage = false): string {
  const compact = content
    .replace(/\s+/g, " ")
    .replace(/^[\s.,!?;:–—-]+|[\s.,!?;:–—-]+$/g, "")
    .trim();
  const fallback = hasImage ? "Image conversation" : "New conversation";
  if (!compact || compact === "Describe this image.") return fallback;
  return compact.length > 42 ? `${compact.slice(0, 41).trimEnd()}…` : compact;
}

function dayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function groupConversations(conversations: Conversation[], now = Date.now()): ConversationGroup[] {
  const today = dayStart(now);
  const yesterday = today - 86_400_000;
  const groups: Record<ConversationGroup["label"], Conversation[]> = {
    TODAY: [],
    YESTERDAY: [],
    OLDER: []
  };

  [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .forEach(conversation => {
      const timestamp = dayStart(conversation.updatedAt);
      if (timestamp >= today) groups.TODAY.push(conversation);
      else if (timestamp >= yesterday) groups.YESTERDAY.push(conversation);
      else groups.OLDER.push(conversation);
    });

  return (["TODAY", "YESTERDAY", "OLDER"] as const)
    .filter(label => groups[label].length)
    .map(label => ({ label, conversations: groups[label] }));
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function historyStorageKey(): string {
  return HISTORY_KEY;
}
