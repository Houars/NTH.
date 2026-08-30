import { Channel, invoke } from "@tauri-apps/api/core";

export type NthUpdateInfo = {
  currentVersion: string;
  version: string;
  date?: string | null;
  body?: string | null;
};

type NativeUpdateEvent =
  | { event: "started"; data: { contentLength?: number | null } }
  | { event: "progress"; data: { downloaded: number; contentLength?: number | null } }
  | { event: "finished" };

export type NthUpdateProgress = {
  downloaded: number;
  total?: number;
  percent?: number;
  finished?: boolean;
};

export function checkNthUpdate(): Promise<NthUpdateInfo | null> {
  return invoke<NthUpdateInfo | null>("check_update");
}

export function installNthUpdate(
  onProgress: (progress: NthUpdateProgress) => void
): Promise<void> {
  const channel = new Channel<NativeUpdateEvent>();
  let total: number | undefined;

  channel.onmessage = event => {
    if (event.event === "started") {
      total = event.data.contentLength || undefined;
      onProgress({ downloaded: 0, total, percent: total ? 0 : undefined });
      return;
    }
    if (event.event === "progress") {
      total = event.data.contentLength || total;
      onProgress({
        downloaded: event.data.downloaded,
        total,
        percent: total ? Math.min(100, Math.round((event.data.downloaded / total) * 100)) : undefined
      });
      return;
    }
    onProgress({ downloaded: total || 0, total, percent: 100, finished: true });
  };

  return invoke("install_update", { onEvent: channel });
}
