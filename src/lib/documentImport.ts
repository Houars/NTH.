import type { Attachment } from "./nth";
import { loadDocument, saveDocument } from "./documentStore";
import { validateDocumentFile, type StoredDocument } from "./documents";
import { logDiagnostic } from "./diagnostics";

export async function importDocument(file: File, conversationId: string, signal?: AbortSignal): Promise<Attachment> {
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
    const extracted = await new Promise<Pick<StoredDocument, "pages" | "chunks" | "warning">>((resolve, reject) => {
      const worker = new Worker(new URL("./document.worker.ts", import.meta.url), { type: "module" });
      const cleanup = () => { clearTimeout(timer); worker.terminate(); signal?.removeEventListener("abort", cancel); };
      const cancel = () => { cleanup(); reject(new DOMException("File import cancelled", "AbortError")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("File extraction timed out. Try a smaller file.")); }, 30_000);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      worker.onmessage = event => {
        if (event.data?.nthDocument !== true) return;
        cleanup(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
      };
      worker.onerror = () => { cleanup(); reject(new Error("File extraction failed. Try a smaller file or export it again.")); };
      worker.postMessage({ buffer, pdf: type === "pdf" }, [buffer]);
    });
    if (signal?.aborted) throw new DOMException("File import cancelled", "AbortError");
    document = { ...extracted, id, conversationId, name: file.name, mime: type === "pdf" ? "application/pdf" : "text/plain", size: file.size, blob: file, fingerprint, version: 1 };
    await saveDocument(document);
  }
  if (signal?.aborted) throw new DOMException("File import cancelled", "AbortError");
  logDiagnostic({ operation: "extract_file", durationMs: Math.round(performance.now() - started), route: "file" });
  return { id: crypto.randomUUID(), kind: "document", documentId: id, name: document.name, mime: document.mime, dataUrl: "", size: document.size, pageCount: document.pages.length, warning: document.warning };
}
