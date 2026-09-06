// Pure computation for the Family Meeting "Points Review" presenter view.
//
// Two awards are computed per child over a configurable date window:
//   • Excellent Belt  — a "clean day" where every active routine in both
//                       morning and evening was rated 'excellent'.
//   • Excellent Ladder — a routine where every rating in the window was
//                       'excellent' (days with no rating for that routine
//                       are ignored, so a missed day doesn't punish anyone).
//
// Winners are computed across all children: kid(s) with the highest count
// of Belt days / Ladder routines. Ties surface every tied kid.

import type { Award, Child, DailyRating, Routine } from './firestore';

// Discriminated window descriptor. Quick-pick chips use the bare kinds
// (today / lifetime / last7 / …); the dropdown + custom chip carry extra
// data on the same object so a single state value covers every case.
export type WindowKey =
  | { kind: 'today' }
  | { kind: 'lifetime' }
  | { kind: 'last7' }
  | { kind: 'last14' }
  | { kind: 'mtd' }
  | { kind: 'month'; year: number; month: number }  // month is 1–12 (UTC)
  | { kind: 'custom'; from: string; to: string };   // YYYY-MM-DD inclusive

export interface WindowRange {
  from: string;       // YYYY-MM-DD, inclusive
  to: string;         // YYYY-MM-DD, inclusive
  days: string[];     // every date from `from` → `to` inclusive
  label: string;      // human-friendly summary, e.g. "Last 7 days"
}

export interface KidReviewStats {
  childId: string;
  pointsFromRatings: number;
  pointsFromAwards: number;
  totalPoints: number;
  beltDays: string[];           // YYYY-MM-DD dates that were clean
  ladderRoutineIds: string[];   // routine ids that stayed Excellent
}

export interface ReviewResult {
  range: WindowRange;
  perKid: Record<string, KidReviewStats>;
  leaderboard: KidReviewStats[];     // sorted by totalPoints desc
  beltWinnerIds: string[];           // kids with the most Belt days (≥1)
  beltWinnerCount: number;           // shared score among the winners
  ladderWinnerIds: string[];         // kids with the most Ladder routines (≥1)
  ladderWinnerCount: number;
}

// ── Date helpers ─────────────────────────────────────────────────────────
//
// All math is anchored to UTC. Naive local-time math (e.g.
//   `new Date('2026-05-10T00:00:00.000')` then `.toISOString()`) round-trips
// to the *previous* date in any timezone ahead of UTC, which made
// `enumerateDays` loop forever for users in Dar es Salaam (UTC+3) and
// wedged the browser tab. UTC-anchored math sidesteps the whole class.

function toDateString(d: Date): string {
  return d.toISOString().split('T')[0];
}

function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return toDateString(d);
}

// Safety cap: bumped from 400 to 3 650 (~10 years) so Lifetime windows
// resolve without truncating. The cap exists only to keep a pathological
// `addDays` regression from wedging the renderer; 10y is plenty for any
// realistic family use of Kaya.
const ENUMERATE_MAX_DAYS = 3650;

function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = from;
  let safety = 0;
  while (cursor <= to && safety < ENUMERATE_MAX_DAYS) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
    safety += 1;
  }
  return out;
}

