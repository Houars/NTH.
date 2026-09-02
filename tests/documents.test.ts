import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { mockIPC } from "@tauri-apps/api/mocks";
import { answerNth, type Attachment, type NthMessage } from "../src/lib/nth";
import { chunkPages, documentInventory, fileNeedsFreshWeb, resolveDocumentScope, retrieveChunks, summaryBatches, validateDocumentFile, type StoredDocument } from "../src/lib/documents";
import { loadDocument, removeConversationDocuments, saveDocument } from "../src/lib/documentStore";
import { createComposerFocus } from "../src/lib/composerFocus";
import { createConversation, loadConversations, saveConversations } from "../src/lib/history";

function doc(id = "notes", text = "The recommended GPU is RTX 5090. It has 32 GB of VRAM.", pages = 1): StoredDocument {
  const pageList = Array.from({ length: pages }, (_, index) => ({ page: index + 1, text: `${text} Section ${index + 1}.` }));
  return { id, conversationId: "chat", name: `${id}.pdf`, mime: "application/pdf", size: 500, fingerprint: id, version: 1, blob: new Blob([text]), pages: pageList, chunks: chunkPages(pageList) };
}
const ref = (id = "notes"): Attachment => ({ id, documentId: id, kind: "document", name: `${id}.pdf`, mime: "application/pdf", dataUrl: "", size: 500 });
function args(text = "Summarize this PDF.") {
  return { operationId: crypto.randomUUID(), conversationId: "chat", mode: "RUN" as const, forceWeb: false, web: { searxngUrl: "http://127.0.0.1:8888" }, messages: [{ role: "user" as const, content: text, attachments: [ref()] }] };
}
async function seed(document = doc()) {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  await saveDocument(document);
}

test("document validation rejects unsupported, empty and oversized inputs", () => {
  assert.equal(validateDocumentFile({ name: "source.rs", type: "", size: 20 }), "text");
  assert.equal(validateDocumentFile({ name: "MANUAL.PDF", type: "", size: 20 }), "pdf");
  assert.throws(() => validateDocumentFile({ name: "data.xlsx", type: "", size: 20 }), /Use a PDF/);
  assert.throws(() => validateDocumentFile({ name: "empty.txt", type: "", size: 0 }), /empty/);
  assert.throws(() => validateDocumentFile({ name: "large.pdf", type: "", size: 21 * 1024 * 1024 }), /20 MB/);
});

test("chunking retains every section and page; retrieval finds later-page evidence within budget", () => {
  const document = doc("manual", "Background unrelated details. ".repeat(90), 14);
  document.pages[13].text = "VRAM recommendation: 32 GB for the flagship graphics card.";
  document.chunks = chunkPages(document.pages);
  const selected = retrieveChunks([document], "What does it recommend about VRAM?", "", 2000);
  assert.ok(selected.some(item => item.chunk.page === 14));
  assert.ok(selected.reduce((sum, item) => sum + item.chunk.text.length + item.document.name.length + 60, 0) <= 2000);
  const batches = summaryBatches([document], 4000);
  assert.deepEqual(batches.flat().map(item => item.chunk.index), document.chunks.map(chunk => chunk.index));
  assert.equal(batches.at(-1)!.at(-1)!.chunk.page, 14);
});

test("file scope survives long history, resolves ordinal/name references, and ends on topic changes", () => {
  const messages: NthMessage[] = [{ role: "user", content: "Read these", attachments: [ref(), ref("manual")] },
    { role: "assistant", content: "A summary", route: "file", documentSources: [{ documentId: "notes", name: "notes.pdf", page: 1, endPage: 1, pdf: true }] }];
  for (const text of ["What GPU did they recommend?", "Why?", "What did it say about VRAM?"]) {
    assert.deepEqual(resolveDocumentScope([...messages, { role: "user", content: text }]).map(item => item.documentId), ["notes"]);
  }
  assert.equal(resolveDocumentScope([...messages, { role: "user", content: "the second file" }])[0].documentId, "manual");
  assert.equal(resolveDocumentScope([...messages, { role: "user", content: "now Minecraft" }]).length, 0);
  assert.equal(resolveDocumentScope([...messages, { role: "user", content: "What were we talking about?" }]).length, 0);
  assert.equal(resolveDocumentScope([...messages, { role: "user", content: "How are you?" }]).length, 0);
  assert.equal(resolveDocumentScope([...messages, { role: "user", content: "How good is RTX 5090?" }]).length, 0);
  const long = [...messages, ...Array.from({ length: 30 }, () => ({ role: "assistant" as const, content: "Unrelated topic", route: "local" as const }))];
  assert.equal(resolveDocumentScope([...long, { role: "user", content: "Summarize manual.pdf" }])[0].documentId, "manual");
  assert.equal(documentInventory(long).length, 2);
  assert.equal(resolveDocumentScope([...long, { role: "user", content: "Why?" }]).length, 0);
  messages[1].documentContextIds = [];
  assert.equal(resolveDocumentScope([...messages, { role: "user", content: "Why?" }])[0].documentId, "notes");
});

