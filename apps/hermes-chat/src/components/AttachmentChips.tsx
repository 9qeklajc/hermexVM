import type { ReactElement } from "react";
import type { FileTransferDescriptor } from "../lib/api";

/** Formats bytes as a compact human-readable size. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

export type AttachmentKind =
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "archive"
  | "code"
  | "text"
  | "file";

/** Maps a filename + mime type to an attachment icon kind. */
export function attachmentKind(filename: string, mimeType?: string): AttachmentKind {
  const type = (mimeType || "").toLowerCase();
  const name = filename.toLowerCase();
  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/.test(name))
    return "image";
  if (type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|opus|flac|aac)$/.test(name))
    return "audio";
  if (type.startsWith("video/") || /\.(mp4|mov|mkv|webm|avi)$/.test(name)) return "video";
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    type.startsWith("text/") ||
    /\.(txt|md|csv|log|json|ya?ml|toml|ini)$/.test(name)
  )
    return "text";
  if (
    /\.(zip|tar|gz|bz2|xz|7z|rar|tgz)$/.test(name) ||
    type === "application/zip"
  )
    return "archive";
  if (
    /\.(js|jsx|ts|tsx|py|rs|go|java|kt|c|h|cpp|cs|rb|php|sh|sql|html|css)$/.test(name)
  )
    return "code";
  return "file";
}

const ICONS: Record<AttachmentKind, ReactElement> = {
  image: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-4.35-4.35a2 2 0 0 0-2.83 0L3 21" />
    </svg>
  ),
  audio: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ),
  video: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m22 8-6 4 6 4V8Z" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </svg>
  ),
  pdf: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 15h6" />
    </svg>
  ),
  archive: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="5" rx="1" />
      <path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9" />
      <path d="M10 13h4" />
    </svg>
  ),
  code: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </svg>
  ),
  text: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
      <path d="M10 9H8" />
    </svg>
  ),
  file: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  ),
};

/**
 * WhatsApp/Signal-style pending attachment chips rendered above the composer.
 * Each chip shows the file-type icon, name, size, and an × button to remove it.
 */
export function AttachmentChips({
  files,
  onRemove,
}: {
  files: FileTransferDescriptor[];
  onRemove: (index: number) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="attachment-row" role="list">
      {files.map((file, index) => {
        const kind = attachmentKind(file.filename, file.mimeType);
        const size = formatFileSize(file.sizeBytes);
        return (
          <div className="attachment-chip" key={`${file.id}-${index}`} role="listitem">
            <span className="attachment-chip__icon" aria-hidden>
              {ICONS[kind]}
            </span>
            <span className="attachment-chip__body">
              <span className="attachment-chip__name">{file.filename}</span>
              {size ? <span className="attachment-chip__size">{size}</span> : null}
            </span>
            <button
              type="button"
              className="icon-button attachment-chip__remove"
              aria-label={`Remove ${file.filename}`}
              onClick={() => onRemove(index)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
