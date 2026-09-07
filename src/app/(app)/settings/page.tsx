'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { useFamily } from '@/contexts/FamilyContext';
import { useConfirm } from '@/contexts/ConfirmContext';
import {
  updateFamily, updateUserProfile, addChild, ensureReferralCode, type Child,
  getReferredFamilies, isHandleAvailable, Family, PointsMode,
  Gender, BirthdayPrivacy, ExternalContact,
  addExternalContact, updateExternalContact, removeExternalContact,
  PointSystemConfig, readPointSystemConfig,
  ensureInviteCodes, setInviteCodeActive, regenerateInviteCode,
  InviteCodeState,
  getFamilyMembers, removeUserFromFamily, UserProfile,
  updateChild,
} from '@/lib/firestore';
import { filterListedMembers, hiddenHelperCount } from '@/lib/helperVisibility';
import { AvatarEmojiPickerModal } from '@/components/ui/AvatarEmojiPicker';
import { defaultAvatarEmoji } from '@/lib/avatarEmojis';
import {
  normalizeHandle, handleErrorMessage, suggestFamilyHandles,
  formatFamilyHandle, formatPersonHandle, handleToSlug,
} from '@/lib/handles';
import { fileToAvatarDataUrl } from '@/lib/imageUpload';
import { AVATAR_PRESETS, AVATAR_GROUPS, generateAvatarFromName } from '@/lib/avatarPresets';
import { toDisplayDate, monthDayOf, dayOfWeek, daysToNextBirthday, ageNow, ageAtNextBirthday } from '@/lib/dates';
import KidWelcomeWizard from '@/components/family/KidWelcomeWizard';
import { readParticipationAges, isLittleStar, profileUnfinished } from '@/lib/participation';
import AiLevelCard from '@/components/settings/AiLevelCard';
import { readAiConfig, aiLevelMeta } from '@/lib/ai/level.shared';
import { milestoneForYear, ordinal } from '@/lib/anniversaryMilestones';
import {
  bornOnThisDay, eventsOnThisDay,
  BornOnThisDayPerson, OnThisDayEvent,
} from '@/lib/onThisDay';
import {
  EARNING_METHODS, DEFAULT_EARNING_METHODS, FREE_EARNING_METHOD_LIMIT,
  isMethodSelectable,
} from '@/lib/earningMethods';
import { KID_MODULES, DEFAULT_KID_MODULES } from '@/lib/kidModules';
import {
  COUNTRIES, COUNTRY_REGION_LABELS, countryToCurrency, currencyMeta,
  type CountryMeta,
} from '@/lib/hive';
import { useRef } from 'react';
import {
  BADGES, topBadge, nextBadge, progressToNextBadge,
  effectiveCount, referralLink, formatKc, formatKcUsd, formatCharterNumber,
} from '@/lib/referral';
import { ReferralBadge } from '@/components/referral/ReferralBadge';
import { KayaCoin } from '@/components/referral/KayaCoin';
import BackButton from '@/components/ui/BackButton';
import DateSelect from '@/components/ui/DateSelect';
import LanguageCard from '@/components/settings/LanguageCard';
import SettingsQuickFind from '@/components/settings/SettingsQuickFind';
import SecurityPrivacyCard from '@/components/settings/SecurityPrivacyCard';
import KidPrivacyCard from '@/components/settings/KidPrivacyCard';
import { localeLabel, localeForCountry, asLocale } from '@/lib/i18n';
import EmailGroupsCard from '@/components/settings/EmailGroupsCard';
import PeopleBookCard from '@/components/settings/PeopleBookCard';
import GreetingSignatureCard from '@/components/settings/GreetingSignatureCard';
import PointsAudienceRow from '@/components/settings/PointsAudienceRow';
import { CollapsibleSection } from '@/components/ui/CollapsibleSection';
import RoutinesEditor from '@/components/settings/RoutinesEditor';
import NotificationSettings from '@/components/settings/NotificationSettings';
import { useTierAccess } from '@/lib/tierAccess';
import { DEFAULT_TIERS } from '@/lib/tiers';

