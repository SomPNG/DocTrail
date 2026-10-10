import { useEffect, useMemo, useState } from 'react';
import { Check, FileQuestion, Hand, Pause, Play, RotateCcw, Send, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { countdown, fmtDate, fmtHours, REASON, RESPONSIBLE, SEVERITY_TONE, SLA, STATUS, useServerNow } from '../lib/format.js';
import { Badge, Button, Dialog, ErrorNote, Field, Input, Panel, Spinner, Textarea, cx, toneText, useToast } from './ui.jsx';
import RouteLine from './RouteLine.jsx';
import { DocumentList, EventTimeline } from './Records.jsx';

/** Live countdown for the active stage (frozen while paused). */
export function StageClock({ timing, paused }) {
  const now = useServerNow(1000);
  if (!timing) return null;
  const late = timing.overdueHours > 0 || timing.slaStatus === 'BREACHED';
  return (
    <div className="text-right">
      <p className={cx('text-2xl font-semibold tabular-nums tracking-tight', paused ? 'text-paused' : late ? 'text-bad' : timing.slaStatus === 'AT_RISK' ? 'text-warn' : 'text-ink')}>
        {paused ? 'Paused' : countdown(timing.deadline, now).replace('-', '')}
      </p>
      <p className="text-xs text-muted">
        {paused
          ? `${fmtHours(timing.remainingHours)} left when it resumes`
          : late
            ? `Overdue against the ${fmtHours(timing.targetHours)} target for this stage`
            : `Left of the ${fmtHours(timing.targetHours)} target, due ${fmtDate(timing.deadline)}`}
      </p>
    </div>
  );
}

const DIALOGS = {
  request: { title: 'Request a document', confirm: 'Send request' },
  hold: { title: 'Put on hold', confirm: 'Put on hold' },
  return: { title: 'Return for correction', confirm: 'Return to applicant' },
  reject: { title: 'Reject application', confirm: 'Reject' },
};

export default function CaseWorkspace({ applicationId, user, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [checks, setChecks] = useState({});
  const [busy, setBusy] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    setError(null);
    try {
      const [app, checklist, timeline, docs] = await Promise.all([
        api.application(applicationId),
        api.checklists(applicationId),
        api.timeline(applicationId),
        api.documents(applicationId),
      ]);
      let comp = null;
      if (app.compensationStatus === 'ELIGIBLE_PENDING_APPROVAL' && (user.role === 'SUPERVISOR' || user.role === 'ADMIN')) {
        comp = await api.compensation(applicationId).catch(() => null);
      }
      setData({ app, checklist, timeline, docs, comp });
    } catch (e) {
      setError(e);
    }
  };

  useEffect(() => {
    setData(null);
    setChecks({});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationId]);

  const app = data?.app;
  const d = app?.diagnosis;
  const active = app?.stageInstances?.find(i => i.status === 'ACTIVE');
  const isOpen = app && app.status !== 'COMPLETED' && app.status !== 'REJECTED';
  const canAct =
    isOpen && (user.role === 'SUPERVISOR' || (user.role === 'OFFICER' && user.departmentCode === app.currentStage?.departmentCode));
  const paused = !!active?.pausedAt;
  const pendingDocs = data?.docs?.requests?.filter(r => r.status === 'PENDING') ?? [];

  const isFinal = useMemo(() => {
    if (!app?.currentStage) return false;
    const stages = (app.service?.stages || []).filter(s => s.isActive !== false);
    return app.currentStage.isFinalStage || stages[stages.length - 1]?.id === app.currentStageId;
  }, [app]);

  const items = data?.checklist?.items ?? [];
  const mandatoryDone = items.filter(i => i.isMandatory).every(i => checks[i.id]);
  const checkedIds = items.filter(i => checks[i.id]).map(i => i.id);

  const run = async (key, fn, success) => {
    setBusy(key);
    try {
      await fn();
      toast(success);
      setDialog(null);
      setForm({});
      setChecks({});
      await load();
      onChanged?.();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const submitDialog = () => {
    const reason = form.reason?.trim();
    if (dialog === 'request')
      return run('dialog', () => api.requestDocument(applicationId, { documentType: form.documentType, title: form.title, reason }), 'Document requested. The clock is paused until the applicant uploads it.');
    if (dialog === 'hold') return run('dialog', () => api.hold(applicationId, reason), 'Put on hold. The clock is paused.');
    if (dialog === 'return')
      return run('dialog', () => api.decide(applicationId, { decisionType: 'RETURNED_FOR_CORRECTION', reason }), 'Returned to the applicant for correction.');
    if (dialog === 'reject') return run('dialog', () => api.decide(applicationId, { decisionType: 'REJECTED', reason }), 'Application rejected.');
  };

  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={load} /></div>;
  if (!data) return <Spinner label="Loading application" />;

  const sla = SLA[app.slaStatus] || SLA.ON_TRACK;
  const reason = REASON[d?.reasonCode] || REASON.ON_TRACK;
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="space-y-5 p-5 lg:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{app.trackingNumber}</h1>
            <Badge tone={sla.tone}>{sla.label}</Badge>
            <Badge>{STATUS[app.status]}</Badge>
            {app.isSimulated && <Badge tone="accent">Simulated</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            {app.service?.name}, {app.applicantName}
            {app.citizen?.phone ? `, ${app.citizen.phone}` : ''}. Submitted {fmtDate(app.createdAt)}.
          </p>
        </div>
        {isOpen && <StageClock timing={d?.timing} paused={paused} />}
      </div>

      {/* Where and why */}
      <div className="rounded-lg border border-line bg-surface p-5">
        <RouteLine pipeline={d?.pipeline} paused={paused} closed={!isOpen} />
        {isOpen && d && (
          <div className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-[1fr_auto]">
            <div>
              <p className={cx('text-sm font-semibold', toneText[SEVERITY_TONE[d.severity]] || 'text-ink')}>
                {reason.label} at {d.location?.departmentName}
              </p>
              <p className="mt-1 text-sm text-muted">{d.officerMessage}</p>
              {d.recommendedAction && <p className="mt-2 text-sm">Next step: {d.recommendedAction}.</p>}
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:text-right">
              <dt className="text-muted">Responsible</dt>
              <dd className="font-medium">{RESPONSIBLE[d.responsibleParty]}</dd>
              <dt className="text-muted">Assigned to</dt>
              <dd className="font-medium">{d.location?.assignedOfficer || 'Nobody yet'}</dd>
              <dt className="text-muted">Queue position</dt>
              <dd className="font-medium">
                {d.queue?.position ? `${d.queue.position} of ${d.queue.waitingInDepartment}` : '–'}
              </dd>
              <dt className="text-muted">Idle for</dt>
              <dd className="font-medium">{fmtHours(d.timing?.idleHours)}</dd>
            </dl>
          </div>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.15fr_1fr]">
        <div className="space-y-5">
          {/* Actions */}
          {canAct && (
            <Panel
              title={`Verification: ${data.checklist?.stageName || app.currentStage?.name}`}
              action={
                !active?.assignedOfficer && (
                  <Button size="sm" icon={Hand} loading={busy === 'assign'} onClick={() => run('assign', () => api.assign(applicationId), 'Assigned to you.')}>
                    Assign to me
                  </Button>
                )
              }
            >
              {paused ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-paused-soft px-3 py-2.5">
                  <p className="text-sm text-paused">
                    {pendingDocs.length
                      ? `Waiting for the applicant to upload ${pendingDocs.length} document(s). The clock resumes automatically.`
                      : `On hold: ${active.holdReason || 'no reason recorded'}.`}
                  </p>
                  {!pendingDocs.length && active.holdType !== 'CORRECTION' && (
                    <Button size="sm" icon={Play} loading={busy === 'resume'} onClick={() => run('resume', () => api.resume(applicationId, 'Resumed by officer'), 'Processing resumed.')}>
                      Resume
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  <ul className="space-y-1">
                    {items.map(item => (
                      <li key={item.id}>
                        <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-paper">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 accent-[#22408c]"
                            checked={!!checks[item.id]}
                            onChange={e => setChecks(c => ({ ...c, [item.id]: e.target.checked }))}
                          />
                          <span className="text-[13px] leading-snug">
                            {item.label}
                            {!item.isMandatory && <span className="text-muted"> (optional)</span>}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                    {isFinal ? (
                      <Button
                        variant="primary"
                        icon={ShieldCheck}
                        disabled={!mandatoryDone}
                        loading={busy === 'forward'}
                        onClick={() => run('forward', () => api.decide(applicationId, { decisionType: 'APPROVED', reason: 'Final approval granted', checklistResponses: checkedIds }), 'Application approved.')}
                      >
                        Approve application
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        icon={Send}
                        disabled={!mandatoryDone}
                        loading={busy === 'forward'}
                        onClick={() => run('forward', () => api.forward(applicationId, { remarks: 'Verified', checklistResponses: checkedIds }), 'Forwarded to the next department.')}
                      >
                        Verify and forward
                      </Button>
                    )}
                    {!mandatoryDone && <span className="text-xs text-muted">Tick every required check to continue.</span>}
                  </div>
                </>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" icon={FileQuestion} onClick={() => setDialog('request')}>
                  Request document
                </Button>
                {!paused && (
                  <Button size="sm" icon={Pause} onClick={() => setDialog('hold')}>
                    Put on hold
                  </Button>
                )}
                <Button size="sm" icon={Undo2} onClick={() => setDialog('return')}>
                  Return for correction
                </Button>
                <Button size="sm" variant="danger" icon={XCircle} onClick={() => setDialog('reject')}>
                  Reject
                </Button>
              </div>
            </Panel>
          )}

          {isOpen && !canAct && user.role === 'OFFICER' && (
            <p className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-muted">
              This file is with {app.currentStage?.department?.name || app.currentStage?.departmentCode}. You can view it, but only that
              department can act on it.
            </p>
          )}

          {data.comp?.record && data.comp.record.status === 'ELIGIBLE_PENDING_APPROVAL' && (
            <Panel title="Delay compensation claim">
              <p className="text-sm">
                ₹{data.comp.record.standardCompensationAmount} for {data.comp.breachDays} day(s) of delay at ₹{data.comp.ratePerDay} per day.
              </p>
              <p className="mt-1 text-xs text-muted">{data.comp.record.remarks}</p>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  icon={Check}
                  loading={busy === 'comp'}
                  onClick={() => run('comp', () => api.reviewCompensation(applicationId, { recordId: data.comp.record.id, action: 'APPROVE' }), 'Compensation approved.')}
                >
                  Approve claim
                </Button>
                <Button
                  size="sm"
                  icon={RotateCcw}
                  onClick={() => run('comp', () => api.reviewCompensation(applicationId, { recordId: data.comp.record.id, action: 'REJECT' }), 'Compensation claim rejected.')}
                >
                  Reject claim
                </Button>
              </div>
            </Panel>
          )}

          <Panel title="Documents">
            <DocumentList applicationId={applicationId} documents={data.docs?.documents} requests={data.docs?.requests} />
          </Panel>
        </div>

        <Panel title="Audit trail">
          <EventTimeline events={data.timeline} />
        </Panel>
      </div>

      <Dialog
        open={!!dialog}
        title={DIALOGS[dialog]?.title}
        onClose={() => {
          setDialog(null);
          setForm({});
        }}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant={dialog === 'reject' ? 'danger' : 'primary'}
              loading={busy === 'dialog'}
              disabled={!form.reason || form.reason.trim().length < 3 || (dialog === 'request' && (!form.title || !form.documentType))}
              onClick={submitDialog}
            >
              {DIALOGS[dialog]?.confirm}
            </Button>
          </>
        }
      >
        {dialog === 'request' && (
          <>
            <Field label="Document name">
              <Input value={form.title || ''} onChange={set('title')} placeholder="Address proof (utility bill)" />
            </Field>
            <Field label="Document type" hint="A short code, for example address_proof.">
              <Input value={form.documentType || ''} onChange={e => setForm(f => ({ ...f, documentType: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_') }))} placeholder="address_proof" />
            </Field>
          </>
        )}
        <Field
          label={dialog === 'request' ? 'Why it is needed' : 'Reason'}
          hint={dialog === 'reject' ? 'The applicant sees this reason.' : dialog === 'return' ? 'Tell the applicant exactly what to fix.' : undefined}
        >
          <Textarea value={form.reason || ''} onChange={set('reason')} />
        </Field>
      </Dialog>
    </div>
  );
}
