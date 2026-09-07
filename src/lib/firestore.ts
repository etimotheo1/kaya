import {
  collection, collectionGroup, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, Timestamp, serverTimestamp,
  onSnapshot, writeBatch, runTransaction, increment,
} from 'firebase/firestore';
import { db, auth as fbAuth } from './firebase';
import {
  isGuestActive,
  MOCK_FAMILY, MOCK_CHILDREN, MOCK_REWARDS, MOCK_RATINGS, MOCK_AWARDS,
  GUEST_FAMILY_ID,
} from './mockFamily';
import { FOUNDING_FAMILY_LIMIT, generateReferralCode } from './referral';
// Type-only import — business.ts never imports firestore.ts, so this adds no
// runtime cycle. Lets Family.businessConfig stay in sync with the canonical shape.
import type { BusinessConfig } from './business';
// Type-only — pulse.ts imports firestore types (Role) only as types, so this
// adds no runtime cycle. Keeps Family.pulsePlan/pulseConfig in sync with the
// canonical shapes in lib/pulse.ts. (2026-05-22, Kaya Pulse.)
import type { PulsePlan, PulseConfig } from './pulse';

// ── Types ──────────────────────────────────────────
// `guest` is the most restricted role — added so families can hand out
// a third invite code (e.g. for grandparents, godparents) that gets
// view-only access without write permissions. Permission enforcement
// for the guest tier follows in a later pass; for now it behaves like
// `helper` in Firestore rules but the role distinction is recorded.
export type Role = 'parent' | 'helper' | 'kid' | 'guest';
export type PointsMode = 'full' | 'badges-only' | 'encouragement';
export type RatingValue = 'excellent' | 'good' | 'bad' | 'skip';
// The five recognised kinds of award. Drives points math + UI.
//   regular           +1, +2, +3 (cap from family config)
//   diamond           +4 and above (parents' big-moment bonus)
//   reducing          negative (–1 to –reducingMax), only if family enables it
//   kudos             0 pts — accumulates toward a bonus when the family's
//                     threshold is reached (e.g. 4 Kudos = +1 bonus point)
//   improvement_note  0 pts — accumulates toward a deduction when the family's
//                     threshold is reached (only deducts if reducing is enabled)
export type AwardKind = 'regular' | 'diamond' | 'reducing' | 'kudos' | 'improvement_note';
// Used for both parents and kids — same vocabulary so the avatar/Wikipedia
// hints behave consistently. 'unspecified' means "don't filter".
export type Gender = 'male' | 'female' | 'other' | 'unspecified';
// How public a parent's birthday should be.
//   public  → full DD-MMM-YYYY visible
//   partial → only month + day (no year), so age stays private
//   private → hidden everywhere
export type BirthdayPrivacy = 'public' | 'partial' | 'private';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  /** 🏠 HD PR-A — approval categories THIS parent treats as 🔴 urgent on
   *  the Home deck (per-parent focus; absent = kid-centric default). */
  approvalUrgentCategories?: string[];
  photoURL?: string;
  avatarPhoto?: string;     // user-uploaded or library avatar (data URL)
  role: Role;
  familyId: string;
  childId?: string; // if role === 'kid', which child they are
  /** 🤝 Helper visibility mirror (2026-08-25). Parent-controlled verdict
   *  mirrored from `families/{f}/helpers/{uid}` by /api/helpers/visibility:
   *  true when the helper is `active` AND has at least one kid assigned.
   *  Communication surfaces list a helper only when this is not false.
   *  `undefined` = listed (fail-open — legacy helpers with no HelperLink
   *  doc, and any family not yet backfilled). Helpers cannot see the
   *  source doc from a kid's session, which is why this lives here. See
   *  lib/helperVisibility.ts. */
  helperListed?: boolean;
  // ── Language (i18n) ──
  // This person's own language choice. Unset = follow the family's
  // primaryLanguage (which itself falls back to the country, then English).
  // See lib/i18n + useLocale.
  languagePref?: import('./i18n').Locale;
  // ── Public identity ──
  handle?: string;          // case-preserved, e.g. "Daniella"
  handleLower?: string;     // lowercase mirror for unique lookup
  gender?: Gender;
  // ── Birthday (parents) ──
  birthday?: string;                 // YYYY-MM-DD
  birthdayPrivacy?: BirthdayPrivacy; // default 'partial'
  // ── Notification preferences (default: opt-in) ──
  notifyOnRating?: boolean; // email when a routine rating is submitted
  notifyOnAward?: boolean;  // email when a bonus award is given
  // ── Messaging presence + privacy (lib/messaging.ts) ──
  lastActiveAt?: Timestamp; // heartbeat for online / last-seen
  // Shape mirrors MessagingPrivacy in lib/messaging.ts (inlined to avoid a
  // circular import). Undefined fields default to true (share).
  messagingPrivacy?: { showPresence?: boolean; showTyping?: boolean; showReceipts?: boolean };
  // ── COPPA / policy acceptance ──
  // Latest policy version this account has accepted, mirrored from the
  // immutable audit by recordPolicyAcceptance so the client can drive the
  // /accept gate without an extra read. Best-effort + may be absent (e.g. a
  // brand-new account before onboarding writes the full profile); the gate
  // fails open on `undefined` and only interrupts when this is set to an
  // OLDER version than ACTIVE_POLICY_VERSION (a material change mid-session).
  acceptedPolicyVersion?: string;
  // ── Universe tour progress (in-app /universe walk-through) ──
  // Which module chapters the user has marked "explored". Lives on the
  // user's own doc so the owner reads/writes it with no rules change.
  universeProgress?: { exploredKeys: string[]; updatedAt?: Timestamp };
  // ── Kaya Lab beta ratings — the kid's own 1–5★ ratings of beta games,
  //   keyed by game id. Lives on the user's own doc (owner reads/writes, no
  //   rules change). Drives the Lab UI + the Tester Badge (3 distinct rated).
  labRatings?: Record<string, { stars: number; comment?: string; at: number }>;
  // ── First-week intent (2026-05-30) — what's drawing the parent to
  //   Kaya. Captured on onboarding Step 4. Drives the order of the
  //   FirstWeekChecklist on Discover (the parent's "why" sits at
  //   position 1). Null = "Not sure yet" → default order. The literal
  //   union must match lib/firstWeek.ts → FirstWeekIntent.
  firstWeekIntent?: 'character' | 'routines' | 'helpers' | 'money' | 'memory' | null;
  // Wall-clock the family found the rhythm (all 6 first-week items
  // ✓). Once set, the checklist hides forever on Discover.
  firstWeekCompletedAt?: Timestamp;
  createdAt: Timestamp;
}

/** A parent-set pause on a kid's tasks (Kids' Workplan · holidays/pause).
 *  One shape reused at three scopes: per-task (KidWorkplanItem.pause),
 *  whole-plan-per-kid (Child.workplanPause), all-kids (Family.workplanPause).
 *  A day is paused when `from <= day <= (to ?? ∞)`:
 *   • 'range'      — parent picks both from + to (e.g. 14–21 Aug holiday).
 *   • 'until'      — from = the day it was set, to = chosen end date.
 *   • 'indefinite' — from = the day it was set, no `to` (until cleared).
 *  Pauses auto-resume after `to`; nothing is ever deleted from the plan. */
export type WorkplanPauseMode = 'range' | 'until' | 'indefinite';
export interface WorkplanPause {
  mode: WorkplanPauseMode;
  from: string;          // YYYY-MM-DD inclusive — first paused day
  to?: string;           // YYYY-MM-DD inclusive — last paused day; absent = indefinite
  note?: string;         // optional parent reason (e.g. "Eid holidays")
  setBy: string;         // parent uid
  setAt: Timestamp;
}

export interface Family {
  id: string;
  name: string;
  createdBy: string;
  // 🔔 Alert-email recipients — the Global → Category → Item cascade
  // (VIS PR3). Absent field = "all parents". See lib/alertEmails.shared.
  alertEmails?: import('./alertEmails.shared').AlertEmailsConfig;
  /** 🎁 RWD PR1 — store rules: 🛡 min-points floor (family default + per-kid
   *  overrides, keyed by childId) + kid auto-approve threshold. */
  /** 🏅 BDG PR2 — Boutique config: released set + threshold overrides +
   *  parent-created custom badges (shape in lib/badgeLib.ts). */
  badgeConfig?: import('./badgeLib').BadgeConfig;
  rewardsConfig?: {
    minPointsFloor?: number;
    minPointsFloorPerKid?: Record<string, number>;
    autoApproveBelowPoints?: number;
    /** 👨‍👩‍👧 RWD PR5 — kids join family goals from this age (Little-Stars
     *  style); per-kid include/exclude overrides win. Absent = everyone. */
    familyGoalsFromAge?: number;
    familyGoalsOverrides?: Record<string, boolean>;
    /** 💡 RWI PR-A — reward IDEAS a kid may send per calendar month
     *  (0 = off, absent = default 3); per-kid overrides win. */
    proposalsPerMonth?: number;
    proposalsPerMonthPerKid?: Record<string, number>;
  };
  /** 🌟 RR PR-1 (approved v3, 13-Aug-2026) — Recognition Rounds: cadenced
   *  nudges reminding parents to celebrate kids. Coverage-first; every
   *  celebration rides the existing award rail. Partial, merged with
   *  DEFAULT_RECOGNITION_CONFIG via readRecognitionConfig(). */
  recognitionConfig?: Partial<RecognitionConfig>;
  /** 👑 Leader of the Week (LW PR-L1, approved 23-Aug-2026) — who wears
   *  the crown NOW (kid-only role; fed by the meeting's leader pick at
   *  FINISH, or appointed by a parent). History + sealed traits live in
   *  `leaderTerms/`; 📒 Notebook entries in `leaderNotes/` — ALL written
   *  through the /api/leader Admin gateway (zero rules deploys). */
  houseLeader?: import('./leaderWeek.shared').HouseLeader | null;
  leaderConfig?: Partial<import('./leaderWeek.shared').LeaderConfig>;
  /** Set when the meeting's pick was an ADULT → parents see the "appoint a
   *  House Leader" card on Home until they pick a kid (or dismiss). */
  leaderAppointPending?: { at: number; byName?: string } | null;
  // 📬 Kids' email updates (KID PR1) — per-kid source POINTER + stream
  // toggles, everything default OFF (COPPA). See lib/kidEmails.shared.
  kidEmailUpdates?: import('./kidEmails.shared').KidEmailUpdatesConfig;
  // Legacy single invite code. Pre-2026-05 families have only this
  // field; new families also get `inviteCodes` below with one code per
  // role. Kept on every doc for backwards compatibility — the legacy
  // code resolves to the `helper` role since that was its original
  // labelling in Settings.
  inviteCode: string;
  // Per-role invite codes. Each one is independent and identifies the
  // role a new user joins as when they paste it during onboarding. All
  // generated up-front for new families; lazily backfilled for older
  // families via `ensureInviteCodes()`.
  //
  // Each entry carries lifecycle state:
  //   - `active`     gates joins (rejected when false, with a clear UI msg)
  //   - `activatedAt`/`usedAt` are display-only audit timestamps
  //   - Kid + Guest codes start INACTIVE — parent activates right
  //     before sharing. Helper codes start ACTIVE (long-lived staff
  //     credential). On successful join the code auto-deactivates so
  //     a single share can't be replayed.
  //
  // The field accepts the legacy string shape too for one-shot
  // migration; `ensureInviteCodes()` normalises to the object form on
  // first read after the upgrade. Cast at the boundary.
  inviteCodes?: {
    kid?:    InviteCodeState | string;
    helper?: InviteCodeState | string;
    guest?:  InviteCodeState | string;
  };
  // ── Public identity ──
  handle?: string;                // case-preserved, e.g. "Timotheo"
  handleLower?: string;           // lowercase mirror — used for case-insensitive lookup
  photoUrl?: string;              // family photo (data URL or external URL)
  // ── Referral campaign ──
  referralCode?: string;          // unique code for inviting OTHER families to start their own
  referredBy?: string | null;     // familyId of the family that referred us (if any)
  referralCount?: number;         // direct successful referrals
  compoundCredit?: number;        // credit from referral-of-referral (1 level deep)
  kayaCoins?: number;             // Kaya Coins (KC) balance — server-owned referral currency (accrual engine ships Phase B; 0 for everyone today)
  isFoundingFamily?: boolean;     // true if among the first FOUNDING_FAMILY_LIMIT families (the "Charter Family" crew — distinct from the earned Founding Family badge @1,000)
  charterNumber?: number;         // Charter Family join ordinal (1..FOUNDING_FAMILY_LIMIT); shown as CF-### — stamped at creation, backfilled for existing families by createdAt order
  foundingNumber?: number;        // order this family EARNED the apex Founding Family badge (@1,000 referrals); shown as FF-### — assigned server-side (lib/referralServer.assignFoundingNumber), none in closed beta yet
  spotlightOptIn?: boolean;       // opt-in flag for landing-page Champion spotlight
  // ── Family milestones ──
  anniversary?: string;           // canonical YYYY-MM-DD; UI shows DD-MMM-YYYY + day-of-week
  anniversaryName?: string;       // optional custom title (e.g. "Wedding Anniversary", "First Met"). Defaults to "Anniversary" in the UI.
  // ── Family identity policy ──
  // Whether the "Other" gender option is shown when picking a gender for a
  // kid or a parent inside this family. Defaults to **false** — many cultures
  // and faith communities consider only Female/Male appropriate, so the
  // option is opt-in. Parents can flip this in Settings.
  allowGenderOther?: boolean;
  // ── Kaya Games · parental controls (play windows, daily caps, age
  //   multiplier). Shape mirrors GamesConfig in lib/games.ts; partial or
  //   absent → resolved against DEFAULT_GAMES_CONFIG. Family-readable,
  //   parent-writable (rides the family doc — no extra rule).
  gamesConfig?: Partial<import('./games').GamesConfig>;
  /** Little Stars — family-default participation ages (partial, merged
   *  over DEFAULT_PARTICIPATION_AGES by lib/participation.ts). */
  participationAges?: Partial<import('./participation').ParticipationAges>;
  /** 🤖 Kaya AI Levels (approved 2026-09-07) — the family default for how
   *  firmly Kaya marks / explains / pushes (1 🌱 Gentle · 2 🌤 Balanced ·
   *  3 💪 Stretch · 4 🎓 Exam-Ready). Absent = Balanced = today's
   *  behaviour. Per-child override lives on Child.aiLevel; resolution +
   *  age guard in lib/ai/level.shared.ts. Rides the family doc. */
  aiConfig?: { defaultLevel?: import('./ai/level.shared').AiLevel };
  /** Kid Stats (My Stats) feature switches — default ON when absent. */
  statsConfig?: { reflections?: boolean; compare?: boolean; helpNudges?: boolean; catchGood?: boolean };
  /** 🎊 Arrival celebration length in days (default 14) — how long a new
   *  member's welcome card stays on everyone's Home. */
  celebrationDays?: number;
  // ── 📮 Reminder email groups (v4) · named recipient bundles built in
  //   Settings, surfaced as one-tap chips in the reminder "EMAIL TO" panel.
  //   Rides the family doc like gamesConfig — no extra rule.
  emailGroups?: import('./reminders').EmailGroup[];
  /** ✉️ Reminders 2.0 (approved 2026-08-22) — 📒 People Book: parent-managed
   *  contacts (honorees for greeting cards; kids pick, never type). */
  contacts?: import('./reminders').FamilyContact[];
  /** ✉️ Reminders 2.0 — how cards to adults are signed (R9). */
  greetingSignature?: import('./reminders').GreetingSignature;
  /** ✉️ Reminders 2.0 — family switches for the Card Studio (Kaya Writes). */
  greetingConfig?: import('./reminders').GreetingConfig;
  /** 📮 Points Email Audience (approved 2026-08-09): EXTRA recipients for
   *  the rating / award emails, saved once for the family (parent-edited).
   *  Personal member toggles + Family contacts stay exactly as they are —
   *  this only ADDS. kidItsAbout rides the COPPA kid-email pointers
   *  (kidEmailUpdates source; no pointer → nothing sends). groupIds
   *  reference emailGroups; emails are extra outside addresses that get
   *  the privacy-trimmed template (first name + points, no app links). */
  pointsEmailAudience?: {
    rating?: { kidItsAbout?: boolean; groupIds?: string[]; emails?: string[]; fullEmails?: string[] };
    award?: { kidItsAbout?: boolean; groupIds?: string[]; emails?: string[]; fullEmails?: string[] };
  };
  /** 🔥 Points Emails 2.0 (approved 2026-08-23): family-tier rating email
   *  style — 'heat' (every task in colour + reasons + week; default) or
   *  'totals' (today's simple card). Outside addresses always get totals. */
  pointsEmailDetail?: 'heat' | 'totals';
  /** 🧒 Kids see the feedback (R8) — what the kid tier carries. Parent-
   *  only, family-level; every switch defaults ON. The kid's ADDRESS still
   *  comes only from the COPPA pointer (kidEmailUpdates). */
  kidFeedback?: { includeReasons?: boolean; askReflection?: boolean; inAppInbox?: boolean };
  /** ⏰ Catch-Up Board (approved 2026-08-10). Pins = catch-ups a parent
   *  tapped "🗣️ Raise on Sunday" — the Catch-Up Corner meeting step
   *  reads them (keyed by childId) and clears after the meeting.
   *  Visibility: whether kids see ONLY their own strip ('own', default)
   *  or each other's On-Track scores too ('family') — parents choose. */
  catchUpPins?: Record<string, Array<{ key: string; icon: string; label: string }>>;
  catchUpVisibility?: 'own' | 'family';
  // ── Location ──
  // Where this family lives. Optional — when set, the country code
  // drives currency auto-detection (`countryToCurrency()` in
  // `lib/hive.ts`) and downstream pricing scales to local FX rates.
  // City is free-text and used only for friendly display ("Run for
  // Dar es Salaam" in WhatsApp messages, etc.). USD is the global
  // default when no country is set.
  location?: {
    country: string;   // ISO 3166 alpha-2 (e.g., "TZ", "US", "IN")
    city?: string;     // free-text, e.g., "Dar es Salaam"
  };
  // ── Primary language (i18n) ──
  // The family's default app language — auto-suggested from `location.country`
  // at sign-up, parent-confirmed. Everyone (incl. helpers) sees this unless
  // they set their own `languagePref`. Unset = derive from country, else
  // English. See lib/i18n + useLocale.
  primaryLanguage?: import('./i18n').Locale;
  /** SET PR2 (M4) — per-person language defaults, parent-set on the family
   *  doc (parent-only update rule; family-readable so every client resolves
   *  live with zero extra subscriptions). Keys: childId for kids, auth uid
   *  for helpers. A person's own users/{uid}.languagePref always wins. */
  memberLanguageDefaults?: Record<string, import('./i18n').Locale>;
  /** 🎁 HR PR-3 — the family's own helper gift ideas (Recognition tab
   *  gift advisor). Empty/absent = the built-in starter list shows. */
  helperGiftBank?: string[];
  // ── Keepsake subscription plan ────────────────────────────────
  // Drives gating across Albums (album/photo caps, sub-albums,
  // custom access, AI features). Defaults to 'free' when missing —
  // see `lib/keepsakeLimits.ts` for the limit shape.
  plan?: 'free' | 'family' | 'family_pro';

  // ── Kaya Tiers subscription (2026-05-26) ────────────────────
  // The seam that gates every module in the app. Three SKUs: Nest
  // (free), Home ($6/mo), Castle ($14/mo). Family-admin chooses one
  // at /subscription; founder + operators can override at /admin.
  //
  // `subscription.addons` is the à-la-carte list of paid extras for
  // Home families (e.g. Kaya Business, Kaya Wealth) — Castle implicitly
  // includes every add-on so its list is always empty.
  //
  // Missing field ⇒ treat as Nest (free). See `lib/tiers.ts` for the
  // resolved-access helper that the gating UI consumes.
  tierId?: 'nest' | 'home' | 'castle';
  subscription?: {
    /** Active add-on IDs from `lib/tiers.ts`. Ignored for Castle. */
    addons?: string[];
    billingCycle?: 'monthly' | 'yearly';
    /** Stripe IDs are absent in closed beta — populated only after the
     *  paid funnel opens. Leaving the seam here so PR 4 (Stripe) is a
     *  drop-in once env wiring lands. */
    stripeSubscriptionId?: string | null;
    /** Stripe Customer ID — needed to open the Billing Portal and to
     *  reuse the same customer across upgrades. Populated by PR 4 (Stripe). */
    stripeCustomerId?: string | null;
    currentPeriodEnd?: Timestamp;
    status?: 'active' | 'past_due' | 'canceled';
    /** Tier-code redemption (closed beta · pre-Stripe, 2026-05-28).
     *  When the family redeems an operator-issued code, their tierId
     *  + addons are written to the existing fields; these three record
     *  the expiry seam. On expiry (lazy check in useTierAccess), the
     *  server reverts to Nest. null/missing = forever / never redeemed. */
    expiresAt?: Timestamp;
    redeemedCodeId?: string;
    redeemedAt?: Timestamp;
  };

