import { describe, expect, it } from "vitest";
import { mergeChatPages } from "./Chats";

describe("conversation pagination", () => {
  it("appends older pages after the latest conversations", () => {
    const latest = [{ id: "latest" }, { id: "recent" }];
    const older = [{ id: "older" }, { id: "oldest" }];

    expect(
      mergeChatPages(latest, older, "back").map((chat) => chat.id),
    ).toEqual(["latest", "recent", "older", "oldest"]);
  });

  it("moves refreshed conversations back to the front without duplicates", () => {
    const current = [{ id: "latest" }, { id: "older" }];
    const refreshed = [{ id: "older" }, { id: "latest" }];

    expect(
      mergeChatPages(current, refreshed, "front").map((chat) => chat.id),
    ).toEqual(["older", "latest"]);
  });
});
