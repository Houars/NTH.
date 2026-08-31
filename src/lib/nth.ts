import { Channel, invoke } from "@tauri-apps/api/core";
import { NTH_POLICY_V2 } from "./policy";
import {
  calculateAge,
  decomposePrompt,
  deriveTopicState,
  isContextualFollowUp,
  isConversationOnlyIntent,
  needsFreshWeb,
  recentAnswerContext,
  resolveContextualQuery,
  topicTerms,
  type ContextMessage,
  type TopicState
} from "./context";

export type NthMode = "RUN" | "JOG" | "WALK";

export const MODEL_BY_MODE: Record<NthMode, string> = {
  RUN: "hf.co/ggml-org/gemma-4-12B-it-GGUF:Q4_0",
  JOG: "hf.co/ggml-org/gemma-4-12B-it-GGUF:Q4_0",
  WALK: "hf.co/ggml-org/gemma-4-12B-it-GGUF:Q4_0"
};

export type Attachment = {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
};

export type NthMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  route?: Route;
  sources?: SearchSource[];
  searchQuery?: string;
  contextReused?: boolean;
};

export type SearchSource = {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  published_date: string;
  engine: string;
  official: boolean;
  quality: string;
  score: number;
  content: string;
  fetched: boolean;
};

// Compatibility with the existing App.tsx name.
export type SearchResult = SearchSource;

export type Route = "local" | "web" | "vision" | "vision+web";

export type NthAnswer = {
  content: string;
  route: Route;
  sources: SearchSource[];
  searchQuery?: string;
  contextReused: boolean;
  topicState: TopicState;
};

export type AnswerPhase = "searching" | "generating" | "verifying";

type StreamEvent = {
  event: "token" | "done" | "stopped";
  data?: string;
};

export type WebSettings = {
  searxngUrl: string;
};

export function needsWeb(text: string, recentMessages: ContextMessage[] = []): boolean {
  return needsFreshWeb(text, recentMessages);
}

export async function pingOllama(): Promise<boolean> {
  return invoke<boolean>("ollama_ping");
}

function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function localDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function webPolicy(evidence: string, intent: string, searchQuery: string): string {
  return `${NTH_POLICY_V2}

WEB MODE:
The question requires current or externally verified information.

CURRENT LOCAL DATE: ${localDateString()}
SEARCH INTENT: ${intent}
RESOLVED SEARCH CONTEXT: ${searchQuery}

STRICT WEB RULES:
- Treat the year in CURRENT LOCAL DATE as the present year, never as a future year.
- Use the supplied web evidence instead of stale model memory for current facts.
- Answer the exact thing the user asked for. Preserve granularity.
- If the user asks for a GPU/phone/device/model, give a specific currently released model ONLY when a title/snippet explicitly supports that exact model.
- "Newest", "latest", and "current" mean released/currently real NOW. Rumors, leaks, future products, roadmaps, and "next" products do NOT count unless the user explicitly asked about rumors or upcoming products.
- FIRST-PARTY / OFFICIAL evidence outranks community posts, retailers, aggregators, and undated claims for product identity/specification.
- For prices, use CURRENT RETAILER or PRICE-TRACKER evidence. Do not treat a news article about an extreme price as the normal current market price.
- If price evidence shows multiple current values, give a range or representative market figure and make clear it varies by model/retailer.
- For news, prefer the most recent DATED relevant sources. Ignore tangential stories just because they mention the company.
- For rumor queries, rumors are allowed, but contradictions MUST be preserved. Never collapse conflicting launch dates/specs into one confident claim.
- Treat snippets as evidence summaries. Never invent details that the snippets do not contain.
- If the evidence only establishes a series/family but not the exact requested model, say that plainly instead of guessing.
- If sources conflict, choose the better-supported source or explicitly state the disagreement.
- Do not paste raw URLs into the prose answer.
- Keep NTH's normal concise style.

WEB EVIDENCE:
${evidence}`;
}

function verifiedContextPolicy(evidence: string, searchQuery: string): string {
  return `${NTH_POLICY_V2}

VERIFIED RECENT CONTEXT MODE:
The answer can be produced from verified evidence already present in this conversation. No new web search was performed.

CURRENT LOCAL DATE: ${localDateString()}
RESOLVED CONTEXT: ${searchQuery}

RULES:
- Answer the visible user message naturally using recent USER and NTH turns.
- Treat the year in CURRENT LOCAL DATE as the present year, never as a future year.
- Use only the verified recent evidence below for externally verifiable claims.
- Do not imply that a new web search occurred.
- If the evidence is insufficient, say so instead of inventing a referent or fact.
- Keep NTH's normal concise style.

VERIFIED RECENT EVIDENCE:
${evidence}`;
}

