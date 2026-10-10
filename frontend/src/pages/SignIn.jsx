import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { api } from '../lib/api.js';
import { Button, ErrorNote, Field, Input, cx, useToast } from '../components/ui.jsx';
import RouteLine from '../components/RouteLine.jsx';

const DEMO_ACCOUNTS = [
  { group: 'Citizen', accounts: [{ email: 'citizen@example.com', label: 'Aarav Sharma' }] },
  {
    group: 'Officers',
    accounts: [
      { email: 'dm.officer@example.com', label: 'District Magistrate Office' },
      { email: 'police.officer@example.com', label: 'Police Department' },
      { email: 'sp.officer@example.com', label: 'Superintendent of Police' },
      { email: 'passport.officer@example.com', label: 'Passport Office' },
      { email: 'municipal.officer@example.com', label: 'Municipal Corporation' },
      { email: 'health.officer@example.com', label: 'Health Department' },
    ],
  },
  {
    group: 'Oversight',
    accounts: [
      { email: 'supervisor@example.com', label: 'Supervisor' },
      { email: 'admin@example.com', label: 'Administrator' },
    ],
  },
];

// A static example of the tracking line, so the first screen shows what the product does.
const EXAMPLE = [
  { stageName: 'Initial verification', departmentName: 'DM Office', state: 'DONE', targetHours: 24, activeHours: 14, pausedHours: 0 },
  { stageName: 'Police verification', departmentName: 'Police Department', state: 'CURRENT', targetHours: 240, activeHours: 262, pausedHours: 30, breached: true },
  { stageName: 'SP review', departmentName: 'SP Office', state: 'UPCOMING', targetHours: 120, activeHours: 0, pausedHours: 0 },
  { stageName: 'Final approval', departmentName: 'DM Office', state: 'UPCOMING', targetHours: 120, activeHours: 0, pausedHours: 0 },
];

export default function SignIn({ onSignedIn }) {
  const toast = useToast();
  const [mode, setMode] = useState('signin');
  const [form, setForm] = useState({ email: '', password: '', name: '', phone: '' });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [resetting, setResetting] = useState(false);

  const handleReset = async () => {
    const ok = window.confirm(
      'Reset all data?\n\nThis will remove all previously uploaded documents, applications, and activity, giving you a completely clean slate.'
    );
    if (!ok) return;

    setResetting(true);
    try {
      await api.clearData();
      toast('All previous uploaded data and applications have been cleared.');
      setTimeout(() => window.location.reload(), 500);
    } catch (e) {
      toast(e.message || 'Failed to reset data', 'bad');
      setResetting(false);
    }
  };

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const signIn = async (email, password, key = 'form') => {
    setBusy(key);
    setError(null);
    try {
      const res = await api.login(email, password);
      onSignedIn(res.token, res.user);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const register = async () => {
    setBusy('form');
    setError(null);
    try {
      const res = await api.register({ email: form.email, password: form.password, name: form.name, phone: form.phone || undefined });
      onSignedIn(res.token, res.user);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative min-h-full">
      <div className="mx-auto flex max-w-6xl justify-end px-6 pt-4">
        <button
          onClick={handleReset}
          disabled={resetting}
          title="Reset all uploaded data and start fresh"
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:border-bad/40 hover:bg-bad/10 hover:text-bad disabled:opacity-50"
        >
          <RotateCcw className={cx('size-3.5', resetting && 'animate-spin text-bad')} />
          <span>{resetting ? 'Resetting…' : 'Reset Data'}</span>
        </button>
      </div>
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl gap-12 px-6 py-8 lg:grid-cols-[1.2fr_1fr] lg:py-16">
      <div className="flex flex-col justify-center">
        <p className="text-sm font-semibold text-accent">DocTrail</p>
        <h1 className="mt-3 max-w-xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
          See where every application is, and why it is waiting.
        </h1>
        <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-muted">
          One tracking number follows a file through every department. Each stage has a time target, so delays show up
          the moment they happen, with the reason and the office responsible.
        </p>
        <div className="mt-10 rounded-lg border border-line bg-surface p-5">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <p className="text-sm font-semibold">GL-2026-000042, gun licence</p>
            <p className="text-xs font-medium text-bad">Overdue at Police: no officer activity for 4 days</p>
          </div>
          <RouteLine pipeline={EXAMPLE} />
        </div>
      </div>

      <div className="flex flex-col justify-center">
        <div className="rounded-lg border border-line bg-surface">
          <div className="flex border-b border-line">
            {[
              ['signin', 'Sign in'],
              ['register', 'Create citizen account'],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => {
                  setMode(k);
                  setError(null);
                }}
                className={`flex-1 px-4 py-3 text-sm font-medium ${mode === k ? 'border-b-2 border-accent text-ink' : 'text-muted hover:text-ink'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <form
            className="space-y-4 p-5"
            onSubmit={e => {
              e.preventDefault();
              mode === 'signin' ? signIn(form.email, form.password) : register();
            }}
          >
            {mode === 'register' && (
              <Field label="Full name">
                <Input required minLength={2} value={form.name} onChange={set('name')} autoComplete="name" />
              </Field>
            )}
            <Field label="Email">
              <Input required type="email" value={form.email} onChange={set('email')} autoComplete="email" />
            </Field>
            <Field label="Password" hint={mode === 'register' ? 'At least 8 characters.' : undefined}>
              <Input
                required
                type="password"
                minLength={mode === 'register' ? 8 : 1}
                value={form.password}
                onChange={set('password')}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              />
            </Field>
            {mode === 'register' && (
              <Field label="Mobile number" hint="Used for SMS and WhatsApp updates.">
                <Input value={form.phone} onChange={set('phone')} placeholder="+91 98765 43210" autoComplete="tel" />
              </Field>
            )}
            <ErrorNote error={error} />
            <Button type="submit" variant="primary" className="w-full" loading={busy === 'form'}>
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
          </form>
        </div>

        <div className="mt-6">
          <p className="text-sm font-medium">Demo accounts</p>
          <p className="mt-0.5 text-xs text-muted">Password for all: Password123!</p>
          <div className="mt-3 space-y-3">
            {DEMO_ACCOUNTS.map(g => (
              <div key={g.group}>
                <p className="mb-1.5 text-xs text-muted">{g.group}</p>
                <div className="flex flex-wrap gap-1.5">
                  {g.accounts.map(a => (
                    <Button key={a.email} size="sm" loading={busy === a.email} onClick={() => signIn(a.email, 'Password123!', a.email)}>
                      {a.label}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </div>
);
}