test("file routing only adds WEB for external freshness, not internal recommendations", () => {
  for (const text of ["Summarize this PDF", "What did it recommend as the best GPU?", "Research its argument in depth", "What price did it mention?"]) assert.equal(fileNeedsFreshWeb(text), false);
  for (const text of ["Is this information still accurate?", "Compare this document with current RTX 5090 information", "Verify this online"]) assert.equal(fileNeedsFreshWeb(text), true);
});

test("v0.6.1 unqualified file questions retain persisted focus without keyword gates", () => {
  const messages: NthMessage[] = [{ role: "user", content: "Summarize this file", attachments: [ref()] },
    { role: "assistant", content: "Marcus Vale leads Blackbird.", route: "file", documentContextIds: ["notes"] }];
  for (const question of ["Who is the lead developer?", "What's the budget?", "What was his name again?", "By how much?", "Which releases first?", "What did page 8 say?"]) {
    assert.equal(resolveDocumentScope([...messages, { role: "user", content: question }])[0]?.documentId, "notes", question);
  }
  assert.equal(resolveDocumentScope([...messages, { role: "user", content: "How good is RTX 5090?" }]).length, 0);
  const failedSwitch: NthMessage[] = [...messages, { role: "user", content: "Forget the files. Now GPUs." }, { role: "assistant", content: "Search failed", error: true }, { role: "user", content: "Why?" }];
  assert.equal(resolveDocumentScope(failedSwitch).length, 0);
});

test("pending and malformed file records fail before any model request", async () => {
  await seed(); let calls = 0;
  mockIPC(() => { calls++; return { content: "must not run" }; });
  for (const file of [{ ...ref(), extractionStatus: "processing" as const }, { ...ref(), documentId: undefined }]) {
    await assert.rejects(answerNth({ ...args(), messages: [{ role: "user", content: "Who is the lead developer?", attachments: [file] }] }), /incomplete|local copy/);
  }
  assert.equal(calls, 0);
});

test("recovery keeps damaged document references visible rather than dropping file intent", () => {
  const chat = createConversation();
  chat.messages = [{ id: "u", role: "user", content: "Summarize this file", createdAt: 1, attachments: [{ ...ref(), dataUrl: undefined, mime: undefined } as never] }];
  assert.ok(saveConversations([chat]));
  const restored = loadConversations()[0].messages[0];
  assert.equal(restored.attachments?.[0].documentId, "notes");
  assert.equal(resolveDocumentScope([restored]).length, 1);
});

test("document cache transactions are conversation-scoped and retain blobs/pages", async () => {
  await seed();
  assert.equal((await loadDocument("notes", "chat"))?.pages[0].page, 1);
  assert.equal(await loadDocument("notes", "different-chat"), undefined);
  await removeConversationDocuments("different-chat");
  assert.ok(await loadDocument("notes", "chat"));
  await removeConversationDocuments("chat");
  assert.equal(await loadDocument("notes", "chat"), undefined);
});

test("FILE answers use local evidence, keep images out of the vision path, and budget context", async () => {
  await seed();
  const calls: any[] = [], phases: string[] = [];
  mockIPC((command, payload) => {
    assert.equal(command, "ollama_chat_stream"); calls.push(payload);
    return { content: "32 GB [notes.pdf · p. 1]" };
  });
  const result = await answerNth({ ...args("What GPU did this file recommend?"), onPhase: phase => phases.push(phase) });
  assert.equal(result.route, "file");
  assert.equal(calls.length, 1);
  assert.match(calls[0].policy, /32 GB/);
  assert.match(calls[0].policy, /untrusted DATA/);
  assert.equal(calls[0].messages[0].images.length, 0);
  assert.ok(phases.includes("reading_files"));
  assert.ok(!phases.includes("vision"));
  assert.ok(result.diagnostics.estimatedContextSize <= 24_000);
  assert.equal(result.documentSources?.[0].page, 1);
});

test("multi-section summaries cover the final page before producing the answer", async () => {
  await seed(doc("notes", "Important source terminology and qualifications. ".repeat(50), 12));
  const passes: any[] = [];
  mockIPC((command, payload) => { assert.equal(command, "ollama_chat_stream"); passes.push(payload); return { content: "Section notes [notes.pdf · p. 12]" }; });
  const result = await answerNth(args());
  assert.ok(passes.length > 2);
  assert.ok(passes.slice(0, -1).some(pass => pass.policy.includes("Section 12.")));
  assert.match(passes.at(-1).policy, /All \d+ sections were processed/);
  assert.equal(result.documentSources?.[0].endPage, 12);
  assert.ok(result.diagnostics.estimatedContextSize <= 24_000);
});

test("JSON/code escape characters cannot overflow the document context budget", async () => {
  await seed(doc("notes", '"\\\\\\\\ code \\n'.repeat(8000)));
  mockIPC(() => ({ content: "The supplied code excerpt does not specify that." }));
  const result = await answerNth(args("What does this file contain?"));
  assert.ok(result.diagnostics.estimatedContextSize <= 24_000);
});

