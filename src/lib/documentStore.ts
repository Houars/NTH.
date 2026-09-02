import type { Attachment } from "./nth";
import { type StoredDocument } from "./documents";
import { logDiagnostic } from "./diagnostics";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("nth.documents.v1", 1);
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error("Local file storage is unavailable. Close other NTH windows and retry.")); }, 5000);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("documents", { keyPath: "id" });
      store.createIndex("conversation", "conversationId");
    };
    request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
    request.onerror = () => { clearTimeout(timer); reject(new Error("Local file storage is unavailable. Retry?")); };
  });
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("documents", mode);
    let value: T;
    const timer = setTimeout(() => { try { tx.abort(); } catch { /* already closed */ } }, 8000);
    tx.oncomplete = () => { clearTimeout(timer); db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { clearTimeout(timer); db.close(); reject(new Error("The file could not be saved or read locally. Check free disk space, then retry.")); };
    action(tx.objectStore("documents"), result => { value = result; });
  });
}
export const saveDocument = (document: StoredDocument) => transaction<void>("readwrite", (store, done) => { store.put(document); done(); });
export async function loadDocument(id: string, conversationId: string): Promise<StoredDocument | undefined> {
  const document = await transaction<StoredDocument | undefined>("readonly", (store, done) => { const request = store.get(id); request.onsuccess = () => done(request.result); });
  if (!document || document.conversationId !== conversationId) { logDiagnostic({ operation: "file_cache", cache: "miss" }); return undefined; }
  if (document.version !== 1 || typeof document.name !== "string" || !["application/pdf", "text/plain"].includes(document.mime)
    || !Array.isArray(document.chunks) || !document.chunks.length || !Array.isArray(document.pages) || !document.pages.length || document.pages.length > 500 || !(document.blob instanceof Blob)
    || !document.pages.every((page, index) => page && page.page === index + 1 && typeof page.text === "string")
    || !document.chunks.every((chunk, index) => chunk && chunk.index === index && typeof chunk.text === "string" && Number.isInteger(chunk.page) && chunk.page > 0 && chunk.page <= document.pages.length && chunk.endPage === chunk.page)
    || document.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) > 240_000
    || (document.extractionStatus !== undefined && document.extractionStatus !== "ready")) {
    logDiagnostic({ operation: "file_cache", cache: "invalid", errorClass: "InvalidFileCache" });
    throw new Error("This file's local cache is unreadable. Reattach the original file; your chat is safe.");
  }
  logDiagnostic({ operation: "file_cache", cache: "hit", extractionStatus: "ready", pageCount: document.pages.length, chunkCount: document.chunks.length });
  return { ...document, extractionStatus: "ready" };
}
export const removeDocument = (id: string) => transaction<void>("readwrite", (store, done) => { store.delete(id); done(); });
export const removeConversationDocuments = (id: string) => transaction<void>("readwrite", (store, done) => {
  const request = store.index("conversation").openKeyCursor(IDBKeyRange.only(id));
  request.onsuccess = () => { const cursor = request.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } else done(); };
});
export async function loadReferencedDocuments(refs: Attachment[], conversationId: string): Promise<StoredDocument[]> {
  if (refs.some(ref => ref.extractionStatus && ref.extractionStatus !== "ready")) throw new Error("Document processing is incomplete. Reattach the original file and retry.");
  const documents = await Promise.all(refs.map(ref => loadDocument(ref.documentId || "", conversationId)));
  const missing = documents.findIndex(document => !document);
  if (missing >= 0) throw new Error(`The local copy of “${refs[missing].name}” is unavailable. Reattach the original file. Your conversation is preserved.`);
  return documents as StoredDocument[];
}
