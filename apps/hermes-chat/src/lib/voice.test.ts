import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscript,
  arrayBufferToBase64,
  blobToBase64,
  formatBytes,
  formatElapsed,
  pickSupportedMimeType,
  startVoiceRecording,
  VoiceUnsupportedError,
} from "./voice.js";

describe("pickSupportedMimeType", () => {
  it("returns the first candidate the browser supports", () => {
    const supported = new Set(["audio/ogg", "audio/mp4"]);
    expect(pickSupportedMimeType((type) => supported.has(type))).toBe(
      "audio/ogg",
    );
  });

  it("returns null when nothing is supported", () => {
    expect(pickSupportedMimeType(() => false)).toBeNull();
  });
});

describe("base64 encoding", () => {
  it("round-trips bytes through arrayBufferToBase64", () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    expect(arrayBufferToBase64(bytes.buffer)).toBe("aGVsbG8=");
  });

  it("encodes a Blob's bytes", async () => {
    const blob = new Blob([new Uint8Array([104, 101, 108, 108, 111])]);
    await expect(blobToBase64(blob)).resolves.toBe("aGVsbG8=");
  });
});

describe("formatElapsed", () => {
  it("formats milliseconds as mm:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_000)).toBe("0:07");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(-500)).toBe("0:00");
  });
});

describe("formatBytes", () => {
  it("scales the unit with the magnitude", () => {
    expect(formatBytes(500)).toBe("500B");
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0MB");
  });
});

describe("appendTranscript", () => {
  it("returns the transcript alone when the draft is empty", () => {
    expect(appendTranscript("", "hello there")).toBe("hello there");
    expect(appendTranscript("   ", "hello there")).toBe("hello there");
  });

  it("separates existing text and the transcript with one blank line", () => {
    expect(appendTranscript("existing note", "hello there")).toBe(
      "existing note\n\nhello there",
    );
  });

  it("trims trailing whitespace from the existing draft before appending", () => {
    expect(appendTranscript("existing note   \n", "hello there")).toBe(
      "existing note\n\nhello there",
    );
  });

  it("leaves the draft untouched when the transcript is empty", () => {
    expect(appendTranscript("existing note", "   ")).toBe("existing note");
  });
});

// -- startVoiceRecording lifecycle -------------------------------------------
// MediaRecorder/getUserMedia don't exist in this test environment, so a fake
// implementation stands in for the browser API surface `voice.ts` actually
// calls (start/stop/state, the ondataavailable/onstop/onerror callbacks, and
// track.stop()).

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeMediaRecorder {
  static isTypeSupportedImpl: (type: string) => boolean = () => true;
  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.isTypeSupportedImpl(type);
  }
  static shouldThrowOnConstruct = false;
  static shouldThrowOnStart = false;
  static instances: FakeMediaRecorder[] = [];

  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(
    public stream: FakeMediaStream,
    public options?: { mimeType?: string },
  ) {
    if (FakeMediaRecorder.shouldThrowOnConstruct) {
      throw new Error("construct failed");
    }
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    if (FakeMediaRecorder.shouldThrowOnStart) {
      throw new Error("start failed");
    }
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.onstop?.();
  }

  emitError(error: Error): void {
    this.state = "inactive";
    this.onerror?.({ error });
  }

  emitData(data: Blob): void {
    this.ondataavailable?.({ data });
  }
}

class FakeMediaStream {
  track = new FakeTrack();
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

function installFakeBrowser(getUserMediaImpl?: () => Promise<FakeMediaStream>) {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.shouldThrowOnConstruct = false;
  FakeMediaRecorder.shouldThrowOnStart = false;
  FakeMediaRecorder.isTypeSupportedImpl = () => true;
  const stream = new FakeMediaStream();
  const getUserMedia = vi.fn(
    getUserMediaImpl ?? (() => Promise.resolve(stream)),
  );
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  return { stream, getUserMedia };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("startVoiceRecording", () => {
  it("throws VoiceUnsupportedError when getUserMedia is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(
      startVoiceRecording({ onStop: vi.fn(), onError: vi.fn() }),
    ).rejects.toBeInstanceOf(VoiceUnsupportedError);
  });

  it("throws VoiceUnsupportedError when no mime type is supported", async () => {
    installFakeBrowser();
    FakeMediaRecorder.isTypeSupportedImpl = () => false;
    await expect(
      startVoiceRecording({ onStop: vi.fn(), onError: vi.fn() }),
    ).rejects.toBeInstanceOf(VoiceUnsupportedError);
  });

  it("emits onStop with collected chunks and releases the track", async () => {
    const { stream } = installFakeBrowser();
    const onStop = vi.fn();
    await startVoiceRecording({ onStop, onError: vi.fn() });

    const recorder = FakeMediaRecorder.instances[0]!;
    const chunk = new Blob(["hi"]);
    recorder.emitData(chunk);
    recorder.stop();

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop.mock.calls[0]![0]).toMatchObject({
      mimeType: expect.any(String),
    });
    expect(stream.track.stopped).toBe(true);
  });

  it("auto-stops at maxDurationMs and releases the track", async () => {
    vi.useFakeTimers();
    installFakeBrowser();
    const onStop = vi.fn();
    await startVoiceRecording(
      { onStop, onError: vi.fn() },
      { maxDurationMs: 1_000 },
    );

    vi.advanceTimersByTime(999);
    expect(onStop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("cancel() releases the track and never invokes onStop or onError", async () => {
    const { stream } = installFakeBrowser();
    const onStop = vi.fn();
    const onError = vi.fn();
    const handle = await startVoiceRecording({ onStop, onError });

    handle.cancel();

    expect(onStop).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(stream.track.stopped).toBe(true);
  });

  it("calling stop() twice only finalizes once", async () => {
    installFakeBrowser();
    const onStop = vi.fn();
    const handle = await startVoiceRecording({ onStop, onError: vi.fn() });

    handle.stop();
    handle.stop();

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("emits at most one callback even if error and stop both fire", async () => {
    installFakeBrowser();
    const onStop = vi.fn();
    const onError = vi.fn();
    await startVoiceRecording({ onStop, onError });

    const recorder = FakeMediaRecorder.instances[0]!;
    recorder.emitError(new Error("device lost"));
    recorder.onstop?.(); // some browsers fire onstop after an error too

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("releases the microphone track if MediaRecorder construction throws", async () => {
    const { stream } = installFakeBrowser();
    FakeMediaRecorder.shouldThrowOnConstruct = true;

    await expect(
      startVoiceRecording({ onStop: vi.fn(), onError: vi.fn() }),
    ).rejects.toThrow("construct failed");
    expect(stream.track.stopped).toBe(true);
  });

  it("releases the microphone track if recorder.start() throws", async () => {
    const { stream } = installFakeBrowser();
    FakeMediaRecorder.shouldThrowOnStart = true;

    await expect(
      startVoiceRecording({ onStop: vi.fn(), onError: vi.fn() }),
    ).rejects.toThrow("start failed");
    expect(stream.track.stopped).toBe(true);
  });
});
