'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useFamily } from '@/contexts/FamilyContext';
import CoachMark from '@/components/ui/CoachMark';
import NextUp from '@/components/ui/NextUp';
import { giveAward, importAward, readPointSystemConfig, AwardKind } from '@/lib/firestore';
import { rewardsFloorFor, type FamilyRewardsSlice } from '@/lib/hive';
import { Timestamp } from 'firebase/firestore';
import { DEFAULT_EARNING_METHODS } from '@/lib/earningMethods';
import { auth as fbAuth } from '@/lib/firebase';
import BackButton from '@/components/ui/BackButton';
import KidAvatar from '@/components/ui/KidAvatar';
import { PAGE_WIDTH_CLASS } from '@/components/layout/Page';

const CATEGORIES = [
  { id: 'kindness',       icon: '💖', label: 'Kindness' },
  { id: 'helping',        icon: '🤝', label: 'Helping Others' },
  { id: 'bravery',        icon: '🦁', label: 'Bravery' },
  { id: 'learning',       icon: '📚', label: 'Learning' },
  { id: 'creativity',     icon: '🎨', label: 'Creativity' },
  { id: 'teamwork',       icon: '⭐', label: 'Teamwork' },
  { id: 'responsibility', icon: '🎯', label: 'Responsibility' },
  { id: 'recognition',    icon: '🌟', label: 'Recognition' },
  { id: 'other',          icon: '✨', label: 'Other' },
];

// Kid Stats PR4 (Elia): the picker filters to >= the family's diamondMin,
// so families with diamondMin=3 were missing the +3 chip entirely.
const DIAMOND_POINTS = [3, 4, 5, 6, 7, 8, 9, 10];

