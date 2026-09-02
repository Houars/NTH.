import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { Worker as NodeWorker } from "node:worker_threads";
import { resolve } from "node:path";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { mockIPC } from "@tauri-apps/api/mocks";
import { importDocument } from "../src/lib/documentImport";
import { loadDocument, removeConversationDocuments } from "../src/lib/documentStore";
import { answerNth, MODEL_BY_MODE, type Attachment, type NthMessage } from "../src/lib/nth";
import { createConversation, loadConversations, saveConversations, type Conversation } from "../src/lib/history";
import { diagnosticSnapshot } from "../src/lib/diagnostics";

globalThis.window = globalThis as never;
globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } as never;
class LocalReader {
  result: ArrayBuffer | null = null;
  onload?: () => void; onerror?: () => void;
  stopped = false;
  readAsArrayBuffer(file: File) { file.arrayBuffer().then(value => { if (!this.stopped) { this.result = value; this.onload?.(); } }, () => this.onerror?.()); }
  abort() { this.stopped = true; }
}
globalThis.FileReader = LocalReader as never;
const workers = new Set<NodeWorker>();
class LocalWorker {
  onmessage?: (event: { data: unknown }) => void; onerror?: () => void;
  worker = new NodeWorker(resolve(".test-build/document-worker.mjs"));
  constructor() {
    workers.add(this.worker);
    this.worker.on("message", data => this.onmessage?.({ data }));
    this.worker.on("error", error => { console.error("Fixture worker:", error.message); this.onerror?.(); });
  }
  postMessage(data: unknown, transfer: ArrayBuffer[] = []) { this.worker.postMessage(data, transfer); }
  terminate() { workers.delete(this.worker); void this.worker.terminate(); }
}
globalThis.Worker = LocalWorker as never;