export default function SettingsPage() {
  const router = useRouter();
  const { user, profile, signOut, refreshProfile, isGuest } = useAuth();
  const { family, children, refresh } = useFamily();
  const confirmAction = useConfirm();
  const tierAccess = useTierAccess();
  const currentTierConfig = DEFAULT_TIERS[tierAccess.tierId];

  const [showInvite, setShowInvite] = useState(false);
  const [copied, setCopied] = useState(false);
  // Per-role invite codes — full lifecycle state (code + active +
  // timestamps). Resolved from family.inviteCodes via
  // ensureInviteCodes(), which lazily generates / migrates older
  // shapes so pre-lifecycle families pick them up on first Settings
  // open.
  const [inviteCodes, setInviteCodes] = useState<{ kid: InviteCodeState; helper: InviteCodeState; guest: InviteCodeState } | null>(null);
  const [copiedCode, setCopiedCode] = useState<'kid' | 'helper' | 'guest' | null>(null);
  // Per-row "doing something" indicators so multi-tap can't race.
  const [busyCode, setBusyCode] = useState<{ role: 'kid'|'helper'|'guest'; op: 'toggle'|'regen' } | null>(null);
  // Family members panel — list of every UserProfile attached to this
  // family. Lets parents audit who has access and remove anyone they
  // didn't intend (e.g. a stale helper, an unknown joiner). Refreshes
  // after a removal so the row vanishes without a page reload.
  const [members, setMembers] = useState<UserProfile[] | null>(null);
  const [removingMember, setRemovingMember] = useState<string | null>(null);
  const [newChildName, setNewChildName] = useState('');
  // Avatar picker (approved 2026-07-20): tap a kid's emoji to change it.
  const [avatarChild, setAvatarChild] = useState<{ id: string; name: string; avatarEmoji?: string } | null>(null);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [pointsMode, setPointsMode] = useState<PointsMode>(family?.pointsMode || 'full');
  const [savingMethod, setSavingMethod] = useState<string | null>(null);
  const [savingGenderOption, setSavingGenderOption] = useState(false);
  // Point system config — editable from the "Point system rules" card.
  // Label inputs are debounced via local draft state to avoid hammering
  // Firestore on every keystroke; numeric pickers and toggles save immediately.
  const pointSystem = readPointSystemConfig(family);
  const [kudosLabelDraft, setKudosLabelDraft] = useState(pointSystem.kudos.label);
  const [improvementLabelDraft, setImprovementLabelDraft] = useState(pointSystem.improvementNote.label);
  // Local draft for the custom RP→HP rate input. Synced on family load
  // so external changes propagate, but free to edit independently while
  // the user is typing.
  const [rpRateDraft, setRpRateDraft] = useState<string>(String(pointSystem.routines.pointsPerHousePoint));
  const [savingPointSystem, setSavingPointSystem] = useState<string | null>(null);

  // Display name editor
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState('');

  // Personal handle editor
  const [editingMyHandle, setEditingMyHandle] = useState(false);
  const [myHandleInput, setMyHandleInput] = useState('');
  const [myHandleError, setMyHandleError] = useState('');
  const [savingMyHandle, setSavingMyHandle] = useState(false);

  // Personal birthday + privacy editor
  const [editingMyBirthday, setEditingMyBirthday] = useState(false);
  const [myBdayInput, setMyBdayInput] = useState('');
  const [myBdayPrivacy, setMyBdayPrivacy] = useState<BirthdayPrivacy>('partial');
  const [myBdayError, setMyBdayError] = useState('');
  const [savingMyBirthday, setSavingMyBirthday] = useState(false);

  // Personal avatar
  const [pickingMyAvatar, setPickingMyAvatar] = useState(false);
  const [savingMyAvatar, setSavingMyAvatar] = useState<string | null>(null);
  const [myAvatarError, setMyAvatarError] = useState('');
  const myAvatarRef = useRef<HTMLInputElement | null>(null);

  // Saving gender (no editor screen — chips inline)
  const [savingGender, setSavingGender] = useState(false);

  // On-this-day for the signed-in user
  const [myBornToday, setMyBornToday] = useState<BornOnThisDayPerson[]>([]);
  const [myEventsToday, setMyEventsToday] = useState<OnThisDayEvent[]>([]);

  const startEditingMyHandle = () => {
    setMyHandleInput(profile?.handle || '');
    setMyHandleError('');
    setEditingMyHandle(true);
  };

  const saveMyHandle = async () => {
    if (!user || isGuest) return;
    const canonical = normalizeHandle(myHandleInput);
    if (!canonical) {
      setMyHandleError(handleErrorMessage(myHandleInput) || 'Invalid handle.');
      return;
    }
    if (canonical.toLowerCase() === (profile?.handle || '').toLowerCase()) {
      setEditingMyHandle(false);
      return;
    }
    setSavingMyHandle(true);
    setMyHandleError('');
    try {
      const ok = await isHandleAvailable(canonical, { userUid: user.uid });
      if (!ok) {
        setMyHandleError(`@${canonical} is already taken — try another.`);
        setSavingMyHandle(false);
        return;
      }
      await updateUserProfile(user.uid, {
        handle: canonical,
        handleLower: canonical.toLowerCase(),
      } as any);
      await refreshProfile();
      setEditingMyHandle(false);
    } catch (e: any) {
      setMyHandleError(e?.message || 'Failed to save handle');
    }
    setSavingMyHandle(false);
  };

  // Referral panel
  const [referralCode, setReferralCode] = useState<string>('');
  const [referredFamilies, setReferredFamilies] = useState<Family[]>([]);
  const [refLinkCopied, setRefLinkCopied] = useState(false);

  // Notification prefs (default: opt-in)
  const notifyOnRating = profile?.notifyOnRating !== false;
  const notifyOnAward = profile?.notifyOnAward !== false;
  const [savingPref, setSavingPref] = useState<'rating' | 'award' | null>(null);

  // External contacts (email-only people who get rating/award emails)
  const externalContacts: ExternalContact[] = family?.externalContacts || [];
  const [contactDraft, setContactDraft] = useState({ name: '', email: '' });
  const [contactDraftError, setContactDraftError] = useState('');
  const [savingContact, setSavingContact] = useState(false);
  const [contactBusy, setContactBusy] = useState<string | null>(null); // contact id

  const submitNewContact = async () => {
    if (!profile?.familyId || !profile.uid) return;
    setContactDraftError('');
    setSavingContact(true);
    try {
      await addExternalContact(profile.familyId, {
        name: contactDraft.name,
        email: contactDraft.email,
        addedBy: profile.uid,
      });
      setContactDraft({ name: '', email: '' });
      await refresh();
    } catch (e: any) {
      setContactDraftError(e?.message || 'Could not add contact.');
    } finally {
      setSavingContact(false);
    }
  };

  const toggleContactPref = async (
    contact: ExternalContact,
    which: 'notifyOnRating' | 'notifyOnAward',
  ) => {
    if (!profile?.familyId) return;
    setContactBusy(contact.id);
    try {
      await updateExternalContact(profile.familyId, contact.id, {
        [which]: !(contact[which] !== false), // flip current effective value
      });
      await refresh();
    } catch {
      // noop — toggle stays as-is
    } finally {
      setContactBusy(null);
    }
  };

  const deleteContact = async (contact: ExternalContact) => {
    if (!profile?.familyId) return;
    const ok = await confirmAction({
      title: `Remove ${contact.name}?`,
      message: `${contact.email} will be removed from notification contacts.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    setContactBusy(contact.id);
    try {
      await removeExternalContact(profile.familyId, contact.id);
      await refresh();
    } finally {
      setContactBusy(null);
    }
  };

  // Family handle + photo
  const [editingHandle, setEditingHandle] = useState(false);
  const [handleInput, setHandleInput] = useState('');
  const [handleError, setHandleError] = useState('');
  const [savingHandle, setSavingHandle] = useState(false);
  const [savingFamilyPhoto, setSavingFamilyPhoto] = useState(false);
  const [familyPhotoError, setFamilyPhotoError] = useState('');
  const familyPhotoRef = useRef<HTMLInputElement | null>(null);

  // Family anniversary (shared across both parents — lives on the Family doc)
  const [editingAnniversary, setEditingAnniversary] = useState(false);
  const [anniversaryInput, setAnniversaryInput] = useState('');
  const [anniversaryNameInput, setAnniversaryNameInput] = useState('');
  const [anniversaryError, setAnniversaryError] = useState('');
  const [savingAnniversary, setSavingAnniversary] = useState(false);
  const [anniversarySaved, setAnniversarySaved] = useState(false);

  const startEditingAnniversary = () => {
    setAnniversaryInput(family?.anniversary || '');
    setAnniversaryNameInput(family?.anniversaryName || '');
    setAnniversaryError('');
    setEditingAnniversary(true);
  };

  const saveAnniversary = async () => {
    if (!profile?.familyId || !family || isGuest) return;
    const trimmed = anniversaryInput.trim();
    const trimmedName = anniversaryNameInput.trim().slice(0, 60);
    if (trimmed && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      setAnniversaryError('Pick a valid date.');
      return;
    }
    setSavingAnniversary(true);
    setAnniversaryError('');
    try {
      await updateFamily(profile.familyId, {
        anniversary: trimmed || null,
        anniversaryName: trimmedName || null,
      } as any);
      setEditingAnniversary(false);
      setAnniversarySaved(true);
      setTimeout(() => setAnniversarySaved(false), 2200);
    } catch (e: any) {
      setAnniversaryError(e?.message || 'Failed to save anniversary.');
    }
    setSavingAnniversary(false);
  };

  const startEditingHandle = () => {
    setHandleInput(family?.handle || (family?.name ? suggestFamilyHandles(family.name)[0] || '' : ''));
    setHandleError('');
    setEditingHandle(true);
  };

  const saveHandle = async () => {
    if (!profile?.familyId || !family || isGuest) return;
    const canonical = normalizeHandle(handleInput);
    if (!canonical) {
      setHandleError(handleErrorMessage(handleInput) || 'Invalid handle.');
      return;
    }
    if (canonical.toLowerCase() === (family.handle || '').toLowerCase()) {
      setEditingHandle(false);
      return;
    }
    setSavingHandle(true);
    setHandleError('');
    try {
      const ok = await isHandleAvailable(canonical, { familyId: family.id });
      if (!ok) {
        setHandleError('That handle is taken — try another.');
        setSavingHandle(false);
        return;
      }
      await updateFamily(profile.familyId, {
        handle: canonical,
        handleLower: canonical.toLowerCase(),
      } as any);
      setEditingHandle(false);
    } catch (e: any) {
      setHandleError(e?.message || 'Failed to save handle.');
    }
    setSavingHandle(false);
  };

  const handleFamilyPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !profile?.familyId) return;
    setFamilyPhotoError('');
    setSavingFamilyPhoto(true);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      await updateFamily(profile.familyId, { photoUrl: dataUrl } as any);
    } catch (err: any) {
      setFamilyPhotoError(err?.message || 'Could not process that image.');
    }
    setSavingFamilyPhoto(false);
  };

  const removeFamilyPhoto = async () => {
    if (!profile?.familyId) return;
    setSavingFamilyPhoto(true);
    try {
      await updateFamily(profile.familyId, { photoUrl: '' } as any);
    } catch {}
    setSavingFamilyPhoto(false);
  };

  const togglePref = async (which: 'rating' | 'award') => {
    if (!user || isGuest) return;
    const field = which === 'rating' ? 'notifyOnRating' : 'notifyOnAward';
    const current = which === 'rating' ? notifyOnRating : notifyOnAward;
    setSavingPref(which);
    try {
      await updateUserProfile(user.uid, { [field]: !current } as any);
      await refreshProfile();
    } catch {
      // ignore — UI will resync from profile on next refresh
    }
    setSavingPref(null);
  };

  useEffect(() => {
    if (family?.pointsMode) setPointsMode(family.pointsMode);
  }, [family?.pointsMode]);

  // Re-sync the label drafts when the family doc reloads (e.g., after a
  // remote save by another parent). Skip when the user is mid-edit — the
  // simplest signal is "draft matches the previous source value".
  useEffect(() => {
    setKudosLabelDraft(pointSystem.kudos.label);
    setImprovementLabelDraft(pointSystem.improvementNote.label);
    setRpRateDraft(String(pointSystem.routines.pointsPerHousePoint));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family?.pointSystem?.kudos?.label, family?.pointSystem?.improvementNote?.label, family?.pointSystem?.routines?.pointsPerHousePoint]);

  // Load Wikipedia panels for the signed-in user when their birthday is set.
  // Mirrors the kid profile behaviour so parents see the same surfaces.
  useEffect(() => {
    setMyBornToday([]);
    setMyEventsToday([]);
    if (!profile?.birthday) return;
    const md = monthDayOf(profile.birthday);
    if (!md) return;
    const g = (profile.gender || 'unspecified') as Gender;
    bornOnThisDay(md.month, md.day, 5, g).then(setMyBornToday).catch(() => setMyBornToday([]));
    eventsOnThisDay(md.month, md.day, 5).then(setMyEventsToday).catch(() => setMyEventsToday([]));
  }, [profile?.birthday, profile?.gender]);

  const startEditingMyBirthday = () => {
    setMyBdayInput(profile?.birthday || '');
    setMyBdayPrivacy((profile?.birthdayPrivacy || 'partial') as BirthdayPrivacy);
    setMyBdayError('');
    setEditingMyBirthday(true);
  };

  const saveMyBirthday = async () => {
    if (!user || isGuest) return;
    const trimmed = myBdayInput.trim();
    if (trimmed && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      setMyBdayError('Pick a valid date.');
      return;
    }
    setSavingMyBirthday(true);
    setMyBdayError('');
    try {
      const updates: Record<string, unknown> = { birthdayPrivacy: myBdayPrivacy };
      if (trimmed) updates.birthday = trimmed;
      await updateUserProfile(user.uid, updates as any);
      await refreshProfile();
      setEditingMyBirthday(false);
    } catch (e: any) {
      setMyBdayError(e?.message || 'Failed to save');
    }
    setSavingMyBirthday(false);
  };

  // Saved gender folds behind a "Change" link (no stray-tap switches).
  const genderSet = !!profile?.gender && profile.gender !== 'unspecified';
  const [genderEditOpen, setGenderEditOpen] = useState(false);
  const setMyGender = async (gender: Gender) => {
    if (!user || isGuest || savingGender) return;
    if ((profile?.gender || 'unspecified') === gender) { setGenderEditOpen(false); return; }
    setSavingGender(true);
    try {
      await updateUserProfile(user.uid, { gender } as any);
      await refreshProfile();
      setGenderEditOpen(false);
    } catch {}
    setSavingGender(false);
  };

  const chooseMyAvatar = async (url: string) => {
    if (!user || isGuest) return;
    setSavingMyAvatar(url || 'remove');
    setMyAvatarError('');
    try {
      await updateUserProfile(user.uid, { avatarPhoto: url } as any);
      await refreshProfile();
      setPickingMyAvatar(false);
    } catch (e: any) {
      setMyAvatarError(e?.message || 'Failed to save avatar');
    }
    setSavingMyAvatar(null);
  };

  const handleMyAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMyAvatarError('');
    setSavingMyAvatar('upload');
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      await chooseMyAvatar(dataUrl);
    } catch (err: any) {
      setMyAvatarError(err?.message || 'Could not process that image.');
      setSavingMyAvatar(null);
    }
  };

  // A KID's birthday lives on their Child doc (parents set it in Kid
  // Profiles); the users doc only carries a parent's own birthday. Resolve
  // kid-first so kids actually see theirs (Elia fix, 24-Jul-2026).
  const myChildDoc = profile?.role === 'kid' && profile.childId
    ? children.find((c) => c.id === profile.childId)
    : undefined;
  const effectiveMyBirthday = myChildDoc?.birthday || profile?.birthday;

  // What the birthday should display as, given the privacy choice.
  // Used both inline (the read-only profile card) and to decide whether the
  // Wikipedia panels show year-specific copy.
  const myBirthdayDisplay = (() => {
    if (!effectiveMyBirthday) return null;
    const privacy = (profile?.birthdayPrivacy || 'partial') as BirthdayPrivacy;
    if (privacy === 'private') return null;
    const md = monthDayOf(effectiveMyBirthday);
    if (privacy === 'partial' && md) {
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${parseInt(md.day, 10)}-${monthNames[parseInt(md.month, 10) - 1]}`;
    }
    return toDisplayDate(effectiveMyBirthday);
  })();

  useEffect(() => {
    if (!family) return;
    (async () => {
      const code = await ensureReferralCode(family);
      setReferralCode(code);
      const list = await getReferredFamilies(family.id);
      setReferredFamilies(list);
    })();
  }, [family]);

  const directCount = family?.referralCount ?? referredFamilies.length;
  const compoundCount = family?.compoundCredit ?? 0;
  const totalCredit = effectiveCount(directCount, compoundCount);
  const top = topBadge(directCount, compoundCount);
  const nextB = nextBadge(directCount, compoundCount);
  const badgePct = Math.round(progressToNextBadge(directCount, compoundCount) * 100);
  const kc = family?.kayaCoins ?? 0;
  const fullRefLink = referralCode ? referralLink(referralCode) : '';

  const copyRefLink = () => {
    if (!fullRefLink) return;
    navigator.clipboard.writeText(fullRefLink);
    setRefLinkCopied(true);
    setTimeout(() => setRefLinkCopied(false), 2000);
  };

  const shareWhatsApp = () => {
    if (!fullRefLink) return;
    const text = encodeURIComponent(
      `I'm using Kaya to make our family routines feel less like nagging — give it a try with my link: ${fullRefLink}`,
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  };

  const shareEmail = () => {
    if (!fullRefLink) return;
    const subject = encodeURIComponent('Try Kaya — my invite link');
    const body = encodeURIComponent(
      `I'm using Kaya to track our family routines, points and weekly meetings. If you start your family with my link, I earn a referral badge toward the Kaya wall of fame:\n\n${fullRefLink}`,
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  const startEditingName = () => {
    setNameInput(profile?.displayName || '');
    setNameError('');
    setEditingName(true);
  };

  const cancelEditingName = () => {
    setEditingName(false);
    setNameError('');
  };

  const saveName = async () => {
    if (!user || isGuest) return;
    const trimmed = nameInput.trim();
    if (!trimmed) { setNameError('Name cannot be empty'); return; }
    if (trimmed === profile?.displayName) { setEditingName(false); return; }
    setSavingName(true);
    setNameError('');
    try {
      await updateUserProfile(user.uid, { displayName: trimmed });
      await refreshProfile();
      setEditingName(false);
    } catch (e: any) {
      setNameError(e.message || 'Failed to save');
    }
    setSavingName(false);
  };

  const copyInviteCode = () => {
    if (!family?.inviteCode) return;
    navigator.clipboard.writeText(family.inviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Resolve all three per-role codes once the family doc loads.
  // ensureInviteCodes writes any missing codes through to Firestore so
  // the family doc converges on the new shape with zero parent action.
  useEffect(() => {
    if (!family || isGuest) return;
    let cancelled = false;
    (async () => {
      try {
        const codes = await ensureInviteCodes(family);
        if (!cancelled) setInviteCodes(codes);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [family, isGuest]);

  // Load family members alongside the invite codes — the "who has
  // access" answer pairs with "how do they get in" on the same screen.
  // Re-fetches when family.id changes (e.g. user switches families).
  useEffect(() => {
    if (!profile?.familyId || isGuest) {
      setMembers(null);
      return;
    }
    let cancelled = false;
    getFamilyMembers(profile.familyId)
      .then((m) => { if (!cancelled) setMembers(m); })
      .catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [profile?.familyId, isGuest]);

  // 🤝 2026-08-25 — outside helpers (no kid assigned in Settings →
  // Helpers, or paused/removed) don't populate this roster either. They
  // are NOT invisible: the muted line below counts them and links to the
  // helper manager, which is never filtered. `members` keeps the full
  // list so the count stays truthful.
  const listedMembers = members === null ? null : filterListedMembers(members, profile?.uid);
  const hiddenHelpers = members === null ? 0 : hiddenHelperCount(members, profile?.uid);

  const handleRemoveMember = async (m: UserProfile) => {
    if (!profile || removingMember) return;
    if (m.uid === profile.uid) return; // can't remove yourself
    const label = m.displayName || m.email || 'this member';
    const ok = await confirmAction({
      title: `Remove ${label} from your family?`,
      message: 'They keep their account but lose access until you add them back.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    setRemovingMember(m.uid);
    try {
      await removeUserFromFamily(m.uid);
      setMembers((prev) => (prev ? prev.filter((x) => x.uid !== m.uid) : prev));
    } catch {}
    setRemovingMember(null);
  };

  const copyRoleCode = (role: 'kid' | 'helper' | 'guest') => {
    const code = inviteCodes?.[role]?.code;
    if (!code) return;
    navigator.clipboard.writeText(code);
    setCopiedCode(role);
    setTimeout(() => setCopiedCode((cur) => (cur === role ? null : cur)), 2000);
  };

  // Pre-filled invite copy used by the WhatsApp + Email share buttons.
  // Falls back to a generic origin string when window isn't available
  // (SSR — though this whole page is 'use client', so it's fine).
  const buildShareMessage = (role: 'kid' | 'helper' | 'guest', code: string): { subject: string; body: string } => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://ourkaya.com';
    const familyName = family?.name || 'our family';
    if (role === 'kid') {
      return {
        subject: `Welcome to ${familyName} on Kaya 🎉`,
        body: `Hi! Welcome to ${familyName} on Kaya 🎉\n\nTap to set up your account: ${origin}/onboarding\n\nUse this invite code: ${code}\n\nThe code is single-use, so don't share it with anyone else.`,
      };
    }
    if (role === 'helper') {
      return {
        subject: `Join ${familyName} on Kaya as a helper`,
        body: `Hi! ${familyName} would like you to join their Kaya family as a helper.\n\nSign in: ${origin}/onboarding\n\nInvite code: ${code}\n\nThanks!`,
      };
    }
    return {
      subject: `Follow ${familyName} on Kaya`,
      body: `Hi! ${familyName} would love for you to follow along on Kaya.\n\nSign in here: ${origin}/onboarding\n\nGuest invite code: ${code}`,
    };
  };

  const shareViaWhatsApp = (role: 'kid' | 'helper' | 'guest') => {
    const code = inviteCodes?.[role];
    if (!code) return;
    const { body } = buildShareMessage(role, code.code);
    const url = `https://wa.me/?text=${encodeURIComponent(body)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const shareViaEmail = (role: 'kid' | 'helper' | 'guest') => {
    const code = inviteCodes?.[role];
    if (!code) return;
    const { subject, body } = buildShareMessage(role, code.code);
    // mailto: opens the user's default mail client with the message
    // pre-filled. Works on every device — no backend email plumbing.
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const toggleCodeActive = async (role: 'kid' | 'helper' | 'guest') => {
    if (!profile?.familyId || !inviteCodes || busyCode) return;
    const current = inviteCodes[role];
    setBusyCode({ role, op: 'toggle' });
    // Optimistic: flip the local state immediately so the UI feels
    // instant; the server write follows.
    setInviteCodes({ ...inviteCodes, [role]: { ...current, active: !current.active } });
    try {
      await setInviteCodeActive(profile.familyId, role, !current.active);
    } catch {
      // Rollback on failure.
      setInviteCodes({ ...inviteCodes, [role]: current });
    }
    setBusyCode(null);
  };

  const regenerateCode = async (role: 'kid' | 'helper' | 'guest') => {
    if (!profile?.familyId || !inviteCodes || busyCode) return;
    const ok = await confirmAction({
      title: 'Regenerate this code?',
      message: 'The old code will stop working immediately.',
      confirmLabel: 'Regenerate',
      tone: 'danger',
    });
    if (!ok) return;
    setBusyCode({ role, op: 'regen' });
    try {
      const newCode = await regenerateInviteCode(profile.familyId, role);
      // Server marks the new code inactive — parent must activate
      // before sharing. Update local state to match.
      setInviteCodes({ ...inviteCodes, [role]: { code: newCode, active: false } });
    } catch {}
    setBusyCode(null);
  };

  // Welcome Wizard (2026-07-26) — opens right after a quick-add, and from
  // the ✎ Finish-profile chip on any kid with missing basics.
  const [wizardChild, setWizardChild] = useState<Child | null>(null);

  const handleAddChild = async () => {
    if (!profile?.familyId || !newChildName.trim()) return;
    setAddingChild(true);
    const colors = ['#D4A017', '#7B9DB7', '#9B8EC4', '#C0392B', '#27AE60', '#2980B9'];

    const idx = children.length % colors.length;
    const newChild = {
      name: newChildName.trim(),
      houseName: `House ${children.length + 1}`,
      houseColor: colors[idx],
      avatarEmoji: defaultAvatarEmoji(children.length),
      totalPoints: 0,
      weeklyPoints: 0,
      streak: 0,
      badges: [],
    };
    const childId = await addChild(profile.familyId, newChild as any);
    setNewChildName('');
    setAddingChild(false);
    await refresh();
    // Open the Welcome Wizard for the freshly-added kid (design §1).
    setWizardChild({ id: childId, ...newChild } as Child);
  };

  // Little Stars — family-default participation ages (design §2).
  const partAges = readParticipationAges(family);
  // 🤖 Kaya AI level — folded-header summary for the Settings card.
  const aiLevelFamily = aiLevelMeta(readAiConfig(family).defaultLevel);
  const setAge = async (key: 'sparksFromAge' | 'meetingsFromAge', value: number) => {
    if (!profile?.familyId || !Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(18, Math.round(value)));
    if (next === partAges[key]) return;
    await updateFamily(profile.familyId, {
      participationAges: { ...family?.participationAges, [key]: next },
    } as any);
    await refresh();
  };
  const bumpAge = (key: 'sparksFromAge' | 'meetingsFromAge', delta: number) =>
    setAge(key, partAges[key] + delta);
  const celebrationDays = Math.max(0, Math.min(60, Number((family as any)?.celebrationDays ?? 14)));
  // 2026-08-02 (Elia): the number itself is now editable — tap it and type an
  // exact value instead of stepping ±. Same clamps as the steppers.
  const setCelebration = async (value: number) => {
    if (!profile?.familyId || !Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(60, Math.round(value)));
    if (next === celebrationDays) return;
    await updateFamily(profile.familyId, { celebrationDays: next } as any);
    await refresh();
  };
  const bumpCelebration = (delta: number) => setCelebration(celebrationDays + delta);

  const handlePointsMode = async (mode: PointsMode) => {
    if (!profile?.familyId) return;
    setPointsMode(mode);
    await updateFamily(profile.familyId, { pointsMode: mode } as any);
  };

  // Family-level gender policy. Defaults to false so the "Other" chip only
  // appears in profile editors after a parent explicitly opts in. We persist
  // the boolean either way so a parent who turns it ON and OFF lands back
  // exactly where they expect.
  const allowGenderOther = !!family?.allowGenderOther;
  const toggleAllowGenderOther = async () => {
    if (!profile?.familyId || !family || isGuest || savingGenderOption) return;
    setSavingGenderOption(true);
    try {
      await updateFamily(profile.familyId, { allowGenderOther: !allowGenderOther } as any);
    } catch {}
    setSavingGenderOption(false);
  };

  // Family location → currency. Picking a country writes
  // `location.country` and derives `hiveConfig.currency` via
  // `countryToCurrency()`. USD is the default when no country is
  // set. A parent can still override the currency afterward in
  // /parent/rates — this just gives a sensible location-based start.
  const [savingLocation, setSavingLocation] = useState(false);
  const familyCountry = family?.location?.country || '';
  const derivedCurrency = countryToCurrency(familyCountry);

  // ── Local language label (2026-05-19) ─────────────────────────
  // Used by the Staples form to label the optional secondary-name
  // field with the family's local language ("Swahili", "Hindi", etc.)
  // instead of generic "Local language". English is implicit as the
  // primary; this field is just the cosmetic label.
  const [savingLanguage, setSavingLanguage] = useState(false);
  const familyLocalLanguage = family?.localLanguage ?? '';
  // 8 common picks + an "Other…" escape to free-text. Order roughly
  // by Kaya's user base (East Africa first, then global). "None"
  // clears the field → form falls back to the generic label.
  const LANGUAGE_PRESETS = [
    { value: '',           label: '— No local language (use generic label) —' },
    { value: 'Swahili',    label: 'Swahili (Kiswahili)' },
    { value: 'Hindi',      label: 'Hindi (हिन्दी)' },
    { value: 'Arabic',     label: 'Arabic (العربية)' },
    { value: 'French',     label: 'French (Français)' },
    { value: 'Spanish',    label: 'Spanish (Español)' },
    { value: 'Portuguese', label: 'Portuguese (Português)' },
    { value: 'Mandarin',   label: 'Mandarin (中文)' },
    { value: 'German',     label: 'German (Deutsch)' },
    { value: '__other__',  label: 'Other — type below' },
  ];
  const presetValues = LANGUAGE_PRESETS.map((p) => p.value);
  const initialMode = familyLocalLanguage && !presetValues.includes(familyLocalLanguage)
    ? '__other__'
    : familyLocalLanguage;
  const [languageMode, setLanguageMode] = useState<string>(initialMode);
  const [languageOther, setLanguageOther] = useState<string>(
    familyLocalLanguage && !presetValues.includes(familyLocalLanguage) ? familyLocalLanguage : '',
  );
  // Keep local state in sync when the family doc changes underneath us
  // (another parent saving in another tab).
  useEffect(() => {
    const newInitial = familyLocalLanguage && !presetValues.includes(familyLocalLanguage)
      ? '__other__'
      : familyLocalLanguage;
    setLanguageMode(newInitial);
    setLanguageOther(familyLocalLanguage && !presetValues.includes(familyLocalLanguage) ? familyLocalLanguage : '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyLocalLanguage]);
  const saveLocalLanguage = async (rawValue: string) => {
    if (!profile?.familyId || isGuest || savingLanguage) return;
    const next = rawValue.trim() || undefined;  // empty → unset
    if ((family?.localLanguage ?? undefined) === next) return;
    setSavingLanguage(true);
    try {
      // Use null-coalesce → undefined would skip the write; explicit
      // empty-string clears + re-saves cleanly. Cast to satisfy the
      // typed updateFamily signature for an optional field.
      await updateFamily(profile.familyId, { localLanguage: next ?? '' } as any);
      await refresh();
    } catch { /* surface via the savingLanguage spinner only */ }
    setSavingLanguage(false);
  };
  const handleCountryChange = async (countryCode: string) => {
    if (!profile?.familyId || !family || isGuest || savingLocation) return;
    if (!countryCode || countryCode === familyCountry) return;
    setSavingLocation(true);
    try {
      const nextCurrency = countryToCurrency(countryCode);
      await updateFamily(profile.familyId, {
        location: {
          country: countryCode,
          city: family.location?.city || '',
        },
        // Spread the existing hiveConfig so we only change the currency —
        // updateDoc would otherwise replace the whole nested map.
        hiveConfig: { ...(family.hiveConfig || {}), currency: nextCurrency },
      } as any);
      await refresh();
    } catch {}
    setSavingLocation(false);
  };

  // Kid-module picker. Fall back to the slim default set when a family
  // hasn't customised yet. Home is always granted and not rendered as a
  // toggle in the UI below.
  const selectedKidModules = family?.kidModules ?? DEFAULT_KID_MODULES;
  const [savingKidModule, setSavingKidModule] = useState<string | null>(null);
  // Which kid-module accordions are expanded (only modules with
  // sub-pages have one). Collapsed by default to keep the list calm —
  // parents tap the chevron to reveal + allocate sub-pages.
  const [expandedKidMods, setExpandedKidMods] = useState<Set<string>>(new Set());
  const toggleKidModExpand = (id: string) =>
    setExpandedKidMods((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  // Master collapse for the whole "What kids see" block — collapsed by
  // default so the Settings page stays short; the header summary still
  // shows the "N on" count. Mirrors how a helper card tucks its access
  // list away until tapped.
  const [kidVisibilityOpen, setKidVisibilityOpen] = useState(false);
  // SET PR3 (M9) — #kids deep link unfolds the block and scrolls to it
  // (quick-find chip + any guide link).
  useEffect(() => {
    const check = () => {
      if (typeof window === 'undefined' || window.location.hash !== '#kids') return;
      setKidVisibilityOpen(true);
      setTimeout(() => document.getElementById('kids')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []);
  const toggleKidModule = async (id: string) => {
    if (!profile?.familyId || !family || isGuest || savingKidModule) return;
    const isOn = selectedKidModules.includes(id);
    // Off strips the module AND all its sub-page grants — leftovers used to
    // re-grant the module through the nav resolver (the Household gate leak).
    const next = isOn
      ? selectedKidModules.filter((m) => m !== id && !m.startsWith(`${id}:`))
      : [...selectedKidModules, id];
    setSavingKidModule(id);
    try {
      await updateFamily(profile.familyId, { kidModules: next } as any);
    } catch {}
    setSavingKidModule(null);
  };

  // Privacy — may a kid open a sibling's profile? Absent ⇒ on (matches
  // the behaviour before this toggle). When off, the Kid profiles page
  // locks each kid to their own card; Reports + Family tree are
  // unaffected. Only meaningful when the Stats module (which holds the
  // Kid profiles page) is granted — the toggle is surfaced there.
  const siblingProfilesOn = family?.kidsCanSeeSiblingProfiles !== false;
  const [savingSiblingProfiles, setSavingSiblingProfiles] = useState(false);
  const toggleSiblingProfiles = async () => {
    if (!profile?.familyId || !family || isGuest || savingSiblingProfiles) return;
    setSavingSiblingProfiles(true);
    try {
      await updateFamily(profile.familyId, { kidsCanSeeSiblingProfiles: !siblingProfilesOn } as any);
    } catch {}
    setSavingSiblingProfiles(false);
  };

  // Earning-method picker. Fall back to the Phase-1 default for families that
  // existed before this feature so their UX doesn't suddenly empty out.
  const selectedMethods = family?.earningMethods ?? DEFAULT_EARNING_METHODS;
  const toggleEarningMethod = async (id: string) => {
    if (!profile?.familyId || !family || isGuest || savingMethod) return;
    const method = EARNING_METHODS.find((m) => m.id === id);
    if (!method || !isMethodSelectable(method)) return;
    const isOn = selectedMethods.includes(id);
    if (!isOn && selectedMethods.length >= FREE_EARNING_METHOD_LIMIT) return; // cap reached
    const next = isOn
      ? selectedMethods.filter((m) => m !== id)
      : [...selectedMethods, id];
    setSavingMethod(id);
    try {
      await updateFamily(profile.familyId, { earningMethods: next } as any);
    } catch {}
    setSavingMethod(null);
  };

  // Save a partial point-system patch and merge with the existing config.
  // Caller passes the section it's updating (used as the spinner key + to
  // ignore stale writes if the user clicks two toggles in quick succession).
  const savePointSystem = async (key: string, patch: Partial<PointSystemConfig>) => {
    if (!profile?.familyId || isGuest || savingPointSystem) return;
    setSavingPointSystem(key);
    try {
      const next: PointSystemConfig = {
        reducing: { ...pointSystem.reducing, ...(patch.reducing || {}) },
        kudos: { ...pointSystem.kudos, ...(patch.kudos || {}) },
        improvementNote: { ...pointSystem.improvementNote, ...(patch.improvementNote || {}) },
        diamondMinPoints: patch.diamondMinPoints ?? pointSystem.diamondMinPoints,
        routines: { ...pointSystem.routines, ...(patch.routines || {}) },
      };
      await updateFamily(profile.familyId, { pointSystem: next } as any);
    } catch {}
    setSavingPointSystem(null);
  };

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  const isParent = profile?.role === 'parent';

  // ── Referral panel (rendered inline on mobile, in right column on desktop) ─
  const ReferralPanel = (
    <>
      <div className="bg-gradient-to-br from-kaya-chocolate to-kaya-chocolate-light text-white rounded-kaya-lg p-5 relative overflow-hidden">
        <div className="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-kaya-gold/15 blur-2xl pointer-events-none" />
        <div className="relative">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="font-display font-black text-4xl">{totalCredit}</span>
            <span className="text-xs text-kaya-sand-light">
              {totalCredit === 1 ? 'family referred' : 'families referred'}
            </span>
          </div>
          <p className="text-[12px] text-kaya-sand-light leading-relaxed mb-3">
            {top
              ? <>Your badge: <span className="text-kaya-gold font-bold">{top.name}</span>{nextB
                  ? <> · {nextB.threshold - totalCredit} more to unlock <span className="font-bold text-white">{nextB.name}</span>.</>
                  : <> — the apex. 👑</>}</>
              : <>Refer your first family to earn <span className="text-kaya-gold font-bold">First Friend</span>.</>
            }
          </p>
          {/* badge ladder mini-strip */}
          <div className="flex items-center justify-between gap-1 mb-3">
            {BADGES.map((b) => {
              const got = totalCredit >= b.threshold;
              return (
                <div key={b.id} className="flex flex-col items-center gap-1 flex-1 min-w-0">
                  <ReferralBadge id={b.id} size={34} locked={!got} title={`${b.name} · ${b.threshold >= 1000 ? '1,000' : b.threshold}`} />
                  <span className={`text-[9px] font-bold ${got ? 'text-kaya-gold' : 'text-white/40'}`}>{b.threshold >= 1000 ? '1k' : b.threshold}</span>
                </div>
              );
            })}
          </div>
          {nextB && (
            <>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden mb-1.5">
                <div className="h-full bg-kaya-gold rounded-full transition-all" style={{ width: `${badgePct}%` }} />
              </div>
              <div className="flex justify-between text-[10px] text-white/60">
                <span>{top ? top.name : 'Start'}</span><span>{nextB.name} · {nextB.threshold >= 1000 ? '1,000' : nextB.threshold}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Kaya Coins — family-level referral currency (accrual engine ships next; 0 for now) */}
      <div className="bg-kaya-warm/30 border border-kaya-warm-dark rounded-kaya p-4 flex items-center gap-3">
        <KayaCoin size={48} className="shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-display font-black text-xl text-kaya-chocolate leading-none">{formatKc(kc)}<span className="text-[12px] font-bold text-kaya-sand ml-1">KC</span></p>
            <span className="text-[10px] font-bold uppercase tracking-wider text-kaya-gold-dark bg-kaya-gold-light/70 px-1.5 py-0.5 rounded-full">Coming soon</span>
          </div>
          <p className="text-[11px] text-kaya-sand leading-snug mt-1">Kaya Coins (≈ {formatKcUsd(kc)}) — you&apos;ll earn them when families you refer subscribe. Spendable rewards land with the next update.</p>
        </div>
      </div>

      <div className="bg-white border border-kaya-warm-dark rounded-kaya p-4">
        <p className="text-xs text-kaya-sand font-semibold uppercase tracking-wider mb-2">Your referral link</p>
        <div className="flex items-center gap-2 bg-kaya-warm/40 rounded-kaya-sm p-2 border border-kaya-warm-dark mb-3">
          <code className="flex-1 px-1 text-[11px] font-mono text-kaya-chocolate truncate">{fullRefLink || 'Generating…'}</code>
          <button
            onClick={copyRefLink}
            disabled={!fullRefLink}
            className="h-8 px-3 bg-kaya-chocolate text-white rounded-kaya-sm text-xs font-bold whitespace-nowrap disabled:opacity-40"
          >
            {refLinkCopied ? '✅ Copied' : '📋 Copy'}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={shareWhatsApp}
            disabled={!fullRefLink}
            className="h-9 px-3 bg-[#25D366]/10 text-[#128C7E] rounded-kaya-sm text-xs font-bold flex items-center gap-1.5 hover:bg-[#25D366]/20 disabled:opacity-40"
          >💬 WhatsApp</button>
          <button
            onClick={shareEmail}
            disabled={!fullRefLink}
            className="h-9 px-3 bg-kaya-warm/60 rounded-kaya-sm text-xs font-bold text-kaya-chocolate flex items-center gap-1.5 hover:bg-kaya-warm disabled:opacity-40"
          >✉️ Email</button>
        </div>
      </div>

      <div className="bg-white border border-kaya-warm-dark rounded-kaya overflow-hidden">
        <div className="px-4 py-3 border-b border-kaya-warm-dark">
          <p className="text-xs text-kaya-sand font-semibold uppercase tracking-wider">Referral badges</p>
        </div>
        {BADGES.map((b) => {
          const got = totalCredit >= b.threshold;
          return (
            <div
              key={b.id}
              className={`px-4 py-3 flex items-center gap-3 border-b last:border-b-0 border-kaya-warm-dark ${got ? 'bg-kaya-gold/5' : ''}`}
            >
              <ReferralBadge id={b.id} size={40} locked={!got} className="shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2 mb-0.5">
                  <p className="font-bold text-[13px]">{b.name}</p>
                  <span className={`text-[10px] font-bold uppercase shrink-0 ${got ? 'text-kaya-gold' : 'text-kaya-sand'}`}>
                    {got ? 'Earned' : `${(b.threshold - totalCredit).toLocaleString()} to go`}
                  </span>
                </div>
                <p className="text-[11px] text-kaya-sand leading-snug">{b.blurb}</p>
                <p className="text-[10px] text-kaya-sand-light mt-0.5 font-semibold">{b.threshold === 1 ? '1 family' : `${b.threshold.toLocaleString()} families`}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-kaya-warm/40 border border-kaya-warm-dark rounded-kaya p-3 flex items-start gap-3">
        <div className="w-8 h-8 rounded-[10px] bg-kaya-gold-light flex items-center justify-center text-sm shrink-0">🌱</div>
        <div className="text-[11px] leading-relaxed text-kaya-chocolate">
          <p className="font-bold">Compounding credit</p>
          <p className="text-kaya-sand">When a family <em>you</em> referred goes on to refer another, you earn an extra credit.{compoundCount > 0 && ` You have ${compoundCount} so far.`}</p>
        </div>
      </div>

      {referredFamilies.length > 0 && (
        <div className="bg-white border border-kaya-warm-dark rounded-kaya overflow-hidden">
          <div className="px-4 py-3 border-b border-kaya-warm-dark">
            <p className="text-xs text-kaya-sand font-semibold uppercase tracking-wider">Families you&apos;ve referred</p>
          </div>
          {referredFamilies.map((f) => (
            <div key={f.id} className="px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-kaya-gold-light flex items-center justify-center text-sm shrink-0">🏡</div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold truncate">{f.name}</p>
              </div>
              <span className="text-[10px] font-bold text-kaya-gold uppercase">+1 credit</span>
            </div>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-md w-full lg:max-w-5xl px-4 lg:px-8 pt-4 lg:pt-8">
      <div className="lg:hidden"><BackButton /></div>
      <div className="mb-5 lg:mb-7">
        <h1 className="font-display text-2xl lg:text-[34px] font-black lg:font-extrabold tracking-tight">Settings</h1>
        <p className="hidden lg:block text-sm text-kaya-sand mt-1">Manage your family, profile and preferences.</p>
      </div>

      {/* 🔎 Quick-find (M10) — jump to any section in two taps. */}
      <SettingsQuickFind
        targets={[
          { id: 'language', icon: '🌍', label: 'Language', keywords: 'lugha swahili english kiswahili' },
          { id: 'alerts', icon: '🔔', label: 'Alerts', keywords: 'notifications push devices digest' },
          ...(isParent ? [
            { id: 'participation', icon: '🌟', label: 'Ages', keywords: 'participation little stars sparks meetings' },
            { id: 'ai-level', icon: '🤖', label: 'AI level', keywords: 'ai level intensity marking homework strict gentle balanced stretch exam ready kaya ai coach' },
            { id: 'greetings', icon: '✉️', label: 'Cards', keywords: 'greeting cards people book contacts signature whatsapp honoree kaya writes' },
            { id: 'kids', icon: '👀', label: 'Kids', keywords: 'modules visibility what kids see household' },
            { id: 'security', icon: '🔐', label: 'Security', keywords: 'password login reset code privacy sign out' },
            // Sub-pages (href) — these live on their own route, so the chip
            // navigates rather than unfolding a card. Before this, typing
            // "performance" or "meetings" returned "Nothing matches".
            { id: 'helpers-page', icon: '🤝', label: 'Helpers', keywords: 'helper nanny tutor driver gardener login codes kids they can act on', href: '/settings/helpers' },
            { id: 'performance-page', icon: '⚖️', label: 'Performance', keywords: 'performance policy tracked track helper score scoring weights metrics work days kids review who is tracked', href: '/settings/performance' },
            { id: 'meetings-page', icon: '🗓️', label: 'Meetings', keywords: 'meeting sunday family meeting steps agenda reflection', href: '/settings/meetings' },
          ] : [
            { id: 'privacy', icon: '🔐', label: 'My privacy', keywords: 'password login code email' },
          ]),
          { id: 'profile', icon: '👤', label: 'Profile', keywords: 'name handle photo birthday' },
        ]}
      />

      <div className="lg:grid lg:grid-cols-12 lg:gap-6 lg:items-start">
        {/* ── Left column: account + family + preferences ──────── */}
        <div className="lg:col-span-7 space-y-4">

          {/* Language (i18n) — everyone picks their own; parents set the
              family default. Folded like the rest of Settings (M8); the
              #language deep link (kids' 🌍 More shortcut) auto-opens it. */}
          <CollapsibleSection
            id="language"
            remember
            icon="🌍"
            title="Language"
            summary={localeLabel(asLocale(family?.primaryLanguage) ?? localeForCountry(family?.location?.country))}
          >
            <LanguageCard bare />
          </CollapsibleSection>

          {/* 🔐 Security & privacy (SET PR4) — parents get the family login
              manager; kids get their own My-privacy card (self-view only). */}
          {isParent && !isGuest && (
            <CollapsibleSection id="security" remember icon="🔐" title="Security & privacy" summary="logins · resets · privacy">
              <SecurityPrivacyCard />
            </CollapsibleSection>
          )}

          {/* 🎁 Rewards rules moved to Manage Rewards (Elia, 26-Jul) — the
              store's settings live with the store. */}
          {profile?.role === 'kid' && <KidPrivacyCard />}

          {/* Profile card · anchored at #profile so deep links from the
              Family Tree land directly on it. */}
          <div id="profile" className="scroll-mt-24 bg-white border border-kaya-warm-dark rounded-kaya p-4">
            <div className="flex items-center gap-3">
              {profile?.avatarPhoto ? (
                <img
                  src={profile.avatarPhoto}
                  alt={profile.displayName || 'You'}
                  className="w-12 h-12 rounded-full object-cover bg-white shrink-0"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-kaya-gold to-kaya-gold-dark flex items-center justify-center text-lg text-white font-black shrink-0">
                  {profile?.displayName?.[0]?.toUpperCase() || 'U'}
                </div>
              )}
              <div className="flex-1 min-w-0">
                {editingName ? (
                  <div className="space-y-2">
                    <input
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      className="w-full h-9 px-3 bg-kaya-cream rounded-kaya-sm text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
                      placeholder="Your display name"
                      autoFocus
                      maxLength={40}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveName();
                        if (e.key === 'Escape') cancelEditingName();
                      }}
                    />
                    <div className="flex gap-2">
                      <button onClick={saveName} disabled={savingName} className="h-8 px-3 bg-kaya-gold text-white rounded-kaya-sm text-xs font-bold disabled:opacity-40">
                        {savingName ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={cancelEditingName} disabled={savingName} className="h-8 px-3 bg-kaya-warm rounded-kaya-sm text-xs font-semibold text-kaya-sand">
                        Cancel
                      </button>
                    </div>
                    {nameError && <p className="text-red-500 text-xs">{nameError}</p>}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-sm truncate">{profile?.displayName || 'You'}</p>
                      {!isGuest && (
                        <button onClick={startEditingName} className="text-[11px] text-kaya-gold font-semibold hover:underline shrink-0">
                          Edit
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-kaya-sand truncate">{profile?.email}</p>
                    <p className="text-xs font-semibold capitalize" style={{ color: '#D4A017' }}>{profile?.role}</p>
                    {profile?.handle && (
                      <p className="text-[11px] font-semibold text-kaya-gold mt-0.5">{formatPersonHandle(profile.handle)}</p>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Personal handle editor */}
            {!isGuest && (
              <div className="border-t border-kaya-warm-dark pt-3 mt-3">
                {!editingMyHandle ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Your handle</p>
                      {profile?.handle ? (
                        <p className="text-[12px] truncate font-semibold text-kaya-gold">{formatPersonHandle(profile.handle)}</p>
                      ) : (
                        <p className="text-[12px] text-kaya-sand">Pick a personal handle (no &quot;&apos;s Family&quot; suffix).</p>
                      )}
                    </div>
                    <button
                      onClick={startEditingMyHandle}
                      className="text-[11px] text-kaya-gold font-semibold hover:underline shrink-0"
                    >
                      {profile?.handle ? 'Change' : 'Pick handle'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Your handle</p>
                    <div className="flex items-center gap-1 bg-kaya-cream/40 border border-kaya-warm-dark rounded-kaya-sm pl-3">
                      <span className="text-kaya-sand font-bold">@</span>
                      <input
                        value={myHandleInput}
                        onChange={(e) => setMyHandleInput(e.target.value)}
                        autoFocus
                        maxLength={24}
                        placeholder="Eli"
                        className="flex-1 h-9 bg-transparent text-sm font-semibold focus:outline-none"
                      />
                    </div>
                    <p className="text-[10px] text-kaya-sand-light leading-snug">
                      Will display as <strong>{myHandleInput.trim() ? formatPersonHandle(normalizeHandle(myHandleInput) || myHandleInput) : '@…'}</strong>.
                      Letters and numbers, starts with a capital. Globally unique.
                    </p>
                    {myHandleError && (
                      <p className="text-red-500 text-[11px]">{myHandleError}</p>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={saveMyHandle}
                        disabled={savingMyHandle}
                        className="h-9 px-4 bg-kaya-gold text-white rounded-kaya-sm text-xs font-bold disabled:opacity-40"
                      >
                        {savingMyHandle ? 'Checking…' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingMyHandle(false); setMyHandleError(''); }}
                        disabled={savingMyHandle}
                        className="h-9 px-4 bg-kaya-warm rounded-kaya-sm text-xs font-semibold text-kaya-sand"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Avatar picker — uploaded photo or curated library, mirroring kids. */}
            {!isGuest && (
              <div className="border-t border-kaya-warm-dark pt-3 mt-3">
                {!pickingMyAvatar ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Profile photo</p>
                      <p className="text-[12px] text-kaya-sand">
                        {profile?.avatarPhoto ? 'Looking sharp.' : 'Add a photo or pick an avatar.'}
                      </p>
                    </div>
                    <button
                      onClick={() => setPickingMyAvatar(true)}
                      className="text-[11px] text-kaya-gold font-semibold hover:underline shrink-0"
                    >
                      {profile?.avatarPhoto ? 'Change' : '+ Add'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Profile photo</p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className="h-10 px-2 rounded-kaya-sm bg-kaya-chocolate text-white text-[12px] font-bold"
                        aria-pressed="true"
                      >
                        🎨 From library
                      </button>
                      <button
                        type="button"
                        onClick={() => myAvatarRef.current?.click()}
                        disabled={!!savingMyAvatar}
                        className="h-10 px-2 rounded-kaya-sm bg-white border border-kaya-warm-dark text-kaya-chocolate text-[12px] font-bold hover:border-kaya-chocolate transition-colors disabled:opacity-60"
                      >
                        {savingMyAvatar === 'upload' ? 'Uploading…' : '📷 From your device'}
                      </button>
                      <input
                        ref={myAvatarRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleMyAvatarUpload}
                      />
                    </div>
                    {myAvatarError && (
                      <p className="text-red-500 text-[11px] bg-red-50 border border-red-200 rounded-kaya-sm px-2 py-1.5">{myAvatarError}</p>
                    )}
                    <div className="flex items-center gap-3 bg-kaya-cream/60 border border-kaya-warm-dark rounded-kaya-sm p-2.5">
                      <img
                        src={generateAvatarFromName(profile?.displayName || 'You')}
                        alt=""
                        className="w-10 h-10 rounded-full bg-white shrink-0"
                        referrerPolicy="no-referrer"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-bold">Pick for {profile?.displayName?.split(' ')[0] || 'you'}</p>
                        <p className="text-[10px] text-kaya-sand">Generated from your name</p>
                      </div>
                      <button
                        onClick={() => chooseMyAvatar(generateAvatarFromName(profile?.displayName || 'You'))}
                        disabled={!!savingMyAvatar}
                        className="h-7 px-2.5 bg-kaya-gold text-white rounded-kaya-sm text-[11px] font-bold disabled:opacity-40"
                      >
                        Use
                      </button>
                    </div>
                    {AVATAR_GROUPS.map((group) => (
                      <div key={group.key}>
                        <p className="text-[10px] font-bold text-kaya-sand uppercase tracking-wider mb-1.5">{group.label}</p>
                        <div className="grid grid-cols-4 gap-2">
                          {AVATAR_PRESETS.filter((a) => a.group === group.key).map((preset) => {
                            const sel = profile?.avatarPhoto === preset.url;
                            const saving = savingMyAvatar === preset.url;
                            return (
                              <button
                                key={preset.url}
                                onClick={() => chooseMyAvatar(preset.url)}
                                disabled={!!savingMyAvatar}
                                title={preset.label}
                                aria-label={preset.label}
                                className={`relative aspect-square rounded-kaya-sm overflow-hidden border-2 transition-all ${
                                  sel ? 'border-kaya-gold' : 'border-transparent hover:border-kaya-warm-dark'
                                } ${saving ? 'opacity-60' : ''}`}
                              >
                                <img src={preset.url} alt="" className="w-full h-full object-cover bg-white" referrerPolicy="no-referrer" />
                                {sel && (
                                  <span className="absolute bottom-0.5 right-0.5 bg-kaya-gold text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">✓</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <div className="flex items-center justify-between pt-1">
                      <button
                        onClick={() => setPickingMyAvatar(false)}
                        className="h-8 px-3 bg-kaya-warm rounded-kaya-sm text-xs font-semibold text-kaya-sand"
                      >
                        Done
                      </button>
                      {profile?.avatarPhoto && (
                        <button
                          onClick={() => chooseMyAvatar('')}
                          disabled={!!savingMyAvatar}
                          className="h-8 px-3 text-xs font-semibold text-kaya-sand hover:text-red-500"
                        >
                          Remove photo
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Gender — the "Other" option is gated by the family-level
                allowGenderOther flag (Family options card). Once a gender is
                SAVED the chips fold behind a "Change" link so it can't be
                switched by a stray tap (Elia fix, 24-Jul-2026). */}
            {!isGuest && (
              <div className="border-t border-kaya-warm-dark pt-3 mt-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Gender</p>
                  {genderSet && !genderEditOpen && (
                    <button
                      type="button"
                      onClick={() => setGenderEditOpen(true)}
                      className="text-[11px] text-kaya-gold font-semibold hover:underline"
                    >
                      Change
                    </button>
                  )}
                </div>
                {genderSet && !genderEditOpen ? (
                  <p className="text-[12px] font-semibold">
                    {profile?.gender === 'female' ? '👩 Woman' : profile?.gender === 'male' ? '👨 Man' : '🌈 Other'}
                  </p>
                ) : (
                <div className="flex flex-wrap gap-1.5">
                  {(([
                    { value: 'female', label: 'Woman', emoji: '👩' },
                    { value: 'male', label: 'Man', emoji: '👨' },
                    { value: 'other', label: 'Other', emoji: '🌈' },
                    { value: 'unspecified', label: 'Prefer not to say', emoji: '—' },
                  ] as { value: Gender; label: string; emoji: string }[]).filter((g) => {
                    // Always keep the user's currently-saved choice visible so
                    // a family that flips the toggle off doesn't lose state.
                    if (g.value === 'other' && !allowGenderOther && profile?.gender !== 'other') return false;
                    return true;
                  })).map((g) => {
                    const sel = (profile?.gender || 'unspecified') === g.value;
                    return (
                      <button
                        key={g.value}
                        onClick={() => setMyGender(g.value)}
                        disabled={savingGender}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                          sel ? 'bg-kaya-chocolate text-white border-transparent' : 'border-kaya-warm-dark bg-white text-kaya-sand hover:border-kaya-sand-light'
                        }`}
                      >
                        {g.emoji} {g.label}
                      </button>
                    );
                  })}
                </div>
                )}
              </div>
            )}

            {/* Birthday + privacy */}
            {!isGuest && (
              <div className="border-t border-kaya-warm-dark pt-3 mt-3">
                {!editingMyBirthday ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Birthday</p>
                      {effectiveMyBirthday ? (
                        <>
                          <p className="text-[12px] truncate">
                            🎂 {myBirthdayDisplay || <span className="text-kaya-sand">Hidden</span>}
                            <span className="text-kaya-sand-light ml-2">·{' '}
                              {(profile?.birthdayPrivacy || 'partial') === 'public' && 'Public'}
                              {(profile?.birthdayPrivacy || 'partial') === 'partial' && 'Day & month only'}
                              {(profile?.birthdayPrivacy || 'partial') === 'private' && 'Private'}
                            </span>
                          </p>
                          {(profile?.birthdayPrivacy || 'partial') !== 'private' && (() => {
                            const day = dayOfWeek(effectiveMyBirthday);
                            const d = daysToNextBirthday(effectiveMyBirthday);
                            const parts: string[] = [];
                            if (day) parts.push(`Born on a ${day}`);
                            if (d === 0) parts.push('🎉 today!');
                            else if (d !== null) parts.push(`${d} day${d === 1 ? '' : 's'} to go`);
                            return parts.length > 0 ? (
                              <p className="text-[11px] text-kaya-sand mt-0.5">{parts.join(' · ')}</p>
                            ) : null;
                          })()}
                        </>
                      ) : (
                        <p className="text-[12px] text-kaya-sand">Not set — add it for on-this-day surprises.</p>
                      )}
                    </div>
                    {myChildDoc?.birthday ? (
                      /* Kid birthdays are parent-managed (Kid Profiles) —
                         no self-edit, so it can't drift from the family record. */
                      <span className="text-[10px] text-kaya-sand font-semibold shrink-0">set by your parents</span>
                    ) : (
                      <button
                        onClick={startEditingMyBirthday}
                        className="text-[11px] text-kaya-gold font-semibold hover:underline shrink-0"
                      >
                        {profile?.birthday ? 'Edit' : 'Add'}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Birthday</p>
                    <DateSelect
                      value={myBdayInput}
                      onChange={setMyBdayInput}
                      maxDate={new Date().toISOString().slice(0, 10)}
                    />
                    <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider mt-2">Who can see it</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                      {([
                        { value: 'public', label: 'Public', desc: 'Full date — visible to family' },
                        { value: 'partial', label: 'Day & month', desc: 'Hide the year' },
                        { value: 'private', label: 'Private', desc: 'Hidden everywhere' },
                      ] as { value: BirthdayPrivacy; label: string; desc: string }[]).map((p) => {
                        const sel = myBdayPrivacy === p.value;
                        return (
                          <button
                            key={p.value}
                            onClick={() => setMyBdayPrivacy(p.value)}
                            className={`text-left p-2 rounded-kaya-sm border transition-colors ${
                              sel ? 'border-kaya-gold bg-kaya-gold/5' : 'border-kaya-warm-dark bg-white hover:border-kaya-sand-light'
                            }`}
                          >
                            <p className="text-[12px] font-bold">{p.label}</p>
                            <p className="text-[10px] text-kaya-sand leading-snug">{p.desc}</p>
                          </button>
                        );
                      })}
                    </div>
                    {myBdayError && <p className="text-red-500 text-[11px]">{myBdayError}</p>}
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={saveMyBirthday}
                        disabled={savingMyBirthday}
                        className="h-9 px-4 bg-kaya-gold text-white rounded-kaya-sm text-xs font-bold disabled:opacity-40"
                      >
                        {savingMyBirthday ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingMyBirthday(false); setMyBdayError(''); }}
                        disabled={savingMyBirthday}
                        className="h-9 px-4 bg-kaya-warm rounded-kaya-sm text-xs font-semibold text-kaya-sand"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Anniversary — read-only here. The shared family-level field
                lives on the Family doc and is edited under Family identity
                ↓; we surface it on the personal profile so the parent sees
                their key dates side-by-side (birthday + anniversary). */}
            {!isGuest && family && (
              <div className="border-t border-kaya-warm-dark pt-3 mt-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">
                      {family.anniversaryName?.trim() || 'Anniversary'}
                    </p>
                    {family.anniversary ? (
                      <>
                        <p className="text-[12px] truncate">
                          💍 {toDisplayDate(family.anniversary)}{' '}
                          <span className="text-kaya-sand">· {dayOfWeek(family.anniversary)}</span>
                        </p>
                        {(() => {
                          const d = daysToNextBirthday(family.anniversary!);
                          const yrs = ageNow(family.anniversary!);
                          const upcoming = ageAtNextBirthday(family.anniversary!);
                          const milestoneYear = d === 0 ? yrs : upcoming;
                          const milestone = milestoneYear !== null ? milestoneForYear(milestoneYear) : null;
                          const familyShort = (family.name || '').replace(/^the\s+/i, '').replace(/\s+family$/i, '').trim() || family.name || '';
                          return (
                            <>
                              {d !== null && (d === 0
                                ? (
                                  <p className="text-[11px] font-bold text-kaya-gold mt-0.5">
                                    {milestone
                                      ? `🎉 Today — ${milestone.emoji} ${milestone.name} (${ordinal(milestone.year)} year)`
                                      : '🎉 Today!'}
                                  </p>
                                ) : (
                                  <p className="text-[11px] text-kaya-gold font-semibold mt-0.5">
                                    {milestone && upcoming !== null
                                      ? `${d} day${d === 1 ? '' : 's'} to celebrating ${milestone.emoji} ${milestone.name} (${ordinal(milestone.year)} year)`
                                      : `${d} day${d === 1 ? '' : 's'} to your ${upcoming !== null ? ordinal(upcoming) + ' ' : ''}anniversary${yrs !== null ? ` · ${yrs} year${yrs === 1 ? '' : 's'} so far` : ''}`}
                                  </p>
                                )
                              )}
                              {yrs !== null && (
                                <p className="text-[11px] italic text-kaya-chocolate mt-1 leading-snug">
                                  {familyShort
                                    ? `${yrs} year${yrs === 1 ? '' : 's'} of building the ${familyShort} family with love together 💛`
                                    : `${yrs} year${yrs === 1 ? '' : 's'} of building this family with love together 💛`}
                                </p>
                              )}
                            </>
                          );
                        })()}
                      </>
                    ) : (
                      <p className="text-[12px] text-kaya-sand">Not set on the family yet.</p>
                    )}
                  </div>
                  {isParent && (
                    <a
                      href="#family"
                      className="text-[11px] text-kaya-gold font-semibold hover:underline shrink-0"
                    >
                      {family.anniversary ? 'Edit ↓' : 'Add ↓'}
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Born on this day (parent) */}
          {!isGuest && profile?.birthday && (profile?.birthdayPrivacy || 'partial') !== 'private' && myBornToday.length > 0 && (
            <CollapsibleSection
              title={
                <>
                  Born on the same day
                  {profile.gender === 'female' && <span className="ml-1 text-kaya-sand-light normal-case">· women</span>}
                  {profile.gender === 'male' && <span className="ml-1 text-kaya-sand-light normal-case">· men</span>}
                </>
              }
              summary="via Wikipedia"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {myBornToday.map((p) => (
                  <a
                    key={p.pageUrl}
                    href={p.pageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-2 p-2 rounded-kaya-sm border border-kaya-warm-dark bg-kaya-cream/40 hover:border-kaya-chocolate transition-colors no-underline text-inherit"
                  >
                    {p.thumbnailUrl ? (
                      <img src={p.thumbnailUrl} alt="" className="w-10 h-10 rounded-full object-cover bg-white shrink-0" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-kaya-gold-light flex items-center justify-center shrink-0">⭐</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-bold leading-tight truncate">{p.name}</p>
                      <p className="text-[10px] text-kaya-sand">b. {p.year}</p>
                      {p.description && <p className="text-[10px] text-kaya-sand line-clamp-2 leading-snug mt-0.5">{p.description}</p>}
                    </div>
                  </a>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* Inspiring innovations on this day (parent) */}
          {!isGuest && profile?.birthday && (profile?.birthdayPrivacy || 'partial') !== 'private' && myEventsToday.length > 0 && (
            <CollapsibleSection title="Inspiring on this day" summary="curated · Wikipedia">
              <ul className="space-y-2">
                {myEventsToday.map((e, idx) => {
                  const inner = (
                    <>
                      {e.thumbnailUrl ? (
                        <img src={e.thumbnailUrl} alt="" className="w-10 h-10 rounded-kaya-sm object-cover bg-white shrink-0" referrerPolicy="no-referrer" />
                      ) : (
                        <div className="w-10 h-10 rounded-kaya-sm bg-kaya-gold-light flex items-center justify-center shrink-0">📜</div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-bold text-kaya-gold">{e.year}</p>
                        <p className="text-[12px] leading-snug">{e.text}</p>
                      </div>
                    </>
                  );
                  const cls = 'flex items-start gap-2.5 p-2.5 rounded-kaya-sm border border-kaya-warm-dark bg-kaya-cream/40 hover:border-kaya-chocolate transition-colors no-underline text-inherit';
                  return (
                    <li key={`${e.year}-${idx}`}>
                      {e.pageUrl ? (
                        <a href={e.pageUrl} target="_blank" rel="noopener noreferrer" className={cls}>{inner}</a>
                      ) : (
                        <div className={cls}>{inner}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </CollapsibleSection>
          )}

          {/* Family identity — name, handle, photo. Anchored at #family so
              deep links from the Family Tree (anniversary card "Edit" /
              empty-state "+ Add anniversary") land directly on this card. */}
          {family && (
            <div id="family" className="scroll-mt-24 bg-white border border-kaya-warm-dark rounded-kaya p-4 space-y-4">
              <div className="flex items-start gap-4">
                {/* Family photo */}
                <div className="shrink-0">
                  {family.photoUrl ? (
                    <img
                      src={family.photoUrl}
                      alt={family.name}
                      className="w-16 h-16 rounded-[18px] object-cover border border-kaya-warm-dark"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-[18px] bg-gradient-to-br from-kaya-chocolate to-kaya-chocolate-light text-kaya-gold-light flex items-center justify-center font-display font-black text-2xl">
                      {(family.name || 'K').replace(/^the\s+/i, '').charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Family</p>
                  <p className="font-bold text-base truncate">{family.name}</p>
                  {family.handle ? (
                    <p className="text-[12px] font-semibold text-kaya-gold truncate">{formatFamilyHandle(family.handle)}</p>
                  ) : (
                    <p className="text-[12px] text-kaya-sand">No handle yet</p>
                  )}
                  {family.isFoundingFamily && (
                    <p className="text-[11px] font-bold text-kaya-gold mt-1">
                      🤝 Charter Family{formatCharterNumber(family.charterNumber) ? ` · No. ${formatCharterNumber(family.charterNumber)}` : ' · founding member'}
                    </p>
                  )}
                </div>
              </div>

              {/* Photo controls (parent-only, not guest) */}
              {isParent && !isGuest && (
                <div className="flex flex-wrap gap-2 items-center">
                  <button
                    onClick={() => familyPhotoRef.current?.click()}
                    disabled={savingFamilyPhoto}
                    className="h-8 px-3 bg-white border border-kaya-warm-dark rounded-kaya-sm text-[11px] font-bold hover:border-kaya-chocolate transition-colors disabled:opacity-60"
                  >
                    {savingFamilyPhoto ? 'Saving…' : family.photoUrl ? '📷 Change photo' : '📷 Add photo'}
                  </button>
                  {family.photoUrl && (
                    <button
                      onClick={removeFamilyPhoto}
                      disabled={savingFamilyPhoto}
                      className="text-[11px] text-kaya-sand hover:text-red-500 font-semibold"
                    >
                      Remove
                    </button>
                  )}
                  <input
                    ref={familyPhotoRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleFamilyPhoto}
                  />
                  {familyPhotoError && (
                    <p className="text-red-500 text-[11px] basis-full">{familyPhotoError}</p>
                  )}
                </div>
              )}

              {/* Handle editor (parent-only, not guest) */}
              {isParent && !isGuest && (
                <div className="border-t border-kaya-warm-dark pt-3">
                  {!editingHandle ? (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Public handle</p>
                        {family.handle ? (
                          <p className="text-[12px] truncate">
                            {formatFamilyHandle(family.handle)} ·{' '}
                            <a
                              href={`/u/${handleToSlug(family.handle)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-kaya-gold hover:underline"
                            >
                              ourkaya.com/u/{handleToSlug(family.handle)} ↗
                            </a>
                          </p>
                        ) : (
                          <p className="text-[12px] text-kaya-sand">Pick a public handle for your family.</p>
                        )}
                      </div>
                      <button
                        onClick={startEditingHandle}
                        className="text-[11px] text-kaya-gold font-semibold hover:underline shrink-0"
                      >
                        {family.handle ? 'Change' : 'Pick handle'}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Public handle</p>
                      <div className="flex items-center gap-1 bg-kaya-cream/40 border border-kaya-warm-dark rounded-kaya-sm pl-3">
                        <span className="text-kaya-sand font-bold">@</span>
                        <input
                          value={handleInput}
                          onChange={(e) => setHandleInput(e.target.value)}
                          autoFocus
                          maxLength={24}
                          placeholder="Timotheo"
                          className="flex-1 h-9 bg-transparent text-sm font-semibold focus:outline-none"
                        />
                      </div>
                      <p className="text-[10px] text-kaya-sand-light leading-relaxed">
                        Will display as <strong>{handleInput.trim() ? `@${normalizeHandle(handleInput) || handleInput}'s Family` : "@…'s Family"}</strong>.
                        Uses 3–24 letters/numbers, starts with a capital. Lowercased in the URL.
                      </p>
                      {family.name && suggestFamilyHandles(family.name).length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          <span className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider mr-1 self-center">Try</span>
                          {suggestFamilyHandles(family.name).map((s) => (
                            <button
                              key={s}
                              onClick={() => setHandleInput(s)}
                              className="px-2 py-1 rounded-full text-[11px] font-semibold border border-kaya-warm-dark bg-white text-kaya-chocolate hover:border-kaya-chocolate"
                            >
                              @{s}
                            </button>
                          ))}
                        </div>
                      )}
                      {handleError && (
                        <p className="text-red-500 text-[11px]">{handleError}</p>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={saveHandle}
                          disabled={savingHandle}
                          className="h-9 px-4 bg-kaya-gold text-white rounded-kaya-sm text-xs font-bold disabled:opacity-40"
                        >
                          {savingHandle ? 'Checking…' : 'Save'}
                        </button>
                        <button
                          onClick={() => { setEditingHandle(false); setHandleError(''); }}
                          disabled={savingHandle}
                          className="h-9 px-4 bg-kaya-warm rounded-kaya-sm text-xs font-semibold text-kaya-sand"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Location & currency — picking a country derives the
                  family's display currency and scales pantry prices to
                  local FX rates. Parent-only; USD is the global default. */}
              {isParent && !isGuest && (
                <div className="border-t border-kaya-warm-dark pt-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">
                      Location &amp; currency
                    </p>
                    {savingLocation && (
                      <span className="text-[10px] text-kaya-sand">Saving…</span>
                    )}
                  </div>
                  <select
                    value={familyCountry}
                    onChange={(e) => handleCountryChange(e.target.value)}
                    disabled={savingLocation}
                    className="w-full h-10 px-3 bg-kaya-cream/40 border border-kaya-warm-dark rounded-kaya-sm text-sm font-semibold focus:outline-none focus:border-kaya-chocolate disabled:opacity-60"
                  >
                    <option value="">🌍 Select your country…</option>
                    {(Object.keys(COUNTRY_REGION_LABELS) as CountryMeta['region'][]).map((region) => {
                      const inRegion = COUNTRIES.filter((c) => c.region === region);
                      if (inRegion.length === 0) return null;
                      return (
                        <optgroup key={region} label={COUNTRY_REGION_LABELS[region]}>
                          {inRegion.map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.flag} {c.label}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                  <p className="text-[10px] text-kaya-sand-light leading-relaxed mt-1.5">
                    {familyCountry ? (
                      <>
                        Currency set to{' '}
                        <strong>
                          {currencyMeta(derivedCurrency).label} ({derivedCurrency})
                        </strong>{' '}
                        — pantry prices scale to live exchange rates. You can
                        override the currency in The Hive&apos;s rate settings.
                      </>
                    ) : (
                      <>
                        No country set — using <strong>US Dollar (USD)</strong> as
                        the default. Pick your country so pantry prices show in
                        your local currency.
                      </>
                    )}
                  </p>
                </div>
              )}

              {/* Local / native language (2026-05-19) — labels the
                  optional secondary name on Staples + future bilingual
                  surfaces with the family's actual language ("Asali"
                  in Swahili etc.). Helpers see this name FIRST in
                  rows so a low-literacy nanny scans faster. English
                  is the implicit primary. */}
              {isParent && !isGuest && (
                <div className="border-t border-kaya-warm-dark pt-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">
                      Local / native language
                    </p>
                    {savingLanguage && (
                      <span className="text-[10px] text-kaya-sand">Saving…</span>
                    )}
                  </div>
                  <select
                    value={languageMode}
                    onChange={(e) => {
                      const v = e.target.value;
                      setLanguageMode(v);
                      if (v !== '__other__') {
                        saveLocalLanguage(v);
                      }
                    }}
                    disabled={savingLanguage}
                    className="w-full h-10 px-3 bg-kaya-cream/40 border border-kaya-warm-dark rounded-kaya-sm text-sm font-semibold focus:outline-none focus:border-kaya-chocolate disabled:opacity-60"
                  >
                    {LANGUAGE_PRESETS.map((p) => (
                      <option key={p.value || 'none'} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                  {languageMode === '__other__' && (
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        value={languageOther}
                        onChange={(e) => setLanguageOther(e.target.value)}
                        placeholder="e.g. Yoruba"
                        maxLength={40}
                        className="flex-1 h-10 px-3 bg-kaya-cream/40 border border-kaya-warm-dark rounded-kaya-sm text-sm font-semibold focus:outline-none focus:border-kaya-chocolate"
                      />
                      <button
                        type="button"
                        onClick={() => saveLocalLanguage(languageOther)}
                        disabled={savingLanguage || !languageOther.trim()}
                        className="h-10 px-3 bg-kaya-chocolate text-white rounded-kaya-sm text-xs font-bold disabled:opacity-50"
                      >
                        Save
                      </button>
                    </div>
                  )}
                  <p className="text-[10px] text-kaya-sand-light leading-relaxed mt-1.5">
                    {familyLocalLanguage ? (
                      <>
                        Set to <strong>{familyLocalLanguage}</strong>. Staples can carry a second name in this language —
                        helpers see it as their primary label. Searches match either name.
                      </>
                    ) : (
                      <>
                        Default is <strong>English</strong> only. Pick a second language so helpers can search and read staples in their preferred word.
                      </>
                    )}
                  </p>
                </div>
              )}

              {/* Anniversary — shared across both parents. Read-only for
                  helpers/kids; editable by parents. */}
              {!isGuest && (
                <div className="border-t border-kaya-warm-dark pt-3">
                  {!editingAnniversary ? (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider flex items-center gap-2">
                          {family.anniversaryName?.trim() || 'Anniversary'}
                          {anniversarySaved && (
                            <span className="text-[10px] font-bold text-kaya-gold normal-case">✓ Saved</span>
                          )}
                        </p>
                        {family.anniversary ? (
                          <>
                            <p className="text-[12px] truncate">
                              💍 {toDisplayDate(family.anniversary)} ·{' '}
                              <span className="text-kaya-sand">{dayOfWeek(family.anniversary)}</span>
                            </p>
                            {(() => {
                              const d = daysToNextBirthday(family.anniversary!);
                              const yrs = ageNow(family.anniversary!);
                              const upcoming = ageAtNextBirthday(family.anniversary!);
                              const milestoneYear = d === 0 ? yrs : upcoming;
                              const milestone = milestoneYear !== null ? milestoneForYear(milestoneYear) : null;
                              if (d === null) return null;
                              return (
                                <p className="text-[11px] text-kaya-gold font-semibold mt-0.5">
                                  {d === 0
                                    ? (milestone
                                        ? `🎉 Today — ${milestone.emoji} ${milestone.name} (${ordinal(milestone.year)} year)`
                                        : '🎉 Today!')
                                    : (milestone && upcoming !== null
                                        ? `${d} day${d === 1 ? '' : 's'} to celebrating ${milestone.emoji} ${milestone.name} (${ordinal(milestone.year)} year) Anniversary`
                                        : `${d} day${d === 1 ? '' : 's'} to your ${upcoming !== null ? ordinal(upcoming) + ' ' : ''}anniversary`)}
                                </p>
                              );
                            })()}
                            {(() => {
                              const yrs = ageNow(family.anniversary!);
                              if (yrs === null) return null;
                              const familyShort = (family.name || '').replace(/^the\s+/i, '').replace(/\s+family$/i, '').trim() || family.name || '';
                              return (
                                <p className="text-[11px] italic text-kaya-chocolate mt-1 leading-snug">
                                  {familyShort
                                    ? `${yrs} year${yrs === 1 ? '' : 's'} of building the ${familyShort} family with love together 💛`
                                    : `${yrs} year${yrs === 1 ? '' : 's'} of building this family with love together 💛`}
                                </p>
                              );
                            })()}
                          </>
                        ) : (
                          <p className="text-[12px] text-kaya-sand">Add the wedding date so both parents see the countdown.</p>
                        )}
                      </div>
                      {isParent && (
                        <button
                          onClick={startEditingAnniversary}
                          className="text-[11px] text-kaya-gold font-semibold hover:underline shrink-0"
                        >
                          {family.anniversary ? 'Change' : 'Add'}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider">Anniversary date</p>
                      <DateSelect
                        value={anniversaryInput}
                        onChange={setAnniversaryInput}
                        maxDate={new Date().toISOString().slice(0, 10)}
                      />
                      <p className="text-[10px] text-kaya-sand font-bold uppercase tracking-wider mt-2">What to call it</p>
                      <input
                        value={anniversaryNameInput}
                        onChange={(e) => setAnniversaryNameInput(e.target.value)}
                        placeholder="Wedding Anniversary"
                        maxLength={60}
                        className="w-full h-10 px-3 bg-kaya-cream rounded-kaya-sm text-sm focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
                      />
                      <p className="text-[10px] text-kaya-sand-light">
                        Optional. Defaults to &quot;Anniversary&quot;. Try &quot;Wedding Anniversary&quot;,
                        &quot;Engagement Day&quot;, &quot;The Day We Met&quot; — anything that means
                        something to you. Visible to everyone in the family; both parents
                        see the same countdown.
                      </p>
                      {anniversaryError && (
                        <p className="text-red-500 text-[11px]">{anniversaryError}</p>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={saveAnniversary}
                          disabled={savingAnniversary}
                          className="h-9 px-4 bg-kaya-gold text-white rounded-kaya-sm text-xs font-bold disabled:opacity-40"
                        >
                          {savingAnniversary ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={() => { setEditingAnniversary(false); setAnniversaryError(''); }}
                          disabled={savingAnniversary}
                          className="h-9 px-4 bg-kaya-warm rounded-kaya-sm text-xs font-semibold text-kaya-sand"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Family options — small toggles that change what kids and
              parents see when editing their profiles. */}
          {isParent && family && (
            <CollapsibleSection title="Family options">
              <button
                onClick={toggleAllowGenderOther}
                disabled={savingGenderOption || isGuest}
                className="w-full flex items-start gap-3 p-3 rounded-kaya-sm border border-kaya-warm-dark hover:border-kaya-sand-light text-left transition-colors disabled:opacity-60"
              >
                <div className={`w-10 h-6 rounded-full shrink-0 mt-0.5 relative transition-colors ${allowGenderOther ? 'bg-kaya-gold' : 'bg-kaya-warm-dark'}`}>
                  <div
                    className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all"
                    style={{ left: allowGenderOther ? '18px' : '2px' }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">Show &quot;Other&quot; gender option</p>
                  <p className="text-[11px] text-kaya-sand leading-relaxed">
                    Off by default. Many families only want Female and Male choices when
                    setting up a child or parent profile. Turn on to also show 🌈 Other.
                  </p>
                </div>
              </button>
            </CollapsibleSection>
          )}

          {/* Inline referral panel — mobile only (desktop renders it in the right column) */}
          {isParent && family && (
            <div className="lg:hidden space-y-2">
              {ReferralPanel}
            </div>
          )}

          {/* Invite codes — one per role. Whichever code a new user
              pastes during onboarding determines what role they join
              as. Always visible (no Show/Hide gate) so parents don't
              hunt for them when inviting a kid mid-conversation. */}
          {isParent && family && (
            <CollapsibleSection title="Invite codes" summary="3 codes · 1 per role">
              <p className="text-[11px] text-kaya-sand mb-3 leading-relaxed">
                Share the matching code so each person joins with the right access. The code itself sets the role at sign-up.
              </p>

              {([
                { key: 'kid' as const,    title: 'Kids',    emoji: '🧒', hint: 'For your children. Lets them rate their routines and see their points.' },
                { key: 'helper' as const, title: 'Helpers', emoji: '🤝', hint: 'One-time code for a NEW helper to join. Their day-to-day sign-in codes live per helper in Settings → Helpers.' },
                { key: 'guest' as const,  title: 'Guests',  emoji: '👀', hint: 'View-only. Great for grandparents and godparents.' },
              ]).map(({ key, title, emoji, hint }) => {
                const entry = inviteCodes?.[key];
                const code = entry?.code;
                const active = !!entry?.active;
                const toggling = busyCode?.role === key && busyCode?.op === 'toggle';
                const regening = busyCode?.role === key && busyCode?.op === 'regen';
                return (
                  <div key={key} className="border-t border-kaya-warm-dark/40 pt-3 mt-3 first:border-t-0 first:pt-0 first:mt-0">
                    {/* Header — name + status pill */}
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-sm font-bold">{emoji} {title}</p>
                      <span
                        className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                          active
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-kaya-warm-dark/30 text-kaya-sand'
                        }`}
                      >
                        {active ? '● Active' : '○ Inactive'}
                      </span>
                    </div>
                    {/* The code itself — visually muted when inactive */}
                    <p className={`text-xl font-mono font-bold tracking-[0.25em] mb-1 ${active ? '' : 'opacity-50'}`}>{code || '…'}</p>
                    <p className="text-[10px] text-kaya-sand leading-relaxed mb-3">{hint}</p>

                    {/* Action row 1 — Activate toggle */}
                    <button
                      onClick={() => toggleCodeActive(key)}
                      disabled={!entry || toggling || isGuest}
                      className={`w-full h-9 rounded-kaya-sm text-xs font-bold mb-2 transition-colors ${
                        active
                          ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                          : 'bg-kaya-gold hover:bg-kaya-gold-dark text-white'
                      } disabled:opacity-50`}
                    >
                      {toggling
                        ? 'Saving…'
                        : active
                          ? 'Deactivate now'
                          : 'Activate · single-use'}
                    </button>

                    {/* Action row 2 — Copy + Share + Regenerate */}
                    <div className="grid grid-cols-4 gap-1.5">
                      <button
                        onClick={() => copyRoleCode(key)}
                        disabled={!code || !active}
                        title={!active ? 'Activate the code first' : ''}
                        className="h-9 rounded-kaya-sm text-[11px] font-bold bg-white border border-kaya-warm-dark text-kaya-sand disabled:opacity-40"
                      >
                        {copiedCode === key ? '✅' : '📋 Copy'}
                      </button>
                      <button
                        onClick={() => shareViaWhatsApp(key)}
                        disabled={!code || !active}
                        title={!active ? 'Activate the code first' : 'Share via WhatsApp'}
                        className="h-9 rounded-kaya-sm text-[11px] font-bold bg-white border border-kaya-warm-dark text-kaya-sand disabled:opacity-40"
                      >
                        💬 WhatsApp
                      </button>
                      <button
                        onClick={() => shareViaEmail(key)}
                        disabled={!code || !active}
                        title={!active ? 'Activate the code first' : 'Share via Email'}
                        className="h-9 rounded-kaya-sm text-[11px] font-bold bg-white border border-kaya-warm-dark text-kaya-sand disabled:opacity-40"
                      >
                        ✉️ Email
                      </button>
                      <button
                        onClick={() => regenerateCode(key)}
                        disabled={!entry || regening || isGuest}
                        title="Replace this code (kills any leaked copy)"
                        className="h-9 rounded-kaya-sm text-[11px] font-bold bg-white border border-kaya-warm-dark text-kaya-sand disabled:opacity-40"
                      >
                        {regening ? '…' : '🔄 New'}
                      </button>
                    </div>
                  </div>
                );
              })}

              <p className="text-[10px] text-kaya-sand-light mt-3 leading-relaxed">
                Codes auto-deactivate after one successful join. Re-activate or regenerate any time. Inviting <em>other</em> families to start their own? Use the referral link instead.
              </p>
            </CollapsibleSection>
          )}

          {/* Plan & billing — current tier + entry to /settings/subscription.
              Family-admin (parent) only; helpers and kids don't manage
              billing. */}
          {isParent && (
            <button
              onClick={() => router.push('/settings/subscription')}
              className="w-full bg-white border border-kaya-warm-dark rounded-kaya p-4 text-left hover:border-kaya-chocolate transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-kaya-sand font-semibold uppercase tracking-wider mb-1">Plan &amp; billing</p>
                  <p className="font-bold text-sm">
                    {currentTierConfig.emoji} {currentTierConfig.name}{' '}
                    <span className="text-kaya-sand font-semibold">· {currentTierConfig.tagline}</span>
                  </p>
                  <p className="text-[11px] text-kaya-sand mt-0.5 leading-relaxed">
                    {tierAccess.tierId === 'castle'
                      ? 'You have full access to every Kaya module.'
                      : tierAccess.tierId === 'home'
                        ? 'See all plans, add-ons, and what Castle unlocks.'
                        : 'See all plans and what upgrading unlocks for your family.'}
                  </p>
                </div>
                <span className="text-kaya-sand text-xl flex-shrink-0">→</span>
              </div>
            </button>
          )}

          {/* Helpers — Tier A login + per-kid scope. Separate page so
              we can iterate on the form without weighing down this
              monster file further. */}
          {isParent && (
            <button
              onClick={() => router.push('/settings/helpers')}
              className="w-full bg-white border border-kaya-warm-dark rounded-kaya p-4 text-left hover:border-kaya-chocolate transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-kaya-sand font-semibold uppercase tracking-wider mb-1">Helpers</p>
                  <p className="font-bold text-sm">Manage helpers + their login codes</p>
                  <p className="text-[11px] text-kaya-sand mt-0.5 leading-relaxed">
                    Add nannies, tutors, grandparents with a family-code login. Pick which kids each helper can act on.
                  </p>
                </div>
                <span className="text-kaya-sand text-xl flex-shrink-0">→</span>
              </div>
            </button>
          )}

          {/* Performance policy — who's tracked + how the helper score is
              built. Lived only under Stats → ⚖️ in the sidebar, so parents
              looking for it in Settings found nothing (Elia, 2026-08-25). */}
          {isParent && (
            <button
              onClick={() => router.push('/settings/performance')}
              className="w-full bg-white border border-kaya-warm-dark rounded-kaya p-4 text-left hover:border-kaya-chocolate transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-kaya-sand font-semibold uppercase tracking-wider mb-1">Helper performance</p>
                  <p className="font-bold text-sm">Choose who&apos;s tracked + tune the score</p>
                  <p className="text-[11px] text-kaya-sand mt-0.5 leading-relaxed">
                    Switch performance tracking on per helper, set their work days, allow kids to review them, and weight the five dials behind the score.
                  </p>
                </div>
                <span className="text-kaya-sand text-xl flex-shrink-0">→</span>
              </div>
            </button>
          )}

          {/* Celebrations — per-kid reward style (animation vs inspiring
              words), age-aware. Own page to keep this file lean. */}
          {isParent && (
            <button
              onClick={() => router.push('/settings/celebrations')}
              className="w-full bg-white border border-kaya-warm-dark rounded-kaya p-4 text-left hover:border-kaya-chocolate transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-kaya-sand font-semibold uppercase tracking-wider mb-1">Celebrations</p>
                  <p className="font-bold text-sm">🎉 How Kaya cheers each kid on</p>
                  <p className="text-[11px] text-kaya-sand mt-0.5 leading-relaxed">
                    Pick a celebration, inspiring words, or a surprise mix — per kid, by age. Preview it too.
                  </p>
                </div>
                <span className="text-kaya-sand text-xl flex-shrink-0">→</span>
              </div>
            </button>
          )}

          {/* Household → Approval policies. Per-category choice between
              "Either parent approves" and "Both parents must approve"
              for every Household request flow. Pantry is the only
              category wired in Purchase v1; the rest take effect as
              the External / Utility / Payroll modules ship. */}
          {isParent && <ApprovalPoliciesCard familyId={profile?.familyId} family={family} />}

          {/* Family members — who has access right now. Pairs with
              the invite-codes card above ("how do they get in") to
              give parents a complete control surface. Removing a
              member detaches them from this family but keeps their
              account so they can rejoin with a fresh code. */}
          {isParent && (
            <CollapsibleSection
              title="Family members"
              summary={listedMembers === null ? '…' : `${listedMembers.length} ${listedMembers.length === 1 ? 'person' : 'people'}`}
            >
              <p className="text-[11px] text-kaya-sand mb-3 leading-relaxed">
                Everyone with access to your family right now. Remove anyone you didn&apos;t intend to add — they keep their account but lose access until you invite them again.
              </p>

              {listedMembers === null ? (
                <p className="text-[11px] text-kaya-sand-light italic">Loading…</p>
              ) : listedMembers.length === 0 ? (
                <p className="text-[11px] text-kaya-sand-light italic">No members yet.</p>
              ) : (
                <div className="space-y-2">
                  {/* Sort: parents first, then helpers, kids, guests; self at top of role bucket */}
                  {[...listedMembers]
                    .sort((a, b) => {
                      const order: Record<string, number> = { parent: 0, helper: 1, kid: 2, guest: 3 };
                      const ra = order[a.role] ?? 9;
                      const rb = order[b.role] ?? 9;
                      if (ra !== rb) return ra - rb;
                      if (a.uid === profile?.uid) return -1;
                      if (b.uid === profile?.uid) return 1;
                      return (a.displayName || '').localeCompare(b.displayName || '');
                    })
                    .map((m) => {
                      const isSelf = m.uid === profile?.uid;
                      const roleStyle =
                        m.role === 'parent' ? 'bg-kaya-gold/15 text-kaya-chocolate'
                        : m.role === 'helper' ? 'bg-blue-100 text-blue-700'
                        : m.role === 'kid'    ? 'bg-emerald-100 text-emerald-700'
                        :                        'bg-kaya-warm-dark/30 text-kaya-sand';
                      const roleEmoji =
                        m.role === 'parent' ? '👨‍👩‍👧‍👦'
                        : m.role === 'helper' ? '🤝'
                        : m.role === 'kid'    ? '⭐'
                        :                        '👀';
                      return (
                        <div key={m.uid} className="flex items-center gap-3 p-2.5 border border-kaya-warm-dark/40 rounded-kaya-sm">
                          {m.photoURL || m.avatarPhoto ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={m.avatarPhoto || m.photoURL}
                              alt=""
                              className="w-9 h-9 rounded-full object-cover shrink-0"
                            />
                          ) : (
                            <div className="w-9 h-9 rounded-full bg-kaya-warm flex items-center justify-center text-base shrink-0">
                              {roleEmoji}
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-1.5">
                              <p className="text-sm font-bold truncate">{m.displayName || '(no name)'}</p>
                              {isSelf && <span className="text-[9px] uppercase tracking-wider text-kaya-sand-light">you</span>}
                            </div>
                            <p className="text-[11px] text-kaya-sand truncate">{m.email || '—'}</p>
                          </div>
                          <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 ${roleStyle}`}>
                            {roleEmoji} {m.role}
                          </span>
                          {!isSelf && (
                            <button
                              onClick={() => handleRemoveMember(m)}
                              disabled={removingMember === m.uid}
                              className="text-[11px] font-bold text-red-600 hover:text-red-700 disabled:opacity-40 shrink-0"
                            >
                              {removingMember === m.uid ? '…' : 'Remove'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}

              {hiddenHelpers > 0 && (
                <button
                  onClick={() => router.push('/settings/helpers')}
                  className="w-full mt-3 flex items-center justify-between gap-2 px-3 py-2 rounded-kaya-sm bg-kaya-warm/60 text-left"
                >
                  <span className="text-[11px] text-kaya-sand">
                    🤝 {hiddenHelpers} {hiddenHelpers === 1 ? 'helper' : 'helpers'} without kid access
                  </span>
                  <span className="text-[11px] font-bold text-kaya-gold shrink-0">Manage →</span>
                </button>
              )}

              <p className="text-[10px] text-kaya-sand-light mt-3 leading-relaxed">
                Kids&apos; profiles (the children themselves) are managed separately under the section below — these are people with sign-in access.
              </p>
            </CollapsibleSection>
          )}

          {/* What kids see — module visibility toggles. Drives the
              kid sidebar, mobile bottom bar, and the More sheet.
              Home is always granted and not shown as a toggle. */}
          {isParent && (
            <div id="kids" className="scroll-mt-24 bg-white border border-kaya-warm-dark rounded-kaya p-4">
              <button
                type="button"
                onClick={() => setKidVisibilityOpen((o) => !o)}
                aria-expanded={kidVisibilityOpen}
                className="w-full flex items-center justify-between gap-2 text-left"
              >
                <p className="text-xs text-kaya-sand font-semibold uppercase tracking-wider">What kids see</p>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-kaya-sand-light">
                    {selectedKidModules.filter((id) => id !== 'home').length} on
                  </span>
                  <span className={`inline-block text-sm text-kaya-sand transition-transform ${kidVisibilityOpen ? 'rotate-180' : ''}`}>⌄</span>
                </span>
              </button>
              {kidVisibilityOpen && (
                <>
                  <p className="text-[11px] text-kaya-sand mb-3 mt-3 leading-relaxed">
                    Pick which modules show up in your kid&apos;s menu. Home is always there. Anything you turn off is hidden from their sidebar and bounces back to Home if they try the URL directly.
                  </p>
              <div className="space-y-2">
                {KID_MODULES.filter((m) => !m.alwaysOn).map((m) => {
                  const sel = selectedKidModules.includes(m.id);
                  const disabled = isGuest;
                  const expanded = expandedKidMods.has(m.id);
                  return (
                    <div key={m.id}>
                      {/* Parent module row — the wide area toggles the
                          module on/off; modules with sub-pages get a
                          chevron (right) to expand + allocate them.
                          Border lives on this wrapper so the chevron
                          shares the selected styling. */}
                      <div
                        className={`flex items-stretch rounded-kaya-sm border-2 transition-all ${
                          sel
                            ? 'border-kaya-gold bg-kaya-gold/5'
                            : 'border-kaya-warm-dark bg-white'
                        } ${savingKidModule === m.id ? 'opacity-60' : ''} ${disabled ? 'opacity-70' : ''}`}
                      >
                        <button
                          onClick={() => toggleKidModule(m.id)}
                          disabled={disabled || savingKidModule === m.id}
                          className={`flex-1 min-w-0 flex items-start gap-3 p-3 text-left ${disabled ? 'cursor-not-allowed' : ''}`}
                        >
                          <span className="text-2xl shrink-0 leading-none">{m.icon}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2 flex-wrap">
                              <p className="text-sm font-bold leading-tight">{m.label}</p>
                              {m.soon && (
                                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-kaya-warm-dark/40 text-kaya-sand">
                                  Coming soon
                                </span>
                              )}
                              {m.isLegacy && (
                                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-kaya-warm-dark/30 text-kaya-sand">
                                  Legacy
                                </span>
                              )}
                              {m.subModules && sel && (
                                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-kaya-gold/20 text-kaya-chocolate">
                                  {selectedKidModules.filter((id) => id.startsWith(`${m.id}:`)).length}/{m.subModules.length} sub-pages
                                </span>
                              )}
                            </div>
                          </div>
                          <span
                            className={`shrink-0 mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center text-[11px] font-bold transition-colors ${
                              sel
                                ? 'bg-kaya-gold border-kaya-gold text-white'
                                : 'border-kaya-warm-dark bg-white text-transparent'
                            }`}
                          >
                            {sel ? '✓' : ''}
                          </span>
                        </button>
                        {m.subModules && sel && (
                          <button
                            type="button"
                            onClick={() => toggleKidModExpand(m.id)}
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${m.label} sub-pages`}
                            className="shrink-0 w-10 flex items-center justify-center text-kaya-sand border-l-2 border-kaya-warm-dark/30 hover:bg-white/60"
                          >
                            <span className={`inline-block text-sm transition-transform ${expanded ? 'rotate-180' : ''}`}>⌄</span>
                          </button>
                        )}
                      </div>

                      {/* Sub-modules — only when parent is on AND the
                          accordion is expanded. Each sub uses the
                          composite id "{parent}:{sub}" so the existing
                          toggleKidModule handler works unchanged. */}
                      {m.subModules && sel && expanded && (
                        <div className="mt-2 ml-6 pl-3 border-l-2 border-kaya-warm-dark/40 space-y-1.5">
                          <p className="text-[10px] text-kaya-sand-light leading-relaxed mb-1">
                            Sub-pages your kid can open inside {m.label}. Off by default — turn on the ones you want them to access.
                          </p>
                          {m.subModules.map((sub) => {
                            const subCompositeId = `${m.id}:${sub.id}`;
                            const subSel = selectedKidModules.includes(subCompositeId);
                            return (
                              <button
                                key={sub.id}
                                onClick={() => toggleKidModule(subCompositeId)}
                                disabled={disabled || savingKidModule === subCompositeId}
                                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-kaya-sm border text-left transition-all ${
                                  subSel
                                    ? 'border-kaya-gold bg-kaya-gold/5'
                                    : 'border-kaya-warm-dark hover:border-kaya-sand-light bg-white'
                                } ${savingKidModule === subCompositeId ? 'opacity-60' : ''}`}
                              >
                                <span className="text-base shrink-0">{sub.icon}</span>
                                <p className="text-xs font-semibold flex-1">{sub.label}</p>
                                <span
                                  className={`shrink-0 w-4 h-4 rounded-md border-2 flex items-center justify-center text-[9px] font-bold ${
                                    subSel
                                      ? 'bg-kaya-gold border-kaya-gold text-white'
                                      : 'border-kaya-warm-dark bg-white text-transparent'
                                  }`}
                                >
                                  {subSel ? '✓' : ''}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Privacy — sibling profile visibility. Surfaced only
                  when Stats (which contains the Kid profiles page) is
                  on, so the toggle never appears for something the kid
                  can't reach. */}
              {selectedKidModules.includes('stats') && (
                <div className="mt-4 pt-4 border-t border-kaya-warm-dark/50">
                  <p className="text-[10px] text-kaya-sand font-semibold uppercase tracking-wider mb-2">Privacy</p>
                  <button
                    onClick={toggleSiblingProfiles}
                    disabled={isGuest || savingSiblingProfiles}
                    className={`w-full flex items-start gap-3 p-3 rounded-kaya-sm border-2 text-left transition-all ${
                      siblingProfilesOn
                        ? 'border-kaya-gold bg-kaya-gold/5'
                        : 'border-kaya-warm-dark hover:border-kaya-sand-light bg-white'
                    } ${savingSiblingProfiles ? 'opacity-60' : ''} ${isGuest ? 'opacity-70 cursor-not-allowed' : ''}`}
                  >
                    <span className="text-2xl shrink-0 leading-none">👀</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold leading-tight">Kids can see each other&apos;s profiles</p>
                      <p className="text-[11px] text-kaya-sand mt-0.5 leading-relaxed">
                        {siblingProfilesOn
                          ? 'On — any kid can open a sibling profile from the Kid profiles page.'
                          : 'Off — each kid sees only their own profile card. Reports and Family tree are unaffected.'}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center text-[11px] font-bold transition-colors ${
                        siblingProfilesOn
                          ? 'bg-kaya-gold border-kaya-gold text-white'
                          : 'border-kaya-warm-dark bg-white text-transparent'
                      }`}
                    >
                      {siblingProfilesOn ? '✓' : ''}
                    </span>
                  </button>
                </div>
              )}
                </>
              )}
            </div>
          )}

          {/* How kids earn points */}
          {isParent && (
            <CollapsibleSection
              title="How kids earn points"
              summary={`${selectedMethods.length}/${FREE_EARNING_METHOD_LIMIT} active`}
            >
              <p className="text-[11px] text-kaya-sand mb-3 leading-relaxed">
                Pick up to {FREE_EARNING_METHOD_LIMIT} ways your family runs. Extras are part of the Pro plan.
              </p>
              <div className="space-y-2">
                {EARNING_METHODS.map((m) => {
                  const sel = selectedMethods.includes(m.id);
                  const selectable = isMethodSelectable(m);
                  const atCap = !sel && selectedMethods.length >= FREE_EARNING_METHOD_LIMIT;
                  const disabled = !selectable || atCap || isGuest;
                  return (
                    <button
                      key={m.id}
                      onClick={() => toggleEarningMethod(m.id)}
                      disabled={disabled || savingMethod === m.id}
                      className={`w-full flex items-start gap-3 p-3 rounded-kaya-sm border-2 text-left transition-all ${
                        sel
                          ? 'border-kaya-gold bg-kaya-gold/5'
                          : disabled
                            ? 'border-kaya-warm-dark bg-kaya-warm/30 opacity-70 cursor-not-allowed'
                            : 'border-kaya-warm-dark hover:border-kaya-sand-light bg-white'
                      } ${savingMethod === m.id ? 'opacity-60' : ''}`}
                    >
                      <span className="text-2xl shrink-0 leading-none">{m.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <p className="text-sm font-bold leading-tight">{m.title}</p>
                          {m.tier === 'pro' && (
                            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">
                              🔒 Pro
                            </span>
                          )}
                          {m.tier === 'free' && m.status === 'soon' && (
                            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-kaya-warm-dark/40 text-kaya-sand">
                              Coming soon
                            </span>
                          )}
                          {atCap && (
                            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-kaya-warm-dark/30 text-kaya-sand">
                              Limit reached
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-kaya-sand leading-snug mt-0.5">{m.description}</p>
                      </div>
                      <span
                        className={`shrink-0 mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center text-[11px] font-bold transition-colors ${
                          sel
                            ? 'bg-kaya-gold border-kaya-gold text-white'
                            : disabled
                              ? 'border-kaya-warm-dark/60 bg-white text-transparent'
                              : 'border-kaya-warm-dark bg-white text-transparent'
                        }`}
                      >
                        {sel ? '✓' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-kaya-sand-light mt-3 leading-relaxed">
                The roadmap items show up here so you know what&apos;s next. We&apos;ll switch them on as they ship.
              </p>
            </CollapsibleSection>
          )}

          {/* Point system rules — tier caps, reducing on/off, Kudos +
              Improvement Note thresholds. Only relevant when the family
              uses "Bonus awards" (the awards module). */}
          {isParent && selectedMethods.includes('awards') && (
            <CollapsibleSection title="Point system rules">
              <div className="space-y-4">
                <p className="text-[11px] text-kaya-sand leading-relaxed">
                  Tune the limits and special award types. Defaults work well — tweak only what your family needs.
                </p>

              {/* Routine Points → House Points conversion */}
              <div className="border-t border-kaya-warm-dark/40 pt-3">
                <div className="flex items-baseline justify-between gap-2 mb-2">
                  <p className="text-sm font-semibold">📋 Routine → House Points</p>
                  <span className="text-[10px] text-kaya-sand-light">
                    {pointSystem.routines.pointsPerHousePoint} RP = 1 HP
                  </span>
                </div>
                <p className="text-[11px] text-kaya-sand mb-2 leading-relaxed">
                  Rated routines (Excellent / Good / Bad) earn Routine Points. They auto-convert into a House Point once the threshold is met. Lower = faster conversion; higher = routine points stay distinct from headline score.
                </p>
                <div className="grid grid-cols-5 gap-1.5">
                  {[10, 25, 50, 100, 200].map((n) => (
                    <button
                      key={n}
                      onClick={() => savePointSystem('rp-rate', { routines: { pointsPerHousePoint: n } })}
                      disabled={isGuest || savingPointSystem === 'rp-rate'}
                      className={`h-9 rounded-kaya-sm font-bold text-xs transition-all ${
                        pointSystem.routines.pointsPerHousePoint === n
                          ? 'bg-kaya-gold text-white shadow-sm'
                          : 'bg-white border border-kaya-warm-dark text-kaya-sand'
                      } disabled:opacity-50`}
                    >{n}</button>
                  ))}
                </div>
                {/* Custom value — escape hatch when none of the chips fit.
                    Accepts 1–9999. Save-on-blur so typing doesn't fire a
                    write per keystroke. */}
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-[10px] font-semibold text-kaya-sand uppercase tracking-wider">Custom</label>
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    step={1}
                    value={rpRateDraft}
                    onChange={(e) => setRpRateDraft(e.target.value)}
                    onBlur={() => {
                      const n = parseInt(rpRateDraft, 10);
                      if (Number.isFinite(n) && n >= 1 && n <= 9999 && n !== pointSystem.routines.pointsPerHousePoint) {
                        savePointSystem('rp-rate', { routines: { pointsPerHousePoint: n } });
                      } else {
                        setRpRateDraft(String(pointSystem.routines.pointsPerHousePoint));
                      }
                    }}
                    disabled={isGuest}
                    className="h-9 w-24 px-2 rounded-kaya-sm border border-kaya-warm-dark bg-white text-xs font-bold text-center focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
                  />
                  <span className="text-[10px] text-kaya-sand-light">RP per House Point</span>
                </div>
              </div>

              {/* Diamond threshold */}
              <div className="border-t border-kaya-warm-dark/40 pt-3">
                <div className="flex items-baseline justify-between gap-2 mb-2">
                  <p className="text-sm font-semibold">💎 Diamond threshold</p>
                  <span className="text-[10px] text-kaya-sand-light">
                    Regular ≤ {pointSystem.diamondMinPoints - 1}, Diamond ≥ {pointSystem.diamondMinPoints}
                  </span>
                </div>
                <p className="text-[11px] text-kaya-sand mb-2 leading-relaxed">
                  Awards at or above this number are flagged as Diamond. Lower values stay Regular.
                </p>
                <div className="flex gap-2">
                  {[3, 4, 5, 6].map((n) => (
                    <button
                      key={n}
                      onClick={() => savePointSystem('diamond', { diamondMinPoints: n })}
                      disabled={isGuest || savingPointSystem === 'diamond'}
                      className={`flex-1 h-10 rounded-kaya-sm font-bold text-sm transition-all ${
                        pointSystem.diamondMinPoints === n
                          ? 'bg-purple-600 text-white shadow-md shadow-purple-600/30'
                          : 'bg-white border border-kaya-warm-dark text-kaya-sand'
                      } disabled:opacity-50`}
                    >+{n}</button>
                  ))}
                </div>
              </div>

              {/* Reducing points */}
              <div className="border-t border-kaya-warm-dark/40 pt-3">
                <button
                  onClick={() => savePointSystem('reducing-toggle', { reducing: { ...pointSystem.reducing, enabled: !pointSystem.reducing.enabled } })}
                  disabled={isGuest || savingPointSystem === 'reducing-toggle'}
                  className="w-full flex items-start gap-3 text-left disabled:opacity-60"
                >
                  <div className={`w-10 h-6 rounded-full shrink-0 mt-0.5 relative transition-colors ${pointSystem.reducing.enabled ? 'bg-kaya-gold' : 'bg-kaya-warm-dark'}`}>
                    <div
                      className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all"
                      style={{ left: pointSystem.reducing.enabled ? '18px' : '2px' }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold">⚠️ Reducing points</p>
                    <p className="text-[11px] text-kaya-sand leading-relaxed">
                      Allow parents to take points away for slips. Off by default — leaving this off keeps the system encouragement-only.
                    </p>
                  </div>
                </button>
                {pointSystem.reducing.enabled && (
                  <div className="mt-3 pl-13">
                    <p className="text-[11px] text-kaya-sand mb-2 leading-relaxed">
                      Largest deduction allowed per award: <span className="font-bold">−{pointSystem.reducing.max}</span>
                    </p>
                    <div className="grid grid-cols-5 gap-1.5">
                      {[1, 2, 3, 5, 10].map((n) => (
                        <button
                          key={n}
                          onClick={() => savePointSystem('reducing-max', { reducing: { ...pointSystem.reducing, max: n } })}
                          disabled={isGuest || savingPointSystem === 'reducing-max'}
                          className={`h-9 rounded-kaya-sm font-bold text-xs transition-all ${
                            pointSystem.reducing.max === n
                              ? 'bg-red-500 text-white shadow-sm'
                              : 'bg-white border border-kaya-warm-dark text-kaya-sand'
                          } disabled:opacity-50`}
                        >−{n}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Kudos */}
              <div className="border-t border-kaya-warm-dark/40 pt-3">
                <button
                  onClick={() => savePointSystem('kudos-toggle', { kudos: { ...pointSystem.kudos, enabled: !pointSystem.kudos.enabled } })}
                  disabled={isGuest || savingPointSystem === 'kudos-toggle'}
                  className="w-full flex items-start gap-3 text-left disabled:opacity-60"
                >
                  <div className={`w-10 h-6 rounded-full shrink-0 mt-0.5 relative transition-colors ${pointSystem.kudos.enabled ? 'bg-kaya-gold' : 'bg-kaya-warm-dark'}`}>
                    <div
                      className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all"
                      style={{ left: pointSystem.kudos.enabled ? '18px' : '2px' }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold">👍 {pointSystem.kudos.label}</p>
                    <p className="text-[11px] text-kaya-sand leading-relaxed">
                      Zero-point recognition that adds up. Every {pointSystem.kudos.threshold} earns a bonus of +{pointSystem.kudos.bonusPoints}.
                    </p>
                  </div>
                </button>
                {pointSystem.kudos.enabled && (
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="block text-[10px] font-semibold text-kaya-sand uppercase tracking-wider mb-1">Label</label>
                      <input
                        value={kudosLabelDraft}
                        onChange={(e) => setKudosLabelDraft(e.target.value)}
                        onBlur={() => {
                          const v = kudosLabelDraft.trim();
                          if (v && v !== pointSystem.kudos.label) {
                            savePointSystem('kudos-label', { kudos: { ...pointSystem.kudos, label: v } });
                          } else if (!v) {
                            setKudosLabelDraft(pointSystem.kudos.label);
                          }
                        }}
                        disabled={isGuest}
                        className="w-full h-9 px-3 bg-white border border-kaya-warm-dark rounded-kaya-sm text-sm focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
                        placeholder="Kudos"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-semibold text-kaya-sand uppercase tracking-wider mb-1">Threshold</label>
                        <div className="grid grid-cols-4 gap-1">
                          {[3, 4, 5, 6].map((n) => (
                            <button
                              key={n}
                              onClick={() => savePointSystem('kudos-threshold', { kudos: { ...pointSystem.kudos, threshold: n } })}
                              disabled={isGuest || savingPointSystem === 'kudos-threshold'}
                              className={`h-9 rounded-kaya-sm font-bold text-xs transition-all ${
                                pointSystem.kudos.threshold === n
                                  ? 'bg-kaya-gold text-white shadow-sm'
                                  : 'bg-white border border-kaya-warm-dark text-kaya-sand'
                              } disabled:opacity-50`}
                            >{n}×</button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-kaya-sand uppercase tracking-wider mb-1">Bonus</label>
                        <div className="grid grid-cols-3 gap-1">
                          {[1, 2, 3].map((n) => (
                            <button
                              key={n}
                              onClick={() => savePointSystem('kudos-bonus', { kudos: { ...pointSystem.kudos, bonusPoints: n } })}
                              disabled={isGuest || savingPointSystem === 'kudos-bonus'}
                              className={`h-9 rounded-kaya-sm font-bold text-xs transition-all ${
                                pointSystem.kudos.bonusPoints === n
                                  ? 'bg-kaya-gold text-white shadow-sm'
                                  : 'bg-white border border-kaya-warm-dark text-kaya-sand'
                              } disabled:opacity-50`}
                            >+{n}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                    {/* Kid → kid appreciation note. Opt-in: when ON,
                        siblings can send each other 0-point kudos that
                        feed the same threshold accumulator. Daily cap
                        prevents spam. */}
                    <div className="mt-3 pt-3 border-t border-kaya-warm-dark/30">
                      <button
                        onClick={() => savePointSystem('kudos-k2k', { kudos: { ...pointSystem.kudos, kidToKidEnabled: !pointSystem.kudos.kidToKidEnabled } })}
                        disabled={isGuest || savingPointSystem === 'kudos-k2k'}
                        className="w-full flex items-start gap-3 text-left disabled:opacity-60"
                      >
                        <div className={`w-10 h-6 rounded-full shrink-0 mt-0.5 relative transition-colors ${pointSystem.kudos.kidToKidEnabled ? 'bg-kaya-gold' : 'bg-kaya-warm-dark'}`}>
                          <div
                            className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all"
                            style={{ left: pointSystem.kudos.kidToKidEnabled ? '18px' : '2px' }}
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold">💛 Kid → kid appreciation</p>
                          <p className="text-[11px] text-kaya-sand leading-relaxed">
                            Let siblings send each other a {pointSystem.kudos.label}. Counts toward the same bonus threshold.
                          </p>
                        </div>
                      </button>
                      {pointSystem.kudos.kidToKidEnabled && (
                        <div className="mt-3">
                          <label className="block text-[10px] font-semibold text-kaya-sand uppercase tracking-wider mb-1">Daily limit per kid</label>
                          <div className="grid grid-cols-5 gap-1">
                            {[1, 2, 3, 5, 10].map((n) => (
                              <button
                                key={n}
                                onClick={() => savePointSystem('kudos-k2k-cap', { kudos: { ...pointSystem.kudos, kidDailyCap: n } })}
                                disabled={isGuest || savingPointSystem === 'kudos-k2k-cap'}
                                className={`h-9 rounded-kaya-sm font-bold text-xs transition-all ${
                                  (pointSystem.kudos.kidDailyCap ?? 3) === n
                                    ? 'bg-kaya-gold text-white shadow-sm'
                                    : 'bg-white border border-kaya-warm-dark text-kaya-sand'
                                } disabled:opacity-50`}
                              >{n}</button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Improvement Note */}
              <div className="border-t border-kaya-warm-dark/40 pt-3">
                <button
                  onClick={() => savePointSystem('imp-toggle', { improvementNote: { ...pointSystem.improvementNote, enabled: !pointSystem.improvementNote.enabled } })}
                  disabled={isGuest || savingPointSystem === 'imp-toggle'}
                  className="w-full flex items-start gap-3 text-left disabled:opacity-60"
                >
                  <div className={`w-10 h-6 rounded-full shrink-0 mt-0.5 relative transition-colors ${pointSystem.improvementNote.enabled ? 'bg-kaya-gold' : 'bg-kaya-warm-dark'}`}>
                    <div
                      className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all"
                      style={{ left: pointSystem.improvementNote.enabled ? '18px' : '2px' }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold">👉 {pointSystem.improvementNote.label}</p>
                    <p className="text-[11px] text-kaya-sand leading-relaxed">
                      Zero-point note that adds up. Every {pointSystem.improvementNote.threshold} {pointSystem.reducing.enabled ? `takes −${pointSystem.improvementNote.deductionPoints}` : 'is tracked (deduction needs Reducing on)'}.
                    </p>
                  </div>
                </button>
                {pointSystem.improvementNote.enabled && (
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="block text-[10px] font-semibold text-kaya-sand uppercase tracking-wider mb-1">Label</label>
                      <input
                        value={improvementLabelDraft}
                        onChange={(e) => setImprovementLabelDraft(e.target.value)}
                        onBlur={() => {
                          const v = improvementLabelDraft.trim();
                          if (v && v !== pointSystem.improvementNote.label) {
                            savePointSystem('imp-label', { improvementNote: { ...pointSystem.improvementNote, label: v } });
                          } else if (!v) {
                            setImprovementLabelDraft(pointSystem.improvementNote.label);
                          }
                        }}
                        disabled={isGuest}
                        className="w-full h-9 px-3 bg-white border border-kaya-warm-dark rounded-kaya-sm text-sm focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
                        placeholder="Improvement Note"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-semibold text-kaya-sand uppercase tracking-wider mb-1">Threshold</label>
                        <div className="grid grid-cols-4 gap-1">
                          {[3, 4, 5, 6].map((n) => (
                            <button
                              key={n}
                              onClick={() => savePointSystem('imp-threshold', { improvementNote: { ...pointSystem.improvementNote, threshold: n } })}
                              disabled={isGuest || savingPointSystem === 'imp-threshold'}
                              className={`h-9 rounded-kaya-sm font-bold text-xs transition-all ${
                                pointSystem.improvementNote.threshold === n
                                  ? 'bg-kaya-gold text-white shadow-sm'
                                  : 'bg-white border border-kaya-warm-dark text-kaya-sand'
                              } disabled:opacity-50`}
                            >{n}×</button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-kaya-sand uppercase tracking-wider mb-1">Deduction</label>
                        <div className="grid grid-cols-3 gap-1">
                          {[1, 2, 3].map((n) => (
                            <button
                              key={n}
                              onClick={() => savePointSystem('imp-deduction', { improvementNote: { ...pointSystem.improvementNote, deductionPoints: n } })}
                              disabled={isGuest || savingPointSystem === 'imp-deduction' || !pointSystem.reducing.enabled}
                              className={`h-9 rounded-kaya-sm font-bold text-xs transition-all ${
                                pointSystem.improvementNote.deductionPoints === n
                                  ? 'bg-red-500 text-white shadow-sm'
                                  : 'bg-white border border-kaya-warm-dark text-kaya-sand'
                              } disabled:opacity-50`}
                            >−{n}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                    {!pointSystem.reducing.enabled && (
                      <p className="text-[10px] text-kaya-sand-light italic">
                        Turn on Reducing points above to make deductions take effect.
                      </p>
                    )}
                  </div>
                )}
              </div>
              </div>
            </CollapsibleSection>
          )}

          {/* Daily routines editor — the morning / evening checklist
              that drives the Rate page. */}
          {isParent && selectedMethods.includes('routines') && (
            <RoutinesEditor />
          )}

          {/* One-time historical import (e.g. Google Sheet of past
              ratings). Surfaced as a link rather than inline so the
              dense mapping UI lives on its own page. */}
          {isParent && !isGuest && (
            <CollapsibleSection title="Import past ratings">
              <p className="text-[11px] text-kaya-sand mb-3 leading-relaxed">
                Bringing data from a Google Sheet or spreadsheet log? Paste it once, map the columns, and we&apos;ll
                back-fill the daily ratings (comments included). Re-running is safe — existing rows for the same
                kid/date/period get replaced.
              </p>
              <a
                href="/settings/import"
                className="inline-flex items-center gap-1.5 h-10 px-4 bg-kaya-chocolate text-white rounded-kaya-sm text-xs font-bold hover:bg-kaya-chocolate-light transition-colors"
              >
                📥 Open importer
              </a>
            </CollapsibleSection>
          )}

          {/* Points Mode */}
          {isParent && (
            <CollapsibleSection title="Points mode">
              <div className="space-y-2">
                {[
                  { value: 'full' as PointsMode, label: 'Full Points', desc: 'Show all points and rankings' },
                  { value: 'badges-only' as PointsMode, label: 'Badges Only', desc: 'Focus on badges, hide point numbers' },
                  { value: 'encouragement' as PointsMode, label: 'Encouragement', desc: 'No competition, positive reinforcement only' },
                ].map((mode) => (
                  <button
                    key={mode.value}
                    onClick={() => handlePointsMode(mode.value)}
                    className={`w-full text-left p-3 rounded-kaya-sm border-2 transition-all ${
                      pointsMode === mode.value ? 'border-kaya-gold bg-kaya-gold/5' : 'border-kaya-warm-dark'
                    }`}
                  >
                    <p className="text-sm font-semibold">{mode.label}</p>
                    <p className="text-xs text-kaya-sand">{mode.desc}</p>
                  </button>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* Device push notifications (FCM). Sits above the email
              notifications card because push is the primary channel
              once a user has installed the PWA. */}
          {!isGuest && <NotificationSettings />}

          {/* Notifications */}
          {!isGuest && (
            <CollapsibleSection title="Email notifications">
              <div className="space-y-2">
                {[
                  { key: 'rating' as const, on: notifyOnRating, label: 'When a routine is rated', desc: 'Email me when someone in the family rates a kid’s morning or evening routine.' },
                  { key: 'award' as const,  on: notifyOnAward,  label: 'When bonus points are awarded', desc: 'Email me when someone awards a kid bonus points (kindness, helping, diamond points).' },
                ].map((p) => (
                  <div key={p.key}>
                  <button
                    onClick={() => togglePref(p.key)}
                    disabled={savingPref === p.key}
                    className="w-full flex items-start gap-3 p-3 rounded-kaya-sm border border-kaya-warm-dark hover:border-kaya-sand-light text-left transition-colors disabled:opacity-60"
                  >
                    <div className={`w-10 h-6 rounded-full shrink-0 mt-0.5 relative transition-colors ${p.on ? 'bg-kaya-gold' : 'bg-kaya-warm-dark'}`}>
                      <div
                        className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all"
                        style={{ left: p.on ? '18px' : '2px' }}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">{p.label}</p>
                      <p className="text-[11px] text-kaya-sand leading-relaxed">{p.desc}</p>
                    </div>
                  </button>
                  {/* 📮 Points Audience (2026-08-09) — family-level extra
                      recipients per type; parents edit, everyone benefits. */}
                  {isParent && <PointsAudienceRow type={p.key} />}
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-kaya-sand-light mt-3 leading-relaxed">
                Emails are sent from <strong>noreply@ourkaya.com</strong>. Toggle these any time.
              </p>

              {/* 📮 Email groups (Reminders v4) — parents bundle recipients
                  once, pick them as one-tap chips in every reminder. Lives
                  here with the rest of the email settings (Elia, 04-Jul). */}
              {isParent && <div className="mt-3"><EmailGroupsCard /></div>}
            </CollapsibleSection>
          )}

          {/* ✉️ Greeting cards (Reminders 2.0, approved 22-Aug-2026) — People
              Book (honorees outside Kaya) + family signature + Kaya Writes. */}
          {!isGuest && isParent && (
            <CollapsibleSection id="greetings" remember icon="✉️" title="Greeting cards"
              summary={(family?.contacts?.length || 0) > 0 ? `${family?.contacts?.length} people` : undefined}>
              <div className="space-y-3">
                <PeopleBookCard />
                <GreetingSignatureCard />
              </div>
            </CollapsibleSection>
          )}

          {/* Family contacts — email-only recipients (e.g. grandparents,
              godparents, tutors) who get the same notifications as the
              parents/helpers in the family. Parents only. */}
          {!isGuest && isParent && (
            <CollapsibleSection title="Family contacts" summary={externalContacts.length > 0 ? `${externalContacts.length}` : undefined}>
              <p className="text-[11px] text-kaya-sand mb-3 leading-relaxed">
                Email-only people (grandparents, godparents, tutors…) who get the same rating + award emails as the family. They don&apos;t need a Kaya account.
              </p>

              {externalContacts.length > 0 && (
                <div className="space-y-2 mb-3">
                  {externalContacts.map((c) => {
                    const onRating = c.notifyOnRating !== false;
                    const onAward  = c.notifyOnAward  !== false;
                    const busy = contactBusy === c.id;
                    return (
                      <div key={c.id} className="border border-kaya-warm-dark rounded-kaya-sm p-3">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold truncate">{c.name}</p>
                            <p className="text-[11px] text-kaya-sand truncate">{c.email}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => deleteContact(c)}
                            disabled={busy}
                            className="text-[11px] font-semibold text-red-500 hover:underline disabled:opacity-40"
                          >
                            Remove
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {[
                            { key: 'notifyOnRating' as const, on: onRating, label: 'Ratings' },
                            { key: 'notifyOnAward'  as const, on: onAward,  label: 'Awards' },
                          ].map((p) => (
                            <button
                              key={p.key}
                              type="button"
                              onClick={() => toggleContactPref(c, p.key)}
                              disabled={busy}
                              className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition-colors disabled:opacity-50 ${
                                p.on
                                  ? 'bg-kaya-chocolate text-white border-transparent'
                                  : 'border-kaya-warm-dark bg-white text-kaya-sand'
                              }`}
                            >
                              {p.on ? '✓ ' : ''}{p.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Add new contact form — always visible at the bottom. */}
              <div className="border border-dashed border-kaya-warm-dark rounded-kaya-sm p-3">
                <p className="text-[11px] text-kaya-sand font-semibold uppercase tracking-wider mb-2">Add a contact</p>
                <div className="space-y-2">
                  <input
                    type="text"
                    placeholder="Name (e.g. Grandma Rose)"
                    value={contactDraft.name}
                    onChange={(e) => setContactDraft((d) => ({ ...d, name: e.target.value }))}
                    disabled={savingContact}
                    className="w-full px-3 py-2 bg-kaya-cream rounded-kaya-sm text-sm focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
                  />
                  <input
                    type="email"
                    placeholder="Email address"
                    value={contactDraft.email}
                    onChange={(e) => setContactDraft((d) => ({ ...d, email: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitNewContact(); }}
                    disabled={savingContact}
                    className="w-full px-3 py-2 bg-kaya-cream rounded-kaya-sm text-sm focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
                  />
                  {contactDraftError && (
                    <p className="text-[11px] text-red-500">{contactDraftError}</p>
                  )}
                  <button
                    type="button"
                    onClick={submitNewContact}
                    disabled={savingContact || !contactDraft.name.trim() || !contactDraft.email.trim()}
                    className="w-full h-9 bg-kaya-gold text-white rounded-kaya-sm font-bold text-xs disabled:opacity-40"
                  >
                    {savingContact ? 'Adding…' : '+ Add contact'}
                  </button>
                </div>
              </div>
            </CollapsibleSection>
          )}

          {/* Add child */}
          {isParent && (
            <div className="bg-white border border-kaya-warm-dark rounded-kaya p-4">
              <p className="text-xs text-kaya-sand font-semibold uppercase tracking-wider mb-3">Children</p>
              <div className="space-y-2 mb-3">
                {children.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 text-sm flex-wrap">
                    <button
                      type="button"
                      onClick={() => setAvatarChild({ id: c.id, name: c.name, avatarEmoji: c.avatarEmoji })}
                      title="Change avatar"
                      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 hover:bg-kaya-warm transition-colors"
                    >
                      <span className="text-base">{c.avatarEmoji}</span>
                      <span className="text-[9px] text-kaya-sand font-bold">✎</span>
                    </button>
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-kaya-sand">— {c.houseName}</span>
                    {isLittleStar(c, family) && (
                      <span className="text-[10px] font-black rounded-full px-2 py-0.5" style={{ background: '#FDF3E4', color: '#9a5f14' }}>🌟 Little Star</span>
                    )}
                    {profileUnfinished(c) && (
                      <button type="button" onClick={() => setWizardChild(c)}
                        className="text-[10px] font-black rounded-full px-2 py-0.5" style={{ background: '#FDF2F4', color: '#B4485A' }}>
                        ✎ Finish profile →
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={newChildName}
                  onChange={(e) => setNewChildName(e.target.value)}
                  className="flex-1 h-10 px-3 bg-kaya-cream rounded-kaya-sm text-sm focus:outline-none focus:ring-2 focus:ring-kaya-gold/40"
                  placeholder="Add a child…"
                />
                <button
                  onClick={handleAddChild}
                  disabled={!newChildName.trim() || addingChild}
                  className="h-10 px-4 bg-kaya-gold text-white rounded-kaya-sm text-sm font-bold disabled:opacity-40"
                >Add</button>
              </div>
              {avatarChild && (
                <AvatarEmojiPickerModal
                  title={`${avatarChild.name}'s avatar`}
                  value={avatarChild.avatarEmoji || '🏅'}
                  saving={savingAvatar}
                  onClose={() => setAvatarChild(null)}
                  onSave={async (emoji) => {
                    if (!profile?.familyId) return;
                    setSavingAvatar(true);
                    try {
                      await updateChild(profile.familyId, avatarChild.id, { avatarEmoji: emoji });
                      await refresh();
                      setAvatarChild(null);
                    } finally {
                      setSavingAvatar(false);
                    }
                  }}
                />
              )}
            </div>
          )}

          {/* 🌟 Little Stars — participation ages + celebration length
              (2026-07-26, Elia-approved design §2 + §3). */}
          {isParent && (<>
            <CollapsibleSection
              id="kid-stats"
              remember
              icon="📈"
              title="My Stats options"
              summary="what kids can do on their stats page"
            >
              <p className="text-[11px] text-kaya-sand mb-2">📈 My Stats is granted per kid under &ldquo;What kids see&rdquo; → Stats. These switches shape what the page offers (all default on).</p>
              {([
                ['reflections', '💬 Kids can add reflections', 'comments on their own ratings, visible to family'],
                ['compare', '⚖️ Compare mode', 'period-vs-period comparisons'],
                ['helpNudges', '🤝 “I need help” nudges', 'kid can ping a parent from a struggling behaviour'],
                ['catchGood', '🔦 Catch someone doing good', 'kid nominates deeds; parents decide the award'],
              ] as const).map(([key, label, sub]) => {
                const on = (family as any)?.statsConfig?.[key] !== false;
                return (
                  <div key={key} className="flex items-center justify-between gap-3 py-2.5 border-b border-dashed border-kaya-warm-dark last:border-b-0">
                    <div>
                      <p className="text-[13px] font-bold">{label}</p>
                      <p className="text-[11px] text-kaya-sand">{sub}</p>
                    </div>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={async () => {
                        if (!profile?.familyId) return;
                        await updateFamily(profile.familyId, {
                          statsConfig: { ...(family as any)?.statsConfig, [key]: !on },
                        } as any);
                        await refresh();
                      }}
                      className={`w-11 h-6 rounded-full relative transition-colors shrink-0 ${on ? 'bg-emerald-500' : 'bg-kaya-warm-dark'}`}
                    >
                      <span className={`absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all ${on ? 'right-[3px]' : 'left-[3px]'}`} />
                    </button>
                  </div>
                );
              })}
            </CollapsibleSection>

            <CollapsibleSection
              id="participation"
              remember
              icon="🌟"
              title="Participation ages"
              summary={`Sparks ${partAges.sparksFromAge} · meetings ${partAges.meetingsFromAge}`}
            >
              <p className="text-[11px] text-kaya-sand mb-3">Little Stars join the family everywhere it warms — tasks &amp; meetings start at the ages you set. Each kid&rsquo;s profile can override.</p>
              {([
                ['sparksFromAge', '✨ Kaya Sparks from', 'tasks, routines & ratings begin'],
                ['meetingsFromAge', '🗓️ Sunday meetings from', 'counted in attendance, gratitude & goals'],
              ] as const).map(([key, label, sub]) => (
                <div key={key} className="flex items-center justify-between gap-3 py-2.5 border-b border-dashed border-kaya-warm-dark">
                  <div>
                    <p className="text-[13px] font-bold">{label}</p>
                    <p className="text-[11px] text-kaya-sand">{sub}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => void bumpAge(key, -1)} className="w-8 h-8 rounded-kaya-sm border border-kaya-warm-dark font-black">−</button>
                    {/* Tap the number to type an exact age (saves on leave/Enter). */}
                    <span className="flex items-baseline gap-1 font-black text-sm">
                      age
                      <input
                        key={partAges[key]}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={18}
                        defaultValue={partAges[key]}
                        aria-label={`${label} — type the exact age`}
                        onBlur={(e) => void setAge(key, Number(e.target.value))}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        className="w-12 h-8 text-center font-black text-sm rounded-kaya-sm border border-kaya-warm-dark bg-white focus:outline-none focus:ring-2 focus:ring-kaya-gold/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    </span>
                    <button type="button" onClick={() => void bumpAge(key, 1)} className="w-8 h-8 rounded-kaya-sm border border-kaya-warm-dark font-black">＋</button>
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <p className="text-[13px] font-bold">🎊 Arrival celebration</p>
                  <p className="text-[11px] text-kaya-sand">how long a new member&rsquo;s welcome stays on Home</p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => void bumpCelebration(-7)} className="w-8 h-8 rounded-kaya-sm border border-kaya-warm-dark font-black">−</button>
                  {/* Tap the number to type exact days (saves on leave/Enter). */}
                  <span className="flex items-baseline gap-1 font-black text-sm">
                    <input
                      key={celebrationDays}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={60}
                      defaultValue={celebrationDays}
                      aria-label="Arrival celebration — type the exact number of days"
                      onBlur={(e) => void setCelebration(Number(e.target.value))}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      className="w-14 h-8 text-center font-black text-sm rounded-kaya-sm border border-kaya-warm-dark bg-white focus:outline-none focus:ring-2 focus:ring-kaya-gold/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    days
                  </span>
                  <button type="button" onClick={() => void bumpCelebration(7)} className="w-8 h-8 rounded-kaya-sm border border-kaya-warm-dark font-black">＋</button>
                </div>
              </div>
            </CollapsibleSection>

            {/* 🤖 Kaya AI level (approved 2026-09-07) — family default +
                per-child overrides for how firmly Kaya marks / explains /
                pushes. lib/ai/level.shared.ts holds the rules. */}
            <CollapsibleSection
              id="ai-level"
              remember
              icon="🤖"
              title="Kaya AI level"
              summary={`family ${aiLevelFamily.emoji} ${aiLevelFamily.name}`}
            >
              <AiLevelCard />
            </CollapsibleSection>
          </>)}

          {/* Welcome Wizard sheet */}
          {wizardChild && profile?.familyId && (
            <KidWelcomeWizard
              familyId={profile.familyId}
              child={wizardChild}
              onClose={() => { setWizardChild(null); void refresh(); }}
            />
          )}

          {/* Navigation links — parent-only. Helpers don't need to
              navigate to Kid Profiles / Reports / Badges from their
              own Settings page (2026-05-19, Elia helper-cleanup pass). */}
          {isParent && (
            <div className="bg-white border border-kaya-warm-dark rounded-kaya overflow-hidden">
              {[
                { label: 'Kid Profiles', path: '/profiles', icon: '👧' },
                { label: 'Reports',      path: '/reports',  icon: '📊' },
                { label: 'Badges',       path: '/badges',   icon: '🏆' },
              ].map((item, i) => (
                <button
                  key={item.path}
                  onClick={() => router.push(item.path)}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-kaya-cream transition-colors ${
                    i > 0 ? 'border-t border-kaya-warm-dark' : ''
                  }`}
                >
                  <span className="text-lg">{item.icon}</span>
                  <span className="text-sm font-medium flex-1">{item.label}</span>
                  <span className="text-kaya-sand text-sm">→</span>
                </button>
              ))}
            </div>
          )}

          {/* Sign out */}
          <button
            onClick={handleSignOut}
            className="w-full h-11 bg-red-50 text-red-500 rounded-kaya text-sm font-semibold hover:bg-red-100 transition-colors mb-8 lg:mb-0"
          >Sign Out</button>
        </div>

        {/* ── Right column: invite friends — desktop only ─────── */}
        {isParent && family && (
          <aside className="hidden lg:block lg:col-span-5 space-y-2 sticky top-20">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-kaya-sand mb-2 px-1">Invite friends · earn rewards</p>
            {ReferralPanel}
          </aside>
        )}
      </div>
    </div>
  );
}

// ── Household → Approval policies ─────────────────────────────
// Per-category Either/Both approval toggle. One row per request type.
// Pantry is the only one Purchase v1 reads today; the rest live here
// already so families can set their preferences before the modules
// land, and so the External/Utility/Payroll surfaces can read from
// `family.approvalModes` on day one.
type ApprovalCategoryKey = 'pantry' | 'outdoor' | 'drivers' | 'utility' | 'dineOut' | 'home' | 'payrollAdvance' | 'payrollLoan';
const APPROVAL_CATEGORIES: Array<{
  key: ApprovalCategoryKey;
  emoji: string;
  label: string;
  hint: string;
  live: boolean;
}> = [
  { key: 'pantry',         emoji: '🛒', label: 'Pantry purchases',   hint: 'Groceries, household staples.',                                      live: true  },
  { key: 'outdoor',        emoji: '🌿', label: 'Outdoor purchases',  hint: 'Garden, pool, kuku, pets, repairs — everything outside the kitchen.', live: true  },
  { key: 'drivers',        emoji: '🚗', label: 'Drivers purchases',  hint: 'Fuel, vehicle service, spare parts, car wash, tolls / parking.',     live: true  },
  { key: 'utility',        emoji: '⚡', label: 'Utility top-ups',    hint: 'Electricity, water, internet, gas refills.',                        live: false },
  { key: 'payrollAdvance', emoji: '💵', label: 'Payroll advances',   hint: 'Helpers requesting an advance on next pay.',                        live: false },
  { key: 'payrollLoan',    emoji: '🏦', label: 'Payroll loans',      hint: 'Helpers requesting a loan with a repayment schedule.',              live: false },
  { key: 'dineOut',        emoji: '🍽️', label: 'Dine Out',           hint: 'Meals out — restaurants, takeaway, delivery, coffee. Parent-logged.', live: true  },
  { key: 'home',           emoji: '🛋️', label: 'Home & Wellness',     hint: 'Furniture, appliances, décor, fittings + self-care — mostly parent buys.', live: true  },
];

function ApprovalPoliciesCard({ familyId, family }: {
  familyId?: string;
  family: { approvalMode?: 'either' | 'both'; approvalModes?: Partial<Record<ApprovalCategoryKey, 'either' | 'both'>> } | null;
}) {
  const legacy = family?.approvalMode;
  const modes = family?.approvalModes ?? {};
  const [saving, setSaving] = useState<ApprovalCategoryKey | null>(null);

  const setMode = async (key: ApprovalCategoryKey, next: 'either' | 'both') => {
    if (!familyId) return;
    setSaving(key);
    try {
      await updateDoc(doc(db, 'families', familyId), { [`approvalModes.${key}`]: next });
    } finally { setSaving(null); }
  };

  const resolved = (k: ApprovalCategoryKey): 'either' | 'both' =>
    modes[k] ?? legacy ?? 'either';

  return (
    <CollapsibleSection title="Approval policies">
      <p className="text-[11px] text-kaya-sand mb-3 leading-relaxed">
        Choose whether each Household request type needs one parent or both. Defaults to "Either"; the legacy family-wide setting still applies to anything not explicitly set here.
      </p>
      <div className="space-y-2">
        {APPROVAL_CATEGORIES.map((cat) => {
          const value = resolved(cat.key);
          const isSaving = saving === cat.key;
          return (
            <div
              key={cat.key}
              className={`flex items-center justify-between gap-3 rounded-kaya border border-kaya-warm-dark/60 bg-kaya-cream/40 p-3 ${cat.live ? '' : 'opacity-80'}`}
            >
              <div className="min-w-0 flex items-start gap-2">
                <span className="text-lg leading-none flex-shrink-0 mt-0.5">{cat.emoji}</span>
                <div className="min-w-0">
                  <p className="text-sm font-bold leading-tight">
                    {cat.label}
                    {!cat.live && <span className="ml-2 text-[9px] uppercase tracking-wider bg-kaya-warm-dark/40 text-kaya-chocolate px-1.5 py-0.5 rounded-full font-bold">Soon</span>}
                  </p>
                  <p className="text-[11px] text-kaya-sand mt-0.5 leading-tight">{cat.hint}</p>
                </div>
              </div>
              <div className="flex items-center gap-0.5 bg-white rounded-full p-0.5 border border-kaya-warm-dark flex-shrink-0">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => setMode(cat.key, 'either')}
                  className={`text-[11px] font-bold px-2.5 py-1 rounded-full transition-colors ${
                    value === 'either' ? 'bg-kaya-chocolate text-white' : 'text-kaya-sand'
                  }`}
                >Either</button>
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => setMode(cat.key, 'both')}
                  className={`text-[11px] font-bold px-2.5 py-1 rounded-full transition-colors ${
                    value === 'both' ? 'bg-kaya-chocolate text-white' : 'text-kaya-sand'
                  }`}
                >Both</button>
              </div>
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}
