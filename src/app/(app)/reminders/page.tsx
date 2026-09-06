'use client';

// Kaya Reminders — the space under the Kaya nav group (approved v3 FINAL,
// 2026-06-13). Every user (parent · kid · helper) gets it. Events are 🔒
// private or 👨‍👩‍👧 shared; repeat on fixed days OR by an "N times a
// week/month" frequency; remind at a lead time via 🔔 in-app + 📧 email
// (with a recipient picker — family + add-your-own); and surface in My Day
// + a Home chip (PR B). All reads/writes route through the Admin-SDK
// /api/reminders/* endpoints — see lib/reminders header for why.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useFamily } from '@/contexts/FamilyContext';
import { getFamilyMembers, type UserProfile, type Child } from '@/lib/firestore';
import { filterListedMembers } from '@/lib/helperVisibility';
import { toDisplayDate, dayOfWeek } from '@/lib/dates';
import {
  fetchReminders, saveReminder, deleteReminder, decideReminder,
  occurrencesInRange, autoImportedEvents, isAutoImported,
  describeRepeat, formatTime, relativeDays, typeMeta,
  nextOccurrenceOnOrAfter, diffDaysKey, nthFor, displayTitle, nthSubLabel, anniversaryMilestone,
  REMINDER_TYPES, WEEKDAY_LABELS, LEAD_PRESETS, todayKey, resolveGroupRecipients,
  type ReminderEvent, type ReminderType, type ReminderVisibility,
  type RepeatRule, type RepeatFreq, type MonthDay, type ReminderRecipient,
  type EmailGroup, type GreetTo, type FamilyContact, cardEligible, builtInGroups, nextAnniversaryOf, syncGreetToWithContact,
  isCareType, suggestSlots, slotIcon, careDayNumber, careTotalDays, careEndDate, addDaysKey, doseKeyFor,
  type CareInfo, type CareSlot, type CareDurationMode, type DoseEntry,
} from '@/lib/reminders';
import { compressImageBlob, safeUploadBytes } from '@/lib/storageUpload';
import { ref as storageRef, getDownloadURL } from 'firebase/storage';
import { storage } from '@/lib/firebase';
import HonoreePicker from '@/components/reminders/HonoreePicker';
import GreetingCardStudio, { type StudioTarget } from '@/components/reminders/GreetingCardStudio';
import { listCards, cardIdFor, type GreetingCard } from '@/lib/greetingCards';
import GiftBrain from '@/components/reminders/GiftBrain';
import CareDoseCards from '@/components/reminders/CareDoseCards';
import CatchUpBoard from '@/components/catchup/CatchUpBoard';
import TimeCapsule from '@/components/reminders/TimeCapsule';
import { PAGE_WIDTH_CLASS, PageSplit, DataRows, DATA_ROW, DATA_ROW_HOVER } from '@/components/layout/Page';

// Reminders accent (the approved indigo from the v3 mock). Scoped to this
// module via arbitrary values so it never touches the kaya-* palette.
const CAL = '#5B6CC8';
const CAL_DK = '#3E4DA0';
const CAL_SOFT = '#E7EAFA';
// 💊 v5 Care accent — the approved mint-teal (deeper than the 🎉 event mid).
const CARE = '#2E8C7E';
const CARE_SOFT = '#E2F4F1';

const MONTH_DAY_CHIPS: MonthDay[] = [1, 5, 10, 15, 20, 25, 'last'];

// "2026-06" → "June 2026" for the All-reminders month groups.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  return `${MONTH_NAMES[parseInt(m[2], 10) - 1] || ''} ${m[1]}`;
}

interface FormState {
  id?: string;
  type: ReminderType;
  title: string;
  date: string;       // YYYY-MM-DD
  originDate: string; // YYYY-MM-DD or '' — actual DOB / wedding day (v4 Nth)
  time: string;       // HH:MM or ''
  withWho: string;
  location: string;
  note: string;
  visibility: ReminderVisibility;
  freq: RepeatFreq;
  weekdays: number[];
  monthDays: MonthDay[];
  customCount: number;
  customPer: 'week' | 'month';
  endMode: 'never' | 'on' | 'after';
  endOn: string;
  endAfter: number;
  leadDays: number[];
  channelInApp: boolean;
  channelEmail: boolean;
  recipients: ReminderRecipient[];
  /** ✉️ 2.0 — the honoree (greeting card target). */
  greetTo: GreetTo | null;
  /** 💊 v5 — care fields (type medicine|routine only). */
  careDose: string;
  careSlots: CareSlot[];
  careDurMode: CareDurationMode;
  careDays: number;
  careUntil: string;
  careForKind: 'kid' | 'self';
  careForChildId: string;
  careForName: string;
  careGiverUids: string[];
  careWithFood: boolean;
  carePhotoUrl: string;
  careLabelName: string;
  carePackCount: number | null;
  careWatchInApp: boolean;
  careWatchSummary: boolean;
  careWatchMissed: boolean;
}

function blankForm(): FormState {
  return {
    type: 'reminder', title: '', date: todayKey(), originDate: '', time: '', withWho: '', location: '', note: '',
    visibility: 'shared', freq: 'none', weekdays: [], monthDays: [], customCount: 3, customPer: 'week',
    endMode: 'never', endOn: '', endAfter: 10, leadDays: [1, 0], channelInApp: true, channelEmail: false,
    recipients: [],
    greetTo: null,
    careDose: '', careSlots: suggestSlots(3), careDurMode: 'days', careDays: 7, careUntil: '',
    careForKind: 'kid', careForChildId: '', careForName: '', careGiverUids: [],
    careWithFood: false, carePhotoUrl: '', careLabelName: '', carePackCount: null,
    careWatchInApp: true, careWatchSummary: true, careWatchMissed: true,
  };
}

function formFromEvent(ev: ReminderEvent): FormState {
  const r = ev.repeat || { freq: 'none' };
  // Pre-fill the origin from the anchor when the anchor's year is already in
  // the past — "the Date you entered is already the true original date"
  // (approved v4 design). Visible in the field + ✨ preview before saving.
  const inferredOrigin = (ev.type === 'birthday' || ev.type === 'anniversary')
    && ev.date.slice(0, 4) < todayKey().slice(0, 4)
    ? ev.date : '';
  return {
    id: ev.id,
    type: ev.type, title: ev.title, date: ev.date, originDate: ev.originDate || inferredOrigin, time: ev.time || '',
    withWho: ev.withWho || '', location: ev.location || '', note: ev.note || '',
    visibility: ev.visibility,
    freq: r.freq || 'none',
    weekdays: r.weekdays || [],
    monthDays: r.monthDays || [],
    customCount: r.customCount || 3,
    customPer: r.customPer || 'week',
    endMode: r.end?.mode || 'never',
    endOn: r.end?.onDate || '',
    endAfter: r.end?.afterCount || 10,
    leadDays: ev.leadDays?.length ? ev.leadDays : [0],
    channelInApp: ev.channels?.inApp !== false,
    channelEmail: !!ev.channels?.email,
    recipients: ev.emailRecipients || [],
    greetTo: ev.greetTo || null,
    careDose: ev.care?.dose || '',
    careSlots: ev.care?.slots?.length ? ev.care.slots : suggestSlots(3),
    careDurMode: ev.care?.duration?.mode || 'days',
    careDays: ev.care?.duration?.mode === 'days' ? (ev.care.duration.days || 7) : 7,
    careUntil: ev.care?.duration?.mode === 'until' ? (ev.care.duration.until || '') : '',
    careForKind: ev.care?.forKind || 'kid',
    careForChildId: ev.care?.forChildId || '',
    careForName: ev.care?.forName || '',
    careGiverUids: ev.care?.giverUids || [],
    careWithFood: !!ev.care?.withFood,
    carePhotoUrl: ev.care?.photoUrl || '',
    careLabelName: ev.care?.labelName || '',
    carePackCount: ev.care?.packCount ?? null,
    careWatchInApp: ev.care?.watchInApp !== false,
    careWatchSummary: ev.care?.watchSummaryEmail !== false,
    careWatchMissed: ev.care?.watchMissedEmail !== false,
  };
}

/** Build the care payload for save — undefined for non-care types. */
function buildCare(f: FormState): CareInfo | undefined {
  if (!isCareType(f.type)) return undefined;
  return {
    dose: f.careDose.trim(),
    slots: f.careSlots,
    duration: f.careDurMode === 'days' ? { mode: 'days', days: f.careDays }
      : f.careDurMode === 'until' ? { mode: 'until', until: f.careUntil }
      : { mode: 'ongoing' },
    forKind: f.careForKind,
    ...(f.careForKind === 'kid' && f.careForChildId ? { forChildId: f.careForChildId } : {}),
    ...(f.careForName ? { forName: f.careForName } : {}),
    giverUids: f.careGiverUids,
    ...(f.careWithFood ? { withFood: true } : {}),
    ...(f.carePhotoUrl ? { photoUrl: f.carePhotoUrl } : {}),
    ...(f.careLabelName ? { labelName: f.careLabelName } : {}),
    ...(f.carePackCount ? { packCount: f.carePackCount } : {}),
    watchInApp: f.careWatchInApp,
    watchSummaryEmail: f.careWatchSummary,
    watchMissedEmail: f.careWatchMissed,
  };
}

function buildRepeat(f: FormState): RepeatRule {
  const rule: RepeatRule = { freq: f.freq };
  if (f.freq === 'weekly') rule.weekdays = f.weekdays;
  if (f.freq === 'monthly') rule.monthDays = f.monthDays;
  if (f.freq === 'custom') { rule.customCount = f.customCount; rule.customPer = f.customPer; }
  if (f.freq !== 'none') {
    if (f.endMode === 'on') rule.end = { mode: 'on', onDate: f.endOn };
    else if (f.endMode === 'after') rule.end = { mode: 'after', afterCount: f.endAfter };
    else rule.end = { mode: 'never' };
  }
  return rule;
}