const SHORT_MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Resolve a WindowKey to a concrete date range. Trailing periods
// (last7 / last14 / mtd / lifetime) END ON the meeting day, INCLUSIVE, so
// points earned or issued during the meeting itself count in that meeting's
// review.
//
// Fixed 2026-09-06 (Elia): these used to anchor `to` at meeting-day −1
// ("Sunday's meeting reviews up to Saturday"), which silently dropped
// everything logged or awarded ON the meeting day. For a family that holds
// the meeting — and issues house points — on Sunday, Sunday's points fell
// outside "Last 7 days" and kids were under-counted. Ending inclusive of the
// meeting day recomputes every past and future review correctly, no data
// migration needed (the review is computed live from stored ratings/awards).
//
// `today` is a one-day window on the meeting day. `lifetime` reaches back to
// a sentinel earliest date.
export function computeWindowRange(window: WindowKey, meetingDateStr: string): WindowRange {
  switch (window.kind) {
    case 'today': {
      return { from: meetingDateStr, to: meetingDateStr, days: [meetingDateStr], label: 'Today' };
    }
    case 'lifetime': {
      // Sentinel earliest date — early enough to predate any Kaya family.
      // We don't actually walk every day for display use cases; the consuming
      // tab decides whether to cap the visual window.
      const from = '2020-01-01';
      const to = meetingDateStr;
      return { from, to, days: enumerateDays(from, to), label: 'Lifetime' };
    }
    case 'last7': {
      const to = meetingDateStr;
      const from = addDays(to, -6);
      return { from, to, days: enumerateDays(from, to), label: 'Last 7 days' };
    }
    case 'last14': {
      const to = meetingDateStr;
      const from = addDays(to, -13);
      return { from, to, days: enumerateDays(from, to), label: 'Last 14 days' };
    }
    case 'mtd': {
      const to = meetingDateStr;
      const toDate = new Date(`${to}T00:00:00.000Z`);
      const firstOfMonth = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), 1));
      let from = toDateString(firstOfMonth);
      if (from > to) from = to;
      return { from, to, days: enumerateDays(from, to), label: 'Month to date' };
    }
    case 'month': {
      // First → last UTC day of the chosen calendar month.
      const first = new Date(Date.UTC(window.year, window.month - 1, 1));
      const lastDay = new Date(Date.UTC(window.year, window.month, 0));
      const from = toDateString(first);
      const to = toDateString(lastDay);
      const label = `${SHORT_MONTH[window.month - 1]} ${window.year}`;
      return { from, to, days: enumerateDays(from, to), label };
    }
    case 'custom': {
      // Tolerate from > to by swapping — gentler than failing silently.
      let from = window.from;
      let to = window.to;
      if (from > to) [from, to] = [to, from];
      return { from, to, days: enumerateDays(from, to), label: 'Custom' };
    }
  }
}

// Build the trailing-12-months option list for the "Months" dropdown,
// most recent first. Each entry is a ready-to-use WindowKey.
export function recentMonths(meetingDateStr: string, count = 12): { key: WindowKey; label: string }[] {
  const anchor = new Date(`${meetingDateStr}T00:00:00.000Z`);
  const list: { key: WindowKey; label: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    list.push({
      key: { kind: 'month', year, month },
      label: `${SHORT_MONTH[month - 1]} ${year}`,
    });
  }
  return list;
}

// ── Belt / Ladder computation ───────────────────────────────────────────

// A day is a "Belt day" when:
//   1. Both morning AND evening DailyRating docs exist for that kid+date.
//   2. Every routine present in either doc is rated 'excellent'.
// (Inactive routines that aren't rated don't count against — they simply
// won't appear in the ratings map. Skip / good / bad all break the Belt.)
function isCleanDay(ratingsForDay: DailyRating[]): boolean {
  if (ratingsForDay.length < 2) return false;
  const periods = new Set(ratingsForDay.map((r) => r.period));
  if (!periods.has('morning') || !periods.has('evening')) return false;
  for (const r of ratingsForDay) {
    const values = Object.values(r.ratings || {});
    if (values.length === 0) return false;
    if (values.some((v) => v !== 'excellent')) return false;
  }
  return true;
}

// A routine wins the Ladder when, across all ratings in the window for that
// kid+period, the routine was always 'excellent'. Days where the routine
// wasn't rated at all are ignored (missed day ≠ failure). Requires at least
// one Excellent rating so untouched routines don't auto-win.
function ladderRoutineIds(child: Child, ratings: DailyRating[], routines: Routine[]): string[] {
  const active = routines.filter((r) => r.active);
  const kidRatings = ratings.filter((r) => r.childId === child.id);
  const won: string[] = [];
  for (const routine of active) {
    const relevant = kidRatings.filter((r) => r.period === routine.period);
    let sawExcellent = false;
    let broken = false;
    for (const doc of relevant) {
      const v = doc.ratings?.[routine.id];
      if (v === undefined) continue; // not rated that day — skip
      if (v === 'excellent') sawExcellent = true;
      else { broken = true; break; }
    }
    if (sawExcellent && !broken) won.push(routine.id);
  }
  return won;
}

