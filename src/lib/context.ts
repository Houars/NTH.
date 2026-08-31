export type ContextMessage = {
  role: "user" | "assistant";
  content: string;
};

const RECENT_MESSAGE_LIMIT = 10;

const DIRECT_FRESHNESS_PATTERNS = [
  /\b(latest|newest|current|currently|today|tonight|this week|this month|recent|recently|most recent)\b/i,
  /\b(price|pricing|cost|worth|stock|available|availability|release date|released|launch|version)\b/i,
  /\b(news|breaking|weather|forecast|schedule|score|standings|election|president|ceo)\b/i,
  /\b(how old is|age of)\b/i,
  /\b(best|top\s+\d+|recommend|recommendation|recommended|worth buying|should i buy)\b/i,
  /\b(research|look deeper|dig deeper|look up|verify|fact[- ]?check|is (?:that|this|it) true)\b/i
];

const CURRENT_TECH_PATTERN = /\b(?:rtx\s*\d{3,4}(?:\s*(?:ti|super))?|radeon\s*(?:rx\s*)?\d{3,4}|ryzen\s*\d(?:\s*\d{3,4}[a-z0-9]*)?|intel\s+core\s+(?:ultra\s+)?[3579]\b|core\s+i[3579][- ]?\d{3,5}|apple\s+m\d|snapdragon\s+[a-z0-9+ -]+|windows\s*\d{2}|android\s*\d{1,2}|ios\s*\d{1,2}|macos\s+\d{1,2}|gpt[- ]?\d(?:\.\d+)?|chatgpt|gemma\s*\d|llama\s*\d|claude\s*\d|gemini\s*\d(?:\.\d+)?|ollama\b)\b/i;

const RESEARCH_COMMAND = /^(?:please\s+)?(?:research|look|dig|go)\s+(?:deeper|further|into it|more)(?:\s+(?:on|into)\s+that)?[.!?]*$/i;
const VERIFY_COMMAND = /^(?:please\s+)?(?:verify\s+(?:that|this|it)|is\s+(?:that|this|it)\s+true|fact[- ]?check\s+(?:that|this|it)?)[.!?]*$/i;
const OTHER_ONE_COMMAND = /^(?:and\s+)?(?:what|how)\s+about\s+(?:the\s+)?other\s+one[.!?]*$/i;
const FOLLOW_UP_PATTERN = /^(?:what\s+about\b|and\b|why\b|how\b|is\s+(?:that|this|it)\b|(?:can you\s+)?verify\b|(?:please\s+)?(?:research|look|dig)\s+(?:deeper|further)|(?:he|she|it|they|this|that|his|her|its|their)\b)/i;
const REFERENTIAL_WORDS = /\b(?:he|she|it|they|this|that|him|her|them|his|its|their|the other one)\b/i;

const ENTITY_PATTERNS = [
  /\b(?:nvidia\s+)?(?:geforce\s+)?rtx\s+\d{3,4}(?:\s+(?:ti|super))?\b/gi,
  /\b(?:amd\s+)?radeon\s+(?:rx\s+)?\d{3,4}(?:\s+xtx?|\s+gre)?\b/gi,
  /\b(?:amd\s+)?ryzen\s+\d(?:\s+\d{3,4}[a-z0-9]*)?\b/gi,
  /\b(?:apple\s+)?m\d(?:\s+(?:pro|max|ultra))?\b/gi,
  /\b(?:gpt|gemma|llama|claude|gemini)[- ]?\d+(?:\.\d+)?(?:\s+[a-z0-9]+)?\b/gi,
  /\b(?:windows|android|ios|macos)\s+\d+(?:\.\d+)?\b/gi
];

const GENERIC_ENTITY_PREFIXES = new Set([
  "how old",
  "how good",
  "what about",
  "what is",
  "who is",
  "research deeper",
  "look deeper",
  "official sources"
]);

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimQuery(text: string): string {
  const normalized = compact(text).replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, "");
  return normalized.length > 220 ? normalized.slice(0, 220).trimEnd() : normalized;
}

