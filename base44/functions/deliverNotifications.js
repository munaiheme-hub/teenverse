```ts
// Shared notification engine for TeenVerse.
//
// Every notification-worthy event goes through `deliverNotifications`: it
// validates the recipients, honours notification preferences and blocks,
// de-duplicates by a stable event key, groups bursts from the same
// conversation, writes the permanent in-app record(s) and pushes to the
// recipient's devices. Both the client-callable `notifyEvent` endpoint and the
// server-side `syncNotifications` recovery job use it, so there is exactly one
// notification pipeline in the app.

import { sendPushToUsers } from './push.ts';

export const ALLOWED_TYPES = new Set([
  'pm', 'mention', 'quote', 'reply',
  'friend_request', 'friend_accept', 'social',
  'game', 'room', 'room_invite',
  'club', 'story', 'profile', 'like', 'comment', 'gift', 'sticker',
  'moderation', 'announcement', 'referral', 'achievement', 'level_up',
  'quest', 'birthday', 'transfer', 'age_review', 'info',
]);

// Notification type → the member's preference switch that governs it.
export function categoryForType(type: string): string | null {
  const t = String(type || '').toLowerCase();
  if (['pm', 'message', 'messages'].includes(t)) return 'messages';
  if (['mention', 'quote', 'reply'].includes(t)) return 'mentions';
  if (['friend_request', 'friend_accept', 'like', 'comment', 'gift', 'sticker', 'social', 'profile', 'achievement', 'level_up', 'quest', 'transfer', 'birthday'].includes(t)) return 'social';
  if (['game', 'room', 'room_invite', 'club', 'story'].includes(t)) return 'clubs';
  if (['announcement', 'topic'].includes(t)) return 'announcements';
  if (t === 'referral') return 'referral';
  return null;
}

const MAX_RECIPIENTS = 200;
const GROUP_WINDOW_MS = 2 * 60 * 1000;
const DEDUPE_LOOKBACK_DAYS = 14;

function clean(text: any, max: number): string {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

// A link is either an in-app path ("/room/main?dm=…") or, for friend requests,
// the sender's opaque user id. Anything carrying a scheme or protocol-relative
// prefix is dropped so a notification can never navigate somewhere unsafe.
function safeLink(link: any, fallback: string): string {
  const value = typeof link === 'string' ? link.trim() : '';
  if (!value) return fallback;
  if (value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return fallback;
  if (value.startsWith('/')) return value.slice(0, 300);
  if (/^[\w-]{1,64}$/.test(value)) return value;
  return fallback;
}

export type NotifyPayload = {
  recipients: string[];
  type: string;
  title: string;
  body?: string;
  link?: string;
  icon?: string;
  /** Stable id of the event (message id, request id…). Guarantees one alert per event. */
  eventKey?: string;
  /** Optional burst grouping, e.g. `pm:<senderId>` — repeated alerts fold into one. */
  groupKey?: string;
  actorId?: string;
  actorUsername?: string;
  actorAvatar?: string;
  /** Deliver a device alert even when the recipient looks online. */
  force?: boolean;
  /** Save the in-app record only — used by the catch-up job (no buzz on return). */
  silent?: boolean;
};

export type NotifyOutcome = {
  created: number;
  grouped: number;
  deduped: number;
  skipped: number;
  pushed: number;
};

export async function deliverNotifications(base44: any, payload: NotifyPayload): Promise<NotifyOutcome> {
  const outcome: NotifyOutcome = { created: 0, grouped: 0, deduped: 0, skipped: 0, pushed: 0 };
  const type = String(payload?.type || 'info').toLowerCase();
  const title = clean(payload?.title, 120);
  if (!title) return outcome;

  const actorId = payload?.actorId || '';
  const recipients = [...new Set((payload?.recipients || []).filter((id) => typeof id === 'string' && id && id !== actorId))].slice(0, MAX_RECIPIENTS);
  if (!recipients.length) return outcome;

  const body = clean(payload?.body, 300);
  const link = safeLink(payload?.link, '/room/main');
  const icon = typeof payload?.icon === 'string' && payload.icon.startsWith('http') ? payload.icon : undefined;
  const category = categoryForType(type);

  const profiles = await base44.asServiceRole.entities.MemberProfile.filter({ user_id: { $in: recipients } });
  const byUser = new Map<string, any>();
  (profiles || []).forEach((p: any) => byUser.set(p.user_id, p));

  // Blocks in either direction silence the alert.
  let blocked = new Set<string>();
  if (actorId) {
    try {
      const [out, inc] = await Promise.all([
        base44.asServiceRole.entities.Block.filter({ blocker_id: actorId, blocked_id: { $in: recipients } }),
        base44.asServiceRole.entities.Block.filter({ blocked_id: actorId, blocker_id: { $in: recipients } }),
      ]);
      blocked = new Set([...(out || []).map((b: any) => b.blocked_id), ...(inc || []).map((b: any) => b.blocker_id)]);
    } catch {
      blocked = new Set();
    }
  }

  const allowed: string[] = [];
  for (const id of recipients) {
    const profile = byUser.get(id);
    if (!profile || profile.banned) { outcome.skipped += 1; continue; }
    if (category && profile.notif_prefs?.[category] === false) { outcome.skipped += 1; continue; }
    if (blocked.has(id)) { outcome.skipped += 1; continue; }
    if ((profile.blocked_users || []).includes(actorId)) { outcome.skipped += 1; continue; }
    allowed.push(id);
  }
  if (!allowed.length) return outcome;

  // De-duplicate: the same event never notifies the same member twice.
  let pendingIds = allowed;
  if (payload.eventKey) {
    const since = new Date(Date.now() - DEDUPE_LOOKBACK_DAYS * 86400000).toISOString();
    const keys = allowed.map((id) => `${payload.eventKey}:${id}`);
    try {
      // Grouped alerts keep every folded key, so both places are checked.
      const [single, folded] = await Promise.all([
        base44.asServiceRole.entities.Notification.filter({
          event_key: { $in: keys },
          created_date: { $gt: since },
        }),
        base44.asServiceRole.entities.Notification.filter({
          event_keys: { $in: keys },
          created_date: { $gt: since },
        }),
      ]);
      const already = new Set([...(single || []), ...(folded || [])].map((n: any) => n.user_id));
      if (already.size) {
        outcome.deduped += already.size;
        pendingIds = allowed.filter((id) => !already.has(id));
      }
    } catch {
      /* dedupe is best-effort — delivery must still happen */
    }
  }
  if (!pendingIds.length) return outcome;

  const base = {
    type,
    category: category || '',
    title,
    body,
    link,
    actor_id: actorId,
    actor_username: clean(payload.actorUsername, 60),
    actor_avatar: typeof payload.actorAvatar === 'string' ? payload.actorAvatar.slice(0, 500) : '',
    read: false,
  };

  // Grouping: a burst from the same source folds into the member's existing
  // unread alert instead of filling the bell with near-identical rows.
  const toCreate: any[] = [];
  const groupKey = clean(payload.groupKey, 120);
  if (groupKey) {
    try {
      const recent = await base44.asServiceRole.entities.Notification.filter({
        user_id: { $in: pendingIds },
        group_key: groupKey,
        read: false,
        created_date: { $gt: new Date(Date.now() - GROUP_WINDOW_MS).toISOString() },
      });
      const groupedUsers = new Set<string>();
      for (const row of recent || []) {
        if (groupedUsers.has(row.user_id)) continue;
        groupedUsers.add(row.user_id);
        const newKey = payload.eventKey ? `${payload.eventKey}:${row.user_id}` : '';
        await base44.asServiceRole.entities.Notification.update(row.id, {
          title,
          body,
          link,
          count: (row.count || 1) + 1,
          event_key: newKey || row.event_key,
          // Keep every folded key so no repeat of an earlier event is ever
          // treated as new (which would duplicate the alert later).
          event_keys: [...new Set([...(row.event_keys || []), row.event_key, newKey].filter(Boolean))],
        });
        outcome.grouped += 1;
      }
      pendingIds = pendingIds.filter((id) => !groupedUsers.has(id));
    } catch {
      /* fall through to a fresh record */
    }
  }

  for (const userId of pendingIds) {
    toCreate.push({
      ...base,
      user_id: userId,
      group_key: groupKey,
      event_key: payload.eventKey ? `${payload.eventKey}:${userId}` : '',
      event_keys: payload.eventKey ? [`${payload.eventKey}:${userId}`] : [],
      count: 1,
    });
  }

  if (toCreate.length) {
    try {
      await base44.asServiceRole.entities.Notification.bulkCreate(toCreate);
      outcome.created = toCreate.length;
    } catch {
      for (const row of toCreate) {
        try {
          await base44.asServiceRole.entities.Notification.create(row);
          outcome.created += 1;
        } catch {
          outcome.skipped += 1;
        }
      }
    }
  }

  const pushTargets = payload.silent ? [] : allowed;
  if (pushTargets.length) {
    try {
      const res = await sendPushToUsers(base44, pushTargets, {
        title,
        body,
        link,
        icon,
        tag: groupKey || payload.eventKey || `tv-${type}`,
        type,
      });
      outcome.pushed = res.sent;
    } catch {
      /* the in-app record is saved; push is retried by the client queue */
    }
  }

  return outcome;
}
```
