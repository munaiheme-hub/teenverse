```js
import { base44 } from "@/api/base44Client";
import { loadVersyBrowserConfig, versyBrowserReady, generateVersyReplyDirect } from "@/lib/versyDirect";

// The fixed identity Versy uses across TeenVerse — rooms and PMs.
export const VERSY_ID = "versy";
export const VERSY_USERNAME = "VersyAI";
export const TIMEBOT_ID = "timebot";
export const TIMEBOT_USERNAME = "TimeBot";

// Shown when Versy's backend can't answer (network drop, provider outage or
// timeout). The backend sends the same friendly line, so the UI never shows a
// raw error or an empty bubble. Versy is powered by the versyChat backend
// function, which calls Gemini directly — there is no "limited mode" or
// "AI brain offline" state anymore.
const VERSY_RETRY = "🤖 Versy is taking a quick breather — try again in a moment! ✨";

// In-memory cache of bot profiles (avatar_url, banner_url, display_name).
// Loaded once from BotProfile and refreshed via realtime. Scoped per bot_id
// so Versy's PFP can never appear on TimeBot and vice versa.
const _botProfileCache = {};
let _botProfilesLoaded = false;
let _botProfileLoadPromise = null;

export async function loadBotProfiles(force = false) {
  if (!force && _botProfilesLoaded) return _botProfileCache;
  if (_botProfileLoadPromise) return _botProfileLoadPromise;
  _botProfileLoadPromise = (async () => {
    try {
      const list = await base44.entities.BotProfile.list("-created_date", 50);
      const items = list.items || list || [];
      items.forEach((r) => { if (r.bot_id) _botProfileCache[r.bot_id] = r; });
      _botProfilesLoaded = true;
    } catch {}
    _botProfileLoadPromise = null;
    return _botProfileCache;
  })();
  return _botProfileLoadPromise;
}

// Subscribe once to BotProfile updates so a staff PFP/banner change appears
// everywhere immediately without a reload.
if (typeof window !== "undefined") {
  try {
    base44.entities.BotProfile.subscribe((ev) => {
      if ((ev.type === "create" || ev.type === "update") && ev.data?.bot_id) {
        _botProfileCache[ev.data.bot_id] = { ..._botProfileCache[ev.data.bot_id], ...ev.data };
      }
    });
  } catch {}
}

export function getBotProfile(botId) {
  return _botProfileCache[botId] || null;
}

// Returns the persisted avatar URL for a bot, or "" if not set yet.
function botAvatar(botId) {
  return _botProfileCache[botId]?.avatar_url || "";
}

// Detect when a plain message is clearly addressed to Versy (no command prefix needed).
// Recognizes "versy", "versyai", "versy ai", "@versy", "@versyai" and common
// greeting prefixes — matching the actual @VersyAI username used by the tag system.
export function isAddressingVersy(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  if (/^(hey|hi|hello|yo|ok|okay|hey there|hi there|sup)\s*,?\s*@?(versy|versyai|versy ai)\b/.test(t)) return true;
  if (/^@?(versy|versyai|versy ai)\b/.test(t)) return true;
  return false;
}

export function extractVersyPrompt(text) {
  return (text || "")
    .replace(/^(hey|hi|hello|yo|ok|okay|hey there|hi there|sup)\s*,?\s*@?(versyai|versy ai|versy)\s*[,,:]?\s*/i, "")
    .replace(/^@?(versyai|versy ai|versy)\s*[,,:]?\s*/i, "")
    .trim();
}

// Returns true when the given id is one of TeenVerse's bot accounts
// (Versy or TimeBot). Used by the profile-view flow to open a BotProfile
// view instead of a (non-existent) MemberProfile.
export function isBotId(id) {
  const t = String(id || "").toLowerCase();
  return t === VERSY_ID || t === TIMEBOT_ID;
}

// Returns true if a username would impersonate Versy — used to block
// users from registering/sending as Versy in the Versy Room.
export function isVersyUsername(name) {
  const n = (name || "").trim().toLowerCase();
  return n === "versy" || n === "versyai" || n === "versy ai" || n === "@versy" || n === "@versyai";
}

// Credit-preservation guardrails for Versy AI:
// 1. Canned greeting guardrail — a 1-word greeting (hi/hey/hello/yo/sup/ok)
//    returns a fast local reply WITHOUT invoking the serverless function, so
//    casual pings don't spend any AI credits.
// 2. 3-second client-side rate limit — rapid back-to-back triggers are bounced
//    locally so users can't spam @versy or the Versy Room.
const VERSY_GREETINGS = new Set(["hi", "hey", "hello", "yo", "sup", "ok", "okay", "hiya", "heyy", "hii", "helloo"]);
const VERSY_GREETING_REPLY = "Hey! I'm Versy, your TeenVerse AI buddy 💫 Ask me anything — school help, ideas, facts, or just chat!";
const VERSY_SLOWDOWN_REPLY = "Whoa, slow down a sec — I'm still thinking! Try again in a moment. ✨";
const VERSY_RATE_LIMIT_MS = 3000;
let _lastVersyCallAt = 0;
let _lastVersyPrompt = "";

// Returns true for a bare 1-word greeting (no real question attached).
export function isShortGreeting(text) {
  const t = (text || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return t.length > 0 && t.length <= 8 && VERSY_GREETINGS.has(t);
}

// Ask Versy. One central routine for every entry point — rooms, the Versy room,
// direct messages, @Versy and /versy — with optional conversation history for
// follow-up context. Returns the answer string, or null on failure. Greetings
// and rate-limited bursts return a canned reply without any AI call.
//
// Two interchangeable back ends, both calling Gemini directly with the app's own
// key so no built-in AI credits are used:
//   1. the browser path (versyDirect) — used while the Owner has switched
//      "Versy without credits" on in the Owner's Office. It never touches a
//      backend function, so it keeps working while the workspace's integration
//      allowance is used up.
//   2. the versyChat backend function — the standard path, used whenever the
//      switch is off.
const VERSY_CLIENT_TIMEOUT_MS = 40000;

export async function askVersyAI(prompt, history = [], roomId = "") {
  const clean = (prompt || "").trim();
  // 1. Canned greeting — no backend call, no credit spend. A bare tag with no
  //    question ("Versy", "@VersyAI", "!versy") also gets the friendly intro
  //    instead of failing on an empty prompt.
  if (!clean || isShortGreeting(clean)) return VERSY_GREETING_REPLY;
  // 2. Double-send guard — a rapid repeat of the SAME text (fast double tap or
  //    pressing Enter twice) is bounced locally. A genuinely different
  //    follow-up question always goes through: blocking it made Versy answer
  //    the previous question and look like it ignored the new one.
  const fingerprint = clean.toLowerCase();
  if (Date.now() - _lastVersyCallAt < VERSY_RATE_LIMIT_MS && _lastVersyPrompt === fingerprint) {
    return VERSY_SLOWDOWN_REPLY;
  }
  _lastVersyCallAt = Date.now();
  _lastVersyPrompt = fingerprint;
  // Browser path — see the note above. When it is switched on it is the only
  // path used, so a member's question never spends integration credits.
  try {
    // A failed reading of the optional browser switch must never block the
    // server path — it is treated as "off".
    const browserConfig = await loadVersyBrowserConfig().catch((err) => {
      console.error("[Versy] could not read the browser switch — using the server path:", err?.message || err);
      return null;
    });
    if (versyBrowserReady(browserConfig)) {
      const direct = await generateVersyReplyDirect({ prompt: clean, history, roomLabel: roomId, apiKey: browserConfig.key, preferredModel: browserConfig.preferredModel });
      if (direct.ok) return direct.answer;
      // Never leave the member without a reply: fall through to the server path.
      console.error(`[Versy] direct Gemini failed code=${direct.code} status=${direct.status ?? "-"} detail=${direct.detail} — using the server path`);
    }
    // Client-side timeout so a hung request can never leave Versy silent forever.
    const resp = await Promise.race([
      base44.functions.invoke("versyChat", { prompt: clean, history, room_id: roomId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`versyChat timed out after ${VERSY_CLIENT_TIMEOUT_MS / 1000}s`)), VERSY_CLIENT_TIMEOUT_MS)),
    ]);
    if (resp?.data?.ok && resp.data.answer) {
      return String(resp.data.answer).slice(0, 800);
    }
    // Backend answered but had no reply — log the exact reason (code/status/detail)
    // and surface the friendly line it sent, so the UI shows a clean message.
    console.error("[Versy] backend returned no answer:", resp?.data);
    return resp?.data?.friendly || null;
  } catch (err) {
    // Request itself failed (network, platform rate limit 429, 5xx, timeout).
    console.error("[Versy] versyChat request failed:", err?.response?.status || "", err?.response?.data || err?.message || err);
    return null;
  }
}

// In-flight guard: prevents the same room from producing two Versy replies
// for a single tag (e.g. a double-tap send or a duplicate listener firing).
const _versyInFlight = new Set();
function versyKey(roomId, prompt) {
  return `${roomId}:${(prompt || "").slice(0, 60)}`;
}

// Versy responds in a chat room. Every interaction routes through the
// versyChat backend function — the one AI path shared by public rooms, custom
// rooms, the Versy room, private messages and the @Versy / /versy commands.
export async function versyRespond(prompt, roomId, history = []) {
  const key = versyKey(roomId, prompt);
  if (_versyInFlight.has(key)) return null;
  _versyInFlight.add(key);
  try {
    await loadBotProfiles();
    const ai = await askVersyAI(prompt, history, roomId);
    const reply = ai ? "🤖 " + ai : VERSY_RETRY;
    try {
      const bp = getBotProfile(VERSY_ID);
      await base44.entities.Message.create({
        room_id: roomId, user_id: VERSY_ID, username: bp?.username || VERSY_USERNAME, avatar_url: botAvatar(VERSY_ID),
        rank: "premium", level: 2, content: reply, media_type: "none"
      });
    } catch (err) {
      console.error("[Versy] could not post Versy's reply to the room:", err?.response?.status || "", err?.message || err);
    }
    return reply;
  } finally {
    // Release after a short window so a later, genuinely new tag still works.
    setTimeout(() => _versyInFlight.delete(key), 1200);
  }
}

// Versy responds in a private message conversation. The reply is posted from
// Versy via the versyPmReply backend function (service role); if that call is
// refused — which is what happens while the workspace's integration allowance
// is used up — it is written straight into the member's own conversation
// instead. The message rules permit a Versy message only in the signed-in
// member's OWN inbox, so nobody can have Versy answer another member. Each
// conversation is naturally separate because messages are filtered by user id.
//
// PM answers are processed ONE AT A TIME per user. Versy takes a few seconds to
// answer, so without a queue a quickly typed follow-up could overtake the
// answer to the previous message — the reply for question 2 would appear before
// the reply for question 1, making it look like the earlier answer was lost.
// The queue guarantees one answer per question, in the order they were asked.
// A failed request is retried once before falling back to the friendly line, so
// a question is never left unanswered.
const _pmQueues = new Map();

function enqueuePmReply(userId, task) {
  const key = String(userId || "anon");
  const previous = _pmQueues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  // Keep the chain alive for later questions without letting a rejection leak.
  _pmQueues.set(key, next.catch(() => {}));
  return next;
}

export function versyRespondPM(prompt, userId, history = []) {
  return enqueuePmReply(userId, async () => {
    let ai = await askVersyAI(prompt, history);
    if (!ai) ai = await askVersyAI(prompt, history);
    const reply = ai ? "🤖 " + ai : VERSY_RETRY;
    let saved = null;
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      try {
        const res = await base44.functions.invoke("versyPmReply", { content: reply });
        saved = res?.data?.message || null;
        if (!saved && res?.data?.ok === false) continue;
        // ok with no record: the reply was saved, it just isn't echoed back.
        if (res?.data?.ok !== false) break;
      } catch (err) {
        console.error("[Versy] PM reply failed", attempt + 1, err?.message || err);
        // Only a rejected request is retried. A dropped connection may still
        // have saved the reply, and retrying would post it twice.
        if (!err?.response) break;
      }
    }
    if (!saved) {
      try {
        saved = await base44.entities.PrivateMessage.create({
          sender_id: VERSY_ID, receiver_id: userId, content: reply, media_type: "text", read: false,
        });
      } catch (err) {
        console.error("[Versy] could not post Versy's PM reply:", err?.response?.status || "", err?.message || err);
      }
    }
    // The saved reply is handed back so the conversation can show it at once.
    return saved || null;
  });
}

// TimeBot responds with the current time and date. NEVER reveals the user's
// location, timezone name, city, country, or any geographic information —
// only the time and date needed for the time function itself.
export async function timeBotRespond(roomId) {
  const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const d = new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  try {
    await loadBotProfiles();
    const bp = getBotProfile(TIMEBOT_ID);
    await base44.entities.Message.create({
      room_id: roomId, user_id: TIMEBOT_ID, username: bp?.username || TIMEBOT_USERNAME, avatar_url: botAvatar(TIMEBOT_ID),
      rank: "premium", level: 2, content: `⏰ It's ${t} on ${d}`, media_type: "none"
    });
  } catch {}
}
```
