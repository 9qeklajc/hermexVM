import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ApplesauceRelayPool,
  EncryptionMode,
  NostrClientTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import type { Filter, NostrEvent, UnsignedEvent } from "nostr-tools";
import {
  parseQuranVerseRef,
  QURAN_AUDIO_RECITERS_LIST_TOOL_NAME,
  QURAN_AUDIO_SURAH_GET_TOOL_NAME,
  QURAN_EDITIONS_LIST_TOOL_NAME,
  QURAN_PAGE_GET_TOOL_NAME,
  QURAN_SURAHS_LIST_TOOL_NAME,
  QURAN_SURAH_GET_TOOL_NAME,
  QURAN_TAFSIR_GET_TOOL_NAME,
  QURAN_VERSE_GET_TOOL_NAME,
  quranVerseRef,
  type QuranAudioAyah,
  type QuranAudioPage,
  type QuranAyah,
  type QuranEdition,
  type QuranEditionLanguage,
  type QuranPage,
  type QuranReciter,
  type QuranSurah,
  type QuranSurahMeta,
  type QuranSurahPage,
  type QuranTafsirResult,
} from "@contexcgi/protocol";
import { normalizePrivateKey, normalizePublicKey } from "./index.js";

export type QuranClientConfig = {
  privateKey: string;
  serverPubkey: string;
  relays?: string[];
  discoveryRelays?: string[];
  fallbackRelays?: string[];
  encryption?: EncryptionMode;
};

export type QuranVerse = {
  ref: string;
  surah: Pick<
    QuranSurahMeta,
    "number" | "name" | "englishName" | "englishNameTranslation"
  >;
  ayah: QuranAyah;
};

/** Reassemble bounded audio pages while rejecting gaps, duplicates, and loops. */
export async function reassembleAudioPages(
  surah: number,
  reciter: string,
  fetchPage: (fromAyah: number) => Promise<QuranAudioPage>,
): Promise<QuranAudioAyah[]> {
  const ayahs: QuranAudioAyah[] = [];
  let cursor = 1;
  let previousGlobalAyah = 0;
  const seenCursors = new Set<number>();

  while (true) {
    if (seenCursors.has(cursor)) {
      throw new Error(`Quran audio pagination repeated cursor ${cursor}`);
    }
    seenCursors.add(cursor);
    const page = await fetchPage(cursor);
    if (page.surah !== surah) {
      throw new Error(`Quran audio page changed surah to ${page.surah}`);
    }
    if (page.reciter !== reciter) {
      throw new Error(`Quran audio page changed reciter to ${page.reciter}`);
    }
    if (page.fromAyah !== cursor) {
      throw new Error(
        `Quran audio page started at ${page.fromAyah}, expected ${cursor}`,
      );
    }
    if (page.ayahs.length === 0) {
      throw new Error(`Quran audio page ${cursor} contained no ayahs`);
    }

    for (const entry of page.ayahs) {
      const expectedAyah = ayahs.length + 1;
      if (entry.surah !== surah || entry.ayah !== expectedAyah) {
        throw new Error(
          `Quran audio expected ayah ${expectedAyah}, received ${entry.surah}:${entry.ayah}`,
        );
      }
      if (
        !Number.isInteger(entry.globalAyah) ||
        entry.globalAyah <= previousGlobalAyah
      ) {
        throw new Error(
          `Quran audio global ayah order failed at ${entry.ayah}`,
        );
      }
      previousGlobalAyah = entry.globalAyah;
      ayahs.push(entry);
    }

    if (page.nextAyah === undefined) return ayahs;
    const expectedCursor = ayahs.length + 1;
    if (page.nextAyah !== expectedCursor) {
      throw new Error(
        `Quran audio next cursor ${page.nextAyah}, expected ${expectedCursor}`,
      );
    }
    cursor = page.nextAyah;
  }
}

/**
 * ContextVM client for a Quran bridge. Speaks MCP-over-Nostr only; the bridge
 * wraps the public Quran APIs. Same transport posture as HermesChatClient:
 * pinned relays, discovery disabled, liveness ping effectively never.
 */
