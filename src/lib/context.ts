export type ContextMessage = {
  role: "user" | "assistant";
  content: string;
};

export type TopicState = {
  topic: string;
  entities: string[];
  focus: string;
};

const RECENT_MESSAGE_LIMIT = 10;

const DIRECT_FRESHNESS_PATTERNS = [
  /\b(latest|newest|current|currently|today|tonight|this week|this month|recent|recently|most recent)\b/i,
  /\b(price|pricing|cost|worth|stock|available|availability|release date|released|launch|version)\b/i,
  /\b(news|breaking|weather|forecast|schedule|score|standings|election|president|ceo)\b/i,
  /\b(how old is|age of|who is older|which (?:person|one) is older)\b/i,
  /\b(best|top\s+\d+|recommend|recommendation|recommended|worth buying|should i buy)\b/i,
  /\b(research|look deeper|dig deeper|look up|verify|fact[- ]?check|is (?:that|this|it) true)\b/i
];

const CURRENT_TECH_PATTERN = /\b(?:rtx\s*\d{3,4}(?:\s*(?:ti|super))?|radeon\s*(?:rx\s*)?\d{3,4}|ryzen\s*\d(?:\s*\d{3,4}[a-z0-9]*)?|intel\s+core\s+(?:ultra\s+)?[3579]\b|core\s+i[3579][- ]?\d{3,5}|apple\s+m\d|snapdragon\s+[a-z0-9+ -]+|windows\s*\d{2}|android\s*\d{1,2}|ios\s*\d{1,2}|macos\s+\d{1,2}|gpt[- ]?\d(?:\.\d+)?|chatgpt|gemma\s*\d|llama\s*\d|claude\s*\d|gemini\s*\d(?:\.\d+)?|ollama\b)\b/i;

const RESEARCH_COMMAND = /^(?:please\s+)?(?:research|look|dig|go)\s+(?:deeper|further|into it|more)(?:\s+(?:on|into)\s+that)?[.!?]*$/i;
const VERIFY_COMMAND = /^(?:please\s+)?(?:verify\s+(?:that|this|it)|is\s+(?:that|this|it)\s+true|fact[- ]?check\s+(?:that|this|it)?)[.!?]*$/i;
const OTHER_ONE_COMMAND = /^(?:and\s+)?(?:what|how)\s+about\s+(?:the\s+)?other\s+one[.!?]*$/i;
const FOLLOW_UP_PATTERN = /^(?:what\s+about\b|and\b|why\b|how\b|which(?:\s+one)?\b|who\s+is\s+older\b|is\s+(?:that|this|it)\b|(?:can you\s+)?verify\b|(?:please\s+)?(?:research|look|dig)\s+(?:deeper|further)|(?:he|she|it|they|this|that|his|her|its|their)\b)/i;
const REFERENTIAL_WORDS = /\b(?:he|she|it|they|this|that|him|her|them|his|its|their|the other one)\b/i;

const CONVERSATION_ONLY_PATTERNS = [
  /^(?:hi|hello|hey|yo|good\s+(?:morning|afternoon|evening)|how are you|how's it going)[!?. ]*$/i,
  /^(?:ok|okay|thanks|thank you|got it|understood|cool|nice|great|alright|sure|fair enough)[!?. ]*$/i,
  /\b(?:tell me (?:a|another) joke|make me laugh|say something funny)\b/i,
  /\b(?:what (?:were|was) we talking about|what did (?:i|you) say|what was (?:the|our) previous topic|did i (?:ask|mention)|did you (?:say|mention))\b/i,
  /^(?:and\s+)?(?:what\s+about\s+)?before that[!?. ]*$/i,
  /\b(?:this|our|the current)\s+(?:chat|conversation)\b/i,
  /\b(?:summari[sz]e|recap)\s+(?:this|our|the)\s+(?:chat|conversation|discussion)\b/i,
  /^(?:what do you mean(?: by (?:that|this|it))?|(?:can|could|would) you (?:clarify|explain|rephrase|expand on) (?:that|this|it|your answer)|clarify that|explain what you meant)[!?. ]*$/i
];

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
  if (/^who\s+is\s+older\b/i.test(value) && extractEntities(value).length) return false;
  return RESEARCH_COMMAND.test(value)
    || VERIFY_COMMAND.test(value)
    || OTHER_ONE_COMMAND.test(value)
    || REFERENTIAL_WORDS.test(value)
    || FOLLOW_UP_PATTERN.test(value);
}

export function isConversationOnlyIntent(text: string): boolean {
  const value = compact(text);
  return CONVERSATION_ONLY_PATTERNS.some(pattern => pattern.test(value));
}

export function needsFreshWeb(
  text: string,
  recentMessages: ContextMessage[] = [],
  now = new Date()
): boolean {
  const value = compact(text);
  if (!value) return false;
  if (isConversationOnlyIntent(value)) return false;
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

export function calculateAge(dateOfBirth: string, now = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1800 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  let age = now.getFullYear() - year;
  if (now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day)) age -= 1;
  return age >= 0 ? age : null;
}

export function decomposePrompt(text: string, maximum = 5): string[] {
  const original = compact(text);
  if (!original) return [];
  const limit = Math.max(2, Math.min(maximum, 6));

  const numbered = [...text.matchAll(/(?:^|\n)\s*(?:\d{1,2}[.)]|[-•])\s+(.+?)(?=\n\s*(?:\d{1,2}[.)]|[-•])\s+|$)/gs)]
    .map(match => trimQuery(match[1]))
    .filter(Boolean);
  const questions = numbered.length >= 2
    ? numbered
    : (text.match(/[^?\n]+\?/g) || []).map(part => trimQuery(part)).filter(Boolean);

  if (questions.length < 2) return [original];
  const distinct = [...new Map(questions.map(question => [question.toLowerCase(), question])).values()];
  return distinct.slice(0, limit);
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

