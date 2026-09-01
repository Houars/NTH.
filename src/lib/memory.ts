import {
  deriveTopicState,
  isConversationOnlyIntent,
  normalizeTopicState,
  topicTerms,
  type ContextMessage,
  type TopicState
} from "./context";

export type MemorySource = {
  title: string;
  url: string;
  snippet: string;
  domain: string;
};

export type MemoryMessage = ContextMessage & {
  createdAt?: number;
  searchQuery?: string;
  sources?: MemorySource[];
  attachments?: Array<{ mime: string; dataUrl: string }>;
  error?: boolean;
};

export type MemoryNoteKind = "fact" | "decision" | "constraint" | "question" | "conclusion" | "correction";

export type MemoryNote = {
  kind: MemoryNoteKind;
  text: string;
  createdAt: number;
};

export type TopicMemory = {
  key: string;
  subject: string;
  entities: string[];
  notes: MemoryNote[];
  updatedAt: number;
};

export type EvidenceFreshness = "volatile" | "current_product" | "stable_spec" | "historical" | "uncertain";

export type EvidenceMemory = {
  query: string;
  subject: string;
  snippets: string[];
  sources: MemorySource[];
  capturedAt: number;
  verified: true;
  freshness: EvidenceFreshness;
};

export type ConversationMemory = {
  version: 1;
  recentTurnWindow: number;
  topics: TopicMemory[];
  evidence: EvidenceMemory[];
  updatedAt: number;
};

export type ContextDiagnostics = {
  recentTurnCount: number;
  estimatedContextSize: number;
  summarySize: number;
  activeSubject: string;
  entities: string[];
  reusedEvidenceCount: number;
};

export type BudgetedContext = {
  messages: MemoryMessage[];
  grounding: string;
  diagnostics: ContextDiagnostics;
};

export const DEFAULT_RECENT_TURN_WINDOW = 6;
export const CONTEXT_BUDGET_CHARS = 24_000;