  // ── Storage usage (2026-05-28) ─────────────────────────────────
  // Per-family Firebase Storage accounting. `bytes` is bumped server-
  // side on every upload (via storageQuota.ts) and decremented on
  // delete. `extraGB` is admin-granted (or, post-Stripe, purchased)
  // top-up that adds to the tier's base cap. Effective cap is
  // resolved by `tierCapBytes(tier, extraGB)` in `lib/storage.ts`.
  //
  // Missing field ⇒ treat as 0 bytes used + 0 extra GB (i.e. fresh).
  storage?: {
    /** Current Firebase Storage usage in bytes. */
    bytes: number;
    /** Admin-granted or operator-issued extra capacity in GB. */
    extraGB: number;
    /** Last time `bytes` was recomputed via the recount endpoint. */
    recountedAt?: Timestamp;
  };

  // ── Settings ──
  pointsMode: PointsMode;
  earningMethods?: string[]; // ids from EARNING_METHODS — defaults to DEFAULT_EARNING_METHODS when absent
  // Which modules show up in a kid's nav (sidebar + mobile More sheet)
  // and which kid-side routes are reachable. Ids from `KID_MODULES` in
  // `lib/kidModules.ts`. When absent, falls back to `DEFAULT_KID_MODULES`
  // — Home is always granted regardless. Routes not in the granted set
  // bounce kids back to /kid via the AppShell route guard.
  kidModules?: string[];
  // Privacy: may a kid open a *sibling's* profile in the Kid profiles
  // page? When false, each kid is locked to their own profile card (the
  // sibling switcher is hidden). Reports (the family roll-up) and the
  // Family tree are unaffected. Absent ⇒ true (kids can see each other),
  // which matches the behaviour shipped before this toggle existed.
  kidsCanSeeSiblingProfiles?: boolean;
  routines: Routine[];
  // Family-configurable point system rules (tier caps, reducing on/off,
  // Kudos / Improvement Note thresholds). Optional — `readPointSystemConfig`
  // merges with `DEFAULT_POINT_SYSTEM` so older family docs keep working.
  pointSystem?: PointSystemConfig;
  // ── The Hive ──
  // Parent-controlled rates + policy for the three-layer money module.
  // See `src/lib/hive.ts` for the canonical shape (`HiveConfig`). Persisted
  // as a partial — `readHiveConfig(family)` merges with `DEFAULT_HIVE_CONFIG`.
  hiveConfig?: {
    hpToHoneyRate?: number;
    honeyToCashRate?: number;
    currency?: string;
    minCashOut?: number;
    spendRequiresApproval?: boolean;
    cashOutRequiresApproval?: boolean;
    requireApprovalForHpToHoney?: boolean;
    spendAutoApproveBelowCents?: number;
    autoAllowance?: {
      enabled: boolean;
      kidId?: string;
      amountCents?: number;
      cadence?: 'weekly' | 'monthly';
      nextRunAt?: Timestamp;
    };
  };
  // ── Kaya Business ──
  // Parent-controlled config for the micro-enterprise module. See
  // `src/lib/business.ts` for the canonical shape (`BusinessConfig`); persisted
  // as a partial and merged with DEFAULT_BUSINESS_CONFIG by
  // `readBusinessConfig(family)`.
  businessConfig?: Partial<BusinessConfig>;
  // ── Household purchase guardrails (2026-05-31) ──
  // Parent-controlled ± price-change band a helper can apply during
  // reconcile, plus optional per-module overrides. Canonical shape is
  // `PurchaseConfig` in `src/lib/purchase.ts`; persisted as a partial and
  // merged with DEFAULT_PURCHASE_CONFIG by `readPurchaseConfig(family)`.
  purchaseConfig?: Partial<import('./purchase').PurchaseConfig>;
  // ── Drivers v2 odometer guardrails (2026-07-05) ──
  // Parent toggle: odometer mandatory for helpers on Drivers requests,
  // plus the big-jump sanity band. Canonical shape is `DriversConfig`
  // in `src/lib/purchase.ts`; merged by `readDriversConfig(family)`.
  driversConfig?: Partial<import('./purchase').DriversConfig>;
  // ── Family-wide units (Household Setup → Units & formats, 2026-07-05) ──
  // Distance km/mi + fuel volume L/gal. Storage stays canonical;
  // display converts. Canonical shape in `src/lib/units.ts`.
  units?: Partial<import('./units').FamilyUnits>;
  // ── External email contacts ──────────────────────────────────
  // Email-only contacts (grandparents, godparents, tutors…) who get
  // the same rating / award notifications as parents/helpers in the
  // family. They don't have Kaya accounts. Parents manage the list
  // in Settings. Per-event toggles default to true so a contact
  // added today receives both kinds of email until told otherwise.
  externalContacts?: ExternalContact[];
  // ── Helper login code ────────────────────────────────────────
  // Stable, displayable family identifier used by helpers to sign in
  // via Tier A (family code + helper code + password). Distinct from
  // `inviteCodes.helper`, which gates JOIN; this gates ongoing LOGIN.
  // 4-char alphanumeric, ambiguity-stripped (no 0/O/1/I/L). Lazily
  // populated by `ensureFamilyCode()` on first Settings → Helpers
  // open so legacy families pick it up without a migration.
  familyCode?: string;
  // ── Helper session length ────────────────────────────────────
  // How long (in days) a helper stays signed in after their last
  // sign-in before being asked to re-enter their codes. Family-wide
  // (applies to every helper). Default 30. Implementation: on
  // sign-in we stamp localStorage with `Date.now()`; on each helper
  // page load we compare against `now - days * 86400000` and force
  // sign-out if past. A shortened value takes effect immediately
  // for already-signed-in helpers — they get bounced on their next
  // page load.
  helperSessionDays?: number;
  // ── Local language label (2026-05-19) ─────────────────────────
  // Free-text label for the family's second language — used in the
  // Staples form helper text ("Local name (Swahili) — helpers see
  // this first") and similar bilingual surfaces. Default undefined
  // → forms show the generic "Local language" copy. Setting any
  // value (Swahili, Hindi, French, Arabic, …) personalises every
  // hint string accordingly. English is implicit as the primary
  // (the `name` field of Staple).
  localLanguage?: string;
  // ── Approval mode (Household requests) — LEGACY ──────────────
  // Family-wide default that pre-dates per-category modes
  // (introduced 2026-05-17). Still respected as the fallback when a
  // specific category isn't set in `approvalModes` below. New writes
  // should target `approvalModes.<category>` instead.
  approvalMode?: 'either' | 'both';
  // ── Approval modes — per-category (Household requests) ───────
  // Lets a family say "Pantry: either parent, but Payroll advances:
  // both parents." Categories follow the Household module plan; only
  // `pantry` is wired in Purchase v1, the rest take effect as those
  // modules ship. Missing entries fall back to the legacy
  // `approvalMode` above, then to 'either'.
  approvalModes?: {
    pantry?: 'either' | 'both';
    outdoor?: 'either' | 'both';
    drivers?: 'either' | 'both';
    utility?: 'either' | 'both';
    payrollAdvance?: 'either' | 'both';
    payrollLoan?: 'either' | 'both';
  };
  // ── Household budgets ────────────────────────────────────────
  // Per-module monthly caps (in cents, family display currency) that
  // roll up into the Household Finances view. Each Household module
  // gets its own cap; Finances reads them all and sums to a total.
  //
  // 2026-05-19 (Budget v3) — this field is now a denormalized CACHE
  // of the computed monthly total from `budgetComposer`. The composer
  // owns the source of truth (line items + cadence); on save we
  // compute the monthly and write it here too so existing readers
  // (progress bars, finances roll-up) keep working unchanged.
  householdBudgets?: {
    pantry?: number;
    outdoor?: number;
    drivers?: number;
    utility?: number;
    payroll?: number;
    dineOut?: number;
    home?: number;
    subscriptions?: number;
    contributions?: number;
  };
  /** Payroll email notifications (2026-06-08). Up to 2 extra inboxes that
   *  get payroll emails (beyond the parents' login emails), plus a per-event
   *  on/off. Managed in Settings → Notifications. */
  payrollNotify?: {
    extraEmails?: string[];           // max 2
    events?: {
      salaryRaised?: boolean;         // ~7 days before month-end
      markPaidDue?: boolean;          // pay window opens
      approvals?: boolean;            // a request needs a nod
      salaryPaid?: boolean;           // marked-paid receipt
    };
  };
  /** Structured budget breakdowns — line items in their natural
   *  cadence (day/week/month/year), normalized to monthly on save.
   *  See `src/lib/budgetComposer.ts` for shape + helpers. (2026-05-19) */
  budgetComposer?: import('./budgetComposer').BudgetComposer;
  /** Per-module carry-forward balance from prior closed requests
   *  where the parent chose "keep as balance" on the savings decision.
   *  Applied as a credit on the NEXT request in the same module
   *  (next createDraftRequest reads + clears this). Stored in cents,
   *  family display currency. (2026-05-19.) */
  pendingModuleBalance?: {
    pantry?: number;
    outdoor?: number;
    drivers?: number;
    utility?: number;
  };
  // ── Kaya Pulse (2026-05-22) ──────────────────────────────────
  /** Savings plan — the parent's intent (% to cut/keep OR an absolute amount
   *  to save). The system auto-suggests focus buckets + a cut %, the parent
   *  overrides; both modes resolve to per-module caps in householdBudgets.
   *  See lib/pulse.ts `PulsePlan`. */
  pulsePlan?: PulsePlan;
  /** Per-family Pulse tunables (anomaly multiplier, streak bonuses, default
   *  Wealth allocation). Partial — merged with DEFAULT_PULSE_CONFIG. */
  pulseConfig?: Partial<PulseConfig>;
  // ── Kids' Workplan · proof for points (2026-05-23) ────────────
  /** How a proof-required workplan task's points are granted:
   *   • 'approve' (default when absent) — points stay PENDING until a
   *     parent approves the kid's submitted proof.
   *   • 'instant' — points land on submit (revocable: a later parent
   *     reject claws them back).
   *  Read via `readWorkplanProofMode(family)`; set via `updateFamily`. */
  workplanProofMode?: 'instant' | 'approve';
  /** All-kids workplan pause (holidays). Applies to every child's plan on
   *  covered days — streak-safe. Set via setFamilyWorkplanPause. */
  workplanPause?: WorkplanPause;
  /** SM3.1 (H·A): 📖 Theme of the Week — a short verse/quote the leader
   *  sets at the meeting close. Shows on Home + My Day all week; next
   *  meeting's opener asks "who remembers it?". `weekOf` = that week's
   *  meeting-day key (YYYY-MM-DD). */
  weekTheme?: {
    text: string;
    by?: string;
    weekOf: string;
    setAt?: number;
  };
  // ── Meeting setup ────────────────────────────────────────────
  // Parent-controlled configuration the presenter reads on meeting
  // night. Optional — absent = sensible defaults (every step in the
  // agenda, every closing mode available, no prayer library).
  meetingSetup?: {
    /** Which steps are part of the agenda, in the order shown. When
     *  absent, presenter renders the full 6-step default. Step ids:
     *  'attendance' | 'gratitude' | 'celebrate' | 'appreciations' |
     *  'goals' | 'reflection'. */
    agendaSteps?: string[];
    /** Which closing reflection modes are surfaced to the parent
     *  during the meeting. When absent, all three (story / songs /
     *  prayer) are shown. */
    closingModesEnabled?: ReflectionMode[];
    /** Prayer library — multiple saved prayers parents can rotate
     *  through. The presenter preloads a random one when the Prayer
     *  closing is picked (parent can still edit or paste a different
     *  prayer on the night). Stored on the family doc; no Storage
     *  involved. */
    prayers?: Array<{
      id: string;
      title: string;
      body: string;
      /** Epoch millis — order, audit, "added this week" badges. */
      createdAt: number;
    }>;
    /** Per-step display-name overrides. Keys are canonical step ids
     *  (`attendance` / `gratitude` / `celebrate` / `appreciations` /
     *  `goals` / `reflection`); value is the parent's preferred label
     *  for that step. Empty / missing = use the default title. The
     *  presenter and setup page both honor these. */
    stepLabels?: Record<string, string>;
    /** Recurring meeting time. When set, the meetings hub shows a
     *  "Meeting tonight at HH:mm" banner on the scheduled day. Pure
     *  client-side check today — no push / cron infrastructure yet.
     *  dayOfWeek follows the JS convention: 0 = Sunday … 6 = Saturday.
     *  time is "HH:mm" 24h. */
    schedule?: {
      dayOfWeek: number;
      time: string;
    };
    /** Sunday-Meeting v2 (b5): when a kid attaches a song link in the
     *  Closing Reflection step, the family can require a parent to OK
     *  it before it shows up as a playable button. Default = true (be
     *  conservative — parents can flip it off in /settings/meetings). */
    kidSongLinkRequiresApproval?: boolean;
    /** Sunday-Meeting v2 (b6): after a meeting is submitted, email a
     *  one-page "Meeting Recap Book" to parents + family contacts.
     *  Default = true. Toggle in /settings/meetings. */
    recapBookEmailEnabled?: boolean;
    /** Meeting Notes (2026-06-21): WHO gets the auto-sent notes after each
     *  meeting — 'off' (nobody) · 'parents' (today's behaviour) · 'all'
     *  (every attendee with an email on file, kids included). Absent =
     *  derive from recapBookEmailEnabled (true→'parents', false→'off'). */
    recapBookRecipients?: 'off' | 'parents' | 'parents-kids' | 'all' | 'custom';
    /** OF-4 (approved 2026-07-20): the saved 'custom' selection —
     *  memberIds are 'p:<uid>' (parents) / 'k:<childId>' (kids), plus
     *  free-typed extra emails (grandma, mentors…). Only read when
     *  recapBookRecipients === 'custom'. */
    recapCustomRecipients?: { memberIds: string[]; emails: string[] };
    /** 🗣️ Open Floor (approved 2026-07-20) — optional 7th agenda step:
     *  topics anyone raised, open discussion, the leader keeps notes.
     *  Default OFF (absent = off). Raisers: who may raise topics in prep;
     *  leader: who may run the segment. */
    openFloorEnabled?: boolean;
    openFloorRaisers?: 'parents' | 'all';
    openFloorLeader?: 'parents' | 'leader' | 'anykid';
    /** 🧩 Agenda Builder (approved 2026-07-20, OF-3) — presentation order
     *  of the REORDERABLE steps (first 3 — Attendance → Gratitude →
     *  Celebrate — stay pinned). Ids: 'appreciations' | 'goals' |
     *  'openfloor' | 'reflection' | 'custom'. Absent = canonical order.
     *  Per-step ON/OFF stays in `agendaSteps` — order and enablement are
     *  independent, so turning a step off never loses its position. */
    agendaOrder?: string[];
    /** ⏰ Catch-Up Corner (approved 2026-08-10) — own flag like Opening
     *  Word/Open Floor, default ON (absent = on), sits BEFORE Goals
     *  Review so promises flow straight into goal commitments. */
    catchUpCornerEnabled?: boolean;
    /** 🚪 Close-the-Meeting gate (2026-08-16): the meeting closes ONLY
     *  via the big gate button — and if the family forgets, it auto-
     *  closes after this many minutes on the last step. 0 = never
     *  auto-close. Absent = 10. */
    autoCloseMinutes?: 0 | 5 | 10 | 20;
    /** OF-3: the family's own 8th step — shown in the presenter with a
     *  notes box the leader fills. Off when absent/disabled/unnamed. */
    customStep?: { emoji: string; name: string; enabled: boolean };
    /** Whether the recap email includes the closing song link.
     *  Default = true; flips off independently of recapBookEmailEnabled
     *  so parents can keep the recap but drop the song. */
    recapBookIncludeSong?: boolean;
    /** Sunday-Meeting v2 (b7): how far ahead a Time Capsule note
     *  stays sealed. Allowed: 0.5 (6 months), 1 (1 year), 3 (3 years).
     *  Default = 1 year. The capsule's openOn lands on the nearest
     *  scheduled meeting day within ±3 days of that anniversary. */
    timeCapsuleLockYears?: 0.5 | 1 | 3;
    /** SM3.1 (#2): 🙏 Opening Word — the leader opens the night with a
     *  prayer / word of wisdom / verse, spoken FROM THE HEART by default.
     *  `openingWordEnabled` shows/hides the step (default true — its own
     *  flag, NOT part of agendaSteps, so families with saved step lists
     *  still get it). `openingWordRequired` locks "Next" until the leader
     *  marks the opening done. `openingWordShowLibrary` surfaces the saved
     *  prayers library as an optional read-from card (default false —
     *  heart-first). */
    openingWordEnabled?: boolean;
    openingWordRequired?: boolean;
    openingWordShowLibrary?: boolean;
    /** SM3.1 (#7): 🎁 Sunday Surprise — the shared moment that ends the
     *  meeting. `sundaySurpriseEnabled` shows/hides the step (default ON).
     *  `surprises` overrides per-type enablement (absent = registry
     *  defaults in lib/meetingSurprises). `goldenTickets` is the parent-
     *  stocked treat list for the 🍬 Golden Ticket surprise. */
    sundaySurpriseEnabled?: boolean;
    surprises?: Record<string, boolean>;
    goldenTickets?: string[];
    /** 🌟 Note of the Week (Timeline 2.0, 2026-08-25): Kaya nominates the
     *  week's journal notes, the family crowns one → Moments. Own flag,
     *  default ON (absent = on). */
    noteOfWeekEnabled?: boolean;
    /** Sunday-Meeting (song reveal, 2026-06-21): the closing song set
     *  AHEAD of the meeting by the leader or a parent. During the meeting
     *  the Closing step opens it as a surprise (5-4-3-2-1 countdown →
     *  open the link). `cycleKey` scopes it to one meeting so it doesn't
     *  carry over; parents can override the leader's pick. */
    closingSong?: {
      url: string;
      setByName?: string;
      cycleKey?: string;      // YYYY-MM-DD of the meeting it's for
      approvedBy?: string;    // parent uid, when a kid set it + approval is on
    };
  };
  // ── Sunday-Meeting v2: leader queue ─────────────────────────
  // The person queued to *run* the next meeting. Set by the current
  // leader at the start of the meeting (Attendance step), either by
  // tapping a chip or spinning the wheel. Displayed on the OpenStep
  // reveal + on the chosen person's My Day from the moment it's set.
  // `id` is uid (parents/helpers) or childId (kids); the snapshot
  // fields let cards render without a join.
  nextMeetingLeader?: {
    id: string;             // uid or childId
    name: string;
    emoji: string;
    kind: 'parent' | 'kid' | 'helper';
    pickedBy: string;       // uid of the user who picked
    pickedAt: number;       // epoch millis
  } | null;
  createdAt: Timestamp;
}

// ── Helper (per-family scoped credential) ────────────────────
// One doc per helper per family. Lives at
// `families/{familyId}/helpers/{uid}`. The Firebase Auth user backing
// this helper is created via the secondary-app pattern in
// `lib/helpers.ts` (no admin SDK required).
//
// Tier A (today): synthetic email of the form
// `h.{familyCode}.{helperCode}@helper.kaya.app` + password. The helper
// never sees or uses the email — they enter the 3 codes at /h/login.
// Tier B (Neldi-driven OTP) + Tier C (real email) come later; they
// link a real phone/email onto the same UID via account linking so
// all HelperLink history is preserved automatically.
export type WorkDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const ALL_WORK_DAYS: WorkDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface HelperLink {
  uid: string;
  helperCode: string;                                        // short handle within the family, e.g. "JANE"
  displayName: string;
  preset: 'nanny' | 'tutor' | 'driver' | 'grandparent' | 'gardener' | 'security' | 'cleaner' | 'cook' | 'handyman' | 'custom';
  kidIds: string[];                                          // which kids this helper can act on; [] = none
  // ── Module access (legacy) ───────────────────────────────────
  // Single-tier list of kid-module ids this helper has full access
  // to (implicit view + act). Kept for backwards compat — older
  // HelperLink docs have only this field. New writes also populate
  // `moduleAccess` below; rules prefer `moduleAccess` when present,
  // fall back to `modules` when absent.
  modules: string[];
  // ── Module access (canonical, view vs act) ───────────────────
  // Per-module view + act flags. Source of truth on docs that have
  // it. Rules use `moduleAccess[m].act` for writes and
  // `moduleAccess[m].view` for reads. A module missing from this map
  // means "no access" — UI should only show modules the helper has
  // at least view rights on.
  //
  // Why two fields: rolling this out without breaking existing
  // helpers required keeping `modules` as the legacy fallback. Once
  // every active doc has `moduleAccess`, the legacy field can be
  // archived; until then both stay in sync on every write.
  moduleAccess?: Record<string, { view: boolean; act: boolean }>;
  canLog: boolean;                                           // tap-checklist + capture writes (default true) — legacy
  canAward: boolean;                                         // kudos / improvement_note only; defaults false — legacy
  attribution: 'named' | 'generic' | 'hidden';               // for the future performance page
  authTier: 'A' | 'B' | 'C';
  /** Tier A sign-in password, stored so a parent can re-view & re-share
   *  it when a helper changes devices (Settings → Helpers → Sign-in
   *  details). Readable ONLY by the family's parents or the helper
   *  themselves per firestore.rules `/helpers/{uid}` — never by kids or
   *  other helpers. Absent on helpers created before this shipped;
   *  populated for them via the reset-password route. */
  password?: string;
  status: 'active' | 'paused' | 'removed';
  // What the family expects this helper to fill in each day. Drives
  // the helper-side "Today" panel and (later) the performance %
  // calculation. Default treated as 'both' when missing so existing
  // HelperLinks don't need a migration.
  //   morning  → just the morning rating
  //   evening  → just the evening rating
  //   both     → both morning AND evening expected
  //   flexible → no specific cadence; helper fills when relevant
  expectedFrequency?: 'morning' | 'evening' | 'both' | 'flexible';
  /** HP2 D4 (2026-08-23) — which weekdays the helper works. Off-days
   *  show ⚪ in the routine-fill RAG and drop out of the ratings
   *  expectation (a Sunday off is no longer a red). Absent = all 7. */
  workDays?: WorkDay[];
  /** Per-helper override of how long they stay signed in before having
   *  to re-enter their codes. When unset, the family-wide
   *  `Family.helperSessionDays` (default 30) applies. Set from the
   *  helper's "Stays signed in for" control in Settings → Helpers. */
  sessionDaysOverride?: number | null;
  /** Automated payroll setup (2026-05-19). When present, the
   *  /pantry/payroll page auto-generates pending salary requests
   *  on the configured cadence. Optional — leave undefined for
   *  helpers paid via the existing ad-hoc Payroll flow only
   *  (advance / loan / bonus / reimbursement). See
   *  HelperPayrollConfig below for the full shape. */
  payrollConfig?: HelperPayrollConfig;
  createdAt: Timestamp;
  createdBy: string;                                         // parent UID who added them
}

