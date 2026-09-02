import type { Attachment } from "./nth";
import { loadDocument, saveDocument } from "./documentStore";
import { validateDocumentFile, type StoredDocument } from "./documents";
import { logDiagnostic } from "./diagnostics";

export async function importDocument(file: File, conversationId: string, signal?: AbortSignal): Promise<Attachment> {
  const started = performance.now();
  logDiagnostic({ operation: "attachment_detected", route: "file", attachmentCount: 1, extractionStatus: "processing" });
  try { return await ingestDocument(file, conversationId, signal); }
  catch (error) {
    logDiagnostic({ operation: "extraction_failure", route: "file", durationMs: Math.round(performance.now() - started), extractionStatus: "error", errorClass: error instanceof Error ? error.name : "FileImportFailure", cancelled: signal?.aborted });
    throw error;
  }
}

async function ingestDocument(file: File, conversationId: string, signal?: AbortSignal): Promise<Attachment> {
  const type = validateDocumentFile(file);
  if (signal?.aborted) throw new DOMException("File import cancelled", "AbortError");
  const started = performance.now();
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    const cancel = () => { cleanup(); reader.abort(); reject(new DOMException("File import cancelled", "AbortError")); };
    const timer = setTimeout(() => { cleanup(); reader.abort(); reject(new Error("File reading timed out. Retry with a local copy.")); }, 10_000);
    reader.onload = () => { cleanup(); resolve(reader.result as ArrayBuffer); };
    reader.onerror = () => { cleanup(); reject(new Error("That file is unavailable. Choose it again.")); };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    reader.readAsArrayBuffer(file);
  });
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  const fingerprint = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  const id = `${conversationId}:${fingerprint}:${encodeURIComponent(file.name)}`;
  let document: StoredDocument | undefined;
  // Reattaching an original is the recovery path for damaged cache metadata.
  try { document = await loadDocument(id, conversationId); } catch { document = undefined; }
  if (!document) {
    logDiagnostic({ operation: "extraction_start", route: "file", extractionStatus: "processing" });
    const extracted = await new Promise<Pick<StoredDocument, "pages" | "chunks" | "warning">>((resolve, reject) => {
      const worker = new Worker(new URL("./document.worker.ts", import.meta.url), { type: "module" });
      const cleanup = () => { clearTimeout(timer); worker.terminate(); signal?.removeEventListener("abort", cancel); };
      const cancel = () => { cleanup(); reject(new DOMException("File import cancelled", "AbortError")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("File extraction timed out. Try a smaller file.")); }, 30_000);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      worker.onmessage = event => {
        if (event.data?.nthDocument !== true) return;
        cleanup();
        if (event.data.error) { const error = new Error(event.data.error); error.name = event.data.errorClass || "ExtractionError"; reject(error); }
        else resolve(event.data);
      };
      worker.onerror = () => { cleanup(); reject(new Error("File extraction failed. Try a smaller file or export it again.")); };
      worker.postMessage({ buffer, pdf: type === "pdf" }, [buffer]);
    });
    if (signal?.aborted) throw new DOMException("File import cancelled", "AbortError");
    if (!extracted.pages?.length || !extracted.chunks?.length) throw new Error("File extraction returned no text. Reattach a readable copy.");
    document = { ...extracted, id, conversationId, name: file.name, mime: type === "pdf" ? "application/pdf" : "text/plain", size: file.size, blob: file, fingerprint, version: 1, extractionStatus: "ready" };
    await saveDocument(document);
  }
  if (signal?.aborted) throw new DOMException("File import cancelled", "AbortError");
  const extractedChars = document.pages.reduce((total, page) => total + page.text.length, 0);
  logDiagnostic({ operation: "extraction_end", durationMs: Math.round(performance.now() - started), route: "file", extractionStatus: "ready", extractedChars, estimatedTokens: Math.ceil(extractedChars / 4), pageCount: document.pages.length, chunkCount: document.chunks.length });
  return { id, kind: "document", documentId: id, extractionStatus: "ready", name: document.name, mime: document.mime, dataUrl: "", size: document.size, pageCount: document.pages.length, warning: document.warning };
}
