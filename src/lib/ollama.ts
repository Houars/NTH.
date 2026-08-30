import { NTH_POLICY_V2 } from "./policy";

export type NthMode = "RUN" | "JOG" | "WALK";

export const MODEL_BY_MODE: Record<NthMode, string> = {
  RUN: "hf.co/ggml-org/gemma-4-12B-it-GGUF:Q4_0",
  JOG: "hf.co/ggml-org/gemma-4-12B-it-GGUF:Q4_0",
  WALK: "hf.co/ggml-org/gemma-4-12B-it-GGUF:Q4_0"
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type OllamaResponse = {
  message?: {
    role?: string;
    content?: string;
  };
  done?: boolean;
};

const OLLAMA = "http://127.0.0.1:11434";

export async function pingOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendToNth(
  messages: ChatMessage[],
  mode: NthMode,
  signal?: AbortSignal
): Promise<string> {
  const model = MODEL_BY_MODE[mode];

  const response = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      keep_alive: "30m",
      messages: [
        { role: "system", content: NTH_POLICY_V2 },
        ...messages
      ],
      options: {
        temperature: 0,
        num_predict: 512
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Ollama returned ${response.status}`);
  }

  const data = (await response.json()) as OllamaResponse;
  return data.message?.content?.trim() || "";
}