// ── Payroll automation (v1 — 2026-05-19) ─────────────────────────
//
// Two new sub-systems on top of the existing Payroll module:
//   1. AUTOMATED SALARY — per-helper pay config drives a generator
//      that creates pending PurchaseRequest docs on each pay date.
//   2. CHECK-INS — for hourly/daily helpers, a per-day log of hours
//      worked (helper logs, parent approves) that the generator
//      sums into the basic-pay line.
//
// The existing self-service advance / loan / bonus / reimbursement
// flow is UNCHANGED. Loans + advances feed into the new system via
// the optional `deductions` list on payrollConfig — each pay cycle
// includes a repayment line, balance auto-decrements on close.

export type PayBasis = 'hourly' | 'daily' | 'monthly';
export type PayFrequency = 'weekly' | 'biweekly' | 'monthly';

/** Allowance type — drives the pill + icon + filterability. Never gates the
 *  amount or the schedule. Defaults to 'other' when omitted (back-compat). */
export type PayrollAllowanceType =
  | 'food' | 'transport' | 'holiday' | 'airtime' | 'housing' | 'medical' | 'other';

/** Allowance cadence (2026-05-27). Old rows without `cadence` are treated as
 *  `monthly` with `payDay` = helper's salary anchor, preserving existing
 *  "added to the salary cycle" behaviour. */
export type PayrollAllowanceCadence =
  | 'monthly'        // payDay (1–28)
  | 'twice_monthly'  // payDaysOfMonth: [d1, d2]
  | 'weekly'         // payDayOfWeek (0=Sun..6=Sat)
  | 'biweekly'       // payDayOfWeek + biweek offset from startDate
  | 'one_time';      // payDate (YYYY-MM-DD)

export interface PayrollAllowance {
  /** Free-text label visible on the generated request ("Transport",
   *  "Airtime", "Meals", "Housing", etc.). */
  label: string;
  /** Recurring amount in cents added to every pay cycle on top of
   *  the basic rate. */
  amountCents: number;
  /** Typed category — display only (pill + icon). Optional; defaults to 'other'. */
  type?: PayrollAllowanceType;
  /** How often this allowance fires. Optional — absent = 'monthly' with the
   *  helper's salary anchor, matching pre-2026-05-27 behaviour. */
  cadence?: PayrollAllowanceCadence;
  /** Monthly cadence: day of month (1–28). */
  payDay?: number;
  /** Twice-monthly cadence: exactly two days of month (1–28), e.g. [1, 15]. */
  payDaysOfMonth?: number[];
  /** Weekly / biweekly cadence: 0=Sun .. 6=Sat. */
  payDayOfWeek?: number;
  /** One-time cadence: full pay date (YYYY-MM-DD). */
  payDate?: string;
  /** Generator bookkeeping — last YYYY-MM the monthly/twice-monthly cycle
   *  paid. Twice-monthly stores per-slot via `lastPaidMonthSlots` instead. */
  lastPaidMonth?: string;
  /** Twice-monthly bookkeeping: map of day-of-month → last YYYY-MM paid for
   *  THAT specific slot. e.g. { 1: '2026-05', 15: '2026-05' } once both
   *  halves of May 2026 are paid. */
  lastPaidMonthSlots?: Record<string, string>;
  /** Weekly/biweekly bookkeeping — last ISO week (YYYY-Www) paid. */
  lastPaidWeek?: string;
  /** One-time bookkeeping — set when paid; never fires again. */
  paidAt?: Timestamp;
}

export interface PayrollDeduction {
  /** Source request — typically the loan / advance the helper took. */
  sourceRequestId: string;
  /** Human label rendered on the pay request ("Loan from 18-May-2026"). */
  label: string;
  /** Amount deducted each pay cycle, in cents. */
  perCycleCents: number;
  /** Outstanding balance in cents. Decremented on every closed
   *  payroll request that included this deduction. */
  balanceCents: number;
  /** When balance hits 0 (or below), set false so the generator
   *  stops including the line. Kept in the array for audit. */
  active: boolean;
}

export interface HelperPayrollConfig {
  /** Hourly = needs check-ins (hours); Daily = needs check-ins
   *  (day-count); Monthly = fixed salary (no check-ins). */
  basis: PayBasis;
  /** Rate in cents. Per-hour / per-day / per-month per basis. */
  rateCents: number;
  /** Pay-cycle cadence — drives WHEN the generator fires. */
  frequency: PayFrequency;
  /** Anchor for the next pay date.
   *    weekly/biweekly → day-of-week (0=Sun .. 6=Sat)
   *    monthly         → day-of-month (1..28; capped for safety) */
  payAnchor: number;
  /** Expectation buffer in days: payment lands on `payAnchor + N` at the
   *  latest. Display-only — sets the helper's expectation ("paid by the
   *  7th"). The generator still fires on payAnchor; this is the polite
   *  upper bound a parent commits to. Default 0 = "paid on day N exactly".
   *  Cap: 7 days. */
  payAnchorBufferDays?: number;
  /** ISO YYYY-MM-DD when payroll begins. The generator won't
   *  back-fill before this date. */
  startDate: string;
  /** Optional contract end. Generator stops AFTER this date. */
  endDate?: string;
  /** Recurring allowances added to every pay cycle. */
  allowances?: PayrollAllowance[];
  /** Active loans + advances. Decremented per cycle on close. */
  deductions?: PayrollDeduction[];
  /** Last YYYY-MM-DD the generator created a request for this
   *  helper. Used to avoid double-creating. */
  lastGeneratedDate?: string;
  /** Optional cap: stop generating after this many cycles total.
   *  Null/undefined = open-ended. Decremented as requests are
   *  generated. */
  cyclesRemaining?: number | null;
  /** Parent authority (2026-06-08): when true (the default), a generated
   *  salary is auto-approved straight to the budget as "Processing" — no
   *  manual approve tap. The parent just confirms payment in the pay window.
   *  Set false to keep the old "review &amp; approve each cycle" behaviour. */
  autoApproveToBudget?: boolean;
  /** When true, Kaya reminds the parent to mark the salary paid once the
   *  pay window opens (1st of the following month). Default off. */
  markPaidReminder?: boolean;
  /** Pay-in-arrears (2026-06-08): when true, a monthly salary covers the
   *  month BEFORE the pay date — so pay made on 1–5 June covers MAY and is
   *  booked to May's budget. Default false = covers the pay date's month.
   *  Legacy — superseded by `payWindow` in the cycle model below. */
  salaryCoversPreviousMonth?: boolean;
  /** Cycle model (2026-06-08). A monthly salary covers a WORK CYCLE (the
   *  whole month) and is RAISED this many days before the cycle ends —
   *  so May is raised ~24 May, not on the pay day. Parent-set, default 7,
   *  cap 0..28. Monthly only; weekly/biweekly keep their window cadence. */
  raiseDaysBeforeCycleEnd?: number;
  /** When the salary is actually PAID — separate from the work cycle.
   *  'next_month' = 1st–5th of the month after the cycle (e.g. May's pay
   *  paid 1–5 Jun); 'same_month' = by the payAnchor day of the cycle month.
   *  Controls only when "Mark paid" shows; never moves the budget month.
   *  Default 'next_month'. */
  payWindow?: 'next_month' | 'same_month';
  /** Last work-cycle (YYYY-MM) the monthly generator raised. Idempotency
   *  guard for the cycle model, parallel to `lastGeneratedDate`. */
  lastGeneratedCycle?: string;
}

// ── Pay check-ins (hourly/daily helpers only) ────────────────────
//
// One doc per day per helper at:
//   /families/{f}/helpers/{uid}/payCheckIns/{YYYY-MM-DD}
//
// Helper taps "Log today" → writes the doc with hours + helperLoggedAt.
// Parent approves → adds approvedBy + approvedAt. The generator only
// counts APPROVED check-ins when computing basic pay.

export interface PayCheckIn {
  /** Doc id = YYYY-MM-DD. */
  date: string;
  /** Hours worked (1 or fractional for hourly; 1 for full day
   *  daily helpers — they can also enter 0.5 for half-day). */
  hours: number;
  /** When the helper self-logged. */
  helperLoggedAt: Timestamp;
  /** Approved by which parent (UID); undefined while unapproved. */
  approvedBy?: string;
  approvedAt?: Timestamp;
  /** Optional one-liner ("Came in late · made up next day"). */
  note?: string;
  /** Last edit stamp. */
  updatedAt?: Timestamp;
  updatedBy?: string;
}

// ── Helper Workplan ──────────────────────────────
// The helper's own task list — distinct from kid routines. Parent
// defines recurring items per day-of-week (e.g. "Make beds" on
// Mon–Sat morning, "Do laundry" on Tue+Thu). Helper sees today's set
// on /helper as a tap-to-check list, then optionally adds an EoD note.
//
// Two collections per helper:
//   /families/{f}/helpers/{uid}/workplanItems/{itemId}       — definitions
//   /families/{f}/helpers/{uid}/workplanCompletions/{date}   — per-day state
//
// Daily completion is one doc per date keyed by YYYY-MM-DD; it stores
// the set of completed item ids + the EoD note. This makes "what
// % of today is done" a single get + array compare.

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type WorkplanPeriod = 'morning' | 'evening' | 'anytime';

// v4-final §04 Step 7 (2026-05-18) — workplan items now come in two
// flavours. Legacy docs without `kind` are treated as 'recurring' for
// back-compat (every read site falls back via `?? 'recurring'`).
//   • recurring — repeats by `daysOfWeek` (the original behaviour)
//   • adhoc     — one-off tasks assigned for specific calendar dates
//                 (`scheduledDates`); `daysOfWeek` is ignored. Captured
//                 audit fields: `assignedAt`/`assignedBy`/optional `note`.
export type WorkplanItemKind = 'recurring' | 'adhoc';

export interface WorkplanItem {
  id: string;
  label: string;                       // e.g. "Make beds"
  icon: string;                        // emoji — surfaced as a big tile on the helper view
  daysOfWeek: DayOfWeek[];             // recurring: which days; adhoc: [] (ignored)
  period: WorkplanPeriod;              // groups tiles on the helper view; 'anytime' is the default
  active: boolean;                     // soft on/off without deleting (audit)
  createdAt: Timestamp;
  createdBy: string;                   // parent UID
  // ── Ad-hoc one-offs (v4-final §04 Step 7) ───────────────────────
  /** Item flavour. Absent = legacy recurring (read sites must coalesce). */
  kind?: WorkplanItemKind;
  /** Adhoc only: YYYY-MM-DD list of dates this task is scheduled for.
   *  Helper sees it on each of these dates; itemsScheduledOn() honors
   *  this for adhoc items in place of daysOfWeek. */
  scheduledDates?: string[];
  /** Adhoc only: when the parent assigned it (separate from createdAt
   *  for symmetry — they're the same on creation but distinguishing
   *  the audit field makes future "reassign" semantics cleaner). */
  assignedAt?: Timestamp;
  /** Adhoc only: parent UID who assigned this one-off. Mirrors
   *  createdBy on creation; kept separate for future delegated-assign. */
  assignedBy?: string;
  /** Adhoc only: optional short message from parent to helper
   *  ("pls also pick up cake on the way back"). Rendered under the
   *  tile label on both surfaces. */
  note?: string;
}

export interface WorkplanCompletion {
  date: string;                        // YYYY-MM-DD, doc id
  completedItemIds: string[];          // which workplanItems were checked off today
  eodNote?: string;                    // free-text end-of-day summary
  updatedAt: Timestamp;
  updatedBy: string;                   // typically helper UID; parent UID if they corrected
}

// Per-role invite code with lifecycle state. Stored under
// `Family.inviteCodes.{role}`. See the comment on `Family.inviteCodes`
// for the activation/expiry policy.
export interface InviteCodeState {
  code: string;
  active: boolean;
  /** Last time someone flipped `active` on. Display-only. */
  activatedAt?: Timestamp;
  /** When the code was consumed by a successful join. After this fires
   *  the code is auto-flipped to inactive and the parent must re-activate
   *  (or regenerate) before another join is allowed. */
  usedAt?: Timestamp;
}

export interface ExternalContact {
  /** Local id (timestamp-random) — used to address a single contact
   *  inside the array on update/delete since Firestore can't target
   *  array elements by index. */
  id: string;
  name: string;
  /** Validated client-side via the same regex used in
   *  `/api/notify`. Stored lowercased so de-dup against family member
   *  emails works on insert. */
  email: string;
  /** Default true. Stored explicitly so a parent can flip it off
   *  without re-creating the contact. */
  notifyOnRating?: boolean;
  notifyOnAward?: boolean;
  addedAt: Timestamp;
  /** uid of the parent who added the contact — purely audit. */
  addedBy: string;
}

export interface Routine {
  id: string;
  label: string;
  labelSw: string;
  icon: string;
  period: 'morning' | 'evening';
  pointsExcellent: number;
  pointsGood: number;
  pointsBad: number;
  active: boolean;
}

export interface Child {
  id: string;
  name: string;
  houseName: string;
  houseColor: string;
  avatarEmoji: string;
  avatarPhoto?: string;
  // ── Identity ──
  birthday?: string;          // canonical YYYY-MM-DD; UI displays DD-MMM-YYYY
  email?: string;             // optional — when set, this kid can later sign in with it
  emailLower?: string;        // lowercase mirror so we can match-on-signup case-insensitively
  loginEnabled?: boolean;     // parent toggle — must be true for the kid to sign in via email match
  handle?: string;            // case-preserved, e.g. "Daniella"
  handleLower?: string;       // lowercase mirror for unique lookup
  gender?: Gender;            // drives avatar hints + on-this-day filtering
  interests?: string[];       // free-form chips, e.g. ['Football', 'Lego']
  aspirations?: string[];     // up to 3, e.g. ['Pilot', 'Doctor', 'Footballer']
  // ── Little Stars (2026-07-26) ──
  /** Per-kid participation override — set only when a parent flips a
   *  wizard/profile switch away from the age-based family default
   *  (lib/participation.ts). Absent = follow family participationAges. */
  participationOverrides?: { sparks?: boolean; meetings?: boolean; notebook?: boolean };
  /** The day this kid was added to the family (YYYY-MM-DD) — powers the
   *  🎊 arrival celebration on Home + the pinned Moments welcome. */
  arrivedAt?: string;
  /** Set once the graduation reminder ("joins meetings next week!") has
   *  been sent for a surface, so the cron never double-notifies. */
  graduationNotified?: { sparks?: boolean; meetings?: boolean };
  // ── Game state ──
  totalPoints: number;
  weeklyPoints: number;
  streak: number;
  // ── Kaya Games — multi-device win tracking (written ONLY by the Admin
  //   /api/games/win route on a finished multi-device game; the Games board
  //   reads these). Game-points for the board are summed from approved
  //   gamePlays (games only), not totalPoints.
  gameWins?: number;        // total multi-device games won
  gameWinStreak?: number;   // current consecutive-win streak
  gameWinBest?: number;     // best streak ever reached
  badges: string[];
  /** BDG PR2 (B5) — lifetime EARNED points, the badge yardstick. Only ever
   *  grows (positive award deltas); redemptions/conversions never shrink it.
   *  Absent on old docs → treat as max(totalPoints, 0) (lazy backfill). */
  lifetimePoints?: number;
  /** BDG PR3 — one tally map for every badge signal Kaya can't read straight
   *  off this doc: `quiz_correct`, `meetings`, `workplan_done`, `conversions`,
   *  `goals_reached`, `diamonds`, `award_<category>`… Each area's flow bumps
   *  its own key; /api/badges/mint verifies the threshold server-side. */
  badgeCounters?: Record<string, number>;
  // Per-kid Celebrations preference (Kaya Business · celebrate engine). Shape
  // mirrors CelebrationSettings in lib/celebrate.ts (inlined to avoid a
  // circular import). Absent → age-based default.
  celebration?: { style: 'celebration' | 'inspiring' | 'surprise'; intensity: 'calm' | 'normal' | 'big'; sound: boolean };
  /** Whole-plan pause for THIS kid (holidays/pause). Applies to all their
   *  workplan tasks on covered days — streak-safe. Set via
   *  setChildWorkplanPause. Auto-resumes after `to`; nothing is deleted. */
  workplanPause?: WorkplanPause;
  // Running counters for 0-point award kinds. When either hits its family-
  // configured threshold, `giveAward` auto-fires a derived bonus/deduction
  // award and decrements the counter by the threshold (modulo, not reset —
  // overflow carries to the next cycle).
  kudosCount?: number;
  improvementNoteCount?: number;
  // Sender-side rate limit for kid → kid appreciation notes. Tracks
  // how many kudos this kid has SENT today (not received). Reset
  // implicitly when the date string no longer matches today's
  // YYYY-MM-DD. Read + bumped in `sendKidKudos`.
  dailyKudosSentDate?: string;
  dailyKudosSentCount?: number;
  // Routine Points — accumulator for the points earned from rated daily
  // routines. Held separately from `totalPoints` so each rating contributes
  // small (0/1/2) increments here, and the configured conversion rate
  // (default 100 RP → 1 HP) folds them into `totalPoints` once the
  // threshold is reached. Lets parents see fine-grained routine effort
  // without ballooning the headline score.
  routinePoints?: number;
  // ── The Hive · per-child overrides ──
  // Override the family-wide `hiveConfig.spendAutoApproveBelowCents` for
  // this kid. `null` (or absent) → use the family default. `0` → force
  // every spend through approval, even if the family has a default
  // threshold. Stored in the active currency's minor units (cents).
  spendAutoApproveBelowCents?: number | null;
  // ── 🤖 Kaya AI Levels · per-child override ──
  // A parent's deliberate level for THIS child (1-4) — wins over the
  // family default, uncapped. `null` / absent → inherit the family default
  // (age-guarded). Parent-written from Settings; kids can't update child
  // docs (firestore.rules · isParentOrHelper).
  aiLevel?: import('./ai/level.shared').AiLevel | null;
}

export interface WishlistItem {
  id: string;
  title: string;
  description?: string;
  url?: string;
  imageUrl?: string;
  estimatedCost?: number;
  achieved: boolean;
  achievedAt?: Timestamp;
  createdAt: Timestamp;
}

// ── Helper performance policy (v3, 2026-05-18) ──────────────────
//
// Per-family rules for how a helper's consolidated performance score
// is computed. v2 (workplan + budget, hardcoded 50/50, hardcoded face
// thresholds, hardcoded 7-day window) was always intended to be a
// stepping stone — Elia's original plan was 4 metrics × 25% each,
// parent-configurable. This is that.
//
// Doc location: /families/{f}/performancePolicy/default
// Singleton today; the subcollection layout leaves room for named
// alternate policies later (e.g. per-period overrides).

export type PerformanceMetric =
  | 'workplan'           // % of daily-scheduled tasks completed
  | 'budget'             // shop-cost adherence (under/over estimate)
  | 'ratingCompletion'   // % of expected morning+evening ratings logged
  | 'parentFeedback'     // aggregated 👍 / 😐 / 👎 from parent in window
  | 'kidReview';         // HP2 (2026-08-23) — kids' weekly review of the helper, averaged across kids

