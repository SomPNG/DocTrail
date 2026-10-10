import { useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { api } from '../lib/api.js';
import { fmtDateTime, fmtHours, REASON } from '../lib/format.js';
import { Badge, Button, Empty, ErrorNote, Field, Input, Panel, Select, Spinner, cx, useAsync, useToast } from '../components/ui.jsx';
import BarChart from '../components/BarChart.jsx';
import CaseWorkspace from '../components/CaseWorkspace.jsx';
import { QueueRow } from './OfficerDesk.jsx';
import SimulationRoom from './SimulationRoom.jsx';

/* ------------------------------------------------------------ overview */
function Stat({ label, value, tone }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className={cx('text-2xl font-semibold tabular-nums tracking-tight', tone)}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

function ScoreMeter({ score }) {
  const tone = score >= 60 ? 'bg-bad' : score >= 40 ? 'bg-warn' : 'bg-ok';
  return (
    <div className="flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-line" aria-hidden>
        <span className={cx('block h-full rounded-full', tone)} style={{ width: `${score}%` }} />
      </span>
      <span className="w-6 text-right text-[13px] font-semibold tabular-nums">{score}</span>
    </div>
  );
}

function Overview({ user, onOpen }) {
  const data = useAsync(
    () => Promise.all([api.overview(), api.stuck(), api.bottlenecks(), api.departments(), api.trends(14)]),
    []
  );
  const [reasonFilter, setReasonFilter] = useState(null);

  if (data.loading && !data.data) return <Spinner label="Loading dashboard" />;
  if (data.error) return <div className="p-6"><ErrorNote error={data.error} onRetry={data.reload} /></div>;
  const [ov, stuck, bottlenecks, depts, trends] = data.data;
  const stuckItems = reasonFilter ? stuck.items.filter(i => i.diagnosis.reasonCode === reasonFilter) : stuck.items;
  const deptRows = depts.filter(d => d.activeWorkload + d.completedCount > 0).sort((a, b) => b.activeWorkload - a.activeWorkload);
  const top = bottlenecks.filter(b => b.activeBacklog + b.arrivalsLast7Days + b.breachedEverCount > 0).slice(0, 6);
  const day = s => new Date(s.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Where files are getting stuck</h1>
        <Button size="sm" icon={RefreshCw} loading={data.loading} onClick={data.reload}>
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 divide-x divide-y divide-line rounded-lg border border-line bg-surface sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6">
        <Stat label="Open applications" value={ov.activeApplications + ov.onHoldApplications} />
        <Stat label="Stuck right now" value={ov.stuckApplications} tone={ov.stuckApplications ? 'text-warn' : undefined} />
        <Stat label="Overdue right now" value={ov.breachedApplications} tone={ov.breachedApplications ? 'text-bad' : undefined} />
        <Stat label="Ever missed a stage target" value={`${ov.slaBreachRatePercent}%`} />
        <Stat label="Median days to approval" value={ov.medianTurnaroundDays || '–'} />
        <Stat label="Approved" value={ov.completedApplications} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_1.2fr]">
        <Panel
          title={`Stuck files (${stuck.count})`}
          bodyClassName="p-2"
          action={
            reasonFilter && (
              <button className="text-xs text-accent hover:underline" onClick={() => setReasonFilter(null)}>
                Show all reasons
              </button>
            )
          }
        >
          <div className="flex flex-wrap gap-1.5 px-2 pb-2 pt-1">
            {Object.entries(stuck.byReason).map(([code, n]) => (
              <button
                key={code}
                onClick={() => setReasonFilter(reasonFilter === code ? null : code)}
                className={cx(
                  'rounded border px-2 py-0.5 text-xs',
                  reasonFilter === code ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'
                )}
              >
                {(REASON[code] || { label: code }).label} {n}
              </button>
            ))}
          </div>
          {stuckItems.length === 0 ? (
            <Empty title="Nothing is stuck">Every open file is moving within its time target.</Empty>
          ) : (
            <ul className="max-h-[520px] space-y-1 overflow-y-auto">
              {stuckItems.map(i => (
                <li key={i.id}>
                  <QueueRow item={i} showDepartment onSelect={() => onOpen(i.id)} />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="space-y-5">
          <Panel title="Bottlenecks by stage">
            {top.length === 0 ? (
              <p className="text-sm text-muted">No activity yet. Run a simulation scenario to see how bottlenecks build up.</p>
            ) : (
              <ul className="divide-y divide-line">
                {top.map(b => (
                  <li key={b.stageId} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 py-2.5">
                    <p className="truncate text-[13px] font-medium">
                      {b.stageName} <span className="font-normal text-muted">at {b.departmentName}</span>
                    </p>
                    <ScoreMeter score={b.bottleneckScore} />
                    <p className="col-span-2 text-xs text-muted">
                      {b.explanation}. {b.activeBacklog} open, {b.breachRatePercent}% missed target, average {fmtHours(b.averageCompletedHours || b.averageActiveHours)} against {fmtHours(b.configuredSlaHours)}.
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Last 14 days">
            <div className="grid gap-6 sm:grid-cols-2">
              <BarChart title="Files open at end of day" data={trends.series.map(s => ({ label: day(s), value: s.backlog }))} />
              <BarChart title="Stage deadlines missed" color="bg-bad" data={trends.series.map(s => ({ label: day(s), value: s.newBreaches }))} />
            </div>
          </Panel>
        </div>
      </div>

      <Panel title="Time spent in each department" bodyClassName="overflow-x-auto p-0">
        <table className="w-full min-w-[760px] text-left text-[13px]">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2.5 font-medium">Department</th>
              <th className="px-3 py-2.5 text-right font-medium">Open</th>
              <th className="px-3 py-2.5 text-right font-medium">Average time</th>
              <th className="px-3 py-2.5 text-right font-medium">Median</th>
              <th className="px-3 py-2.5 text-right font-medium">Slowest 10%</th>
              <th className="px-3 py-2.5 text-right font-medium">Waiting on applicant</th>
              <th className="px-3 py-2.5 text-right font-medium">Within target</th>
              <th className="px-4 py-2.5 text-right font-medium">Done per day</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {deptRows.map(d => (
              <tr key={d.code}>
                <td className="px-4 py-2.5 font-medium">{d.name}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{d.activeWorkload}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtHours(d.averageProcessingHours)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtHours(d.medianProcessingHours)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtHours(d.p90ProcessingHours)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{d.pausedOnCitizenOrHold}</td>
                <td className={cx('px-3 py-2.5 text-right font-medium tabular-nums', d.slaCompliancePercent < 80 ? 'text-bad' : d.slaCompliancePercent < 95 ? 'text-warn' : 'text-ok')}>
                  {d.slaCompliancePercent}%
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{d.throughputPerDay}</td>
              </tr>
            ))}
            {deptRows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-muted">
                  No applications yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
      <p className="text-xs text-muted">Times count only working time: periods waiting on the applicant or on hold are excluded.</p>
    </div>
  );
}

/* ------------------------------------------------------------ outbox */
function Outbox() {
  const [channel, setChannel] = useState('');
  const data = useAsync(() => api.outbox({ channel, limit: 100 }), [channel]);
  return (
    <div className="space-y-4 p-5 lg:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Messages sent to citizens</h1>
          <p className="mt-1 text-sm text-muted">SMS, WhatsApp and email are simulated. This is exactly what each person would have received.</p>
        </div>
        <Select value={channel} onChange={e => setChannel(e.target.value)} className="w-40">
          <option value="">All channels</option>
          <option value="SMS">SMS</option>
          <option value="WHATSAPP">WhatsApp</option>
          <option value="EMAIL">Email</option>
        </Select>
      </div>
      {data.error && <ErrorNote error={data.error} />}
      {data.loading && !data.data ? (
        <Spinner />
      ) : !data.data?.length ? (
        <Empty title="No messages yet">Messages appear here when applications move, need documents or run late.</Empty>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {data.data.map(m => (
            <li key={m.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[140px_1fr_auto] sm:gap-4">
              <div>
                <Badge tone={m.channel === 'EMAIL' ? 'accent' : 'neutral'}>{m.channel === 'WHATSAPP' ? 'WhatsApp' : m.channel === 'SMS' ? 'SMS' : 'Email'}</Badge>
                <p className="mt-1 text-xs text-muted">{m.destination}</p>
              </div>
              <div className="min-w-0">
                {m.subject && <p className="text-[13px] font-medium">{m.subject}</p>}
                <p className="text-[13px] text-muted">{m.body}</p>
              </div>
              <p className="text-xs text-faint">{fmtDateTime(m.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ staff (admin) */
function Staff() {
  const toast = useToast();
  const staff = useAsync(() => Promise.all([api.staff(), api.adminDepartments()]), []);
  const [form, setForm] = useState({ role: 'OFFICER', departmentCode: '', name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const create = async e => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createStaff({ ...form, departmentCode: form.role === 'OFFICER' ? form.departmentCode : undefined });
      toast(`Account created for ${form.name}.`);
      setForm(f => ({ ...f, name: '', email: '', password: '' }));
      staff.reload();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const [users, depts] = staff.data || [[], []];
  return (
    <div className="grid gap-5 p-5 lg:grid-cols-[1fr_360px] lg:p-6">
      <Panel title="Staff accounts" bodyClassName="p-0">
        {staff.loading && !staff.data ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-line">
            {users.map(u => (
              <li key={u.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{u.name}</p>
                  <p className="truncate text-xs text-muted">{u.email}</p>
                </div>
                <p className="text-right text-xs text-muted">
                  {u.role.toLowerCase()}
                  {u.department ? `, ${u.department.name}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Add a staff account">
        <form className="space-y-3" onSubmit={create}>
          <Field label="Role">
            <Select value={form.role} onChange={set('role')}>
              <option value="OFFICER">Officer</option>
              <option value="SUPERVISOR">Supervisor</option>
              <option value="ADMIN">Administrator</option>
            </Select>
          </Field>
          {form.role === 'OFFICER' && (
            <Field label="Department">
              <Select required value={form.departmentCode} onChange={set('departmentCode')}>
                <option value="">Select a department</option>
                {depts.map(d => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Full name">
            <Input required minLength={2} value={form.name} onChange={set('name')} />
          </Field>
          <Field label="Email">
            <Input required type="email" value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Temporary password" hint="At least 8 characters.">
            <Input required minLength={8} type="password" value={form.password} onChange={set('password')} />
          </Field>
          <Button type="submit" variant="primary" loading={busy}>
            Create account
          </Button>
        </form>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------ page */
export default function Oversight({ user, tab, onTab }) {
  const [openCase, setOpenCase] = useState(null);

  if (openCase) {
    return (
      <div className="mx-auto max-w-[1400px]">
        <div className="px-5 pt-4 lg:px-6">
          <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => setOpenCase(null)}>
            Back to dashboard
          </Button>
        </div>
        <CaseWorkspace applicationId={openCase} user={user} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      {tab === 'overview' && <Overview user={user} onOpen={setOpenCase} />}
      {tab === 'simulation' && <SimulationRoom onOpen={setOpenCase} onShowDashboard={() => onTab('overview')} />}
      {tab === 'messages' && <Outbox />}
      {tab === 'staff' && user.role === 'ADMIN' && <Staff />}
    </div>
  );
}
