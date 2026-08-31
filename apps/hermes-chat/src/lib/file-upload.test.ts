import { beforeEach, describe, expect, it, vi } from "vitest";

const values = new Map<string, string>();
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: values.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      values.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      values.delete(key);
    }),
  },
}));

import {
  blobUploadSource,
  CAMERA_JPEG_QUALITY,
  cameraImageDimensions,
  cameraJpegFilename,
  fileMatchesPending,
  loadPendingFileUpload,
  optimizeCameraImage,
  savePendingFileUpload,
  shouldOptimizeCameraImage,
  type CameraImageOptimizer,
  type PendingFileUpload,
} from "./file-upload";

const pending = (): PendingFileUpload => ({
  uploadId: "upload-1",
  filename: "photo.jpg",
  sizeBytes: 5,
  mimeType: "image/jpeg",
  sha256: "a".repeat(64),
  expiresAt: Date.now() + 60_000,
});

describe("camera upload optimization", () => {
  it("caps the longest edge at 2048px while preserving aspect ratio", () => {
    expect(cameraImageDimensions(4000, 3000)).toEqual({
      width: 2048,
      height: 1536,
    });
    expect(cameraImageDimensions(3000, 4000)).toEqual({
      width: 1536,
      height: 2048,
    });
    expect(cameraImageDimensions(3000, 3000)).toEqual({
      width: 2048,
      height: 2048,
    });
  });

  it("does not upscale and rejects invalid dimensions", () => {
    expect(cameraImageDimensions(2048, 1024)).toEqual({
      width: 2048,
      height: 1024,
    });
    expect(cameraImageDimensions(800, 600)).toEqual({
      width: 800,
      height: 600,
    });
    expect(cameraImageDimensions(0, 600)).toBeNull();
    expect(cameraImageDimensions(Number.NaN, 600)).toBeNull();
  });

  it("selects browser-decodable camera formats without selecting documents", () => {
    expect(shouldOptimizeCameraImage({ size: 100, type: "image/jpeg" })).toBe(
      true,
    );
    expect(shouldOptimizeCameraImage({ size: 100, type: "image/png" })).toBe(
      true,
    );
    expect(shouldOptimizeCameraImage({ size: 100, type: "image/heic" })).toBe(
      false,
    );
    expect(
      shouldOptimizeCameraImage({ size: 100, type: "application/pdf" }),
    ).toBe(false);
    expect(shouldOptimizeCameraImage({ size: 0, type: "image/jpeg" })).toBe(
      false,
    );
  });

  it("creates a smaller oriented JPEG with a sensible name and closes the decoder", async () => {
    const original = new File([new Uint8Array(1000)], "IMG_1234.PNG", {
      type: "image/png",
      lastModified: 123,
    });
    const close = vi.fn();
    const optimizer: CameraImageOptimizer = {
      decode: vi.fn(async () => ({
        source: {} as CanvasImageSource,
        width: 4000,
        height: 3000,
        close,
      })),
      encode: vi.fn(async () => new Blob([new Uint8Array(500)])),
    };

    const optimized = await optimizeCameraImage(original, optimizer);

    expect(optimizer.encode).toHaveBeenCalledWith(
      expect.objectContaining({ width: 4000, height: 3000 }),
      { width: 2048, height: 1536 },
      "image/jpeg",
      CAMERA_JPEG_QUALITY,
    );
    expect(optimized).not.toBe(original);
    expect(optimized).toMatchObject({
      name: "IMG_1234.jpg",
      type: "image/jpeg",
      size: 500,
      lastModified: 123,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the original on decode failure, encode failure, or size increase", async () => {
    const original = new File([new Uint8Array(1000)], "photo.jpg", {
      type: "image/jpeg",
    });
    const decodeFailure: CameraImageOptimizer = {
      decode: vi.fn(async () => {
        throw new Error("unsupported decoder");
      }),
      encode: vi.fn(),
    };
    await expect(optimizeCameraImage(original, decodeFailure)).resolves.toBe(
      original,
    );

    const close = vi.fn();
    const decoded = {
      source: {} as CanvasImageSource,
      width: 1000,
      height: 800,
      close,
    };
    const encodeFailure: CameraImageOptimizer = {
      decode: vi.fn(async () => decoded),
      encode: vi.fn(async () => null),
    };
    await expect(optimizeCameraImage(original, encodeFailure)).resolves.toBe(
      original,
    );

    const largerOutput: CameraImageOptimizer = {
      decode: vi.fn(async () => decoded),
      encode: vi.fn(async () => new Blob([new Uint8Array(1000)])),
    };
    await expect(optimizeCameraImage(original, largerOutput)).resolves.toBe(
      original,
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("normalizes JPEG filenames", () => {
    expect(cameraJpegFilename("DCIM/camera.photo.jpeg")).toBe(
      "camera.photo.jpg",
    );
    expect(cameraJpegFilename("untitled")).toBe("untitled.jpg");
    expect(cameraJpegFilename(".jpeg")).toBe("camera-photo.jpg");
  });
});

describe("file upload resume state", () => {
  beforeEach(() => values.clear());

  it("persists only safe metadata and restores it", async () => {
    await savePendingFileUpload(pending());
    await expect(loadPendingFileUpload()).resolves.toMatchObject({
      uploadId: "upload-1",
      filename: "photo.jpg",
    });
  });

  it("requires the user to reselect the same file identity", () => {
    expect(
      fileMatchesPending(
        { name: "photo.jpg", size: 5, type: "image/jpeg" },
        pending(),
      ),
    ).toBe(true);
    expect(
      fileMatchesPending(
        { name: "other.jpg", size: 5, type: "image/jpeg" },
        pending(),
      ),
    ).toBe(false);
  });

  it("reads a Blob in bounded slices", async () => {
    const source = blobUploadSource(
      new Blob([Uint8Array.from([1, 2, 3, 4, 5])]),
    );
    await expect(source.read(1, 4)).resolves.toEqual(
      Uint8Array.from([2, 3, 4]),
    );
  });
});