export interface PerformancePolicy {
  /** Weights as percentages — must sum to 100. Default 25 each. */
  weights: Record<PerformanceMetric, number>;
  /** Face-emoji cutoffs (0–100). Default 90 / 70 / 50:
   *    pct ≥ excellent → 😀 Excellent
   *    pct ≥ good      → 🙂 Good
   *    pct ≥ okay      → 😐 Okay
   *    pct <  okay     → 🙁 Low
   *  Validation guarantees excellent > good > okay > 0. */
  thresholds: { excellent: number; good: number; okay: number };
  /** Rolling window length in days for every metric. Default 7. */
  windowDays: number;
  /** Per-helper escape hatch — typically used to exclude a metric
   *  that doesn't apply ("tutor doesn't shop, exclude budget";
   *  "grandparent doesn't have a workplan, exclude workplan").
   *  HP2 (2026-08-23, D1/D9): `tracked` (default true) — false hides
   *  EVERY performance surface for that helper (face, %, tabs, emails,
   *  kid reviews) but leaves the workplan alone; `kidsReview`
   *  (default true) — whether assigned kids are asked to review them. */
  helperOverrides?: Record<string, {
    excludeMetrics?: PerformanceMetric[];
    tracked?: boolean;
    kidsReview?: boolean;
  }>;
  /** HP2 D2 — helpers may open their own Score / Routine-fill tabs
   *  (never kids' review answers). Default true (today's behaviour). */
  helpersSeeOwnScore?: boolean;
  /** HP2 D9–D13 — kids-review-helpers settings. */
  kidReview?: {
    /** Minimum kid age to be asked (default 5). */
    minAge: number;
    /** Email parents the moment a kid sends a review (default true). */
    emailOnSubmit: boolean;
  };
  updatedAt?: Timestamp;
  updatedBy?: string;
}

export const DEFAULT_KID_REVIEW_SETTINGS = { minAge: 5, emailOnSubmit: true };

export const DEFAULT_PERFORMANCE_POLICY: PerformancePolicy = {
  // kidReview starts at 0 (HP2 Q3) — shown beside the score, not inside
  // it, until a parent dials it in. Existing families' scores don't move.
  weights: { workplan: 25, budget: 25, ratingCompletion: 25, parentFeedback: 25, kidReview: 0 },
  thresholds: { excellent: 90, good: 70, okay: 50 },
  windowDays: 7,
  helpersSeeOwnScore: true,
  kidReview: DEFAULT_KID_REVIEW_SETTINGS,
};

// ── Parent feedback on a helper (v3 — 2026-05-18) ────────────────
//
// Doc: /families/{f}/helpers/{uid}/feedbackNotes/{YYYY-MM-DD}
// One doc per day (upsert by date) so a parent's tap "👍 today" is
// idempotent. Metric aggregates sentiment across the window:
//   score = clamp((positive% − negative%), 0, 100)
// Null when there are no notes in the window.

export type FeedbackSentiment = 'positive' | 'neutral' | 'negative';

export interface HelperFeedbackNote {
  /** Doc id = YYYY-MM-DD. Stored as a field for queryability. */
  date: string;
  sentiment: FeedbackSentiment;
  /** Optional one-line note ("Did extra without being asked",
   *  "Was late twice this week", etc.). */
  note?: string;
  createdAt: Timestamp;
  /** Parent UID who left the note. */
  createdBy: string;
  /** Latest-edit timestamp for the same day. */
  updatedAt?: Timestamp;
  updatedBy?: string;
}

export interface DailyRating {
  id: string;
  childId: string;
  date: string; // YYYY-MM-DD
  period: 'morning' | 'evening';
  ratings: Record<string, RatingValue>;
  totalPoints: number;
  ratedBy: string;
  ratedByName: string;
  // Free-text note for the whole period. Originally added so comments
  // from historical Google-Sheet logs are preserved on import; surfaced
  // on Reports + family meeting view.
  comment?: string;
  // Per-routine notes keyed by routine id. Required when a routine is
  // rated 'bad' (so meetings can address what went wrong); optional but
  // encouraged when rated 'excellent' (so wins get context). Surfaced in
  // the Reports notes panel alongside the overall `comment`.
  ratingNotes?: Record<string, string>;
  // Kid Stats PR2 (2026-07-29) — the kid's own reflection per routine
  // ("I stayed up reading; I'll sleep by 9"). Written ONLY via the
  // Admin route /api/stats/reflection (kids can't write ratings client-
  // side); frozen once a meeting on/after `date` exists. Surfaced in
  // My Stats detail, the meeting Behaviour tab and the Reports notes.
  reflections?: Record<string, { text: string; byUid: string; byName: string; at: number } | null>;
  createdAt: Timestamp;
}

export interface Award {
  id: string;
  childId: string;
  // The five recognised kinds. Older docs may not have this field — use
  // `inferAwardKind(award)` to read defensively. New writes always set it.
  kind?: AwardKind;
  points: number;          // 0 for kudos/improvement_note, negative for reducing
  reason: string;
  category: string;
  awardedBy: string;
  awardedByName: string;
  // Role of the awarder at the time of creation. Defaults to 'parent'
  // for legacy docs. Kid-authored kudos (the appreciation-note feature)
  // always carry 'kid'; helper-authored awards carry 'helper'.
  senderRole?: 'parent' | 'helper' | 'kid';
  createdAt: Timestamp;
  // Set when this award was auto-fired by the threshold accumulator
  // (e.g. 4 Kudos → +1 derived award). Lets the UI badge it as automatic
  // and lets us trace back the source events that triggered it.
  derivedFrom?: {
    kind: 'kudos' | 'improvement_note';
    sourceAwardIds: string[];
  };
  // Optional tag used by the historical import script so re-runs are
  // idempotent and the bulk can be cleaned up if needed. Live UI writes
  // omit this field.
  importSource?: string;
  /** 💛 Award emails 2.0 (2026-08-23) — the kid's "thanks" on this award,
   *  written via /api/points/award-thanks (Admin). Parents see it in the
   *  📬 Feedback card + the 🔔 bell. */
  kidNote?: { text: string; byUid: string; byName: string; at: number };
}

// Family-configurable rules for the point system. Persisted partial on the
// Family doc as `pointSystem`; read via `readPointSystemConfig()` so
// missing/partial values fall back to `DEFAULT_POINT_SYSTEM`.
export interface PointSystemConfig {
  reducing: {
    enabled: boolean;       // default false — disabled = no negative awards
    max: number;            // 1–10 — caps the magnitude of a single reducing award
  };
  kudos: {
    enabled: boolean;       // default true
    label: string;          // renameable, default 'Kudos'
    threshold: number;      // e.g. 4 → fires a bonus every 4 Kudos
    bonusPoints: number;    // points granted when threshold is reached (default 1)
    // ── Kid → kid appreciation note (opt-in) ─────────────────────
    // When true, kids can send each other 0-point kudos via the
    // "Send appreciation" UI on their home page. Received kudos still
    // run through the same threshold accumulator so a sibling-issued
    // kudos contributes toward the recipient's bonus the same way a
    // parent-issued kudos would. Off by default.
    kidToKidEnabled?: boolean;
    // Max appreciations a single kid can send per day. Enforced at
    // the app layer via a per-sender counter on the Child doc. Default 3.
    kidDailyCap?: number;
  };
  improvementNote: {
    enabled: boolean;       // default true
    label: string;          // renameable, default 'Improvement Note'
    threshold: number;      // e.g. 4 → fires a deduction every 4 notes
    deductionPoints: number; // magnitude of the deduction (default 1)
  };
  diamondMinPoints: number; // boundary between regular and diamond (default 4)
  routines: {
    // Conversion rate from accumulated routine points to a single house
    // point. Default 100 keeps headline scores clean — 30 days of
    // straight-Excellent routines turn into ~3-5 house points per kid.
    pointsPerHousePoint: number;
  };
}

export type ReflectionMode = 'story' | 'songs' | 'prayer';

export interface Meeting {
  id: string;
  date: string;
  type: 'weekly' | 'special' | 'kid-led';
  attendees: string[];
  gratitude: Record<string, string>;
  goals: Record<string, string>;
  notes: string;
  createdBy: string;
  createdAt: Timestamp;
  /** Per-kid appreciation captured in the new presenter-mode flow.
   *  Optional so historical meetings keep working unchanged. */
  appreciations?: Record<string, string>;
  /** v1 — per-kid done/not-done flag for the goal set in the *previous*
   *  meeting (stored on the *reviewing* meeting). Kept for backward
   *  compatibility with the first presenter-mode release; new code uses
   *  `goalsDone` on the meeting where the goal was actually set. */
  lastWeekGoalsDone?: Record<string, boolean>;
  /** v2 — per-kid done flag for the goals SET in this meeting.
   *  Mutated retrospectively by a later meeting's Goals Review step
   *  via `updateMeeting()`, so a goal can be reviewed and marked done
   *  even weeks later (not just the immediate next week). */
  goalsDone?: Record<string, boolean>;
  /** v4 — childIds who 🤝 pinky-promised the goal they committed to in this
   *  meeting. Next meeting's Goals Review surfaces a "you pinky-promised
   *  this" ribbon on those goals (and a "promise kept!" beat when done). */
  pinkyPromised?: string[];
  /** 🗣️ Open Floor (2026-07-20) — the night's topics with their outcome:
   *  💬 discussed · ✔ decided (note = the decision) · → parked (auto-
   *  carries to next week's queue). Firestore-safe array-of-maps. */
  openFloor?: Array<{ text: string; by?: string; outcome: 'discussed' | 'decided' | 'parked'; note?: string }>;
  /** 🧩 Custom 8th step (OF-3) — what the family's own step recorded. */
  customStep?: { name: string; emoji?: string; notes?: string };
  /** ⏰ Catch-Up Corner (2026-08-10) — per kid: cleared count, the open
   *  items the family faced, and the promise made (also merged into the
   *  kid's goals so next week's review checks it). */
  catchUps?: Record<string, { cleared: number; open: string[]; promise?: string }>;
  /** Meeting Notes (2026-06-21) — leadership captured on the record so the
   *  structured notes + recap email can tell the story: who led tonight,
   *  who led the prayer, and who leads next week (post-wheel snapshot). */
  ledByName?: string;
  prayerLedBy?: string;
  nextLeaderName?: string;
  /** Meeting Notes — a snapshot of the week's Points & Rewards at finish
   *  time (last-7-days window ending tonight), so the notes/email stay
   *  accurate forever even as live points move on. Firestore-safe
   *  array-of-maps. `stars` = days this kid had the most Excellents. */
  pointsSummary?: {
    kids: Array<{ childId: string; name: string; hp: number; excellentDays: number; stars: number; belt?: boolean }>;
    redeemed?: Array<{ name: string; reward: string; points: number }>;
  };
  /** SM3.1 (#2) — 🙏 Opening Word: how the leader opened the night.
   *  Stamped when the leader marks the opening done; absent when the
   *  step was skipped (or disabled). Shows in the meeting report. */
  openingWord?: {
    mode: 'prayer' | 'wisdom' | 'verse' | 'own';
    note?: string;
    doneAt?: number;   // epoch ms
  };
  /** SM3.1 (#7) — 🎁 tonight's Sunday Surprise as it happened. `postId`
   *  links the Moments post for photo/video surprises. `missions` (Secret
   *  Mission) stays sealed until NEXT meeting's check-in writes
   *  `checkedMissions` back onto this doc. */
  surprise?: {
    id: string;
    promptText?: string;
    note?: string;
    postId?: string;
    missions?: Record<string, string>;
    checkedMissions?: Record<string, boolean>;
  };
  /** 🌟 Note of the Week (Timeline 2.0): tonight's crowned journal note. */
  noteOfWeek?: {
    kidId: string;
    kidName: string;
    date: string;
    surface: 'reflection' | 'diary';
    excerpt: string;
    postId?: string;
    at: number;
  };
  /** SM3.1 (H·B): 🎭 tonight's co-host roles — roleId → childId. The Wheel
   *  deals them at Attendance; each role-kid earns +1 HP at finish. */
  roles?: Record<string, string>;
  /** SM3.1 (H·C): 🗳️ tonight's Family Vote as it closed. */
  vote?: {
    question: string;
    winner: string;
    counts: Record<string, number>;
  };
  /** Optional "anyone presenting tonight?" capture during the new
   *  attendance step. */
  presentation?: {
    by?: string;
    topic?: string;
  };
  /** v2 attendees — captures parent UIDs alongside kid IDs (the v1
   *  `attendees` array was kids-only). Optional + additive so older
   *  records continue to load. */
  parentAttendees?: string[];
  /** Free-form guests present at the meeting. Each guest is captured
   *  with a display name + optional relationship label so the saved
   *  record reads naturally ("Bibi Asha · Grandma") for future review. */
  guestAttendees?: Array<{
    /** Stable id so toggling/editing works during the meeting. Not a
     *  Firebase UID — these are session-scoped. */
    id: string;
    name: string;
    /** e.g. "Grandma", "Family Friend", "Cousin", "Nanny", "Other". */
    relationship?: string;
  }>;
  /** What the family did to close the meeting — story, songs, or a
   *  family prayer. v1 was single-mode (mode + content). v2 supports
   *  multi-select (modes[]) so a family can do a story AND a prayer
   *  on the same night. Readers should prefer `modes`/`contents` and
   *  fall back to `mode`/`content` for older saved meetings. */
  reflection?: {
    /** v1 single-mode (kept for backward compat). */
    mode?: ReflectionMode;
    /** v1 single-mode content. */
    content?: string;
    /** v2 multi-mode — which modes were chosen this meeting. */
    modes?: ReflectionMode[];
    /** v2 per-mode content. Missing entries = mode picked but blank. */
    contents?: Partial<Record<ReflectionMode, string>>;
    /** Sunday-Meeting v2 (b5): uid of the parent who approved a
     *  kid-attached song link (only set when approval was required).
     *  Empty / undefined = either no song link, or a parent typed it
     *  themselves, or the family disabled the approval requirement. */
    songLinkApprovedBy?: string;
  };
}

export interface Reward {
  id: string;
  title: string;
  description: string;
  pointsCost: number;
  icon: string;
  active: boolean;
  // Category is free-text so parents can name buckets however they like
  // (Treats, Privileges, Outings, Family-only…). Optional for backward
  // compat with rewards seeded before categories existed — those fall
  // back to DEFAULT_REWARD_CATEGORY on display.
  category?: string;
  // ── 🔒 RWD PR4 — locked / coming-soon (distinct from retiring via
  //    `active:false`, which hides completely). Locked rewards stay VISIBLE
  //    to kids, greyed with a countdown, so the excitement builds.
  locked?: boolean;
  /** YYYY-MM-DD — auto-unlocks on this local day (hourly cron flips the flag
   *  + rings the kids' bells). Absent = locked until a parent unlocks. */
  lockedUntil?: string;
  /** Set by the cron so the unlock bell only rings once. */
  unlockNotified?: boolean;
  /** 🎂 RWD PR6 — minimum age to redeem this reward. Younger kids see it
   *  🔒 "from age N" (it auto-opens as they grow). No birthday = no gating. */
  minAge?: number;
  /** 💡 RWI PR-B — set when this reward began as a kid's idea; the
   *  "idea by {name}" credit stays on the card forever. */
  ideaBy?: { childId: string; name: string };
  // ── 👨‍👩‍👧 RWD PR5 — family goal (everyone chips in). For family goals
  //    `pointsCost` is ignored; `targetPoints` is the team total.
  kind?: 'personal' | 'family';
  targetPoints?: number;
  /** 'equal' = target splits evenly across included kids; 'open' = anyone
   *  chips in any amount, volunteers can carry more. */
  poolMode?: 'equal' | 'open';
  /** Parent's advice line shown on the goal card. */
  parentNote?: string;
  /** Running total + per-kid contributions (childId → points), updated
   *  transactionally on each approved chip-in. */
  contributedTotal?: number;
  contributions?: Record<string, number>;
  goalReachedAt?: Timestamp;
  /** Parent marked the goal fulfilled IRL (writes the family history row). */
  fulfilled?: boolean;
}