export function isContextualFollowUp(text: string): boolean {
  const value = compact(text);
  return RESEARCH_COMMAND.test(value)
    || VERIFY_COMMAND.test(value)
    || OTHER_ONE_COMMAND.test(value)
    || REFERENTIAL_WORDS.test(value)
    || FOLLOW_UP_PATTERN.test(value);
}

export function needsFreshWeb(
  text: string,
  recentMessages: ContextMessage[] = [],
  now = new Date()
): boolean {
  const value = compact(text);
  if (!value) return false;
  if (DIRECT_FRESHNESS_PATTERNS.some(pattern => pattern.test(value))) return true;
  if (CURRENT_TECH_PATTERN.test(value)) return true;
  if (new RegExp(`\\b${now.getFullYear()}\\b`).test(value)) return true;

  if (isContextualFollowUp(value)) {
    const recent = recentMessages
      .slice(-RECENT_MESSAGE_LIMIT)
      .map(message => message.content)
      .join(" ");
    return CURRENT_TECH_PATTERN.test(recent)
      || DIRECT_FRESHNESS_PATTERNS.some(pattern => pattern.test(recent));
  }

  return false;
}

export function recentAnswerContext<T extends ContextMessage>(messages: T[]): T[] {
  return messages
    .filter(message => compact(message.content).length > 0)
    .slice(-RECENT_MESSAGE_LIMIT);
}

function extractEntities(text: string): string[] {
  const entities: string[] = [];
  for (const pattern of ENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) entities.push(compact(match[0]));
  }

  const properNames = text.match(/\b[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,}(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,}){1,3}\b/g) || [];
  for (const name of properNames) {
    if (
      !GENERIC_ENTITY_PREFIXES.has(name.toLowerCase())
      && !/^(?:compare|tell|explain|describe|research|verify|how|what|who|is|are)\b/i.test(name)
    ) entities.push(compact(name));
  }

  return [...new Set(entities.map(entity => entity.replace(/[?!.,]+$/g, "")))];
}

function fallbackTopic(text: string): string {
  if (isContextualFollowUp(text)) return "";
  const normalized = trimQuery(text)
    .replace(/^(?:please\s+)?(?:tell me about|explain|describe|research|look up)\s+/i, "")
    .replace(/\b(?:age|price|pricing|power consumption|power draw|tdp|performance|availability)\b.*$/i, "")
    .replace(/[?!]+$/g, "")
    .trim();
  if (!normalized || normalized.length > 80 || normalized.split(/\s+/).length > 7) return "";
  if (/^(?:what|who|when|where|why|how|is|are|do|does|can|could|would)\b/i.test(normalized)) return "";
  return normalized;
}

function topicsFromRecentUsers(messages: ContextMessage[]): string[] {
  const topics: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    const entities = extractEntities(message.content);
    if (entities.length) topics.push(...entities);
    else {
      const fallback = fallbackTopic(message.content);
      if (fallback) topics.push(fallback);
    }
  }
  return [...new Set(topics)];
}

function bestRecentTopic(messages: ContextMessage[]): string {
  const topics = topicsFromRecentUsers(messages);
  if (!topics.length) return "";
  const nearest = topics[0];
  const nearestTokens = nearest.toLowerCase().split(/\s+/).filter(token => token.length > 2);
  const expanded = topics.find(topic => {
    const lower = topic.toLowerCase();
    return topic.length > nearest.length && nearestTokens.some(token => lower.includes(token));
  });
  return expanded || nearest;
}

