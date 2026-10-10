import { useState } from 'react';
import { FastForward, Play, RotateCcw, SkipForward, Trash2, Database, ExternalLink } from 'lucide-react';
import { api } from '../lib/api.js';
import { fmtDateTime, fmtHours, REASON, SEVERITY_TONE, SLA, useServerNow } from '../lib/format.js';
import { Badge, Button, Field, Input, Panel, Select, cx, toneText, useAsync, useToast } from '../components/ui.jsx';

function ClockPanel({ onChanged }) {
  const toast = useToast();
  const now = useServerNow(1000);
  const [busy, setBusy] = useState(null);
  const ahead = (now.getTime() - Date.now()) / 3_600_000;

  const advance = async hours => {
    setBusy(hours);
    try {
      const r = await api.simAdvance(hours);
      toast(`Moved ${fmtHours(hours)} ahead. ${r.scan.newlyBreached.length} file(s) newly overdue, ${r.scan.remindersSent} reminder(s) sent.`);
      onChanged?.();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Clock">
      <p className="text-2xl font-semibold tabular-nums tracking-tight">{fmtDateTime(now)}</p>
      <p className="text-xs text-muted">
        {Math.abs(ahead) < 0.05 ? 'Real time.' : `${ahead > 0 ? 'Ahead of' : 'Behind'} real time by ${fmtHours(Math.abs(ahead))}.`} Deadlines,
        reminders and escalations all follow this clock.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {[6, 24, 72].map(h => (
          <Button key={h} size="sm" icon={FastForward} loading={busy === h} onClick={() => advance(h)}>
            {h < 24 ? `${h} hours` : `${h / 24} day${h > 24 ? 's' : ''}`}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          icon={RotateCcw}
          loading={busy === 'reset'}
          onClick={async () => {
            setBusy('reset');
            try {
              await api.simResetClock();
              toast('Back to real time.');
              onChanged?.();
            } catch (e) {
              toast(e.message, 'bad');
            } finally {
              setBusy(null);
            }
          }}
        >
          Back to real time
        </Button>
      </div>
    </Panel>
  );
}

function StoryPanel({ onOpen }) {
  const toast = useToast();
  const stories = useAsync(() => api.simStories(), []);
  const [key, setKey] = useState('stuck_at_police');
  const [steps, setSteps] = useState([]);
  const [busy, setBusy] = useState(false);
  const current = stories.data?.find(s => s.key === key);
  const last = steps[steps.length - 1];

  const go = async start => {
    setBusy(true);
    try {
      const step = start ? await api.simStartStory(key) : await api.simNextStep();
      setSteps(s => (start ? [step] : [...s, step]));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Follow one application">
      <p className="text-sm text-muted">Step through a scripted journey. Each step moves the clock forward and acts as the right officer or citizen.</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Story">
          <Select value={key} onChange={e => setKey(e.target.value)} className="min-w-64">
            {stories.data?.map(s => (
              <option key={s.key} value={s.key}>
                {s.title}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" icon={Play} loading={busy && !steps.length} onClick={() => go(true)}>
          Start
        </Button>
        {steps.length > 0 && !last?.done && (
          <Button icon={SkipForward} loading={busy && steps.length > 0} onClick={() => go(false)}>
            Next step
          </Button>
        )}
        {last?.applicationId && (
          <Button variant="ghost" icon={ExternalLink} onClick={() => onOpen(last.applicationId)}>
            Open {last.trackingNumber}
          </Button>
        )}
      </div>
      {current && !steps.length && <p className="mt-3 text-[13px] text-muted">{current.description}</p>}

      {steps.length > 0 && (
        <ol className="mt-4 space-y-3 border-l border-line pl-4">
          {steps.map(s => {
            const snap = s.snapshot;
            const tone = SEVERITY_TONE[snap?.severity] || 'neutral';
            return (
              <li key={s.stepIndex} className="relative">
                <span className={cx('absolute -left-[21px] top-1.5 size-2 rounded-full', s === last ? 'bg-accent' : 'bg-line-strong')} />
                <p className="text-xs text-faint">
                  Step {s.stepIndex + 1} of {s.totalSteps}, {fmtDateTime(s.clock.now)}
                </p>
                <p className="text-[13px]">{s.narration}</p>
                {snap && (
                  <p className="mt-0.5 text-xs">
                    <span className="text-muted">{snap.where}. </span>
                    <span className={cx('font-medium', toneText[tone])}>{(REASON[snap.reasonCode] || { label: snap.reason }).label}</span>
                    <span className="text-muted">
                      , {(SLA[snap.slaStatus] || { label: snap.slaStatus }).label.toLowerCase()}, {fmtHours(snap.activeHours)} of {fmtHours(snap.targetHours)}
                    </span>
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {last?.done && <p className="mt-3 text-sm font-medium">Story finished. Open the application to see its full record.</p>}
    </Panel>
  );
}

function ScenarioPanel({ onShowDashboard }) {
  const toast = useToast();
  const scenarios = useAsync(() => api.simScenarios(), []);
  const [key, setKey] = useState('police_backlog');
  const [days, setDays] = useState(8);
  const [seed, setSeed] = useState(7);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const current = scenarios.data?.find(s => s.key === key);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.simRunScenario(key, { days: Number(days), seed: Number(seed) || undefined });
      setResult(r);
      toast(`Simulated ${r.simulatedHours} hours: ${r.stats.created} applications, ${r.stuck.count} stuck.`);
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Simulate a department under pressure">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Scenario">
          <Select value={key} onChange={e => setKey(e.target.value)} className="min-w-56">
            {scenarios.data?.map(s => (
              <option key={s.key} value={s.key}>
                {s.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Days">
          <Input type="number" min={1} max={30} value={days} onChange={e => setDays(e.target.value)} className="w-20" />
        </Field>
        <Field label="Seed">
          <Input type="number" min={1} value={seed} onChange={e => setSeed(e.target.value)} className="w-24" />
        </Field>
        <Button variant="primary" icon={Play} loading={busy} onClick={run}>
          Run
        </Button>
      </div>
      {current && (
        <div className="mt-3 space-y-1 text-[13px]">
          <p className="text-muted">{current.description}</p>
          <p>
            <span className="text-muted">What to look for: </span>
            {current.expectedOutcome}
          </p>
        </div>
      )}
      {busy && <p className="mt-3 text-xs text-muted">Running. Longer runs can take a minute.</p>}

      {result && (
        <div className="mt-5 space-y-4 border-t border-line pt-4">
          <p className="text-sm">
            {result.stats.created} applications arrived, {result.stats.forwarded} moves between departments, {result.stats.completed} approved,{' '}
            {result.stats.docRequests} document requests. {result.stuck.count} files are stuck now.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(result.stuck.byReason).map(([code, n]) => (
              <Badge key={code} tone={(REASON[code] || {}).tone || 'neutral'}>
                {(REASON[code] || { label: code }).label}: {n}
              </Badge>
            ))}
          </div>
          <div>
            <p className="mb-2 text-[13px] font-semibold">Top bottlenecks</p>
            <ul className="divide-y divide-line">
              {result.topBottlenecks.map(b => (
                <li key={`${b.stage}-${b.department}`} className="flex items-start justify-between gap-4 py-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">
                      {b.stage} <span className="font-normal text-muted">at {b.department}</span>
                    </p>
                    <p className="text-xs text-muted">{b.explanation}</p>
                  </div>
                  <span className={cx('text-sm font-semibold tabular-nums', b.score >= 60 ? 'text-bad' : b.score >= 40 ? 'text-warn' : 'text-ok')}>{b.score}</span>
                </li>
              ))}
            </ul>
          </div>
          {result.stuck.top?.length > 0 && (
            <div>
              <p className="mb-2 text-[13px] font-semibold">Most urgent files</p>
              <ul className="space-y-1">
                {result.stuck.top.map(s => (
                  <li key={s.trackingNumber} className="text-xs">
                    <span className="font-medium">{s.trackingNumber}</span> <span className="text-muted">{s.citizenMessage}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={onShowDashboard}>
            See it on the dashboard
          </Button>
        </div>
      )}
    </Panel>
  );
}

function DataPanel() {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const act = async (key, fn, msg, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key);
    try {
      const r = await fn();
      toast(typeof msg === 'function' ? msg(r) : msg);
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel title="Demo data">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <p className="text-[13px] text-muted">Create about ten days of realistic history ending now, plus three example journeys.</p>
          <Button size="sm" icon={Database} loading={busy === 'samples'} onClick={() => act('samples', () => api.simSamples({ days: 10 }), r => `Created ${r.stats.created} sample applications.`)}>
            Generate
          </Button>
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-line pt-3">
          <p className="text-[13px] text-muted">Remove simulated applications only and return to real time.</p>
          <Button size="sm" icon={RotateCcw} loading={busy === 'sim'} onClick={() => act('sim', () => api.simReset(), r => `Removed ${r.removedApplications} simulated applications.`)}>
            Remove
          </Button>
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-line pt-3">
          <p className="text-[13px] text-muted">Delete every application, document and message. Accounts and services stay.</p>
          <Button
            size="sm"
            variant="danger"
            icon={Trash2}
            loading={busy === 'wipe'}
            onClick={() => act('wipe', () => api.demoReset(false), 'All applications deleted.', 'Delete every application, document and message?')}
          >
            Delete all
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export default function SimulationRoom({ onOpen, onShowDashboard }) {
  const [, setTick] = useState(0);
  return (
    <div className="grid gap-5 p-5 lg:grid-cols-[1.3fr_1fr] lg:p-6">
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Simulation</h1>
          <p className="mt-1 text-sm text-muted">
            Fast-forward time and play out delays. Everything here runs through the real workflow, so the dashboards, queues and messages update as they
            would in production.
          </p>
        </div>
        <StoryPanel onOpen={id => onOpen(id)} />
        <ScenarioPanel onShowDashboard={onShowDashboard} />
      </div>
      <div className="space-y-5">
        <ClockPanel onChanged={() => setTick(t => t + 1)} />
        <DataPanel />
      </div>
    </div>
  );
}