function beltDays(child: Child, ratings: DailyRating[], days: string[]): string[] {
  const kidRatings = ratings.filter((r) => r.childId === child.id);
  const byDate = new Map<string, DailyRating[]>();
  for (const r of kidRatings) {
    const bucket = byDate.get(r.date) ?? [];
    bucket.push(r);
    byDate.set(r.date, bucket);
  }
  return days.filter((d) => isCleanDay(byDate.get(d) ?? []));
}

// ── Top-level computation ───────────────────────────────────────────────

export function computeReview(
  children: Child[],
  routines: Routine[],
  ratings: DailyRating[],
  awards: Award[],
  range: WindowRange,
): ReviewResult {
  const perKid: Record<string, KidReviewStats> = {};

  for (const child of children) {
    const kidRatings = ratings.filter((r) => r.childId === child.id);
    const kidAwards = awards.filter((a) => a.childId === child.id);

    const pointsFromRatings = kidRatings.reduce((sum, r) => sum + (r.totalPoints || 0), 0);
    const pointsFromAwards = kidAwards.reduce((sum, a) => sum + (a.points || 0), 0);

    perKid[child.id] = {
      childId: child.id,
      pointsFromRatings,
      pointsFromAwards,
      totalPoints: pointsFromRatings + pointsFromAwards,
      beltDays: beltDays(child, ratings, range.days),
      ladderRoutineIds: ladderRoutineIds(child, ratings, routines),
    };
  }

  const leaderboard = Object.values(perKid).sort((a, b) => b.totalPoints - a.totalPoints);

  const beltWinnerCount = Math.max(0, ...Object.values(perKid).map((k) => k.beltDays.length));
  const beltWinnerIds = beltWinnerCount === 0
    ? []
    : Object.values(perKid).filter((k) => k.beltDays.length === beltWinnerCount).map((k) => k.childId);

  const ladderWinnerCount = Math.max(0, ...Object.values(perKid).map((k) => k.ladderRoutineIds.length));
  const ladderWinnerIds = ladderWinnerCount === 0
    ? []
    : Object.values(perKid).filter((k) => k.ladderRoutineIds.length === ladderWinnerCount).map((k) => k.childId);

  return { range, perKid, leaderboard, beltWinnerIds, beltWinnerCount, ladderWinnerIds, ladderWinnerCount };
}

// ── Belt v2 ─────────────────────────────────────────────────────────────
//
// New definition (Elia 2026-05-16): champion = the (kid, day) combination
// with the most 'excellent' ratings in the window. The Bad toggle mirrors
// the same logic for 'bad' ratings (worst day). "Reveal Next" cycles the
// presenter through the next-best (kid, day) tuple so multiple champions
// can be celebrated in one meeting.

export interface DayScore {
  childId: string;
  date: string;                  // YYYY-MM-DD
  excellentCount: number;
  badCount: number;
  excellentRoutineIds: string[]; // routines rated Excellent on that day
  badRoutineIds: string[];       // routines rated Bad on that day
  totalRated: number;            // total non-skip ratings on the day
}

