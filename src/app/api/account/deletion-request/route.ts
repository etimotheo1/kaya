// Account & data deletion requests — the endpoint behind /legal/delete-account.
//
// Google Play requires apps that let people create an account to expose a
// PUBLIC, no-login URL where account + data deletion can be requested. That
// makes this one of the very few unauthenticated POST routes in Kaya, so the
// abuse surface gets treated seriously:
//
//   • The notification email is sent ONLY to a fixed internal address. The
//     address the requester types is recorded as data and is never used as a
//     recipient — so this can't be turned into an open relay that mails a
//     victim on an attacker's behalf. For the same reason we deliberately do
//     NOT send the requester a confirmation email; the page tells them what
//     happens next instead.
//   • Requests are rate-limited per IP in Firestore (serverless means an
//     in-process counter would reset constantly and cap nothing).
//   • Nothing is deleted here. This records an intent and alerts a human.
//     Deleting a family's data touches Firestore, Storage, Auth and Stripe,
//     and is done deliberately by an operator — never by an unauthenticated
//     request.

import { NextRequest, NextResponse } from 'next/server';
import { getAdminFirestore } from '@/lib/firebaseAdmin';
import { Resend } from 'resend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const resendKey = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Kaya <noreply@ourkaya.com>';
const resend = resendKey ? new Resend(resendKey) : null;

// Where deletion requests land. Never taken from the request body.
const PRIVACY_INBOX = process.env.KAYA_PRIVACY_INBOX || 'hello@ourkaya.com';

const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_MAX = 5; // per IP per window

const SCOPES = ['everything', 'child', 'other'] as const;
type Scope = (typeof SCOPES)[number];

const SCOPE_LABEL: Record<Scope, string> = {
  everything: 'The whole account and every family member',
  child: "One child's data only",
  other: 'Something else (see notes)',
};

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Escape user-supplied text before it goes into the notification HTML. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

export async function POST(req: NextRequest) {
  // Validate BEFORE touching Firestore: junk gets rejected without doing any
  // work, and the input contract stays testable in environments that have no
  // service-account credentials (local dev and Vercel previews both lack them).
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad-request' }, { status: 400 });
  }

  const email = clean(body.email, 200);
  const name = clean(body.name, 120);
  const notes = clean(body.notes, 2000);
  const scopeRaw = clean(body.scope, 20);
  const scope: Scope = (SCOPES as readonly string[]).includes(scopeRaw)
    ? (scopeRaw as Scope)
    : 'everything';

  // Deliberately permissive — we only need it to be plausibly an address, and
  // an over-strict regex rejecting a real address is the worse failure here.
  if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'invalid-email' }, { status: 400 });
  }

  const db = getAdminFirestore();
  if (!db) return NextResponse.json({ error: 'admin-unavailable' }, { status: 503 });

  // ── Rate limit by IP ────────────────────────────────────────────────
  const ip =
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const now = Date.now();

  if (ip !== 'unknown') {
    // Doc id keyed by IP so this is a single point-read, never a query — no
    // composite index, no collection scan.
    const rlRef = db.collection('rateLimits').doc(`deletion_${ip.replace(/[^\w.:-]/g, '_')}`);
    try {
      const snap = await rlRef.get();
      const prev = snap.data() as { windowStart?: number; count?: number } | undefined;
      const windowStart = Number(prev?.windowStart ?? 0);
      const fresh = now - windowStart > RATE_WINDOW_MS;
      const count = fresh ? 0 : Number(prev?.count ?? 0);

      if (count >= RATE_MAX) {
        return NextResponse.json({ error: 'rate-limited' }, { status: 429 });
      }
      await rlRef.set(
        { windowStart: fresh ? now : windowStart, count: count + 1 },
        { merge: true },
      );
    } catch {
      /* rate limiting is best-effort — never block a genuine request on it */
    }
  }

  // ── Record the request ──────────────────────────────────────────────
  // Top-level collection written by the Admin SDK, which bypasses security
  // rules — so this ships with ZERO firestore.rules changes.
  let refId = '';
  try {
    const ref = await db.collection('accountDeletionRequests').add({
      email,
      name: name || null,
      scope,
      notes: notes || null,
      status: 'received',
      requestedAt: now,
      sourceIp: ip,
      userAgent: (req.headers.get('user-agent') || '').slice(0, 300),
    });
    refId = ref.id;
  } catch {
    return NextResponse.json({ error: 'write-failed' }, { status: 500 });
  }

  // ── Alert a human ───────────────────────────────────────────────────
  if (resend) {
    try {
      await resend.emails.send({
        from: RESEND_FROM,
        to: PRIVACY_INBOX, // fixed — never the requester's address
        replyTo: email,
        subject: `🗑️ Account deletion request — ${email}`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:560px">
            <h2 style="margin:0 0 4px">Account deletion request</h2>
            <p style="color:#6b6b6b;margin:0 0 16px">Reference <code>${esc(refId)}</code></p>
            <table cellpadding="6" style="border-collapse:collapse;font-size:14px">
              <tr><td><b>Email</b></td><td>${esc(email)}</td></tr>
              <tr><td><b>Name</b></td><td>${esc(name || '—')}</td></tr>
              <tr><td><b>Scope</b></td><td>${esc(SCOPE_LABEL[scope])}</td></tr>
              <tr><td valign="top"><b>Notes</b></td><td>${esc(notes || '—').replace(/\n/g, '<br>')}</td></tr>
            </table>
            <p style="font-size:13px;color:#6b6b6b;margin-top:18px">
              Verify the requester controls this address before deleting anything.
              Kaya commits to completing verified requests within 30 days.
            </p>
          </div>`,
      });
    } catch {
      /* The request is already recorded — a mail failure must not lose it. */
    }
  }

  return NextResponse.json({ ok: true, reference: refId });
}