export class QuranClient {
  private readonly mcpClient: Client;
  private readonly transport: NostrClientTransport;

  constructor(config: QuranClientConfig) {
    const relays =
      config.relays ?? config.discoveryRelays ?? config.fallbackRelays ?? [];
    const relayPool = new ApplesauceRelayPool(relays, {
      pingFrequencyMs: 2_147_400_000,
    });
    this.transport = new NostrClientTransport({
      signer: new PrivateKeySigner(normalizePrivateKey(config.privateKey)),
      relayHandler: relayPool,
      discoveryRelayUrls: config.discoveryRelays ?? [],
      fallbackOperationalRelayUrls: config.fallbackRelays ?? config.relays,
      serverPubkey: normalizePublicKey(config.serverPubkey),
      encryptionMode: config.encryption ?? EncryptionMode.OPTIONAL,
      openStream: {
        enabled: true,
        policy: {
          closeGracePeriodMs: 120_000,
          idleTimeoutMs: 600_000,
          probeTimeoutMs: 60_000,
          maxBufferedChunksPerStream: 5_000,
          maxBufferedBytesPerStream: 64 * 1024 * 1024,
        },
      },
      oversizedTransfer: {
        enabled: true,
        thresholdBytes: 48_000,
        chunkSizeBytes: 48_000,
        policy: {
          maxTransferBytes: 16 * 1024 * 1024,
          maxTransferChunks: 10_000,
        },
      },
    });

    // Clock-skew guard — a phone clock even ~1s ahead of the bridge silently
    // filters out every reply. Same patch as the other ContextVM clients.
    const SINCE_GUARD_SECONDS = 3600;
    type SubFilter = Record<string, unknown> & { since?: number };
    const patchTarget = this.transport as unknown as {
      createSubscriptionFilters: (
        targetPubkey: string,
        additionalFilters?: Record<string, unknown>,
      ) => SubFilter[];
    };
    const buildFilters =
      patchTarget.createSubscriptionFilters.bind(patchTarget);
    patchTarget.createSubscriptionFilters = (
      targetPubkey,
      additionalFilters = {},
    ) =>
      buildFilters(targetPubkey, additionalFilters).map((filter) => ({
        ...filter,
        since: Math.max(
          0,
          (filter.since ?? Math.floor(Date.now() / 1000)) - SINCE_GUARD_SECONDS,
        ),
      }));

    this.mcpClient = new Client({
      name: "quran-reader-client",
      version: "0.1.0",
    });
  }

  async connect(): Promise<void> {
    await this.mcpClient.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.mcpClient.close();
  }

