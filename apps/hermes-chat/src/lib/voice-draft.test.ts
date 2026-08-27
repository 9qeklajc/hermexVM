import { describe, expect, it, vi } from "vitest";
import { clearVoiceDraft, loadVoiceDraft, saveVoiceDraft } from "./voice-draft";

describe("voice draft persistence", () => {
  it("degrades safely when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(
      saveVoiceDraft({
        blob: new Blob(["voice"]),
        mimeType: "audio/webm",
        durationMs: 1000,
      }),
    ).resolves.toBeUndefined();
    await expect(loadVoiceDraft()).resolves.toBeNull();
    await expect(clearVoiceDraft()).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
