import { Check, Pause } from 'lucide-react';
import { cx } from './ui.jsx';
import { fmtHours } from '../lib/format.js';

/**
 * The application's route across departments, drawn like a transit line.
 * Each segment fills with the time used at that stage relative to its target, so a late stage
 * is visibly longer-than-full (red), and the current stop pulses.
 *
 * pipeline: [{ stageName, departmentName, state: DONE|CURRENT|UPCOMING, targetHours, activeHours, pausedHours, breached }]
 */
export default function RouteLine({ pipeline = [], paused = false, closed = false }) {
  if (!pipeline.length) return null;
  return (
    <>
      <VerticalRoute pipeline={pipeline} paused={paused} closed={closed} />
    <ol className="hidden gap-0 sm:grid" style={{ gridTemplateColumns: `repeat(${pipeline.length}, minmax(0, 1fr))` }}>
      {pipeline.map((p, i) => {
        const ratio = p.targetHours ? p.activeHours / p.targetHours : 0;
        const fill = Math.min(1, ratio);
        const isCurrent = p.state === 'CURRENT';
        const done = p.state === 'DONE' || (closed && p.state !== 'UPCOMING');
        const late = p.breached || ratio > 1;
        const barColor = late ? 'bg-bad' : ratio > 0.8 ? 'bg-warn' : 'bg-ok';

        return (
          <li key={`${p.stageName}-${i}`} className="relative min-w-0 pr-3">
            {/* track */}
            <div className="flex items-center">
              <span
                className={cx(
                  'relative z-10 grid size-6 shrink-0 place-items-center rounded-full border-2',
                  done && 'border-ok bg-ok text-white',
                  isCurrent && !done && (paused ? 'border-paused bg-surface text-paused' : 'route-marker border-accent bg-accent text-white'),
                  !done && !isCurrent && 'border-line-strong bg-surface'
                )}
              >
                {done ? <Check className="size-3.5" strokeWidth={3} /> : isCurrent && paused ? <Pause className="size-3" strokeWidth={3} /> : null}
              </span>
              {i < pipeline.length - 1 && (
                <span className="relative -ml-0.5 h-1.5 flex-1 overflow-hidden rounded-r bg-line">
                  {(done || isCurrent) && (
                    <span className={cx('absolute inset-y-0 left-0', barColor)} style={{ width: `${Math.max(done ? 100 : fill * 100, 4)}%` }} />
                  )}
                </span>
              )}
            </div>

            {/* labels */}
            <div className="mt-2.5 space-y-0.5 pr-1">
              <p className={cx('truncate text-[13px] font-semibold', !done && !isCurrent && 'text-faint')} title={p.stageName}>
                {p.stageName}
              </p>
              <p className="truncate text-xs text-muted" title={p.departmentName}>
                {p.departmentName}
              </p>
              <p className={cx('text-xs', late ? 'font-medium text-bad' : 'text-muted')}>
                {p.state === 'UPCOMING' ? `Target ${fmtHours(p.targetHours)}` : `${fmtHours(p.activeHours)} of ${fmtHours(p.targetHours)}`}
                {p.pausedHours >= 1 && p.state !== 'UPCOMING' ? `, ${fmtHours(p.pausedHours)} paused` : ''}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
    </>
  );
}

/** Phone layout: the same route, top to bottom. */
function VerticalRoute({ pipeline, paused, closed }) {
  return (
    <ol className="sm:hidden">
      {pipeline.map((p, i) => {
        const ratio = p.targetHours ? p.activeHours / p.targetHours : 0;
        const isCurrent = p.state === 'CURRENT';
        const done = p.state === 'DONE' || (closed && p.state !== 'UPCOMING');
        const late = p.breached || ratio > 1;
        return (
          <li key={`${p.stageName}-${i}`} className="relative flex gap-3 pb-4 last:pb-0">
            {i < pipeline.length - 1 && (
              <span className={cx('absolute left-[11px] top-6 bottom-0 w-1 rounded', done ? 'bg-ok' : isCurrent ? (late ? 'bg-bad' : 'bg-accent') : 'bg-line')} aria-hidden />
            )}
            <span
              className={cx(
                'relative z-10 grid size-6 shrink-0 place-items-center rounded-full border-2',
                done && 'border-ok bg-ok text-white',
                isCurrent && !done && (paused ? 'border-paused bg-surface text-paused' : 'route-marker border-accent bg-accent text-white'),
                !done && !isCurrent && 'border-line-strong bg-surface'
              )}
            >
              {done ? <Check className="size-3.5" strokeWidth={3} /> : isCurrent && paused ? <Pause className="size-3" strokeWidth={3} /> : null}
            </span>
            <div className="min-w-0 pt-0.5">
              <p className={cx('text-[13px] font-semibold', !done && !isCurrent && 'text-faint')}>{p.stageName}</p>
              <p className="text-xs text-muted">{p.departmentName}</p>
              <p className={cx('text-xs', late ? 'font-medium text-bad' : 'text-muted')}>
                {p.state === 'UPCOMING' ? `Target ${fmtHours(p.targetHours)}` : `${fmtHours(p.activeHours)} of ${fmtHours(p.targetHours)}`}
                {p.pausedHours >= 1 && p.state !== 'UPCOMING' ? `, ${fmtHours(p.pausedHours)} paused` : ''}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
