import type { VoiceRecorderResult } from "./voice";

const DATABASE_NAME = "hermes-chat-drafts";
const STORE_NAME = "voice-recordings";
const DRAFT_KEY = "latest";

type StoredVoiceDraft = VoiceRecorderResult & { id: typeof DRAFT_KEY };

export async function saveVoiceDraft(
  recording: VoiceRecorderResult,
): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    await requestDone(
      database
        .transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .put({ id: DRAFT_KEY, ...recording } satisfies StoredVoiceDraft),
    );
  } finally {
    database.close();
  }
}

export async function loadVoiceDraft(): Promise<VoiceRecorderResult | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    const value = await requestDone<StoredVoiceDraft | undefined>(
      database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(DRAFT_KEY),
    );
    if (!value?.blob || value.blob.size === 0) return null;
    return {
      blob: value.blob,
      mimeType: value.mimeType,
      durationMs: value.durationMs,
    };
  } finally {
    database.close();
  }
}

export async function clearVoiceDraft(): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    await requestDone(
      database
        .transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .delete(DRAFT_KEY),
    );
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB failed"));
  });
}

function requestDone<T = undefined>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB failed"));
  });
}