function shouldVerifyWeb(intent: string): boolean {
  return ["current_product", "latest_news", "price", "rumor"].includes(intent);
}

function webVerifierPolicy(evidence: string, intent: string): string {
  return `You are NTH's evidence verifier.

CURRENT LOCAL DATE: ${localDateString()}
SEARCH INTENT: ${intent}

Your job is NOT to add knowledge. Check the draft ONLY against the evidence.

Return ONLY the corrected final answer.

MANDATORY CHECKS:
- Every current factual claim in the answer must be explicitly supported by at least one evidence title/snippet.
- Exact entity requested must match the answer granularity: GPU -> GPU model, phone -> phone model, series -> series.
- For current-product questions, rumors/leaks/upcoming/future products cannot be treated as released products.
- If the evidence supports only a family/series and not an exact model, say that the exact model cannot be verified from the search evidence.
- For price questions, do not present an outlier/news headline as the normal market price. Prefer multiple retailer/price-tracker observations; otherwise state that a reliable current market price cannot be determined from these snippets.
- For latest-news questions, choose recent, directly relevant, dated items. Remove tangential stories.
- For rumor questions, if sources disagree on dates/specs, explicitly say reports conflict. Do NOT choose one unsupported consensus.
- Official first-party evidence outranks community posts for product identity.
- Never introduce a fact from model memory to "fix" the draft.
- Be concise.

WEB EVIDENCE:
${evidence}`;
}

function abortError(): DOMException {
  return new DOMException("Generation stopped.", "AbortError");
}

type SearchBundle = {
  query: string;
  intent: string;
  search_queries: string[];
  sources: SearchSource[];
  evidence: string;
  engine_warnings: string[];
};

