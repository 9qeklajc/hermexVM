import { useCallback, useEffect, useRef, useState } from "react";

const ShutterIcon = () => (
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

/**
 * Full-screen webcam capture modal (WhatsApp Web style): shows a live preview
 * from getUserMedia, lets the user snap a still, and hands the JPEG back as a
 * File. Native Android never mounts this — the attach menu routes the camera
 * option through a `capture="environment"` input so the device camera app
 * (flash, front/back switch, HDR…) does the work instead of the WebView.
 */
export function CameraCapture({
  onCancel,
  onCapture,
}: {
  /** Called with the captured JPEG still when the user snaps a photo. */
  onCapture: (file: File) => void;
  /** Called when the user dismisses the modal without a photo. */
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(
      navigator.mediaDevices,
    );
    if (!getUserMedia) {
      setError("No camera is available on this device.");
      return;
    }
    getUserMedia({ video: true, audio: false })
      .then((stream) => {
        // Unmounted while the permission prompt was open — release the camera.
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
          setReady(true);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof DOMException && cause.name === "NotAllowedError"
            ? "Camera access was denied. Allow camera access for this site and try again."
            : "Couldn't start the camera. Close other apps using it and try again.",
        );
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  // Escape dismisses the modal like every other dialog in the app.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const snap = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    // The preview is mirrored for a natural selfie view; the saved still is
    // the unmirrored frame, matching what camera apps produce.
    context.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const now = new Date();
        const pad = (value: number) => String(value).padStart(2, "0");
        const name =
          `photo-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}` +
          `${pad(now.getUTCDate())}-${pad(now.getUTCHours())}` +
          `${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}.jpg`;
        onCapture(new File([blob], name, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.92,
    );
  }, [onCapture]);

  return (
    <div
      className="camera-capture-backdrop"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="camera-capture"
        role="dialog"
        aria-modal="true"
        aria-label="Take a photo"
        onClick={(event) => event.stopPropagation()}
      >
        {error ? (
          <div className="camera-capture__error">
            <p>{error}</p>
            <button
              type="button"
              className="camera-capture__cancel"
              onClick={onCancel}
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="camera-capture__viewport">
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                aria-label="Camera preview"
              />
              {!ready ? (
                <span className="voice-spinner" aria-label="Starting camera" />
              ) : null}
            </div>
            <div className="camera-capture__controls">
              <button
                type="button"
                className="camera-capture__cancel"
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className="camera-capture__shutter"
                onClick={snap}
                disabled={!ready}
                aria-label="Take photo"
                title="Take photo"
              >
                <ShutterIcon />
              </button>
              {/* Balances the Cancel button so the shutter stays centered. */}
              <span className="camera-capture__spacer" aria-hidden />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