test("missing document fails clearly without searching or hallucinating", async () => {
  await seed(); await removeConversationDocuments("chat");
  let modelCalls = 0;
  mockIPC(command => { if (command === "ollama_chat_stream") modelCalls++; });
  await assert.rejects(answerNth(args()), /local copy.+unavailable/);
  assert.equal(modelCalls, 0);
});

test("FILE plus WEB uses short resolved queries and retains both evidence sets", async () => {
  await seed();
  let searchCount = 0, generationCount = 0;
  mockIPC((command, payload: any) => {
    if (command === "searxng_smart_search") {
      searchCount++;
      assert.ok(payload.query.length < 160);
      assert.equal(payload.query, "NVIDIA RTX 5090 VRAM specifications");
      return { sources: [{ title: "NVIDIA RTX 5090 specifications", snippet: "32 GB VRAM", url: "https://www.nvidia.com/specs", domain: "nvidia.com" }], evidence: "NVIDIA RTX 5090: 32 GB VRAM", intent: "general" };
    }
    assert.equal(command, "ollama_chat_stream");
    generationCount++;
    if (generationCount === 1) return { content: "NVIDIA RTX 5090 VRAM specifications" };
    assert.match(payload.policy, /WEB EVIDENCE/);
    assert.match(payload.policy, /UNTRUSTED DOCUMENT DATA/);
    return { content: "The file matches the current specification [notes.pdf · p. 1]." };
  });
  const result = await answerNth(args("Is this information still accurate?"));
  assert.equal(result.route, "file+web"); assert.equal(searchCount, 1);
  assert.ok(result.documentSources?.length); assert.ok(result.sources.length);
  assert.ok(result.diagnostics.estimatedContextSize <= 24_000);
});

test("combined WEB failure cannot silently turn into a FILE answer", async () => {
  await seed(); let generations = 0;
  mockIPC(command => {
    if (command === "ollama_chat_stream") { generations++; return { content: "RTX 5090 specifications" }; }
    if (command === "searxng_smart_search") throw new Error("SearXNG no useful evidence");
  });
  await assert.rejects(answerNth(args("Compare this with current RTX 5090 specifications")), /SearXNG/);
  assert.equal(generations, 1); // Only local query resolution, no unsupported answer.
});

test("document cache corruption is readable and never silently passed to the model", async () => {
  const corrupted = doc(); corrupted.pages = [null] as never;
  await seed(corrupted);
  await assert.rejects(loadDocument("notes", "chat"), /cache is unreadable/);
});

test("cancelled section processing cannot start later sections or final generation", async () => {
  await seed(doc("notes", "A section with important facts. ".repeat(80), 12));
  const controller = new AbortController();
  let modelCalls = 0;
  mockIPC(command => {
    if (command === "cancel_operation") return;
    modelCalls++; controller.abort(); return new Promise(() => undefined);
  });
  await assert.rejects(answerNth({ ...args(), signal: controller.signal }), /stopped/);
  assert.equal(modelCalls, 1);
});

test("chat recovery preserves file associations and citation pages", () => {
  const chat = createConversation();
  chat.messages = [{ id: "u", role: "user", content: "Read", attachments: [ref()], createdAt: 1 },
    { id: "a", role: "assistant", content: "Summary", route: "file", documentSources: [{ documentId: "notes", name: "notes.pdf", page: 2, endPage: 3, pdf: true }], createdAt: 2 }];
  assert.ok(saveConversations([chat]));
  assert.equal(loadConversations()[0].messages[0].attachments?.[0].documentId, "notes");
  assert.equal(loadConversations()[0].messages[1].documentSources?.[0].endPage, 3);
});

test("composer restores only owned focus and never overrides selection, Settings or other controls", () => {
  const listeners = new Map<string, (event: any) => void>();
  let count = 0, blocked = false, selection = false;
  const composer = { focus: (options: any) => { assert.equal(options.preventScroll, true); count++; document.activeElement = composer; } };
  globalThis.document = { body: {}, activeElement: null, hasFocus: () => true,
    addEventListener: (type: string, cb: any) => listeners.set(type, cb), removeEventListener() {} } as never;
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  globalThis.window.getSelection = () => ({ isCollapsed: !selection }) as Selection;
  const focus = createComposerFocus(() => composer as never, () => blocked);
  const disconnect = focus.connect();
  focus.claim(); assert.equal(count, 1);
  listeners.get("pointerdown")!({ target: {} }); document.activeElement = document.body;
  focus.restore(); assert.equal(count, 1);
  focus.claim(); assert.equal(count, 2);
  listeners.get("keydown")!({ key: "Tab" }); document.activeElement = document.body;
  focus.restore(); assert.equal(count, 2);
  blocked = true; focus.claim(); assert.equal(count, 2);
  blocked = false; selection = true; focus.claim(); assert.equal(count, 2);
  disconnect();
});
