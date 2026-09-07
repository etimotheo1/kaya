// 🤖 Kaya AI Levels · server-side resolution.
//
// Two entry points:
//
//   resolveAiLevelAdmin(db, familyId, kidId)
//     For Admin-gateway routes and crons that already hold a familyId
//     (Quests Coach Ear, Treasures quiz, the weekly reflection cron).
//     Reads the family doc + the child doc and applies resolveAiLevel.
//
//   resolveAiLevelFromRequest(req, body)
//     For the plain /api/sparks/ai/* + /api/business-coach routes. When the
//     client sends its bearer token (lib/ai/useAiLevel.aiRequestHeaders) and
//     the Admin SDK is configured (production), the level is resolved
//     SERVER-side from the caller's family + the kid named in the body —
//     the child doc is read under the caller's familyId, so a kid can only
//     ever name a sibling, never another family. Without a token or Admin
//     (Vercel previews), the client's hint is used, else Balanced.
//
// The resolved level is ALWAYS the kid's (body.kidId), never the actor's.

import type { NextRequest } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminFirestore } from '@/lib/firebaseAdmin';
import { AI_LEVEL_DEFAULT, parseAiLevel, resolveAiLevel, type AiLevel } from './level.shared';

export interface ServerAiLevel {
  level: AiLevel;
  /** 'server' = resolved from Firestore · 'client' = the body hint · 'default' = Balanced. */
  source: 'server' | 'client' | 'default';
}

type FamilyData = { aiConfig?: { defaultLevel?: unknown } } | undefined;
type ChildData = { aiLevel?: unknown; birthday?: string } | undefined;

/** Admin-SDK resolution for a kid in a known family. Pass already-loaded
 *  docs via `opts` to save reads. Never throws — falls back to Balanced. */
export async function resolveAiLevelAdmin(
  db: Firestore,
  familyId: string,
  kidId: string,
  opts: { family?: FamilyData; child?: ChildData } = {},
): Promise<AiLevel> {
  try {
    const famRef = db.collection('families').doc(familyId);
    const family = opts.family ?? ((await famRef.get()).data() as FamilyData);
    let child = opts.child;
    if (!child && kidId) {
      child = (await famRef.collection('children').doc(kidId).get()).data() as ChildData;
    }
    return resolveAiLevel(family ?? null, child ?? null).level;
  } catch {
    return AI_LEVEL_DEFAULT;
  }
}

/** Plain-route resolution (see header). */
export async function resolveAiLevelFromRequest(
  req: NextRequest,
  body: { kidId?: unknown; aiLevel?: unknown } | null | undefined,
): Promise<ServerAiLevel> {
  const hint = parseAiLevel(body?.aiLevel);
  const kidId = typeof body?.kidId === 'string' ? body.kidId.trim().slice(0, 80) : '';
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

  const db = getAdminFirestore();
  const adminAuth = getAdminAuth();
  if (token && db && adminAuth && kidId) {
    try {
      const { uid } = await adminAuth.verifyIdToken(token);
      const user = (await db.collection('users').doc(uid).get()).data() as { familyId?: string } | undefined;
      if (user?.familyId) {
        const level = await resolveAiLevelAdmin(db, user.familyId, kidId);
        return { level, source: 'server' };
      }
    } catch {
      /* fall through to the client hint */
    }
  }
  if (hint) return { level: hint, source: 'client' };
  return { level: AI_LEVEL_DEFAULT, source: 'default' };
}