// Build one DayScore per (kid, day) tuple that has at least one rating.
export function computeDayScores(
  children: Child[],
  ratings: DailyRating[],
  range: WindowRange,
): DayScore[] {
  const out: DayScore[] = [];
  for (const child of children) {
    const kidRatings = ratings.filter((r) => r.childId === child.id);
    const byDate = new Map<string, DailyRating[]>();
    for (const r of kidRatings) {
      if (!range.days.includes(r.date)) continue;
      const bucket = byDate.get(r.date) ?? [];
      bucket.push(r);
      byDate.set(r.date, bucket);
    }
    for (const [date, docs] of byDate.entries()) {
      const excellent: string[] = [];
      const bad: string[] = [];
      let totalRated = 0;
      for (const doc of docs) {
        for (const [routineId, value] of Object.entries(doc.ratings || {})) {
          if (value === 'skip') continue;
          totalRated += 1;
          if (value === 'excellent') excellent.push(routineId);
          else if (value === 'bad') bad.push(routineId);
        }
      }
      if (totalRated === 0) continue;
      out.push({
        childId: child.id,
        date,
        excellentCount: excellent.length,
        badCount: bad.length,
        excellentRoutineIds: excellent,
        badRoutineIds: bad,
        totalRated,
      });
    }
  }
  return out;
}

// Sort day-scores for Belt presentation. Excellent: count desc, then date desc
// (more recent days break ties — feels timely in the meeting). Bad: same.
export function topDays(scores: DayScore[], kind: 'excellent' | 'bad'): DayScore[] {
  const key = (s: DayScore) => (kind === 'excellent' ? s.excellentCount : s.badCount);
  return [...scores]
    .filter((s) => key(s) > 0)
    .sort((a, b) => {
      const diff = key(b) - key(a);
      if (diff !== 0) return diff;
      return a.date < b.date ? 1 : -1;
    });
}

// ── Sunday-Meeting v2: Excellent Belt (perfect day) helpers ────────────
//
// New honour, separate from the existing "most-Excellents-in-a-day"
// recognition (which becomes Excellent Star of the Day in the UI).
//
//   • isPerfectDay  — a (kid, day) where every rated routine was Excellent,
//                     i.e. excellentCount === totalRated && totalRated > 0.
//                     This is the gate for the Belt.
//   • perfectDays   — filter helper for downstream lists.
//   • beltChampions — kids ranked by perfect-day count in the window. Used
//                     to call out the Belt Champion(s) at the meeting and
//                     to drive the per-kid bonus award row. Ties surface
//                     as multiple champions; the caller decides whether
//                     to split the bonus.

export function isPerfectDay(s: DayScore): boolean {
  return s.totalRated > 0 && s.excellentCount === s.totalRated;
}

export function perfectDays(scores: DayScore[]): DayScore[] {
  return scores.filter(isPerfectDay);
}

export interface BeltChampion {
  childId: string;
  count: number;        // # perfect days in the window
  days: DayScore[];     // the perfect days themselves (sorted newest first)
  isChampion: boolean;  // true for everyone tied at the max
}

export function beltChampions(scores: DayScore[]): BeltChampion[] {
  const perfect = perfectDays(scores);
  const byKid = new Map<string, DayScore[]>();
  for (const s of perfect) {
    const bucket = byKid.get(s.childId) ?? [];
    bucket.push(s);
    byKid.set(s.childId, bucket);
  }
  // Build rows (count desc, then most-recent perfect-day desc).
  const rows: BeltChampion[] = [];
  for (const [childId, days] of byKid.entries()) {
    const sortedDays = [...days].sort((a, b) => (a.date < b.date ? 1 : -1));
    rows.push({ childId, count: sortedDays.length, days: sortedDays, isChampion: false });
  }
  rows.sort((a, b) => {
    const diff = b.count - a.count;
    if (diff !== 0) return diff;
    // Tiebreak: most recent perfect day surfaces first so a kid who was
    // perfect *yesterday* outranks one who was perfect three weeks ago.
    const aRecent = a.days[0]?.date ?? '';
    const bRecent = b.days[0]?.date ?? '';
    return aRecent < bRecent ? 1 : -1;
  });
  const maxCount = rows[0]?.count ?? 0;
  return rows.map((r) => ({ ...r, isChampion: maxCount > 0 && r.count === maxCount }));
}