export default function AwardPage() {
  const { profile } = useAuth();
  const { family, children, rewards: familyRewards } = useFamily();

  // Families can disable Diamond points from Settings → "How kids earn points".
  // Honour that preference here; otherwise fall back to the Phase-1 default.
  const earningMethods = family?.earningMethods ?? DEFAULT_EARNING_METHODS;
  const diamondEnabled = earningMethods.includes('diamond');
  // Per-family tier limits + Kudos / Improvement Note settings. Read here
  // so the picker chips honour the parent's setup (e.g., reducing.max
  // controls how far down the deduction picker goes).
  const pointSystem = readPointSystemConfig(family);
  const diamondMin = pointSystem.diamondMinPoints;
  // Regular awards span +1..(diamondMin − 1). Cap conservatively at +3
  // even if the family raises diamondMin above 4 — the spec puts regular
  // at 1–3 and lets diamond start anywhere ≥ 4.
  const regularPointsRange = Array.from({ length: Math.max(1, diamondMin - 1) }, (_, i) => i + 1);
  // Reducing chips: −1 down to −reducing.max (cap at 10 to keep the grid sane).
  const reducingPointsRange = Array.from({ length: Math.min(10, pointSystem.reducing.max) }, (_, i) => i + 1);

  // Multi-select: parents often want to award a shared moment ("you all
  // helped grandma carry the groceries") to several kids in one go.
  const [selectedChildren, setSelectedChildren] = useState<string[]>([]);
  const [category, setCategory] = useState('');
  // Award kind drives the rest of the form. Default to 'regular'.
  const [kind, setKind] = useState<AwardKind>('regular');
  const [regularPts, setRegularPts] = useState(regularPointsRange[regularPointsRange.length - 1] || 3);
  const [diamondPts, setDiamondPts] = useState(diamondMin + 1);
  const [reducingPts, setReducingPts] = useState(1);
  const [reason, setReason] = useState('');
  // Kid Stats PR4 — backfill: when the deed actually happened (defaults
  // today). An earlier date routes through importAward with the true day.
  const [happenedOn, setHappenedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  // ?kid=/?reason= prefill (deep links). Round celebrations + Shine Cards
  // live EXCLUSIVELY in the 🌟 Recognition wizard now (FX PR-6, Elia:
  // "one-time points must not mint cards — cards lose meaning").
  const searchParams = useSearchParams();
  useEffect(() => {
    const kid = searchParams?.get('kid');
    if (kid) setSelectedChildren((prev) => (prev.includes(kid) ? prev : [...prev, kid]));
    const r = searchParams?.get('reason');
    if (r) setReason((prev) => prev || r);
  }, [searchParams]);
  // 🎁 Reward bridge — when ONE kid is selected and a store reward is
  // within a small top-up, offer to award exactly the gap.
  const bridge = useMemo(() => {
    if (selectedChildren.length !== 1) return null;
    const kid = children.find((c) => c.id === selectedChildren[0]);
    if (!kid) return null;
    const floor = rewardsFloorFor(family as FamilyRewardsSlice | undefined, kid.id);
    const spend = Math.max(0, (kid.totalPoints || 0) - floor);
    const candidates = (familyRewards || [])
      .filter((r) => r.active && r.kind !== 'family' && r.pointsCost > spend && r.pointsCost - spend <= 10)
      .sort((a, b) => a.pointsCost - b.pointsCost);
    if (candidates.length === 0) return null;
    return { reward: candidates[0], gap: candidates[0].pointsCost - spend, kidName: kid.name.split(' ')[0] };
  }, [selectedChildren, children, family, familyRewards]);

  // Snapshot of who received the award — used by the success screen so it
  // stays accurate even after the form resets.
  const [awardedNames, setAwardedNames] = useState<string[]>([]);

  // If a family disables Diamond mid-flow, fall back to regular so we
  // never submit a diamond award the family said they don't use.
  const isDiamond = kind === 'diamond' && diamondEnabled;
  const isReducing = kind === 'reducing' && pointSystem.reducing.enabled;
  const isKudos = kind === 'kudos' && pointSystem.kudos.enabled;
  const isImprovement = kind === 'improvement_note' && pointSystem.improvementNote.enabled;
  const isRegular = kind === 'regular' || (!isDiamond && !isReducing && !isKudos && !isImprovement);
  // Final signed points value to send to Firestore.
  let finalPoints = 0;
  if (isRegular) finalPoints = regularPts;
  else if (isDiamond) finalPoints = diamondPts;
  else if (isReducing) finalPoints = -reducingPts;
  // kudos / improvement_note → 0
  const selectedKidObjs = children.filter((c) => selectedChildren.includes(c.id));
  // ── Kind-aware presentation helpers ──
  // Keep accent classes, headings, and the submit verb derived from `kind`
  // so the visual treatment matches what the user picked (purple for
  // diamond, red for reducing, emerald for kudos, amber for improvement).
  const accentGradient = isDiamond
    ? 'from-purple-600 to-purple-800 shadow-purple-600/20'
    : isReducing
      ? 'from-red-500 to-red-700 shadow-red-500/20'
      : isKudos
        ? 'from-emerald-600 to-emerald-800 shadow-emerald-600/20'
        : isImprovement
          ? 'from-amber-600 to-amber-800 shadow-amber-600/20'
          : 'from-kaya-chocolate to-kaya-chocolate-light shadow-kaya-chocolate/20';
  const accentButtonClass = isDiamond
    ? 'bg-purple-600 hover:bg-purple-700 text-white'
    : isReducing
      ? 'bg-red-500 hover:bg-red-600 text-white'
      : isKudos
        ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
        : isImprovement
          ? 'bg-amber-600 hover:bg-amber-700 text-white'
          : 'bg-kaya-gold hover:bg-kaya-gold-dark text-white';
  const pointsSectionLabel = isKudos
    ? `${pointSystem.kudos.label} (auto-bonus every ${pointSystem.kudos.threshold})`
    : isImprovement
      ? `${pointSystem.improvementNote.label} (auto-deduction every ${pointSystem.improvementNote.threshold})`
      : isReducing
        ? `Reducing points (down to −${pointSystem.reducing.max})`
        : isDiamond
          ? `Diamond points (${diamondMin}+)`
          : 'How many points?';
  // Big preview number — "+3", "−1", or "👍/👉" for 0-point kinds.
  const previewBigNumber = isKudos
    ? '👍'
    : isImprovement
      ? '👉'
      : `${finalPoints > 0 ? '+' : ''}${finalPoints}`;
  const previewUnitLabel = isKudos
    ? pointSystem.kudos.label
    : isImprovement
      ? pointSystem.improvementNote.label
      : isDiamond
        ? 'diamond pts'
        : isReducing
          ? 'reducing pts'
          : 'points';
  const submitLabel = saving
    ? (isKudos || isImprovement ? 'Logging…' : 'Awarding…')
    : isKudos
      ? `Log ${pointSystem.kudos.label}${selectedChildren.length > 1 ? ` for ${selectedChildren.length} kids` : ''} 👍`
      : isImprovement
        ? `Log ${pointSystem.improvementNote.label}${selectedChildren.length > 1 ? ` for ${selectedChildren.length} kids` : ''} 👉`
        : isReducing
          ? `Deduct ${finalPoints} ${selectedChildren.length > 1 ? `from ${selectedChildren.length} kids` : ''} ⚠️`
          : `Award ${finalPoints > 0 ? '+' : ''}${finalPoints} ${isDiamond ? 'diamond ' : ''}points${selectedChildren.length > 1 ? ` to ${selectedChildren.length} kids` : ''} ${isDiamond ? '💎' : '🎖️'}`;
  // Whether to render the Points-type chip row — only useful when more
  // than one kind is available to the family.
  const showTypeToggle = (
    1 + (diamondEnabled ? 1 : 0) +
    (pointSystem.reducing.enabled ? 1 : 0) +
    (pointSystem.kudos.enabled ? 1 : 0) +
    (pointSystem.improvementNote.enabled ? 1 : 0)
  ) > 1;
  // Preview shows the first selected kid's avatar; if multiple, the title
  // line says "EarlnathanIrisha + 2 others".
  const child = selectedKidObjs[0] || null;
  const cat = CATEGORIES.find((c) => c.id === category) || null;
  const canSubmit = !!(selectedChildren.length > 0 && category && reason.trim() && !saving);

  const toggleChild = (id: string) => {
    setSelectedChildren((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleAward = async () => {
    if (!profile?.familyId || selectedChildren.length === 0 || !category || !reason.trim()) return;
    setSaving(true);
    // Submit one award per selected kid in parallel — each kid's points,
    // activity feed and badge thresholds are independent so we can't batch
    // a single write.
    // Kid Stats PR4 — backfill date: when the deed happened on an earlier
    // day (batch-filling on Sunday), route through importAward with the
    // TRUE date so patterns + future ML stay honest. importAward credits
    // totals the same way (weekly only if in the current week).
    const today = new Date().toISOString().slice(0, 10);
    const backfilling = happenedOn && happenedOn !== today;
    const results = await Promise.all(
      selectedChildren.map((childId) => {
        const base = {
          childId,
          kind,
          points: finalPoints,
          reason: reason.trim(),
          // Preserve the legacy `diamond-` prefix on category so existing
          // dashboards that read it keep working. `kind` is now the source
          // of truth — the prefix is purely back-compat.
          category: isDiamond ? `diamond-${category}` : category,
          awardedBy: profile.uid,
          awardedByName: profile.displayName,
        };
        return backfilling
          ? importAward(profile.familyId, { ...base, createdAt: Timestamp.fromDate(new Date(`${happenedOn}T12:00:00`)) } as Parameters<typeof importAward>[1])
          : giveAward(profile.familyId, base);
      }),
    );
    setAwardedNames(selectedKidObjs.map((c) => c.name));
    setSuccess(true);
    setSaving(false);


    // 🎖️ Award emails 2.0 (approved 23-Aug-2026) — ONE server gateway
    // composes the family + outside emails from each award doc (reason
    // card · kind · this week's trail). The kid tier rides giveAward's
    // existing reward-email ping. Fire-and-forget; 0-point kinds skip.
    if (finalPoints > 0) {
      const ids = results.map((r) => r?.id).filter((id): id is string => !!id && id !== 'guest-award');
      if (ids.length > 0) {
        fbAuth.currentUser?.getIdToken().then((token) => {
          if (!token) return;
          for (const awardId of ids) {
            void fetch('/api/points/award-email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ awardId }),
              keepalive: true,
            }).catch(() => {});
          }
        }).catch(() => { /* delight only — never blocks */ });
      }
    }

    setTimeout(() => {
      setSuccess(false);
      setAwardedNames([]);
      setSelectedChildren([]); setCategory(''); setKind('regular');
      setRegularPts(regularPointsRange[regularPointsRange.length - 1] || 3);
      setDiamondPts(diamondMin + 1);
      setReducingPts(1);
      setReason('');
    }, 2500);
  };

  // "Daniella, Diella & Earlnathan" / "Daniella & Diella" / "Daniella"
  const formatNames = (names: string[]): string => {
    if (names.length === 0) return '';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
  };

  if (success) {
    const successEmoji = isDiamond ? '💎' : isReducing ? '⚠️' : isKudos ? '👍' : isImprovement ? '👉' : '🎉';
    const successHeading = isReducing
      ? 'Point deducted'
      : isKudos
        ? `${pointSystem.kudos.label} logged`
        : isImprovement
          ? `${pointSystem.improvementNote.label} logged`
          : awardedNames.length > 1 ? 'Points Awarded to All!' : 'Points Awarded!';
    // Body copy varies by kind: numbered amount for regular/diamond/reducing,
    // descriptive text for the 0-point kinds.
    const bodyAmount = isKudos
      ? `a ${pointSystem.kudos.label} (counts toward +${pointSystem.kudos.bonusPoints} every ${pointSystem.kudos.threshold})`
      : isImprovement
        ? `an ${pointSystem.improvementNote.label}`
        : (
          <span className="text-kaya-gold font-bold">
            {finalPoints >= 0 ? '+' : ''}{finalPoints} {isDiamond ? 'diamond ' : ''}points{awardedNames.length > 1 ? ' each' : ''}
          </span>
        );
    return (
      <div className={`mx-auto max-w-md w-full ${PAGE_WIDTH_CLASS.narrow} px-4 pt-16 lg:pt-24 text-center animate-slide-up`}>
        {/* 🌟 RR PR-2 — the freshly minted Shine Card(s), ready to share. */}
        <div className="text-6xl lg:text-7xl mb-4">{successEmoji}</div>
        <h2 className="font-display text-2xl lg:text-3xl font-black mb-2">{successHeading}</h2>
        <p className="text-kaya-sand text-sm lg:text-base">
          {formatNames(awardedNames)} received {bodyAmount} for {reason}
        </p>
      </div>
    );
  }

  // ── Field components used by both layouts ─────────────────
  // Multi-select chips: tap to add/remove. A small ✓ overlay confirms
  // selection state on already-selected kids.
  const KidPicker = ({ size = 'sm' }: { size?: 'sm' | 'lg' }) => (
    <>
      <div className={size === 'lg' ? 'grid grid-cols-2 gap-2' : 'flex gap-2 flex-wrap'}>
        {children.map((c) => {
          const sel = selectedChildren.includes(c.id);
          return (
            <button
              key={c.id}
              onClick={() => toggleChild(c.id)}
              aria-pressed={sel}
              className={`relative flex items-center gap-2.5 px-3 py-2.5 rounded-kaya-sm border-2 transition-all ${
                sel ? 'text-white border-transparent shadow-sm' : 'border-kaya-warm-dark bg-white text-kaya-sand hover:border-kaya-sand-light'
              }`}
              style={sel ? { backgroundColor: c.houseColor } : {}}
            >
              <span className="text-base">{c.avatarEmoji}</span>
              <span className="text-sm font-bold">{c.name}</span>
              {sel && (
                <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-white/25 text-[10px] font-black">✓</span>
              )}
            </button>
          );
        })}
      </div>
      {children.length > 1 && (
        <p className="text-[10px] text-kaya-sand-light mt-2">
          Tap each kid you want to award. They&apos;ll all get the same points and message.
          {selectedChildren.length > 0 && children.length > selectedChildren.length && (
            <button
              onClick={() => setSelectedChildren(children.map((c) => c.id))}
              className="ml-2 text-kaya-gold font-semibold hover:underline"
            >
              Select all
            </button>
          )}
          {selectedChildren.length > 0 && (
            <button
              onClick={() => setSelectedChildren([])}
              className="ml-2 text-kaya-sand font-semibold hover:underline"
            >
              Clear
            </button>
          )}
        </p>
      )}
    </>
  );

  const CategoryGrid = ({ cols = 4 }: { cols?: 4 | 8 }) => (
    <div className={cols === 8 ? 'grid grid-cols-4 lg:grid-cols-8 gap-2' : 'grid grid-cols-4 gap-2'}>
      {CATEGORIES.map((c) => {
        const sel = category === c.id;
        return (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            className={`flex flex-col items-center gap-1 p-3 rounded-kaya-sm border transition-all ${
              sel ? 'border-kaya-gold bg-kaya-gold/5 shadow-sm' : 'border-kaya-warm-dark bg-white hover:border-kaya-sand-light'
            }`}
          >
            <span className="text-xl">{c.icon}</span>
            <span className="text-[10px] font-semibold text-kaya-sand leading-tight text-center">{c.label}</span>
          </button>
        );
      })}
    </div>
  );

  // All five award kinds — but the family-config gates which appear.
  // Regular always shows (it's the default). Diamond requires the diamond
  // earning method. Reducing / Kudos / Improvement each require their
  // respective family-setting toggle.
  const kindOptions: Array<{ id: AwardKind; emoji: string; label: string; activeClass: string }> = [
    { id: 'regular',          emoji: '⭐', label: 'Regular',                        activeClass: 'bg-kaya-chocolate text-white' },
    ...(diamondEnabled ? [{ id: 'diamond' as AwardKind, emoji: '💎', label: 'Diamond', activeClass: 'bg-purple-600 text-white shadow-lg shadow-purple-600/30' }] : []),
    ...(pointSystem.reducing.enabled ? [{ id: 'reducing' as AwardKind, emoji: '⚠️', label: 'Reducing', activeClass: 'bg-red-500 text-white shadow-md shadow-red-500/30' }] : []),
    ...(pointSystem.kudos.enabled ? [{ id: 'kudos' as AwardKind, emoji: '👍', label: pointSystem.kudos.label, activeClass: 'bg-emerald-600 text-white shadow-md shadow-emerald-600/30' }] : []),
    ...(pointSystem.improvementNote.enabled ? [{ id: 'improvement_note' as AwardKind, emoji: '👉', label: pointSystem.improvementNote.label, activeClass: 'bg-amber-600 text-white shadow-md shadow-amber-600/30' }] : []),
  ];
  const TypeToggle = () => (
    <div className={`grid gap-2 ${kindOptions.length > 3 ? 'grid-cols-3' : `grid-cols-${kindOptions.length}`}`}>
      {kindOptions.map((opt) => {
        const sel = kind === opt.id;
        return (
          <button
            key={opt.id}
            onClick={() => setKind(opt.id)}
            // min-h instead of fixed h + whitespace-normal so longer
            // labels (e.g. "Improvement Note") wrap to 2 lines inside
            // the chip instead of getting truncated by `truncate`.
            className={`min-h-10 py-1.5 px-2 rounded-kaya-sm font-bold text-[12px] flex items-center justify-center gap-1.5 transition-all ${
              sel ? opt.activeClass : 'bg-kaya-warm text-kaya-sand'
            }`}
          >
            <span className="shrink-0">{opt.emoji}</span>
            <span className="text-center leading-tight whitespace-normal break-words">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );

  const PointsPicker = () => {
    if (isKudos) {
      return (
        <p className="text-xs text-emerald-700 font-semibold leading-relaxed">
          👍 Each {pointSystem.kudos.label} carries no points on its own. Every {pointSystem.kudos.threshold} earns a +{pointSystem.kudos.bonusPoints} bonus automatically.
        </p>
      );
    }
    if (isImprovement) {
      return (
        <p className="text-xs text-amber-700 font-semibold leading-relaxed">
          👉 Each {pointSystem.improvementNote.label} carries no points on its own. {pointSystem.reducing.enabled
            ? `Every ${pointSystem.improvementNote.threshold} takes −${pointSystem.improvementNote.deductionPoints} automatically.`
            : `Tracked only — turn on Reducing in Settings to make deductions take effect.`}
        </p>
      );
    }
    if (isReducing) {
      return (
        <>
          <div className="grid grid-cols-5 gap-2">
            {reducingPointsRange.map((p) => (
              <button
                key={p}
                onClick={() => setReducingPts(p)}
                className={`h-11 rounded-kaya-sm font-bold transition-all ${
                  reducingPts === p ? 'bg-red-500 text-white shadow-md shadow-red-500/30' : 'bg-white border border-kaya-warm-dark text-kaya-sand'
                }`}
              >−{p}</button>
            ))}
          </div>
          <p className="text-xs text-red-600 font-semibold mt-2">⚠️ Reducing — points come off the kid&apos;s total.</p>
        </>
      );
    }
    if (isDiamond) {
      return (
        <>
          <div className="grid grid-cols-4 gap-2">
            {DIAMOND_POINTS.filter((p) => p >= diamondMin).map((p) => (
              <button
                key={p}
                onClick={() => setDiamondPts(p)}
                className={`h-11 rounded-kaya-sm font-bold transition-all ${
                  diamondPts === p ? 'bg-purple-600 text-white shadow-md shadow-purple-600/30' : 'bg-white border border-kaya-warm-dark text-kaya-sand'
                }`}
              >+{p}</button>
            ))}
          </div>
          <p className="text-xs text-purple-600 font-semibold mt-2">💎 Diamond points — parents decide the bonus for exceptional behavior.</p>
        </>
      );
    }
    // Regular (default)
    return (
      <div className="flex gap-2">
        {regularPointsRange.map((p) => (
          <button
            key={p}
            onClick={() => setRegularPts(p)}
            className={`flex-1 h-12 rounded-kaya-sm font-bold transition-all ${
              regularPts === p ? 'bg-kaya-gold text-white shadow-md shadow-kaya-gold/30' : 'bg-white border border-kaya-warm-dark text-kaya-sand'
            }`}
          >+{p}</button>
        ))}
      </div>
    );
  };

  // 🌟 RR PR-2 — tonight's round strip (from the nudge link) + the
  // 🎁 reward-bridge suggestion. Shared by both layouts.
  const bridgeChip = bridge ? (
    <button
      type="button"
      onClick={() => {
        if (bridge.gap < diamondMin) { setKind('regular'); setRegularPts(bridge.gap); }
        else if (diamondEnabled) { setKind('diamond'); setDiamondPts(bridge.gap); }
      }}
      className="w-full text-left rounded-kaya border border-kaya-gold/50 bg-gradient-to-r from-kaya-gold-light/60 to-kaya-warm/40 px-3.5 py-2.5 mb-4"
    >
      <p className="text-[12px] font-bold">
        🎁 {bridge.kidName} is {bridge.gap} pts from {bridge.reward.icon} <b>{bridge.reward.title}</b> — tap to award exactly +{bridge.gap} and unlock it.
      </p>
    </button>
  ) : null;

  return (
    <>
      {/* ─────────────────────────────────────────────────────────── */}
      {/* MOBILE (< lg) — preserved                                    */}
      {/* ─────────────────────────────────────────────────────────── */}
      <div className="lg:hidden mx-auto max-w-md w-full px-4 pt-4">
        <BackButton />
        <div className="mb-5">
          <h1 className="font-display text-2xl font-black">Award Points</h1>
          <p className="text-kaya-sand text-sm">Recognize great behavior with bonus points</p>
        </div>
        {bridgeChip}

        <div className="mb-5">
          <label className="block text-xs font-semibold text-kaya-sand mb-2 uppercase tracking-wider">Who deserves points?</label>
          <KidPicker />
        </div>

        <div className="mb-5">
          <label className="block text-xs font-semibold text-kaya-sand mb-2 uppercase tracking-wider">What for?</label>
          <CategoryGrid />
        </div>

        {showTypeToggle && (
          <div className="mb-4">
            <label className="block text-xs font-semibold text-kaya-sand mb-2 uppercase tracking-wider">Points type</label>
            <TypeToggle />
          </div>
        )}

        <div className="mb-5">
          <label className="block text-xs font-semibold text-kaya-sand mb-2 uppercase tracking-wider">{pointsSectionLabel}</label>
          <PointsPicker />
        </div>

        <div className="mb-6">
          <label className="block text-xs font-semibold text-kaya-sand mb-2 uppercase tracking-wider">📅 When did this happen?</label>
          <input
            type="date"
            value={happenedOn}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setHappenedOn(e.target.value)}
            className="w-full h-11 px-3 mb-4 bg-kaya-cream rounded-kaya-sm text-sm focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
          />
          <label className="block text-xs font-semibold text-kaya-sand mb-2 uppercase tracking-wider">Tell them why (they&apos;ll see this!)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full h-24 px-4 py-3 bg-white border border-kaya-warm-dark rounded-kaya-sm text-sm resize-none focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
            placeholder="e.g. You helped your sister with homework without being asked!"
          />
        </div>

        <button
          onClick={handleAward}
          disabled={!canSubmit}
          className={`w-full h-[52px] rounded-kaya font-bold text-sm disabled:opacity-40 transition-colors ${accentButtonClass}`}
        >
          {submitLabel}
        </button>
      </div>

      {/* ─────────────────────────────────────────────────────────── */}
      {/* DESKTOP (lg+) — form left, live preview right                */}
      {/* Web-Fit (2026-08-23): content tier (1040, centred) — this     */}
      {/* block is desktop-only; the mobile block above is untouched.   */}
      {/* ─────────────────────────────────────────────────────────── */}
      <div className={`hidden lg:block mx-auto ${PAGE_WIDTH_CLASS.content} w-full px-8 py-8`}>
        <div className="mb-7 flex items-end justify-between">
          <div>
            <h1 className="font-display text-[34px] leading-tight font-extrabold tracking-tight">Award points</h1>
            <p className="text-sm text-kaya-sand mt-1">Catch a kindness. Recognise the wins, big and small.</p>
          </div>
        </div>

        {bridgeChip}
        <div className="grid grid-cols-12 gap-6">
          {/* Form column */}
          <section className="col-span-8 space-y-6">
            <div className="bg-white border border-kaya-warm-dark/70 rounded-kaya-lg p-6">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-kaya-sand mb-3">Who deserves points?</p>
              <KidPicker size="lg" />
            </div>

            <div className="bg-white border border-kaya-warm-dark/70 rounded-kaya-lg p-6">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-kaya-sand mb-3">What for?</p>
              <CategoryGrid cols={8} />
            </div>

            <div className={showTypeToggle ? 'grid grid-cols-2 gap-6' : ''}>
              {showTypeToggle && (
                <div className="bg-white border border-kaya-warm-dark/70 rounded-kaya-lg p-6">
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-kaya-sand mb-3">Points type</p>
                  <TypeToggle />
                </div>
              )}
              <div className="bg-white border border-kaya-warm-dark/70 rounded-kaya-lg p-6">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-kaya-sand mb-3">
                  {pointsSectionLabel}
                </p>
                <PointsPicker />
              </div>
            </div>

            <div className="bg-white border border-kaya-warm-dark/70 rounded-kaya-lg p-6">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-kaya-sand mb-3">📅 When did this happen?</p>
              <input
                type="date"
                value={happenedOn}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setHappenedOn(e.target.value)}
                className="w-full h-11 px-3 bg-kaya-cream/60 border border-kaya-warm-dark rounded-kaya-sm text-sm focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
              />
              <p className="text-[11px] text-kaya-sand-light mt-2">
                Defaults to today. Pick an earlier day when you&apos;re catching up at the meeting — the points count on the day it actually happened, not today.
              </p>
            </div>

            <div className="bg-white border border-kaya-warm-dark/70 rounded-kaya-lg p-6">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-kaya-sand mb-3">Tell them why (they&apos;ll see this)</p>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                className="w-full px-4 py-3 bg-kaya-cream/60 border border-kaya-warm-dark rounded-kaya-sm text-sm resize-none focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
                placeholder="e.g. You helped your sister with homework without being asked!"
              />
            </div>
          </section>

          {/* Preview column */}
          <aside className="col-span-4">
            <div className="sticky top-20 space-y-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-kaya-sand px-1">Preview</p>

              <div
                className={`rounded-kaya-lg p-6 text-white shadow-xl bg-gradient-to-br ${accentGradient}`}
              >
                <div className="flex items-center gap-3 mb-4">
                  {child ? (
                    <KidAvatar child={child} size="lg" shape="square" bgOpacity="40" />
                  ) : (
                    <div className="w-12 h-12 rounded-[14px] bg-white/10 flex items-center justify-center text-xl">👤</div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] opacity-70">For</p>
                    <p className="font-display font-bold text-lg truncate">
                      {selectedKidObjs.length === 0
                        ? 'Pick a child'
                        : selectedKidObjs.length === 1
                          ? selectedKidObjs[0].name
                          : `${selectedKidObjs[0].name} + ${selectedKidObjs.length - 1} other${selectedKidObjs.length > 2 ? 's' : ''}`}
                    </p>
                  </div>
                  {isDiamond && <span className="text-2xl">💎</span>}
                  {isReducing && <span className="text-2xl">⚠️</span>}
                </div>

                <div className="flex items-baseline gap-2 mb-4">
                  <span className="font-display font-black text-6xl">{previewBigNumber}</span>
                  <span className="text-sm opacity-70">
                    {previewUnitLabel}{selectedKidObjs.length > 1 && !isKudos && !isImprovement ? ' each' : ''}
                  </span>
                </div>

                <div className="border-t border-white/15 pt-4 space-y-2.5">
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="text-base">{cat?.icon || '✨'}</span>
                    <span className="opacity-80">{cat?.label || 'Pick a category'}</span>
                  </div>
                  <p className="text-[13px] leading-relaxed opacity-90 italic">
                    {reason ? `"${reason}"` : <span className="opacity-60 not-italic">Your message will appear here…</span>}
                  </p>
                  <p className="text-[10px] opacity-50 pt-1">From {profile?.displayName || 'You'}</p>
                </div>
              </div>

              <button
                onClick={handleAward}
                disabled={!canSubmit}
                className={`w-full h-[52px] rounded-kaya font-bold text-sm disabled:opacity-40 transition-colors ${accentButtonClass}`}
              >
                {submitLabel}
              </button>

              <p className="text-[11px] text-kaya-sand-light px-1 leading-relaxed">
                Awards land in {selectedKidObjs.length > 1 ? 'each kid’s' : (child?.name ? `${child.name}’s` : 'their')} activity feed and family score immediately.
              </p>
            </div>
          </aside>
        </div>
        <NextUp from="award" />
      </div>
      <CoachMark
        pageId="award"
        uid={profile?.uid || ''}
        title="Catch a kindness"
        body="Pick a kid, choose a tag, write what they did. The kids see it in their activity feed."
      />
    </>
  );
}