/** Current age from a YYYY-MM-DD birthday, or null when unknown. */
export function ageFromBirthday(birthday?: string): number | null {
  if (!birthday) return null;
  const birth = new Date(`${birthday}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

/** 👨‍👩‍👧 Is this kid INCLUDED in family goals? Age-gated the Little-Stars way:
 *  per-kid override wins → else age >= the family threshold → no birthday or
 *  no threshold = included (no-birthday-no-gating rule). */
export function isKidInFamilyGoals(
  cfg: { familyGoalsFromAge?: number; familyGoalsOverrides?: Record<string, boolean> } | undefined,
  child: { id: string; birthday?: string },
): boolean {
  const override = cfg?.familyGoalsOverrides?.[child.id];
  if (typeof override === 'boolean') return override;
  const fromAge = cfg?.familyGoalsFromAge;
  if (!fromAge || fromAge <= 0 || !child.birthday) return true;
  const birth = new Date(`${child.birthday}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return true;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age >= fromAge;
}

/** 🔒 Is this reward locked right now? Date-based locks auto-open the moment
 *  the local day arrives — the cron then also flips the flag + notifies. */
export function isRewardLocked(r: Reward, todayKey?: string): boolean {
  if (!r.locked) return false;
  if (!r.lockedUntil) return true;
  const today = todayKey ?? (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  return today < r.lockedUntil;
}

// Logged once per `redeemReward()` call. `rewardTitle` is denormalised
// so the history view still works after the underlying Reward doc is
// edited or deleted by a parent.
export interface Redemption {
  id: string;
  childId: string;
  rewardId: string;
  rewardTitle: string;
  pointsSpent: number;
  createdAt: Timestamp;
  // ── RWD PR1 — approval accounting. Legacy rows (pre-26-Jul-2026) have
  //    none of these and read as an approved instant redemption.
  status?: 'approved' | 'rejected';
  /** Parent uid who approved, or 'auto' (under the family threshold). */
  approvedBy?: string;
  /** Parent's note to the kid, mirrored from the approval. */
  note?: string;
  /** 💬 RWD PR2 — the kid's post-enjoyment reaction, written via the
   *  kid-authed /api/rewards/feedback route (client rules keep redemption
   *  docs parent/server-only). Aggregated per reward for parents. */
  feedback?: { reaction: 'loved' | 'ok' | 'meh'; text?: string };
}

// Seed categories shown in the dropdown the first time a parent opens
// the manage page. Plain English per Kaya naming convention.
export const DEFAULT_REWARD_CATEGORIES: { name: string; icon: string }[] = [
  { name: 'Treats',      icon: '🍦' },
  { name: 'Privileges',  icon: '🌙' },
  { name: 'Experiences', icon: '🎫' },
  { name: 'Things',      icon: '🎁' },
];

export const DEFAULT_REWARD_CATEGORY = 'Treats';

// ── Reward Library ─────────────────────────────────
// Curated catalog parents browse to seed their family's rewards list
// without having to invent everything from scratch. Defined in code
// (no Firestore reads) — the parent picks items, we batch-copy the
// chosen ones into `families/{id}/rewards`. From there they're
// editable / deletable like any other reward.
//
// Keep entries culturally neutral (Kaya runs UAE + USA + TZ households)
// and avoid anything that assumes a religion, gender role, or local
// currency. Pocket-money rewards live in The Hive, not here.
export type LibraryReward = Omit<Reward, 'id' | 'active'>;

export const REWARD_LIBRARY: LibraryReward[] = [
  // ── Treats ──────────────────────────────────────
  { title: 'Ice cream outing',              description: 'Family trip to the ice cream parlour',                pointsCost: 50,  icon: '🍦', category: 'Treats' },
  { title: 'Pick the family dessert',       description: 'You choose what everyone has after dinner',           pointsCost: 20,  icon: '🍨', category: 'Treats' },
  { title: 'Hot chocolate with marshmallows', description: 'A proper mug, your way',                            pointsCost: 15,  icon: '☕', category: 'Treats' },
  { title: 'Bake cookies with a parent',    description: 'Choose the recipe, do the mixing',                    pointsCost: 30,  icon: '🍪', category: 'Treats' },
  { title: 'Smoothie of your choice',       description: 'Any combo you can imagine',                           pointsCost: 15,  icon: '🥤', category: 'Treats' },
  { title: 'Pizza night (you pick toppings)', description: 'You design the whole pizza',                        pointsCost: 40,  icon: '🍕', category: 'Treats' },
  { title: 'Frozen yogurt trip',            description: 'Outing to the fro-yo place',                          pointsCost: 50,  icon: '🍧', category: 'Treats' },
  { title: 'Pancake breakfast',             description: 'Pancakes made just how you like them',                pointsCost: 25,  icon: '🥞', category: 'Treats' },
  { title: 'Order takeaway favourite',      description: 'Choose where the family orders from',                 pointsCost: 60,  icon: '🥡', category: 'Treats' },
  { title: 'Pick a snack at the shop',      description: 'One snack of your choice on the next shop',           pointsCost: 20,  icon: '🍭', category: 'Treats' },
  { title: 'Cupcake decorating',            description: 'Bake and decorate cupcakes, your design',             pointsCost: 35,  icon: '🧁', category: 'Treats' },
  { title: 'Make your own milkshake',       description: 'Any flavour combo you can dream up',                  pointsCost: 20,  icon: '🍫', category: 'Treats' },
  { title: 'Donut run',                     description: 'Pick the donut shop, pick the donut',                 pointsCost: 30,  icon: '🍩', category: 'Treats' },
  { title: 'Build-your-own sundae',         description: 'A bowl of toppings, no limits',                       pointsCost: 30,  icon: '🍒', category: 'Treats' },
  { title: 'Lemonade stand kit',            description: 'Set up a stand, keep the takings',                    pointsCost: 50,  icon: '🍋', category: 'Treats' },
  { title: 'Popcorn movie snack',           description: 'Fresh popcorn for tonight\'s movie',                  pointsCost: 10,  icon: '🍿', category: 'Treats' },
  { title: 'Build your own burger',         description: 'You pick every topping',                              pointsCost: 30,  icon: '🍔', category: 'Treats' },
  { title: 'Cotton candy at a fair',        description: 'Or anywhere they sell it',                            pointsCost: 25,  icon: '🍡', category: 'Treats' },

  // ── Privileges ──────────────────────────────────
  { title: 'Extra screen time (30 min)',    description: 'A bonus half hour today',                             pointsCost: 20,  icon: '📱', category: 'Privileges' },
  { title: 'Extra screen time (1 hr)',      description: 'A bonus full hour today',                             pointsCost: 35,  icon: '⏰', category: 'Privileges' },
  { title: 'Stay up 30 min late',           description: 'Bedtime pushed back tonight',                         pointsCost: 25,  icon: '🌙', category: 'Privileges' },
  { title: 'Stay up an hour late',          description: 'Bedtime pushed back tonight by a whole hour',         pointsCost: 50,  icon: '🌜', category: 'Privileges' },
  { title: 'Choose the family movie',       description: 'You pick what we all watch',                          pointsCost: 30,  icon: '🎬', category: 'Privileges' },
  { title: 'Pick the dinner menu',          description: 'Choose what the family eats tonight',                 pointsCost: 30,  icon: '🍽️', category: 'Privileges' },
  { title: 'Be the family DJ',              description: 'Control the music for the whole car ride',            pointsCost: 15,  icon: '🎶', category: 'Privileges' },
  { title: 'Front seat in the car',         description: 'Ride shotgun on the next trip',                       pointsCost: 20,  icon: '🚗', category: 'Privileges' },
  { title: 'Skip one chore today',          description: 'One chore of your choice — gone',                     pointsCost: 35,  icon: '✋', category: 'Privileges' },
  { title: 'Skip the dishes for a week',    description: 'A whole week off dish duty',                          pointsCost: 100, icon: '🧽', category: 'Privileges' },
  { title: 'Choose tomorrow\'s outfit',     description: 'Including a parent\'s outfit if you dare',            pointsCost: 25,  icon: '👕', category: 'Privileges' },
  { title: 'First in the bathroom',         description: 'Skip the morning queue tomorrow',                     pointsCost: 10,  icon: '🚿', category: 'Privileges' },
  { title: 'Stay up for the big match',     description: 'Watch the late game with the family',                 pointsCost: 40,  icon: '⚽', category: 'Privileges' },
  { title: 'Decide what we play',           description: 'Pick the next family game night activity',            pointsCost: 20,  icon: '🎲', category: 'Privileges' },
  { title: 'Lead the family meeting',       description: 'You run the weekly catch-up this week',               pointsCost: 35,  icon: '🗣️', category: 'Privileges' },
  { title: 'Pyjama day at home',            description: 'One Saturday — no getting dressed',                   pointsCost: 30,  icon: '🛌', category: 'Privileges' },
  { title: 'Breakfast in bed',              description: 'A parent brings breakfast to you',                    pointsCost: 40,  icon: '🛎️', category: 'Privileges' },
  { title: 'Choose Sunday lunch spot',      description: 'Pick where the family eats Sunday',                   pointsCost: 50,  icon: '🍱', category: 'Privileges' },
  { title: 'Phone time (15 min)',           description: 'Extra phone time today',                              pointsCost: 15,  icon: '📲', category: 'Privileges' },
  { title: 'Tablet game time (30 min)',     description: 'Bonus tablet game session',                           pointsCost: 25,  icon: '🎮', category: 'Privileges' },
  { title: 'Choose the radio station',      description: 'You own the airwaves on the next drive',              pointsCost: 10,  icon: '📻', category: 'Privileges' },
  { title: 'Choose the bedtime story',      description: 'You pick what we read tonight',                       pointsCost: 10,  icon: '📕', category: 'Privileges' },

  // ── Experiences ─────────────────────────────────
  { title: 'Friend sleepover',              description: 'Invite a friend to stay the night',                   pointsCost: 150, icon: '🏠', category: 'Experiences' },
  { title: 'Cinema outing',                 description: 'Trip to the cinema, ticket on the family',            pointsCost: 120, icon: '🎟️', category: 'Experiences' },
  { title: 'Trip to the park',              description: 'Special trip to your favourite park',                 pointsCost: 40,  icon: '🌳', category: 'Experiences' },
  { title: 'Bowling night',                 description: 'Family bowling trip',                                 pointsCost: 100, icon: '🎳', category: 'Experiences' },
  { title: 'Trampoline park',               description: 'An hour of jumping',                                  pointsCost: 120, icon: '🤸', category: 'Experiences' },
  { title: 'Beach day',                     description: 'Half-day at the beach',                               pointsCost: 100, icon: '🏖️', category: 'Experiences' },
  { title: 'Museum trip',                   description: 'Pick the museum, we go',                              pointsCost: 80,  icon: '🏛️', category: 'Experiences' },
  { title: 'Cooking class with a parent',   description: '1-on-1 in the kitchen, you choose the dish',          pointsCost: 80,  icon: '👨‍🍳', category: 'Experiences' },
  { title: 'Build a fort in the lounge',    description: 'Pillow fort takes over the living room',              pointsCost: 30,  icon: '🛖', category: 'Experiences' },
  { title: 'Camp in the garden',            description: 'Tent in the back yard for the night',                 pointsCost: 60,  icon: '⛺', category: 'Experiences' },
  { title: 'Solo time with a parent',       description: '2 hours, just you and a parent, your plan',           pointsCost: 80,  icon: '💞', category: 'Experiences' },
  { title: 'Visit grandparents',            description: 'A special trip to see grandparents',                  pointsCost: 60,  icon: '👴', category: 'Experiences' },
  { title: 'Zoo trip',                      description: 'Day out at the zoo',                                  pointsCost: 150, icon: '🦒', category: 'Experiences' },
  { title: 'Aquarium trip',                 description: 'Day out at the aquarium',                             pointsCost: 150, icon: '🐠', category: 'Experiences' },
  { title: 'Family bike ride',              description: 'Long ride to a place you choose',                     pointsCost: 50,  icon: '🚴', category: 'Experiences' },
  { title: 'Picnic of your choice',         description: 'Pack the basket, pick the spot',                      pointsCost: 50,  icon: '🧺', category: 'Experiences' },
  { title: 'Mini golf outing',              description: 'Family round of mini golf',                           pointsCost: 100, icon: '⛳', category: 'Experiences' },
  { title: 'Roller skating trip',           description: 'An hour at the rink',                                 pointsCost: 100, icon: '🛼', category: 'Experiences' },
  { title: 'Ice skating trip',              description: 'An hour on the ice',                                  pointsCost: 100, icon: '⛸️', category: 'Experiences' },
  { title: 'Arcade outing',                 description: 'A round of tokens at the arcade',                     pointsCost: 100, icon: '🕹️', category: 'Experiences' },
  { title: 'Theme park day',                description: 'A whole day at a theme park',                         pointsCost: 400, icon: '🎢', category: 'Experiences' },
  { title: 'Water park outing',             description: 'Day at the water park',                               pointsCost: 300, icon: '🏊', category: 'Experiences' },
  { title: 'Stadium match ticket',          description: 'See a live sports match',                             pointsCost: 350, icon: '🏟️', category: 'Experiences' },
  { title: 'Concert ticket',                description: 'See a kid-friendly live show',                        pointsCost: 350, icon: '🎤', category: 'Experiences' },
  { title: 'Pottery class',                 description: 'A pottery or clay session',                           pointsCost: 200, icon: '🏺', category: 'Experiences' },
  { title: 'Escape room',                   description: 'Family escape-room session',                          pointsCost: 250, icon: '🗝️', category: 'Experiences' },

  // ── Things ──────────────────────────────────────
  { title: 'New book',                      description: 'A book of your choice',                               pointsCost: 80,  icon: '📖', category: 'Things' },
  { title: 'New small toy',                 description: 'A small toy on the next shop',                        pointsCost: 100, icon: '🧸', category: 'Things' },
  { title: 'New art supplies',              description: 'Pens, paints or paper of your choice',                pointsCost: 70,  icon: '🎨', category: 'Things' },
  { title: 'Sticker pack',                  description: 'A new pack of stickers',                              pointsCost: 30,  icon: '✨', category: 'Things' },
  { title: 'Lego set (small)',              description: 'A small Lego or building set',                        pointsCost: 150, icon: '🧱', category: 'Things' },
  { title: 'Lego set (medium)',             description: 'A medium Lego or building set',                       pointsCost: 300, icon: '🏗️', category: 'Things' },
  { title: 'New game for the tablet',       description: 'One paid app or game',                                pointsCost: 100, icon: '🎮', category: 'Things' },
  { title: 'Sports gear',                   description: 'A small piece of kit you choose',                     pointsCost: 120, icon: '⚽', category: 'Things' },
  { title: 'Plant for your room',           description: 'Pick a houseplant — you care for it',                 pointsCost: 60,  icon: '🪴', category: 'Things' },
  { title: 'Decoration for your room',      description: 'A poster, fairy lights, something you love',          pointsCost: 80,  icon: '🖼️', category: 'Things' },
  { title: 'New stationery',                description: 'Notebook, pens, the lot',                             pointsCost: 50,  icon: '📒', category: 'Things' },
  { title: 'Puzzle (500–1000 pcs)',         description: 'A new jigsaw puzzle',                                 pointsCost: 100, icon: '🧩', category: 'Things' },
  { title: 'Board game of your choice',     description: 'A new board game for the family',                     pointsCost: 200, icon: '♟️', category: 'Things' },
  { title: 'Card pack',                     description: 'Trading cards or a card-game booster',                pointsCost: 60,  icon: '🃏', category: 'Things' },
  { title: 'New piece of clothing',         description: 'You pick the shirt / dress / hoodie',                 pointsCost: 200, icon: '👚', category: 'Things' },
  { title: 'New shoes',                     description: 'You choose, within reason',                           pointsCost: 350, icon: '👟', category: 'Things' },
  { title: 'Headphones',                    description: 'A set of kid-friendly headphones',                    pointsCost: 250, icon: '🎧', category: 'Things' },
  { title: 'Backpack',                      description: 'A new backpack you pick',                             pointsCost: 200, icon: '🎒', category: 'Things' },
  { title: 'Water bottle',                  description: 'A new bottle you love',                               pointsCost: 60,  icon: '🧴', category: 'Things' },
  { title: 'Hair accessory',                description: 'Clips, bands, scrunchies — your call',                pointsCost: 30,  icon: '🎀', category: 'Things' },

  // ── Learning ─────────────────────────────────────
  { title: 'Documentary night',             description: 'Pick a documentary, the family watches',              pointsCost: 25,  icon: '📺', category: 'Learning' },
  { title: 'Online course of your choice',  description: 'A short course on something you love',                pointsCost: 200, icon: '💻', category: 'Learning' },
  { title: 'Magazine subscription',         description: 'A monthly magazine just for you',                     pointsCost: 180, icon: '📰', category: 'Learning' },
  { title: 'Library trip',                  description: 'Pick out 5 books to take home',                       pointsCost: 30,  icon: '🏫', category: 'Learning' },
  { title: 'Science experiment kit',        description: 'A small kit to try at home',                          pointsCost: 150, icon: '🔬', category: 'Learning' },
  { title: 'Coding game subscription',      description: 'A month of a kid-coding platform',                    pointsCost: 250, icon: '⌨️', category: 'Learning' },
  { title: 'Music lesson',                  description: 'One lesson on the instrument of your choice',         pointsCost: 200, icon: '🎹', category: 'Learning' },
  { title: 'Art class',                     description: 'A one-off art class',                                 pointsCost: 200, icon: '🖌️', category: 'Learning' },
  { title: 'Pick the next non-fiction book', description: 'Choose what the family reads aloud next',            pointsCost: 30,  icon: '📚', category: 'Learning' },
  { title: 'Globe / atlas',                 description: 'A globe or kid atlas for your room',                  pointsCost: 200, icon: '🌍', category: 'Learning' },
  { title: 'Telescope time',                description: 'A clear night, a telescope, a parent',                pointsCost: 60,  icon: '🔭', category: 'Learning' },
  { title: 'Visit a planetarium',           description: 'Half-day at the planetarium',                         pointsCost: 200, icon: '🪐', category: 'Learning' },

  // ── Connection ───────────────────────────────────
  { title: 'Video call with cousin',        description: 'Set up a long catch-up call',                         pointsCost: 15,  icon: '📞', category: 'Connection' },
  { title: 'Write a letter together',       description: 'Letter to a family member, stamp included',           pointsCost: 20,  icon: '✉️', category: 'Connection' },
  { title: 'Family game night',             description: 'You pick the game, everyone plays',                   pointsCost: 30,  icon: '🎲', category: 'Connection' },
  { title: 'Story time (you read)',         description: 'You read the bedtime story tonight',                  pointsCost: 15,  icon: '📚', category: 'Connection' },
  { title: 'One-on-one walk',               description: '30 min walk with a parent, you talk',                 pointsCost: 25,  icon: '🚶', category: 'Connection' },
  { title: 'Cook dinner with a parent',     description: 'Plan it, shop it, cook it together',                  pointsCost: 60,  icon: '🍳', category: 'Connection' },
  { title: 'Photo album afternoon',         description: 'Go through old family photos together',               pointsCost: 30,  icon: '🖼️', category: 'Connection' },
  { title: 'Phone a grandparent',           description: 'A real, long catch-up call',                          pointsCost: 15,  icon: '☎️', category: 'Connection' },
  { title: 'Sibling team-up time',          description: 'Pick something to do with a sibling — together',      pointsCost: 20,  icon: '👫', category: 'Connection' },
  { title: 'Family karaoke',                description: 'Pick the playlist, everyone sings',                   pointsCost: 30,  icon: '🎤', category: 'Connection' },
  { title: 'Send a postcard',               description: 'Write and post a card to someone you love',           pointsCost: 20,  icon: '📮', category: 'Connection' },
  { title: 'Family talent show',            description: 'You host the family talent show',                     pointsCost: 50,  icon: '🎭', category: 'Connection' },

  // ── Skills ──────────────────────────────────────
  { title: 'Learn to ride a bike',          description: 'A focused parent-led session',                        pointsCost: 80,  icon: '🚲', category: 'Skills' },
  { title: 'Learn a new card trick',        description: 'A parent teaches you a magic trick',                  pointsCost: 30,  icon: '🪄', category: 'Skills' },
  { title: 'Sewing a button',               description: 'Real needle, real thread, real shirt',                pointsCost: 40,  icon: '🧵', category: 'Skills' },
  { title: 'Knot-tying session',            description: 'Learn five useful knots',                             pointsCost: 30,  icon: '🪢', category: 'Skills' },
  { title: 'Learn to whistle a tune',       description: 'A parent teaches you',                                pointsCost: 20,  icon: '🎼', category: 'Skills' },
  { title: 'Learn to make pasta',           description: 'From scratch, with a parent',                         pointsCost: 80,  icon: '🍝', category: 'Skills' },
  { title: 'Learn a chess opening',         description: 'Master one named opening',                            pointsCost: 50,  icon: '♟️', category: 'Skills' },
  { title: 'Origami session',               description: 'Fold 5 new things',                                   pointsCost: 30,  icon: '🦢', category: 'Skills' },
  { title: 'Learn a juggling trick',        description: 'Three balls, real progress',                          pointsCost: 50,  icon: '🤹', category: 'Skills' },
  { title: 'Tie your own shoelaces',        description: 'Master the bow, get the badge',                       pointsCost: 30,  icon: '👞', category: 'Skills' },

  // ── Adventure ───────────────────────────────────
  { title: 'Family hike',                   description: 'A new trail of your choice',                          pointsCost: 100, icon: '🥾', category: 'Adventure' },
  { title: 'Geocaching afternoon',          description: 'Hunt down two caches together',                       pointsCost: 80,  icon: '🧭', category: 'Adventure' },
  { title: 'Tide-pool exploring',           description: 'Half-day at the rock pools',                          pointsCost: 100, icon: '🦀', category: 'Adventure' },
  { title: 'Forest scavenger hunt',         description: 'You make the list, family hunts',                     pointsCost: 60,  icon: '🍃', category: 'Adventure' },
  { title: 'Sunrise breakfast outing',      description: 'Up early, breakfast somewhere new',                   pointsCost: 80,  icon: '🌅', category: 'Adventure' },
  { title: 'Bird-watching morning',         description: 'Binoculars, list, quiet patience',                    pointsCost: 50,  icon: '🐦', category: 'Adventure' },
  { title: 'Star-gazing night',             description: 'Drive somewhere dark, stay up late',                  pointsCost: 100, icon: '✨', category: 'Adventure' },
  { title: 'Try a new sport',               description: 'A single trial session of something new',             pointsCost: 150, icon: '🥅', category: 'Adventure' },
  { title: 'Treasure hunt at home',         description: 'A parent sets one up — clues and all',                pointsCost: 40,  icon: '🗺️', category: 'Adventure' },
  { title: 'Kayak / canoe trip',            description: 'A guided paddle outing',                              pointsCost: 250, icon: '🛶', category: 'Adventure' },
];

export const REWARD_LIBRARY_CATEGORIES = Array.from(
  new Set(REWARD_LIBRARY.map((r) => r.category || DEFAULT_REWARD_CATEGORY))
);

export interface Notification {
  id: string;
  type:
    | 'points'
    | 'badge'
    | 'meeting'
    | 'reward'
    | 'streak'
    // Moments events — surfaced in the bell icon dropdown.
    | 'moment-reaction'
    | 'moment-comment'
    | 'moment-mention'
    | 'moment-new'
    // Messaging — a new chat message (in-app bell deep-links to the thread).
    | 'message'
    // Household → Workplan v3 (v4-final §04 Step 8, 2026-05-18) —
    // parent assigned a one-off task to this helper. `link` deep-links
    // to /helper so the helper lands on their workplan card.
    | 'workplan-adhoc-assigned'
    // Household → Purchase request events (2026-05-19). Four flavours:
    //   `purchase-approval-requested` — helper sent a draft for approval;
    //                                   notified to all parents.
    //   `purchase-approved`           — parent approved a request;
    //                                   notified to the creator (helper).
    //   `purchase-rejected`           — parent rejected (or force-rejected
    //                                   an already-approved request);
    //                                   notified to the creator so they
    //                                   don't shop on an outdated nod.
    //   `purchase-reconciled`         — helper closed reconcile, budget
    //                                   posted; notified to all parents.
    //   `utility-topup-reminder`      — a regular top-up's reminder day
    //                                   arrived; nudges helpers to launch
    //                                   a request. Links to /pantry/utility.
    // Each one's `link` deep-links to /pantry/purchase/{requestId}.
    | 'purchase-approval-requested'
    | 'purchase-approved'
    | 'purchase-rejected'
    | 'purchase-reconciled'
    //   `purchase-shared` — a parent/helper shared an approved purchase's
    //                       printable form with a family member via Kaya.
    //                       Links to /pantry/purchase/{id}/print.
    | 'purchase-shared'
    | 'utility-topup-reminder'
    // Kaya Business → daily stock-take nudge (Phase 2 · A2). Links to the
    // business's stock-take screen; sent to the owner kid + parents.
    | 'business-stocktake-reminder'
    // Kaya Pulse — a reading task is due today (links to Quick Entry) or was
    // missed (links to Today). Sent to the assigned reader (kid or helper).
    | 'pulse-reading-due'
    | 'pulse-missed'
    // Kaya Reminders — a reminder's lead-time fired (in-app channel), or a
    // kid's shared-event needs/cleared a parent nod. Links to /reminders.
    | 'reminder'
    // Sunday Meeting — someone @-tagged you in their appreciation; revealed
    // to you on meeting day (kept sealed until the meeting is submitted).
    // Links to /meetings.
    | 'appreciation'
    // Sunday Meeting — a kid leader chose a closing song that needs a
    // parent's OK before it plays. Sent to all parents; links to /my-day
    // where they can tap Approve. (v4.6)
    | 'song-approval';
  title: string;
  message: string;
  read: boolean;
  forUserId: string;
  /** Optional link target — when set, tapping the notification opens it.
   *  For Moments events this is `/moments/{postId}`. */
  link?: string;
  createdAt: Timestamp;
}

// ── Default Routines ──────────────────────────────
// Morning (8) + Evening (12) — aligned with the Excel "Form 2" template
// used by Elia's household for ~6 months. Single source of truth: new
// families get this whole set; existing families can add/rename/disable
// via `RoutinesEditor` in Settings.
export const DEFAULT_ROUTINES: Routine[] = [
  // ── Morning (8) ──
  { id: 'bed',         label: 'Making bed',         labelSw: 'Kutandika Kitanda',    icon: '🛏️', period: 'morning', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'teeth',       label: 'Brushing teeth',     labelSw: 'Kuswaki',              icon: '🪥', period: 'morning', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'bath',        label: 'Taking bath',        labelSw: 'Kuoga',                icon: '🚿', period: 'morning', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'timely',      label: 'Timely preparation', labelSw: 'Kujiandaa kwa wakati', icon: '⏰', period: 'morning', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'breakfast',   label: 'Breakfast',          labelSw: 'Chai Asubuhi',         icon: '🥣', period: 'morning', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'room',        label: 'Clean room',         labelSw: 'Chumba Safi',          icon: '✨', period: 'morning', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'prayer',      label: 'Morning prayer',     labelSw: 'Sala Asubuhi',         icon: '🤲', period: 'morning', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'behavior',    label: 'Good behavior',      labelSw: 'Adabu Njema',          icon: '⭐', period: 'morning', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  // ── Evening (12) ──
  { id: 'homework',          label: 'Homework',         labelSw: 'Kazi za Shule',           icon: '📚', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'playing-outside',   label: 'Playing outside',  labelSw: 'Kucheza Nje',             icon: '🏃', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'reading',           label: 'Reading',          labelSw: 'Kusoma',                  icon: '📖', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'writing',           label: 'Writing',          labelSw: 'Kuandika',                icon: '✍️', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'home-chores',       label: "Daddy's home chores", labelSw: 'Kazi za Baba',         icon: '🧹', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'room-evening',      label: 'Clean room',       labelSw: 'Kupanga Chumba',          icon: '🛋️', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'dinner',            label: 'Dinner',           labelSw: 'Chakula Jioni',           icon: '🍽️', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'evening-prayer',    label: 'Evening prayer',   labelSw: 'Sala ya Jioni',           icon: '🕌', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'sleeping-time',     label: 'Sleeping time',    labelSw: 'Muda wa Kulala',          icon: '🌙', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'tablets',           label: 'Tablets / screens', labelSw: 'Kuangalia Movie or Games', icon: '📱', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'slippers',          label: 'Slippers',         labelSw: 'Malapa',                  icon: '🥿', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
  { id: 'behavior-evening',  label: 'Good behavior',    labelSw: 'Adabu Njema',             icon: '⭐', period: 'evening', pointsExcellent: 2, pointsGood: 1, pointsBad: 0, active: true },
];

// ── Default Point System Config ───────────────────
// Conservative defaults — Reducing is OFF until a family opts in (matches
// the encouragement-first philosophy). Kudos / Improvement Note are ON
// because they're low-stakes recognition that costs nothing if unused.
export const DEFAULT_POINT_SYSTEM: PointSystemConfig = {
  reducing: { enabled: false, max: 3 },
  kudos: { enabled: true, label: 'Kudos', threshold: 4, bonusPoints: 1, kidToKidEnabled: false, kidDailyCap: 3 },
  improvementNote: { enabled: true, label: 'Improvement Note', threshold: 4, deductionPoints: 1 },
  diamondMinPoints: 4,
  routines: { pointsPerHousePoint: 100 },
};

// Merge a family's stored partial config with the defaults. Always safe
// to call — handles missing `family`, missing `pointSystem`, partial sub-
// objects. Read-path only; writes should `updateDoc` a partial.
export function readPointSystemConfig(family: Family | null | undefined): PointSystemConfig {
  const stored = family?.pointSystem;
  if (!stored) return DEFAULT_POINT_SYSTEM;
  return {
    reducing: { ...DEFAULT_POINT_SYSTEM.reducing, ...(stored.reducing || {}) },
    kudos: { ...DEFAULT_POINT_SYSTEM.kudos, ...(stored.kudos || {}) },
    improvementNote: { ...DEFAULT_POINT_SYSTEM.improvementNote, ...(stored.improvementNote || {}) },
    diamondMinPoints: stored.diamondMinPoints ?? DEFAULT_POINT_SYSTEM.diamondMinPoints,
    routines: { ...DEFAULT_POINT_SYSTEM.routines, ...(stored.routines || {}) },
  };
}

// ── 🌟 Recognition Rounds (RR PR-1, approved v3 13-Aug-2026) ─────────
// The module is the REMINDER + pattern-keeper only: every celebration it
// triggers rides the existing award rail (giveAward side-effects — badge
// counters, points, kid 🏅 email — all fire untouched).

export interface RecognitionConfig {
  /** Master switch. Default ON — the nudge is the product. */
  active: boolean;
  /** Local weekdays the round fires (0=Sun…6=Sat). Default Tue+Fri. */
  days: number[];
  /** Local hour (0-23) the round fires at/after. Default 18. */
  hourLocal: number;
  /** Reviewer uids who receive the nudge. Empty/absent = all parents. */
  audienceUids: string[];
  /** Delivery channels. WhatsApp lands later via Neldi — seam only. */
  channels: { bell: boolean; email: boolean };
}

export const DEFAULT_RECOGNITION_CONFIG: RecognitionConfig = {
  active: true,
  days: [2, 5],
  hourLocal: 18,
  audienceUids: [],
  channels: { bell: true, email: true },
};

export function readRecognitionConfig(family: Family | null | undefined): RecognitionConfig {
  const stored = family?.recognitionConfig;
  if (!stored) return DEFAULT_RECOGNITION_CONFIG;
  return {
    ...DEFAULT_RECOGNITION_CONFIG,
    ...stored,
    channels: { ...DEFAULT_RECOGNITION_CONFIG.channels, ...(stored.channels || {}) },
  };
}

// Resolve the AwardKind for legacy docs missing the `kind` field. Order:
//   1. explicit `kind` if set
//   2. `category` prefixed with 'diamond-' → diamond (pre-AwardKind convention)
//   3. negative points → reducing
//   4. fallback regular
// Zero-point legacy docs cannot be distinguished between kudos and
// improvement_note without context, so default to regular — those legacy
// rows will simply show as 0-point regular awards, which is harmless.
export function inferAwardKind(award: Pick<Award, 'kind' | 'category' | 'points'>): AwardKind {
  if (award.kind) return award.kind;
  if (award.category?.startsWith('diamond-')) return 'diamond';
  if ((award.points ?? 0) < 0) return 'reducing';
  return 'regular';
}

// ── Default Rewards ──────────────────────────────
export const DEFAULT_REWARDS: Omit<Reward, 'id'>[] = [
  { title: 'Extra screen time (30 min)', description: 'Earn 30 minutes of extra tablet/TV time', pointsCost: 20, icon: '📱', active: true, category: 'Privileges' },
  { title: 'Choose dinner menu', description: 'Pick what the family eats for dinner', pointsCost: 30, icon: '🍕', active: true, category: 'Privileges' },
  { title: 'Stay up 30 min late', description: 'Bedtime pushed back by 30 minutes', pointsCost: 25, icon: '🌙', active: true, category: 'Privileges' },
  { title: 'Ice cream trip', description: 'Family trip to get ice cream', pointsCost: 50, icon: '🍦', active: true, category: 'Treats' },
  { title: 'New book or toy', description: 'Choose a new book or small toy', pointsCost: 100, icon: '🎁', active: true, category: 'Things' },
  { title: 'Friend sleepover', description: 'Have a friend sleep over for one night', pointsCost: 150, icon: '🏠', active: true, category: 'Experiences' },
];

// ── Badge Definitions ─────────────────────────────
export const BADGES = [
  { id: 'first-star', name: 'First Star', description: 'Earn your first points', icon: '⭐', threshold: 1 },
  { id: 'rising-star', name: 'Rising Star', description: 'Earn 50 total points', icon: '🌟', threshold: 50 },
  { id: 'superstar', name: 'Superstar', description: 'Earn 200 total points', icon: '💫', threshold: 200 },
  { id: 'streak-3', name: 'On Fire', description: '3-day perfect streak', icon: '🔥', threshold: 3 },
  { id: 'streak-7', name: 'Unstoppable', description: '7-day perfect streak', icon: '🚀', threshold: 7 },
  { id: 'streak-30', name: 'Legend', description: '30-day streak', icon: '👑', threshold: 30 },
  { id: 'helper-hero', name: 'Helper Hero', description: 'Help with 10 extra chores', icon: '🦸', threshold: 10 },
  { id: 'meeting-champ', name: 'Meeting Champion', description: 'Attend 5 family meetings', icon: '🏆', threshold: 5 },
  // CASH UPGRADE · 🔥 Saver Streak milestones — minted by SaverStreakCard
  // when the Hive save-rate streak crosses each mark.
  { id: 'saver-4', name: 'Bronze Saver', description: '4-week saver streak (≥50% saved)', icon: '🥉', threshold: 4 },
  { id: 'saver-12', name: 'Silver Saver', description: '12-week saver streak', icon: '🥈', threshold: 12 },
  { id: 'saver-26', name: 'Gold Saver', description: '26-week saver streak', icon: '🥇', threshold: 26 },
];

// ── Utility ───────────────────────────────────────
function generateInviteCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export function todayString(): string {
  return new Date().toISOString().split('T')[0];
}

// ── User Operations ───────────────────────────────
export async function createUserProfile(profile: UserProfile) {
  if (isGuestActive()) return;
  await setDoc(doc(db, 'users', profile.uid), profile);
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  if (isGuestActive()) return { uid, email: 'guest@ourkaya.com', displayName: 'Guest Visitor', role: 'parent' as Role, familyId: GUEST_FAMILY_ID } as UserProfile;
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? (snap.data() as UserProfile) : null;
}

export async function updateUserProfile(uid: string, data: Partial<UserProfile>) {
  if (isGuestActive()) return;
  await updateDoc(doc(db, 'users', uid), data);
}

// Returns all user profiles attached to a family — used to find notification
// recipients (parents + helpers) when ratings or awards are submitted.
export async function getFamilyMembers(familyId: string): Promise<UserProfile[]> {
  if (isGuestActive()) return [];
  const q = query(collection(db, 'users'), where('familyId', '==', familyId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as UserProfile);
}

// Detach a user from their family. Keeps the user account intact (so
// they can re-join with a fresh invite code or be added to a different
// family later) — just clears `familyId` and `childId`. Used from the
// Family members card in Settings when a parent wants to remove a
// helper, guest, or stale kid login.
//
// Safety: this should be gated to the calling parent's UI; the
// Firestore rules do their own enforcement (`isParentInFamily`) but
// we don't want the UI to even surface the option for non-parents.
export async function removeUserFromFamily(uid: string): Promise<void> {
  if (isGuestActive()) return;
  await updateDoc(doc(db, 'users', uid), {
    familyId: '',
    childId: null,
  });
}

// ── Family Operations ─────────────────────────────
export async function createFamily(
  name: string,
  createdBy: string,
  referralCode?: string,
): Promise<string> {
  if (isGuestActive()) return GUEST_FAMILY_ID;

  // Resolve the referrer family up-front (queries inside transactions are not
  // supported in the client SDK).
  let referrerFamilyId: string | null = null;
  if (referralCode) {
    const q = query(
      collection(db, 'families'),
      where('referralCode', '==', referralCode.toUpperCase()),
    );
    const snap = await getDocs(q);
    if (!snap.empty) referrerFamilyId = snap.docs[0].id;
  }

  // Atomic: increment global family counter, set founding-family flag, link
  // referrer (+ compound credit one level up).
  let createdFamilyId = '';
  await runTransaction(db, async (tx) => {
    // ── reads first ──
    const metaRef = doc(db, 'meta', 'global');
    const metaSnap = await tx.get(metaRef);

    let referrerData: any = null;
    let grandRefId: string | null = null;
    let grandData: any = null;
    if (referrerFamilyId) {
      const referrerSnap = await tx.get(doc(db, 'families', referrerFamilyId));
      if (referrerSnap.exists()) {
        referrerData = referrerSnap.data();
        if (referrerData.referredBy) {
          grandRefId = referrerData.referredBy as string;
          const grandSnap = await tx.get(doc(db, 'families', grandRefId));
          if (grandSnap.exists()) grandData = grandSnap.data();
        }
      } else {
        referrerFamilyId = null; // stale code; ignore
      }
    }

    // ── compute ──
    const familyCount = (metaSnap.exists() ? metaSnap.data().familyCount : 0) || 0;
    const newCount = familyCount + 1;
    const isFounding = newCount <= FOUNDING_FAMILY_LIMIT;

    // ── writes ──
    const familyRef = doc(collection(db, 'families'));
    createdFamilyId = familyRef.id;

    tx.set(familyRef, {
      name,
      createdBy,
      inviteCode: generateInviteCode(),
      // Three role-specific codes generated up-front so parents can
      // copy-share them from Settings right after onboarding. Kid +
      // Guest start inactive (parent activates right before sharing);
      // Helper starts active since it's a long-lived staff credential.
      inviteCodes: {
        kid:    { code: generateInviteCode(), active: false },
        helper: { code: generateInviteCode(), active: true },
        guest:  { code: generateInviteCode(), active: false },
      },
      referralCode: generateReferralCode(name),
      referredBy: referrerFamilyId,
      referralCount: 0,
      compoundCredit: 0,
      kayaCoins: 0,
      isFoundingFamily: isFounding,
      // 2026-05-29 — every new family lands on Free / Nest tier
      // explicitly. Founding-family crew (first 100) still gets the
      // full-access bypass via `isFoundingFamily`, so their visible
      // surface is unchanged. Anyone after that redeems a tier code
      // via /admin/tier-codes to unlock Home or Castle.
      tierId: 'nest' as const,
      // Charter serial = global join ordinal, stamped only for the
      // closed-beta crew (newCount ≤ FOUNDING_FAMILY_LIMIT) so it renders
      // as CF-### on their profile. familyCount is monotonic, so this is
      // their true join position.
      ...(isFounding ? { charterNumber: newCount } : {}),
      spotlightOptIn: false,
      pointsMode: 'full' as PointsMode,
      routines: DEFAULT_ROUTINES,
      createdAt: serverTimestamp(),
    });

    tx.set(metaRef, { familyCount: newCount }, { merge: true });

    if (referrerFamilyId && referrerData) {
      tx.update(doc(db, 'families', referrerFamilyId), {
        referralCount: (referrerData.referralCount || 0) + 1,
      });
    }
    if (grandRefId && grandData) {
      tx.update(doc(db, 'families', grandRefId), {
        compoundCredit: (grandData.compoundCredit || 0) + 1,
      });
    }
  });

  return createdFamilyId;
}

/** Seed the starter reward catalogue for a freshly-created family.
 *  Split out of createFamily so onboarding can run it AFTER the creator's
 *  parent profile exists: the rewards subcollection's create rule requires
 *  isParentInFamily(), which reads users/{uid} — false until that profile
 *  is written. Seeding inside createFamily (before the profile) is what
 *  hit "Missing or insufficient permissions" at the closed-beta "Let's Go!"
 *  (separate batch — too many writes for one transaction). */
export async function seedDefaultRewards(familyId: string): Promise<void> {
  const batch = writeBatch(db);
  DEFAULT_REWARDS.forEach((reward) => {
    const rewardRef = doc(collection(db, 'families', familyId, 'rewards'));
    batch.set(rewardRef, reward);
  });
  await batch.commit();
}

// ── Handle lookups ──────────────────────────────────────────────
// handles are stored case-preserved with a `handleLower` mirror so we can
// query case-insensitively and still display with the user's preferred case.
export async function getFamilyByHandle(handle: string): Promise<Family | null> {
  if (isGuestActive()) return null;
  if (!handle) return null;
  const q = query(
    collection(db, 'families'),
    where('handleLower', '==', handle.toLowerCase()),
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as Family;
}

export async function isHandleAvailable(
  handle: string,
  exclude?: { familyId?: string; userUid?: string; childId?: string },
): Promise<boolean> {
  if (isGuestActive()) return true;
  if (!handle) return false;
  const lower = handle.toLowerCase();
  const ex = exclude || {};

  // Every lookup below is best-effort: a permission or missing-index error
  // must NEVER block a legitimate save. The `users` collection in particular
  // has no blanket `list` rule (see firestore.rules — read is gated to
  // same-family/self), so Firestore rejects this unconstrained handle query
  // with permission-denied. We treat that the same way we treat a missing
  // index below: as "no known collision" and let the save proceed. Handle
  // uniqueness here is advisory, not a hard server-enforced guarantee.

  // Families
  try {
    const famSnap = await getDocs(
      query(collection(db, 'families'), where('handleLower', '==', lower)),
    );
    for (const d of famSnap.docs) {
      if (d.id !== ex.familyId) return false;
    }
  } catch {
    // ignore — see note above
  }

  // Users
  try {
    const userSnap = await getDocs(
      query(collection(db, 'users'), where('handleLower', '==', lower)),
    );
    for (const d of userSnap.docs) {
      if (d.id !== ex.userUid) return false;
    }
  } catch {
    // ignore — see note above
  }

  // Children — collection group query across all families.
  // Note: requires a Firestore composite index. Firebase will print a console
  // link the first time this runs; tap it to create the index.
  try {
    const kidSnap = await getDocs(
      query(collectionGroup(db, 'children'), where('handleLower', '==', lower)),
    );
    for (const d of kidSnap.docs) {
      if (d.id !== ex.childId) return false;
    }
  } catch {
    // If the composite index isn't there yet, treat as available (uniqueness
    // will be enforced once the index is created and the next save retries).
  }

  return true;
}

// Find a child whose stored email matches (case-insensitive). Used at signup
// time to auto-link a brand-new user to an existing kid profile.
export async function findChildByEmail(email: string): Promise<{ familyId: string; child: Child } | null> {
  if (isGuestActive()) return null;
  if (!email) return null;
  const lower = email.toLowerCase();
  try {
    const snap = await getDocs(
      query(collectionGroup(db, 'children'), where('emailLower', '==', lower)),
    );
    for (const d of snap.docs) {
      const data = d.data() as Child;
      if (data.loginEnabled !== true) continue;
      // d.ref.parent.parent is the family doc.
      const familyRef = d.ref.parent.parent;
      if (!familyRef) continue;
      return { familyId: familyRef.id, child: { ...data, id: d.id } as Child };
    }
  } catch {
    // No index yet → treat as no match.
  }
  return null;
}

export async function getFamilyByReferralCode(code: string): Promise<Family | null> {
  if (isGuestActive()) return null;
  if (!code) return null;
  const q = query(
    collection(db, 'families'),
    where('referralCode', '==', code.toUpperCase()),
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as Family;
}

// Families opted in to the Champion landing-page spotlight. Only shows
// families with 10+ direct referrals (Champion tier).
export async function getSpotlightFamilies(max = 6): Promise<Family[]> {
  if (isGuestActive()) return [];
  const q = query(
    collection(db, 'families'),
    where('spotlightOptIn', '==', true),
  );
  const snap = await getDocs(q);
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Family));
  return all
    .filter((f) => (f.referralCount || 0) >= 10)
    .sort((a, b) => (b.referralCount || 0) - (a.referralCount || 0))
    .slice(0, max);
}

export async function getReferredFamilies(familyId: string): Promise<Family[]> {
  if (isGuestActive()) {
    // Demo: show one referred family in guest mode so the panel feels populated.
    return [{
      ...MOCK_FAMILY,
      id: 'demo-referred',
      name: 'The Mwangi Family',
      referredBy: familyId,
    } as Family];
  }
  const q = query(collection(db, 'families'), where('referredBy', '==', familyId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Family));
}

// Lazily backfill a referralCode for a family that pre-dates the campaign.
// Safe to call repeatedly; no-op if a code already exists.
export async function ensureReferralCode(family: Family): Promise<string> {
  if (family.referralCode) return family.referralCode;
  if (isGuestActive()) return generateReferralCode(family.name);
  const code = generateReferralCode(family.name);
  await updateDoc(doc(db, 'families', family.id), { referralCode: code });
  return code;
}

export async function getFamily(familyId: string): Promise<Family | null> {
  if (isGuestActive()) return MOCK_FAMILY;
  const snap = await getDoc(doc(db, 'families', familyId));
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Family) : null;
}

export async function updateFamily(familyId: string, data: Partial<Family>) {
  if (isGuestActive()) return;
  await updateDoc(doc(db, 'families', familyId), data);
}

/** How proof-required workplan tasks award points. Defaults to 'approve'
 *  (points pending until a parent OKs the proof) when the field is
 *  absent — the safe default. 'instant' grants on submit, revocable. */
export function readWorkplanProofMode(family: Pick<Family, 'workplanProofMode'> | null | undefined): 'instant' | 'approve' {
  return family?.workplanProofMode === 'instant' ? 'instant' : 'approve';
}

// ── External contact CRUD ────────────────────────────────────────
// Operates on the `externalContacts` array on the Family doc. We
// read-modify-write because Firestore can't update individual array
// elements by id. Concurrent edits are extremely rare for a family-app
// settings page so this is fine.

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function addExternalContact(
  familyId: string,
  data: { name: string; email: string; notifyOnRating?: boolean; notifyOnAward?: boolean; addedBy: string },
): Promise<ExternalContact> {
  if (isGuestActive()) throw new Error('Guests cannot add contacts.');
  const trimmedName = data.name.trim();
  const lowerEmail = data.email.trim().toLowerCase();
  if (!trimmedName) throw new Error('Name is required.');
  if (!EMAIL_RX.test(lowerEmail)) throw new Error('Invalid email address.');
  const fam = await getFamily(familyId);
  const existing = fam?.externalContacts || [];
  // De-dup by email so the dispatcher doesn't send twice.
  if (existing.some((c) => c.email === lowerEmail)) {
    throw new Error('A contact with that email already exists.');
  }
  const contact: ExternalContact = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: trimmedName,
    email: lowerEmail,
    notifyOnRating: data.notifyOnRating !== false,
    notifyOnAward: data.notifyOnAward !== false,
    addedAt: Timestamp.now(),
    addedBy: data.addedBy,
  };
  await updateDoc(doc(db, 'families', familyId), {
    externalContacts: [...existing, contact],
  });
  return contact;
}

export async function updateExternalContact(
  familyId: string,
  contactId: string,
  patch: Partial<Pick<ExternalContact, 'name' | 'email' | 'notifyOnRating' | 'notifyOnAward'>>,
): Promise<void> {
  if (isGuestActive()) return;
  const fam = await getFamily(familyId);
  const existing = fam?.externalContacts || [];
  const next = existing.map((c) => {
    if (c.id !== contactId) return c;
    const updated: ExternalContact = { ...c };
    if (patch.name !== undefined) {
      const t = patch.name.trim();
      if (!t) throw new Error('Name is required.');
      updated.name = t;
    }
    if (patch.email !== undefined) {
      const lower = patch.email.trim().toLowerCase();
      if (!EMAIL_RX.test(lower)) throw new Error('Invalid email address.');
      if (existing.some((x) => x.id !== contactId && x.email === lower)) {
        throw new Error('Another contact already uses that email.');
      }
      updated.email = lower;
    }
    if (patch.notifyOnRating !== undefined) updated.notifyOnRating = patch.notifyOnRating;
    if (patch.notifyOnAward !== undefined) updated.notifyOnAward = patch.notifyOnAward;
    return updated;
  });
  await updateDoc(doc(db, 'families', familyId), { externalContacts: next });
}

export async function removeExternalContact(familyId: string, contactId: string): Promise<void> {
  if (isGuestActive()) return;
  const fam = await getFamily(familyId);
  const existing = fam?.externalContacts || [];
  const next = existing.filter((c) => c.id !== contactId);
  await updateDoc(doc(db, 'families', familyId), { externalContacts: next });
}

export async function findFamilyByInviteCode(code: string): Promise<Family | null> {
  if (isGuestActive()) return null;
  const q = query(collection(db, 'families'), where('inviteCode', '==', code.toUpperCase()));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as Family;
}

// Normalise a stored invite-code entry (which may be the legacy
// string shape OR the new InviteCodeState object) to the canonical
// object form. Used everywhere we read codes so the rest of the code
// only deals with one shape.
function normalizeInviteCode(
  raw: InviteCodeState | string | undefined,
  fallbackActive: boolean,
): InviteCodeState | null {
  if (!raw) return null;
  if (typeof raw === 'string') return { code: raw, active: fallbackActive };
  return raw;
}

// Lazily generate per-role invite codes for a family that pre-dates
// the lifecycle feature. Safe to call repeatedly; only writes when the
// field is missing, partial, or still in the legacy string shape.
// Returns the resolved triple of fully-normalised state objects so
// callers can render immediately without a second fetch.
export async function ensureInviteCodes(
  family: Family,
): Promise<{ kid: InviteCodeState; helper: InviteCodeState; guest: InviteCodeState }> {
  const stored = family.inviteCodes || {};
  // Defaults: kid + guest start INACTIVE (parent activates right
  // before sharing — minimises the window a leaked code is useful).
  // Helper starts ACTIVE since it's a long-lived staff credential.
  const kid    = normalizeInviteCode(stored.kid,    false) || { code: generateInviteCode(), active: false };
  const helper = normalizeInviteCode(stored.helper, true)  || { code: family.inviteCode || generateInviteCode(), active: true };
  const guest  = normalizeInviteCode(stored.guest,  false) || { code: generateInviteCode(), active: false };
  const needsWrite =
    !stored.kid || !stored.helper || !stored.guest ||
    typeof stored.kid === 'string' || typeof stored.helper === 'string' || typeof stored.guest === 'string';
  if (needsWrite && !isGuestActive()) {
    await updateDoc(doc(db, 'families', family.id), {
      inviteCodes: { kid, helper, guest },
    });
  }
  return { kid, helper, guest };
}

// Match a code against any of a family's stored codes (legacy + 3
// per-role). Returns the matched role along with the (normalised)
// state so the caller can check `active` before honouring the join.
export async function findFamilyByAnyInviteCode(
  code: string,
): Promise<{ family: Family; suggestedRole: Role; state: InviteCodeState } | { reason: 'inactive'; suggestedRole: Role } | null> {
  if (isGuestActive()) return null;
  const upper = code.toUpperCase();

  // Try the legacy single-code path first. Treated as the Helper code
  // (its original Settings labelling) and assumed active — legacy code
  // had no lifecycle. New per-role codes take precedence below.
  const legacy = await getDocs(
    query(collection(db, 'families'), where('inviteCode', '==', upper)),
  );
  if (!legacy.empty) {
    const d = legacy.docs[0];
    const fam = { id: d.id, ...d.data() } as Family;
    // If the same code is ALSO indexed under `inviteCodes.helper`
    // (e.g. after ensureInviteCodes migrated it), the per-role path
    // below will catch it with its real `active` state. Skip falling
    // through to legacy if so — covered by the for-loop's match.
    const helperState = normalizeInviteCode(fam.inviteCodes?.helper, true);
    if (!helperState || helperState.code !== upper) {
      return { family: fam, suggestedRole: 'helper', state: { code: upper, active: true } };
    }
  }

  // Then check each per-role code field. Firestore queries on nested
  // fields require either an indexed path or three small reads — three
  // reads is fine for this rate.
  for (const role of ['kid', 'helper', 'guest'] as const) {
    // Stored entries can be a string (legacy) OR { code: '...' };
    // we query both shapes by hitting the `.code` path AND the bare
    // field. Most families will be on the new shape after one Settings
    // open; legacy reads keep working until then.
    const objectQ = await getDocs(
      query(collection(db, 'families'), where(`inviteCodes.${role}.code`, '==', upper)),
    );
    const stringQ = objectQ.empty
      ? await getDocs(query(collection(db, 'families'), where(`inviteCodes.${role}`, '==', upper)))
      : null;
    const snap = !objectQ.empty ? objectQ : stringQ!;
    if (snap.empty) continue;
    const d = snap.docs[0];
    const fam = { id: d.id, ...d.data() } as Family;
    const state = normalizeInviteCode(
      fam.inviteCodes?.[role],
      role === 'helper',
    ) || { code: upper, active: false };
    if (!state.active) {
      return { reason: 'inactive', suggestedRole: role };
    }
    return { family: fam, suggestedRole: role, state };
  }
  return null;
}

// Toggle an invite code's `active` flag. Writes `activatedAt` when
// flipping on so the UI can show "Activated 5 min ago".
export async function setInviteCodeActive(
  familyId: string,
  role: 'kid' | 'helper' | 'guest',
  active: boolean,
): Promise<void> {
  if (isGuestActive()) return;
  const famSnap = await getDoc(doc(db, 'families', familyId));
  if (!famSnap.exists()) return;
  const fam = { id: famSnap.id, ...famSnap.data() } as Family;
  const codes = await ensureInviteCodes(fam);
  const next: InviteCodeState = {
    ...codes[role],
    active,
    ...(active ? { activatedAt: Timestamp.now() } : {}),
  };
  await updateDoc(doc(db, 'families', familyId), {
    [`inviteCodes.${role}`]: next,
  });
}

// Mint a fresh code for one role + flip it inactive (parent will
// re-activate before sharing). Use when a code may be leaked, or to
// rotate routinely.
export async function regenerateInviteCode(
  familyId: string,
  role: 'kid' | 'helper' | 'guest',
): Promise<string> {
  if (isGuestActive()) return 'GUEST-NOOP';
  const newCode = generateInviteCode();
  await updateDoc(doc(db, 'families', familyId), {
    [`inviteCodes.${role}`]: { code: newCode, active: false },
  });
  return newCode;
}

// Mark a code as consumed by a successful join: stamps `usedAt` and
// auto-flips `active` to false (single-use safety). Called from the
// onboarding success path.
export async function markInviteCodeUsed(
  familyId: string,
  role: 'kid' | 'helper' | 'guest',
): Promise<void> {
  if (isGuestActive()) return;
  const famSnap = await getDoc(doc(db, 'families', familyId));
  if (!famSnap.exists()) return;
  const fam = { id: famSnap.id, ...famSnap.data() } as Family;
  const codes = await ensureInviteCodes(fam);
  const next: InviteCodeState = {
    ...codes[role],
    active: false,
    usedAt: Timestamp.now(),
  };
  await updateDoc(doc(db, 'families', familyId), {
    [`inviteCodes.${role}`]: next,
  });
}

// ── Children Operations ───────────────────────────
export async function addChild(familyId: string, child: Omit<Child, 'id'>): Promise<string> {
  if (isGuestActive()) return 'guest-child';
  const ref = await addDoc(collection(db, 'families', familyId, 'children'), child);
  return ref.id;
}

export async function getChildren(familyId: string): Promise<Child[]> {
  if (isGuestActive()) return MOCK_CHILDREN;
  const snap = await getDocs(collection(db, 'families', familyId, 'children'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Child));
}

export async function updateChild(familyId: string, childId: string, data: Partial<Child>) {
  if (isGuestActive()) return;
  await updateDoc(doc(db, 'families', familyId, 'children', childId), data);
}

// ── Wishlist (per-child subcollection) ───────────
export async function getWishlist(familyId: string, childId: string): Promise<WishlistItem[]> {
  if (isGuestActive()) return [];
  const snap = await getDocs(
    query(
      collection(db, 'families', familyId, 'children', childId, 'wishlist'),
      orderBy('createdAt', 'desc'),
    ),
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as WishlistItem));
}

export async function addWishlistItem(
  familyId: string,
  childId: string,
  item: Omit<WishlistItem, 'id' | 'createdAt' | 'achieved' | 'achievedAt'>,
): Promise<string> {
  if (isGuestActive()) return 'guest-wish';
  const ref = await addDoc(
    collection(db, 'families', familyId, 'children', childId, 'wishlist'),
    { ...item, achieved: false, createdAt: serverTimestamp() },
  );
  return ref.id;
}

export async function updateWishlistItem(
  familyId: string,
  childId: string,
  itemId: string,
  data: Partial<WishlistItem>,
) {
  if (isGuestActive()) return;
  const patch: any = { ...data };
  if (data.achieved && !data.achievedAt) patch.achievedAt = serverTimestamp();
  await updateDoc(
    doc(db, 'families', familyId, 'children', childId, 'wishlist', itemId),
    patch,
  );
}

export async function deleteWishlistItem(familyId: string, childId: string, itemId: string) {
  if (isGuestActive()) return;
  await deleteDoc(doc(db, 'families', familyId, 'children', childId, 'wishlist', itemId));
}

export function subscribeToChildren(familyId: string, callback: (children: Child[]) => void) {
  if (isGuestActive()) {
    callback(MOCK_CHILDREN);
    return () => {};
  }
  return onSnapshot(collection(db, 'families', familyId, 'children'), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Child)));
  });
}

