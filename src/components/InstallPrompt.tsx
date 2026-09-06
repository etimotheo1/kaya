'use client';

// InstallPrompt — first-run "add Kaya to your home screen" interstitial.
//
// Goal: a first-time MOBILE visitor is greeted (once) with a prominent,
// app-like install screen so Kaya lives on their home screen and runs
// full-screen — desktop is never touched.
//
// Platform reality this encodes:
//   • Android/Chrome → real one-tap install via the `beforeinstallprompt`
//     event (captured at module load so we don't miss an early fire).
//   • iOS/Safari → Apple exposes NO install API, so we show the exact
//     Share → "Add to Home Screen" steps with a pointer to Safari's
//     share button. We cannot trigger it for them.
//
// "Don't nag" detection (the part Elia asked to confirm):
//   1. Running inside the installed app  → `display-mode: standalone`
//      (+ iOS `navigator.standalone`). Rock-solid on every platform — the
//      prompt is simply never rendered. This is the case that matters:
//      once installed they open via the icon, which IS standalone.
//   2. The first time we EVER see standalone we set a permanent
//      `installed` flag, so even a later browser-tab visit stays quiet.
//   3. Dismissing sets a 7-day cooldown so it never reappears every load.
//   Honest gap: an iOS Safari tab cannot know an installed copy exists
//   elsewhere (Apple gives no API, and the tab's storage isn't shared with
//   the installed app) — the cooldown covers repeat visits in that tab.
//
// QA: append `?showinstall=1` to force the overlay on any device/route.

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

// Routes the overlay must never cover. The /legal/* pages are the public
// policy surfaces — Privacy, Terms, Children's Privacy and account deletion —
// and Google Play requires the deletion URL in particular to be reachable and
// usable WITHOUT installing the app. Mounting this full-screen "Install Kaya"
// interstitial in the root layout meant a phone visitor hit an install wall on
// exactly the page the policy says must be open. (Intrusive interstitials on
// public pages are also a search-ranking penalty.)
const EXEMPT_PREFIXES = ['/legal'] as const;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const INSTALLED_KEY = 'kaya.pwa.installed';
const DISMISSED_KEY = 'kaya.pwa.dismissedAt';
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // re-prompt at most weekly

// Capture `beforeinstallprompt` as early as the module loads on the client —
// Chrome can fire it before React mounts, and we'd otherwise lose the only
// chance to trigger a native install.
let cachedPrompt: BeforeInstallPromptEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    cachedPrompt = e as BeforeInstallPromptEvent;
  });
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's legacy flag for a home-screen-launched web app.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function detectPlatform(): 'ios' | 'android' | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports as "Mac" — disambiguate with touch points.
  const ios =
    /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return null;
}