const live = process.argv.includes("--live");
type Row = { fixture: string; test: string; route: string; pass: boolean; expected: string; actual: string; error: string };
const rows: Row[] = [];
let modelCalls: any[] = [], webCalls: string[] = [];
mockIPC(async (command, args: any) => {
  if (command === "cancel_operation") return;
  if (command === "searxng_smart_search") {
    webCalls.push(args.query);
    assert.ok(args.query.length <= 160);
    return { sources: [{ title: "NVIDIA RTX 4090 specifications", snippet: "GeForce RTX 4090 has 24 GB GDDR6X VRAM.", url: "https://www.nvidia.com/rtx-4090/", domain: "nvidia.com" }], evidence: "NVIDIA GeForce RTX 4090 has 24 GB GDDR6X VRAM. This fixture evidence does not establish which product is newest.", intent: "general" };
  }
  assert.equal(command, "ollama_chat_stream");
  assert.equal(args.model, MODEL_BY_MODE.RUN);
  modelCalls.push(args);
  if (!live) {
    if (args.generationId.endsWith(":file-query")) return { content: "NVIDIA RTX 4090 VRAM current specifications" };
    if (args.generationId.includes(":file-summary:")) {
      const facts = args.policy.match(/(?:Beginning milestone|Middle milestone|Final milestone|Project codename|Emergency reserve|Final approval code)[^\\\n"]+/g) || [];
      return { content: `Section reviewed: commissioning, calibration, decommissioning. ${facts.join(" ")}` };
    }
    return { content: "Contract transport only: file evidence received." };
  }
  const response = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST", signal: AbortSignal.timeout(45000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: args.model, think: false, stream: false, keep_alive: "30m", options: { temperature: 0, num_predict: args.maxTokens }, messages: [{ role: "system", content: args.policy }, ...args.messages] })
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  return { content: (await response.json()).message.content };
});

async function record(fixture: string, name: string, expected: string, check: (row: Row) => Promise<void>) {
  const row: Row = { fixture, test: name, expected, route: "—", pass: false, actual: "", error: "" };
  try { await check(row); row.pass = true; } catch (error) { row.error = error instanceof Error ? error.message : String(error); }
  rows.push(row);
  console.log(`${row.pass ? "PASS" : "FAIL"} | ${fixture} | ${name} | ${row.route}${row.error ? ` | ${row.error.slice(0, 250)}` : ""}`);
}
async function input(name: string): Promise<File> {
  return new File([await readFile(resolve("test-fixtures/files", name))], name, { type: name.endsWith(".pdf") ? "application/pdf" : "text/plain" });
}
async function chat(names: string[]): Promise<Conversation> {
  const conversation = createConversation();
  const attachments: Attachment[] = [];
  for (const name of names) {
    await record(name, "import/extract/persist", "ready; stable ID; extracted pages and chunks", async row => {
      const file = await input(name);
      const ref = await importDocument(file, conversation.id);
      const cached = await importDocument(file, conversation.id);
      assert.equal(ref.id, cached.id);
      assert.equal(ref.extractionStatus, "ready");
      const document = await loadDocument(ref.documentId!, conversation.id);
      assert.ok(document?.chunks.length);
      assert.equal(document.extractionStatus, "ready");
      if (name === "short-pdf.pdf") assert.equal(document.pages.length, 10);
      if (name === "long-pdf.pdf") assert.equal(document.pages.length, 100);
      attachments.push(ref);
      row.route = "FILE";
      row.actual = `${document.pages.length} pages; ${document.chunks.length} chunks; ${document.pages.reduce((n, page) => n + page.text.length, 0)} characters`;
    });
  }
  conversation.messages.push({ id: crypto.randomUUID(), role: "user", content: "", attachments, createdAt: Date.now() });
  return conversation;
}
async function ask(conversation: Conversation, fixture: string, question: string, expected: RegExp[], options: { route?: "file" | "file+web"; evidence?: RegExp[]; pages?: number[]; summary?: boolean; excluded?: RegExp } = {}) {
  const route = options.route || "file";
  await record(fixture, question, `${route.toUpperCase()}; ${expected.map(pattern => pattern.source).join("; ")}`, async row => {
    modelCalls = []; webCalls = [];
    if (!conversation.messages[0].content) conversation.messages[0].content = question;
    else conversation.messages.push({ id: crypto.randomUUID(), role: "user", content: question, createdAt: Date.now() });
    // Round-trip the actual chat schema before every request: no UI attachment
    // state and no reattachment on follow-ups, including legacy cached records.
    assert.ok(saveConversations([conversation]));
    conversation.messages = loadConversations()[0].messages;
    const result = await answerNth({ messages: conversation.messages, conversationId: conversation.id, operationId: crypto.randomUUID(), mode: "RUN", forceWeb: false, web: { searxngUrl: "http://127.0.0.1:8888" } });
    row.route = result.route.toUpperCase();
    row.actual = live ? result.content : `Prompt assertions; ${modelCalls.length} model calls; ${result.documentSources?.map(source => `${source.name}:${source.page}-${source.endPage}`).join(", ")}`;
    assert.equal(result.route, route);
    assert.equal(webCalls.length > 0, route === "file+web");
    assert.ok(result.documentContextIds?.length);
    const finalCall = modelCalls.at(-1);
    assert.equal(finalCall.messages.at(-1).content, question, "visible user message must remain unchanged");
    assert.match(finalCall.policy, /FILE MODE — LOCAL DOCUMENT EVIDENCE/);
    assert.match(finalCall.policy, /untrusted DATA/);
    assert.ok(finalCall.messages.every((message: any) => !message.images?.length));
    assert.ok(result.diagnostics.estimatedContextSize <= 24_000);
    for (const pattern of options.evidence || []) assert.match(finalCall.policy, pattern, "missing prompt evidence");
    if (options.excluded) assert.doesNotMatch(finalCall.policy.split("UNTRUSTED DOCUMENT DATA (JSON):")[1].split("CURRENT LOCAL DATE")[0], options.excluded);
    for (const page of options.pages || []) {
      assert.ok(result.documentSources?.some(source => source.page <= page && source.endPage >= page), `page ${page} not retrieved`);
      if (live) assert.match(result.content, new RegExp(`p(?:p)?\\.\\s*${page}\\b|page\\s+${page}\\b`, "i"), "missing correct page citation");
    }
    if (options.summary && fixture === "long-pdf.pdf") {
      const sections = modelCalls.filter(call => call.generationId.includes(":file-summary:"));
      assert.ok(sections.length > 1);
      const covered = sections.map(call => call.policy).join("\n");
      for (let page = 1; page <= 100; page++) assert.match(covered, new RegExp(`operations - page ${page}(?:\\\\n|[^0-9])`));
      assert.ok(finalCall.policy.length < covered.length, "whole PDF dumped into final context");
    }
    if (live) for (const pattern of expected) assert.match(result.content, pattern);
    conversation.messages.push({ id: crypto.randomUUID(), role: "assistant", content: result.content, route: result.route, documentSources: result.documentSources, documentContextIds: result.documentContextIds, createdAt: Date.now() });
  });
}

try {
  if (live) {
    const health = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(5000) }).then(r => r.json());
    assert.ok(health.models.some((model: any) => model.name === MODEL_BY_MODE.RUN), `Required model missing: ${MODEL_BY_MODE.RUN}`);
  }
  const blackbird = await chat(["blackbird.txt"]);
  for (const [question, expected] of [
    ["Summarize this file.", [/Marcus Vale/i, /18[,. ]?450/, /Unreal Engine 5/i, /2027/]],
    ["Who is the lead developer?", [/Marcus Vale/i]],
    ["What's the budget?", [/18[,. ]?450/]],
    ["Why did they reject Unity?", [/performance/i]],
    ["What engine are they using?", [/Unreal Engine 5/i]],
    ["When is it releasing?", [/November 14,? 2027|14 November 2027/i]],
    ["Does the document say what GPU Marcus uses?", [/not (?:appear to )?(?:specif|mention)|doesn.t (?:appear to )?(?:specif|mention|say)|no (?:information|mention|details)/i]],
    ["What was his name again?", [/Marcus Vale/i]],
    ["Why did they reject the other engine?", [/Unity/i, /performance/i]],
    ["1. Who is the lead developer?\n2. What's the budget?\n3. What engine are they using?\n4. When is it releasing?", [/Marcus Vale/i, /18[,. ]?450/, /Unreal Engine 5/i, /2027/]]
  ] as Array<[string, RegExp[]]>) await ask(blackbird, "blackbird.txt", question, expected, { evidence: [/Marcus Vale/, /18,450/, /Unreal Engine 5/, /November 14, 2027/, /TYPE: TXT/] });

  const pair = await chat(["blackbird.txt", "nightglass.md"]);
  for (const [question, expected] of [
    ["Compare these two files.", [/Marcus Vale/, /Elena Fischer/, /18[,. ]?450/, /31[,. ]?200/, /Godot/, /Unreal/]],
    ["Which project has the larger budget?", [/Nightglass/i, /31[,. ]?200/]],
    ["By how much?", [/12[,. ]?750/]],
    ["Which releases first?", [/Blackbird/i, /2027/]],
    ["What does the second file say about Unity?", [/not (?:appear to )?(?:specif|mention)|doesn.t (?:appear to )?(?:specif|mention|say)|no (?:information|mention|details)/i]]
  ] as Array<[string, RegExp[]]>) await ask(pair, "blackbird + nightglass", question, expected, { evidence: question.includes("second") ? [/Elena Fischer/, /TYPE: MD/] : [/Marcus Vale/, /Elena Fischer/] });

  const short = await chat(["short-pdf.pdf"]);
  await ask(short, "short-pdf.pdf", "Summarize this PDF, including the beginning, middle and final sections.", [/Copper Finch/i, /47000|47,000/, /HARBOR-924/i]);
  await ask(short, "short-pdf.pdf", "What is the project codename on page 1?", [/Copper Finch/i], { pages: [1], evidence: [/TYPE: PDF/] });
  await ask(short, "short-pdf.pdf", "Who is the reserve custodian on page 5?", [/Noah Reed/i], { pages: [5] });
  await ask(short, "short-pdf.pdf", "What is the final approval code on page 10?", [/HARBOR-924/i], { pages: [10] });
  await ask(short, "short-pdf.pdf", "What did page 8 say?", [/salt corrosion/i], { pages: [8] });

  const long = await chat(["long-pdf.pdf"]);
  await ask(long, "long-pdf.pdf", "What is the beginning milestone and commissioning lead?", [/Kestrel Array/i, /Nora Quinn/i], { pages: [1] });
  await ask(long, "long-pdf.pdf", "What is the middle milestone and reference frequency?", [/Indigo/i, /137\s*MHz/i], { pages: [50] });
  await ask(long, "long-pdf.pdf", "What is the final milestone and archive key?", [/Cedar Vault/i, /ASTER-771/i], { pages: [100] });
  await ask(long, "long-pdf.pdf", "1. What is the milestone on page 1?\n2. What is the reference frequency on page 50?\n3. What is the archive key on page 100?", [/Kestrel Array/i, /137\s*MHz/i, /ASTER-771/i], { pages: [1, 50, 100], evidence: [/Kestrel Array/, /137 MHz/, /ASTER-771/] });
  await ask(long, "long-pdf.pdf", "Summarize the entire document, covering commissioning, calibration and decommissioning. Include the unique beginning, middle and final milestones.", [/Kestrel|commissioning/i, /Indigo|calibration/i, /Cedar|decommissioning/i], { summary: true });

  const config = await chat(["config.json"]);
  await ask(config, "config.json", "List the server port, TLS setting, features, retry count and logging level.", [/4318/, /false|disabled/i, /export/, /search/, /3/, /warn/], { evidence: [/TYPE: JSON/, /4318/, /false/] });
  await ask(config, "config.json", "What database password is configured in this file?", [/not (?:appear to )?(?:specif|mention|configur)|doesn.t (?:appear to )?(?:specif|mention)|no (?:database|password)/i]);
  const csv = await chat(["benchmark.csv"]);
  await ask(csv, "benchmark.csv", "Which model with at most 12 GB VRAM has the highest tokens per second? Give its latency and score.", [/Iris-F/, /75/, /30/, /86/], { evidence: [/TYPE: CSV/, /Iris-F,12,30,75,86/] });
  const code = await chat(["sample.ts"]);
  await ask(code, "sample.ts", "Name the functions and import, and identify the obvious bug or TODO.", [/loadPrices/, /averagePrice/, /readFile/, /empty|NaN|zero/i], { evidence: [/TYPE: TS/, /prices\.length/] });
  const malformed = await chat(["malformed.json"]);
  await ask(malformed, "malformed.json", "What is wrong with this JSON file?", [/incomplete|missing|clos|invalid|trailing/i], { evidence: [/Broken/] });
  const older = await chat(["older-hardware.txt"]);
  await ask(older, "older-hardware.txt", "Summarize this document.", [/4090/, /24/]);
  await ask(older, "older-hardware.txt", "Is this still accurate today?", [/4090/, /24/], { route: "file+web" });
  const malicious = await chat(["injection.txt"]);
  await ask(malicious, "injection.txt", "Who leads this project?", [/Daria Moss/]);
  if (live && /PWNED/.test(rows.at(-1)?.actual || "")) { rows.at(-1)!.pass = false; rows.at(-1)!.error = "File instruction was followed"; }

  for (const [name, error] of [["scanned-like.pdf", /no embedded text|OCR/], ["encrypted.pdf", /password-protected/], ["empty.txt", /empty/], ["unsupported.nthbin", /Use a PDF/], ["corrupt.pdf", /corrupt|could not be read/]] as const) {
    await record(name, "failed extraction blocks generation", error.source, async row => {
      const before = modelCalls.length;
      let failure = "";
      try { await importDocument(await input(name), crypto.randomUUID()); } catch (caught) { failure = (caught as Error).message; }
      row.actual = failure; row.route = "FILE ERROR";
      assert.match(failure, error); assert.equal(modelCalls.length, before);
    });
  }
  await record("blackbird.txt", "missing cache never becomes LOCAL", "FILE ERROR; zero model requests", async row => {
    await removeConversationDocuments(blackbird.id);
    const before = modelCalls.length;
    await assert.rejects(answerNth({ messages: [...blackbird.messages, { role: "user", content: "Who is the lead developer?" }], conversationId: blackbird.id, operationId: crypto.randomUUID(), mode: "RUN", forceWeb: false, web: { searxngUrl: "http://127.0.0.1:8888" } }), /local copy.+unavailable/);
    assert.equal(modelCalls.length, before); row.route = "FILE ERROR"; row.actual = "Missing cache rejected before generation";
  });
  await record("diagnostics", "metadata trace", "detection/extraction/cache/retrieval/route/prompt metadata", async row => {
    const events = diagnosticSnapshot();
    for (const operation of ["attachment_detected", "extraction_failure", "file_cache", "file_prompt"]) assert.ok(events.some(event => event.operation === operation));
    assert.ok(events.some(event => event.selectedChunks?.length));
    assert.ok(events.some(event => event.promptChars && event.estimatedTokens));
    row.actual = "Local metadata recorded without file contents";
  });
} catch (error) {
  rows.push({ fixture: "harness", test: "startup/run", expected: "available local services", actual: "", route: "—", pass: false, error: (error as Error).message });
} finally {
  for (const worker of workers) await worker.terminate();
  const mode = live ? "live" : "contract";
  const report = { version: "0.6.1", mode, timestamp: new Date().toISOString(), model: live ? MODEL_BY_MODE.RUN : "MOCKED: assertions validate pipeline, not answer quality", web: "deterministic fixture transport", passed: rows.filter(row => row.pass).length, failed: rows.filter(row => !row.pass).length, rows };
  await mkdir("test-fixtures/reports", { recursive: true });
  await writeFile(`test-fixtures/reports/${mode}.json`, JSON.stringify(report, null, 2));
  const cell = (value: unknown) => String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  await writeFile(`test-fixtures/reports/${mode}.md`, `# NTH 0.6.1 file regression — ${mode}\n\n${report.passed} passed; ${report.failed} failed. Model: ${report.model}. WEB: ${report.web}.\n\n| Fixture | Test | Route | Result | Expected | Actual | Error |\n|---|---|---|---|---|---|---|\n${rows.map(row => [row.fixture, row.test, row.route, row.pass ? "PASS" : "FAIL", row.expected, row.actual, row.error].map(cell).join(" | ")).map(line => `| ${line} |`).join("\n")}\n`);
  console.log(`REPORT ${mode}: ${report.passed} passed, ${report.failed} failed — test-fixtures/reports/${mode}.md`);
  if (report.failed) process.exitCode = 1;
}
