import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatSource = readFileSync(
  new URL("./screens/Chat.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("chat composer interaction contract", () => {
  it("leaves Enter to the textarea instead of sending from the keyboard", () => {
    const textareaStart = chatSource.indexOf("<textarea");
    const textareaEnd = chatSource.indexOf("/>", textareaStart);
    const textarea = chatSource.slice(textareaStart, textareaEnd);

    expect(textarea).toContain('enterKeyHint="enter"');
    expect(textarea).not.toContain("onKeyDown");
    expect(textarea).not.toContain("send()");
  });

  it("grows the draft field but caps it at four text rows", () => {
    expect(chatSource).toContain("useLayoutEffect(() =>");
    expect(chatSource).toContain("textarea.scrollHeight");
    expect(styles).toContain("--composer-line-height: 20px");
    expect(styles).toContain("Four 20px text rows plus 21px vertical padding");
    expect(styles).toContain("max-height: 101px");
  });
});