// Real-time subscription to the family doc itself. Used so toggles like
// `allowGenderOther` / `earningMethods` / `anniversary` reflect their new
// value the instant Firestore confirms the write — without it, callers
// would read a stale value of `family.X` until the next page load.
export function subscribeToFamily(familyId: string, callback: (family: Family | null) => void) {
  if (isGuestActive()) {
    callback(MOCK_FAMILY);
    return () => {};
  }
  return onSnapshot(doc(db, 'families', familyId), (snap) => {
    callback(snap.exists() ? ({ id: snap.id, ...snap.data() } as Family) : null);
  });
}

// ── Rating Operations ─────────────────────────────
// Routine ratings credit `routinePoints` (a fine-grained accumulator)
// rather than `totalPoints` directly. The family-configured conversion
// rate (default 100 RP → 1 HP) folds them into house points once the
// threshold is reached. Mirrors the kudos / improvement-note pattern.
//
// Pre-2026-05-16 behaviour credited `totalPoints` directly — that's fine
// for legacy data; new writes go through the accumulator.

// Shared helper — given a child's pre-update state and the routine points
// from this rating, returns the updates to apply (routinePoints,
// totalPoints, weeklyPoints) such that every full block of
// `pointsPerHousePoint` routine points converts to 1 house point.
// `creditWeekly` controls whether the converted house points should also
// hit weeklyPoints (true for live ratings; false for historical imports
// dated outside the current week).
function computeRoutineRatingUpdates(
  child: Child,
  earned: number,
  pointsPerHousePoint: number,
  creditWeekly: boolean,
): Record<string, unknown> {
  const ppHP = Math.max(1, pointsPerHousePoint);
  const current = child.routinePoints || 0;
  const next = current + earned;
  const housePointsGained = Math.floor(next / ppHP);
  const carryover = next - housePointsGained * ppHP;
  const updates: Record<string, unknown> = { routinePoints: carryover };
  if (housePointsGained > 0) {
    updates.totalPoints = (child.totalPoints || 0) + housePointsGained;
    if (creditWeekly) updates.weeklyPoints = (child.weeklyPoints || 0) + housePointsGained;
  }
  return updates;
}