export default function RemindersPage() {
  const { user, profile } = useAuth();
  const { children, family } = useFamily();
  const uid = profile?.uid || '';
  const role = profile?.role;

  const [events, setEvents] = useState<ReminderEvent[]>([]);
  const [members, setMembers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // "All reminders" by-month list (approved 2026-06-14): search + which
  // month groups are expanded. Soonest month opens once on first load.
  const [search, setSearch] = useState('');
  // R2-2 — two tabs: the original Reminders material vs the Catch-Up
  // Board (parents only; kids just see the reminders content).
  const [tab, setTab] = useState<'reminders' | 'catchup'>('reminders');
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  const [monthsSeeded, setMonthsSeeded] = useState(false);
  // ✉️ 2.0 — greeting cards by id (`${eventId}_${dateKey}`) + the open Studio.
  const [cards, setCards] = useState<Record<string, GreetingCard>>({});
  const [studio, setStudio] = useState<StudioTarget | null>(null);
  const [deepLinkDone, setDeepLinkDone] = useState(false);

  const load = useCallback(async () => {
    if (!user || !profile?.familyId) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const [evs, mems] = await Promise.all([
        fetchReminders(token),
        getFamilyMembers(profile.familyId).catch(() => [] as UserProfile[]),
      ]);
      setEvents(evs);
      // 🤝 2026-08-25 — outside helpers (driver, gardener…) drop out of
      // the recipient checklist, the built-in groups and the honoree
      // picker. A saved reminder that already names one keeps them: the
      // address simply falls through to the ✉️ external list below
      // (see `externals`), so nothing is lost and it stays removable.
      setMembers(filterListedMembers(mems, profile.uid).filter((m) => !!m.email));
      listCards().then((cs) => setCards(Object.fromEntries(cs.map((c) => [c.id, c])))).catch(() => {});
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [user, profile?.familyId]);

  useEffect(() => { load(); }, [load]);

  // Auto-imported family birthdays/anniversary surface alongside manual
  // events (read-only mirrors). Children come from the family context.
  const autoEvents = useMemo(() => {
    if (!profile?.familyId) return [] as ReminderEvent[];
    const people = (children || []).map((c) => ({ id: c.id, name: c.name, birthday: c.birthday, kind: 'kid' as const }));
    return autoImportedEvents(profile.familyId, people, family || undefined);
  }, [children, family, profile?.familyId]);

  // ✉️ 2.0 — People Book is the record of truth: show corrected names/emails
  // even before the server re-syncs the stored snapshot.
  const allEvents = useMemo(() => [
    ...events.map((e) => (e.greetTo ? { ...e, greetTo: syncGreetToWithContact(e.greetTo, family?.contacts) } : e)),
    ...autoEvents,
  ], [events, autoEvents, family?.contacts]);

  const occurrences = useMemo(
    () => occurrencesInRange(allEvents, uid, role, { horizonDays: 60, viewerChildId: profile?.childId }),
    [allEvents, uid, role, profile?.childId],
  );
  const today = todayKey();
  // 💊 v5 — care events get dose cards, not generic rows (they stay findable
  // in the All-reminders month list for managing/editing).
  const todays = occurrences.filter((o) => o.dateKey === today && !o.event.care);
  const upcoming = occurrences.filter((o) => o.dateKey > today && !o.event.care).slice(0, 20);
  const careToday = useMemo(
    () => occurrences.filter((o) => o.dateKey === today && !!o.event.care).map((o) => o.event),
    [occurrences, today],
  );
  const applyDose = useCallback((eventId: string, entry: DoseEntry) => {
    setEvents((evs) => evs.map((e) => {
      if (e.id !== eventId) return e;
      const log = (e.doseLog || []).filter((d) => d.key !== entry.key);
      return { ...e, doseLog: [...log, entry] };
    }));
  }, []);

  const pending = useMemo(
    () => (role === 'parent' ? events.filter((e) => e.status === 'pending_parent') : []),
    [events, role],
  );

  // ✉️ 2.0 — who's celebrated on an auto-imported mirror (kid birthday /
  // family anniversary): in-family honoree, never emailed.
  const honoreeForAuto = useCallback((ev: ReminderEvent): GreetTo | undefined => {
    if (ev.greetTo) return ev.greetTo;
    if (ev.id.startsWith('auto:bday:')) {
      const cid = ev.id.slice('auto:bday:'.length);
      const kid = (children || []).find((c) => c.id === cid);
      return kid ? { childId: kid.id, name: kid.name, relationship: 'family', autoSend: false, ccParents: false } : undefined;
    }
    if (ev.id === 'auto:anniversary') return { name: family?.anniversaryName?.trim() || 'Mum & Dad', relationship: 'family', autoSend: false, ccParents: false };
    return undefined;
  }, [children, family?.anniversaryName]);
  const openStudio = useCallback((ev: ReminderEvent, dateKey: string) => {
    setStudio({ event: ev, dateKey, honoree: honoreeForAuto(ev) });
  }, [honoreeForAuto]);
  const pendingCards = useMemo(
    () => (role === 'parent' ? Object.values(cards).filter((c) => c.status === 'pending_parent') : []),
    [cards, role],
  );
  // Deep link: /reminders?card={eventId}_{dateKey} (nudges, My Day ✉️).
  useEffect(() => {
    if (deepLinkDone || loading || occurrences.length === 0) return;
    const want = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('card') : null;
    if (!want) { setDeepLinkDone(true); return; }
    const occ = occurrences.find((o) => cardIdFor(o.event.id, o.dateKey) === want);
    if (occ) openStudio(occ.event, occ.dateKey);
    setDeepLinkDone(true);
  }, [deepLinkDone, loading, occurrences, openStudio]);

  // "All reminders" — every event (manual + Auto birthdays) filed by the
  // month of its NEXT occurrence, so a saved reminder is always findable.
  // Past one-offs fall back to their own date's month.
  const searchQ = search.trim().toLowerCase();
  const monthGroups = useMemo(() => {
    const map = new Map<string, { ev: ReminderEvent; dateKey: string }[]>();
    for (const ev of allEvents) {
      if (searchQ && !ev.title.toLowerCase().includes(searchQ)) continue;
      const dateKey = nextOccurrenceOnOrAfter(ev, today, 800) || ev.date;
      const mk = dateKey.slice(0, 7);
      if (!map.has(mk)) map.set(mk, []);
      map.get(mk)!.push({ ev, dateKey });
    }
    return Array.from(map.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, items]) => ({
        key,
        label: monthLabel(key),
        items: items.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1)),
      }));
  }, [allEvents, searchQ, today]);

  // Open the soonest month once on first load; user toggles take over after.
  useEffect(() => {
    if (!monthsSeeded && monthGroups.length > 0) {
      setOpenMonths(new Set([monthGroups[0].key]));
      setMonthsSeeded(true);
    }
  }, [monthsSeeded, monthGroups]);

  const toggleMonth = (key: string) =>
    setOpenMonths((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  function openNew() { setForm(blankForm()); setError(''); setEditorOpen(true); }
  function openEdit(ev: ReminderEvent) {
    if (isAutoImported(ev)) return; // mirrors aren't editable
    setForm(formFromEvent(ev)); setError(''); setEditorOpen(true);
  }

  async function handleSave() {
    if (!user) return;
    if (!form.title.trim()) { setError(isCareType(form.type) ? 'Give the medicine/routine a name' : 'Give it a name'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) { setError('Pick a date'); return; }
    if (isCareType(form.type)) {
      if (form.careForKind === 'kid' && !form.careForChildId) { setError('Pick who it’s for'); return; }
      if (form.careDurMode === 'until' && !/^\d{4}-\d{2}-\d{2}$/.test(form.careUntil)) { setError('Pick the last day'); return; }
      if (form.careForKind === 'kid' && form.careGiverUids.length === 0) { setError('Pick who gives it'); return; }
    }
    setSaving(true); setError('');
    try {
      const token = await user.getIdToken();
      await saveReminder(token, {
        id: form.id,
        type: form.type,
        title: form.title.trim(),
        date: form.date,
        originDate: form.originDate || undefined,
        time: form.time || undefined,
        withWho: form.withWho.trim(),
        location: form.location.trim(),
        note: form.note.trim(),
        visibility: form.visibility,
        repeat: buildRepeat(form),
        leadDays: form.leadDays.length ? form.leadDays : [0],
        channels: { inApp: form.channelInApp, email: form.channelEmail },
        emailRecipients: form.channelEmail ? form.recipients : [],
        greetTo: form.greetTo || undefined,
        care: buildCare(form),
      });
      setEditorOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!user || !form.id) return;
    setSaving(true);
    try {
      const token = await user.getIdToken();
      await deleteReminder(token, form.id);
      setEditorOpen(false);
      await load();
    } catch {
      setError('Could not delete');
    } finally {
      setSaving(false);
    }
  }

  async function decide(ev: ReminderEvent, decision: 'approve' | 'decline') {
    if (!user) return;
    const token = await user.getIdToken();
    await decideReminder(token, ev.id, decision).catch(() => {});
    await load();
  }

  // Web-Fit (2026-08-23): wide tier. The wrapper keeps its own mobile
  // classes (no max-w-md scaffold here) and only gains the lg tier width.
  // Desktop: share/card requests + Gift Brain sit in the right rail
  // (railMobile="first" = exactly where they sat on mobile); Today /
  // Coming up / All reminders take the main column as dense rows.
  const rail = (
    <>
      {/* Parent approvals */}
      {pending.length > 0 && (
        <div className="rounded-kaya border border-dashed p-4 mb-5" style={{ borderColor: CAL, background: CAL_SOFT }}>
          <div className="text-xs font-extrabold uppercase tracking-wide mb-2" style={{ color: CAL_DK }}>
            👶 Share requests
          </div>
          {pending.map((ev) => (
            <div key={ev.id} className="flex items-center gap-2 py-1.5">
              <span className="text-lg">{typeMeta(ev.type).icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-kaya-chocolate truncate">{ev.title}</div>
                <div className="text-[11px] text-kaya-sand">{ev.ownerName || 'A kid'} wants to share with the family</div>
              </div>
              <button onClick={() => decide(ev, 'approve')} className="rounded-kaya-sm px-3 py-1.5 text-xs font-bold text-white" style={{ background: CAL }}>Approve</button>
              <button onClick={() => decide(ev, 'decline')} className="rounded-kaya-sm px-3 py-1.5 text-xs font-bold text-kaya-sand bg-white border border-kaya-warm-dark">Keep private</button>
            </div>
          ))}
        </div>
      )}

      {/* ✉️ 2.0 — kid/helper cards to outside people waiting for a parent nod. */}
      {pendingCards.length > 0 && (
        <div className="rounded-kaya border border-dashed p-4 mb-5" style={{ borderColor: CAL, background: CAL_SOFT }}>
          <div className="text-xs font-extrabold uppercase tracking-wide mb-2" style={{ color: CAL_DK }}>✉️ Card requests</div>
          {pendingCards.map((c) => {
            const ev = allEvents.find((e) => e.id === c.eventId);
            return (
              <div key={c.id} className="flex items-center gap-2 py-1.5">
                <span className="text-lg">{typeMeta(c.type).icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-kaya-chocolate truncate">Card for {c.honoree.name}</div>
                  <div className="text-[11px] text-kaya-sand truncate">{c.authorName} · “{c.oneLiner || '…'}” · {toDisplayDate(c.dateKey)}</div>
                </div>
                <button onClick={() => ev && openStudio(ev, c.dateKey)} disabled={!ev} className="rounded-kaya-sm px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50" style={{ background: CAL }}>Review</button>
              </div>
            );
          })}
        </div>
      )}

      {/* 🎁 Gift Brain — parents only (never spoil the surprise). */}
      {role === 'parent' && <GiftBrain occurrences={occurrences} children={children} />}
    </>
  );

  return (
    <div className={`px-4 lg:px-8 py-6 mx-auto pb-24 ${tab === 'catchup' ? 'max-w-5xl' : 'max-w-3xl'} ${PAGE_WIDTH_CLASS.wide}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-display font-extrabold text-kaya-chocolate flex items-center gap-2">
            <span>🔔</span> Reminders
          </h1>
          <p className="text-sm text-kaya-sand mt-1">
            Birthdays, anniversaries, appointments &amp; special days — private or shared with the family.
          </p>
        </div>
        <button
          onClick={openNew}
          className="shrink-0 rounded-kaya px-4 py-2.5 text-white font-bold text-sm shadow-sm"
          style={{ background: CAL }}
        >
          + New
        </button>
      </div>

      {/* R2-2 · Tabs — reminders material vs the Catch-Up Board. */}
      {role === 'parent' && (
        <div className="flex gap-1.5 bg-kaya-warm rounded-full p-1 w-fit mb-5">
          {([['reminders', '🔔 Reminders'], ['catchup', '⏰ Catch-Up Board']] as const).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={`px-4 py-2 rounded-full text-[12.5px] font-black transition-colors ${
                tab === key ? 'bg-kaya-chocolate text-kaya-gold-light' : 'text-kaya-sand hover:text-kaya-chocolate'
              }`}>{label}</button>
          ))}
        </div>
      )}

      {tab === 'catchup' && role === 'parent' ? (
        <CatchUpBoard />
      ) : (
      <>
      <PageSplit rail={rail} railMobile="first" railWidth={360} sticky={false}>
      {loading ? (
        <div className="text-center text-kaya-sand py-16 text-sm">Loading your reminders…</div>
      ) : (
        <>
          {/* 💊 v5 — today's dose cards (tickable), above the classic rows. */}
          {careToday.length > 0 && (
            <Section label="💊 Care today">
              <CareDoseCards events={careToday} onDose={applyDose} />
            </Section>
          )}

          {/* Today */}
          {todays.length > 0 && (
            <Section label="Today">
              {todays.map((o) => <Row key={`${o.event.id}-${o.dateKey}`} o={o} dense onTap={() => openEdit(o.event)} card={cards[cardIdFor(o.event.id, o.dateKey)] || null} onCard={cardEligible({ type: o.event.type, greetTo: honoreeForAuto(o.event) }) ? () => openStudio(o.event, o.dateKey) : undefined} />)}
            </Section>
          )}

          {/* Coming up */}
          <Section label="Coming up">
            {upcoming.length === 0 && todays.length === 0 ? (
              <EmptyState onNew={openNew} />
            ) : upcoming.length === 0 ? (
              <div className="text-sm text-kaya-sand px-1 py-2">Nothing else on the horizon. 🌤️</div>
            ) : (
              upcoming.map((o) => <Row key={`${o.event.id}-${o.dateKey}`} o={o} dense onTap={() => openEdit(o.event)} card={cards[cardIdFor(o.event.id, o.dateKey)] || null} onCard={cardEligible({ type: o.event.type, greetTo: honoreeForAuto(o.event) }) ? () => openStudio(o.event, o.dateKey) : undefined} />)
            )}
          </Section>

          {/* All reminders — the complete list, grouped by month + collapsible
              (approved 2026-06-14), so a saved reminder is never out of sight.
              Tap a row to edit/delete (same editor); Auto birthdays are read-only. */}
          {allEvents.length > 0 && (
            <div className="mb-5">
              <div className="flex items-center justify-between gap-2 mb-2 px-1">
                <div className="text-[11px] font-extrabold uppercase tracking-wider text-kaya-sand">📋 All reminders</div>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="🔎 Search…"
                  className="text-xs rounded-kaya-sm border border-kaya-warm-dark bg-white px-2.5 py-1.5 w-32 focus:w-44 transition-all text-kaya-chocolate"
                />
              </div>
              {monthGroups.length === 0 ? (
                <div className="text-sm text-kaya-sand px-1 py-2">No reminders match “{search}”.</div>
              ) : (
                <div className="rounded-kaya border border-kaya-warm-dark bg-white overflow-hidden">
                  {monthGroups.map((g) => {
                    const open = !!searchQ || openMonths.has(g.key);
                    return (
                      <div key={g.key} className="border-b border-kaya-warm-dark last:border-b-0">
                        <button
                          onClick={() => toggleMonth(g.key)}
                          className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left"
                          style={open ? { background: CAL_SOFT } : undefined}
                          aria-expanded={open}
                        >
                          <span className="text-[11px] w-3.5 shrink-0" style={{ color: CAL_DK, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                          <span className="text-[13.5px] font-extrabold text-kaya-chocolate">{g.label}</span>
                          <span
                            className="ml-auto text-[10.5px] font-extrabold rounded-full px-2 py-0.5 border"
                            style={open ? { background: CAL, color: '#fff', borderColor: CAL } : { color: CAL_DK, borderColor: CAL }}
                          >
                            {g.items.length}
                          </span>
                        </button>
                        {open && (
                          <div className="px-2.5 pb-2.5 space-y-2">
                            {g.items.map(({ ev, dateKey }) => (
                              <Row
                                key={`${ev.id}-${dateKey}`}
                                o={{ event: ev, dateKey, daysAway: diffDaysKey(today, dateKey) }}
                                onTap={() => openEdit(ev)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}
      </PageSplit>

      {/* 📮 Time Capsule — everyone can seal a future message. Sits BELOW
          the reminders material now so Coming Up stays on top (R2-2). */}
      {profile?.familyId && <TimeCapsule members={members} ownUid={uid} familyId={profile.familyId} />}
      </>
      )}

      {studio && (
        <GreetingCardStudio
          target={{ ...studio, event: allEvents.find((e) => e.id === studio.event.id) || studio.event, honoree: honoreeForAuto(allEvents.find((e) => e.id === studio.event.id) || studio.event) }}
          initial={cards[cardIdFor(studio.event.id, studio.dateKey)] || null}
          onClose={() => setStudio(null)}
          onChanged={(c) => { if (c) setCards((m) => ({ ...m, [c.id]: c })); }}
        />
      )}

      {editorOpen && (
        <Editor
          form={form}
          setForm={setForm}
          members={members}
          groups={family?.emailGroups || []}
          ownUid={uid}
          saving={saving}
          error={error}
          onClose={() => setEditorOpen(false)}
          onSave={handleSave}
          onDelete={form.id ? handleDelete : undefined}
          kids={children}
          contacts={family?.contacts || []}
          familyId={profile?.familyId || ''}
          viewerRole={role}
          careEvent={form.id ? events.find((e) => e.id === form.id) : undefined}
        />
      )}
    </div>
  );
}

// ── List bits ──────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-[11px] font-extrabold uppercase tracking-wider text-kaya-sand mb-2 px-1">{label}</div>
      <DataRows tone="kaya">{children}</DataRows>
    </div>
  );
}

function Row({ o, onTap, card, onCard, dense }: {
  o: ReturnType<typeof occurrencesInRange>[number];
  onTap: () => void;
  /** ✉️ 2.0 — the greeting card for this occurrence (if any) + opener. */
  card?: GreetingCard | null;
  onCard?: () => void;
  /** Web-Fit: inside a <DataRows> Section — dense divided row at lg (mobile unchanged). */
  dense?: boolean;
}) {
  const ev = o.event;
  const meta = typeMeta(ev.type);
  // Milestone years swap the sub-flourish for the approved "a milestone
  // year ✨" line — the badge pill already carries the count.
  const milestone = anniversaryMilestone(ev, o.dateKey);
  const nth = milestone ? 'a milestone year ✨' : nthSubLabel(ev, o.dateKey);
  // 💊 v5 — care rows speak dose · ×N/day · who · day-N instead of repeat.
  const careN = ev.care ? careDayNumber(ev, o.dateKey) : null;
  const careT = ev.care ? careTotalDays(ev) : null;
  const sub = ev.care
    ? [
        ev.care.dose,
        `×${ev.care.slots.length}/day`,
        ev.care.forKind === 'self' ? '🔒 my own' : ev.care.forName,
        careN ? `day ${careN}${careT ? ` of ${careT}` : ''}` : 'ongoing',
      ].filter(Boolean).join(' · ')
    : [
        [ev.withWho && `with ${ev.withWho}`, ev.location].filter(Boolean).join(' · ') || describeRepeat(ev.repeat),
        nth,
      ].filter(Boolean).join(' · ');
  const auto = isAutoImported(ev);
  const cardState = card?.status === 'sent' || card?.status === 'belated' ? 'sent' : card?.status === 'ready' ? 'ready' : card?.status === 'pending_parent' ? 'pending' : card ? 'draft' : 'none';
  const cardLabel = cardState === 'sent' ? '✅' : cardState === 'ready' ? '✉️✓' : cardState === 'pending' ? '⏳' : cardState === 'draft' ? '✏️' : '✉️';
  const cardTitle = cardState === 'sent' ? 'Card sent' : cardState === 'ready' ? 'Card ready' : cardState === 'pending' ? 'Card awaiting a parent' : cardState === 'draft' ? 'Card drafted' : 'Make a greeting card';
  return (
    <div className={`w-full flex items-center gap-2 bg-white rounded-kaya border border-kaya-warm-dark px-3 py-2.5 hover:border-[#5B6CC8] ${dense ? `lg:px-4 lg:py-3 ${DATA_ROW} ${DATA_ROW_HOVER}` : ''}`}>
      <button onClick={onTap} className="flex-1 min-w-0 text-left flex items-center gap-3">
        <span className="w-9 h-9 rounded-kaya-sm flex items-center justify-center text-lg shrink-0" style={{ background: CAL_SOFT }}>{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-kaya-chocolate truncate flex items-center gap-1.5">
            {displayTitle(ev, o.dateKey)}
            {milestone && (
              <span className="text-[8.5px] font-extrabold rounded px-1.5 py-0.5" style={milestoneStyle(milestone.label)}>
                {milestone.emoji} {milestone.label.toUpperCase()}
              </span>
            )}
            {ev.visibility === 'shared'
              ? <span className="text-[8.5px] font-extrabold rounded px-1.5 py-0.5" style={{ background: '#E1F3E8', color: '#3FAF6C' }}>FAMILY</span>
              : <span className="text-[8.5px] font-extrabold rounded px-1.5 py-0.5" style={{ background: '#EFEAFB', color: '#6B4FC0' }}>PRIVATE</span>}
            {auto && <span className="text-[8.5px] font-extrabold rounded px-1.5 py-0.5 text-kaya-sand bg-kaya-warm">AUTO</span>}
          </div>
          <div className="text-[11px] text-kaya-sand truncate">
            {sub}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs font-extrabold" style={{ color: CAL_DK }}>{relativeDays(o.daysAway, o.dateKey)}</div>
          {ev.time && <div className="text-[11px] text-kaya-sand">{formatTime(ev.time)}</div>}
        </div>
      </button>
      {onCard && (
        <button onClick={onCard} title={cardTitle} aria-label={cardTitle}
          className="shrink-0 w-9 h-9 rounded-kaya-sm border text-[13px] font-black flex items-center justify-center"
          style={cardState === 'none' ? { borderColor: '#E8DEC9', background: '#fff', color: CAL_DK } : { borderColor: CAL, background: CAL_SOFT, color: CAL_DK }}>
          {cardLabel}
        </button>
      )}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="text-center py-12">
      <div className="text-4xl mb-2">🔔</div>
      <div className="font-bold text-kaya-chocolate">No reminders yet</div>
      <div className="text-sm text-kaya-sand mt-1 mb-4">Never miss a birthday, appointment or special day.</div>
      <button onClick={onNew} className="rounded-kaya px-5 py-2.5 text-white font-bold text-sm" style={{ background: CAL }}>+ Add your first reminder</button>
    </div>
  );
}

// ── Editor ───────────────────────────────────────────────────────────────

function Editor({
  form, setForm, members, groups, ownUid, saving, error, onClose, onSave, onDelete, kids, contacts, familyId, viewerRole, careEvent,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  members: UserProfile[];
  groups: EmailGroup[];
  kids: Child[];
  contacts: FamilyContact[];
  familyId: string;
  viewerRole?: string;
  /** 💊 v5 — the stored event being edited (for the adherence grid). */
  careEvent?: ReminderEvent;
  ownUid: string;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
}) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const toggleArr = <T,>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  // ── 💊 v5 Care — section toggle + medicine-photo upload + AI label read ─
  const { user: authUser } = useAuth();
  const isCare = isCareType(form.type);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoErr, setPhotoErr] = useState('');
  const [aiReading, setAiReading] = useState(false);
  const [aiRead, setAiRead] = useState<string>('');
  async function pickCarePhoto(file: File | null) {
    if (!file || !familyId || uploadingPhoto) return;
    setUploadingPhoto(true); setPhotoErr('');
    try {
      const blob = await compressImageBlob(file, { maxDim: 900, quality: 0.85 });
      // Rides the existing messages storage rule (like Card Studio) — no
      // storage.rules deploy.
      const path = `families/${familyId}/messages/care/${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.jpg`;
      const r = storageRef(storage, path);
      await safeUploadBytes(r, blob, { contentType: 'image/jpeg' });
      set('carePhotoUrl', await getDownloadURL(r));
      void readLabel(blob);
    } catch (e) {
      setPhotoErr(e instanceof Error ? e.message : 'Could not upload the photo — try again.');
    }
    setUploadingPhoto(false);
  }
  /** ✨ Transcription-only label read — pre-fills EMPTY fields only; the
   *  parent confirms everything (approved Logic close #5). */
  async function readLabel(blob: Blob) {
    if (form.type !== 'medicine' || aiReading) return;
    setAiReading(true); setAiRead('');
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      const token = await authUser?.getIdToken();
      if (!token || !b64) { setAiReading(false); return; }
      const res = await fetch('/api/reminders/care-label', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ imageBase64: b64, mediaType: 'image/jpeg' }),
      });
      const j = await res.json().catch(() => ({ found: false }));
      if (j?.found && j.name) {
        const fullName = [j.name, j.strength].filter(Boolean).join(' ');
        setForm((f) => ({
          ...f,
          ...(f.title.trim() ? {} : { title: fullName }),
          careLabelName: fullName,
          ...(f.carePackCount ? {} : (j.packCount ? { carePackCount: j.packCount } : {})),
          ...(j.withFood ? { careWithFood: true } : {}),
          ...(f.careDose.trim() ? {} : (j.form && j.form !== 'other' && j.form !== '' ? { careDose: `1 ${j.form}` } : {})),
        }));
        setAiRead([fullName, j.packCount ? `${j.packCount} in the pack` : '', j.instructions].filter(Boolean).join(' · '));
      } else {
        setAiRead('couldn’t read this label — fill the fields yourself, nothing is blocked.');
      }
    } catch { setAiRead('couldn’t read this label — fill the fields yourself, nothing is blocked.'); }
    setAiReading(false);
  }

  // ── v4 Nth Birthday/Anniversary — origin date + live ✨ preview ─────────
  const showOrigin = form.type === 'birthday' || form.type === 'anniversary';
  // Picking a past-year Date = "you entered the true original date" → pre-fill
  // the origin (approved v4 design). Never overwrites one already set.
  function setDate(v: string) {
    setForm((f) => {
      const canInfer = (f.type === 'birthday' || f.type === 'anniversary')
        && !f.originDate && /^\d{4}-\d{2}-\d{2}$/.test(v) && v.slice(0, 4) < todayKey().slice(0, 4);
      return { ...f, date: v, ...(canInfer ? { originDate: v } : {}) };
    });
  }
  const previewEvent: ReminderEvent | null = showOrigin && form.originDate && form.title.trim() ? {
    id: 'preview', familyId: '', ownerUid: '',
    type: form.type, title: form.title.trim(), date: form.date, originDate: form.originDate,
    visibility: form.visibility, repeat: buildRepeat(form), leadDays: [0],
    channels: { inApp: true, email: false }, emailRecipients: [], status: 'active',
  } : null;
  const previewOcc = previewEvent ? (nextOccurrenceOnOrAfter(previewEvent, todayKey(), 800) || form.date) : '';
  const previewTitle = previewEvent && nthFor(previewEvent, previewOcc) ? displayTitle(previewEvent, previewOcc) : '';

  // Recipient checklist state derived from members + the saved external list.
  const memberEmails = new Set(members.map((m) => (m.email || '').toLowerCase()));
  const externals = form.recipients.filter((r) => r.kind === 'external' || !memberEmails.has(r.email.toLowerCase()));
  const isMemberChecked = (email: string) => form.recipients.some((r) => r.email.toLowerCase() === email.toLowerCase());

  function toggleMember(m: UserProfile) {
    const email = (m.email || '').toLowerCase();
    if (!email) return;
    setForm((f) => {
      const has = f.recipients.some((r) => r.email.toLowerCase() === email);
      if (has) return { ...f, recipients: f.recipients.filter((r) => r.email.toLowerCase() !== email) };
      return { ...f, recipients: [...f.recipients, { kind: 'member', email, uid: m.uid, name: m.displayName }] };
    });
  }

  // ── v4 Email-group chips — truthful tri-state, additive toggles. ───────
  // full → tap clears ITS members only; empty/partial → tap selects all its
  // members. Never touches ticks that belong to other groups or singles.
  const groupInfos = groups
    .map((g) => {
      const recips = resolveGroupRecipients(g, members);
      const selected = recips.filter((r) => form.recipients.some((x) => x.email.toLowerCase() === r.email)).length;
      const state: 'empty' | 'partial' | 'full' = !recips.length || selected === 0 ? 'empty'
        : selected === recips.length ? 'full' : 'partial';
      return { g, recips, selected, state };
    })
    .filter((info) => info.recips.length > 0);

  function toggleGroup(info: { recips: ReminderRecipient[]; state: 'empty' | 'partial' | 'full' }) {
    if (info.state === 'full') {
      const emails = new Set(info.recips.map((r) => r.email));
      setForm((f) => ({ ...f, recipients: f.recipients.filter((r) => !emails.has(r.email.toLowerCase())) }));
    } else {
      setForm((f) => {
        const have = new Set(f.recipients.map((r) => r.email.toLowerCase()));
        const add = info.recips.filter((r) => !have.has(r.email));
        return { ...f, recipients: [...f.recipients, ...add] };
      });
    }
  }

  const [extInput, setExtInput] = useState('');
  const [showPeople, setShowPeople] = useState(false);
  // Manual lead time — any number of days beyond the presets.
  const [customLead, setCustomLead] = useState('');
  function addCustomLead() {
    const n = Math.round(Number(customLead));
    if (!Number.isFinite(n) || n < 1 || n > 60) return;
    setForm((f) => (f.leadDays.includes(n) ? f : { ...f, leadDays: [...f.leadDays, n] }));
    setCustomLead('');
  }
  function addExternal() {
    const email = extInput.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
    setForm((f) => (f.recipients.some((r) => r.email.toLowerCase() === email)
      ? f
      : { ...f, recipients: [...f.recipients, { kind: 'external', email }] }));
    setExtInput('');
  }
  function removeRecipient(email: string) {
    setForm((f) => ({ ...f, recipients: f.recipients.filter((r) => r.email.toLowerCase() !== email.toLowerCase()) }));
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
      <div
        className="bg-kaya-cream w-full sm:max-w-xl lg:max-w-2xl rounded-t-kaya-lg sm:rounded-kaya-lg max-h-[92vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-kaya-cream border-b border-kaya-warm-dark px-4 py-3 flex items-center justify-between z-10">
          <div className="font-display font-extrabold text-kaya-chocolate">{form.id ? 'Edit reminder' : 'New reminder'}</div>
          <button onClick={onClose} className="text-kaya-sand text-xl leading-none px-2">✕</button>
        </div>

        <div className="p-4 space-y-5">
          {/* Type — 💊/🔁 Care chips are parent-only (approved v5). */}
          <Field label="Type">
            <div className="flex flex-wrap gap-2">
              {REMINDER_TYPES.filter((t) => viewerRole === 'parent' || !isCareType(t.id)).map((t) => (
                <Chip key={t.id} on={form.type === t.id} onClick={() => setForm((f) => ({
                  ...f, type: t.id,
                  ...((t.id === 'birthday' || t.id === 'anniversary') && f.freq === 'none' ? { freq: 'yearly' as RepeatFreq } : {}),
                  ...(isCareType(t.id) ? { freq: 'daily' as RepeatFreq } : {}),
                }))}>
                  {t.icon} {t.label}
                </Chip>
              ))}
            </div>
          </Field>

          {/* Title */}
          <Field label={isCare ? (form.type === 'medicine' ? 'Medicine name' : 'Routine name') : "What's it for?"}>
            <input
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder={isCare
                ? (form.type === 'medicine' ? 'e.g. Amoxicillin 250mg' : 'e.g. Afternoon nap · Physio stretches')
                : "e.g. Nathan's dentist · Grandma's birthday"}
              className="w-full rounded-kaya border border-kaya-warm-dark bg-white px-3 py-2.5 text-sm font-medium text-kaya-chocolate"
            />
          </Field>

          {/* Date + time (care schedules own their times via slots) */}
          <div className={isCare ? '' : 'grid grid-cols-2 gap-3'}>
            <Field label={isCare ? 'Start date' : 'Date'}>
              <input type="date" value={form.date} onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-kaya border border-kaya-warm-dark bg-white px-3 py-2.5 text-sm font-medium text-kaya-chocolate" />
              {form.date && <div className="text-[11px] text-kaya-sand mt-1">{dayOfWeek(form.date)} · {toDisplayDate(form.date)}</div>}
            </Field>
            {!isCare && (
              <Field label="Time (optional)">
                <input type="time" value={form.time} onChange={(e) => set('time', e.target.value)}
                  className="w-full rounded-kaya border border-kaya-warm-dark bg-white px-3 py-2.5 text-sm font-medium text-kaya-chocolate" />
              </Field>
            )}
          </div>

          {/* ── 💊 v5 Care — photo · dose · slots · duration · people ── */}
          {isCare && (
            <>
              {form.type === 'medicine' && (
                <Field label="📷 Photo of the medicine (optional)">
                  <div className="flex items-center gap-3">
                    <label className="w-[74px] h-[74px] rounded-kaya border-2 border-dashed flex items-center justify-center text-2xl cursor-pointer overflow-hidden shrink-0"
                      style={{ borderColor: CARE, background: form.carePhotoUrl ? '#fff' : CARE_SOFT }}>
                      {form.carePhotoUrl
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={form.carePhotoUrl} alt="Medicine" className="w-full h-full object-cover" />
                        : uploadingPhoto ? '⏳' : '💊'}
                      <input type="file" accept="image/*" capture="environment" className="hidden"
                        onChange={(e) => pickCarePhoto(e.target.files?.[0] || null)} />
                    </label>
                    <div className="text-[11px] text-kaya-sand">
                      Snap the box or bottle — the photo rides on every dose card so the right medicine is never in doubt.
                      {form.carePhotoUrl && <button onClick={() => set('carePhotoUrl', '')} className="ml-1.5 font-bold text-red-500">✕ Remove</button>}
                    </div>
                  </div>
                  {photoErr && <div className="text-[11px] text-red-600 mt-1">{photoErr}</div>}
                  {(aiReading || aiRead) && (
                    <div className="mt-2 rounded-kaya-sm border border-dashed px-3 py-2 text-[12px]"
                      style={{ borderColor: CARE, background: CARE_SOFT, color: '#1F4F47' }}>
                      {aiReading
                        ? '✨ Kaya is reading the label…'
                        : <>✨ <b>Kaya read:</b> {aiRead} — <b>please check every detail.</b> Always follow your doctor’s instructions.</>}
                    </div>
                  )}
                </Field>
              )}

              <div className="grid grid-cols-2 gap-3">
                <Field label={form.type === 'medicine' ? 'Dose' : 'What exactly?'}>
                  <input value={form.careDose} onChange={(e) => set('careDose', e.target.value)}
                    placeholder={form.type === 'medicine' ? 'e.g. 1 tablet · 10ml syrup' : 'e.g. 20 minutes'}
                    className="w-full rounded-kaya border border-kaya-warm-dark bg-white px-3 py-2.5 text-sm font-medium text-kaya-chocolate" />
                </Field>
                <Field label="Times a day">
                  <div className="flex gap-1.5">
                    {[1, 2, 3, 4].map((n) => (
                      <button key={n} onClick={() => set('careSlots', suggestSlots(n))}
                        className="w-10 h-10 rounded-kaya-sm text-sm font-extrabold border transition"
                        style={form.careSlots.length === n
                          ? { background: CARE, borderColor: CARE, color: '#fff' }
                          : { background: '#fff', borderColor: '#E8DEC9', color: '#5C6975' }}>
                        ×{n}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>

              <Field label="At these times">
                <div className="flex flex-wrap gap-2">
                  {form.careSlots.map((s, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5"
                      style={{ borderColor: CARE, background: '#fff' }}>
                      <span className="text-sm">{s.icon || slotIcon(s.time)}</span>
                      <input type="time" value={s.time}
                        onChange={(e) => {
                          const t = e.target.value;
                          if (!t) return;
                          set('careSlots', form.careSlots.map((x, j) => (j === i ? { time: t, icon: slotIcon(t) } : x)));
                        }}
                        className="text-[13px] font-extrabold bg-transparent" style={{ color: CARE }} />
                    </span>
                  ))}
                </div>
                <div className="text-[11px] text-kaya-sand mt-1.5">Kaya spreads them evenly — tap any time to change it. Local family time.</div>
              </Field>

              <Field label="For how long">
                <div className="flex flex-wrap gap-2 items-center">
                  <Chip on={form.careDurMode === 'days'} onClick={() => set('careDurMode', 'days')}>For N days</Chip>
                  <Chip on={form.careDurMode === 'until'} onClick={() => set('careDurMode', 'until')}>Until a date</Chip>
                  <Chip on={form.careDurMode === 'ongoing'} onClick={() => set('careDurMode', 'ongoing')}>Ongoing</Chip>
                  {form.careDurMode === 'days' && (
                    <input type="number" min={1} max={365} value={form.careDays}
                      onChange={(e) => set('careDays', Math.max(1, Math.min(365, parseInt(e.target.value, 10) || 1)))}
                      className="w-16 rounded-kaya-sm border border-kaya-warm-dark bg-white px-2 py-1.5 text-sm text-center font-bold" />
                  )}
                  {form.careDurMode === 'until' && (
                    <input type="date" value={form.careUntil} onChange={(e) => set('careUntil', e.target.value)}
                      className="rounded-kaya-sm border border-kaya-warm-dark bg-white px-2 py-1.5 text-sm" />
                  )}
                </div>
                <div className="text-[11px] text-kaya-sand mt-1.5">Courses end themselves — no zombie doses after the last day.</div>
              </Field>

              <Field label="Who is it for?">
                <div className="flex flex-wrap gap-2">
                  {kids.map((k) => (
                    <Chip key={k.id} on={form.careForKind === 'kid' && form.careForChildId === k.id}
                      onClick={() => setForm((f) => ({ ...f, careForKind: 'kid', careForChildId: k.id, careForName: k.name }))}>
                      🧒 {k.name}
                    </Chip>
                  ))}
                  <Chip on={form.careForKind === 'self'}
                    onClick={() => setForm((f) => ({ ...f, careForKind: 'self', careForChildId: '', careForName: '', visibility: 'private' }))}>
                    🙋 Me
                  </Chip>
                </div>
                {form.careForKind === 'self' && (
                  <div className="mt-2 rounded-kaya-sm px-3 py-2 text-[11.5px] font-bold" style={{ background: '#EFEAFB', color: '#6B4FC0' }}>
                    🔒 Your own care stays private — no helper, no kids. Flip below to share with your co-parent.
                  </div>
                )}
              </Field>

              {form.careForKind === 'self' ? (
                <Field label="Share with your co-parent?">
                  <div className="flex gap-2">
                    <Chip on={form.visibility === 'private'} onClick={() => set('visibility', 'private')}>🔒 Just me</Chip>
                    <Chip on={form.visibility === 'shared'} onClick={() => set('visibility', 'shared')}>👫 Co-parent too</Chip>
                  </div>
                </Field>
              ) : (
                <>
                  <Field label="Who gives it? (the ✓ that counts)">
                    <div className="flex flex-wrap gap-2">
                      {members.filter((m) => m.role !== 'kid').map((m) => (
                        <Chip key={m.uid} on={form.careGiverUids.includes(m.uid)}
                          onClick={() => set('careGiverUids', toggleArr(form.careGiverUids, m.uid))}>
                          {roleEmoji(m.role)} {m.displayName}{m.uid === ownUid ? ' (me)' : ''}
                        </Chip>
                      ))}
                    </div>
                    <div className="text-[11px] text-kaya-sand mt-1.5">Dose cards land in their My Day. More than one is fine — first ✓ wins.</div>
                  </Field>

                  <Field label="Parents are watching 👀">
                    <div className="space-y-2">
                      <ChannelRow on={form.careWatchInApp} onToggle={() => set('careWatchInApp', !form.careWatchInApp)} label="🔔 In-app: every ✓ and ❌" />
                      <ChannelRow on={form.careWatchSummary} onToggle={() => set('careWatchSummary', !form.careWatchSummary)} label="📧 Email: evening summary" />
                      <ChannelRow on={form.careWatchMissed} onToggle={() => set('careWatchMissed', !form.careWatchMissed)} label="🚨 Email instantly if a dose is missed" />
                    </div>
                  </Field>
                </>
              )}

              {form.type === 'medicine' && (
                <div className="flex items-center gap-2">
                  <ChannelRow on={form.careWithFood} onToggle={() => set('careWithFood', !form.careWithFood)} label="🍽 Take with food" />
                </div>
              )}

              {form.type === 'medicine' && (
                <div className="text-[11px] text-kaya-sand italic">Always follow your doctor’s instructions.</div>
              )}

              {/* 👀 Adherence at a glance — dot grid over the last days. */}
              {form.id && careEvent?.care && (
                <>
                  <AdherenceGrid ev={careEvent} />
                  <CareTools ev={careEvent} />
                </>
              )}
            </>
          )}

          {/* v4 — actual event date (only 🎂/💍): powers "Nth Birthday". */}
          {showOrigin && (
            <Field label="Actual date of the event (optional)">
              <input type="date" value={form.originDate} onChange={(e) => {
                const v = e.target.value;
                // Correcting the origin moves the reminder to that month/day (next occurrence) + keeps it yearly.
                setForm((f) => ({ ...f, originDate: v, ...(/^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: nextAnniversaryOf(v), freq: f.freq === 'none' ? 'yearly' : f.freq } : {}) }));
              }}
                className="w-full rounded-kaya border border-kaya-warm-dark bg-white px-3 py-2.5 text-sm font-medium text-kaya-chocolate" />
              <div className="text-[11px] text-kaya-sand mt-1">
                {form.type === 'birthday' ? 'The day they were born.' : 'The wedding day (or when it all began).'} Kaya uses the year to count.
              </div>
              {previewTitle && (
                <div className="mt-2 rounded-kaya-sm border border-dashed px-3 py-2 text-[12.5px] font-bold"
                  style={{ background: '#F5E9D2', borderColor: '#E8C989', color: '#3D2E08' }}>
                  ✨ Will read: {previewTitle} {form.type === 'birthday' ? '🎂' : '💍'}
                </div>
              )}
            </Field>
          )}

          {/* ✉️ 2.0 — honoree (greeting card target). 🎂/💍 always; 🎉 opt-in. */}
          {(form.type === 'birthday' || form.type === 'anniversary' || form.type === 'event') && (
            <Field label={form.type === 'event' ? 'Celebrating someone? (greeting card)' : 'Who’s being celebrated? (greeting card)'}>
              <HonoreePicker value={form.greetTo} onChange={(g) => set('greetTo', g)} type={form.type}
                members={members} kids={kids} contacts={contacts} familyId={familyId} ownUid={ownUid} />
              <div className="text-[11px] text-kaya-sand mt-1.5">Kaya drafts a card 3 days before; the honoree never gets a plain “reminder” email. Outside people come from the 📒 People Book (Settings → ✉️ Greeting cards).</div>
            </Field>
          )}

          {/* With / Where — care events carry dose/giver instead. */}
          {!isCare && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="With (optional)">
              <input value={form.withWho} onChange={(e) => set('withWho', e.target.value)} placeholder="e.g. Mum"
                className="w-full rounded-kaya border border-kaya-warm-dark bg-white px-3 py-2.5 text-sm font-medium text-kaya-chocolate" />
            </Field>
            <Field label="Where (optional)">
              <input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="e.g. Dr. Mvungi, Masaki"
                className="w-full rounded-kaya border border-kaya-warm-dark bg-white px-3 py-2.5 text-sm font-medium text-kaya-chocolate" />
            </Field>
          </div>
          )}

          {/* Note */}
          <Field label="Note (optional)">
            <input value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="e.g. Bring the referral form"
              className="w-full rounded-kaya border border-kaya-warm-dark bg-white px-3 py-2.5 text-sm font-medium text-kaya-chocolate" />
          </Field>

          {/* Visibility — care routes by who-it's-for (v5); hidden there. */}
          {!isCare && (
          <Field label="Who can see it?">
            <div className="flex gap-2">
              <Chip on={form.visibility === 'private'} onClick={() => set('visibility', 'private')}>🔒 Private</Chip>
              <Chip on={form.visibility === 'shared'} onClick={() => set('visibility', 'shared')}>👨‍👩‍👧 Shared</Chip>
            </div>
          </Field>
          )}

          {/* Repeats · Remind-me · Notify-by · Email-to — the classic rail.
              Care events derive all of this (daily slots + watch prefs). */}
          {!isCare && (<>
          {/* Repeats */}
          <Field label="Repeats">
            <div className="flex flex-wrap gap-2">
              {(['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom'] as RepeatFreq[]).map((fq) => (
                <Chip key={fq} on={form.freq === fq} onClick={() => set('freq', fq)}>
                  {fq === 'none' ? "Doesn't" : fq === 'custom' ? 'Custom ✦' : fq[0].toUpperCase() + fq.slice(1)}
                </Chip>
              ))}
            </div>

            {form.freq === 'weekly' && (
              <div className="mt-3">
                <div className="flex gap-1.5">
                  {WEEKDAY_LABELS.map((lab, i) => (
                    <button key={i} onClick={() => set('weekdays', toggleArr(form.weekdays, i))}
                      className="w-9 h-9 rounded-full text-xs font-extrabold border transition"
                      style={form.weekdays.includes(i)
                        ? { background: CAL, borderColor: CAL_DK, color: '#fff' }
                        : { background: '#fff', borderColor: '#E8DEC9', color: '#5C6975' }}>
                      {lab}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {form.freq === 'monthly' && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {MONTH_DAY_CHIPS.map((d) => (
                  <button key={String(d)} onClick={() => set('monthDays', toggleArr(form.monthDays, d))}
                    className="min-w-[34px] h-8 px-2 rounded-kaya-sm text-xs font-bold border transition"
                    style={form.monthDays.includes(d)
                      ? { background: CAL, borderColor: CAL_DK, color: '#fff' }
                      : { background: '#fff', borderColor: '#E8DEC9', color: '#5C6975' }}>
                    {d === 'last' ? 'Last' : d}
                  </button>
                ))}
              </div>
            )}

            {form.freq === 'custom' && (
              <div className="mt-3">
                <div className="flex items-center gap-2 bg-white border border-kaya-warm-dark rounded-kaya px-3 py-2 text-sm font-bold text-kaya-chocolate">
                  Remind me
                  <input type="number" min={1} max={30} value={form.customCount}
                    onChange={(e) => set('customCount', Math.max(1, Math.min(30, parseInt(e.target.value, 10) || 1)))}
                    className="w-14 text-center rounded-kaya-sm px-1 py-1 font-extrabold" style={{ background: CAL_SOFT, color: CAL_DK }} />
                  ×  per
                  <select value={form.customPer} onChange={(e) => set('customPer', e.target.value as 'week' | 'month')}
                    className="rounded-kaya-sm px-2 py-1 font-extrabold" style={{ background: CAL_SOFT, color: CAL_DK }}>
                    <option value="week">week</option>
                    <option value="month">month</option>
                  </select>
                </div>
                <div className="text-[11px] mt-2 rounded-kaya-sm px-2.5 py-1.5 inline-block font-bold" style={{ background: CAL_SOFT, color: CAL_DK }}>
                  ↪ {form.customCount}× a {form.customPer} — Kaya spreads them, no fixed day
                </div>
              </div>
            )}

            {form.freq !== 'none' && (
              <div className="mt-3">
                <div className="text-[10.5px] font-extrabold uppercase tracking-wide text-kaya-sand mb-1.5">Ends</div>
                <div className="flex flex-wrap gap-2 items-center">
                  <Chip on={form.endMode === 'never'} onClick={() => set('endMode', 'never')}>Never</Chip>
                  <Chip on={form.endMode === 'on'} onClick={() => set('endMode', 'on')}>On a date</Chip>
                  <Chip on={form.endMode === 'after'} onClick={() => set('endMode', 'after')}>After N times</Chip>
                  {form.endMode === 'on' && (
                    <input type="date" value={form.endOn} onChange={(e) => set('endOn', e.target.value)}
                      className="rounded-kaya-sm border border-kaya-warm-dark bg-white px-2 py-1.5 text-sm" />
                  )}
                  {form.endMode === 'after' && (
                    <input type="number" min={1} value={form.endAfter} onChange={(e) => set('endAfter', Math.max(1, parseInt(e.target.value, 10) || 1))}
                      className="w-16 rounded-kaya-sm border border-kaya-warm-dark bg-white px-2 py-1.5 text-sm text-center" />
                  )}
                </div>
              </div>
            )}
          </Field>

          {/* Remind me — lead times (presets + any custom number of days) */}
          <Field label="Remind me">
            <div className="flex flex-wrap gap-2">
              {LEAD_PRESETS.map((p) => (
                <Chip key={p.days} on={form.leadDays.includes(p.days)} onClick={() => set('leadDays', toggleArr(form.leadDays, p.days))}>
                  {p.label}
                </Chip>
              ))}
              {/* Custom lead days the user added — tap to remove. */}
              {form.leadDays
                .filter((d) => !LEAD_PRESETS.some((p) => p.days === d))
                .sort((a, b) => a - b)
                .map((d) => (
                  <Chip key={`custom-${d}`} on onClick={() => set('leadDays', toggleArr(form.leadDays, d))}>
                    {d} days before ✕
                  </Chip>
                ))}
            </div>
            {/* Manual entry — set your own number of days beyond the presets. */}
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[11px] text-kaya-sand">or set your own</span>
              <input
                type="number" min={1} max={60} inputMode="numeric"
                value={customLead}
                onChange={(e) => setCustomLead(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomLead(); } }}
                placeholder="#"
                className="w-16 rounded-kaya-sm border border-kaya-warm-dark bg-white px-2.5 py-1.5 text-sm text-center font-bold text-kaya-chocolate"
              />
              <span className="text-[11px] text-kaya-sand">days before</span>
              <button onClick={addCustomLead} className="rounded-kaya-sm px-3 py-1.5 text-xs font-extrabold text-white" style={{ background: CAL }}>+ Add</button>
            </div>
          </Field>

          {/* Channels */}
          <Field label="Notify by">
            <div className="space-y-2">
              <ChannelRow on={form.channelInApp} onToggle={() => set('channelInApp', !form.channelInApp)} label="🔔 In-app notification" />
              <ChannelRow on={form.channelEmail} onToggle={() => set('channelEmail', !form.channelEmail)} label="📧 Email" />
              <div className="flex items-center gap-2.5 bg-white border border-kaya-warm-dark rounded-kaya px-3 py-2.5 opacity-60">
                <span className="w-[18px] h-[18px] rounded-[5px] border-[1.5px] border-kaya-warm-dark shrink-0" />
                <span className="text-sm font-bold text-kaya-chocolate">💬 WhatsApp</span>
                <span className="ml-auto text-[9px] font-extrabold uppercase tracking-wide bg-kaya-warm text-kaya-sand rounded px-1.5 py-0.5">Coming later</span>
              </div>
            </div>
          </Field>

          {/* Email recipients */}
          {form.channelEmail && (
            <Field label="Email to — pick + add">
              {/* ✉️ 2.0 — built-in one-tap groups (Parents · +Kids · +Helpers, parents only). */}
              <div className="flex flex-wrap gap-2 mb-1.5">
                {builtInGroups(members, viewerRole).map((g) => {
                  const emails = g.recipients.map((r) => r.email.toLowerCase());
                  const selected = emails.filter((e) => form.recipients.some((r) => r.email.toLowerCase() === e)).length;
                  const state = selected === 0 ? 'empty' : selected === emails.length ? 'full' : 'partial';
                  return (
                    <button key={g.id} type="button"
                      onClick={() => setForm((f) => {
                        if (state === 'full') return { ...f, recipients: f.recipients.filter((r) => !emails.includes(r.email.toLowerCase())) };
                        const have = new Set(f.recipients.map((r) => r.email.toLowerCase()));
                        return { ...f, recipients: [...f.recipients, ...g.recipients.filter((r) => !have.has(r.email.toLowerCase()))] };
                      })}
                      className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-extrabold border transition"
                      style={state === 'full' ? { background: CAL, borderColor: CAL, color: '#fff' } : state === 'partial' ? { background: CAL_SOFT, borderColor: CAL, color: CAL_DK } : { background: '#fff', borderColor: '#E8DEC9', color: '#5C6975' }}>
                      {g.emoji} {g.label} <span className="font-bold opacity-75">({state === 'partial' ? `${selected}/${emails.length}` : emails.length})</span>
                    </button>
                  );
                })}
              </div>
              {groupInfos.length > 0 && (
                <>
                  <div className="flex flex-wrap gap-2 mb-1.5">
                    {groupInfos.map((info) => (
                      <button
                        key={info.g.id}
                        onClick={() => toggleGroup(info)}
                        className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-extrabold border transition"
                        style={info.state === 'full'
                          ? { background: CAL, borderColor: CAL, color: '#fff' }
                          : info.state === 'partial'
                            ? { background: CAL_SOFT, borderColor: CAL, color: CAL_DK }
                            : { background: '#fff', borderColor: '#E8DEC9', color: '#5C6975' }}
                      >
                        {info.state === 'full' && (
                          <span className="w-3.5 h-3.5 rounded-[4px] bg-white text-[9px] font-extrabold flex items-center justify-center" style={{ color: CAL }}>✓</span>
                        )}
                        {info.state === 'partial' && (
                          <span className="w-3.5 h-3.5 rounded-[4px] text-white text-[10px] font-extrabold flex items-center justify-center" style={{ background: CAL }}>−</span>
                        )}
                        {info.g.emoji || '👨‍👩‍👧'} {info.g.name}
                        <span className="font-bold opacity-75">({info.state === 'partial' ? `${info.selected}/${info.recips.length}` : info.recips.length})</span>
                      </button>
                    ))}
                  </div>
                  <div className="text-[11px] text-kaya-sand mb-2">One tap picks the whole group · tap again clears it · untick anyone below and the chip turns “partial”.</div>
                </>
              )}
              <div className="bg-white border border-kaya-warm-dark rounded-kaya px-3 py-2.5">
                {/* Names only — emails stay in the background (Elia, 22-Aug). */}
                {(() => {
                  const picked = members.filter((m) => isMemberChecked((m.email || '').toLowerCase()));
                  return (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {picked.length === 0 && <span className="text-[11.5px] text-kaya-sand">No one picked yet — tap a group above or adjust below.</span>}
                      {picked.map((m) => (
                        <span key={m.uid} className="inline-flex items-center gap-1 text-[11.5px] font-bold rounded-full px-2.5 py-1" style={{ background: CAL_SOFT, color: CAL_DK }}>
                          {roleEmoji(m.role)} {m.displayName.split(' ')[0]}{m.uid === ownUid ? ' (you)' : ''}
                          <button type="button" onClick={() => toggleMember(m)} className="opacity-60 hover:opacity-100" aria-label={`Remove ${m.displayName}`}>✕</button>
                        </span>
                      ))}
                      <button type="button" onClick={() => setShowPeople((v) => !v)} className="text-[11px] font-extrabold ml-auto" style={{ color: CAL_DK }}>{showPeople ? 'Done' : 'Adjust people ▾'}</button>
                    </div>
                  );
                })()}
                {showPeople && (
                  <div className="mt-2 border-t border-dashed border-kaya-warm-dark pt-2 grid grid-cols-2 gap-x-3">
                    {members.map((m) => {
                      const email = (m.email || '').toLowerCase();
                      const checked = isMemberChecked(email);
                      return (
                        <button key={m.uid} type="button" onClick={() => toggleMember(m)} className="flex items-center gap-2 py-1.5 text-left min-w-0">
                          <span className="w-[17px] h-[17px] rounded-[5px] flex items-center justify-center text-[10px] font-extrabold text-white shrink-0"
                            style={checked ? { background: CAL } : { background: '#fff', border: '1.5px solid #E8DEC9' }}>
                            {checked ? '✓' : ''}
                          </span>
                          <span className="text-[12.5px] font-bold text-kaya-chocolate truncate">
                            {roleEmoji(m.role)} {m.displayName}{m.uid === ownUid ? ' (you)' : ''}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="flex gap-2 mt-2 border-t border-dashed border-kaya-warm-dark pt-2.5">
                  <input value={extInput} onChange={(e) => setExtInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExternal(); } }}
                    placeholder="grandma@example.com"
                    className="flex-1 rounded-kaya-sm border border-kaya-warm-dark px-2.5 py-1.5 text-xs font-medium text-kaya-chocolate" />
                  <button onClick={addExternal} className="rounded-kaya-sm px-3 py-1.5 text-xs font-extrabold text-white" style={{ background: CAL }}>+ Add</button>
                </div>
                {externals.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {externals.map((r) => (
                      <span key={r.email} className="inline-flex items-center gap-1.5 text-[11px] font-bold rounded-full px-2.5 py-1" style={{ background: CAL_SOFT, color: CAL_DK }}>
                        ✉️ {r.email}
                        <button onClick={() => removeRecipient(r.email)} className="opacity-60 hover:opacity-100">✕</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="text-[11px] text-kaya-sand mt-1.5">Groups do the picking; emails stay in the background. Add any outside address in the line above. Saved on this reminder for re-use.</div>
            </Field>
          )}

          </>)}

          {error && <div className="text-sm text-red-600 font-medium">{error}</div>}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            {onDelete && (
              <button onClick={onDelete} disabled={saving} className="rounded-kaya px-4 py-2.5 text-sm font-bold text-red-600 bg-white border border-red-200">
                Delete
              </button>
            )}
            <div className="flex-1" />
            <button onClick={onClose} className="rounded-kaya px-4 py-2.5 text-sm font-bold text-kaya-sand bg-white border border-kaya-warm-dark">Cancel</button>
            <button onClick={onSave} disabled={saving} className="rounded-kaya px-6 py-2.5 text-sm font-extrabold text-white disabled:opacity-60" style={{ background: CAL }}>
              {saving ? 'Saving…' : form.id ? 'Save' : 'Add reminder'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] font-extrabold uppercase tracking-wide text-kaya-sand mb-2">{label}</div>
      {children}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="text-xs font-bold rounded-kaya-sm px-3 py-2 border transition"
      style={on ? { background: CAL_SOFT, borderColor: CAL, color: CAL_DK } : { background: '#fff', borderColor: '#E8DEC9', color: '#5C6975' }}>
      {children}
    </button>
  );
}

function ChannelRow({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button onClick={onToggle} className="w-full flex items-center gap-2.5 bg-white border border-kaya-warm-dark rounded-kaya px-3 py-2.5 text-left">
      <span className="w-[18px] h-[18px] rounded-[5px] flex items-center justify-center text-[11px] font-extrabold text-white shrink-0"
        style={on ? { background: '#3FAF6C' } : { background: '#fff', border: '1.5px solid #E8DEC9' }}>
        {on ? '✓' : ''}
      </span>
      <span className="text-sm font-bold text-kaya-chocolate">{label}</span>
    </button>
  );
}

/** 💊 v5 — adherence dot grid (last ≤7 days × slots) for the care editor.
 *  ✓ mint = given · ✓ amber = late · ✕ red = missed · − grey = skipped ·
 *  beige = nothing recorded. Hover/long-press a dot → who + when. */
function AdherenceGrid({ ev }: { ev: ReminderEvent }) {
  const care = ev.care!;
  const today = todayKey();
  const end = careEndDate(ev);
  const last = end && end < today ? end : today;
  const first = diffDaysKey(ev.date, last) > 6 ? addDaysKey(last, -6) : ev.date;
  const days: string[] = [];
  for (let k = first; k <= last && days.length < 7; k = addDaysKey(k, 1)) days.push(k);
  if (!days.length) return null;
  const entryAt = (dateKey: string, i: number): DoseEntry | undefined =>
    (ev.doseLog || []).find((d) => d.key === doseKeyFor(dateKey, i));
  return (
    <Field label="Adherence 👀">
      <div className="bg-white border border-kaya-warm-dark rounded-kaya px-3 py-2.5 overflow-x-auto">
        <table className="text-[11px]">
          <thead>
            <tr>
              <th className="pr-2" />
              {care.slots.map((s, i) => <th key={i} className="px-1.5 pb-1 text-center">{s.icon || slotIcon(s.time)}</th>)}
            </tr>
          </thead>
          <tbody>
            {days.map((dk) => (
              <tr key={dk}>
                <td className="pr-2 font-bold text-kaya-sand whitespace-nowrap">{dayOfWeek(dk).slice(0, 3)} {dk.slice(8)}</td>
                {care.slots.map((s, i) => {
                  const e = entryAt(dk, i);
                  const style = e?.status === 'given' ? { background: '#2E8C7E', color: '#fff' }
                    : e?.status === 'late' ? { background: '#E8A64F', color: '#fff' }
                    : e?.status === 'missed' ? { background: '#C0392B', color: '#fff' }
                    : e?.status === 'skipped' ? { background: '#E4DCCB', color: '#8A7A66' }
                    : { background: '#F1EBDD', color: '#F1EBDD' };
                  const mark = e?.status === 'given' || e?.status === 'late' ? '✓'
                    : e?.status === 'missed' ? '✕' : e?.status === 'skipped' ? '−' : '·';
                  const tip = e?.byName ? `${e.byName}${e.at ? ` · ${new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}` : 'Nothing recorded';
                  return (
                    <td key={i} className="px-1.5 py-0.5 text-center">
                      <span title={tip} className="inline-flex w-[18px] h-[18px] rounded-[6px] items-center justify-center font-extrabold" style={style}>{mark}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Field>
  );
}

/** 💊 v5-F — pack countdown (📉 Refill Radar's visible face) + the 🩺
 *  Doctor's Report Card (printable adherence trail for the clinic). */
function CareTools({ ev }: { ev: ReminderEvent }) {
  const care = ev.care!;
  const given = (ev.doseLog || []).filter((d) => d.status === 'given' || d.status === 'late').length;
  const remaining = care.packCount ? Math.max(0, care.packCount - given) : null;
  const lowPack = remaining !== null && remaining <= care.slots.length * 3;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {remaining !== null && (
        <span className="text-[11.5px] font-extrabold rounded-full px-3 py-1.5"
          style={lowPack ? { background: '#F5E9D2', color: '#8A6D1F' } : { background: CARE_SOFT, color: CARE }}>
          📉 ≈ {remaining} of {care.packCount} left{lowPack ? ' · refill soon 🛒' : ''}
        </span>
      )}
      {(ev.doseLog || []).length > 0 && (
        <button onClick={() => openDoctorReport(ev)}
          className="text-[11.5px] font-extrabold rounded-full px-3 py-1.5 border"
          style={{ borderColor: CARE, color: CARE, background: '#fff' }}>
          🩺 Doctor’s Report
        </button>
      )}
    </div>
  );
}

/** Build + print the clinic-ready adherence report in a new tab. */
function openDoctorReport(ev: ReminderEvent) {
  const care = ev.care!;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = (ev.doseLog || [])
    .filter((d) => d.status)
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((d) => {
      const [dk, si] = d.key.split(':');
      const slot = care.slots[parseInt(si, 10)];
      const at = d.at ? new Date(d.at) : null;
      const time = at ? `${at.getHours() % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${at.getHours() >= 12 ? 'PM' : 'AM'}` : '—';
      const status = d.status === 'given' ? '✓ given' : d.status === 'late' ? '✓ given late' : d.status === 'missed' ? '✕ missed' : '⏭ skipped';
      return `<tr><td>${esc(toDisplayDate(dk))}</td><td>${slot ? `${slot.icon || ''} ${esc(slot.time)}` : `slot ${si}`}</td><td>${status}</td><td>${esc(d.byName || '—')}</td><td>${time}</td></tr>`;
    }).join('');
  const givenN = (ev.doseLog || []).filter((d) => d.status === 'given' || d.status === 'late').length;
  const missedN = (ev.doseLog || []).filter((d) => d.status === 'missed').length;
  const total = careTotalDays(ev);
  const html = `<!doctype html><html><head><title>Kaya Care Report — ${esc(ev.title)}</title><style>
    body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1F2D3D;padding:32px;max-width:720px;margin:0 auto;}
    h1{font-size:20px;margin:0;} .sub{color:#5C6975;font-size:13px;margin-top:4px;}
    .box{border:1px solid #D8CFC0;border-radius:12px;padding:14px 16px;margin:16px 0;display:flex;gap:16px;align-items:center;}
    img{max-width:90px;max-height:90px;border-radius:10px;border:1px solid #D8CFC0;}
    table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;}
    th{text-align:left;border-bottom:2px solid #D8CFC0;padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#5C6975;}
    td{border-bottom:1px solid #EDE5D8;padding:6px 8px;}
    .foot{margin-top:24px;font-size:11px;color:#5C6975;} @media print{.noprint{display:none}}
  </style></head><body>
    <h1>💊 Care adherence report — ${esc(ev.title)}</h1>
    <div class="sub">${esc(care.forName || 'Self')} · ${esc(care.dose)} × ${care.slots.length}/day (${care.slots.map((s) => esc(s.time)).join(' · ')})${care.withFood ? ' · with food' : ''} · started ${esc(toDisplayDate(ev.date))}${total ? ` · ${total}-day course` : ' · ongoing'}</div>
    <div class="box">${care.photoUrl ? `<img src="${esc(care.photoUrl)}" alt="Medicine" />` : ''}<div>
      <b>${esc(care.labelName || ev.title)}</b><br>
      <span class="sub">${givenN} given · ${missedN} missed${care.packCount ? ` · pack of ${care.packCount}` : ''}</span>
    </div></div>
    <table><thead><tr><th>Date</th><th>Slot</th><th>Status</th><th>By</th><th>At</th></tr></thead><tbody>${rows || '<tr><td colspan=5>No doses recorded yet.</td></tr>'}</tbody></table>
    <div class="foot">Generated by Kaya · ourkaya.com · This is a family log, not a medical record. Always follow your doctor’s instructions.</div>
    <button class="noprint" onclick="window.print()" style="margin-top:18px;padding:10px 22px;border-radius:999px;border:0;background:#2E8C7E;color:#fff;font-weight:800;">🖨 Print / Save PDF</button>
  </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

/** Badge tints for the classic milestone years (approved v4 mock) — Silver,
 *  Golden and Diamond get their own hue; the rest share the warm gold tint. */
function milestoneStyle(label: string): React.CSSProperties {
  switch (label) {
    case 'Silver': return { background: '#EEF1F6', color: '#5F6B80' };
    case 'Golden': return { background: '#FBF3DC', color: '#A07C1F' };
    case 'Diamond': return { background: '#E9F6F7', color: '#1D7A85' };
    default: return { background: '#F5E9D2', color: '#8A6D1F' };
  }
}

function roleEmoji(role: string | undefined): string {
  switch (role) {
    case 'parent': return '👨';
    case 'helper': return '🤝';
    case 'kid': return '🧒';
    default: return '👤';
  }
}
