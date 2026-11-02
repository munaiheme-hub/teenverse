```js
import { base44 } from "@/api/base44Client";

// Central notification dispatcher for TeenVerse.
//
// Every event that should reach a member goes through here. The work is done
// server-side by `notifyEvent`, which validates the recipients, respects
// notification preferences and blocks, de-duplicates by event key, saves the
// permanent in-app record and pushes it to their devices — so an alert still
// arrives when TeenVerse is closed, and is still in the bell when they return.
//
// If that call cannot be made (offline, transient failure) the notification is
// written locally and the device alert queued, so nothing is silently lost.

let pushPausedUntil = 0;

const QUEUE_KEY = "tv_push_queue";
const QUEUE_MAX = 25;
const QUEUE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function readQueue() {
  try {
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    const cutoff = Date.now() - QUEUE_TTL_MS;
    return raw.filter((item) => item && item.at > cutoff && item.payload);
  } catch {
    return [];
  }
}

function writeQueue(items) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-QUEUE_MAX)));
  } catch {
    /* storage unavailable — nothing to retry from */
  }
}

function queuePush(payload) {
  const items = readQueue();
  items.push({ at: Date.now(), attempts: 0, payload });
  writeQueue(items);
}

/** Retry every alert that could not be delivered while the device was away. */
export async function flushPendingPushes() {
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  const pending = readQueue();
  if (!pending.length) return;
  const keep = [];
  for (const item of pending) {
    const attempts = item.attempts || 0;
    if (attempts >= MAX_ATTEMPTS) continue;
    try {
      await base44.functions.invoke("notifyPush", item.payload);
    } catch {
      keep.push({ ...item, attempts: attempts + 1 });
    }
  }
  writeQueue(keep);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { flushPendingPushes().catch(() => {}); });
  setTimeout(() => { flushPendingPushes().catch(() => {}); }, 4000);
}

/** Send one device alert only (no in-app record). */
export function pushDeviceAlert({ userIds, title, body, link, type, icon, tag, force }) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (!ids.length || !title) return;
  if (Date.now() < pushPausedUntil) return;
  const payload = { user_ids: ids, title, body, link, type, icon, tag, force };
  try {
    base44.functions.invoke("notifyPush", payload).catch((error) => {
      const status = error?.response?.status;
      if (status === 402 || /402|integration credits|payment required/i.test(String(error?.message || ""))) {
        pushPausedUntil = Date.now() + 300000;
        return;
      }
      queuePush(payload);
    });
  } catch {
    queuePush(payload);
  }
}

// Server-side delivery; returns null when it could not run at all.
async function dispatch({ recipients, type, title, body, link, icon, eventKey, groupKey, force }) {
  try {
    const res = await base44.functions.invoke("notifyEvent", {
      recipients,
      type,
      title,
      body,
      link,
      icon,
      eventKey,
      groupKey,
      force,
    });
    if (res?.data?.ok) return res.data;
    return null;
  } catch {
    return null;
  }
}

// Offline/fallback path: write the record here and queue the device alert.
async function fallbackDeliver({ recipients, type, title, body, link }) {
  try {
    await base44.entities.Notification.bulkCreate(
      [...new Set(recipients)].map((id) => ({ user_id: id, type, title, body, link, read: false }))
    );
  } catch {}
  pushDeviceAlert({ userIds: recipients, title, body, link, type });
}

export async function notifyUser({
  userId,
  title,
  body,
  link,
  type = "info",
  tag,
  icon,
  force,
  eventKey,
  groupKey,
}) {
  if (!userId || !title) return;
  const result = await dispatch({
    recipients: [userId],
    type,
    title,
    body,
    link,
    icon,
    eventKey,
    groupKey: groupKey || tag,
    force,
  });
  if (!result) await fallbackDeliver({ recipients: [userId], type, title, body, link });
}

// Direct message alert. `eventKey` should be the PM record id so a retry can
// never produce a second notification for the same message.
export async function notifyPm({ userId, title, body, link, icon, eventKey, groupKey }) {
  if (!userId || !title) return;
  const result = await dispatch({
    recipients: [userId],
    type: "pm",
    title,
    body,
    link,
    icon,
    eventKey,
    groupKey: groupKey || `pm-thread:${userId}`,
    force: true,
  });
  if (!result) {
    await fallbackDeliver({ recipients: [userId], type: "pm", title, body, link });
    pushDeviceAlert({ userIds: [userId], title, body, link, type: "pm", icon, tag: groupKey, force: true });
  }
}

export async function notifyQuestUpdate({ userId, title, body, link, icon }) {
  if (!userId || !title) return;
  const result = await dispatch({ recipients: [userId], type: "quest", title, body, link, icon });
  if (!result) await fallbackDeliver({ recipients: [userId], type: "quest", title, body, link });
}

// Fan-out for events that notify many members (wall posts, announcements).
export async function notifyUsersBulk({
  userIds,
  title,
  body,
  link,
  type = "info",
  tag,
  icon,
  force,
  eventKey,
}) {
  if (!userIds || !userIds.length || !title) return [];
  const recipients = [...new Set(userIds)].filter(Boolean);
  const result = await dispatch({
    recipients,
    type,
    title,
    body,
    link,
    icon,
    eventKey,
    groupKey: tag,
    force,
  });
  if (!result) await fallbackDeliver({ recipients, type, title, body, link });
  return recipients;
}

// ── Catch-up ────────────────────────────────────────────────────────────────
// Realtime only covers the moment a device is connected. On return (and after a
// reconnect) we ask the server which incoming messages never produced an alert
// and save the missing ones, so the bell is always complete.
let lastSync = 0;
let syncInFlight = null;

export function syncMissedNotifications(force = false) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return Promise.resolve();
  if (syncInFlight) return syncInFlight;
  if (!force && Date.now() - lastSync < 90 * 1000) return Promise.resolve();
  syncInFlight = base44.functions
    .invoke("syncNotifications", {})
    .then((res) => {
      lastSync = Date.now();
      if ((res?.data?.created || 0) > 0) {
        window.dispatchEvent(new CustomEvent("tv-notif-read"));
      }
      return res?.data;
    })
    .catch(() => null)
    .finally(() => { syncInFlight = null; });
  return syncInFlight;
}
```
