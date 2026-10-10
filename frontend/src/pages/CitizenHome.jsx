import { useEffect, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { api } from '../lib/api.js';
import { fmtDate, fmtDateTime, fmtHours, REASON, SLA, STATUS } from '../lib/format.js';
import { Badge, Button, Empty, ErrorNote, Field, Input, Panel, Select, Spinner, Textarea, cx, useAsync, useToast } from '../components/ui.jsx';
import RouteLine from '../components/RouteLine.jsx';
import { DocumentList, PublicTimeline } from '../components/Records.jsx';
import { StageClock } from '../components/CaseWorkspace.jsx';

/* ------------------------------------------------------------ new application */
function NewApplication({ user, onCreated }) {
  const toast = useToast();
  const services = useAsync(() => api.services(), []);
  const [mode, setMode] = useState('upload');
  const [file, setFile] = useState(null);
  const [notes, setNotes] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [name, setName] = useState(user.name.replace(/\s*\(.*\)$/, ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async e => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'upload') {
        const fd = new FormData();
        fd.append('file', file);
        if (notes) fd.append('notes', notes);
        const res = await api.uploadAndRoute(fd);
        toast(`Application ${res.application.trackingNumber} sent to ${res.receivingDepartment.name}.`);
        onCreated(res.application.id);
      } else {
        const app = await api.createApplication({ serviceKey, applicantName: name });
        toast(`Application ${app.trackingNumber} submitted.`);
        onCreated(app.id);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const selected = services.data?.find(s => s.key === serviceKey);

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Start a new application</h1>
        <p className="mt-1 text-sm text-muted">Upload your filled-in form and we will route it, or pick the service yourself.</p>
      </div>

      <div className="inline-flex rounded-md border border-line bg-surface p-0.5">
        {[
          ['upload', 'Upload a form'],
          ['manual', 'Choose a service'],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setMode(k)}
            className={cx('rounded px-3 py-1.5 text-[13px] font-medium', mode === k ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-4 rounded-lg border border-line bg-surface p-5">
        {mode === 'upload' ? (
          <>
            <Field label="Application form" hint="PDF, PNG, JPG or TXT, up to 15 MB. We read the form to find the right department.">
              <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-line-strong px-4 py-8 text-center hover:bg-paper">
                <Upload className="size-5 text-muted" />
                <span className="text-sm">{file ? file.name : 'Select a file'}</span>
                <input type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" className="sr-only" onChange={e => setFile(e.target.files?.[0] || null)} />
              </label>
            </Field>
            <Field label="Note for the office (optional)">
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Service">
              <Select required value={serviceKey} onChange={e => setServiceKey(e.target.value)}>
                <option value="">Select a service</option>
                {services.data?.map(s => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            {selected && (
              <div className="rounded-md bg-paper px-3 py-2.5">
                <p className="text-xs text-muted">Your file will pass through</p>
                <p className="mt-1 text-[13px]">
                  {selected.stages.map(s => `${s.department?.name || s.departmentCode} (${fmtHours(s.slaHours)})`).join(', then ')}
                </p>
              </div>
            )}
            <Field label="Applicant name">
              <Input required minLength={2} value={name} onChange={e => setName(e.target.value)} />
            </Field>
          </>
        )}
        <ErrorNote error={error} />
        <Button type="submit" variant="primary" loading={busy} disabled={mode === 'upload' ? !file : !serviceKey}>
          Submit application
        </Button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------ one application */
function UploadRequested({ applicationId, request, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const upload = async file => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const stored = await api.uploadFile(fd);
      await api.submitDocument(applicationId, {
        documentRequestId: request.id,
        documentType: request.documentType,
        title: request.title,
        fileUrl: stored.fileUrl,
        fileHash: stored.fileHash,
      });
      toast(`${request.title} uploaded. Processing continues.`);
      onDone();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warn/30 bg-warn-soft px-4 py-3">
      <div>
        <p className="text-sm font-medium">{request.title}</p>
        <p className="text-xs text-muted">
          {request.reason}. Requested {fmtDateTime(request.requestedAt)}.
        </p>
      </div>
      <label className={cx('inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-white', busy && 'opacity-60')}>
        <Upload className="size-4" />
        {busy ? 'Uploading' : 'Upload'}
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" className="sr-only" disabled={busy} onChange={e => upload(e.target.files?.[0])} />
      </label>
    </div>
  );
}

function Resubmit({ applicationId, onDone }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-paused/30 bg-paused-soft px-4 py-3">
      <Field label="What did you correct?">
        <Textarea rows={2} value={text} onChange={e => setText(e.target.value)} placeholder="Added my date of birth" />
      </Field>
      <Button
        size="sm"
        variant="primary"
        loading={busy}
        disabled={text.trim().length < 3}
        onClick={async () => {
          setBusy(true);
          try {
            await api.resubmit(applicationId, { remarks: text, applicantDetails: { correction: text } });
            toast('Resubmitted. The office has been told.');
            onDone();
          } catch (e) {
            toast(e.message, 'bad');
          } finally {
            setBusy(false);
          }
        }}
      >
        Resubmit application
      </Button>
    </div>
  );
}

function Tracking({ applicationId, onChanged }) {
  const t = useAsync(() => Promise.all([api.tracking(applicationId), api.documents(applicationId)]), [applicationId]);
  if (t.loading && !t.data) return <Spinner label="Loading your application" />;
  if (t.error) return <div className="p-6"><ErrorNote error={t.error} onRetry={t.reload} /></div>;
  const [tr, docs] = t.data;
  const closed = tr.status === 'COMPLETED' || tr.status === 'REJECTED';
  const paused = tr.timing?.slaStatus === 'PAUSED';
  const pending = docs.requests.filter(r => r.status === 'PENDING');
  const reload = () => {
    t.reload();
    onChanged();
  };
  const why = REASON[tr.why.reasonCode] || REASON.ON_TRACK;

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{tr.trackingNumber}</h1>
            <Badge tone={closed ? (tr.status === 'COMPLETED' ? 'ok' : 'bad') : (SLA[tr.timing?.slaStatus] || SLA.ON_TRACK).tone}>
              {closed ? STATUS[tr.status] : (SLA[tr.timing?.slaStatus] || SLA.ON_TRACK).label}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            {tr.serviceName} for {tr.applicantName}. Submitted {fmtDate(tr.submittedAt)}.
          </p>
        </div>
        {!closed && <StageClock timing={tr.timing} paused={paused} />}
      </div>

      <div className="rounded-lg border border-line bg-surface p-5">
        <RouteLine pipeline={tr.pipeline} paused={paused} closed={closed} />
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-sm font-semibold">{closed ? STATUS[tr.status] : `${why.label}${tr.whereIsIt ? ` at ${tr.whereIsIt.departmentName}` : ''}`}</p>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{tr.why.message}</p>
          {tr.compensationStatus && tr.compensationStatus !== 'NONE' && (
            <p className="mt-2 text-sm">
              Delay compensation:{' '}
              <span className="font-medium">
                {{ ELIGIBLE_PENDING_APPROVAL: 'claim created, waiting for approval', APPROVED: 'approved', REJECTED: 'not approved', PAID: 'paid' }[tr.compensationStatus]}
              </span>
            </p>
          )}
        </div>
      </div>

      {pending.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">The office needs from you</h2>
          {pending.map(r => (
            <UploadRequested key={r.id} applicationId={applicationId} request={r} onDone={reload} />
          ))}
        </section>
      )}
      {tr.why.reasonCode === 'RETURNED_FOR_CORRECTION' && <Resubmit applicationId={applicationId} onDone={reload} />}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="What has happened">
          <PublicTimeline items={tr.timeline} />
        </Panel>
        <Panel title="Your documents">
          <DocumentList applicationId={applicationId} documents={docs.documents} requests={[]} />
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ page */
export default function CitizenHome({ user }) {
  const list = useAsync(() => api.listApplications(), []);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (selected === null && list.data?.length) setSelected(list.data[0].id);
  }, [list.data, selected]);

  const apps = list.data || [];

  return (
    <div className="mx-auto grid max-w-[1400px] lg:grid-cols-[320px_1fr]">
      <aside className="border-b border-line lg:min-h-[calc(100vh-3.5rem)] lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-4 py-4">
          <h2 className="text-sm font-semibold">Your applications</h2>
          <Button size="sm" icon={Plus} variant={selected === 'new' ? 'primary' : 'secondary'} onClick={() => setSelected('new')}>
            New
          </Button>
        </div>
        {list.loading && !list.data ? (
          <Spinner />
        ) : apps.length === 0 ? (
          <Empty title="No applications yet">Start one by uploading your form.</Empty>
        ) : (
          <ul className="space-y-1 px-2 pb-4">
            {apps.map(a => {
              const closed = a.status === 'COMPLETED' || a.status === 'REJECTED';
              const s = SLA[a.slaStatus] || SLA.ON_TRACK;
              return (
                <li key={a.id}>
                  <button
                    onClick={() => setSelected(a.id)}
                    className={cx('w-full rounded-md px-3 py-2.5 text-left', selected === a.id ? 'bg-accent-soft' : 'hover:bg-surface')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold">{a.trackingNumber}</span>
                      <Badge tone={closed ? 'neutral' : s.tone}>{closed ? STATUS[a.status] : s.label}</Badge>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted">{a.service?.name}</p>
                    {!closed && <p className="truncate text-xs text-muted">At {a.currentStage?.department?.name || a.currentStage?.name}</p>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <main className="min-w-0">
        {selected === 'new' ? (
          <NewApplication
            user={user}
            onCreated={id => {
              list.reload();
              setSelected(id);
            }}
          />
        ) : selected ? (
          <Tracking key={selected} applicationId={selected} onChanged={list.reload} />
        ) : (
          !list.loading && (
            <Empty title="Track an application" action={<Button variant="primary" icon={Plus} onClick={() => setSelected('new')}>Start an application</Button>}>
              Your applications appear here with where they are and what happens next.
            </Empty>
          )
        )}
      </main>
    </div>
  );
}
