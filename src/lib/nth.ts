import { Channel, invoke } from "@tauri-apps/api/core";
import { NTH_POLICY_V2 } from "./policy";

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
};

export type AnswerPhase = "searching" | "generating" | "verifying";

type StreamEvent = {
  event: "token" | "done" | "stopped";
  data?: string;
};

export type WebSettings = {
  searxngUrl: string;
};

const FRESHNESS_PATTERNS = [
  /\b(latest|newest|current|currently|today|tonight|this week|this month|recent|recently)\b/i,
  /\b(price|cost|worth|stock|available|availability|release date|released|launch|version)\b/i,
  /\b(news|weather|forecast|schedule|score|standings|election|president|ceo)\b/i,
  /\bhow old is\b/i,
  /\bwhat(?:'s| is) the newest\b/i,
  /\bwhat(?:'s| is) the latest\b/i
];

export function needsWeb(text: string): boolean {
  return FRESHNESS_PATTERNS.some(pattern => pattern.test(text));
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

function webPolicy(evidence: string, intent: string): string {
  return `${NTH_POLICY_V2}

WEB MODE:
The question requires current or externally verified information.

CURRENT LOCAL DATE: ${localDateString()}
SEARCH INTENT: ${intent}

STRICT WEB RULES:
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
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  onPhase?: (phase: AnswerPhase) => void;
}): Promise<NthAnswer> {
  const { messages, mode, forceWeb, web, signal, onToken, onPhase } = args;
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const text = lastUser?.content ?? "";
  const hasVision = Boolean(lastUser?.attachments?.length);
  const useWeb = forceWeb || needsWeb(text);
  const generationId = crypto.randomUUID();

  let sources: SearchSource[] = [];
  let policy = NTH_POLICY_V2;
  let evidence = "";
  let intent = "";

  if (useWeb) {
    onPhase?.("searching");
    const bundle = await invoke<{
      query: string;
      intent: string;
      search_queries: string[];
      sources: SearchSource[];
      evidence: string;
      engine_warnings: string[];
    }>("searxng_smart_search", {
      query: text,
      searxngUrl: web.searxngUrl,
      maxSources: 6
    });

    sources = bundle.sources;
    evidence = bundle.evidence;
    intent = bundle.intent;
    policy = webPolicy(evidence, intent);
  }

  if (signal?.aborted) throw abortError();

  const apiMessages = messages.map(message => ({
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
  if (useWeb && shouldVerifyWeb(intent)) {
    onPhase?.("verifying");
    const verified = await streamOllamaChat({
      model: MODEL_BY_MODE[mode],
      policy: webVerifierPolicy(evidence, intent),
      messages: [{
        role: "user",
        content: `USER QUESTION:\n${text}\n\nDRAFT ANSWER:\n${finalContent}`,
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
    hasVision && useWeb ? "vision+web" :
    hasVision ? "vision" :
    useWeb ? "web" :
    "local";

  return {
    content: finalContent,
    route,
    sources
  };
}
