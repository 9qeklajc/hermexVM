import { describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools";
import {
  highlightFromEvent,
  QuranClient,
  QuranUserData,
  QURAN_BOOKMARKS_D,
  QURAN_BOOKMARKS_KIND,
  QURAN_DELETION_KIND,
  QURAN_HIGHLIGHT_KIND,
  QURAN_POSITION_D,
  QURAN_POSITION_KIND,
  readStructured,
  reassembleAudioPages,
  reduceUserDataEvents,
} from "./quran.js";
import {
  QURAN_PAGE_GET_TOOL_NAME,
  type QuranAudioPage,
} from "@contexcgi/protocol";

let counter = 0;
function event(partial: Partial<NostrEvent> & { kind: number }): NostrEvent {
  counter += 1;
  return {
    id: `id-${counter}`,
    pubkey: "pk",
    sig: "sig",
    content: "",
    tags: [],
    created_at: 1_700_000_000 + counter,
    ...partial,
  };
}

describe("Quran tool result errors", () => {
  it("surfaces the bridge error instead of blaming structuredContent", () => {
    expect(() =>
      readStructured({
        isError: true,
        content: [
          { type: "text", text: "Unknown tool quran.audio.reciters.list" },
        ],
      }),
    ).toThrow("Unknown tool quran.audio.reciters.list");
  });
});

describe("reassembleAudioPages", () => {
  const page = (
    fromAyah: number,
    ayahs: Array<{ ayah: number; globalAyah: number }>,
    nextAyah?: number,
  ): QuranAudioPage => ({
    surah: 1,
    reciter: "ar.alafasy",
    fromAyah,
    ayahs: ayahs.map(({ ayah, globalAyah }) => ({
      surah: 1,
      ayah,
      globalAyah,
      url: `https://cdn.example/${globalAyah}.mp3`,
    })),
    ...(nextAyah !== undefined ? { nextAyah } : {}),
  });

  it("reassembles ordered pages and preserves global ayah numbers", async () => {
    const pages = new Map([
      [1, page(1, [{ ayah: 1, globalAyah: 1 }], 2)],
      [2, page(2, [{ ayah: 2, globalAyah: 2 }])],
    ]);
    await expect(
      reassembleAudioPages(1, "ar.alafasy", async (fromAyah) => {
        const result = pages.get(fromAyah);
        if (!result) throw new Error("unexpected cursor");
        return result;
      }),
    ).resolves.toMatchObject([
      { ayah: 1, globalAyah: 1 },
      { ayah: 2, globalAyah: 2 },
    ]);
  });

  it("rejects duplicate or inconsistent pages", async () => {
    await expect(
      reassembleAudioPages(1, "ar.alafasy", async () =>
        page(1, [{ ayah: 2, globalAyah: 2 }]),
      ),
    ).rejects.toThrow(/expected ayah 1/);

    await expect(
      reassembleAudioPages(1, "ar.alafasy", async () => ({
        ...page(1, [{ ayah: 1, globalAyah: 1 }]),
        reciter: "ar.husary",
      })),
    ).rejects.toThrow(/reciter/);
  });
});

describe("QuranClient canonical pages", () => {
  it("calls quran.page.get and unwraps the complete page", async () => {
    const client = Object.create(QuranClient.prototype) as QuranClient;
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    (
      client as unknown as {
        call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      }
    ).call = async (name, args) => {
      calls.push({ name, args });
      return { page: { number: 604, ayahs: [] } };
    };

    await expect(client.getPage("quran-uthmani", 604)).resolves.toEqual({
      number: 604,
      ayahs: [],
    });
    expect(calls).toEqual([
      {
        name: QURAN_PAGE_GET_TOOL_NAME,
        args: { edition: "quran-uthmani", page: 604 },
      },
    ]);
  });
});

describe("highlightFromEvent", () => {
  it("parses a NIP-84 quran highlight", () => {
    const highlight = highlightFromEvent(
      event({
        kind: QURAN_HIGHLIGHT_KIND,
        content: "ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ",
        tags: [
          ["r", "quran://quran-uthmani/2/255"],
          ["edition", "quran-uthmani"],
          ["surah", "2"],
          ["ayah", "255"],
          ["description", "Ayat al-Kursi"],
        ],
      }),
    );
    expect(highlight).toMatchObject({
      edition: "quran-uthmani",
      surah: 2,
      ayah: 255,
      description: "Ayat al-Kursi",
      ref: "quran://quran-uthmani/2/255",
    });
  });

  it("ignores non-quran events", () => {
    expect(highlightFromEvent(event({ kind: 1, content: "hello" }))).toBeNull();
    expect(
      highlightFromEvent(event({ kind: QURAN_HIGHLIGHT_KIND })),
    ).toBeNull();
  });
});

describe("reduceUserDataEvents", () => {
  it("keeps the newest highlight per ref", () => {
    const older = event({
      kind: QURAN_HIGHLIGHT_KIND,
      content: "old",
      tags: [["r", "quran://en.asad/1/1"]],
      created_at: 100,
    });
    const newer = event({
      kind: QURAN_HIGHLIGHT_KIND,
      content: "new",
      tags: [["r", "quran://en.asad/1/1"]],
      created_at: 200,
    });
    const state = reduceUserDataEvents([newer, older]);
    expect(state.highlights).toHaveLength(1);
    expect(state.highlights[0]?.text).toBe("new");
  });

  it("drops highlights removed via kind 5", () => {
    const target = event({
      kind: QURAN_HIGHLIGHT_KIND,
      content: "gone",
      tags: [["r", "quran://en.asad/1/1"]],
      created_at: 100,
    });
    const deletion = event({
      kind: QURAN_DELETION_KIND,
      tags: [["e", target.id]],
      created_at: 300,
    });
    const state = reduceUserDataEvents([target, deletion]);
    expect(state.highlights).toHaveLength(0);
  });

  it("keeps positions independent per edition and reads bookmarks", () => {
    const posEnglish = event({
      kind: QURAN_POSITION_KIND,
      tags: [["d", `${QURAN_POSITION_D}/en.asad`]],
      content: JSON.stringify({
        position: { surah: 1, ayah: 1, updatedAt: 1 },
      }),
      created_at: 100,
    });
    const posFrench = event({
      kind: QURAN_POSITION_KIND,
      tags: [["d", `${QURAN_POSITION_D}/fr.hamidullah`]],
      content: JSON.stringify({
        position: { surah: 2, ayah: 5, updatedAt: 2 },
      }),
      created_at: 200,
    });
    const bookmarks = event({
      kind: QURAN_BOOKMARKS_KIND,
      tags: [["d", QURAN_BOOKMARKS_D]],
      content: JSON.stringify({
        bookmarks: [
          {
            edition: "de.bubenheim",
            surah: 18,
            ayah: 10,
            description: "Al-Kahf",
            createdAt: 3,
          },
        ],
      }),
      created_at: 150,
    });
    const state = reduceUserDataEvents([posEnglish, posFrench, bookmarks]);
    expect(state.positions).toEqual({
      "en.asad": { surah: 1, ayah: 1, updatedAt: 1 },
      "fr.hamidullah": { surah: 2, ayah: 5, updatedAt: 2 },
    });
    expect(state.bookmarks).toHaveLength(1);
    expect(state.bookmarks[0]?.description).toBe("Al-Kahf");
  });
});

describe("QuranUserData merge — re-fetch must never wipe data", () => {
  // Regression: highlights/bookmarks disappeared after the app was
  // backgrounded and resumed. Root cause was that fetchAll() replaced state
  // with whatever the relay returned on that single call — and a degraded or
  // empty response (common after a reconnect, or with an in-memory nak serve
  // relay that lost state) would clobber data the user already had. The fix
  // accumulates every observed event in knownEvents and re-reduces the full
  // set on each fetch, so a thin response can only ever ADD to the picture.
  function makeUserData(): QuranUserData {
    // The pool is never connected in these tests — mergeEvents is pure.
    return new QuranUserData({
      privateKey:
        "0000000000000000000000000000000000000000000000000000000000000001",
      relays: [],
      fetchTimeoutMs: 1,
    });
  }

  it("preserves highlights when a second fetch returns nothing", () => {
    const data = makeUserData();
    const highlight = event({
      kind: QURAN_HIGHLIGHT_KIND,
      content: "بِسْمِ ٱللَّهِ",
      tags: [["r", "quran://quran-uthmani/1/1"]],
      created_at: 100,
    });
    // First fetch returns the highlight.
    let state = data.mergeEvents([highlight]);
    expect(state.highlights).toHaveLength(1);

    // Second fetch returns [] — must NOT wipe the highlight.
    state = data.mergeEvents([]);
    expect(state.highlights).toHaveLength(1);
    expect(state.highlights[0]?.text).toBe("بِسْمِ ٱللَّهِ");
  });

  it("preserves bookmarks when a second fetch returns nothing", () => {
    const data = makeUserData();
    const bookmarksEvent = event({
      kind: QURAN_BOOKMARKS_KIND,
      tags: [["d", QURAN_BOOKMARKS_D]],
      content: JSON.stringify({
        bookmarks: [
          {
            edition: "en.asad",
            surah: 18,
            ayah: 10,
            description: "Al-Kahf",
            createdAt: 1,
          },
        ],
      }),
      created_at: 150,
    });
    let state = data.mergeEvents([bookmarksEvent]);
    expect(state.bookmarks).toHaveLength(1);

    state = data.mergeEvents([]);
    expect(state.bookmarks).toHaveLength(1);
    expect(state.bookmarks[0]?.description).toBe("Al-Kahf");
  });

  it("preserves positions across an empty re-fetch", () => {
    const data = makeUserData();
    const positionEvent = event({
      kind: QURAN_POSITION_KIND,
      tags: [["d", `${QURAN_POSITION_D}/en.asad`]],
      content: JSON.stringify({
        position: { surah: 2, ayah: 255, updatedAt: 42 },
      }),
      created_at: 100,
    });
    let state = data.mergeEvents([positionEvent]);
    expect(state.positions["en.asad"]).toEqual({
      surah: 2,
      ayah: 255,
      updatedAt: 42,
    });

    state = data.mergeEvents([]);
    expect(state.positions["en.asad"]).toEqual({
      surah: 2,
      ayah: 255,
      updatedAt: 42,
    });
  });

  it("a deletion is remembered and applied even if the relay forgets the highlight", () => {
    const data = makeUserData();
    const target = event({
      kind: QURAN_HIGHLIGHT_KIND,
      content: "gone",
      tags: [["r", "quran://en.asad/1/1"]],
      created_at: 100,
    });
    const deletion = event({
      kind: QURAN_DELETION_KIND,
      tags: [["e", target.id]],
      created_at: 300,
    });
    // First fetch sees both the highlight and its deletion.
    let state = data.mergeEvents([target, deletion]);
    expect(state.highlights).toHaveLength(0);

    // Second fetch returns only the highlight (relay lost the deletion).
    // The known deletion must still suppress it.
    state = data.mergeEvents([target]);
    expect(state.highlights).toHaveLength(0);
  });

  it("merges new events from a re-fetch on top of known ones", () => {
    const data = makeUserData();
    const first = event({
      kind: QURAN_HIGHLIGHT_KIND,
      content: "first",
      tags: [["r", "quran://en.asad/1/1"]],
      created_at: 100,
    });
    const second = event({
      kind: QURAN_HIGHLIGHT_KIND,
      content: "second",
      tags: [["r", "quran://en.asad/1/2"]],
      created_at: 200,
    });

    let state = data.mergeEvents([first]);
    expect(state.highlights).toHaveLength(1);

    // A second fetch that returns only the second event — the first must
    // still be present because it's retained in knownEvents.
    state = data.mergeEvents([second]);
    expect(state.highlights).toHaveLength(2);
    expect(state.highlights.some((h) => h.text === "first")).toBe(true);
    expect(state.highlights.some((h) => h.text === "second")).toBe(true);
  });
});