// ── Ladder v2 ───────────────────────────────────────────────────────────
//
// Per-kid trophy grid: only the routines a kid completed (Excellent every
// rated day in the window) are shown, with their day chips. Drives the
// per-kid columns in the Ladder tab.

export type LadderDayStatus = 'excellent' | 'good' | 'bad' | 'skip' | 'unrated';

export interface LadderDayCell {
  date: string;
  status: LadderDayStatus;
  hasComment: boolean;     // rating doc for this day+period had a comment
}

export interface LadderRow {
  routineId: string;
  label: string;
  icon: string;
  period: 'morning' | 'evening';
  days: LadderDayCell[];   // reverse chronological — most recent first
  complete: boolean;       // every rated day was Excellent (= ladder rung won)
}

export function computeLadderRows(
  child: Child,
  routines: Routine[],
  ratings: DailyRating[],
  range: WindowRange,
): LadderRow[] {
  const active = routines.filter((r) => r.active);
  const kidRatings = ratings.filter((r) => r.childId === child.id);

  // Index by (date, period) → DailyRating for O(1) lookup.
  const docByDatePeriod = new Map<string, DailyRating>();
  for (const r of kidRatings) {
    docByDatePeriod.set(`${r.date}|${r.period}`, r);
  }

  const rowsReversed = [...range.days].reverse();
  const rows: LadderRow[] = [];
  for (const routine of active) {
    const days: LadderDayCell[] = rowsReversed.map((date) => {
      const doc = docByDatePeriod.get(`${date}|${routine.period}`);
      const v = doc?.ratings?.[routine.id];
      const status: LadderDayStatus = v ?? 'unrated';
      return { date, status, hasComment: !!doc?.comment };
    });
    // Complete: at least one Excellent + zero non-Excellent (skips don't
    // count against). Mirrors the existing `ladderRoutineIds` rule.
    const rated = days.filter((d) => d.status !== 'unrated' && d.status !== 'skip');
    const allExcellent = rated.length > 0 && rated.every((d) => d.status === 'excellent');
    rows.push({
      routineId: routine.id,
      label: routine.label,
      icon: routine.icon,
      period: routine.period,
      days,
      complete: allExcellent,
    });
  }
  return rows;
}

// ── Comments ────────────────────────────────────────────────────────────
//
// Surfaces helper / parent notes left when ratings were submitted. Drives
// the Behaviour tab so families can talk about specific moments.

export interface CommentEntry {
  ratingId: string;
  childId: string;
  date: string;
  period: 'morning' | 'evening';
  ratedByName: string;
  comment: string;
  /** Tone of the underlying day-period's ratings. 'bad' if anything
   *  was rated Bad; else 'excellent' if anything was Excellent; else
   *  'neutral'. Drives the Behaviour tab's Excellent/Bad filter and
   *  the per-comment tag chip. */
  tone: 'bad' | 'excellent' | 'neutral';
}

function deriveTone(r: DailyRating): CommentEntry['tone'] {
  const vals = Object.values(r.ratings || {});
  if (vals.includes('bad')) return 'bad';
  if (vals.includes('excellent')) return 'excellent';
  return 'neutral';
}

