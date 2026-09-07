// 🤖 Kaya AI Levels (approved 2026-09-07, Logic Test v1).
//
// ONE dial that tells Kaya how firmly to mark, how deeply to explain and
// how hard to push a child — set once for the family, tuned per child.
//
//   1 🌱 Gentle      "Encourage first."
//   2 🌤 Balanced    "Honest and kind."  ← DEFAULT = exactly what Kaya does today
//   3 💪 Stretch     "Push me."
//   4 🎓 Exam-Ready  "Mark me like school will."  (offered from age 10)
//
// Resolution order (resolveAiLevel):
//   1. a parent's per-child override (child.aiLevel) wins, uncapped;
//   2. otherwise the family default (family.aiConfig.defaultLevel), AGE-
//      GUARDED: under 8 never inherits above Balanced, under 10 never
//      inherits Exam-Ready (no birthday = no guard, like participation);
//   3. nothing set → Balanced.
//
// The level ALWAYS belongs to the child whose work it is — never to the
// parent / helper who pressed the button. Every evaluation stamps the
// level it was marked at; changing the level never re-marks past work.
// The kindness floor is identical on every level (see level.prompts.ts)
// and the AI score never moves points on its own.
//
// This file is isomorphic (client + server). Prompt briefs live in
// level.prompts.ts (server) and request resolution in level.server.ts.

import { ageOf } from '@/lib/participation';

export type AiLevel = 1 | 2 | 3 | 4;

export const AI_LEVEL_DEFAULT: AiLevel = 2;

export interface AiLevelMeta {
  level: AiLevel;
  key: 'gentle' | 'balanced' | 'stretch' | 'exam';
  emoji: string;
  name: string;
  tagline: string;
  /** The four dials a parent reads in Settings. */
  marking: string;
  feedback: string;
  challenge: string;
  voice: string;
}

export const AI_LEVELS: readonly AiLevelMeta[] = [
  {
    level: 1, key: 'gentle', emoji: '🌱', name: 'Gentle', tagline: 'Encourage first.',
    marking: 'Generous — effort counts, wide partial credit, spelling and presentation never cost marks.',
    feedback: 'One thing to try + one cheer. About two sentences.',
    challenge: 'Same level, or one step easier.',
    voice: 'Cheerleader — warm, playful, emoji welcome.',
  },
  {
    level: 2, key: 'balanced', emoji: '🌤', name: 'Balanced', tagline: 'Honest and kind.',
    marking: 'Honest — partial credit when the method is right.',
    feedback: 'Up to three points, short breakdown.',
    challenge: 'Matched to the score.',
    voice: 'Coach — warm and honest.',
  },
  {
    level: 3, key: 'stretch', emoji: '💪', name: 'Stretch', tagline: 'Push me.',
    marking: 'Firm — partial credit only when the working is shown; presentation gets a note.',
    feedback: 'Full per-question breakdown, three to five points.',
    challenge: 'One step harder than the score suggests.',
    voice: 'Direct coach — fewer cheers, clear asks.',
  },
  {
    level: 4, key: 'exam', emoji: '🎓', name: 'Exam-Ready', tagline: 'Mark me like school will.',
    marking: 'School standard — method, units, working shown; spelling counts in language subjects.',
    feedback: 'Marking-scheme style breakdown with model-answer hints.',
    challenge: 'Exam-style questions, mixed difficulty, with a time hint.',
    voice: 'Teacher — plain and precise, still respectful; no emoji in the marking.',
  },
];

/** Age from which 🎓 Exam-Ready is offered in the per-child picker. */
export const AI_LEVEL_EXAM_FROM_AGE = 10;
/** Under this age a child never INHERITS above Balanced from the family default. */
export const AI_LEVEL_GUARD_UNDER_AGE = 8;

export function aiLevelMeta(level: AiLevel): AiLevelMeta {
  return AI_LEVELS[level - 1] ?? AI_LEVELS[AI_LEVEL_DEFAULT - 1];
}

/** "🌤 Balanced" — the label used on chips, summaries and prompts. */
export function aiLevelLabel(level: AiLevel): string {
  const m = aiLevelMeta(level);
  return `${m.emoji} ${m.name}`;
}

/** Accepts 1-4 (number or numeric string); anything else → null. */
export function parseAiLevel(v: unknown): AiLevel | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return n === 1 || n === 2 || n === 3 || n === 4 ? (n as AiLevel) : null;
}

// ── Family config ─────────────────────────────────────────────────────

export interface AiConfig {
  /** The family default (rule 2). Absent → Balanced. */
  defaultLevel: AiLevel;
}

export function readAiConfig(
  family: { aiConfig?: { defaultLevel?: unknown } | null } | null | undefined,
): AiConfig {
  return { defaultLevel: parseAiLevel(family?.aiConfig?.defaultLevel) ?? AI_LEVEL_DEFAULT };
}

// ── Age guard ─────────────────────────────────────────────────────────

/** Highest level a child may INHERIT from the family default at this age.
 *  Null age (no birthday on file) = no guard. */
export function maxInheritedLevel(age: number | null): AiLevel {
  if (age === null) return 4;
  if (age < AI_LEVEL_GUARD_UNDER_AGE) return 2;
  if (age < AI_LEVEL_EXAM_FROM_AGE) return 3;
  return 4;
}

/** Is this level offered in the per-child picker for a child of this age?
 *  Only 🎓 Exam-Ready is age-gated (from 10). No birthday = everything. */
export function levelOfferedForAge(level: AiLevel, age: number | null): boolean {
  if (level !== 4) return true;
  return age === null || age >= AI_LEVEL_EXAM_FROM_AGE;
}

// ── Resolution ────────────────────────────────────────────────────────

export interface AiLevelResolution {
  level: AiLevel;
  /** Where the level came from. */
  source: 'child' | 'family' | 'default';
  /** The child's age today, or null when no birthday is on file. */
  age: number | null;
  /** Set when the age guard lowered the inherited family default. */
  capped?: { from: AiLevel; to: AiLevel };
}

type FamilyLike = { aiConfig?: { defaultLevel?: unknown } | null } | null | undefined;
type ChildLike = { aiLevel?: unknown; birthday?: string } | null | undefined;

/** Rules 1-4 in one place. Pass the family doc + the child doc of the kid
 *  whose work it is (never the actor's). */
export function resolveAiLevel(family: FamilyLike, child: ChildLike): AiLevelResolution {
  const age = child ? ageOf({ birthday: child.birthday }) : null;
  const override = parseAiLevel(child?.aiLevel);
  if (override) return { level: override, source: 'child', age };

  const hasFamilyDefault = parseAiLevel(family?.aiConfig?.defaultLevel) !== null;
  const wanted = readAiConfig(family).defaultLevel;
  const cap = maxInheritedLevel(age);
  const level = (wanted > cap ? cap : wanted) as AiLevel;
  return {
    level,
    source: hasFamilyDefault ? 'family' : 'default',
    age,
    ...(wanted > cap ? { capped: { from: wanted, to: level } } : {}),
  };
}

/** One-line kid-readable explanation for the chip's tap-to-explain. */
export function aiLevelExplainer(level: AiLevel): string {
  switch (level) {
    case 1: return 'Kaya marks gently here: effort counts, and you get one thing to try plus a cheer.';
    case 3: return 'Kaya is stretching you: firmer marking, a full breakdown, and slightly harder follow-ups.';
    case 4: return 'Kaya marks like school will: working shown, units, precise feedback, exam-style follow-ups.';
    default: return 'Kaya marks honestly and kindly: partial credit for the right method, up to three points of feedback.';
  }
}