  private async call<T>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    // No-op onprogress → _meta.progressToken → CEP-22 fragmentation works for
    // oversized responses (without it they fail NIP-44 encryption server-side).
    const result = await this.mcpClient.callTool(
      { name, arguments: args },
      undefined,
      { onprogress: () => undefined },
    );
    return readStructured<T>(result);
  }

  async listEditions(): Promise<QuranEdition[]> {
    const payload = await this.call<{ editions: QuranEdition[] }>(
      QURAN_EDITIONS_LIST_TOOL_NAME,
    );
    return payload.editions ?? [];
  }

  async listReciters(): Promise<QuranReciter[]> {
    const payload = await this.call<{ reciters: QuranReciter[] }>(
      QURAN_AUDIO_RECITERS_LIST_TOOL_NAME,
    );
    return payload.reciters ?? [];
  }

  async listSurahs(): Promise<QuranSurahMeta[]> {
    const payload = await this.call<{ surahs: QuranSurahMeta[] }>(
      QURAN_SURAHS_LIST_TOOL_NAME,
    );
    return payload.surahs ?? [];
  }

  async getSurah(edition: string, surah: number): Promise<QuranSurah> {
    // Bound each encrypted tool response well below NIP-44's 65,535-byte
    // plaintext ceiling. Arabic pages (RTL, longer glyphs) inflate ~1.7x when
    // gift-wrapped, so 30 ayahs stays safely under the ceiling — 60 ayahs of
    // dense Arabic (e.g. Al-Baqarah ayahs 181–240) crosses it and the bridge's
    // CEP-22 oversized fallback is unreliable, causing a silent 60s timeout.
    const PAGE_SIZE = 30;
    const ayahs: QuranAyah[] = [];
    let nextAyah: number | undefined = 1;
    let first: QuranSurahPage | undefined;
    while (nextAyah !== undefined) {
      const payload: { surah: QuranSurahPage } = await this.call<{
        surah: QuranSurahPage;
      }>(QURAN_SURAH_GET_TOOL_NAME, {
        edition,
        surah,
        fromAyah: nextAyah,
        limit: PAGE_SIZE,
      });
      first ??= payload.surah;
      ayahs.push(...payload.surah.ayahs);
      nextAyah = payload.surah.nextAyah;
    }
    if (!first)
      throw new Error(`Quran bridge returned no pages for surah ${surah}`);
    return {
      number: first.number,
      name: first.name,
      englishName: first.englishName,
      englishNameTranslation: first.englishNameTranslation,
      revelationType: first.revelationType,
      ayahCount: first.ayahCount,
      ayahs,
    };
  }

  async getPage(edition: string, page: number): Promise<QuranPage> {
    const payload = await this.call<{ page: QuranPage }>(
      QURAN_PAGE_GET_TOOL_NAME,
      { edition, page },
    );
    return payload.page;
  }

  getSurahAudio(
    surah: number,
    reciter = "ar.alafasy",
  ): Promise<QuranAudioAyah[]> {
    return reassembleAudioPages(surah, reciter, async (fromAyah) => {
      const payload = await this.call<{ audio: QuranAudioPage }>(
        QURAN_AUDIO_SURAH_GET_TOOL_NAME,
        { surah, reciter, fromAyah, limit: 60 },
      );
      return payload.audio;
    });
  }

  getVerse(edition: string, surah: number, ayah: number): Promise<QuranVerse> {
    return this.call<QuranVerse>(QURAN_VERSE_GET_TOOL_NAME, {
      edition,
      surah,
      ayah,
    });
  }

  getTafsir(
    surah: number,
    ayah: number,
    language: QuranEditionLanguage = "en",
  ): Promise<QuranTafsirResult> {
    return this.call<{ tafsir: QuranTafsirResult }>(
      QURAN_TAFSIR_GET_TOOL_NAME,
      { surah, ayah, language },
    ).then((payload) => payload.tafsir);
  }
}

// ---------------------------------------------------------------------------
// User data, boris-style: reading position, bookmarks, and highlights live as
// Nostr events signed by the reader's own key — portable across devices.
//
//   highlight  → kind 9802 (NIP-84), content = verse text, `r` = quran:// ref
//   bookmarks  → kind 30003 (NIP-51-style set), d = "quran-bookmarks"
//   position   → kind 30078 (NIP-78 app data), d = "quran-reader/position"
//   removal    → kind 5 deletion referencing the highlight event id
// ---------------------------------------------------------------------------

export const QURAN_HIGHLIGHT_KIND = 9802;
export const QURAN_BOOKMARKS_KIND = 30003;
export const QURAN_POSITION_KIND = 30078;
export const QURAN_DELETION_KIND = 5;
export const QURAN_BOOKMARKS_D = "quran-bookmarks";
export const QURAN_POSITION_D = "quran-reader/position";

export type QuranPosition = {
  surah: number;
  ayah: number;
  /** Epoch ms. */
  updatedAt: number;
};

export type QuranBookmark = {
  edition: string;
  surah: number;
  ayah: number;
  description: string;
  /** Epoch ms. */
  createdAt: number;
};

export type QuranHighlight = {
  /** Nostr event id of the kind 9802 that created it. */
  id: string;
  edition: string;
  surah: number;
  ayah: number;
  /** The highlighted verse text (event content). */
  text: string;
  description?: string;
  /** Epoch seconds. */
  createdAt: number;
  ref: string;
};

export type QuranUserDataState = {
  /** Keyed by edition id — each version remembers its own stop point. */
  positions: Record<string, QuranPosition>;
  bookmarks: QuranBookmark[];
  highlights: QuranHighlight[];
};

