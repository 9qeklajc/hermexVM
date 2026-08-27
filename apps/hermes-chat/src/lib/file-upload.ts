import { Preferences } from "@capacitor/preferences";
import type { HermesUploadSource } from "@contexcgi/client";

const PENDING_UPLOAD_KEY = "hermes.pendingFileUpload.v1";

export type PendingFileUpload = {
  uploadId: string;
  filename: string;
  sizeBytes: number;
  mimeType?: string;
  sha256: string;
  expiresAt: number;
};

export function fileMatchesPending(
  file: Pick<File, "name" | "size" | "type">,
  pending: PendingFileUpload,
): boolean {
  return (
    file.name === pending.filename &&
    file.size === pending.sizeBytes &&
    (file.type || undefined) === pending.mimeType
  );
}

export function blobUploadSource(blob: Blob): HermesUploadSource {
  return {
    sizeBytes: blob.size,
    read: async (startBytes, endBytes) =>
      new Uint8Array(await blob.slice(startBytes, endBytes).arrayBuffer()),
  };
}

export async function loadPendingFileUpload(): Promise<PendingFileUpload | null> {
  const { value } = await Preferences.get({ key: PENDING_UPLOAD_KEY });
  if (!value) return null;
  try {
    const pending = JSON.parse(value) as PendingFileUpload;
    if (!pending.uploadId || pending.expiresAt <= Date.now()) {
      await clearPendingFileUpload();
      return null;
    }
    return pending;
  } catch {
    await clearPendingFileUpload();
    return null;
  }
}

export async function savePendingFileUpload(
  pending: PendingFileUpload,
): Promise<void> {
  await Preferences.set({
    key: PENDING_UPLOAD_KEY,
    value: JSON.stringify(pending),
  });
}

export async function clearPendingFileUpload(): Promise<void> {
  await Preferences.remove({ key: PENDING_UPLOAD_KEY });
}
