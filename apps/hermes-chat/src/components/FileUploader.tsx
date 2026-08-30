import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
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
import { CameraCapture } from "./CameraCapture";

type Phase = "loading" | "idle" | "uploading" | "done" | "error" | "resume";

/** True when a camera can be attached from: the native app uses the device
camera through a `capture` input; the web falls back to a getUserMedia webcam. */
const CAMERA_SUPPORTED =
  Capacitor.isNativePlatform() ||
  (typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia));

const CameraIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

const DocumentIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </svg>
);

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
  // Camera input: `capture="environment"` makes Capacitor's WebView file
  // chooser launch ACTION_IMAGE_CAPTURE (the device camera app) instead of
  // the document picker. Only ever clicked on the native platform; the web
  // route goes through the CameraCapture webcam modal instead.
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const lastFileRef = useRef<File | null>(null);
  const pendingRef = useRef<PendingFileUpload | null>(null);
  const pendingSaveRef = useRef<Promise<void>>(Promise.resolve());
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState(0);
  const [filename, setFilename] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // WhatsApp-style attach menu: Camera (photo) / Document (any file).
  const [menuOpen, setMenuOpen] = useState(false);
  // Webcam modal — only opened on non-native platforms.
  const [cameraOpen, setCameraOpen] = useState(false);

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

  // The composer is disabled while a turn runs — never leave a stale menu
  // hanging over it, and never start an upload the pipeline would refuse.
  useEffect(() => {
    if (disabled && menuOpen) setMenuOpen(false);
  }, [disabled, menuOpen]);

  // Escape closes the attach menu, matching every other dialog in the app.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  // Camera option: native → device camera app via the capture input;
  // web → live webcam modal. The captured File rides the exact same upload
  // pipeline as a picked document (progress, resume chips, error handling).
  const chooseCamera = useCallback(() => {
    setMenuOpen(false);
    if (Capacitor.isNativePlatform()) {
      cameraInputRef.current?.click();
    } else {
      setCameraOpen(true);
    }
  }, []);

  const handleCapturedPhoto = useCallback(
    (file: File) => {
      setCameraOpen(false);
      void handleFile(file);
    },
    [handleFile],
  );

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
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
          event.target.value = "";
        }}
      />
      {menuOpen ? (
        <>
          {/* Transparent catcher for the tap-away that closes the menu. */}
          <div
            className="attach-menu-backdrop"
            onClick={() => setMenuOpen(false)}
          />
          <div className="attach-menu" role="menu" aria-label="Attach">
            {CAMERA_SUPPORTED ? (
              <button
                type="button"
                className="attach-option"
                role="menuitem"
                onClick={chooseCamera}
                aria-label="Take a photo with the camera"
              >
                <span className="attach-option__icon">
                  <CameraIcon />
                </span>
                <span className="attach-option__label">Camera</span>
              </button>
            ) : null}
            <button
              type="button"
              className="attach-option"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                inputRef.current?.click();
              }}
              aria-label="Choose a file"
            >
              <span className="attach-option__icon">
                <DocumentIcon />
              </span>
              <span className="attach-option__label">Document</span>
            </button>
          </div>
        </>
      ) : null}
      {cameraOpen ? (
        <CameraCapture
          onCancel={() => setCameraOpen(false)}
          onCapture={handleCapturedPhoto}
        />
      ) : null}
      <button
        type="button"
        className="icon-button file-button"
        disabled={disabled || busy || phase === "loading"}
        onClick={() => setMenuOpen((open) => !open)}
        aria-label="Attach"
        title="Attach"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {busy ? (
          <span className="file-upload-percent" aria-hidden>
            {Math.min(99, progress)}%
          </span>
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
        <span className="file-progress" title={filename}>
          {filename}
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
