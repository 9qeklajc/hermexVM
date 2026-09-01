import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatSource = readFileSync(
  new URL("./screens/Chat.tsx", import.meta.url),
  "utf8",
);
const fileUploaderSource = readFileSync(
  new URL("./components/FileUploader.tsx", import.meta.url),
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

  it("persists model selection immediately for an existing conversation", () => {
    expect(chatSource).toContain("await client.switchModel({");
    expect(chatSource).toContain("chatId,");
    expect(chatSource).toContain("setPendingModel(null)");
    expect(chatSource).toContain("setPendingModel({ model, provider })");
  });

  it("opens a WhatsApp-style attach menu with camera and document options", () => {
    // The attach button toggles a menu instead of jumping straight into the
    // file picker.
    expect(fileUploaderSource).toContain('aria-haspopup="menu"');
    expect(fileUploaderSource).toContain('role="menu"');
    expect(fileUploaderSource).toContain("Camera");
    expect(fileUploaderSource).toContain("Document");
    // Tapping away or Escape closes the menu.
    expect(fileUploaderSource).toContain("attach-menu-backdrop");
    expect(fileUploaderSource).toMatch(/Escape.*setMenuOpen/);
  });

  it("shows upload progress inline in the attach button and truncates the filename toast", () => {
    // The percent replaces the paperclip icon while uploading — same pattern
    // as the voice recorder's mic slot — capped at 99% until the "done" toast
    // confirms the upload really finished.
    expect(fileUploaderSource).toContain('className="file-upload-progress"');
    expect(fileUploaderSource).toContain('role="progressbar"');
    expect(fileUploaderSource).toContain(
      "aria-valuenow={Math.min(99, progress)}",
    );
    expect(fileUploaderSource).toContain("Math.min(99, progress)");
    // The busy toast carries only the filename, so a long photo name can never
    // push the percentage to an overflowing second line.
    expect(fileUploaderSource).toContain(
      'className="file-progress" title={filename}',
    );
    expect(fileUploaderSource).not.toContain("{filename} {progress}%");
    // The toast is one ellipsized line; error/done toasts wrap long unbroken
    // names inside the box instead of overflowing it.
    expect(styles).toMatch(
      /\.composer-field \.file-progress \{[^}]*white-space: nowrap;/s,
    );
    expect(styles).toContain("overflow-wrap: anywhere");
    expect(styles).toContain("text-overflow: ellipsis");
    expect(styles).toContain(".file-upload-progress__ring {");
    expect(styles).toContain("prefers-reduced-motion: reduce");
    expect(fileUploaderSource).toMatch(/role="status" aria-live="polite"/);
  });

  it("routes the camera option through the device camera on Android and a webcam modal on the web", () => {
    // capture="environment" makes Capacitor's WebView file chooser launch
    // ACTION_IMAGE_CAPTURE (the device camera app) instead of the picker.
    expect(fileUploaderSource).toContain('capture="environment"');
    expect(fileUploaderSource).toContain("cameraInputRef.current?.click()");
    // The web fallback is the getUserMedia webcam modal, not the file picker.
    expect(fileUploaderSource).toContain("<CameraCapture");
    // Both camera routes optimize before upload; the separate Document input
    // still passes its selected File directly to handleFile.
    expect(fileUploaderSource).toMatch(/onCapture={handleCapturedPhoto}/);
    expect(fileUploaderSource).toContain("await optimizeCameraImage(file)");
    expect(fileUploaderSource).toMatch(/if \(file\) void handleFile\(file\)/);
    expect(fileUploaderSource).toMatch(
      /if \(file\) void handleCapturedPhoto\(file\)/,
    );
    // The menu is anchored above the composer through the positioned uploader.
    expect(styles).toContain(".attach-menu {");
    expect(styles).toContain("bottom: calc(100% + 12px)");
    expect(styles).toContain(".camera-capture__shutter");
  });
});
