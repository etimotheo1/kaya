import type { Metadata } from 'next';
import LegalDoc, { LegalSection } from '@/components/legal/LegalDoc';
import DeleteAccountForm from '@/components/legal/DeleteAccountForm';

// Google Play requires apps with account creation to publish a deletion route
// that is reachable WITHOUT installing the app or signing in, and to list its
// URL in Play Console → App content → Data deletion. Keep this page public.

export const metadata: Metadata = {
  title: 'Delete your account · Kaya',
  description: 'Request deletion of your Kaya account and your family’s data.',
};

export default function DeleteAccountPage() {
  return (
    <LegalDoc
      title="Delete your account"
      current="/legal/delete-account"
      // Not a governing policy document — no version stamp, no "the complete
      // document controls" notice.
      showPolicyMeta={false}
      intro="You can ask us to delete your Kaya account and your family’s data at any time — including your children’s. You don’t need to be signed in, and you don’t need the app installed."
    >
      <LegalSection title="Make a request">
        <p>
          Fill this in from the email address on the account if you can. If you’ve lost access to it, send the form anyway and add a note — we’ll find
          another way to confirm it’s you.
        </p>
        <div className="pt-2">
          <DeleteAccountForm />
        </div>
      </LegalSection>

      <LegalSection title="What happens next">
        <p>
          We email you to confirm the request really came from you. Once confirmed, we complete the deletion within <strong>30 days</strong> and email you
          when it’s done. We verify first because a deletion cannot be undone — and because we won’t let anyone else erase your family’s history.
        </p>
      </LegalSection>

      <LegalSection title="What gets deleted">
        <p>Everything that makes up your family in Kaya:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Parent, child and helper profiles, including names, avatars and dates of birth</li>
          <li>Kaya Codes and every login, so nobody can sign back in</li>
          <li>Routines, tasks, points, awards, badges and rewards history</li>
          <li>Moments, photos, videos and any files uploaded to your family</li>
          <li>Chat messages, meeting records, diaries and reflections</li>
          <li>Household, budget, business and savings records</li>
          <li>Push notification tokens and email preferences</li>
        </ul>
      </LegalSection>

      <LegalSection title="What we keep, and why">
        <p>
          A small amount of information outlives the account because the law requires it, not because we want it. That means{' '}
          <strong>payment and invoice records</strong> — kept for the period tax and accounting rules require, and held by our payment processor, not
          alongside your family data — and a <strong>minimal record of the deletion itself</strong> (the request, the date, and the fact it was completed)
          so we can show we honoured it. Neither contains your children’s information.
        </p>
        <p>
          Anonymous, aggregated statistics that can no longer be linked back to your family may also remain. Backups roll off on their normal cycle and are
          fully purged within <strong>90 days</strong>.
        </p>
      </LegalSection>

      <LegalSection title="Deleting one child rather than the whole family">
        <p>
          Choose <em>“One child’s data only”</em> above. We remove that child’s profile, code, points history, photos and written work, and the rest of the
          family carries on untouched. This is also how you withdraw the parental consent you gave when you created their Kaya Code.
        </p>
      </LegalSection>

      <LegalSection title="Cancelling a subscription">
        <p>
          Deleting your account ends any active Kaya subscription. If you only want to stop paying and keep your family’s history, cancel the subscription
          from Settings instead — you don’t need to delete anything.
        </p>
      </LegalSection>

      <LegalSection title="Questions">
        <p>
          Email{' '}
          <a href="mailto:hello@ourkaya.com" className="font-bold text-kaya-gold-dark underline underline-offset-2">
            hello@ourkaya.com
          </a>
          . Our{' '}
          <a href="/legal/privacy" className="font-bold text-kaya-gold-dark underline underline-offset-2">
            Privacy Policy
          </a>{' '}
          and{' '}
          <a href="/legal/childrens-privacy" className="font-bold text-kaya-gold-dark underline underline-offset-2">
            Children’s Privacy notice
          </a>{' '}
          explain what we collect in the first place.
        </p>
      </LegalSection>
    </LegalDoc>
  );
}
