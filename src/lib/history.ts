import type { NthMessage, Route, SearchSource } from "./nth";
import type { TopicState } from "./context";

export type UiMessage = NthMessage & {
  id: string;
  createdAt: number;
  route?: Route;
  sources?: SearchSource[];
  searchQuery?: string;
  contextReused?: boolean;
  error?: boolean;
  streaming?: boolean;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UiMessage[];
  context?: TopicState;
};

export type ConversationGroup = {
  label: "TODAY" | "YESTERDAY" | "OLDER";
  conversations: Conversation[];
};

const HISTORY_KEY = "nth.conversations.v1";
const LEGACY_CHAT_KEY = "nth.chat.v2";

export function createConversation(now = Date.now()): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Conversation>;
  return typeof item.id === "string" && Array.isArray(item.messages);
}

function normalizeMessage(message: UiMessage, fallbackCreatedAt: number): UiMessage {
  const rawError = message.role === "assistant" && /^error:/i.test(message.content.trim());
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

  return {
    ...message,
    content,
    id: message.id || crypto.randomUUID(),
    createdAt: Number(message.createdAt) || fallbackCreatedAt,
    error: message.error || rawError,
    streaming: false
  };
}

function normalizeConversation(conversation: Conversation): Conversation {
  const createdAt = Number(conversation.createdAt) || Date.now();
  return {
    ...conversation,
    title: conversation.title?.trim() || "New conversation",
    createdAt,
    updatedAt: Number(conversation.updatedAt) || createdAt,
    messages: conversation.messages.map(message => normalizeMessage(message, createdAt))
  };
}

export function loadConversations(): Conversation[] {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]") as unknown;
    if (Array.isArray(saved)) {
      const conversations = saved.filter(isConversation).map(normalizeConversation);
      if (conversations.length) return conversations;
    }
  } catch {
    // A broken history entry should never prevent NTH from starting.
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
        messages: legacy.map(message => normalizeMessage(message, now))
      }];
    }
  } catch {
    // Ignore invalid legacy data.
  }

  return [createConversation()];
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    const stable = conversations.map(conversation => ({
      ...conversation,
      messages: conversation.messages.map(({ streaming: _streaming, ...message }) => message)
    }));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(stable));
  } catch {
    // localStorage quotas vary. The active chat remains usable in memory.
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
