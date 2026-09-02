import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { answerNth, classifyNthError, MODEL_BY_MODE } from "../src/lib/nth";
import { createConversation, historyStorageKey, loadConversations, saveConversations } from "../src/lib/history";
import { calculateAge, needsFreshWeb } from "../src/lib/context";
import "./documents.test";

globalThis.window = globalThis;
let store: Map<string, string>;
beforeEach(() => {
  clearMocks();
  store = new Map();
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value); },
    removeItem: key => { store.delete(key); }
  };
  loadConversations(); // Reset the per-launch unreadable-history guard.
});

const args = (text = "Hello") => ({
  operationId: crypto.randomUUID(), mode: "RUN" as const, forceWeb: false,
  web: { searxngUrl: "http://127.0.0.1:8888" },
  messages: [{ role: "user" as const, content: text }]
});
const source = {
  title: "NVIDIA RTX GPU specifications", snippet: "NVIDIA RTX product specifications.",
  url: "https://www.nvidia.com/gpu", domain: "nvidia.com", official: true
};
const bundle = { sources: [source], evidence: "NVIDIA RTX product specifications.", intent: "general" };

test("errors are concise and identify the expected model", () => {
  const model = MODEL_BY_MODE.RUN;
  assert.match(classifyNthError("Ollama connection refused", model).message, /LOCAL is unavailable/);
  assert.match(classifyNthError("Model missing", model).message, /hf.co\/ggml-org/);
  assert.equal(classifyNthError("SearXNG 503: {raw details}", model).kind, "searxng");
  assert.equal(classifyNthError("vision unsupported image", model, true).kind, "vision");
  assert.match(classifyNthError("Web search timed out", model).message, /^Web search timed out/);
});

test("interrupted responses recover in place without replaying the request", () => {
  const chat = createConversation();
  chat.messages = [
    { id: "u", role: "user", content: "Hello", createdAt: 1 },
    { id: "a", role: "assistant", content: "Partial answer", streaming: true, createdAt: 2 }
  ];
  assert.equal(saveConversations([chat]), true);
  const restored = loadConversations()[0];
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[1].id, "a");
  assert.equal(restored.messages[1].streaming, false);
  assert.equal(restored.messages[1].failure?.userMessageId, "u");
  assert.match(restored.messages[1].content, /Partial answer/);
});

test("damaged metadata and malformed entries do not wipe visible chats", () => {
  const chat = createConversation();
  chat.context = { currentExplicitSubject: 42, recentEntities: [null] } as never;
  chat.memory = { version: 1, topics: [null, { subject: false }], evidence: [null] } as never;
  chat.messages = [
    { id: "u", role: "user", content: "Tell me about Tanjiro Kamado", createdAt: 1 },
    null as never,
    { id: "a", role: "assistant", content: "An existing visible answer.", createdAt: 2, sources: [null] as never }
  ];
  store.set(historyStorageKey(), JSON.stringify([chat, createConversation()]));
  const restored = loadConversations();
  assert.equal(restored.length, 2);
  assert.equal(restored[0].messages[1].content, "An existing visible answer.");
  assert.match(restored[0].context!.currentExplicitSubject, /Tanjiro/);
  assert.equal(restored[0].memory!.version, 1);
});

test("unreadable original history is not replaced by an empty startup chat", () => {
  const original = '{"interrupted":';
  store.set(historyStorageKey(), original);
  const recovered = loadConversations();
  assert.equal(saveConversations(recovered), false);
  assert.equal(store.get(historyStorageKey()), original);
});

test("failed atomic writes leave the last saved chat untouched", () => {
  const chat = createConversation();
  assert.equal(saveConversations([chat]), true);
  const previous = store.get(historyStorageKey());
  localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.equal(saveConversations([createConversation()]), false);
  assert.equal(store.get(historyStorageKey()), previous);
});

test("LOCAL requests never depend on SearXNG and keep the configured model", async () => {
  const commands: string[] = [];
  mockIPC((command, payload) => {
    commands.push(command);
    if (command === "ollama_chat_stream") {
      assert.equal(payload.model, MODEL_BY_MODE.RUN);
      return { content: "Hello." };
    }
    throw new Error("SearXNG unavailable");
  });
  assert.equal((await answerNth(args())).content, "Hello.");
  assert.deepEqual(commands, ["ollama_chat_stream"]);
});

