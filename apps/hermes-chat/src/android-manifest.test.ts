import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = readFileSync(
  new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url),
  "utf8",
);
const fileProviderPaths = readFileSync(
  new URL("../android/app/src/main/res/xml/file_paths.xml", import.meta.url),
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

  it("declares the camera permission Capacitor requests for WebView photo capture", () => {
    // The attach menu's capture="environment" input routes through
    // BridgeWebChromeClient: with CAMERA declared it requests the runtime
    // permission, then launches ACTION_IMAGE_CAPTURE for the device camera.
    expect(manifest).toContain("android.permission.CAMERA");
    // …without filtering out camera-less devices from installs.
    expect(manifest).toContain(
      '<uses-feature\n        android:name="android.hardware.camera"\n        android:required="false" />',
    );
    // Capacitor's capture writes into the app-specific external files dir and
    // shares it through the app FileProvider; without this path the provider
    // throws and Capacitor silently falls back to the document picker.
    expect(fileProviderPaths).toContain("external-files-path");
    // Android 11+ package visibility: without this query declaration,
    // resolveActivity(ACTION_IMAGE_CAPTURE) returns null and the camera
    // falls back to the photo picker even after CAMERA was granted.
    expect(manifest).toContain(
      '<intent>\n            <action android:name="android.media.action.IMAGE_CAPTURE" />\n        </intent>',
    );
  });

  it("resizes the WebView for the soft keyboard instead of panning away the header", () => {
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
  });

  it("does not expose the persisted client identity through Android backups", () => {
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).not.toContain('android:allowBackup="true"');
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
