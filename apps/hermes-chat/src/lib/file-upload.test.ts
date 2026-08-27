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
  fileMatchesPending,
  loadPendingFileUpload,
  savePendingFileUpload,
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
