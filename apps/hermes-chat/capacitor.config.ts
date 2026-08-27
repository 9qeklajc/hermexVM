import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.hermex.vm",
  appName: "hermexVM",
  webDir: "dist",
  server: {
    // http scheme + cleartext so the WebView may open ws:// relay connections
    // to LAN / tailnet hosts without being blocked as mixed content.
    androidScheme: "http",
    cleartext: true,
  },
};

export default config;
