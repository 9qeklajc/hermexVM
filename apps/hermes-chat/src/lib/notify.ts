import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

// ---------------------------------------------------------------------------
// Native notifications — a thin wrapper over @capacitor/local-notifications,
// with a Web Notifications fallback so the vite dev build behaves the same.
// ---------------------------------------------------------------------------

const CHANNEL_ID = "agent-replies";

let ready: Promise<boolean> | null = null;

/** Request permission (once) and create the Android channel. Safe to call often. */
export function initNotifications(): Promise<boolean> {
  if (!ready) ready = init();
  return ready;
}

async function init(): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      let permission = await LocalNotifications.checkPermissions();
      if (
        permission.display === "prompt" ||
        permission.display === "prompt-with-rationale"
      ) {
        permission = await LocalNotifications.requestPermissions();
      }
      if (permission.display !== "granted") return false;
      await LocalNotifications.createChannel({
        id: CHANNEL_ID,
        name: "Agent replies",
        description: "A Hermes agent finished a reply",
        importance: 4, // heads-up
      });
      return true;
    } catch {
      return false;
    }
  }
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "default") {
    await Notification.requestPermission().catch(() => undefined);
  }
  return Notification.permission === "granted";
}

/** Show a notification immediately; reusing an id replaces that notification. */
export async function notify(
  id: number,
  title: string,
  body: string,
): Promise<void> {
  if (!(await initNotifications())) return;
  if (Capacitor.isNativePlatform()) {
    await LocalNotifications.schedule({
      notifications: [{ id, title, body, channelId: CHANNEL_ID }],
    }).catch(() => undefined);
    return;
  }
  new Notification(title, { body, tag: String(id) });
}

/** Stable 31-bit id from a string key, so one run keeps one notification slot. */
export function notificationId(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++)
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(hash) || 1;
}