export type AgeFact = {
  subject: string;
  dateOfBirth: string;
  age: number;
  asOf: string;
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

function parseBirthDate(text: string): string | null {
  const labeled = text.match(/(?:born|date of birth|birth date|birthday)\s*(?::|was|is|on)?\s*(\d{4})-(\d{1,2})-(\d{1,2})/i);
  if (labeled) return `${labeled[1]}-${String(Number(labeled[2])).padStart(2, "0")}-${String(Number(labeled[3])).padStart(2, "0")}`;

  const monthFirst = text.match(/(?:born|date of birth|birth date|birthday)\s*(?::|was|is|on)?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i);
  if (monthFirst) return `${monthFirst[3]}-${String(MONTHS[monthFirst[1].toLowerCase()]).padStart(2, "0")}-${String(Number(monthFirst[2])).padStart(2, "0")}`;

  const dayFirst = text.match(/(?:born|date of birth|birth date|birthday)\s*(?::|was|is|on)?\s*(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (dayFirst) return `${dayFirst[3]}-${String(MONTHS[dayFirst[2].toLowerCase()]).padStart(2, "0")}-${String(Number(dayFirst[1])).padStart(2, "0")}`;
  return null;
}

function ageFactsFromSources(sources: SearchSource[], state: TopicState, now = new Date()): AgeFact[] {
  const subjects = state.entities.length ? state.entities : state.topic ? [state.topic] : [];
  const facts: AgeFact[] = [];
  for (const source of sources) {
    const text = `${source.title}. ${source.snippet}. ${source.content || ""}`;
    const dateOfBirth = parseBirthDate(text);
    if (!dateOfBirth) continue;
    const age = calculateAge(dateOfBirth, now);
    if (age === null) continue;
    const subject = subjects.find(entity => text.toLowerCase().includes(entity.toLowerCase()))
      || (subjects.length === 1 ? subjects[0] : "");
    if (!subject || facts.some(fact => fact.subject.toLowerCase() === subject.toLowerCase())) continue;
    facts.push({ subject, dateOfBirth, age, asOf: localDateString() });
  }
  return facts;
}

function ageGrounding(sources: SearchSource[], state: TopicState): string {
  const asksAge = state.focus === "age" || /\b(?:how old|age|older|youngest)\b/i.test(state.topic);
  if (!asksAge) return "";
  const facts = ageFactsFromSources(sources, state);
  if (!facts.length) {
    return `\n\nDETERMINISTIC AGE RULE:\nNo supported date of birth could be extracted. Do not provide an exact current age from model memory or a stale snippet age.`;
  }
  return `\n\nDETERMINISTIC AGE CALCULATION (authoritative for this answer):\n${facts.map(fact => `- ${fact.subject}: born ${fact.dateOfBirth}; age ${fact.age} on ${fact.asOf}.`).join("\n")}\nUse these calculated ages. Do not copy a stale age number from a snippet or model memory.`;
}

function verifiedEvidenceFrom(messages: NthMessage[]): { sources: SearchSource[]; evidence: string } | null {
  const recent = [...messages].reverse().filter(message =>
    message.role === "assistant" && Boolean(message.sources?.length) && Boolean(message.content.trim())
  ).slice(0, 3);
  if (!recent.length) return null;
  const sources = uniqueSources(recent.map(message => ({
    query: message.searchQuery || "recent verified context",
    intent: "general_fresh",
    search_queries: [],
    sources: message.sources || [],
    evidence: "",
    engine_warnings: []
  })));
  const evidence = [
    ...recent.map((message, index) => `RECENT VERIFIED NTH ANSWER ${index + 1}:\n${message.content}`),
    ...sources.map((source, index) => `[${index + 1}] ${source.title}\n${source.snippet}\n${source.domain}`)
  ].join("\n\n");
  return { sources, evidence };
}

function canReuseVerifiedContext(text: string, query: string, state: TopicState, evidence: string): boolean {
  if (!isContextualFollowUp(text) || isConversationOnlyIntent(text)) return false;
  if (/\b(?:research|look|dig)\s+(?:deeper|further)|\bverify\b|fact[- ]?check|is (?:that|this|it) true/i.test(text)) return false;
  const haystack = evidence.toLowerCase();
  const terms = topicTerms(state);
  if (terms.length && !terms.some(term => haystack.includes(term))) return false;
  if (/\b(?:power|watt|tdp)\b/i.test(query) && !/\b(?:power|watt|tdp)\b/i.test(evidence)) return false;
  if (/\b(?:price|cost|how much)\b/i.test(query) && !/\b(?:price|cost|\$|€|£)\b/i.test(evidence)) return false;
  if (/\b(?:older|how old|age)\b/i.test(query) && !/\b(?:born|birth|age|years? old)\b/i.test(evidence)) return false;
  if (/\bolder\b/i.test(query) && state.entities.length > 1) {
    if (!state.entities.slice(0, 2).every(entity => haystack.includes(entity.toLowerCase()))) return false;
  }
  if (state.focus === "performance" && !/\b(?:performance|benchmark|fps|score|faster|slower)\b/i.test(evidence)) return false;
  if (state.focus === "availability" && !/\b(?:available|availability|stock|released|shipping)\b/i.test(evidence)) return false;
  if (
    state.focus
    && !["age", "power consumption", "price", "performance", "availability"].includes(state.focus)
    && !haystack.includes(state.focus.toLowerCase())
  ) return false;
  return /^(?:which(?: one)?|who is older|why|how)[!?. ]*$/i.test(text.trim())
    || /\b(?:he|she|it|they|this|that|other one)\b/i.test(text)
    || terms.some(term => haystack.includes(term));
}

function uniqueSources(bundles: SearchBundle[], maximum = 10): SearchSource[] {
  const seen = new Set<string>();
  const result: SearchSource[] = [];
  for (const source of bundles.flatMap(bundle => bundle.sources)) {
    if (!source.url || seen.has(source.url)) continue;
    seen.add(source.url);
    result.push(source);
    if (result.length >= maximum) break;
  }
  return result;
}

async function streamOllamaChat(args: {
  model: string;
  policy: string;
  messages: Array<{ role: string; content: string; images: string[] }>;
  maxTokens: number;
  generationId: string;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}): Promise<string> {
  const { model, policy, messages, maxTokens, generationId, signal, onToken } = args;
  const onEvent = new Channel<StreamEvent>();
  let streamed = "";

  onEvent.onmessage = event => {
    if (event.event === "token" && event.data) {
      streamed += event.data;
      onToken?.(event.data);
    }
  };

  const cancel = () => {
    void invoke("cancel_generation", { generationId }).catch(() => undefined);
  };

  if (signal?.aborted) throw abortError();
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    const result = await invoke<{ content: string }>("ollama_chat_stream", {
      model,
      policy,
      messages,
      maxTokens,
      generationId,
      onEvent
    });
    if (signal?.aborted) throw abortError();
    return result.content?.trim() || streamed.trim();
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export async function answerNth(args: {
  messages: NthMessage[];
  mode: NthMode;
  forceWeb: boolean;
  web: WebSettings;
  topicState?: TopicState;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  onPhase?: (phase: AnswerPhase) => void;
}): Promise<NthAnswer> {
  const { messages, mode, forceWeb, web, topicState: previousTopicState, signal, onToken, onPhase } = args;
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  const text = lastUser?.content ?? "";
  const hasVision = Boolean(lastUser?.attachments?.length);
  const priorMessages = lastUserIndex >= 0 ? messages.slice(0, lastUserIndex) : messages;
  const nextTopicState = deriveTopicState(messages, previousTopicState);
  const parts = decomposePrompt(text, 5);
  const subquestions = parts.length ? parts : [text];
  const baseSearchRequests = subquestions.flatMap(part => {
    const partMessages = subquestions.length === 1
      ? messages
      : [...priorMessages, { role: "user" as const, content: part }];
    const resolved = resolveContextualQuery(partMessages, nextTopicState) || part;
    const requiresWeb = forceWeb || needsWeb(part, priorMessages);
    return requiresWeb ? [{ question: part, query: resolved }] : [];
  });
  const searchRequests = baseSearchRequests.length === 1
    && !isContextualFollowUp(text)
    && nextTopicState.focus === "age"
    && nextTopicState.entities.length > 1
    ? nextTopicState.entities.slice(0, 4).map(entity => ({
        question: baseSearchRequests[0].question,
        query: `${entity} date of birth age of ${entity}`
      }))
    : baseSearchRequests.map(request => ({
        ...request,
        query: nextTopicState.focus === "age" && !/\b(?:how old|age of|date of birth)\b/i.test(request.query)
          ? `${request.query} date of birth age of each person`
          : request.query
      }));
  const resolvedQuery = searchRequests.map(request => request.query).join(" | ") || text;
  const generationId = crypto.randomUUID();

  let sources: SearchSource[] = [];
  let policy = NTH_POLICY_V2;
  let evidence = "";
  let intent = "";
  let contextReused = false;

  const recentVerified = !forceWeb && searchRequests.length === 1
    ? verifiedEvidenceFrom(priorMessages)
    : null;
  if (
    recentVerified
    && canReuseVerifiedContext(text, searchRequests[0].query, nextTopicState, recentVerified.evidence)
  ) {
    contextReused = true;
    sources = recentVerified.sources;
    evidence = recentVerified.evidence;
    policy = verifiedContextPolicy(evidence, searchRequests[0].query)
      + ageGrounding(sources, nextTopicState);
  }

  if (searchRequests.length && !contextReused) {
    onPhase?.("searching");
    const bundles = await Promise.all(searchRequests.map(request => invoke<SearchBundle>("searxng_smart_search", {
      query: request.query,
      searxngUrl: web.searxngUrl,
      maxSources: 6
    })));

    sources = uniqueSources(bundles);
    evidence = bundles.map((bundle, index) => [
      `SUBQUESTION ${index + 1}: ${searchRequests[index].question}`,
      `RESOLVED QUERY: ${searchRequests[index].query}`,
      bundle.evidence
    ].join("\n")).join("\n\n");
    intent = bundles.find(bundle => shouldVerifyWeb(bundle.intent))?.intent || bundles[0]?.intent || "general_fresh";
    const orderingRule = subquestions.length > 1
      ? "\n- Answer every subquestion in the user's original order. Keep the numbering/order clear."
      : "";
    policy = webPolicy(evidence, intent, resolvedQuery) + orderingRule + ageGrounding(sources, nextTopicState);
  }

  if (signal?.aborted) throw abortError();

  const apiMessages = recentAnswerContext(messages).map(message => ({
    role: message.role,
    content: message.content,
    images: (message.attachments ?? [])
      .filter(a => a.mime.startsWith("image/"))
      .map(a => stripDataUrl(a.dataUrl))
  }));

  onPhase?.("generating");
  const draft = await streamOllamaChat({
    model: MODEL_BY_MODE[mode],
    policy,
    messages: apiMessages,
    maxTokens: 512,
    generationId,
    signal,
    onToken
  });

  let finalContent = draft || "No response.";

  // Evidence verification is useful here because the second pass checks supplied
  // web evidence, not the model's own stale memory. It only runs for risky web intents.
  if (searchRequests.length && !contextReused && shouldVerifyWeb(intent)) {
    onPhase?.("verifying");
    const verified = await streamOllamaChat({
      model: MODEL_BY_MODE[mode],
      policy: webVerifierPolicy(evidence, intent),
      messages: [{
        role: "user",
        content: `USER QUESTION:\n${text}\n\nRESOLVED SEARCH CONTEXT:\n${resolvedQuery}\n\nDRAFT ANSWER:\n${finalContent}`,
        images: []
      }],
      maxTokens: 256,
      generationId,
      signal
    });

    if (verified?.trim()) {
      finalContent = verified.trim();
    }
  }

  const route: Route =
    hasVision && searchRequests.length && !contextReused ? "vision+web" :
    hasVision ? "vision" :
    searchRequests.length && !contextReused ? "web" :
    "local";

  return {
    content: finalContent,
    route,
    sources,
    searchQuery: searchRequests.length ? resolvedQuery : undefined,
    contextReused,
    topicState: nextTopicState
  };
}
