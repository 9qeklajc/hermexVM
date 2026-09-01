import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatSource = readFileSync(
  new URL("./screens/Chat.tsx", import.meta.url),
  "utf8",
);

describe("cached reconnect UI source contracts", () => {
  it("renders an honest no-history state and explicitly read-only cached rows", () => {
    const start = chatSource.indexOf("export function CachedChatScreen");
    const end = chatSource.indexOf("export function ChatScreen", start);
    const cachedScreen = chatSource.slice(start, end);

    expect(cachedScreen).toContain('title="Messages are not cached"');
    expect(cachedScreen).toContain("item={item} readOnly");
    expect(cachedScreen).not.toContain("<Spinner");
    expect(cachedScreen).not.toContain("onSelectMessage");
  });
});