export async function submitRating(familyId: string, rating: Omit<DailyRating, 'id'>) {
  if (isGuestActive()) return 'guest-rating';
  // Strip undefined fields — Firestore rejects them, and `comment` is optional.
  const payload: Record<string, unknown> = { ...rating, createdAt: serverTimestamp() };
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
  const ref = await addDoc(collection(db, 'families', familyId, 'ratings'), payload);

  // Credit routinePoints; the conversion rule folds them into totalPoints
  // every `pointsPerHousePoint` worth of routine points.
  const family = await getFamily(familyId);
  const cfg = readPointSystemConfig(family);
  const childRef = doc(db, 'families', familyId, 'children', rating.childId);
  const childSnap = await getDoc(childRef);
  if (childSnap.exists()) {
    const child = childSnap.data() as Child;
    const updates = computeRoutineRatingUpdates(
      child,
      rating.totalPoints,
      cfg.routines.pointsPerHousePoint,
      true,
    );
    await updateDoc(childRef, updates);
  }

  return ref.id;
}

// Historical import path — used by the one-time Google-Sheet importer.
// Behaviour differs from submitRating in two ways:
//   1. If a rating doc already exists for (childId, date, period), we
//      replace it instead of stacking duplicates — re-running the import
//      is idempotent.
//   2. We only credit weeklyPoints when the row's `date` falls in the
//      current ISO week, so importing last month's data doesn't inflate
//      this week's leaderboard.
// The function returns { id, action } where action is 'created' or
// 'replaced' for the caller's preview/summary.
export async function importRating(
  familyId: string,
  rating: Omit<DailyRating, 'id'>,
): Promise<{ id: string; action: 'created' | 'replaced' }> {
  if (isGuestActive()) return { id: 'guest-import', action: 'created' };
  const payload: Record<string, unknown> = { ...rating, createdAt: serverTimestamp() };
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  // Look for an existing rating with the same key triple.
  const existingQ = query(
    collection(db, 'families', familyId, 'ratings'),
    where('childId', '==', rating.childId),
    where('date', '==', rating.date),
    where('period', '==', rating.period),
  );
  const existingSnap = await getDocs(existingQ);
  const prior = existingSnap.empty ? null : existingSnap.docs[0];
  const priorPoints = prior ? (prior.data() as DailyRating).totalPoints || 0 : 0;
  const delta = rating.totalPoints - priorPoints;

  let id: string;
  let action: 'created' | 'replaced';
  if (prior) {
    await setDoc(prior.ref, payload, { merge: false });
    id = prior.id;
    action = 'replaced';
  } else {
    const ref = await addDoc(collection(db, 'families', familyId, 'ratings'), payload);
    id = ref.id;
    action = 'created';
  }

  // Apply the delta through the routine-points accumulator so historical
  // imports respect the same conversion rate. Weekly only credits if the
  // date is within the current week (a 6-month backfill shouldn't inflate
  // this week's leaderboard).
  const childRef = doc(db, 'families', familyId, 'children', rating.childId);
  const childSnap = await getDoc(childRef);
  if (childSnap.exists()) {
    const child = childSnap.data() as Child;
    const family = await getFamily(familyId);
    const cfg = readPointSystemConfig(family);
    const inThisWeek = isInCurrentWeek(rating.date);
    if (delta !== 0) {
      const updates = computeRoutineRatingUpdates(
        child,
        delta,
        cfg.routines.pointsPerHousePoint,
        inThisWeek,
      );
      await updateDoc(childRef, updates);
    }
  }
  return { id, action };
}

function isInCurrentWeek(dateStr: string): boolean {
  // Monday-start ISO week. Returns true if `dateStr` (YYYY-MM-DD) is in
  // the same week as today, in the local timezone (so it lines up with
  // the kid-facing week boundary).
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  const startOfWeek = (x: Date) => {
    const c = new Date(x);
    const dow = (c.getDay() + 6) % 7; // 0 = Monday
    c.setHours(0, 0, 0, 0);
    c.setDate(c.getDate() - dow);
    return c;
  };
  const a = startOfWeek(d).getTime();
  const b = startOfWeek(today).getTime();
  return a === b;
}

export async function getTodayRatings(familyId: string, childId: string, period: string): Promise<DailyRating | null> {
  if (isGuestActive()) return MOCK_RATINGS.find(r => r.childId === childId && r.period === period && r.date === todayString()) || null;
  const today = todayString();
  const q = query(
    collection(db, 'families', familyId, 'ratings'),
    where('childId', '==', childId),
    where('date', '==', today),
    where('period', '==', period)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as DailyRating;
}

// Same as getTodayRatings but for any YYYY-MM-DD — powers the date stepper on
// /rate so parents can step back and see a past day's ratings (read-only).
export async function getRatingsByDate(familyId: string, childId: string, period: string, date: string): Promise<DailyRating | null> {
  if (isGuestActive()) return MOCK_RATINGS.find(r => r.childId === childId && r.period === period && r.date === date) || null;
  const q = query(
    collection(db, 'families', familyId, 'ratings'),
    where('childId', '==', childId),
    where('date', '==', date),
    where('period', '==', period)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as DailyRating;
}

export async function getRecentRatings(familyId: string, days: number = 7): Promise<DailyRating[]> {
  if (isGuestActive()) return MOCK_RATINGS;
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];

  const q = query(
    collection(db, 'families', familyId, 'ratings'),
    where('date', '>=', sinceStr),
    orderBy('date', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as DailyRating));
}

// Inclusive YYYY-MM-DD range query for DailyRating docs. Used by the
// Family Meeting presenter to fetch every rating between two dates.
export async function getRatingsInDateRange(
  familyId: string,
  fromDate: string,
  toDate: string,
): Promise<DailyRating[]> {
  if (isGuestActive()) {
    return MOCK_RATINGS.filter((r) => r.date >= fromDate && r.date <= toDate);
  }
  const q = query(
    collection(db, 'families', familyId, 'ratings'),
    where('date', '>=', fromDate),
    where('date', '<=', toDate),
    orderBy('date', 'desc'),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as DailyRating));
}

// ── Award Operations ──────────────────────────────
// Result shape — when the threshold accumulator fires a derived bonus or
// deduction, the caller learns the derived award's id so the UI can
// reference both ("You earned a +1 from 4 Kudos!" toast, etc.).
export interface GiveAwardResult {
  id: string;
  derivedAwardId?: string;
  derivedKind?: AwardKind;
  derivedPoints?: number;
}

/** 📬 KID PR2 — ping the reward-email route (fire-and-forget). The route
 *  re-derives the words from the award DOC and only sends when the parent
 *  armed the 🏅 stream; a failure here never touches the award (D4). */
function pingKidRewardEmail(childId: string, awardId: string) {
  import('./firebase').then(async ({ auth }) => {
    const token = await auth.currentUser?.getIdToken();
    if (!token) return;
    void fetch('/api/kids/reward-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ childId, awardId }),
    }).catch(() => {});
  }).catch(() => {});
}

// 🏅 BDG PR3 — bump one or more badge counters on a kid. Fire-and-forget:
// a failed tally must never break the flow that earned it (an award still
// lands, a task still ticks). Parents/helpers can write child docs; kid-side
// flows bump through their own Admin route instead.
export async function bumpBadgeCounters(
  familyId: string,
  childId: string,
  deltas: Record<string, number>,
): Promise<void> {
  if (isGuestActive()) return;
  const patch: Record<string, unknown> = {};
  for (const [key, n] of Object.entries(deltas)) {
    if (!key || !Number.isFinite(n) || n === 0) continue;
    patch[`badgeCounters.${key}`] = increment(n);
  }
  if (Object.keys(patch).length === 0) return;
  try {
    await updateDoc(doc(db, 'families', familyId, 'children', childId), patch);
  } catch { /* tallies are best-effort */ }
}

/** The counter keys one award should bump — kept next to `inferAwardKind`
 *  so the award vocabulary and the badge vocabulary can't drift. */
