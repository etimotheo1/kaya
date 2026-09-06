// Kaya · COPPA + Login — the shared legal-document shell.
//
// Renders Terms / Privacy / Children's Privacy on the live Kaya master skin
// with a dated version stamp (ACTIVE_POLICY_VERSION). These pages MUST be live
// + visually distinct for the sign-up / login clickwrap to legally bind.
//
// IMPORTANT — the lawyer-reviewed source documents live WITH ELIA, not in this
// repo (per project rule: reference the Terms/Privacy docx, never commit them).
// The copy here states Kaya's already-published product commitments and pins
// the governing-document notice; paste the finalized prose into these routes
// before public launch. Bump ACTIVE_POLICY_VERSION on any material change to
// re-trigger the /accept gate.

import Link from 'next/link';
import KayaMark from '@/components/brand/KayaMark';
import { ACTIVE_POLICY_VERSION } from '@/lib/coppa/constants';
import { toDisplayDate } from '@/lib/dates';

const DOCS = [
  { href: '/legal/terms', label: 'Terms of Service' },
  { href: '/legal/privacy', label: 'Privacy Policy' },
  { href: '/legal/childrens-privacy', label: 'Children’s Privacy' },
  // Google Play requires the account-deletion route to be "readily
  // discoverable" — cross-linking it from every legal page is what makes it so.
  { href: '/legal/delete-account', label: 'Delete your account' },
] as const;

export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="font-display font-extrabold text-kaya-chocolate text-lg mb-2">{title}</h2>
      <div className="text-[14px] leading-relaxed text-kaya-chocolate/80 space-y-2.5">{children}</div>
    </section>
  );
}

export default function LegalDoc({
  title,
  intro,
  current,
  children,
  // The version stamp + "the complete document controls" notice belong to the
  // governing policy documents (Terms / Privacy / Children's Privacy). A
  // process page like "Delete your account" is not a governing document — the
  // notice reads as nonsense there ("the complete, governing Delete your
  // account…") — so it can opt out. Defaults to true so the three policy
  // pages render exactly as they always have.
  showPolicyMeta = true,
}: {
  title: string;
  intro: string;
  current: (typeof DOCS)[number]['href'];
  children: React.ReactNode;
  showPolicyMeta?: boolean;
}) {
  return (
    <div className="min-h-screen bg-kaya-cream text-kaya-chocolate font-body">
      {/* Top bar */}
      <header className="flex items-center justify-between px-5 sm:px-8 py-5 border-b border-kaya-warm-dark">
        <Link href="/" className="flex items-center gap-2.5">
          <KayaMark variant="dark" size={32} title="Kaya" />
          <span className="font-display font-bold text-lg text-kaya-chocolate">Kaya</span>
        </Link>
        <Link href="/login" className="text-[13px] font-semibold text-kaya-sand hover:text-kaya-chocolate">
          Log in →
        </Link>
      </header>

      <main className="max-w-2xl mx-auto px-5 sm:px-8 py-10">
        <h1 className="font-display font-extrabold text-kaya-chocolate text-3xl mb-1.5">{title}</h1>
        {showPolicyMeta && (
          <p className="text-[13px] text-kaya-sand mb-6">
            Version {ACTIVE_POLICY_VERSION} · Effective {toDisplayDate(ACTIVE_POLICY_VERSION)}
          </p>
        )}

        <p className="text-[14px] leading-relaxed text-kaya-chocolate/80 mb-6">{intro}</p>

        {/* Governing-document notice — the lawyer-reviewed source governs. */}
        {showPolicyMeta && (
          <div className="bg-kaya-gold-light/40 border border-kaya-gold-light rounded-kaya px-4 py-3.5 mb-8 text-[13px] leading-relaxed text-kaya-chocolate/80">
            This page summarises the commitments in force. The complete, governing {title} is maintained by Kaya; if anything here conflicts with that
            document, the complete document controls. Questions? Email{' '}
            <a href="mailto:hello@ourkaya.com" className="text-kaya-gold-dark font-bold underline underline-offset-2">
              hello@ourkaya.com
            </a>
            .
          </div>
        )}

        {children}

        {/* Cross-links to the sibling documents. */}
        <nav className="mt-10 pt-6 border-t border-kaya-warm-dark flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
          {DOCS.map((d) =>
            d.href === current ? (
              <span key={d.href} className="font-bold text-kaya-chocolate">
                {d.label}
              </span>
            ) : (
              <Link key={d.href} href={d.href} className="font-semibold text-kaya-gold-dark hover:text-kaya-chocolate underline underline-offset-2">
                {d.label}
              </Link>
            ),
          )}
        </nav>
      </main>
    </div>
  );
}
