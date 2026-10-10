import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';

const cx = (...c) => c.filter(Boolean).join(' ');
export { cx };

/* ---------------------------------------------------------------- buttons */
const BTN = {
  primary: 'bg-accent text-white hover:bg-[#1b3473] disabled:bg-line-strong',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-paper disabled:text-faint',
  ghost: 'text-muted hover:text-ink hover:bg-paper disabled:text-faint',
  danger: 'bg-surface text-bad border border-bad/40 hover:bg-bad-soft disabled:text-faint',
};

export function Button({ variant = 'secondary', size = 'md', loading, icon: Icon, children, className, ...props }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        BTN[variant],
        className
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : Icon ? <Icon className="size-4" /> : null}
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- badges */
const TONE = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  paused: 'bg-paused-soft text-paused',
  neutral: 'bg-paper text-muted border border-line',
  accent: 'bg-accent-soft text-accent',
};

export function Badge({ tone = 'neutral', children, className }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium', TONE[tone], className)}>
      {children}
    </span>
  );
}

export const toneText = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', paused: 'text-paused', neutral: 'text-muted', accent: 'text-accent' };
export const toneBg = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', paused: 'bg-paused', neutral: 'bg-line-strong', accent: 'bg-accent' };

/* ---------------------------------------------------------------- layout */
export function Panel({ title, action, children, className, bodyClassName }) {
  return (
    <section className={cx('rounded-lg border border-line bg-surface', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {action}
        </header>
      )}
      <div className={cx('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="max-w-sm text-sm text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  );
}

export function ErrorNote({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad">
      {error.message || String(error)}
      {onRetry && (
        <button className="ml-2 underline" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- form */
export function Field({ label, hint, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-[13px] font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm placeholder:text-faint focus:border-accent focus:outline-none';
export const Input = props => <input {...props} className={cx(inputCls, props.className)} />;
export const Textarea = props => <textarea rows={3} {...props} className={cx(inputCls, props.className)} />;
export const Select = ({ children, ...props }) => (
  <select {...props} className={cx(inputCls, 'pr-8', props.className)}>
    {children}
  </select>
);

/* ---------------------------------------------------------------- dialog */
export function Dialog({ open, title, onClose, children, footer }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-ink/30"
    >
      {open && (
        <div>
          <header className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="text-sm font-semibold">{title}</h2>
            <button aria-label="Close" onClick={onClose} className="rounded p-1 text-muted hover:bg-paper hover:text-ink">
              <X className="size-4" />
            </button>
          </header>
          <div className="space-y-4 px-5 py-4">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

/* ---------------------------------------------------------------- toasts */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, { id, message, tone }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map(t => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto rounded-md border bg-surface px-3 py-2.5 text-sm',
              t.tone === 'bad' ? 'border-bad/40 text-bad' : 'border-line text-ink'
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------------------------------------------------------- data hook */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const run = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      setState(s => ({ ...s, error, loading: false }));
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    run();
  }, [run]);
  return { ...state, reload: run };
}