const MAX_TOPICS = 8;
const MAX_NOTES_PER_TOPIC = 8;
const MAX_EVIDENCE_RECORDS = 12;
const CORRECTION_PATTERN = /^(?:no(?:pe)?[,.: -]+|actually[,.: -]+|correction[: -]+|that(?:'s| is) (?:not|wrong)|i meant\b)/i;
const FILLER_PATTERN = /^(?:hi|hello|hey|yo|ok|okay|thanks|thank you|got it|cool|nice|great|sure|lol|haha)[!?. ]*$/i;
const JOKE_PATTERN = /\b(?:tell me (?:a|another) joke|make me laugh|say something funny)\b/i;
const CONSTRAINT_PATTERN = /\b(?:must|must not|do not|don't|never|always|keep|require|constraint|without changing|should not)\b/i;
const DECISION_PATTERN = /\b(?:i (?:want|choose|chose|decided|prefer|will)|let(?:'s| us)|we (?:will|should|decided)|use .+ instead)\b/i;
const UNRESOLVED_PATTERN = /\?\s*$/;

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, maximum: number): string {
  const value = compact(text).replace(/[*_`#]/g, "");
  return value.length > maximum ? `${value.slice(0, maximum - 1).trimEnd()}…` : value;
}

function topicKey(subject: string): string {
  return compact(subject).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80) || "general";
}

function unique(items: string[], maximum = 8): string[] {
  return [...new Map(items.filter(Boolean).map(item => [item.toLowerCase(), item])).values()].slice(0, maximum);
}

function entityNames(text: string): string[] {
  const named = (text.match(/\b[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,}(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,}){1,3}\b/g) || [])
    .filter(name => !/^(?:Now|Back|The|Always|Never)\b/i.test(name))
    .map(name => name.replace(/[’']s$/i, ""));
  const products = text.match(/\b(?:RTX\s*\d{3,4}(?:\s*(?:Ti|Super))?|Radeon\s*(?:RX\s*)?\d{3,4}|Ryzen\s*\d(?:\s*\d{3,4}[A-Za-z0-9]*)?)\b/gi) || [];
  return unique([...named, ...products]);
}

function limitNotes(notes: MemoryNote[]): MemoryNote[] {
  const critical = notes.filter(note => ["constraint", "correction", "decision"].includes(note.kind)).slice(-4);
  const criticalSet = new Set(critical);
  const remaining = notes.filter(note => !criticalSet.has(note)).slice(-(MAX_NOTES_PER_TOPIC - critical.length));
  return [...critical, ...remaining].sort((a, b) => a.createdAt - b.createdAt);
}

function recentStartIndex(messages: MemoryMessage[], turnWindow: number): number {
  let users = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    users += 1;
    if (users >= turnWindow) return index;
  }
  return 0;
}

function meaningful(text: string): boolean {
  const value = compact(text);
  return value.length >= 8 && !FILLER_PATTERN.test(value);
}

function summaryFiller(text: string): boolean {
  const value = compact(text);
  return FILLER_PATTERN.test(value) || JOKE_PATTERN.test(value);
}

function noteFor(message: MemoryMessage): MemoryNote | null {
  const text = clip(message.content, 260);
  if (!meaningful(text) || message.error || (message.role === "user" && summaryFiller(text))) return null;
  const createdAt = Number(message.createdAt) || Date.now();
  if (message.role === "user") {
    if (CORRECTION_PATTERN.test(text)) return { kind: "correction", text, createdAt };
    if (CONSTRAINT_PATTERN.test(text)) return { kind: "constraint", text, createdAt };
    if (DECISION_PATTERN.test(text)) return { kind: "decision", text, createdAt };
    if (UNRESOLVED_PATTERN.test(text)) return { kind: "question", text, createdAt };
    return { kind: "fact", text: `User established: ${text}`, createdAt };
  }
  return { kind: "conclusion", text: `NTH concluded: ${text}`, createdAt };
}

function freshnessFor(query: string, content: string): EvidenceFreshness {
  const value = `${query} ${content}`;
  if (/\b(?:breaking|news|today|tonight|price|pricing|cost|stock|availability|available|weather|score|schedule)\b/i.test(value)) return "volatile";
  if (/\b(?:latest|newest|current|currently released|release date|version)\b/i.test(value)) return "current_product";
  if (/\b(?:specification|specs|vram|memory|tdp|power consumption|dimensions|date of birth|born)\b/i.test(value)) return "stable_spec";
  if (/\b(?:history|historical|founded|invented|ancient|war|century|died)\b/i.test(value)) return "historical";
  return "uncertain";
}

export function evidenceLifetimeMs(freshness: EvidenceFreshness): number {
  if (freshness === "volatile") return 2 * 60 * 60 * 1000;
  if (freshness === "current_product") return 24 * 60 * 60 * 1000;
  if (freshness === "stable_spec") return 14 * 24 * 60 * 60 * 1000;
  if (freshness === "historical") return 180 * 24 * 60 * 60 * 1000;
  return 0;
}

export function isEvidenceFresh(evidence: EvidenceMemory, now = Date.now()): boolean {
  const lifetime = evidenceLifetimeMs(evidence.freshness);
  return evidence.verified === true && lifetime > 0 && now - evidence.capturedAt <= lifetime;
}

export function emptyConversationMemory(recentTurnWindow = DEFAULT_RECENT_TURN_WINDOW): ConversationMemory {
  const requestedWindow = Number(recentTurnWindow);
  const safeWindow = Number.isFinite(requestedWindow) ? requestedWindow : DEFAULT_RECENT_TURN_WINDOW;
  return {
    version: 1,
    recentTurnWindow: Math.max(2, Math.min(12, Math.round(safeWindow))),
    topics: [],
    evidence: [],
    updatedAt: Date.now()
  };
}

function isMemory(value: unknown): value is ConversationMemory {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ConversationMemory>;
  return item.version === 1 && Array.isArray(item.topics) && Array.isArray(item.evidence);
}

function noteKind(value: unknown): MemoryNoteKind {
  return ["fact", "decision", "constraint", "question", "conclusion", "correction"].includes(String(value))
    ? value as MemoryNoteKind
    : "fact";
}

function evidenceFreshness(value: unknown): EvidenceFreshness {
  return ["volatile", "current_product", "stable_spec", "historical", "uncertain"].includes(String(value))
    ? value as EvidenceFreshness
    : "uncertain";
}

export function normalizeConversationMemory(
  value: unknown,
  messages: MemoryMessage[] = [],
  topicState?: TopicState
): ConversationMemory {
  if (!isMemory(value)) return rebuildConversationMemory(messages, topicState);
  const base = emptyConversationMemory(value.recentTurnWindow);
  const normalized: ConversationMemory = {
    ...base,
    topics: value.topics.filter(topic => topic && typeof topic.subject === "string").slice(-MAX_TOPICS).map(topic => ({
      key: topicKey(topic.subject),
      subject: clip(topic.subject, 100),
      entities: unique(Array.isArray(topic.entities) ? topic.entities.map(String) : []),
      notes: Array.isArray(topic.notes) ? limitNotes(topic.notes.filter(note => note && typeof note.text === "string").map(note => ({
        kind: noteKind(note.kind),
        text: clip(note.text, 260),
        createdAt: Number(note.createdAt) || Date.now()
      }))) : [],
      updatedAt: Number(topic.updatedAt) || Date.now()
    })),
    evidence: value.evidence
      .filter(item => item && item.verified === true && typeof item.query === "string" && Array.isArray(item.sources))
      .slice(-MAX_EVIDENCE_RECORDS)
      .map(item => ({
        query: clip(item.query, 220),
        subject: clip(typeof item.subject === "string" ? item.subject : item.query, 220),
        snippets: Array.isArray(item.snippets) ? item.snippets.map(String).map(text => clip(text, 360)).slice(0, 8) : [],
        sources: item.sources.filter(source => source && typeof source.url === "string").slice(0, 8).map(source => ({
          title: clip(String(source.title || source.domain || "Source"), 180),
          url: source.url,
          snippet: clip(String(source.snippet || ""), 360),
          domain: String(source.domain || "")
        })),
        capturedAt: Number(item.capturedAt) || 0,
        verified: true as const,
        freshness: evidenceFreshness(item.freshness)
      }))
      .filter(item => isEvidenceFresh(item)),
    updatedAt: Number(value.updatedAt) || Date.now()
  };
  const lostTopics = value.topics.length > 0 && normalized.topics.length === 0;
  const lostEvidence = value.evidence.length > 0 && normalized.evidence.length === 0
    && value.evidence.some(item => item && item.verified === true);
  return messages.length && (lostTopics || lostEvidence)
    ? rebuildConversationMemory(messages, topicState, normalized)
    : normalized;
}

function upsertTopic(topics: TopicMemory[], state: TopicState, note: MemoryNote): void {
  const normalized = normalizeTopicState(state);
  const subject = normalized.currentExplicitSubject || normalized.lastMeaningfulUserTopic || "General conversation";
  const key = topicKey(subject);
  let topic = topics.find(item => item.key === key);
  if (!topic) {
    topic = { key, subject: clip(subject, 100), entities: [], notes: [], updatedAt: note.createdAt };
    topics.push(topic);
  }
  topic.subject = clip(subject, 100);
  topic.entities = unique([subject, ...entityNames(subject), ...entityNames(note.text), ...topic.entities]);
  if (note.kind === "correction") {
    topic.notes = topic.notes.filter(existing => !["fact", "conclusion", "correction"].includes(existing.kind));
  }
  const duplicate = topic.notes.findIndex(existing => existing.text.toLowerCase() === note.text.toLowerCase());
  if (duplicate >= 0) topic.notes.splice(duplicate, 1);
  if (note.kind === "conclusion") {
    for (let index = topic.notes.length - 1; index >= 0; index -= 1) {
      if (topic.notes[index].kind !== "question") continue;
      topic.notes.splice(index, 1);
      break;
    }
  }
  topic.notes.push(note);
  topic.notes = limitNotes(topic.notes);
  topic.updatedAt = note.createdAt;
}

export function rebuildConversationMemory(
  messages: MemoryMessage[],
  topicState?: TopicState,
  previous?: ConversationMemory
): ConversationMemory {
  const recentTurnWindow = previous?.recentTurnWindow || DEFAULT_RECENT_TURN_WINDOW;
  const memory = emptyConversationMemory(recentTurnWindow);
  const stableMessages = messages.filter(message => compact(message.content) && !message.error);
  const compactBefore = recentStartIndex(stableMessages, recentTurnWindow);
  let state = normalizeTopicState(undefined);
  let skipAssistantSummary = false;

  for (let index = 0; index < compactBefore; index += 1) {
    const message = stableMessages[index];
    if (message.role === "user") {
      state = deriveTopicState(stableMessages.slice(0, index + 1), state);
      skipAssistantSummary = summaryFiller(message.content);
    } else if (skipAssistantSummary) {
      continue;
    }
    const note = noteFor(message);
    if (note) upsertTopic(memory.topics, state, note);
  }


  // A correction must invalidate an older compacted fact immediately, even
  // while the correcting turn itself remains in the verbatim recent window.
  for (let index = compactBefore; index < stableMessages.length; index += 1) {
    const message = stableMessages[index];
    if (message.role !== "user" || !CORRECTION_PATTERN.test(compact(message.content))) continue;
    const note = noteFor(message);
    const correctionState = normalizeTopicState(topicState || state);
    const correctionKey = topicKey(correctionState.currentExplicitSubject || correctionState.lastMeaningfulUserTopic);
    for (const topic of memory.topics) {
      if (!correctionKey || !(topic.key.includes(correctionKey) || correctionKey.includes(topic.key))) continue;
      topic.notes = topic.notes.filter(existing => !["fact", "conclusion", "correction"].includes(existing.kind));
    }
    if (note) upsertTopic(memory.topics, correctionState, note);
  }

  const currentState = normalizeTopicState(topicState || state);
  const activeKey = topicKey(currentState.currentExplicitSubject || currentState.lastMeaningfulUserTopic);
  memory.topics = memory.topics
    .sort((a, b) => (a.key === activeKey ? 1 : 0) - (b.key === activeKey ? 1 : 0) || a.updatedAt - b.updatedAt)
    .slice(-MAX_TOPICS);

  const evidence: EvidenceMemory[] = [];
  for (const message of stableMessages) {
    if (message.role !== "assistant" || !message.sources?.length) continue;
    const query = clip(message.searchQuery || currentState.currentWebSubject || currentState.currentExplicitSubject || "verified web context", 220);
    const sources = message.sources.slice(0, 8).map(source => ({
      title: clip(source.title, 180),
      url: source.url,
      snippet: clip(source.snippet, 360),
      domain: source.domain
    }));
    evidence.push({
      query,
      subject: query,
      snippets: sources.map(source => source.snippet).filter(Boolean).slice(0, 8),
      sources,
      capturedAt: Number(message.createdAt) || Date.now(),
      verified: true,
      freshness: freshnessFor(query, message.content)
    });
  }
  memory.evidence = evidence.filter(item => isEvidenceFresh(item)).slice(-MAX_EVIDENCE_RECORDS);
  memory.updatedAt = Date.now();
  return memory;
}

function relevantTopics(memory: ConversationMemory, state: TopicState): TopicMemory[] {
  const normalized = normalizeTopicState(state);
  const terms = topicTerms(normalized).map(term => term.toLowerCase());
  if (!terms.length) return memory.topics.slice(-1);
  return memory.topics
    .filter(topic => {
      const haystack = `${topic.subject} ${topic.entities.join(" ")}`.toLowerCase();
      return terms.some(term => haystack.includes(term) || term.includes(topic.key));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 2);
}

export function reusableEvidence(
  memory: ConversationMemory | undefined,
  query: string,
  state: TopicState,
  now = Date.now()
): EvidenceMemory[] {
  if (!memory) return [];
  const terms = unique([...topicTerms(state), ...query.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 4)], 12)
    .map(term => term.toLowerCase());
  return memory.evidence
    .filter(item => isEvidenceFresh(item, now))
    .filter(item => {
      const haystack = `${item.query} ${item.subject} ${item.snippets.join(" ")}`.toLowerCase();
      return terms.length === 0 || terms.some(term => haystack.includes(term));
    })
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .slice(0, 3);
}

function memoryGrounding(memory: ConversationMemory, state: TopicState, evidence: EvidenceMemory[]): string {
  const normalized = normalizeTopicState(state);
  const topics = relevantTopics(memory, normalized);
  const sections: string[] = [];
  const active = normalized.currentExplicitSubject || normalized.lastMeaningfulUserTopic;
  const activeEntities = unique([active, ...topics.flatMap(topic => topic.entities)]);
  if (active || activeEntities.length) {
    sections.push(`ACTIVE SUBJECT: ${active || "unspecified"}\nACTIVE ENTITIES: ${activeEntities.join(", ") || "none"}`);
  }
  for (const topic of topics) {
    const priority: Record<MemoryNoteKind, number> = {
      constraint: 0,
      correction: 1,
      decision: 2,
      question: 3,
      fact: 4,
      conclusion: 5
    };
    const notes = [...topic.notes]
      .sort((a, b) => priority[a.kind] - priority[b.kind] || b.createdAt - a.createdAt)
      .map(note => `- [${note.kind.toUpperCase()}] ${note.text}`)
      .join("\n");
    if (notes) sections.push(`RELEVANT ROLLING SUMMARY — ${topic.subject}:\n${notes}`);
  }
  if (evidence.length) {
    sections.push(`STILL-FRESH VERIFIED EVIDENCE METADATA:\n${evidence.map(item => {
      const sources = item.sources.slice(0, 4).map(source => `${source.title} (${source.url}) — ${source.snippet}`).join("\n");
      return `QUERY: ${item.query}\nCAPTURED: ${new Date(item.capturedAt).toISOString()}\n${sources}`;
    }).join("\n\n")}`);
  }
  if (!sections.length) return "";
  return `CONVERSATION MEMORY (internal; do not reveal as stored memory unless the user explicitly asks for a conversation summary):\n${sections.join("\n\n")}`;
}

export function buildBudgetedContext(args: {
  messages: MemoryMessage[];
  memory?: ConversationMemory;
  topicState: TopicState;
  policySize: number;
  reusedEvidenceCount?: number;
}): BudgetedContext {
  const memory = normalizeConversationMemory(args.memory, args.messages, args.topicState);
  const nonempty = args.messages.filter(message => compact(message.content));
  let lastUserIndex = -1;
  for (let index = nonempty.length - 1; index >= 0; index -= 1) {
    if (nonempty[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const current = lastUserIndex >= 0 ? nonempty[lastUserIndex] : nonempty.at(-1);
  const start = recentStartIndex(nonempty, memory.recentTurnWindow);
  const recent = nonempty.slice(start);
  const terms = topicTerms(args.topicState).map(term => term.toLowerCase());
  const recentRelevant = recent.filter((message, index) => {
    if (index >= recent.length - 4 || terms.length === 0) return true;
    const haystack = message.content.toLowerCase();
    return terms.some(term => haystack.includes(term));
  });
  const conversationOnly = current ? isConversationOnlyIntent(current.content) : false;
  const relevantEvidence = conversationOnly ? [] : reusableEvidence(memory, current?.content || "", args.topicState);
  const fullGrounding = conversationOnly ? "" : memoryGrounding(memory, args.topicState, relevantEvidence);
  const currentSize = current?.content.length || 0;
  let remaining = Math.max(0, CONTEXT_BUDGET_CHARS - args.policySize - currentSize);
  const criticalReserve = /\[(?:CONSTRAINT|CORRECTION|DECISION)\]/.test(fullGrounding)
    ? Math.min(1_600, fullGrounding.length, remaining)
    : 0;
  let historyRemaining = Math.max(0, remaining - criticalReserve);
  const chosenReversed: MemoryMessage[] = [];

  for (const message of [...recentRelevant].reverse()) {
    if (message === current) continue;
    const size = message.content.length + 24;
    if (size > historyRemaining) continue;
    chosenReversed.push(message);
    historyRemaining -= size;
    remaining -= size;
  }

  const grounding = fullGrounding.length <= remaining
    ? fullGrounding
    : fullGrounding.slice(0, Math.max(0, remaining)).trimEnd();
  const selected = [...chosenReversed.reverse(), ...(current ? [current] : [])];
  const summarySize = memory.topics.reduce((total, topic) => total + topic.notes.reduce((sum, note) => sum + note.text.length, 0), 0);
  const activeEntities = unique([
    normalizeTopicState(args.topicState).currentExplicitSubject,
    ...relevantTopics(memory, args.topicState).flatMap(topic => topic.entities)
  ]);
  return {
    messages: selected,
    grounding,
    diagnostics: {
      recentTurnCount: selected.filter(message => message.role === "user").length,
      estimatedContextSize: args.policySize + selected.reduce((total, message) => total + message.content.length, 0) + grounding.length,
      summarySize,
      activeSubject: normalizeTopicState(args.topicState).currentExplicitSubject,
      entities: activeEntities,
      reusedEvidenceCount: args.reusedEvidenceCount || 0
    }
  };
}
