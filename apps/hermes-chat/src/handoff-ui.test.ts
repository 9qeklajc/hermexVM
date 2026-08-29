import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composer = readFileSync(
  new URL("./components/HandoffComposer.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const handoffStyles = styles.slice(
  styles.indexOf("/* Cross-agent handoff composer"),
);

describe("send-to modal contract", () => {
  it("keeps the current/default agent available for another conversation", () => {
    expect(composer).toContain("const choices = profiles;");
    expect(composer).not.toContain(
      "profiles.filter(\n          (profile) => profile.id !== source.agentId",
    );
  });

  it("uses the same bottom-sheet structure as the app's other modals", () => {
    expect(composer).toContain('className="modal-sheet handoff-composer"');
    expect(composer).toContain('className="modal-handle"');
    expect(composer).toContain('className="modal-header"');
    expect(composer).toContain('className="handoff-body"');
    expect(composer).not.toContain('className="handoff-head"');
  });

  it("shows a centered loading state while initial modal data loads", () => {
    expect(composer).toContain('className="handoff-initial-loading"');
    expect(composer).toContain("<Spinner />");
    expect(composer).toContain("aria-busy={initialLoading}");
    expect(styles).toContain(".handoff-initial-loading");
  });

  it("uses app theme tokens and shows the full selected message text", () => {
    expect(handoffStyles).toContain("background: var(--background)");
    expect(handoffStyles).toContain("white-space: pre-wrap");
    expect(handoffStyles).toContain("overflow-wrap: anywhere");
    expect(handoffStyles).not.toContain("-webkit-line-clamp: 3");
    expect(handoffStyles).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(handoffStyles).not.toContain("linear-gradient");
  });
});
