'use client';

// 🤖 Kaya AI level (approved 2026-09-07) — the Settings card.
//
//   • Family default — one of four levels (🌱 Gentle · 🌤 Balanced ·
//     💪 Stretch · 🎓 Exam-Ready); saved to family.aiConfig.defaultLevel.
//   • Per child — an explicit override on child.aiLevel (null = inherit).
//     Each row shows the EFFECTIVE level + where it came from ("family
//     default" · "capped to Balanced for age 6" · "set for this child").
//     🎓 Exam-Ready is offered from age 10; a level set here always wins.
//
// Saves on tap (no separate Save button) — the FamilyContext refresh
// re-renders the rows with the new resolution. Parent-only (the section
// is mounted inside the parent-only block of Settings).

import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useFamily } from '@/contexts/FamilyContext';
import { updateFamily, updateChild, type Child } from '@/lib/firestore';
import {
  AI_LEVELS, AI_LEVEL_EXAM_FROM_AGE, AI_LEVEL_GUARD_UNDER_AGE,
  aiLevelMeta, levelOfferedForAge, parseAiLevel, readAiConfig, resolveAiLevel,
  type AiLevel,
} from '@/lib/ai/level.shared';

export default function AiLevelCard() {
  const { profile } = useAuth();
  const { family, children, refresh } = useFamily();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const familyId = profile?.familyId;
  const cfg = readAiConfig(family);
  const familyMeta = aiLevelMeta(cfg.defaultLevel);

  const setFamilyLevel = async (level: AiLevel) => {
    if (!familyId || busy || level === cfg.defaultLevel) return;
    setBusy('family'); setErr('');
    try {
      await updateFamily(familyId, {
        aiConfig: { ...(family?.aiConfig ?? {}), defaultLevel: level },
      } as Partial<import('@/lib/firestore').Family>);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the family level.');
    } finally { setBusy(null); }
  };

  const setChildLevel = async (child: Child, level: AiLevel | null) => {
    if (!familyId || busy) return;
    if ((parseAiLevel(child.aiLevel) ?? null) === level) return;
    setBusy(child.id); setErr('');
    try {
      await updateChild(familyId, child.id, { aiLevel: level });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : `Could not save ${child.name}'s level.`);
    } finally { setBusy(null); }
  };

  const pill = (on: boolean, disabled: boolean) =>
    `rounded-kaya-sm border px-2 py-1.5 text-[11.5px] font-extrabold transition ${
      on ? 'border-kaya-gold-dark bg-kaya-gold-light' : 'border-kaya-warm-dark bg-kaya-cream hover:bg-white'
    } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`;

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-kaya-sand leading-relaxed">
        One dial for how firmly Kaya marks, how deeply it explains and how hard it pushes — homework marking,
        follow-up questions, reflections, book quizzes, Coach Ear, the business coach and diary prompts.
        Kindness never changes, and an AI score never moves points on its own.
      </p>

      {/* ── Family default ── */}
      <div>
        <p className="text-[13px] font-bold">Family default</p>
        <p className="text-[11px] text-kaya-sand mb-2">Applies to every child without their own level. 🌤 Balanced is exactly what Kaya does today.</p>
        <div className="grid grid-cols-4 gap-1.5">
          {AI_LEVELS.map((m) => {
            const on = m.level === cfg.defaultLevel;
            return (
              <button
                key={m.level}
                type="button"
                aria-pressed={on}
                disabled={busy === 'family'}
                title={`${m.name} — ${m.tagline}`}
                onClick={() => void setFamilyLevel(m.level)}
                className={`rounded-kaya-sm border-2 px-1 py-2 text-center transition ${
                  on ? 'border-kaya-gold-dark bg-kaya-gold-light' : 'border-kaya-warm-dark bg-kaya-cream hover:bg-white'
                }`}
              >
                <div className="text-xl leading-none">{m.emoji}</div>
                <div className="text-[11px] font-extrabold mt-1 leading-tight">{m.name}</div>
              </button>
            );
          })}
        </div>
        <div className="mt-2 rounded-kaya-sm border border-kaya-warm-dark bg-kaya-cream p-3 text-[11.5px] leading-relaxed space-y-0.5">
          <p className="font-extrabold">{familyMeta.emoji} {familyMeta.name} — “{familyMeta.tagline}”</p>
          <p><span className="font-bold">Marking:</span> {familyMeta.marking}</p>
          <p><span className="font-bold">Feedback:</span> {familyMeta.feedback}</p>
          <p><span className="font-bold">Next challenge:</span> {familyMeta.challenge}</p>
          <p><span className="font-bold">Voice:</span> {familyMeta.voice}</p>
        </div>
      </div>

      {/* ── Per child ── */}
      {children.length > 0 && (
        <div className="rounded-kaya-sm border border-dashed border-kaya-warm-dark/60 p-3 space-y-3">
          <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Per child (a level set here always wins)</p>
          {children.map((k) => {
            const r = resolveAiLevel(family, k);
            const own = parseAiLevel(k.aiLevel);
            const meta = aiLevelMeta(r.level);
            const sourceText = own
              ? 'set for this child'
              : r.capped
                ? `capped to ${meta.name} for age ${r.age} — set a level here to change`
                : r.source === 'family' ? 'family default' : 'Kaya default';
            return (
              <div key={k.id} className="space-y-1.5" data-testid={`ai-level-row-${k.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[12.5px] font-semibold truncate">
                    {k.avatarEmoji || '🧒'} {k.name}
                    {r.age !== null && <span className="text-kaya-sand font-normal"> · {r.age}</span>}
                  </p>
                  <p className="text-[11px] text-right leading-snug">
                    <span className="font-extrabold whitespace-nowrap">{meta.emoji} {meta.name}</span>
                    <span className="text-kaya-sand"> · {sourceText}</span>
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    aria-pressed={!own}
                    disabled={busy === k.id}
                    title="Follow the family default"
                    onClick={() => void setChildLevel(k, null)}
                    className={pill(!own, busy === k.id)}
                  >
                    ↺ Family
                  </button>
                  {AI_LEVELS.map((m) => {
                    const offered = levelOfferedForAge(m.level, r.age);
                    const on = own === m.level;
                    return (
                      <button
                        key={m.level}
                        type="button"
                        aria-pressed={on}
                        disabled={!offered || busy === k.id}
                        title={offered ? `${m.name} — ${m.tagline}` : `${m.name} is offered from age ${AI_LEVEL_EXAM_FROM_AGE}`}
                        onClick={() => void setChildLevel(k, m.level)}
                        className={pill(on, !offered || busy === k.id)}
                      >
                        {m.emoji}<span className="hidden sm:inline"> {m.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <p className="text-[10.5px] text-kaya-sand leading-relaxed">
            Under {AI_LEVEL_GUARD_UNDER_AGE} a child never inherits above Balanced; 🎓 Exam-Ready is offered from {AI_LEVEL_EXAM_FROM_AGE}.
            No birthday on file = no age guard.
          </p>
        </div>
      )}

      <p className="text-[10.5px] text-kaya-sand leading-relaxed">
        Changing a level never re-marks past work — every score keeps the level it was marked at, shown as a small chip.
      </p>
      {err && <p className="text-[11px] text-red-600 font-semibold">{err}</p>}
    </div>
  );
}
