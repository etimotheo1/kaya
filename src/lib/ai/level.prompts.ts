// 🤖 Kaya AI Levels · the prompt briefs (server-only).
//
// Each kid-learning route appends ONE addendum block to its system prompt,
// chosen by surface + level. 🌤 Balanced returns null — the route's prompt
// stays byte-for-byte what it was before AI Levels shipped, so no family's
// scores move until a parent touches the dial. The kindness floor is the
// same sentence on every non-Balanced level.
//
// Surfaces wired in v1 (approved 2026-09-07 §3):
//   marking          /api/sparks/ai/revision-score (+ the re-evaluate chat)
//   next             /api/sparks/ai/revision-next
//   reflection-score /api/sparks/ai/reflection-score
//   reflect          /api/sparks/ai/reflect
//   week             /api/sparks/ai/reflection-week (cron · light touch)
//   quiz-write       treasures cupboard · quiz-start
//   quiz-rate        treasures cupboard · quiz-answer
//   coach-ear        quests ai · coach
//   business         /api/business-coach
//   diary-prompt     /api/sparks/ai/diary-prompt

import { aiLevelLabel, type AiLevel } from './level.shared';

export type AiSurface =
  | 'marking' | 'next' | 'reflection-score' | 'reflect' | 'week'
  | 'quiz-write' | 'quiz-rate' | 'coach-ear' | 'business' | 'diary-prompt';

export const KINDNESS_FLOOR =
  'Kindness floor (always, whatever the level): never shame, never compare the child to a sibling or anyone else, always end with a way forward, keep the words pitched to the child\'s age.';

