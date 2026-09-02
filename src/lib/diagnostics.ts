export type DiagnosticEvent = {
  timestamp: string;
  operation: string;
  route?: string;
  durationMs?: number;
  timeout?: boolean;
  cancelled?: boolean;
  serviceFailure?: "ollama" | "model" | "searxng" | "updater" | "vision" | "persistence";
  retryCount?: number;
  errorClass?: string;
  attachmentCount?: number;
  extractedChars?: number;
  estimatedTokens?: number;
  pageCount?: number;
  chunkCount?: number;
  promptChars?: number;
  cache?: "hit" | "miss" | "invalid";
  extractionStatus?: "processing" | "ready" | "error";
  selectedChunks?: Array<{ documentId: string; index: number; page: number }>;
};

const MAX_DIAGNOSTICS = 100;
const DIAGNOSTICS_KEY = "nth.diagnostics.v1";
const events: DiagnosticEvent[] = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(DIAGNOSTICS_KEY) || "[]") as unknown;
    return Array.isArray(saved) ? saved.slice(-MAX_DIAGNOSTICS) as DiagnosticEvent[] : [];
  } catch {
    return [];
  }
})();

export function logDiagnostic(event: Omit<DiagnosticEvent, "timestamp">): void {
  const entry: DiagnosticEvent = {
    timestamp: new Date().toISOString(),
    ...event
  };
  events.push(entry);
  if (events.length > MAX_DIAGNOSTICS) events.splice(0, events.length - MAX_DIAGNOSTICS);
  (window as Window & { __NTH_DIAGNOSTICS__?: DiagnosticEvent[] }).__NTH_DIAGNOSTICS__ = events;
  try {
    localStorage.setItem(DIAGNOSTICS_KEY, JSON.stringify(events));
  } catch {
    // Diagnostics must never interfere with the app or chat persistence.
  }
  if (import.meta.env.DEV || entry.errorClass || entry.timeout || entry.cancelled) {
    console.debug("[NTH diagnostic]", entry);
  }
}

export function diagnosticSnapshot(): DiagnosticEvent[] {
  return [...events];
}