export function extractComments(ratings: DailyRating[]): CommentEntry[] {
  const out: CommentEntry[] = ratings
    .filter((r) => r.comment && r.comment.trim().length > 0)
    .map((r) => ({
      ratingId: r.id,
      childId: r.childId,
      date: r.date,
      period: r.period,
      ratedByName: r.ratedByName || 'Unknown',
      comment: r.comment!.trim(),
      tone: deriveTone(r),
    }));
  // Kid Stats PR2 — the kid's own 💬 reflections join the meeting
  // commentary stream, so a low rating arrives already explained and
  // the meeting doesn't have to ask.
  for (const r of ratings) {
    for (const [routineId, ref] of Object.entries(r.reflections || {})) {
      if (!ref?.text?.trim()) continue;
      out.push({
        ratingId: `${r.id}:reflection:${routineId}`,
        childId: r.childId,
        date: r.date,
        period: r.period,
        ratedByName: `💬 ${ref.byName} (own reflection)`,
        comment: ref.text.trim(),
        tone: deriveTone(r),
      });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

// ─────────────────────────────────────────────────────────────────────────
// ⭐ STAR PODIUM (SM3.1 · #3) — one podium per selected timeframe, with
// rules a kid can verify against their own week:
//
//   Star Score = 2×Excellent + 1×Good − 2×Bad   (over the window)
//   Qualify    = rated on ≥70% of the window's ACTIVE days (days where
//                anyone in the family was rated) — fair to everyone,
//                nobody wins by being away.
//   Ties       = fewer Bads wins; still tied → share the podium step.
//
// The old per-day "most Excellents" star lives on as the small daily-stars
// history strip (dailyStarWinners) — a record, not a ceremony.
// ─────────────────────────────────────────────────────────────────────────

export const STAR_WEIGHTS = { excellent: 2, good: 1, bad: -2 } as const;
export const STAR_QUALIFY_FRACTION = 0.7;

export interface StarStanding {
  childId: string;
  score: number;
  excellent: number;
  good: number;
  bad: number;
  daysRated: number;
  qualifies: boolean;
}

export function computeStarStandings(dayScores: DayScore[]): {
  standings: StarStanding[];   // sorted best → worst (every kid with a rating)
  activeDays: number;          // distinct dates ANY kid was rated
  daysNeeded: number;          // qualification threshold for this window
} {
  const dates = new Set(dayScores.map((d) => d.date));
  const activeDays = dates.size;
  const daysNeeded = Math.max(1, Math.ceil(activeDays * STAR_QUALIFY_FRACTION));
  const per = new Map<string, StarStanding>();
  for (const ds of dayScores) {
    const cur = per.get(ds.childId)
      ?? { childId: ds.childId, score: 0, excellent: 0, good: 0, bad: 0, daysRated: 0, qualifies: false };
    const good = Math.max(0, ds.totalRated - ds.excellentCount - ds.badCount);
    cur.excellent += ds.excellentCount;
    cur.good += good;
    cur.bad += ds.badCount;
    cur.daysRated += 1;
    per.set(ds.childId, cur);
  }
  const standings = Array.from(per.values())
    .map((s) => ({
      ...s,
      score: STAR_WEIGHTS.excellent * s.excellent + STAR_WEIGHTS.good * s.good + STAR_WEIGHTS.bad * s.bad,
      qualifies: s.daysRated >= daysNeeded,
    }))
    .sort((a, b) => b.score - a.score || a.bad - b.bad || b.excellent - a.excellent);
  return { standings, activeDays, daysNeeded };
}

/** Podium ranks (1–3) over the QUALIFYING standings. Exact ties on
 *  (score, bads, excellents) SHARE the step — 1,1,3 style. */
export function starPodiumRanks(standings: StarStanding[]): Map<string, number> {
  const ranks = new Map<string, number>();
  let rank = 0;
  let seen = 0;
  let prevKey = '';
  for (const s of standings.filter((x) => x.qualifies)) {
    seen += 1;
    const key = `${s.score}|${s.bad}|${s.excellent}`;
    if (key !== prevKey) { rank = seen; prevKey = key; }
    if (rank > 3) break;
    ranks.set(s.childId, rank);
  }
  return ranks;
}

/** The kid with the most Excellents on each active day — the daily-stars
 *  history strip under the podium (record only, no ceremony). */
export function dailyStarWinners(
  dayScores: DayScore[],
): Array<{ date: string; childId: string; excellentCount: number }> {
  const byDate = new Map<string, DayScore>();
  for (const ds of dayScores) {
    const cur = byDate.get(ds.date);
    if (!cur || ds.excellentCount > cur.excellentCount) byDate.set(ds.date, ds);
  }
  return Array.from(byDate.values())
    .filter((d) => d.excellentCount > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ date: d.date, childId: d.childId, excellentCount: d.excellentCount }));
}
