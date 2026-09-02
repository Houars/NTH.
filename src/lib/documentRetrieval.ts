import { retrieveChunks, type StoredDocument } from "./documents";

export async function retrieveDocumentChunks(documents: StoredDocument[], question: string, recent: string, budget: number, signal?: AbortSignal): Promise<ReturnType<typeof retrieveChunks>> {
  if (signal?.aborted) throw new DOMException("Document retrieval cancelled", "AbortError");
  // The pure implementation is also exercised by the Node regression suite.
  if (typeof Worker === "undefined") return retrieveChunks(documents, question, recent, budget);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./document.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => { clearTimeout(timer); worker.terminate(); signal?.removeEventListener("abort", cancel); };
    const cancel = () => { cleanup(); reject(new DOMException("Document retrieval cancelled", "AbortError")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Document retrieval timed out. Ask about fewer files.")); }, 5000);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    worker.onmessage = event => {
      if (event.data?.nthDocument !== true) return;
      cleanup();
      if (event.data.error) { reject(new Error("Document retrieval failed. Reattach the original file.")); return; }
      resolve(event.data.selection.flatMap((item: { id: string; index: number }) => {
        const document = documents.find(document => document.id === item.id);
        const chunk = document?.chunks.find(chunk => chunk.index === item.index);
        return document && chunk ? [{ document, chunk }] : [];
      }));
    };
    worker.onerror = () => { cleanup(); reject(new Error("Document retrieval failed. Reattach the original file.")); };
    worker.postMessage({ task: "retrieve", documents: documents.map(document => ({ ...document, blob: undefined, pages: [] })), question, recent, budget });
  });
}