export const EMPTY_QURAN_USER_DATA: QuranUserDataState = {
  positions: {},
  bookmarks: [],
  highlights: [],
};

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/** Map one kind 9802 event to a highlight; null when it isn't a Quran one. */
export function highlightFromEvent(event: NostrEvent): QuranHighlight | null {
  if (event.kind !== QURAN_HIGHLIGHT_KIND) return null;
  const ref = tagValue(event, "r");
  const parsed = ref ? parseQuranVerseRef(ref) : null;
  const surah = parsed?.surah ?? Number(tagValue(event, "surah"));
  const ayah = parsed?.ayah ?? Number(tagValue(event, "ayah"));
  const edition = parsed?.edition ?? tagValue(event, "edition");
  if (!edition || !Number.isInteger(surah) || !Number.isInteger(ayah)) {
    return null;
  }
  const description = tagValue(event, "description");
  return {
    id: event.id,
    edition,
    surah,
    ayah,
    text: event.content,
    ...(description ? { description } : {}),
    createdAt: event.created_at,
    ref: quranVerseRef(edition, surah, ayah),
  };
}

function parseJsonContent<T>(event: NostrEvent): T | null {
  try {
    return JSON.parse(event.content) as T;
  } catch {
    return null;
  }
}

/** Reduce a batch of user-data events into the current state. */
export function reduceUserDataEvents(events: NostrEvent[]): QuranUserDataState {
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at);
  const deletedIds = new Set<string>();
  const highlightByRef = new Map<string, QuranHighlight>();
  let positions: Record<string, QuranPosition> = {};
  let bookmarks: QuranBookmark[] = [];

  for (const event of sorted) {
    if (event.kind === QURAN_DELETION_KIND) {
      for (const tag of event.tags) {
        if (tag[0] === "e" && tag[1]) deletedIds.add(tag[1]);
      }
      continue;
    }
    if (event.kind === QURAN_HIGHLIGHT_KIND) {
      const highlight = highlightFromEvent(event);
      if (highlight) highlightByRef.set(highlight.ref, highlight);
      continue;
    }
    if (event.kind === QURAN_POSITION_KIND) {
      const d = tagValue(event, "d");
      if (d?.startsWith(`${QURAN_POSITION_D}/`)) {
        const edition = decodeURIComponent(
          d.slice(QURAN_POSITION_D.length + 1),
        );
        const parsed = parseJsonContent<{ position?: QuranPosition }>(event);
        if (edition && parsed?.position) {
          positions = { ...positions, [edition]: parsed.position };
        }
        continue;
      }
      // Backward compatibility with the original aggregate event shape.
      if (d === QURAN_POSITION_D) {
        const parsed = parseJsonContent<{
          positions?: Record<string, QuranPosition>;
        }>(event);
        if (parsed?.positions) positions = parsed.positions;
        continue;
      }
    }
    if (
      event.kind === QURAN_BOOKMARKS_KIND &&
      tagValue(event, "d") === QURAN_BOOKMARKS_D
    ) {
      const parsed = parseJsonContent<{ bookmarks?: QuranBookmark[] }>(event);
      if (Array.isArray(parsed?.bookmarks)) bookmarks = parsed.bookmarks;
    }
  }

  const highlights = [...highlightByRef.values()]
    .filter((highlight) => !deletedIds.has(highlight.id))
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    positions,
    bookmarks: [...bookmarks].sort((a, b) => b.createdAt - a.createdAt),
    highlights,
  };
}

export type QuranUserDataConfig = {
  privateKey: string;
  relays: string[];
  /** Max wait for relay history before returning what we have. */
  fetchTimeoutMs?: number;
};

/**
 * Loads and publishes the reader's own Nostr data (boris-style). One instance
 * per identity; call `fetchAll()` once after construction, then use the
 * mutation helpers — they update local state AND publish.
 */