const BRIEFS: Record<AiSurface, Partial<Record<AiLevel, string>>> = {
  marking: {
    1: 'Mark generously: effort counts; give wide partial credit (a right idea with a slip, or a real attempt with the right method, is "partial" — never "wrong"); spelling and presentation never cost marks. Keep "notes" to ONE thing to try plus ONE cheer, about two sentences, an emoji is fine. In "areas" give at most the 2 most helpful entries, phrased playfully; put strengths first. Coverage of "qbq" stays complete. Voice: warm cheerleader.',
    3: 'Mark firmly: partial credit ONLY when the working or method is visibly shown; a bare right answer on a question that needs working is "partial"; note presentation slips (unsimplified fractions, missing units, unclear layout) as their own "areas" entries. Give the full per-question breakdown: 3-5 specific strengths and one "areas" entry per wrong or partial question, each with a concrete tip. "notes" = the single most important thing to fix, said plainly. Voice: direct coach — clear asks, fewer cheers, no emoji.',
    4: 'Mark as a school teacher marks a test: method marks only when working is shown; answers without the required working are "partial" at best; missing units, unsimplified answers or wrong notation are marked down (as "partial", with the reason); in language subjects spelling and grammar count. "notes" = a marking-scheme style summary in plain, precise words. In "areas" give one entry per wrong or partial question naming the exact slip plus a model-answer hint (what a full-mark answer includes). Strengths = 3-5 specific method observations. Voice: teacher — plain, precise, respectful; no emoji anywhere.',
  },
  next: {
    1: 'DIFFICULTY OVERRIDE — ignore the score-based rule: make all 3 questions the same level as the page or one step easier, and start with one the child will almost surely get right. Friendly wording.',
    3: 'DIFFICULTY OVERRIDE — one step harder than the score suggests: if score < 60 use mixed, if 60-79 push harder, if ≥ 80 push clearly harder (multi-step). Still grade-appropriate.',
    4: 'DIFFICULTY OVERRIDE — write 3 exam-style questions at the grade\'s test standard, mixed difficulty, phrased like a test paper, and prefix EACH question with a marks + time hint in square brackets, e.g. "[3 marks · 4 min] …".',
  },
  'reflection-score': {
    1: 'Relax the anchors by about 10 points: a single concrete event lands around 55-60, an event plus a feeling around 75, and even a bland one-word entry no lower than 30. The rationale is one warm cheer naming what was good; only nudge when the entry is truly empty.',
    3: 'Hold the anchors firmly and expect a little more: an event alone stays near 45, an event plus a feeling is 60-65, and reaching 85 needs something noticed or learned. The rationale names the ONE thing that would lift it, plainly.',
    4: 'Apply the anchors strictly as written; 85 and above requires cause-and-effect or a next step. The rationale is one precise, plain sentence.',
  },
  reflect: {
    1: '"wentWell" is one warm sentence. Include a "tip" only if the child clearly asked for help or something is obviously missing, and make it playful. "cheer" is enthusiastic; an emoji is fine.',
    3: 'Always include a "tip" — specific and actionable, one clear thing to try tomorrow. "wentWell" stays specific. "cheer" is short, no emoji.',
    4: 'Always include a "tip" — precise and specific, phrased as a clear next step. Keep "wentWell" factual. "cheer" is one short plain sentence. No emoji.',
  },
  week: {
    1: 'The "tip" is a playful invitation, not an ask.',
    3: 'The "tip" is a clear, specific ask for next week.',
    4: 'The "tip" is precise and specific, like a teacher\'s margin note.',
  },
  'quiz-write': {
    1: 'Write 3 questions only: very simple recall and "what did you like" questions, in short words.',
    3: 'Write 5 questions, including at least two "why" or "what if" questions that need a reason.',
    4: 'Write 5 comprehension questions in the style of a school reading test: plot, a character\'s motive, the theme, and one "find the evidence in the book" question.',
  },
  'quiz-rate': {
    1: 'Rate very generously: any real attempt to engage with the book scores 70 or more, and the sentence is a cheer.',
    3: 'Rate honestly against the book: reward reasons and detail, not just effort; the sentence names one thing to add next time.',
    4: 'Rate against comprehension standards: accuracy, evidence from the book, reasoning. The sentence gives one precise point to improve.',
  },
  'coach-ear': {
    1: 'Give at most 2 notes — the kindest and easiest to act on — then a big cheer. The clarity read leans generous.',
    3: 'Give 3 direct notes, each with a concrete fix. The clarity read is honest. Keep the cheer brief.',
    4: 'Give 3 precise notes as a speech examiner would (structure, pace, clarity), each with an exact fix. The clarity read is strict. The cheer is one plain sentence.',
  },
  business: {
    1: 'One warm reflection plus one tiny next step; keep it light and cheerful.',
    3: 'Be direct: name the number that matters most and one clear action. Still kind.',
    4: 'Give a precise, numbers-first read — margin per unit or per hour — and one measurable target for the next period. Plain words, no fluff.',
  },
  'diary-prompt': {
    1: 'Make the prompt very simple, concrete and playful — at most 12 words.',
    3: 'Make the prompt ask for a reason or a comparison (why / how / what changed).',
    4: 'Make the prompt reflective — one that invites a paragraph with a reason and an example.',
  },
};

const HEADINGS: Record<AiSurface, string> = {
  marking: 'MARKING LEVEL',
  next: 'CHALLENGE LEVEL',
  'reflection-score': 'SCORING LEVEL',
  reflect: 'FEEDBACK LEVEL',
  week: 'TONE LEVEL',
  'quiz-write': 'QUIZ LEVEL',
  'quiz-rate': 'RATING LEVEL',
  'coach-ear': 'COACHING LEVEL',
  business: 'COACHING LEVEL',
  'diary-prompt': 'PROMPT LEVEL',
};

/** The system-prompt addendum for this surface at this level, or null for
 *  🌤 Balanced (= today's prompt, untouched). */
export function aiLevelAddendum(surface: AiSurface, level: AiLevel): string | null {
  const brief = BRIEFS[surface][level];
  if (!brief) return null;
  return `${HEADINGS[surface]}: ${aiLevelLabel(level)} (set by the child's parent). ${brief}\n${KINDNESS_FLOOR}`;
}

/** Deeper levels write more; never LOWER a route's budget (a truncated
 *  JSON answer is worse than a slightly long one). */
export function scaleTokens(base: number, level: AiLevel): number {
  const f = level === 4 ? 1.6 : level === 3 ? 1.3 : 1;
  return Math.round(base * f);
}
