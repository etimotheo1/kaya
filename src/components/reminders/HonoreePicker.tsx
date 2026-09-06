'use client';

// ✉️ Honoree picker (Reminders 2.0) — "Who's being celebrated?" inside the
// reminder editor. v2 (Elia, 22-Aug): SEARCH-first instead of a wall of
// chips — type a name to find a People-Book contact or a family member, or
// add someone new on the spot (parents). Sets "Let Kaya send it" + "CC
// parents". Shown for 🎂/💍 always and for 🎉 once "this celebrates someone"
// is on (R2). Kids pick only — no kid-typed addresses (COPPA).

import { useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { updateFamily, type UserProfile, type Child } from '@/lib/firestore';
import {
  formatWhatsapp, type GreetTo, type FamilyContact, type ReminderType,
} from '@/lib/reminders';
import { ContactForm, blankContactDraft, contactFromDraft, type ContactDraft } from '@/components/settings/PeopleBookCard';

const CAL = '#5B6CC8';
const CAL_DK = '#3E4DA0';
const CAL_SOFT = '#E7EAFA';

type Candidate = { key: string; name: string; sub: string; emoji: string; disabled?: boolean; make: () => GreetTo };

export default function HonoreePicker({ value, onChange, type, members, kids, contacts, familyId, ownUid }: {
  value: GreetTo | null;
  onChange: (g: GreetTo | null) => void;
  type: ReminderType;
  members: UserProfile[];
  kids: Child[];
  contacts: FamilyContact[];
  familyId: string;
  ownUid: string;
}) {
  const { profile } = useAuth();
  const isParent = profile?.role === 'parent';
  const [open, setOpen] = useState(type !== 'event' || !!value);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  // 📇 Contact Picker API (Android Chrome today; the seam for "link to mobile contacts").
  const phonePickerOk = typeof navigator !== 'undefined' && 'contacts' in navigator && typeof (navigator as unknown as { contacts?: { select?: unknown } }).contacts?.select === 'function';
  async function pickFromPhone() {
    try {
      const nav = navigator as unknown as { contacts: { select: (props: string[], opts: { multiple: boolean }) => Promise<Array<{ name?: string[]; email?: string[]; tel?: string[] }>> } };
      const picked = await nav.contacts.select(['name', 'email', 'tel'], { multiple: false });
      const c = picked?.[0]; if (!c) return;
      const d = blankContactDraft();
      d.name = (c.name?.[0] || q.trim()).slice(0, 80);
      d.email = (c.email || []).slice(0, 3).join(', ');
      d.whatsapp = c.tel?.[0] || '';
      setDraft(d); setErr('');
    } catch { /* user cancelled or unsupported */ }
  }

  const candidates: Candidate[] = useMemo(() => {
    const loginKidIds = new Set(members.filter((m) => m.role === 'kid' && m.childId).map((m) => m.childId as string));
    const out: Candidate[] = [];
    for (const c of contacts) {
      const emails = Array.from(new Set([c.email, ...(c.emails || [])].filter(Boolean))) as string[];
      out.push({
        key: `c:${c.id}`, name: c.name, emoji: c.relationship === 'kid-friend' ? '🧒' : '👤',
        sub: [c.relation, emails.length ? `📧 ${emails.length > 1 ? `${emails.length} emails` : emails[0]}` : '', c.whatsapp ? '💬' : '', c.optOut ? 'opted out' : ''].filter(Boolean).join(' · ') || 'People Book',
        disabled: !!c.optOut,
        make: () => {
          const g: GreetTo = { contactId: c.id, name: c.name, relationship: c.relationship, autoSend: emails.length > 0, ccParents: true };
          if (emails[0]) g.email = emails[0];
          if (emails.length > 1) g.emails = emails;
          if (c.whatsapp) g.whatsapp = c.whatsapp;
          if (c.timezone) g.timezone = c.timezone;
          return g;
        },
      });
    }
    for (const m of members) {
      if (m.uid === ownUid || m.role === 'helper') continue; // helpers aren't honorees here (Elia, 22-Aug)
      out.push({
        key: `m:${m.uid}`, name: m.displayName, emoji: m.role === 'kid' ? '🧒' : '👨‍👩‍👧', sub: m.role === 'kid' ? 'Kid · family' : 'Parent · family',
        make: () => ({ memberUid: m.uid, name: m.displayName, ...(m.email ? { email: m.email } : {}), relationship: 'family', autoSend: false, ccParents: false }),
      });
    }
    for (const k of kids) {
      if (loginKidIds.has(k.id)) continue;
      out.push({ key: `k:${k.id}`, name: k.name, emoji: '🧒', sub: 'Kid · family', make: () => ({ childId: k.id, name: k.name, relationship: 'family', autoSend: false, ccParents: false }) });
    }
    return out;
  }, [contacts, members, kids, ownUid]);

  const query = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!query) return candidates.slice(0, 4);
    return candidates.filter((c) => c.name.toLowerCase().includes(query) || c.sub.toLowerCase().includes(query)).slice(0, 8);
  }, [candidates, query]);
  const exact = candidates.some((c) => c.name.toLowerCase() === query);

  const selectedKey = value?.contactId ? `c:${value.contactId}` : value?.memberUid ? `m:${value.memberUid}` : value?.childId ? `k:${value.childId}` : '';

  async function saveContact() {
    if (!draft || !profile) return;
    const r = contactFromDraft(draft, profile.uid);
    if ('error' in r) { setErr(r.error); return; }
    setSaving(true); setErr('');
    try {
      await updateFamily(familyId, { contacts: [...contacts, r.contact] });
      const c = r.contact;
      const emails = Array.from(new Set([c.email, ...(c.emails || [])].filter(Boolean))) as string[];
      const g: GreetTo = { contactId: c.id, name: c.name, relationship: c.relationship, autoSend: emails.length > 0, ccParents: true };
      if (emails[0]) g.email = emails[0];
      if (emails.length > 1) g.emails = emails;
      if (c.whatsapp) g.whatsapp = c.whatsapp;
      if (c.timezone) g.timezone = c.timezone;
      onChange(g); setDraft(null); setQ('');
    } catch { setErr('Could not save — try again'); }
    setSaving(false);
  }

  if (type === 'event' && !open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="w-full rounded-kaya border border-dashed px-3 py-2.5 text-[12.5px] font-extrabold text-left" style={{ borderColor: CAL, color: CAL_DK, background: '#fff' }}>
        🎉 This celebrates someone → pick them (unlocks a greeting card)
      </button>
    );
  }

  const emailsOf = (g: GreetTo) => Array.from(new Set([g.email, ...(g.emails || [])].filter(Boolean))) as string[];

  return (
    <div className="space-y-2">
      {/* Selected */}
      {value && (
        <div className="rounded-kaya border px-3 py-2.5" style={{ borderColor: CAL, background: CAL_SOFT }}>
          <div className="flex items-center gap-2">
            <span className="text-base">{value.relationship === 'kid-friend' ? '🧒' : value.relationship === 'adult' ? '👤' : '🏠'}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-extrabold text-kaya-chocolate truncate">{value.name}</div>
              <div className="text-[10.5px] text-kaya-sand truncate">
                {value.relationship === 'family' ? 'In the family — card goes to chat + Moments, never a separate email'
                  : [emailsOf(value).length ? `📧 ${emailsOf(value).join(', ')}` : '', value.whatsapp && `💬 ${formatWhatsapp(value.whatsapp)}`].filter(Boolean).join(' · ') || 'No email / WhatsApp — you can still make + share the card'}
              </div>
            </div>
            <button type="button" onClick={() => onChange(null)} className="rounded-full px-2.5 py-1 text-[11px] font-bold text-kaya-sand bg-white border border-kaya-warm-dark">Change</button>
          </div>
          {value.relationship !== 'family' && (
            <div className="mt-2 space-y-1.5">
              <button type="button" disabled={!emailsOf(value).length} onClick={() => onChange({ ...value, autoSend: !value.autoSend })}
                className="w-full flex items-center gap-2 bg-white border border-kaya-warm-dark rounded-kaya px-3 py-2 text-left disabled:opacity-60">
                <span className="w-[18px] h-[18px] rounded-[5px] flex items-center justify-center text-[10px] font-extrabold text-white shrink-0"
                  style={value.autoSend && emailsOf(value).length ? { background: CAL } : { background: '#fff', border: '1.5px solid #E8DEC9' }}>{value.autoSend && emailsOf(value).length ? '✓' : ''}</span>
                <span className="text-[12.5px] font-bold text-kaya-chocolate">✨ Let Kaya send it at 07:00 on the day</span>
                {!emailsOf(value).length && <span className="ml-auto text-[9px] font-extrabold uppercase bg-kaya-warm text-kaya-sand rounded px-1.5 py-0.5">needs email</span>}
              </button>
              {!emailsOf(value).length && value.whatsapp && <div className="text-[10.5px] text-kaya-sand px-1">WhatsApp is tap-to-send on the day — Kaya will prompt you.</div>}
              <button type="button" onClick={() => onChange({ ...value, ccParents: !value.ccParents })}
                className="w-full flex items-center gap-2 bg-white border border-kaya-warm-dark rounded-kaya px-3 py-2 text-left">
                <span className="w-[18px] h-[18px] rounded-[5px] flex items-center justify-center text-[10px] font-extrabold text-white shrink-0"
                  style={value.ccParents ? { background: CAL } : { background: '#fff', border: '1.5px solid #E8DEC9' }}>{value.ccParents ? '✓' : ''}</span>
                <span className="text-[12.5px] font-bold text-kaya-chocolate">👨‍👩‍👧 Parents in copy</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Search */}
      {!value && !draft && (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off"
            placeholder="Search people — Grandma, Uncle Joseph, a kid…"
            className="w-full rounded-kaya border border-kaya-warm-dark bg-white px-3 py-2.5 text-sm font-medium text-kaya-chocolate" />
          <div className="flex flex-wrap gap-1.5">
            {results.map((c) => (
              <button key={c.key} type="button" disabled={c.disabled} onClick={() => { onChange(c.make()); setQ(''); }}
                className="rounded-full pl-2.5 pr-3 py-1.5 text-[12px] font-extrabold border text-left disabled:opacity-40 flex items-center gap-1.5"
                style={selectedKey === c.key ? { background: CAL, borderColor: CAL, color: '#fff' } : { background: '#fff', borderColor: '#E8DEC9', color: '#3D241A' }}>
                <span>{c.emoji}</span><span>{c.name}</span><span className="text-[10px] font-bold opacity-60">{c.sub.split(' · ')[0]}</span>
              </button>
            ))}
            {isParent && phonePickerOk && (
              <button type="button" onClick={pickFromPhone}
                className="rounded-full px-3 py-1.5 text-[12px] font-extrabold border border-dashed" style={{ borderColor: CAL, color: CAL_DK, background: '#fff' }}>
                📇 From phone contacts
              </button>
            )}
            {isParent && (
              <button type="button" onClick={() => { const d = blankContactDraft(); d.name = q.trim(); setDraft(d); setErr(''); }}
                className="rounded-full px-3 py-1.5 text-[12px] font-extrabold border border-dashed" style={{ borderColor: CAL, color: CAL_DK, background: '#fff' }}>
                ＋ {query && !exact ? `Add “${q.trim()}”` : 'Add someone new'}
              </button>
            )}
            {!results.length && !isParent && <span className="text-[11px] text-kaya-sand">No match — ask a parent to add them to the People Book.</span>}
          </div>
          {!query && candidates.length > 4 && <div className="text-[10.5px] text-kaya-sand">Showing a few — type a name to find anyone in the People Book or the family{phonePickerOk ? ', or pick from your phone' : ''}.</div>}
        </>
      )}
      {draft && (
        <ContactForm draft={draft} setDraft={setDraft} error={err} saving={saving} onSave={saveContact} onCancel={() => setDraft(null)} compact />
      )}
    </div>
  );
}
