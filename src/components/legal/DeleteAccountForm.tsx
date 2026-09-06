'use client';

// The request form on /legal/delete-account.
//
// This page is PUBLIC and must stay that way — Google Play requires the
// deletion route to be reachable without installing the app or logging in, so
// a signed-out parent (or someone who has lost access entirely) can still ask.
//
// It records an intent; it does not delete. Verification and the actual
// deletion are done by a human, because unpicking a family touches Firestore,
// Storage, Auth and Stripe.

import { useState } from 'react';

const SCOPES = [
  { value: 'everything', label: 'The whole account', hint: 'Every parent, child and helper in the family' },
  { value: 'child', label: "One child's data only", hint: 'The rest of the family stays as it is' },
  { value: 'other', label: 'Something else', hint: 'Tell us below and we’ll come back to you' },
] as const;

export default function DeleteAccountForm() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string>('everything');
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state === 'sending') return;
    setState('sending');
    setError('');
    try {
      const res = await fetch('/api/account/deletion-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, scope, notes }),
      });
      const data = (await res.json().catch(() => ({}))) as { reference?: string; error?: string };
      if (!res.ok) {
        setError(
          data.error === 'rate-limited'
            ? 'That’s a few requests in a short time. Please try again in an hour, or email hello@ourkaya.com.'
            : data.error === 'invalid-email'
              ? 'That email address doesn’t look right — please check it.'
              : 'Something went wrong sending that. Please email hello@ourkaya.com instead.',
        );
        setState('error');
        return;
      }
      setReference(data.reference || '');
      setState('done');
    } catch {
      setError('Couldn’t reach Kaya. Please email hello@ourkaya.com instead.');
      setState('error');
    }
  };

  if (state === 'done') {
    return (
      <div className="rounded-kaya border border-kaya-gold-light bg-kaya-gold-light/40 px-5 py-5">
        <h3 className="font-display text-lg font-extrabold text-kaya-chocolate">Request received ✅</h3>
        <p className="mt-2 text-[14px] leading-relaxed text-kaya-chocolate/80">
          We’ll email <strong>{email}</strong> to confirm it’s really you, then complete the deletion within{' '}
          <strong>30 days</strong>.
        </p>
        {reference && (
          <p className="mt-3 text-[13px] text-kaya-sand">
            Your reference: <code className="font-mono text-kaya-chocolate">{reference}</code>
          </p>
        )}
      </div>
    );
  }

  const inputClass =
    'w-full rounded-kaya-sm border border-kaya-warm-dark bg-white px-3.5 py-2.5 text-[14px] text-kaya-chocolate placeholder:text-kaya-sand focus:border-kaya-gold-dark focus:outline-none';

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="del-email" className="mb-1.5 block text-[13px] font-bold text-kaya-chocolate">
          The email on the Kaya account <span className="text-kaya-gold-dark">*</span>
        </label>
        <input
          id="del-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="del-name" className="mb-1.5 block text-[13px] font-bold text-kaya-chocolate">
          Your name
        </label>
        <input
          id="del-name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Optional"
          className={inputClass}
        />
      </div>

      <fieldset>
        <legend className="mb-1.5 text-[13px] font-bold text-kaya-chocolate">What should we delete?</legend>
        <div className="space-y-2">
          {SCOPES.map((s) => (
            <label
              key={s.value}
              className={`flex cursor-pointer items-start gap-3 rounded-kaya-sm border px-3.5 py-2.5 ${
                scope === s.value
                  ? 'border-kaya-gold-dark bg-kaya-gold-light/30'
                  : 'border-kaya-warm-dark bg-white'
              }`}
            >
              <input
                type="radio"
                name="scope"
                value={s.value}
                checked={scope === s.value}
                onChange={() => setScope(s.value)}
                className="mt-1 accent-kaya-gold-dark"
              />
              <span>
                <span className="block text-[14px] font-bold text-kaya-chocolate">{s.label}</span>
                <span className="block text-[12.5px] text-kaya-sand">{s.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="del-notes" className="mb-1.5 block text-[13px] font-bold text-kaya-chocolate">
          Anything we should know?
        </label>
        <textarea
          id="del-notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional — e.g. which child, or which family if you have more than one"
          className={inputClass}
        />
      </div>

      {error && (
        <p role="alert" className="rounded-kaya-sm bg-red-50 px-3.5 py-2.5 text-[13px] text-red-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={state === 'sending'}
        className="w-full rounded-kaya-sm bg-kaya-chocolate py-3.5 font-display text-[15px] font-black text-white active:scale-[0.99] disabled:opacity-60"
      >
        {state === 'sending' ? 'Sending…' : 'Request deletion'}
      </button>

      <p className="text-center text-[12.5px] leading-relaxed text-kaya-sand">
        Prefer email? Write to{' '}
        <a href="mailto:hello@ourkaya.com" className="font-bold text-kaya-gold-dark underline underline-offset-2">
          hello@ourkaya.com
        </a>{' '}
        from the address on the account.
      </p>
    </form>
  );
}