function awardCounterDeltas(award: { kind?: AwardKind; category?: string; points?: number }): Record<string, number> {
  const out: Record<string, number> = {};
  const cat = (award.category || '').trim();
  if (cat) out[`award_${cat}`] = 1;
  const isDiamond = award.kind === 'diamond' || cat.startsWith('diamond-');
  if (isDiamond) out.diamonds = 1;
  if (cat === 'workplan') out.workplan_done = 1;
  return out;
}

export async function giveAward(
  familyId: string,
  award: Omit<Award, 'id' | 'createdAt'>,
): Promise<GiveAwardResult> {
  if (isGuestActive()) return { id: 'guest-award' };

  // Strip undefined optional fields — Firestore rejects them.
  const payload: Record<string, unknown> = { ...award, createdAt: serverTimestamp() };
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  const ref = await addDoc(collection(db, 'families', familyId, 'awards'), payload);

  const childRef = doc(db, 'families', familyId, 'children', award.childId);
  const childSnap = await getDoc(childRef);
  if (!childSnap.exists()) return { id: ref.id };
  const child = childSnap.data() as Child;

  // 🏅 Badge tallies — positive award kinds only. Nothing a kid did wrong
  // ever counts toward a badge, so `reducing` / `improvement_note` skip it.
  if (award.kind !== 'reducing' && award.kind !== 'improvement_note') {
    void bumpBadgeCounters(familyId, award.childId, awardCounterDeltas(award));
  }

  // Point-bearing kinds update running totals directly. Negative `points`
  // for `reducing` just flows through the same math.
  if (award.kind === 'regular' || award.kind === 'diamond' || award.kind === 'reducing') {
    await updateDoc(childRef, {
      totalPoints: (child.totalPoints || 0) + award.points,
      weeklyPoints: (child.weeklyPoints || 0) + award.points,
      // BDG PR2 (B5) — lifetime EARNED points (positive deltas only): the
      // badge yardstick that spending can never shrink. Backfilled lazily
      // from the larger of the stored value / current balance.
      ...(award.points > 0 ? { lifetimePoints: Math.max(child.lifetimePoints || 0, child.totalPoints || 0) + award.points } : {}),
    });
    if (award.points > 0) pingKidRewardEmail(award.childId, ref.id);
    return { id: ref.id };
  }

  // Zero-point kinds: increment the accumulator, and if the threshold is
  // reached, fire a derived award + decrement the counter by the threshold.
  if (award.kind === 'kudos' || award.kind === 'improvement_note') {
    if (award.kind === 'kudos') pingKidRewardEmail(award.childId, ref.id);
    const family = await getFamily(familyId);
    const config = readPointSystemConfig(family);
    const isKudos = award.kind === 'kudos';
    const counterField = isKudos ? 'kudosCount' : 'improvementNoteCount';
    const setting = isKudos ? config.kudos : config.improvementNote;
    const currentCount = ((child as unknown as Record<string, unknown>)[counterField] as number) || 0;
    const newCount = currentCount + 1;

    // If the family has disabled this kind, just store the event silently —
    // no counter advance, no derived award. The raw award stays in history
    // so re-enabling later doesn't lose the record.
    if (!setting.enabled) {
      return { id: ref.id };
    }

    // Threshold not yet reached — just bump the counter.
    if (newCount < setting.threshold) {
      await updateDoc(childRef, { [counterField]: newCount });
      return { id: ref.id };
    }

    // Threshold reached. Compute the derived award.
    //   Kudos      → +bonusPoints as a 'regular' award.
    //   Improvement → −deductionPoints as a 'reducing' award, but only
    //                 if reducing is enabled family-wide. If reducing is
    //                 off, the counter still advances (so parents can see
    //                 it in setup), but no point penalty is applied.
    const willFireDerived = isKudos || (config.reducing.enabled && !isKudos);
    if (!willFireDerived) {
      // Counter rolled over but reducing is off — reset modulo, no points.
      await updateDoc(childRef, { [counterField]: newCount - setting.threshold });
      return { id: ref.id };
    }

    const derivedKind: AwardKind = isKudos ? 'regular' : 'reducing';
    const derivedPoints = isKudos
      ? config.kudos.bonusPoints
      : -config.improvementNote.deductionPoints;

    const derivedRef = await addDoc(collection(db, 'families', familyId, 'awards'), {
      childId: award.childId,
      kind: derivedKind,
      points: derivedPoints,
      reason: `Auto: ${setting.threshold}× ${setting.label} reached`,
      category: 'other',
      awardedBy: 'system',
      awardedByName: 'Kaya',
      derivedFrom: { kind: award.kind, sourceAwardIds: [ref.id] },
      createdAt: serverTimestamp(),
    });

    await updateDoc(childRef, {
      [counterField]: newCount - setting.threshold,
      totalPoints: (child.totalPoints || 0) + derivedPoints,
      weeklyPoints: (child.weeklyPoints || 0) + derivedPoints,
      ...(derivedPoints > 0 ? { lifetimePoints: Math.max(child.lifetimePoints || 0, child.totalPoints || 0) + derivedPoints } : {}),
    });
    if (derivedPoints > 0) pingKidRewardEmail(award.childId, derivedRef.id);

    return {
      id: ref.id,
      derivedAwardId: derivedRef.id,
      derivedKind,
      derivedPoints,
    };
  }

  // Unknown kind — write but don't touch counters. Defensive.
  return { id: ref.id };
}

// Kid → kid appreciation note. Wraps `giveAward` with a kudos payload
// and an app-layer rate-limit so a kid can't spam siblings. The Firestore
// rule allows the underlying create as long as senderRole === 'kid' and
// the family has `kudos.kidToKidEnabled` on — but the rule doesn't enforce
// the daily cap (would require a counter doc + composite index just for
// rate-limiting). Trust-but-check here is fine: a kid client tampering
// past the cap would still be visible to parents in the activity feed.
//
// Throws on:
//   - Feature disabled at the family level
//   - Daily cap reached
//   - Self-kudos (recipient == sender)
//   - Missing sender child doc
export async function sendKidKudos(
  familyId: string,
  senderChildId: string,
  senderUid: string,
  senderName: string,
  recipientChildId: string,
  reason: string,
  category: string,
): Promise<GiveAwardResult> {
  if (senderChildId === recipientChildId) {
    throw new Error("You can't send appreciation to yourself.");
  }

  const family = await getFamily(familyId);
  const config = readPointSystemConfig(family);
  if (!config.kudos.kidToKidEnabled) {
    throw new Error('Kid appreciation notes are not enabled for this family.');
  }
  const cap = config.kudos.kidDailyCap ?? 3;

  const senderRef = doc(db, 'families', familyId, 'children', senderChildId);
  const senderSnap = await getDoc(senderRef);
  if (!senderSnap.exists()) {
    throw new Error('Sender profile not found.');
  }
  const sender = senderSnap.data() as Child;

  const today = new Date().toISOString().slice(0, 10);
  const sameDay = sender.dailyKudosSentDate === today;
  const todayCount = sameDay ? (sender.dailyKudosSentCount ?? 0) : 0;
  if (todayCount >= cap) {
    throw new Error(
      `You've already sent ${cap} appreciation${cap === 1 ? '' : 's'} today. Try again tomorrow!`
    );
  }

  const result = await giveAward(familyId, {
    childId: recipientChildId,
    kind: 'kudos',
    points: 0,
    reason,
    category,
    awardedBy: senderUid,
    awardedByName: senderName,
    senderRole: 'kid',
  });

  // Bump the sender's per-day counter. Reset implicitly: writing today's
  // date overwrites yesterday's, and the count starts at todayCount + 1
  // (which is 1 on the first send of a new day).
  await updateDoc(senderRef, {
    dailyKudosSentDate: today,
    dailyKudosSentCount: todayCount + 1,
  });

  return result;
}

// Historical import path — used by the one-time Excel/Sheet importer in
// Phase 2. Differs from `giveAward` in two ways:
//   1. Caller supplies an explicit `createdAt` (so awards land at the
//      event's actual date, not `now()`).
//   2. `weeklyPoints` is only credited when `createdAt` falls in the
//      current ISO week — back-filling six months of history shouldn't
//      inflate this week's leaderboard.
// The threshold accumulator still runs (chronological replay matches the
// design intent), so importing 8 Kudos with threshold=4 fires 2 derived
// bonuses backdated to the relevant source events. Callers must import in
// chronological order for the replay to be accurate.
export async function importAward(
  familyId: string,
  award: Omit<Award, 'id'> & { createdAt: Timestamp },
): Promise<GiveAwardResult> {
  if (isGuestActive()) return { id: 'guest-import-award' };

  const payload: Record<string, unknown> = { ...award };
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
  const ref = await addDoc(collection(db, 'families', familyId, 'awards'), payload);

  const childRef = doc(db, 'families', familyId, 'children', award.childId);
  const childSnap = await getDoc(childRef);
  if (!childSnap.exists()) return { id: ref.id };
  const child = childSnap.data() as Child;

  const eventDateStr = award.createdAt.toDate().toISOString().slice(0, 10);
  const creditWeekly = isInCurrentWeek(eventDateStr);

  if (award.kind === 'regular' || award.kind === 'diamond' || award.kind === 'reducing') {
    await updateDoc(childRef, {
      totalPoints: (child.totalPoints || 0) + award.points,
      ...(creditWeekly ? { weeklyPoints: (child.weeklyPoints || 0) + award.points } : {}),
      ...(award.points > 0 ? { lifetimePoints: Math.max(child.lifetimePoints || 0, child.totalPoints || 0) + award.points } : {}),
    });
    return { id: ref.id };
  }

  if (award.kind === 'kudos' || award.kind === 'improvement_note') {
    const family = await getFamily(familyId);
    const config = readPointSystemConfig(family);
    const isKudos = award.kind === 'kudos';
    const counterField = isKudos ? 'kudosCount' : 'improvementNoteCount';
    const setting = isKudos ? config.kudos : config.improvementNote;
    const currentCount = ((child as unknown as Record<string, unknown>)[counterField] as number) || 0;
    const newCount = currentCount + 1;

    if (!setting.enabled) return { id: ref.id };

    if (newCount < setting.threshold) {
      await updateDoc(childRef, { [counterField]: newCount });
      return { id: ref.id };
    }

    const willFireDerived = isKudos || (config.reducing.enabled && !isKudos);
    if (!willFireDerived) {
      await updateDoc(childRef, { [counterField]: newCount - setting.threshold });
      return { id: ref.id };
    }

    const derivedKind: AwardKind = isKudos ? 'regular' : 'reducing';
    const derivedPoints = isKudos
      ? config.kudos.bonusPoints
      : -config.improvementNote.deductionPoints;

    const derivedRef = await addDoc(collection(db, 'families', familyId, 'awards'), {
      childId: award.childId,
      kind: derivedKind,
      points: derivedPoints,
      reason: `Auto: ${setting.threshold}× ${setting.label} reached`,
      category: 'other',
      awardedBy: 'system',
      awardedByName: 'Kaya',
      derivedFrom: { kind: award.kind, sourceAwardIds: [ref.id] },
      importSource: award.importSource,
      // Backdate the derived award to the source's date so the timeline
      // reads correctly when scrolled.
      createdAt: award.createdAt,
    });

    await updateDoc(childRef, {
      [counterField]: newCount - setting.threshold,
      totalPoints: (child.totalPoints || 0) + derivedPoints,
      ...(creditWeekly ? { weeklyPoints: (child.weeklyPoints || 0) + derivedPoints } : {}),
      ...(derivedPoints > 0 ? { lifetimePoints: Math.max(child.lifetimePoints || 0, child.totalPoints || 0) + derivedPoints } : {}),
    });

    return { id: ref.id, derivedAwardId: derivedRef.id, derivedKind, derivedPoints };
  }

  return { id: ref.id };
}

export async function getRecentAwards(familyId: string, days: number = 7): Promise<Award[]> {
  if (isGuestActive()) return MOCK_AWARDS;
  // Filter by `createdAt >= (today - days)` so callers asking for the
  // last 30 days see the full set, not just the freshest 20. For
  // "lifetime" callers pass a very large number (e.g. 9999) — there's
  // no special-case path because Firestore's `>=` against an old date
  // returns everything cheaply.
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceTs = Timestamp.fromDate(since);
  const q = query(
    collection(db, 'families', familyId, 'awards'),
    where('createdAt', '>=', sinceTs),
    orderBy('createdAt', 'desc'),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Award));
}

// Inclusive YYYY-MM-DD range query over `createdAt` for Award docs.
// Used by the Family Meeting presenter to sum award points in a window.
export async function getAwardsInDateRange(
  familyId: string,
  fromDate: string,
  toDate: string,
): Promise<Award[]> {
  const fromTs = Timestamp.fromDate(new Date(`${fromDate}T00:00:00.000Z`));
  const toTs = Timestamp.fromDate(new Date(`${toDate}T23:59:59.999Z`));
  if (isGuestActive()) {
    return MOCK_AWARDS.filter((a) => {
      const ms = a.createdAt?.toMillis?.();
      if (typeof ms !== 'number') return false;
      return ms >= fromTs.toMillis() && ms <= toTs.toMillis();
    });
  }
  const q = query(
    collection(db, 'families', familyId, 'awards'),
    where('createdAt', '>=', fromTs),
    where('createdAt', '<=', toTs),
    orderBy('createdAt', 'desc'),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Award));
}

// ── Meeting Operations ────────────────────────────
export async function createMeeting(familyId: string, meeting: Omit<Meeting, 'id'>) {
  if (isGuestActive()) return { id: 'guest-meeting' } as any;
  return addDoc(collection(db, 'families', familyId, 'meetings'), {
    ...meeting,
    createdAt: serverTimestamp(),
  });
}

/** Save tonight's WEEKLY meeting idempotently — one doc per family per day,
 *  id `weekly-<date>`. Root cause fixed 2026-08-02 (Elia): "tap Finish
 *  again" after a partial failure — and re-running the presenter the same
 *  evening — used to `addDoc` a brand-new record each time, leaving two
 *  (sometimes four) meetings in the submissions list for one night. Now the
 *  last finish of the day WINS by overwriting the same doc. Historic
 *  random-id docs are untouched (all reads are id-agnostic). */
// Meeting-finish gateway (2026-08-09): rules allow family members to
// CREATE meetings but not UPDATE them — and the idempotent weekly-<date>
// id makes every retry an update. Both writers below go through the
// token-verified /api/meetings/finish Admin route; if the route is
// unavailable (local dev without admin creds) they fall back to the
// direct client write, which still covers the first-create case.
async function meetingFinishApi(body: Record<string, unknown>): Promise<boolean> {
  try {
    const token = await fbAuth.currentUser?.getIdToken();
    if (!token) return false;
    const res = await fetch('/api/meetings/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function upsertWeeklyMeeting(familyId: string, meeting: Omit<Meeting, 'id'>) {
  if (isGuestActive()) return { id: 'guest-meeting' } as any;
  const id = `weekly-${meeting.date}`;
  const ref = doc(db, 'families', familyId, 'meetings', id);
  // Strip undefined the way the API's JSON round-trip would — the direct
  // fallback write shares the exact same payload semantics.
  const payload = JSON.parse(JSON.stringify(meeting)) as Record<string, unknown>;
  if (await meetingFinishApi({ action: 'upsert', familyId, meeting: payload })) return ref;
  await setDoc(ref, { ...payload, createdAt: serverTimestamp() });
  return ref;
}

/** Patch fields on an existing meeting. Used by the presenter's Goals
 *  Review step to retroactively mark older meetings' goals as done
 *  (writing back to each meeting's `goalsDone` map). Guest is a no-op. */
export async function updateMeeting(
  familyId: string,
  meetingId: string,
  updates: Partial<Omit<Meeting, 'id' | 'createdAt'>>,
) {
  if (isGuestActive()) return;
  const payload = JSON.parse(JSON.stringify(updates)) as Record<string, unknown>;
  if (await meetingFinishApi({ action: 'patch', familyId, meetingId, updates: payload })) return;
  await updateDoc(doc(db, 'families', familyId, 'meetings', meetingId), updates as any);
}

/** Single meeting by id — the Meeting Notes page (2026-06-21). */
export async function getMeeting(familyId: string, meetingId: string): Promise<Meeting | null> {
  if (isGuestActive()) return null;
  const snap = await getDoc(doc(db, 'families', familyId, 'meetings', meetingId));
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Meeting) : null;
}

export async function getMeetings(familyId: string, max = 20): Promise<Meeting[]> {
  if (isGuestActive()) return [];
  const q = query(
    collection(db, 'families', familyId, 'meetings'),
    orderBy('createdAt', 'desc'),
    limit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Meeting));
}

/** Extended meeting fetch for the Highlights analytics tab (2026-07-05).
 *  The hub list caps at 20, but the year/month streak filters need the
 *  full archive — ~6 years of weekly meetings fits the 300 cap. One-shot
 *  read, loaded only when the Highlights tab mounts. */
export async function getAllMeetings(familyId: string, max = 300): Promise<Meeting[]> {
  if (isGuestActive()) return [];
  const q = query(
    collection(db, 'families', familyId, 'meetings'),
    orderBy('createdAt', 'desc'),
    limit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Meeting));
}

// ── Rewards Operations ────────────────────────────
export async function getRewards(familyId: string): Promise<Reward[]> {
  if (isGuestActive()) return MOCK_REWARDS;
  const snap = await getDocs(collection(db, 'families', familyId, 'rewards'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Reward));
}

export async function addReward(familyId: string, reward: Omit<Reward, 'id'>) {
  if (isGuestActive()) return { id: 'guest-reward' } as any;
  return addDoc(collection(db, 'families', familyId, 'rewards'), reward);
}

export async function updateReward(familyId: string, rewardId: string, patch: Partial<Omit<Reward, 'id'>>) {
  if (isGuestActive()) return;
  await updateDoc(doc(db, 'families', familyId, 'rewards', rewardId), patch);
}

export async function deleteReward(familyId: string, rewardId: string) {
  if (isGuestActive()) return;
  await deleteDoc(doc(db, 'families', familyId, 'rewards', rewardId));
}

// Batch-add multiple rewards in one Firestore round-trip. Used by the
// library picker so importing 30 items doesn't take 30 separate writes.
// Each item is added active=true unless the caller overrides.
export async function addRewardsBatch(familyId: string, rewards: Omit<Reward, 'id'>[]) {
  if (isGuestActive()) return 0;
  if (rewards.length === 0) return 0;
  const batch = writeBatch(db);
  const col = collection(db, 'families', familyId, 'rewards');
  for (const r of rewards) {
    batch.set(doc(col), r);
  }
  await batch.commit();
  return rewards.length;
}

// Recent redemptions for the family, newest first. `limitCount` caps the
// pull so the parent rewards page can show a compact history without
// dragging the whole subcollection over the wire.
export async function getRedemptions(familyId: string, limitCount = 25): Promise<Redemption[]> {
  if (isGuestActive()) return [];
  const q = query(
    collection(db, 'families', familyId, 'redemptions'),
    orderBy('createdAt', 'desc'),
    limit(limitCount),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Redemption));
}

// RWD PR1 — the old redeemReward (non-transactional, desynced the Hive
// wallet, no history status) is RETIRED. All redemptions now run through
// parentRedeemReward / requestRewardRedeem + resolveApprovalRequest in
// lib/hive.ts — one transaction: points + wallet + 📜 statement + history.

// ── Notification Operations ───────────────────────
export async function createNotification(familyId: string, notification: Omit<Notification, 'id'>) {
  if (isGuestActive()) return { id: 'guest-notif' } as any;
  return addDoc(collection(db, 'families', familyId, 'notifications'), {
    ...notification,
    createdAt: serverTimestamp(),
  });
}

export async function getNotifications(familyId: string, userId: string): Promise<Notification[]> {
  if (isGuestActive()) return [];
  const q = query(
    collection(db, 'families', familyId, 'notifications'),
    where('forUserId', '==', userId),
    orderBy('createdAt', 'desc'),
    limit(30)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Notification));
}

export async function markNotificationRead(familyId: string, notificationId: string) {
  if (isGuestActive()) return;
  await updateDoc(doc(db, 'families', familyId, 'notifications', notificationId), { read: true });
}

/** Live unread-count subscription used by the AppShell bell badge.
 *  (2026-05-19) Reuses the same (forUserId ASC, createdAt DESC) index
 *  as `getNotifications` — no additional index required. Counts unread
 *  client-side over the last 30 notifications, which is the same window
 *  the bell page renders, so the badge can't drift from what the user
 *  actually sees when they open it. Returns an unsubscribe. */
export function subscribeToUnreadNotificationCount(
  familyId: string,
  userId: string,
  cb: (count: number) => void,
): () => void {
  if (isGuestActive() || !familyId || !userId) {
    cb(0);
    return () => {};
  }
  const q = query(
    collection(db, 'families', familyId, 'notifications'),
    where('forUserId', '==', userId),
    orderBy('createdAt', 'desc'),
    limit(30),
  );
  return onSnapshot(
    q,
    (snap) => {
      let n = 0;
      snap.forEach((d) => { if (!(d.data() as Notification).read) n += 1; });
      cb(n);
    },
    () => cb(0), // on error, hide the badge rather than show a stale count
  );
}
