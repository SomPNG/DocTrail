import { useEffect, useRef, useState } from 'react';
import { Bell, LogOut, RotateCcw, Timer } from 'lucide-react';
import { api } from '../lib/api.js';
import { fmtDateTime, ROLE_LABEL, useServerNow } from '../lib/format.js';
import { cx, useToast } from './ui.jsx';

function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#22408c" />
        <path d="M7 16h18" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="9" cy="16" r="3" fill="#fff" />
        <circle cx="16" cy="16" r="3" fill="#fff" />
        <circle cx="23" cy="16" r="3.6" fill="#22408c" stroke="#fff" strokeWidth="2.4" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">DocTrail</span>
    </div>
  );
}

/** Shows when the server clock is running ahead of real time (simulation). */
function SimClock() {
  const now = useServerNow(1000);
  const ahead = (now.getTime() - Date.now()) / 3_600_000;
  if (Math.abs(ahead) < 0.05) return null;
  return (
    <span
      className="hidden items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1 text-xs font-medium text-accent sm:inline-flex"
      title="The server clock is simulated. Countdowns follow it."
    >
      <Timer className="size-3.5" />
      Simulated time {fmtDateTime(now)} ({ahead > 0 ? '+' : ''}
      {ahead >= 48 || ahead <= -48 ? `${(ahead / 24).toFixed(1)} days` : `${ahead.toFixed(1)} h`})
    </span>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const ref = useRef(null);

  const load = () => api.notifications().then(setItems).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const close = e => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const unread = items.filter(n => !n.isRead).length;
  const markAll = async () => {
    await Promise.all(items.filter(n => !n.isRead).map(n => api.markRead(n.id).catch(() => {})));
    load();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        onClick={() => {
          setOpen(o => !o);
          if (!open) load();
        }}
        className="relative grid size-8 place-items-center rounded-md text-muted hover:bg-paper hover:text-ink"
      >
        <Bell className="size-4" />
        {unread > 0 && <span className="absolute right-1 top-1 size-2 rounded-full bg-bad" />}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && (
              <button className="text-xs text-accent hover:underline" onClick={markAll}>
                Mark all as read
              </button>
            )}
          </div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {items.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">No notifications yet.</li>}
            {items.map(n => (
              <li key={n.id} className={cx('px-4 py-3', !n.isRead && 'bg-accent-soft/50')}>
                <p className="text-sm font-medium">{n.title}</p>
                <p className="mt-0.5 text-[13px] leading-snug text-muted">{n.message}</p>
                <p className="mt-1 text-xs text-faint">
                  {fmtDateTime(n.createdAt)}
                  {n.deliveries?.length ? `, also sent by ${n.deliveries.map(d => d.channel.toLowerCase()).join(', ')}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ResetButton() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const handleReset = async () => {
    const ok = window.confirm(
      'Reset all data?\n\nThis will remove all previously uploaded documents, applications, and activity, giving you a completely clean slate.'
    );
    if (!ok) return;

    setBusy(true);
    try {
      await api.clearData();
      toast('All previous uploaded data and applications have been cleared.');
      setTimeout(() => {
        window.location.reload();
      }, 500);
    } catch (err) {
      toast(err.message || 'Failed to reset data', 'bad');
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleReset}
      disabled={busy}
      title="Reset all uploaded applications and documents"
      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:border-bad/40 hover:bg-bad/10 hover:text-bad disabled:opacity-50"
    >
      <RotateCcw className={cx('size-3.5', busy && 'animate-spin text-bad')} />
      <span className="hidden sm:inline">{busy ? 'Resetting…' : 'Reset Data'}</span>
    </button>
  );
}

export default function TopBar({ user, onSignOut, children }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4">
        <Wordmark />
        <nav className="flex min-w-0 flex-1 items-center gap-1">{children}</nav>
        <SimClock />
        <Notifications />
        <ResetButton />
        <div className="hidden text-right leading-tight md:block">
          <p className="text-[13px] font-medium">{user.name}</p>
          <p className="text-xs text-muted">
            {ROLE_LABEL[user.role]}
            {user.department ? `, ${user.department}` : ''}
          </p>
        </div>
        <button
          onClick={onSignOut}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-muted hover:bg-paper hover:text-ink"
        >
          <LogOut className="size-4" />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    </header>
  );
}

export function NavTab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'rounded-md px-3 py-1.5 text-[13px] font-medium',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-paper hover:text-ink'
      )}
    >
      {children}
    </button>
  );
}
