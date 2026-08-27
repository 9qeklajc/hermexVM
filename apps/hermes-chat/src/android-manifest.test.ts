import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = readFileSync(
  new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url),
  "utf8",
);
const mainActivity = readFileSync(
  new URL(
    "../android/app/src/main/java/ai/hermex/vm/MainActivity.java",
    import.meta.url,
  ),
  "utf8",
);
const android15StylesUrl = new URL(
  "../android/app/src/main/res/values-v35/styles.xml",
  import.meta.url,
);
const android15Styles = existsSync(android15StylesUrl)
  ? readFileSync(android15StylesUrl, "utf8")
  : "";

describe("Android app manifest", () => {
  it("declares every permission Capacitor requests for WebView audio capture", () => {
    // BridgeWebChromeClient requests BOTH for AUDIO_CAPTURE; missing either one
    // makes the WebView permission request auto-deny even after the user
    // granted the microphone ("Microphone permission was denied").
    expect(manifest).toContain("android.permission.RECORD_AUDIO");
    expect(manifest).toContain("android.permission.MODIFY_AUDIO_SETTINGS");
    expect(manifest).toContain("android.permission.POST_NOTIFICATIONS");
  });

  it("resizes the WebView for the soft keyboard instead of panning away the header", () => {
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
  });

  it("keeps the WebView below the phone status bar on Android 15", () => {
    expect(mainActivity).toContain("WindowCompat.setDecorFitsSystemWindows");
    expect(mainActivity).toContain("getWindow(), true");
    expect(android15Styles).toContain(
      '<style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">',
    );
    expect(android15Styles).toContain(
      '<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">',
    );
    expect(android15Styles).toContain(
      '<item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>',
    );
  });
});