function topicsFromRecentMessages(messages: ContextMessage[]): string[] {
  const userTopics: string[] = [];
  const assistantTopics: string[] = [];
  for (const message of [...messages].reverse()) {
    const entities = extractEntities(message.content);
    const target = message.role === "user" ? userTopics : assistantTopics;
    if (entities.length) target.push(...entities);
    else if (message.role === "user") {
      const fallback = fallbackTopic(message.content);
      if (fallback) target.push(fallback);
    }
  }
  return [...new Set([...userTopics, ...assistantTopics])];
}

function bestRecentTopic(messages: ContextMessage[]): string {
  const topics = topicsFromRecentMessages(messages);
  if (!topics.length) return "";
  const nearest = topics[0];
  const nearestTokens = nearest.toLowerCase().split(/\s+/).filter(token => token.length > 2);
  const expanded = topics.find(topic => {
    const lower = topic.toLowerCase();
    return topic.length > nearest.length && nearestTokens.some(token => lower.includes(token));
  });
  return expanded || nearest;
}

function exactCurrentProductQuery(query: string): string {
  const asksExactCurrent = /\b(?:newest|latest|current|most recent)\b/i.test(query);
  if (!asksExactCurrent) return query;
  if (/\b(?:rtx|geforce)\b/i.test(query) && !/\bnvidia\b/i.test(query)) {
    return trimQuery(`${query.replace(/[?]+$/g, "")} NVIDIA GPU exact currently released model`);
  }
  if (/\bradeon\b/i.test(query) && !/\bamd\b/i.test(query)) {
    return trimQuery(`${query.replace(/[?]+$/g, "")} AMD GPU exact currently released model`);
  }
  return query;
}

function focusFrom(text: string): string {
  const value = compact(text);
  if (/\b(?:how old|age|older|youngest)\b/i.test(value)) return "age";
  if (/\b(?:power consumption|power draw|tdp|wattage|watts?)\b/i.test(value)) return "power consumption";
  if (/\b(?:price|pricing|cost|how much)\b/i.test(value)) return "price";
  if (/\b(?:performance|benchmark|how good|fast)\b/i.test(value)) return "performance";
  if (/\b(?:available|availability|in stock)\b/i.test(value)) return "availability";
  if (/^(?:which(?:\s+one)?|why|how)[!?. ]*$/i.test(value)) return "";

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

export function deriveTopicState(messages: ContextMessage[], previous?: TopicState): TopicState {
  const recent = recentAnswerContext(messages);
  const current = [...recent].reverse().find(message => message.role === "user");
  if (!current || isConversationOnlyIntent(current.content)) {
    return previous || { topic: "", entities: [], focus: "" };
  }

  if (isContextualFollowUp(current.content)) {
    const recentTopics = topicsFromRecentMessages(recent.slice(0, -1)).slice(0, 4);
    const comparison = /^who\s+is\s+older\b/i.test(current.content);
    const entities = comparison
      ? [...new Set([...(previous?.entities || []), ...recentTopics])].slice(0, 4)
      : previous?.entities.length
        ? previous.entities
        : recentTopics;
    const topic = comparison && entities.length >= 2
      ? `${entities[0]} vs ${entities[1]}`
      : previous?.topic || bestRecentTopic(recent.slice(0, -1));
    const explicitFocus = focusFrom(current.content);
    return {
      topic,
      entities,
      focus: RESEARCH_COMMAND.test(current.content) || VERIFY_COMMAND.test(current.content)
        ? previous?.focus || explicitFocus
        : explicitFocus || previous?.focus || ""
    };
  }

  const entities = extractEntities(current.content).slice(0, 4);
  const fallback = fallbackTopic(current.content);
  const topic = entities.length >= 2
    ? `${entities[0]} vs ${entities[1]}`
    : entities[0] || fallback || previous?.topic || "";
  return { topic, entities: entities.length ? entities : previous?.entities || [], focus: focusFrom(current.content) };
}

export function topicTerms(state?: TopicState): string[] {
  if (!state) return [];
  const values = state.entities.length ? state.entities : [state.topic];
  return [...new Set(values
    .flatMap(value => value.toLowerCase().split(/[^a-z0-9]+/i))
    .filter(value => value.length >= 3 && !["the", "and", "with", "versus"].includes(value)))];
}

export function resolveContextualQuery(messages: ContextMessage[], topicState?: TopicState): string {
  let currentIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      currentIndex = index;
      break;
    }
  }
  if (currentIndex < 0) return "";
  const original = trimQuery(messages[currentIndex].content);
  if (!original || isConversationOnlyIntent(original)) return original;
  if (!isContextualFollowUp(original)) return exactCurrentProductQuery(original);

  const prior = messages.slice(Math.max(0, currentIndex - RECENT_MESSAGE_LIMIT), currentIndex);
  if (!prior.length) return original;

  if (OTHER_ONE_COMMAND.test(original)) {
    const other = resolveOtherOne(prior);
    return other || original;
  }

  const topic = topicState?.topic || bestRecentTopic(prior);
  if (!topic) return original;
  const previousUser = [...prior].reverse().find(message => message.role === "user");
  const previousFocus = previousUser ? focusFrom(previousUser.content) : "";

  if (RESEARCH_COMMAND.test(original)) {
    return trimQuery([topic, topicState?.focus || previousFocus, researchSuffix(prior)].filter(Boolean).join(" "));
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
