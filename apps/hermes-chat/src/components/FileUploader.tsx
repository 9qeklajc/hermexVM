import { useCallback, useEffect, useRef, useState } from "react";
import type { FileTransferDescriptor } from "../lib/api";
import { isTransientTransportError } from "../lib/errors";
import {
  blobUploadSource,
  clearPendingFileUpload,
  fileMatchesPending,
  loadPendingFileUpload,
  savePendingFileUpload,
  type PendingFileUpload,
} from "../lib/file-upload";

type Phase = "loading" | "idle" | "uploading" | "done" | "error" | "resume";

/** Uploads arbitrary files with bounded reads and durable, user-assisted resume. */
export function FileUploader({
  client,
  onUploaded,
  disabled,
  waitForClient,
}: {
  client: import("@contexcgi/client").HermesChatClient;
  onUploaded: (file: FileTransferDescriptor) => void;
  disabled?: boolean;
  waitForClient?: (options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    forceReconnect?: boolean;
  }) => Promise<import("@contexcgi/client").HermesChatClient>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastFileRef = useRef<File | null>(null);
  const pendingRef = useRef<PendingFileUpload | null>(null);
  const pendingSaveRef = useRef<Promise<void>>(Promise.resolve());
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState(0);
  const [filename, setFilename] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    void loadPendingFileUpload()
      .then((pending) => {
        if (!mountedRef.current) return;
        if (pending) {
          pendingRef.current = pending;
          setFilename(pending.filename);
          setPhase("resume");
        } else {
          setPhase("idle");
        }
      })
      .catch(() => {
        if (mountedRef.current) setPhase("idle");
      });
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const clearPending = useCallback(async () => {
    pendingRef.current = null;
    await pendingSaveRef.current.catch(() => undefined);
    await clearPendingFileUpload().catch(() => undefined);
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      if (disabled || file.size === 0) return;
      let allowReconnectRetry = Boolean(waitForClient);
      let transientRetryArmed = false;
      lastFileRef.current = file;
      let resumeUploadId: string | undefined;
      const pending = pendingRef.current;
      if (pending && fileMatchesPending(file, pending)) {
        resumeUploadId = pending.uploadId;
      } else if (pending) {
        const cancellationClient = waitForClient
          ? await waitForClient({ timeoutMs: 45_000 }).catch(() => client)
          : client;
        await cancellationClient
          .cancelFileUpload(pending.uploadId)
          .catch(() => undefined);
        await clearPending();
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const upload = (uploadClient: typeof client) =>
        uploadClient.uploadFileSource(
          {
            filename: file.name,
            source: blobUploadSource(file),
            mimeType: file.type || undefined,
          },
          (state) => {
            if (mountedRef.current) setProgress(Math.round(state.percent));
          },
          {
            signal: controller.signal,
            resumeUploadId,
            preserveForResume: true,
            onUploadInitialized: (state) => {
              const next: PendingFileUpload = {
                uploadId: state.uploadId,
                filename: file.name,
                sizeBytes: file.size,
                mimeType: file.type || undefined,
                sha256: state.sha256,
                expiresAt: state.expiresAt,
              };
              pendingRef.current = next;
              pendingSaveRef.current = savePendingFileUpload(next).catch(
                () => undefined,
              );
            },
          },
        );
      setPhase("uploading");
      setProgress(0);
      setFilename(file.name);
      setErrorMessage(null);
      try {
        let descriptor: FileTransferDescriptor;
        let uploadClient = client;
        while (true) {
          try {
            descriptor = await upload(uploadClient);
            break;
          } catch (cause) {
            if (
              !allowReconnectRetry ||
              !isTransientTransportError(cause) ||
              controller.signal.aborted
            ) {
              throw cause;
            }
            allowReconnectRetry = false;
            transientRetryArmed = true;
            if (mountedRef.current) {
              setErrorMessage("Connection dropped — reconnecting…");
            }
            uploadClient = await waitForClient!({
              timeoutMs: 45_000,
              signal: controller.signal,
              forceReconnect: true,
            });
          }
        }
        await clearPending();
        lastFileRef.current = null;
        if (!mountedRef.current) return;
        setPhase("done");
        setProgress(100);
        onUploaded(descriptor);
        setTimeout(() => {
          if (!mountedRef.current) return;
          setPhase("idle");
          setProgress(0);
          setFilename("");
        }, 1500);
      } catch (cause) {
        if (!mountedRef.current) return;
        setPhase("error");
        setErrorMessage(
          controller.signal.aborted
            ? "Upload paused. Tap Retry to resume."
            : transientRetryArmed
              ? "Couldn't reconnect to the bridge. Tap Retry to try again."
              : cause instanceof Error
                ? cause.message
                : String(cause),
        );
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [clearPending, client, disabled, onUploaded, waitForClient],
  );

  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    const pending = pendingRef.current;
    if (pending) {
      const cancellationClient = waitForClient
        ? await waitForClient({ timeoutMs: 45_000 }).catch(() => client)
        : client;
      await cancellationClient
        .cancelFileUpload(pending.uploadId)
        .catch(() => undefined);
    }
    await clearPending();
    lastFileRef.current = null;
    if (mountedRef.current) {
      setPhase("idle");
      setProgress(0);
      setFilename("");
      setErrorMessage(null);
    }
  }, [clearPending, client, waitForClient]);

  const busy = phase === "uploading";
  return (
    <div className="file-uploader">
      <input
        ref={inputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="icon-button file-button"
        disabled={disabled || busy || phase === "loading"}
        onClick={() => inputRef.current?.click()}
        aria-label="Attach a file"
        title="Attach a file"
      >
        {busy ? (
          <span className="voice-spinner" aria-hidden />
        ) : (
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
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        )}
      </button>
      {busy ? (
        <span className="file-progress">
          {filename} {progress}%
        </span>
      ) : null}
      {busy ? (
        <button type="button" onClick={() => abortRef.current?.abort()}>
          Pause
        </button>
      ) : null}
      {phase === "resume" ? (
        <span className="file-error">
          Reselect {filename} to resume.{" "}
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            Select
          </button>{" "}
          <button type="button" onClick={() => void cancel()}>
            Cancel
          </button>
        </span>
      ) : null}
      {phase === "error" && errorMessage ? (
        <span className="file-error">
          {errorMessage}{" "}
          {lastFileRef.current ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void handleFile(lastFileRef.current!)}
            >
              Retry
            </button>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              Reselect
            </button>
          )}{" "}
          <button type="button" onClick={() => void cancel()}>
            Cancel
          </button>
        </span>
      ) : null}
      {phase === "done" ? (
        <span className="file-done">{filename} uploaded</span>
      ) : null}
    </div>
  );
}
