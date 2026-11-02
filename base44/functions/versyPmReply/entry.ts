```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';

// Creates a PrivateMessage FROM Versy (sender_id = "versy") TO the calling
// user. The client cannot create this PM directly because PrivateMessage RLS
// requires sender_id === {{user.id}}, so Versy's reply would be silently
// rejected. This function runs as the service role, which bypasses RLS, so
// the bot reply lands in the user's conversation.
//
// Input: { content: string }  — the reply text (already generated client-side
//   by askVersyAI, including the "🤖 " prefix, greeting bypass, and rate-limit
//   slowdown replies).
// Output: { ok: true } on success.
export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const content = String(body?.content || '').slice(0, 900);
    if (!content) return Response.json({ ok: false, error: 'empty_content' }, { status: 400 });

    // The reply always goes to the authenticated caller — a user can only
    // spawn a Versy reply in their own conversation.
    const saved = await base44.asServiceRole.entities.PrivateMessage.create({
      sender_id: 'versy',
      receiver_id: user.id,
      content,
      media_type: 'text',
      read: false,
    });

    // The saved record is returned so the conversation can show the reply the
    // instant it is ready — no waiting for a separate re-read.
    return Response.json({ ok: true, message: saved });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'versy_pm_failed' }, { status: 500 });
  }
}
```