export class QuranUserData {
  private readonly signer: PrivateKeySigner;
  private readonly pool: ApplesauceRelayPool;
  private readonly fetchTimeoutMs: number;
  private publicKey?: string;
  private lastCreatedAt = 0;
  private state: QuranUserDataState = EMPTY_QURAN_USER_DATA;
  // Every event we've ever observed — fetched from relays or published by us.
  // Preserved across re-fetches so a transiently empty or degraded relay
  // response can never wipe highlights/bookmarks the user already has. Each
  // fetch merges into this map, then the full set is re-reduced.
  private knownEvents = new Map<string, NostrEvent>();

  constructor(config: QuranUserDataConfig) {
    this.signer = new PrivateKeySigner(normalizePrivateKey(config.privateKey));
    this.pool = new ApplesauceRelayPool(config.relays, {
      pingFrequencyMs: 2_147_400_000,
    });
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? 12_000;
  }

  get current(): QuranUserDataState {
    return this.state;
  }

  /** Track an event so it survives future re-fetches. */
  private remember(event: NostrEvent): NostrEvent {
    this.knownEvents.set(event.id, event);
    return event;
  }

  private async publish(
    kind: number,
    content: string,
    tags: string[][],
  ): Promise<NostrEvent> {
    // Replaceable events published within the same second otherwise tie on
    // created_at and relays may keep the older value. Make timestamps strictly
    // increasing inside this identity session.
    const now = Math.floor(Date.now() / 1000);
    const createdAt = Math.max(now, this.lastCreatedAt + 1);
    this.lastCreatedAt = createdAt;
    const unsigned: UnsignedEvent = {
      kind,
      content,
      tags,
      created_at: createdAt,
      pubkey: this.publicKey ?? (await this.signer.getPublicKey()),
    };
    const event = await this.signer.signEvent(unsigned);
    await this.pool.publish(event);
    return this.remember(event);
  }

  /**
   * Merge a batch of events with everything already observed and re-reduce
   * the full set. Exposed so tests can verify the merge without a live relay
   * pool. This is the key safeguard: a re-fetch that returns fewer events
   * (or none) than a previous fetch can never shrink the user's data, because
   * the previously seen events are still in the map and participate in the
   * reduction.
   */
  mergeEvents(events: NostrEvent[]): QuranUserDataState {
    for (const event of events) {
      this.knownEvents.set(event.id, event);
    }
    this.state = reduceUserDataEvents([...this.knownEvents.values()]);
    return this.state;
  }

