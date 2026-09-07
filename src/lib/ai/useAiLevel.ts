'use client';

// 🤖 Kaya AI Levels · client helpers.
//
//   useKidAiLevel(kidId)  → the resolved level for THAT kid (family default,
//                           age guard, per-child override) from the live
//                           FamilyContext. Always the kid's level — never
//                           the signed-in actor's.
//   aiRequestHeaders()    → JSON headers + the signed-in user's bearer token
//                           so the plain AI routes can resolve the level
//                           server-side (lib/ai/level.server.ts). Falls back
//                           to plain JSON headers when signed out (guest).

import { useMemo } from 'react';
import { useFamily } from '@/contexts/FamilyContext';
import { auth } from '@/lib/firebase';
import { resolveAiLevel, type AiLevelResolution } from './level.shared';

export function useKidAiLevel(kidId: string | null | undefined): AiLevelResolution {
  const { family, children } = useFamily();
  return useMemo(
    () => resolveAiLevel(family, children.find((c) => c.id === kidId) ?? null),
    [family, children, kidId],
  );
}

export async function aiRequestHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const u = auth.currentUser;
    if (u) headers.authorization = `Bearer ${await u.getIdToken()}`;
  } catch { /* signed out / token refresh hiccup — the route uses the hint */ }
  return headers;
}
