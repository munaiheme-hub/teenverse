```jsx
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Send, MoreVertical, Ban, Trash2, Maximize2, Minimize2, Plus, Sparkles, MessageCircle, Flag } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { isPmBetween, loadPmConversation } from "@/lib/pmConversation";
import { sfx } from "@/lib/soundFX";
import { enforceSocialFilter } from "@/lib/socialFilter";
import { useTypingSender, useTypingList } from "@/lib/useTyping";
import TypingIndicator from "@/components/TypingIndicator";
import MessageMedia from "@/components/MessageMedia";
import VideoPlayer from "@/components/VideoPlayer";
import VoiceMessagePlayer from "@/components/VoiceMessagePlayer";
import { compressImageFile } from "@/lib/imageCompress";
import { versyRespondPM, VERSY_ID, VERSY_USERNAME } from "@/lib/bots";
// notifyPm removed — PMs no longer create bell-panel notifications. The
// unread badge on the Messages (mail) icon is driven by PrivateMessage.read
// state in PMTray, which is the original behavior the user wants.
import { autoReportLink, hasLink } from "@/lib/linkReport";
import { autoReportSafety } from "@/lib/safetyReport";
import useLatestChatScroll from '@/lib/useLatestChatScroll';
import mergeChatMessages from '@/lib/mergeChatMessages';
import { chatSendKey, trackChatSend } from '@/lib/chatSendQueue';
import { notifyPm, notifyUsersBulk } from '@/lib/notify';
import pmMentionRecipients from '@/lib/pmMentions';
import MentionText from '@/components/chat/MentionText';
import { useProfile } from '@/lib/ProfileContext';
import { useReconnectSync } from "@/lib/useReconnectSync";
import { isStaff } from "@/lib/ranks";
import GifPicker from "@/components/GifPicker";
import PlusPanel from "@/components/PlusPanel";
import PMGameCard from "@/components/pm/PMGameCard";
import PMGamePicker from "@/components/pm/PMGamePicker";
import CachedAvatar from "@/components/CachedAvatar";
import ReportModal from "@/components/ReportModal";
import ChatTextInput from "@/components/chat/ChatTextInput";
import optimisticChatSend from "@/lib/optimisticChatSend";

// PMChat owns the conversation view for a single recipient. Because PMTray
// renders this with key={target.pid}, switching recipients fully unmounts
// the old component and mounts a fresh one — messages state can never bleed
// between threads. No stale-load guards are needed because the component
// simply doesn't exist for the previous recipient anymore.
export default function PMChat({ target, user, profile, blocked, expanded, onToggleExpand, onBack, onBlock, onUnblock, onDeleteChat, onReportUser, onMarkRead, onSent }) {
  const [messages, setMessages] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const composerRef = useRef(null);
  const [sendError, setSendError] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const [quote, setQuote] = useState(null);
  const [pmAction, setPmAction] = useState(null);
  const [msgReport, setMsgReport] = useState(null);
  const [activeGames, setActiveGames] = useState([]);
  const [showGameShortcut, setShowGameShortcut] = useState(false);
  const [showNewestShortcut, setShowNewestShortcut] = useState(false);
  const [gifPicker, setGifPicker] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);

  const [gamePicker, setGamePicker] = useState(false);
  const [versyThinking, setVersyThinking] = useState(false);

  const msgScrollRef = useRef(null);
  const pmAtBottomRef = useRef(true);
  const { awardXp } = useProfile();
  const userScrollRef = useLatestChatScroll(msgScrollRef, pmAtBottomRef, target.pid, messages, !messagesLoading);
  const gameSendingRef = useRef(false);
  const deletingRef = useRef(false);

  const pmPairKey = "pm:" + [user?.id, target.pid].filter(Boolean).sort().join(":");
  const { onTyping: onPmTyping, stopTyping: stopPmTyping } = useTypingSender(pmPairKey, user, profile);
  const pmTypers = useTypingList(pmPairKey, user?.id);
  const isBlocked = blocked.includes(target.pid);

  function handlePmScroll() {
    const el = msgScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom || Date.now() < userScrollRef.current) {
      pmAtBottomRef.current = atBottom;
      setShowNewestShortcut(!atBottom && el.scrollHeight > el.clientHeight + 100);
    }
    setShowGameShortcut(activeGames.length > 0 && el.scrollTop > 200);
  }
  function scrollToGame() {
    pmAtBottomRef.current = false;
    const el = msgScrollRef.current;
    if (el) el.scrollTo({ top: 0, behavior: "smooth" });
  }
  function scrollToNewest() {
    const el = msgScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  // Load messages on mount. key={target.pid} guarantees this is always a
  // fresh mount for the correct recipient — no race, no stale data.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await loadPmConversation(user.id, target.pid);
        if (cancelled) return;
        pmAtBottomRef.current = true;
        setMessages(prev => mergeChatMessages(prev, all));
        setMessagesLoading(false);
        const unread = all.filter(m => m.receiver_id === user.id && !m.read);
        if (unread.length) {
          try { await base44.entities.PrivateMessage.bulkUpdate(unread.map(m => ({ id: m.id, read: true }))); } catch {}
          if (cancelled) return;
          onMarkRead?.(target.pid, unread.length);
        }
      } catch (e) {
        console.error("pm loadMsgs failed", e);
        if (!cancelled) { setLoadError(true); setMessagesLoading(false); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime subscription — only for this conversation's messages.
  useEffect(() => {
    const seenIds = new Set();
    const unsub = base44.entities.PrivateMessage.subscribe((ev) => {
      const d = ev.data;
      if (!d) return;
      if (ev.type === "create" && !isPmBetween(d, user.id, target.pid)) return;
      if (ev.type === "delete") { setMessages(prev => prev.filter(m => m.id !== d.id)); return; }
      if (ev.type === "update") { setMessages(prev => prev.some(m => m.id === d.id) ? prev.map(m => m.id === d.id ? { ...m, ...d } : m) : prev); return; }
      if (ev.type !== "create") return;
      if (d.sender_id === user.id && d.receiver_id === target.pid) { setMessages(prev => mergeChatMessages(prev, [d])); return; }
      if (d.sender_id === target.pid && d.receiver_id === user.id) {
        setMessages(prev => prev.some(m => m.id === d.id) ? prev : [...prev, d]);
        if (seenIds.has(d.id)) return;
        seenIds.add(d.id);
        base44.entities.PrivateMessage.update(d.id, { read: true }).catch(() => {});
        onMarkRead?.(target.pid, 1);
        sfx.message();
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Active PM games for this pair.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await base44.entities.GameLobby.filter({ status: "active" }, "-created_date", 50);
        if (cancelled) return;
        const mine = all.filter((g) => (g.player1_id === user.id && g.player2_id === target.pid) || (g.player1_id === target.pid && g.player2_id === user.id));
        setActiveGames(mine);
      } catch {}
    })();
    const unsub = base44.entities.GameLobby.subscribe((ev) => {
      const d = ev.data;
      if (!d) return;
      const involves = (d.player1_id === user.id && d.player2_id === target.pid) || (d.player1_id === target.pid && d.player2_id === user.id);
      if (!involves) return;
      setActiveGames((prev) => {
        if (ev.type === "delete") return prev.filter((g) => g.id !== d.id);
        if (ev.type === "create") return prev.some((g) => g.id === d.id) ? prev : [...prev, d];
        if (ev.type === "update") return prev.map((g) => (g.id === d.id ? { ...g, ...d } : g));
        return prev;
      });
    });
    return () => { cancelled = true; unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconnect catch-up: re-fetch this conversation on network restore / tab return.
  useReconnectSync(() => {
    pmAtBottomRef.current = true;
    (async () => {
      try {
        const all = await loadPmConversation(user.id, target.pid);
        pmAtBottomRef.current = true;
        setMessages(prev => mergeChatMessages(prev, all));
        setLoadError(false);
      } catch { setLoadError(true); }
    })();
  }, true);

  async function retryMessages() {
    setLoadError(false);
    try {
      const all = await loadPmConversation(user.id, target.pid);
      pmAtBottomRef.current = true;
      setMessages(prev => mergeChatMessages(prev, all));
    }
    catch { setLoadError(true); }
  }

  // Every PM goes through here: save it, then make it part of this conversation
  // AND the inbox list immediately (even if the chat was closed while saving).
  async function createPm(data) {
    pmAtBottomRef.current = true;
    const created = await optimisticChatSend(base44.entities.PrivateMessage, data, setMessages);
    if (created?.id) {
      onSent?.(created);
      // The recipient's alert is raised server-side: it is saved permanently
      // (so it survives the app being closed and is still in the bell on
      // return), de-duplicated by this message id, and pushed to their
      // devices. A tap opens straight into this conversation (?dm=<sender id>).
      if (data.receiver_id && data.sender_id !== VERSY_ID && data.media_type !== "cleared") {
        const preview = String(data.content || (data.media_type === "image" ? "📷 Photo" : "New message")).slice(0, 140);
        notifyPm({
          userId: data.receiver_id,
          title: `💬 ${profile?.username || "New message"}`,
          body: preview,
          link: `/room/main?dm=${data.sender_id}`,
          icon: profile?.avatar_url || undefined,
          eventKey: `pm:${created.id}`,
          groupKey: `pm:${data.sender_id}`,
        }).catch(() => {});
        // Tags inside a private message reach the tagged member (never the
        // person already alerted above, and only for genuine @username tags).
        pmMentionRecipients(String(data.content || ""), { senderId: data.sender_id, receiverId: data.receiver_id })
          .then((tagged) => {
            if (!tagged.length) return;
            return notifyUsersBulk({
              userIds: tagged.map((m) => m.user_id),
              type: "mention",
              title: `${profile?.username || "Someone"} tagged you`,
              body: preview,
              link: `/room/main?dm=${data.sender_id}`,
              icon: profile?.avatar_url || undefined,
              eventKey: `pm-mention:${created.id}`,
              tag: `pm-mention:${data.sender_id}`,
            });
          })
          .catch(() => {});
      }
    }
    return created;
  }

  function send() {
    const raw = composerRef.current?.read().trim();
    if (!raw) return;
    composerRef.current.clear();
    setSendError("");
    return trackChatSend(chatSendKey('pm', user.id, target.pid), () => sendMessage(raw));
  }
  async function sendMessage(raw) {
    if (!raw) return;
    if (isBlocked) { setSendError("You blocked this user."); composerRef.current?.restore(raw); return; }
    stopPmTyping();
    const qContent = quote?.content || "";
    const qAuthor = quote?.author || "";
    setQuote(null);
    const social = await enforceSocialFilter(profile, raw, { peerUserId: target.pid });
    if (social.blocked) { setSendError(social.notice); return; }
    let pm;
    try {
      pm = await createPm({ sender_id: user.id, receiver_id: target.pid, content: raw, media_type: "text", read: false, quote_content: qContent, quote_author: qAuthor, bubble_style: profile?.bubble_style || "gradient" });
      // Safety check runs after the message is saved and never blocks sending.
      autoReportSafety({ contentType: "pm", contentId: pm?.id, content: raw }).catch(() => {});

      awardXp(0, 'pm').catch(error => console.error('PM quest progress failed', error));
      sfx.click();
      if (hasLink(raw)) autoReportLink({ user, profile, content: raw, roomId: "Private Message", roomName: "Private Message", isPm: true }).catch(() => {});
      if (target.pid === VERSY_ID) {
        // Build conversation history from PREVIOUS messages only — the current
        // message is passed separately as `prompt` (raw). Pushing it into history
        // too would send the same question twice, making the AI echo/repeat it.
        // Strip the "🤖 " prefix from Versy's replies so the AI sees clean text.
        const history = messages
          .filter((m) => m.sender_id === VERSY_ID || m.sender_id === user.id)
          .slice(-6)
          .map((m) => ({
            role: m.sender_id === VERSY_ID ? "assistant" : "user",
            text: (m.content || "").replace(/^🤖\s*/, ""),
          }));
        // Versy answers one question at a time (versyRespondPM queues them), so
        // this question's answer always lands right after it — never after the
        // next question. The "typing" line shows a reply is on its way, and the
        // conversation is re-read once the answer is posted so it can never be
        // missing from the thread.
        setVersyThinking(true);
        versyRespondPM(raw, user.id, history)
          // The saved reply is inserted the moment it exists, so each answer
          // appears right after the message it belongs to — never bunched up
          // with other answers later on.
          .then((saved) => {
            if (!saved?.id) return;
            pmAtBottomRef.current = true;
            setMessages((prev) => mergeChatMessages(prev, [saved]));
            sfx.message();
          })
          .catch(() => {})
          .finally(async () => {
            try {
              const all = await loadPmConversation(user.id, target.pid);
              pmAtBottomRef.current = true;
              setMessages((prev) => mergeChatMessages(prev, all));
            } catch {}
            setVersyThinking(false);
          });
      }
    } catch (e) {
      console.error("pm send failed", e);
      if (pm?.id) return;
      composerRef.current?.restore(raw);
      if (quote) setQuote(previous => previous || quote);
      setSendError("Failed to send — your message is back in the typing box. Check your connection and try again.");
    }
  }

  async function uploadMedia(file) {
    try {
      const dataUrl = await compressImageFile(file, 900, 0.72);
      await createPm({ sender_id: user.id, receiver_id: target.pid, content: "📷 Photo", media_url: dataUrl, media_type: "image", read: false, bubble_style: profile?.bubble_style || "gradient" });
      sfx.success();
    } catch (e) { console.error("pm photo send failed", e); }
  }

  return (
    <>
      <div className="px-4 pb-2 flex items-center gap-2 shrink-0">
        <button onClick={onBack} className="text-xs text-pink-300">← Back</button>
        <div className="pfp-glow w-8 h-8">{target.pid === VERSY_ID ? <div className="w-full h-full bg-gradient-to-br from-pink-500 to-violet-600 flex items-center justify-center text-xs font-bold text-white">🤖</div> : <CachedAvatar src={target.profile?.avatar_url} username={target.profile?.username} alt={target.profile?.username || "Member"} className="w-full h-full object-cover" />}</div>
        <p className="text-sm font-semibold text-white flex-1 flex items-center gap-1.5">{target.pid === VERSY_ID ? VERSY_USERNAME : (target.profile?.username || "Member")} {target.pid === VERSY_ID && <span className="px-1.5 py-0.5 rounded-full bg-gradient-to-r from-pink-500 to-violet-600 text-white text-[8px] font-bold">✦ AI</span>}</p>
        <button onClick={onToggleExpand} className="p-1.5 rounded-full bg-white/10" title={expanded ? "Collapse" : "Expand"}>{expanded ? <Minimize2 className="w-4 h-4 text-white" /> : <Maximize2 className="w-4 h-4 text-white" />}</button>
        {target.pid !== VERSY_ID && <button onClick={() => setShowMenu(!showMenu)} className="p-1.5 rounded-full bg-white/10"><MoreVertical className="w-4 h-4 text-white" /></button>}
      </div>
      {showMenu && (
        <div className="absolute top-14 right-4 z-10 glass rounded-2xl p-2 space-y-1">
          <button onClick={onDeleteChat} className="w-full px-3 py-2 rounded-xl hover:bg-white/5 text-xs text-rose-300 font-semibold flex items-center gap-2"><Trash2 className="w-3.5 h-3.5" /> Delete Chat</button>
          {isBlocked ? (
            <button onClick={onUnblock} className="w-full px-3 py-2 rounded-xl hover:bg-white/5 text-xs text-emerald-300 font-semibold flex items-center gap-2"><Ban className="w-3.5 h-3.5" /> Unblock User</button>
          ) : (
            <button onClick={onBlock} className="w-full px-3 py-2 rounded-xl hover:bg-white/5 text-xs text-rose-300 font-semibold flex items-center gap-2"><Ban className="w-3.5 h-3.5" /> Block User</button>
          )}
          <button onClick={() => { onReportUser(); setShowMenu(false); }} className="w-full px-3 py-2 rounded-xl hover:bg-white/5 text-xs text-amber-300 font-semibold flex items-center gap-2"><Flag className="w-3.5 h-3.5" /> Report User</button>
        </div>
      )}
      <div ref={msgScrollRef} onScroll={handlePmScroll} className="flex-1 min-h-0 scroll-y px-4 space-y-2 overflow-x-hidden min-w-0 pm-msg-scroll">
        {messagesLoading && <p className="text-white/40 text-sm text-center py-4">Loading messages…</p>}
        {loadError && <button onClick={retryMessages} className="w-full text-rose-200 text-sm py-4">Could not load messages. Tap to retry.</button>}
        {activeGames.length > 0 && (
          <div className="space-y-2 pb-1">
            <p className="text-[10px] text-white/40 font-semibold tracking-wide px-1">🎮 ACTIVE GAME</p>
            {activeGames.map((g) => (
              <PMGameCard key={g.id} game={g} me={user} meUsername={profile?.username || "You"} opponentUsername={target.profile?.username || "Member"} onEnded={(id) => setActiveGames((prev) => prev.filter((x) => x.id !== id))} />
            ))}
          </div>
        )}
        {isBlocked && <p className="text-xs text-rose-300/70 text-center py-2">You blocked this user. Their messages are hidden.</p>}
        {target.pid === VERSY_ID && messages.filter((m) => m.media_type !== "cleared").length === 0 && (
          <div className="flex flex-col items-center text-center py-6 px-3">
            <div className="pfp-glow w-14 h-14 mb-2"><div className="w-full h-full bg-gradient-to-br from-pink-500 to-violet-600 flex items-center justify-center text-2xl">🤖</div></div>
            <p className="text-sm font-semibold text-white mb-1 flex items-center gap-1.5">Versy <span className="px-1.5 py-0.5 rounded-full bg-gradient-to-r from-pink-500 to-violet-600 text-white text-[8px] font-bold">✦ AI</span></p>
            <p className="text-xs text-white/50 max-w-[260px]">Hey! I'm Versy, your TeenVerse AI assistant. Ask me anything — school help, general knowledge, ideas, or TeenVerse questions. Your conversation here is private. ✨</p>
          </div>
        )}
        {messages.filter(m => m.media_type !== "cleared" && isPmBetween(m, user.id, target.pid) && (!isBlocked || m.sender_id === user.id)).map((m) => (
          <div key={m.id} className={`flex flex-col min-w-0 max-w-full ${m.sender_id === user.id ? "items-end" : "items-start"}`}>
            {m.media_type === "image" && m.media_url ? (
              <div className="max-w-[75%] min-w-0 mb-0.5"><MessageMedia mediaType="image" mediaUrl={m.media_url} content={m.content} /></div>
            ) : null}
            {m.media_type === "video" && m.m
