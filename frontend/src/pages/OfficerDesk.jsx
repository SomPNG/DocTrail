import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api.js';
import { fmtHours, REASON, SEVERITY_TONE } from '../lib/format.js';
import { Badge, Empty, ErrorNote, Spinner, cx, toneBg, useAsync } from '../components/ui.jsx';
import CaseWorkspace from '../components/CaseWorkspace.jsx';

export function QueueRow({ item, selected, onSelect, showDepartment }) {
  const d = item.diagnosis;
  const reason = REASON[d.reasonCode] || REASON.ON_TRACK;
  const t = d.timing;
  return (
    <button
      onClick={onSelect}
      className={cx('relative w-full rounded-md py-2.5 pl-4 pr-3 text-left', selected ? 'bg-accent-soft' : 'hover:bg-surface')}
    >
      <span className={cx('absolute inset-y-2 left-1 w-1 rounded-full', toneBg[SEVERITY_TONE[d.severity]] || 'bg-line')} aria-hidden />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">{item.trackingNumber}</span>
        <span className={cx('text-xs tabular-nums', t?.overdueHours > 0 ? 'font-medium text-bad' : 'text-muted')}>
          {t?.slaStatus === 'PAUSED' ? 'Paused' : t?.overdueHours > 0 ? `${fmtHours(t.overdueHours)} late` : `${fmtHours(t?.remainingHours)} left`}
        </span>
      </div>
      <p className="mt-0.5 truncate text-xs text-muted">
        {item.applicantName}, {d.location?.stageName}
        {showDepartment ? ` at ${d.location?.departmentName}` : ''}
      </p>
      <div className="mt-1.5">
        <Badge tone={reason.tone}>{reason.label}</Badge>
      </div>
    </button>
  );
}

export default function OfficerDesk({ user }) {
  const queue = useAsync(() => api.officerQueue(), []);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('attention');

  useEffect(() => {
    const t = setInterval(queue.reload, 30000);
    return () => clearInterval(t);
  }, [queue.reload]);

  const items = queue.data?.items || [];
  const shown = filter === 'attention' ? items.filter(i => i.diagnosis.isStuck || i.diagnosis.severity !== 'NONE') : items;

  useEffect(() => {
    if (!selected && shown.length) setSelected(shown[0].id);
  }, [shown, selected]);

  const s = queue.data?.summary;

  return (
    <div className="mx-auto grid max-w-[1400px] lg:grid-cols-[340px_1fr]">
      <aside className="border-b border-line lg:min-h-[calc(100vh-3.5rem)] lg:border-b-0 lg:border-r">
        <div className="space-y-3 px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">{user.department || user.departmentCode} queue</h2>
              {s && (
                <p className="text-xs text-muted">
                  {s.total} open, {s.breached} overdue, {s.atRisk} close to deadline, {s.waitingOnCitizen} waiting on applicants
                </p>
              )}
            </div>
            <button aria-label="Refresh queue" onClick={queue.reload} className="rounded p-1.5 text-muted hover:bg-surface hover:text-ink">
              <RefreshCw className={cx('size-4', queue.loading && 'animate-spin')} />
            </button>
          </div>
          <div className="inline-flex rounded-md border border-line bg-surface p-0.5">
            {[
              ['attention', `Needs attention${s ? ` (${items.filter(i => i.diagnosis.isStuck || i.diagnosis.severity !== 'NONE').length})` : ''}`],
              ['all', `All${s ? ` (${s.total})` : ''}`],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={cx('rounded px-2.5 py-1 text-xs font-medium', filter === k ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink')}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="px-2 pb-4">
          {queue.error && <ErrorNote error={queue.error} onRetry={queue.reload} />}
          {queue.loading && !queue.data ? (
            <Spinner />
          ) : shown.length === 0 ? (
            <Empty title={filter === 'attention' ? 'Nothing needs attention' : 'Your queue is empty'}>
              {filter === 'attention' ? 'Every file is on track.' : 'New files appear here as soon as they reach your department.'}
            </Empty>
          ) : (
            <ul className="space-y-1">
              {shown.map(i => (
                <li key={i.id}>
                  <QueueRow item={i} selected={selected === i.id} onSelect={() => setSelected(i.id)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
      <main className="min-w-0">
        {selected ? (
          <CaseWorkspace key={selected} applicationId={selected} user={user} onChanged={queue.reload} />
        ) : (
          !queue.loading && <Empty title="Select a file">Choose a file from the queue to verify it and move it on.</Empty>
        )}
      </main>
    </div>
  );
}