export default function InstallPrompt() {
  const pathname = usePathname();
  const exempt = EXEMPT_PREFIXES.some((p) => pathname === p || pathname?.startsWith(`${p}/`));

  const [variant, setVariant] = useState<'ios' | 'android' | null>(null);
  const [canOneTap, setCanOneTap] = useState<boolean>(!!cachedPrompt);
  const [androidHint, setAndroidHint] = useState(false); // fallback when no native prompt

  useEffect(() => {
    // Public policy pages must stay unobstructed — never prompt here, and
    // don't burn the 7-day cooldown on a visit the user didn't choose.
    if (exempt) {
      setVariant(null);
      return;
    }

    // Already in the installed app → remember it forever, never prompt.
    if (isStandalone()) {
      try {
        localStorage.setItem(INSTALLED_KEY, '1');
      } catch {
        /* private mode — fine */
      }
      return;
    }

    const forced =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('showinstall');

    const platform = detectPlatform();

    if (!forced) {
      if (!platform) return; // desktop / unknown → exempt
      try {
        if (localStorage.getItem(INSTALLED_KEY) === '1') return; // installed before
        const dismissedAt = Number(localStorage.getItem(DISMISSED_KEY) || 0);
        if (dismissedAt && Date.now() - dismissedAt < COOLDOWN_MS) return; // cooling off
      } catch {
        /* storage blocked — fall through and show once */
      }
    }

    setVariant(platform ?? 'ios'); // forced desktop QA falls back to the iOS layout
    if (cachedPrompt) setCanOneTap(true);

    // Late-arriving native install prompt (Android).
    const onBIP = (e: Event) => {
      e.preventDefault();
      cachedPrompt = e as BeforeInstallPromptEvent;
      setCanOneTap(true);
    };
    // If the OS installs it (either platform), remember and dismiss.
    const onInstalled = () => {
      try {
        localStorage.setItem(INSTALLED_KEY, '1');
      } catch {
        /* ignore */
      }
      setVariant(null);
    };
    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP);
      window.removeEventListener('appinstalled', onInstalled);
    };
    // Re-runs on client-side navigation into or out of an exempt route.
  }, [exempt]);

  // Lock background scroll while the full-screen overlay is up.
  useEffect(() => {
    if (!variant) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [variant]);

  if (!variant) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setVariant(null);
  };

  const install = async () => {
    if (cachedPrompt) {
      try {
        await cachedPrompt.prompt();
        await cachedPrompt.userChoice;
      } catch {
        /* user backed out — leave the prompt up */
      }
      cachedPrompt = null;
      // `appinstalled` handles the success path; if they declined we keep
      // the screen so they can try again or continue in the browser.
    } else {
      // No native prompt available — reveal the menu fallback.
      setAndroidHint(true);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add Kaya to your home screen"
      className="fixed inset-0 z-[200] flex flex-col bg-kaya-chocolate text-white"
    >
      {/* ── Brand hero ─────────────────────────────────────────── */}
      <div className="relative flex flex-1 flex-col items-center overflow-hidden px-6 pt-[max(2.5rem,env(safe-area-inset-top))] text-center">
        <div className="pointer-events-none absolute -right-32 -top-32 h-72 w-72 rounded-full bg-kaya-gold/15 blur-3xl" />

        <div className="relative z-10 mt-6 flex h-20 w-20 items-center justify-center rounded-[20px] bg-gradient-to-b from-kaya-gold to-kaya-gold-dark font-display text-[44px] font-black text-kaya-chocolate shadow-[0_14px_30px_-8px_rgba(212,160,23,0.6)]">
          K
        </div>

        <h2 className="relative z-10 mt-5 max-w-[280px] font-display text-2xl font-extrabold leading-tight tracking-tight">
          {variant === 'ios' ? (
            <>
              Add Kaya to your
              <br />
              Home Screen
            </>
          ) : (
            <>Get the Kaya app</>
          )}
        </h2>
        <p className="relative z-10 mt-2.5 max-w-[260px] text-sm leading-relaxed text-kaya-sand-light">
          Open Kaya full-screen — faster, distraction-free, with notifications.
          Just like a real app.
        </p>

        <div className="relative z-10 mt-4 flex gap-4 text-xs font-bold text-kaya-gold-light">
          <span>✨ Full-screen</span>
          <span>🔔 Notifications</span>
        </div>
      </div>

      {/* ── Action sheet ───────────────────────────────────────── */}
      <div className="rounded-t-[26px] bg-kaya-cream px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 text-kaya-chocolate shadow-[0_-16px_40px_-20px_rgba(0,0,0,0.5)]">
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-kaya-warm-dark" />

        {variant === 'ios' ? (
          <div className="flex flex-col gap-3.5">
            <Step n="1" text={<>Tap the <b className="font-extrabold">Share</b> button below</>} glyph="share" />
            <Step n="2" text={<>Choose <b className="font-extrabold">Add to Home Screen</b></>} glyph="add" />
            <Step n="3" text={<>Open <b className="font-extrabold">Kaya</b> from your home screen 🎉</>} glyph="open" />
            {/* Pointer to Safari's share button (sits in the browser chrome below). */}
            <div className="mt-1 flex flex-col items-center text-kaya-gold-dark">
              <span className="mb-1 rounded-full bg-kaya-gold px-2.5 py-0.5 font-display text-[11px] font-black text-kaya-chocolate">
                Share is below ↓
              </span>
              <svg className="h-6 w-6 animate-bounce" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 21l-7-8h4V3h6v10h4z" />
              </svg>
            </div>
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={install}
              className="flex w-full items-center justify-center gap-2.5 rounded-[15px] bg-kaya-chocolate py-4 font-display text-base font-black text-white shadow-[0_10px_22px_-8px_rgba(30,18,11,0.5)] active:scale-[0.99]"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 3v11" />
                <path d="M8 11l4 4 4-4" />
                <path d="M5 20h14" />
              </svg>
              Install Kaya
            </button>
            <p className="mt-3 text-center text-[13px] leading-snug text-kaya-sand">
              {androidHint ? (
                <>Open your browser menu <b className="font-extrabold text-kaya-chocolate">⋮ → Add to Home screen</b>.</>
              ) : canOneTap ? (
                <>One tap — Kaya adds itself to your home screen.<br />No App Store, no download wait.</>
              ) : (
                <>Add Kaya to your home screen for the full-screen app.</>
              )}
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={dismiss}
          className="mt-4 w-full border-t border-kaya-warm-dark pt-3.5 text-center text-[13px] font-bold text-kaya-sand"
        >
          Continue in browser{' '}
          <span className="text-kaya-chocolate-light underline underline-offset-2">just this once →</span>
        </button>
      </div>
    </div>
  );
}

function Step({
  n,
  text,
  glyph,
}: {
  n: string;
  text: React.ReactNode;
  glyph: 'share' | 'add' | 'open';
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-kaya-sm bg-kaya-warm font-display text-sm font-black text-kaya-chocolate">
        {n}
      </span>
      <span className="flex-1 text-[13.5px] leading-snug text-kaya-chocolate-light">{text}</span>
      <span className="flex w-6 flex-none items-center justify-center text-kaya-gold-dark">
        {glyph === 'share' && (
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 15V3" />
            <path d="M8 7l4-4 4 4" />
            <path d="M6 11v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8" />
          </svg>
        )}
        {glyph === 'add' && (
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="4" y="4" width="16" height="16" rx="4" />
            <path d="M12 8v8M8 12h8" />
          </svg>
        )}
        {glyph === 'open' && <span className="text-lg">📲</span>}
      </span>
    </div>
  );
}