test("cancellation before dispatch does not start any work", async () => {
  let calls = 0;
  mockIPC(() => { calls++; });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(answerNth({ ...args(), signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("stopping a stalled stream returns promptly and rejects late tokens", async () => {
  const controller = new AbortController();
  const tokens: string[] = [];
  let channel;
  const cancelled: string[] = [];
  mockIPC((command, payload) => {
    if (command === "cancel_operation") { cancelled.push(payload.operationId); return true; }
    channel = payload.onEvent;
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  });
  await assert.rejects(answerNth({ ...args(), signal: controller.signal, onToken: token => tokens.push(token) }), { name: "AbortError" });
  channel.onmessage({ event: "token", data: "late" });
  assert.deepEqual(tokens, []);
  assert.ok(cancelled.some(id => id.endsWith(":generation")));
});

test("a failed subquestion cancels its sibling and never dispatches queued searches", async () => {
  let searches = 0;
  let generations = 0;
  const cancelled: string[] = [];
  mockIPC((command, payload) => {
    if (command === "cancel_operation") { cancelled.push(payload.operationId); return true; }
    if (command === "ollama_chat_stream") { generations++; return { content: "must not happen" }; }
    searches++;
    if (searches === 1) throw new Error("SearXNG returned no usable results.");
    return new Promise(() => {});
  });
  await assert.rejects(answerNth(args("1. Newest NVIDIA GPU?\n2. Current Minecraft price?\n3. Latest Windows version?")), /no usable results/);
  assert.equal(searches, 2);
  assert.equal(generations, 0);
  assert.ok(cancelled.some(id => id.includes(":search:")));
});

test("transient WEB failure gets one retry with an independent request ID", async () => {
  const requestIds: string[] = [];
  mockIPC((command, payload) => {
    if (command === "searxng_smart_search") {
      requestIds.push(payload.operationId);
      if (requestIds.length === 1) throw new Error("SearXNG temporarily unavailable");
      return bundle;
    }
    return { content: "A grounded answer." };
  });
  const answer = await answerNth(args("What is the newest NVIDIA GPU?"));
  assert.equal(answer.route, "web");
  assert.equal(requestIds.length, 2);
  assert.notEqual(requestIds[0], requestIds[1]);
});

test("WEB failure only falls back when explicitly allowed and labels the answer", async () => {
  let generations = 0;
  mockIPC(command => {
    if (command === "searxng_smart_search") throw new Error("SearXNG returned no usable results.");
    if (command === "ollama_chat_stream") { generations++; return { content: "Potentially stale answer." }; }
    return true;
  });
  await assert.rejects(answerNth(args("What is the newest NVIDIA GPU?")));
  await assert.rejects(answerNth(args("What is the newest NVIDIA GPU? Do not use local fallback.")));
  assert.equal(generations, 0);
  const answer = await answerNth(args("What is the newest NVIDIA GPU? You may answer locally if web fails."));
  assert.equal(answer.route, "local");
  assert.equal(answer.sources.length, 0);
  assert.match(answer.content, /^LOCAL FALLBACK — may be outdated\./);
});

test("vision moves to generating when tokens arrive", async () => {
  const phases: string[] = [];
  mockIPC((command, payload) => {
    if (command === "ollama_chat_stream") {
      payload.onEvent.onmessage({ event: "token", data: "A picture." });
      return { content: "A picture." };
    }
  });
  const request = args("Describe this image.");
  request.messages[0].attachments = [{ id: "image", mime: "image/png", name: "test.png", dataUrl: "data:image/png;base64,test" }];
  await answerNth({ ...request, onPhase: phase => phases.push(phase) });
  assert.deepEqual(phases, ["resolving_context", "vision", "generating"]);
});

test("existing LOCAL routing and date boundaries remain intact", () => {
  assert.equal(needsFreshWeb("How are you?"), false);
  assert.equal(needsFreshWeb("What were we talking about?"), false);
  assert.equal(needsFreshWeb("How good is RTX 5090?"), true);
  assert.equal(calculateAge("1964-09-02", new Date(2026, 8, 1)), 61);
  assert.equal(calculateAge("1964-09-02", new Date(2026, 8, 2)), 62);
});

test("hard generation timeout returns control and cancels the native request", async () => {
  const realTimer = window.setTimeout;
  const cancelled: string[] = [];
  window.setTimeout = ((callback, delay, ...rest) => realTimer(callback, delay >= 40_000 ? 5 : delay, ...rest)) as typeof setTimeout;
  mockIPC((command, payload) => {
    if (command === "cancel_operation") { cancelled.push(payload.operationId); return true; }
    return new Promise(() => {});
  });
  try {
    await assert.rejects(answerNth(args()), /timed out/);
    assert.ok(cancelled.some(id => id.endsWith(":generation")));
  } finally { window.setTimeout = realTimer; }
});

test("verification is cancellable and the next LOCAL request still works", async () => {
  const controller = new AbortController();
  const phases: string[] = [];
  const cancelled: string[] = [];
  mockIPC((command, payload) => {
    if (command === "cancel_operation") { cancelled.push(payload.operationId); return true; }
    if (command === "searxng_smart_search") return { ...bundle, intent: "current_product" };
    if (payload.generationId.endsWith(":verification")) {
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    }
    return { content: "An answer." };
  });
  await assert.rejects(answerNth({ ...args("Newest NVIDIA GPU?"), signal: controller.signal, onPhase: phase => phases.push(phase) }), { name: "AbortError" });
  assert.ok(phases.includes("verifying"));
  assert.ok(cancelled.some(id => id.endsWith(":verification")));
  assert.equal((await answerNth(args())).content, "An answer.");
});
