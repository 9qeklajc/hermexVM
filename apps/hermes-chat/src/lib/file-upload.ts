import { Preferences } from "@capacitor/preferences";
import type { HermesUploadSource } from "@contexcgi/client";

const PENDING_UPLOAD_KEY = "hermes.pendingFileUpload.v1";

export const CAMERA_IMAGE_MAX_DIMENSION = 2048;
export const CAMERA_JPEG_QUALITY = 0.84;
const CAMERA_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type CameraImageDimensions = {
  width: number;
  height: number;
};

export type DecodedCameraImage = CameraImageDimensions & {
  source: CanvasImageSource;
  close?: () => void;
};

export type CameraImageOptimizer = {
  decode: (file: File) => Promise<DecodedCameraImage>;
  encode: (
    image: DecodedCameraImage,
    dimensions: CameraImageDimensions,
    mimeType: "image/jpeg",
    quality: number,
  ) => Promise<Blob | null>;
};

/** Returns oriented output dimensions without ever scaling an image up. */
export function cameraImageDimensions(
  width: number,
  height: number,
  maxDimension = CAMERA_IMAGE_MAX_DIMENSION,
): CameraImageDimensions | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(maxDimension) ||
    width <= 0 ||
    height <= 0 ||
    maxDimension <= 0
  ) {
    return null;
  }
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function cameraJpegFilename(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop()?.trim() || "camera-photo";
  const stem = leaf.replace(/\.[^.]*$/, "").trim() || "camera-photo";
  return `${stem}.jpg`;
}

export function shouldOptimizeCameraImage(file: Pick<File, "size" | "type">) {
  return file.size > 0 && CAMERA_IMAGE_TYPES.has(file.type.toLowerCase());
}

async function decodeCameraImage(file: File): Promise<DecodedCameraImage> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("Image bitmap decoding is unavailable");
  }
  // Explicitly request EXIF orientation so portrait photos are drawn exactly
  // as the browser renders them. Older implementations reject this option and
  // safely fall back to uploading the original file.
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    close: () => bitmap.close(),
  };
}

async function encodeCameraImage(
  image: DecodedCameraImage,
  dimensions: CameraImageDimensions,
  mimeType: "image/jpeg",
  quality: number,
): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image.source, 0, 0, dimensions.width, dimensions.height);
  return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
}

const browserCameraImageOptimizer: CameraImageOptimizer = {
  decode: decodeCameraImage,
  encode: encodeCameraImage,
};

/**
 * Shrinks camera captures before upload. The upload protocol hashes the full
 * payload, then sends it in serialized small chunks, so reducing bytes also
 * reduces both local work and the number of bridge round trips. Any unsupported
 * input or browser failure returns the untouched original camera File.
 */
export async function optimizeCameraImage(
  file: File,
  optimizer: CameraImageOptimizer = browserCameraImageOptimizer,
): Promise<File> {
  if (!shouldOptimizeCameraImage(file)) return file;

  let decoded: DecodedCameraImage | undefined;
  try {
    decoded = await optimizer.decode(file);
    const dimensions = cameraImageDimensions(decoded.width, decoded.height);
    if (!dimensions) return file;
    const encoded = await optimizer.encode(
      decoded,
      dimensions,
      "image/jpeg",
      CAMERA_JPEG_QUALITY,
    );
    // Recompression can increase an already-small image. Preserve the original
    // in that case so camera optimization never makes the upload larger.
    if (!encoded || encoded.size === 0 || encoded.size >= file.size)
      return file;
    return new File([encoded], cameraJpegFilename(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    decoded?.close?.();
  }
}

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
