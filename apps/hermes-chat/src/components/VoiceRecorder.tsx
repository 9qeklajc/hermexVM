import { useCallback, useEffect, useRef, useState } from "react";
import { Preferences } from "@capacitor/preferences";
import {
  HermesTranscriptionError,
  type HermesChatClient,
  type HermesTranscriptionCapabilities,
  type HermesTranscriptionLanguage,
} from "@contexcgi/client";
import {
  blobToBase64,
  formatBytes,
  formatElapsed,
  startVoiceRecording,
  VoiceUnsupportedError,
  type VoiceRecorderHandle,
  type VoiceRecorderResult,
} from "../lib/voice";
import { isTransientTransportError } from "../lib/errors";
import {
  clearVoiceDraft,
  loadVoiceDraft,
  saveVoiceDraft,
} from "../lib/voice-draft";

type Phase =
  | "checking"
  | "unavailable"
  | "idle"
  | "requesting"
  | "recording"
  | "uploading"
  | "transcribing"
  | "error";

const BUSY_PHASES: ReadonlySet<Phase> = new Set([
  "requesting",
  "recording",
  "uploading",
  "transcribing",
]);

// Spoken-language pin for whisper on the bridge. "auto" detects, but short
// clips (especially German) are sometimes misdetected and come out in the
// wrong language — pinning EN/DE transcribes verbatim, never translating.
const LANGUAGE_CYCLE: HermesTranscriptionLanguage[] = ["auto", "en", "de"];
const LANGUAGE_STORAGE_KEY = "hermes.chat.voice.language";

const MicIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
);

const MicOffIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <line x1="2" x2="22" y1="2" y2="22" />
    <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
    <path d="M5 10v2a7 7 0 0 0 12 5" />
    <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
);

const StopIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden
  >
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

const CancelIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

const SpinnerIcon = () => <span className="voice-spinner" aria-hidden />;

/**
 * A microphone control that records up to the bridge's configured limit
 * (default 60s), sends the recording for local whisper.cpp transcription, and
 * hands the transcript to `onTranscript` — the caller decides how to merge it
 * into whatever the user was typing. Never sends anything on its own.
 */
