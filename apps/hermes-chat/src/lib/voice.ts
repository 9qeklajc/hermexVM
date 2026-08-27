/**
 * Voice recording + transcript helpers for the composer/description fields.
 * Recording talks to the browser's MediaRecorder API directly; transcription
 * itself happens on the bridge (see @contexcgi/client `transcribeAudio`).
 */

export const MAX_RECORDING_MS = 60_000;

/** Containers MediaRecorder commonly produces, best (smallest/clearest) first. */
const MIME_PREFERENCE = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
];

export function pickSupportedMimeType(
  isTypeSupported: (mimeType: string) => boolean,
  candidates: string[] = MIME_PREFERENCE,
): string | null {
  for (const candidate of candidates) {
    if (isTypeSupported(candidate)) return candidate;
  }
  return null;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(bytes).toString("base64");
}

/** mm:ss, for the recording timer. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)}MB`;
}

/**
 * Appends a transcript to whatever the user already typed: keeps the existing
 * draft untouched, separates with exactly one blank line, and never sends
 * anything itself — the caller stays in control of the (still editable) text.
 */
export function appendTranscript(current: string, transcript: string): string {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) return current;
  const trimmedCurrent = current.replace(/\s+$/, "");
  if (!trimmedCurrent) return trimmedTranscript;
  return `${trimmedCurrent}\n\n${trimmedTranscript}`;
}

export class VoiceUnsupportedError extends Error {}

export type VoiceRecorderResult = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
};

export type VoiceRecorderCallbacks = {
  onStop: (result: VoiceRecorderResult) => void;
  onError: (error: Error) => void;
};

export type VoiceRecorderHandle = {
  /** Finish recording and emit onStop with whatever was captured. */
  stop: () => void;
  /** Finish recording and emit nothing — the caller is discarding it. */
  cancel: () => void;
};

/**
 * Starts recording from the microphone. Auto-stops at `maxDurationMs`
 * (default 60s) and always releases the microphone track on stop/cancel/error
 * — including if MediaRecorder construction/start itself throws.
 */
export async function startVoiceRecording(
  callbacks: VoiceRecorderCallbacks,
  opts: { maxDurationMs?: number } = {},
): Promise<VoiceRecorderHandle> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    throw new VoiceUnsupportedError("This device can't record audio.");
  }
  if (typeof MediaRecorder === "undefined") {
    throw new VoiceUnsupportedError("This device can't record audio.");
  }
  const mimeType = pickSupportedMimeType((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  if (!mimeType) {
    throw new VoiceUnsupportedError(
      "No supported audio recording format was found.",
    );
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  // Anything that throws from here through a successful `recorder.start()`
  // must not leak the now-live microphone track.
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (cause) {
    stopTracks();
    throw cause;
  }

  const chunks: BlobPart[] = [];
  const startedAt = Date.now();
  let settled = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Exactly one of onStop/onError ever reaches the caller, tracks are always
  // released, and the max-duration timer is always cleared — regardless of
  // whether a natural stop, an explicit stop()/cancel(), or a MediaRecorder
  // error got here first.
  const finalize = (emit: () => void) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    stopTracks();
    emit();
  };

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.onerror = (event) => {
    finalize(() => {
      if (cancelled) return;
      const message =
        (event as unknown as { error?: Error }).error?.message ??
        "Recording failed.";
      callbacks.onError(new Error(message));
    });
  };
  recorder.onstop = () => {
    finalize(() => {
      if (cancelled) return;
      callbacks.onStop({
        blob: new Blob(chunks, { type: mimeType }),
        mimeType,
        durationMs: Date.now() - startedAt,
      });
    });
  };

  const requestStop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (settled || recorder.state === "inactive") {
      // Already finished, or never actually reached "recording" (e.g. the
      // OS/browser ended the track) — finalize directly so tracks/timer are
      // released even though onstop will never fire.
      finalize(() => {});
      return;
    }
    recorder.stop();
  };

  try {
    recorder.start();
  } catch (cause) {
    stopTracks();
    throw cause;
  }

  timer = setTimeout(requestStop, opts.maxDurationMs ?? MAX_RECORDING_MS);

  return {
    stop: () => requestStop(),
    cancel: () => {
      cancelled = true;
      requestStop();
    },
  };
}