  /**
   * Fetch every user-data event from the relays and fold it into state.
   * Merges with previously seen events so a degraded/empty relay response
   * (common after a background→foreground reconnect, or with an in-memory
   * `nak serve` relay that lost state) can never wipe the user's highlights,
   * bookmarks, or reading positions.
   */
  async fetchAll(): Promise<QuranUserDataState> {
    this.publicKey = await this.signer.getPublicKey();
    const filters: Filter[] = [
      {
        kinds: [
          QURAN_HIGHLIGHT_KIND,
          QURAN_BOOKMARKS_KIND,
          QURAN_POSITION_KIND,
          QURAN_DELETION_KIND,
        ],
        authors: [this.publicKey],
      },
    ];
    const events: NostrEvent[] = [];
    await this.pool.connect().catch(() => undefined);
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const timer = setTimeout(done, this.fetchTimeoutMs);
      this.pool
        .subscribe(
          filters,
          (event) => {
            events.push(event);
          },
          () => {
            clearTimeout(timer);
            done();
          },
        )
        .then((unsubscribe) => {
          // Give trailing replaceable events a moment past EOSE, then close.
          const wrap = () => setTimeout(() => unsubscribe(), 500);
          if (settled) wrap();
          else {
            const interval = setInterval(() => {
              if (settled) {
                clearInterval(interval);
                wrap();
              }
            }, 250);
            interval.unref?.();
          }
        })
        .catch(() => done());
    });
    return this.mergeEvents(events);
  }

  async setPosition(edition: string, position: QuranPosition): Promise<void> {
    const positions = { ...this.state.positions, [edition]: position };
    this.state = { ...this.state, positions };
    await this.publish(QURAN_POSITION_KIND, JSON.stringify({ position }), [
      ["d", `${QURAN_POSITION_D}/${encodeURIComponent(edition)}`],
    ]);
  }

  async addBookmark(bookmark: QuranBookmark): Promise<void> {
    const deduped = this.state.bookmarks.filter(
      (entry) =>
        !(
          entry.edition === bookmark.edition &&
          entry.surah === bookmark.surah &&
          entry.ayah === bookmark.ayah
        ),
    );
    const bookmarks = [bookmark, ...deduped];
    this.state = { ...this.state, bookmarks };
    await this.publishBookmarks(bookmarks);
  }

  async removeBookmark(
    edition: string,
    surah: number,
    ayah: number,
  ): Promise<void> {
    const bookmarks = this.state.bookmarks.filter(
      (entry) =>
        !(
          entry.edition === edition &&
          entry.surah === surah &&
          entry.ayah === ayah
        ),
    );
    this.state = { ...this.state, bookmarks };
    await this.publishBookmarks(bookmarks);
  }

  private async publishBookmarks(bookmarks: QuranBookmark[]): Promise<void> {
    await this.publish(QURAN_BOOKMARKS_KIND, JSON.stringify({ bookmarks }), [
      ["d", QURAN_BOOKMARKS_D],
      ["title", "Quran bookmarks"],
      ...bookmarks.map((bookmark) => [
        "r",
        quranVerseRef(bookmark.edition, bookmark.surah, bookmark.ayah),
      ]),
    ]);
  }

  /** Create a highlight; returns it with the event id filled in. */
  async addHighlight(input: {
    edition: string;
    surah: number;
    ayah: number;
    text: string;
    description?: string;
  }): Promise<QuranHighlight> {
    const tags = [
      ["r", quranVerseRef(input.edition, input.surah, input.ayah)],
      ["edition", input.edition],
      ["surah", String(input.surah)],
      ["ayah", String(input.ayah)],
      ["alt", "Quran verse highlight"],
      ...(input.description ? [["description", input.description]] : []),
    ];
    const event = await this.publish(QURAN_HIGHLIGHT_KIND, input.text, tags);
    const highlight: QuranHighlight = {
      id: event.id,
      edition: input.edition,
      surah: input.surah,
      ayah: input.ayah,
      text: input.text,
      ...(input.description ? { description: input.description } : {}),
      createdAt: event.created_at,
      ref: quranVerseRef(input.edition, input.surah, input.ayah),
    };
    const highlights = [
      highlight,
      ...this.state.highlights.filter((entry) => entry.ref !== highlight.ref),
    ];
    this.state = { ...this.state, highlights };
    return highlight;
  }

  /** Edit a highlight's description (publishes a replacement kind 9802). */
  async updateHighlight(
    previous: QuranHighlight,
    patch: { description?: string },
  ): Promise<QuranHighlight> {
    await this.publish(QURAN_DELETION_KIND, "", [
      ["e", previous.id],
      ["k", String(QURAN_HIGHLIGHT_KIND)],
    ]);
    return this.addHighlight({
      edition: previous.edition,
      surah: previous.surah,
      ayah: previous.ayah,
      text: previous.text,
      ...(patch.description ? { description: patch.description } : {}),
    });
  }

  async removeHighlight(id: string): Promise<void> {
    this.state = {
      ...this.state,
      highlights: this.state.highlights.filter((entry) => entry.id !== id),
    };
    await this.publish(QURAN_DELETION_KIND, "", [
      ["e", id],
      ["k", String(QURAN_HIGHLIGHT_KIND)],
    ]);
  }

  async close(): Promise<void> {
    await this.pool.disconnect();
  }
}

export function readStructured<T>(value: unknown): T {
  if (isObject(value) && value.isError === true) {
    const message = Array.isArray(value.content)
      ? value.content
          .filter(
            (entry): entry is { type: "text"; text: string } =>
              isObject(entry) &&
              entry.type === "text" &&
              typeof entry.text === "string",
          )
          .map((entry) => entry.text)
          .join("\n")
          .trim()
      : "";
    throw new Error(message || "Quran bridge tool call failed");
  }
  if (isObject(value) && isObject(value.structuredContent)) {
    return value.structuredContent as T;
  }
  throw new Error("Quran bridge tool result did not include structuredContent");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