function focusFrom(text: string): string {
  const value = compact(text);
  if (/\b(?:how old|age)\b/i.test(value)) return "age";
  if (/\b(?:power consumption|power draw|tdp|wattage|watts?)\b/i.test(value)) return "power consumption";
  if (/\b(?:price|pricing|cost|how much)\b/i.test(value)) return "price";
  if (/\b(?:performance|benchmark|how good|fast)\b/i.test(value)) return "performance";
  if (/\b(?:available|availability|in stock)\b/i.test(value)) return "availability";

  const remainder = value
    .replace(/^(?:and\s+)?what\s+about\s+/i, "")
    .replace(/\b(?:he|she|it|they|this|that|him|her|them|his|its|their|the other one)\b/gi, "")
    .replace(/[?!.,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return remainder.length >= 3 && remainder.length <= 70 ? remainder : "";
}

function lastAssistantClaim(messages: ContextMessage[]): string {
  const answer = [...messages].reverse().find(message => message.role === "assistant" && compact(message.content));
  if (!answer) return "";
  const firstSentence = compact(answer.content)
    .replace(/\[[^\]]+\]/g, "")
    .split(/(?<=[.!?])\s+/)[0]
    .replace(/[*_`#]/g, "")
    .trim();
  if (firstSentence.length < 8) return "";
  return firstSentence.length > 150 ? `${firstSentence.slice(0, 149).trimEnd()}…` : firstSentence;
}

function resolveOtherOne(messages: ContextMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    const pair = extractEntities(messages[index].content);
    if (pair.length !== 2) continue;
    const later = messages.slice(index + 1).map(message => message.content.toLowerCase()).join(" ");
    const mentioned = pair.filter(entity => later.includes(entity.toLowerCase()));
    if (mentioned.length !== 1) return "";
    return pair.find(entity => entity !== mentioned[0]) || "";
  }
  return "";
}

function researchSuffix(messages: ContextMessage[]): string {
  const recent = messages.map(message => message.content).join(" ");
  return /\b(?:anime|manga|character|demon slayer|tanjiro|kamado)\b/i.test(recent)
    ? "official sources manga anime character profile"
    : "official primary sources detailed analysis";
}

export function resolveContextualQuery(messages: ContextMessage[]): string {
  let currentIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      currentIndex = index;
      break;
    }
  }
  if (currentIndex < 0) return "";
  const original = trimQuery(messages[currentIndex].content);
  if (!original || !isContextualFollowUp(original)) return original;

  const prior = messages.slice(Math.max(0, currentIndex - RECENT_MESSAGE_LIMIT), currentIndex);
  if (!prior.length) return original;

  if (OTHER_ONE_COMMAND.test(original)) {
    const other = resolveOtherOne(prior);
    return other || original;
  }

  const topic = bestRecentTopic(prior);
  if (!topic) return original;
  const previousUser = [...prior].reverse().find(message => message.role === "user");
  const previousFocus = previousUser ? focusFrom(previousUser.content) : "";

  if (RESEARCH_COMMAND.test(original)) {
    return trimQuery([topic, previousFocus, researchSuffix(prior)].filter(Boolean).join(" "));
  }

  if (VERIFY_COMMAND.test(original)) {
    const claim = lastAssistantClaim(prior);
    return trimQuery([topic, claim, "official sources verification"].filter(Boolean).join(" "));
  }

  if (/^(?:and\s+)?what\s+about\b/i.test(original)) {
    const focus = focusFrom(original);
    return focus ? trimQuery(`${topic} ${focus}`) : original;
  }

  if (/\bhow old\b/i.test(original)) return `How old is ${topic}?`;

  if (/^(?:why|how)[?!]*$/i.test(original)) {
    const claim = lastAssistantClaim(prior);
    return claim ? trimQuery(`${topic} ${claim} ${original}`) : trimQuery(`${topic} ${original}`);
  }

  if (/^and\b/i.test(original)) {
    const remainder = original.replace(/^and\b/i, "").trim();
    return remainder ? trimQuery(`${topic} ${remainder}`) : original;
  }

  if (REFERENTIAL_WORDS.test(original)) {
    return trimQuery(original
      .replace(/\b(?:his|her|its|their)\b/gi, topic)
      .replace(/\b(?:he|she|it|they|this|that|him|her|them)\b/gi, topic));
  }

  return original;
}