export function VoiceRecorder({
  client,
  onTranscript,
  onBusyChange,
  disabled,
}: {
  client: HermesChatClient;
  onTranscript: (transcript: string) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [caps, setCaps] = useState<HermesTranscriptionCapabilities | null>(
    null,
  );
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  // Upload/transcribe progress: percent while uploading, indeterminate after.
  const [uploadPercent, setUploadPercent] = useState(0);
  const [language, setLanguage] = useState<HermesTranscriptionLanguage>("auto");
  const languageRef = useRef<HermesTranscriptionLanguage>("auto");
  languageRef.current = language;
  const handleRef = useRef<VoiceRecorderHandle | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  // The finished recording, kept until the transcript lands or the user gives
  // up — a failed send must never force the user to re-record from scratch.
  const lastRecordingRef = useRef<VoiceRecorderResult | null>(null);

  const stopTimer = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  // The language pin is a sticky per-device preference.
  useEffect(() => {
    void Preferences.get({ key: LANGUAGE_STORAGE_KEY })
      .then(({ value }) => {
        if (
          value &&
          LANGUAGE_CYCLE.includes(value as HermesTranscriptionLanguage)
        ) {
          setLanguage(value as HermesTranscriptionLanguage);
        }
      })
      .catch(() => undefined);
  }, []);

  const cycleLanguage = useCallback(() => {
    setLanguage((current) => {
      const next =
        LANGUAGE_CYCLE[
          (LANGUAGE_CYCLE.indexOf(current) + 1) % LANGUAGE_CYCLE.length
        ] ?? "auto";
      void Preferences.set({ key: LANGUAGE_STORAGE_KEY, value: next }).catch(
        () => undefined,
      );
      return next;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Release the mic (if recording) and abort a mid-flight transcription
      // call (if uploading) — navigating away must not leave either running.
      handleRef.current?.cancel();
      handleRef.current = null;
      transcribeAbortRef.current?.abort();
      transcribeAbortRef.current = null;
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    client
      .transcriptionCapabilities()
      .then(async (result) => {
        if (cancelled) return;
        setCaps(result);
        setUnavailableReason(
          result.available ? null : (result.reason ?? "disabled"),
        );
        if (!result.available) {
          setPhase("unavailable");
          return;
        }
        const recovered = await loadVoiceDraft().catch(() => null);
        if (cancelled) return;
        if (recovered) {
          lastRecordingRef.current = recovered;
          setErrorMessage("Recovered recording — tap ↻ to continue.");
          setPhase("error");
        } else {
          setPhase("idle");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPhase("unavailable");
        setUnavailableReason("bridge unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const busy = BUSY_PHASES.has(phase);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const failWith = useCallback((message: string) => {
    setPhase("error");
    setErrorMessage(message);
  }, []);

  const finishRecording = useCallback(
    async (recording: VoiceRecorderResult) => {
      handleRef.current = null;
      lastRecordingRef.current = recording;
      if (recording.blob.size === 0) {
        lastRecordingRef.current = null;
        setPhase("idle");
        return;
      }
      if (caps && recording.blob.size > caps.maxAudioBytes) {
        failWith(
          `Recording is too large (${formatBytes(recording.blob.size)} > ${formatBytes(caps.maxAudioBytes)} limit).`,
        );
        return;
      }
      await saveVoiceDraft(recording).catch(() => undefined);
      setUploadPercent(0);
      setPhase("uploading");
      const controller = new AbortController();
      transcribeAbortRef.current = controller;
      try {
        const contentBase64 = await blobToBase64(recording.blob);
        const { transcript } = await client.transcribeAudio(
          {
            contentBase64,
            mimeType: recording.mimeType,
            durationMs: recording.durationMs,
            language: languageRef.current,
          },
          {
            signal: controller.signal,
            onProgress: (progress) => {
              if (!mountedRef.current) return;
              if (progress.phase === "uploading") {
                setUploadPercent(Math.round(progress.percent));
              } else {
                setPhase("transcribing");
              }
            },
          },
        );
        if (!mountedRef.current) return;
        if (transcript.trim()) {
          lastRecordingRef.current = null;
          await clearVoiceDraft().catch(() => undefined);
          onTranscript(transcript);
          setPhase("idle");
        } else {
          failWith("No speech detected — try again.");
        }
      } catch (cause) {
        if (!mountedRef.current) return;
        if (controller.signal.aborted) {
          // User cancelled — keep the recording so Retry still works.
          failWith("Cancelled — tap ↻ to send it anyway.");
          return;
        }
        const message =
          cause instanceof HermesTranscriptionError
            ? cause.message
            : isTransientTransportError(cause)
              ? "Connection dropped while sending — tap ↻ to retry."
              : cause instanceof Error && cause.name === "AbortError"
                ? "Cancelled — tap ↻ to send it anyway."
                : "Transcription failed — tap ↻ to retry.";
        failWith(message);
      } finally {
        if (transcribeAbortRef.current === controller)
          transcribeAbortRef.current = null;
      }
    },
    [caps, client, onTranscript, failWith],
  );

  const beginRecording = useCallback(async () => {
    // Ref guard (not just the `phase` state) so a rapid double-click can't
    // start two overlapping recordings before React re-renders the disabled
    // "requesting" state.
    if (startingRef.current) return;
    startingRef.current = true;
    lastRecordingRef.current = null;
    void clearVoiceDraft().catch(() => undefined);
    setPhase("requesting");
    setErrorMessage(null);
    try {
      const maxDurationMs = (caps?.maxDurationSeconds ?? 60) * 1000;
      const handle = await startVoiceRecording(
        {
          onStop: (result) => {
            stopTimer();
            if (!mountedRef.current) return;
            void finishRecording(result);
          },
          onError: (error) => {
            stopTimer();
            handleRef.current = null;
            if (!mountedRef.current) return;
            failWith(error.message);
          },
        },
        { maxDurationMs },
      );
      if (!mountedRef.current) {
        // Unmounted while the permission prompt was pending — release the mic
        // instead of leaking a live stream.
        handle.cancel();
        return;
      }
      handleRef.current = handle;
      setPhase("recording");
      const startedAt = Date.now();
      setElapsedMs(0);
      // Defensive: if a previous recording somehow left its interval alive
      // (e.g. a stop that never emitted), kill it — two live intervals would
      // make the timer visibly alternate between two elapsed counts.
      stopTimer();
      tickRef.current = setInterval(
        () => setElapsedMs(Date.now() - startedAt),
        250,
      );
    } catch (cause) {
      if (!mountedRef.current) return;
      const message =
        cause instanceof VoiceUnsupportedError
          ? cause.message
          : cause instanceof Error && cause.name === "NotAllowedError"
            ? "Microphone permission was denied."
            : "Couldn't start recording.";
      failWith(message);
    } finally {
      startingRef.current = false;
    }
  }, [caps, finishRecording, stopTimer, failWith]);

  const stopRecording = () => handleRef.current?.stop();
  const cancelRecording = () => {
    stopTimer();
    handleRef.current?.cancel();
    handleRef.current = null;
    lastRecordingRef.current = null;
    void clearVoiceDraft().catch(() => undefined);
    setPhase("idle");
  };

  // Re-send the kept recording — never forces a re-record after a failure.
  const retryLastRecording = () => {
    const recording = lastRecordingRef.current;
    if (!recording) {
      setPhase("idle");
      return;
    }
    void finishRecording(recording);
  };

  // Give up on the kept recording entirely.
  const discardLastRecording = () => {
    lastRecordingRef.current = null;
    void clearVoiceDraft().catch(() => undefined);
    setPhase("idle");
    setErrorMessage(null);
  };

  // Stop waiting on an in-flight upload/transcription (keeps the recording
  // for a later retry).
  const cancelProcessing = () => {
    transcribeAbortRef.current?.abort();
  };

  if (
    phase === "checking" ||
    phase === "requesting" ||
    phase === "transcribing"
  ) {
    return (
      <div className="voice-control">
        <button
          type="button"
          className="icon-button voice-button"
          disabled
          aria-label={
            phase === "transcribing"
              ? "Transcribing recording"
              : "Preparing voice recording"
          }
        >
          <SpinnerIcon />
        </button>
        {phase === "transcribing" ? (
          <button
            type="button"
            className="icon-button voice-cancel"
            onClick={cancelProcessing}
            aria-label="Stop transcribing"
            title="Stop transcribing"
          >
            <CancelIcon />
          </button>
        ) : null}
      </div>
    );
  }

  if (phase === "uploading") {
    return (
      <div className="voice-control">
        <button
          type="button"
          className="icon-button voice-button"
          disabled
          aria-label="Sending recording"
        >
          <span className="voice-upload-percent" aria-hidden>
            {Math.min(99, uploadPercent)}%
          </span>
        </button>
        <button
          type="button"
          className="icon-button voice-cancel"
          onClick={cancelProcessing}
          aria-label="Cancel sending"
          title="Cancel sending"
        >
          <CancelIcon />
        </button>
      </div>
    );
  }

  if (phase === "unavailable") {
    return (
      <button
        type="button"
        className="icon-button voice-button"
        disabled
        title={`Voice transcription unavailable (${unavailableReason})`}
        aria-label="Voice transcription unavailable"
      >
        <MicOffIcon />
      </button>
    );
  }

  if (phase === "recording") {
    return (
      <div className="voice-recording">
        <span className="voice-timer">{formatElapsed(elapsedMs)}</span>
        <button
          type="button"
          className="icon-button voice-cancel"
          onClick={cancelRecording}
          aria-label="Cancel recording"
        >
          <CancelIcon />
        </button>
        <button
          type="button"
          className="icon-button voice-stop"
          onClick={stopRecording}
          aria-label="Stop recording"
        >
          <StopIcon />
        </button>
      </div>
    );
  }

  return (
    <div className="voice-control">
      <button
        type="button"
        className="voice-lang"
        onClick={cycleLanguage}
        title="Spoken language for transcription (tap to change)"
        aria-label={`Transcription language: ${language}`}
      >
        {language === "auto" ? "AUTO" : language.toUpperCase()}
      </button>
      <button
        type="button"
        className="icon-button voice-button"
        disabled={disabled}
        onClick={() => void beginRecording()}
        aria-label="Record a voice message"
      >
        <MicIcon />
      </button>
      {phase === "error" && errorMessage ? (
        <span className="voice-error">
          {errorMessage}
          {lastRecordingRef.current ? (
            <>
              {" "}
              <button
                type="button"
                className="voice-retry"
                onClick={retryLastRecording}
                aria-label="Retry sending this recording"
                title="Retry sending this recording"
              >
                ↻
              </button>
              <button
                type="button"
                className="voice-discard"
                onClick={discardLastRecording}
                aria-label="Discard this recording"
                title="Discard this recording"
              >
                ✕
              </button>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
