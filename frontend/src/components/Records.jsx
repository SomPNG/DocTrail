import { useState } from 'react';
import { FileText, ExternalLink } from 'lucide-react';
import { api } from '../lib/api.js';
import { fmtDateTime } from '../lib/format.js';
import { Badge, cx, useToast } from './ui.jsx';

const EVENT_LABEL = {
  APPLICATION_CREATED: 'Application submitted',
  STAGE_ENTERED: 'Entered stage',
  STAGE_ASSIGNED: 'Officer assigned',
  STAGE_COMPLETED: 'Stage completed',
  APPLICATION_FORWARDED: 'Forwarded',
  DOCUMENT_REQUESTED: 'Document requested',
  DOCUMENT_SUBMITTED: 'Document received',
  DOCUMENT_REMINDER_SENT: 'Reminder sent',
  SLA_PAUSED: 'Clock paused',
  SLA_RESUMED: 'Clock resumed',
  SLA_WARNING: 'Close to deadline',
  SLA_BREACHED: 'Deadline missed',
  ESCALATED: 'Escalated to supervisor',
  DECISION_RECORDED: 'Decision recorded',
  APPLICATION_HELD: 'Put on hold',
  APPLICATION_RETURNED: 'Returned for correction',
  APPLICATION_RESUBMITTED: 'Resubmitted by applicant',
  APPLICATION_APPROVED: 'Approved',
  APPLICATION_REJECTED: 'Not approved',
  COMPENSATION_ELIGIBLE: 'Compensation claim created',
  EXTERNAL_UPDATE: 'Update from external system',
};

const EVENT_TONE = { SLA_BREACHED: 'bad', ESCALATED: 'bad', SLA_WARNING: 'warn', SLA_PAUSED: 'paused', APPLICATION_APPROVED: 'ok', APPLICATION_REJECTED: 'bad' };

function eventDetail(e) {
  const m = e.metadata || {};
  switch (e.eventType) {
    case 'STAGE_ENTERED':
      return m.stageName;
    case 'APPLICATION_FORWARDED':
      return `${m.fromStage} to ${m.toStage}`;
    case 'DOCUMENT_REQUESTED':
    case 'DOCUMENT_SUBMITTED':
    case 'DOCUMENT_REMINDER_SENT':
      return m.title;
    case 'SLA_PAUSED':
    case 'APPLICATION_HELD':
    case 'APPLICATION_RETURNED':
    case 'APPLICATION_REJECTED':
      return m.reason;
    case 'STAGE_COMPLETED':
      return m.remarks || m.stageName;
    case 'DECISION_RECORDED':
      return `${m.decisionType}${m.reason ? `: ${m.reason}` : ''}`;
    case 'COMPENSATION_ELIGIBLE':
      return `₹${m.amount}`;
    case 'EXTERNAL_UPDATE':
      return `${m.sourceSystem}: ${m.rawEventType}${m.externalStatus ? ` (${m.externalStatus})` : ''}`;
    case 'SLA_BREACHED':
      return m.stage;
    default:
      return null;
  }
}

/** Staff audit trail (raw events, newest last). */
export function EventTimeline({ events = [] }) {
  if (!events.length) return <p className="text-sm text-muted">No events yet.</p>;
  return (
    <ol className="relative space-y-3 border-l border-line pl-4">
      {events.map(e => {
        const tone = EVENT_TONE[e.eventType];
        const detail = eventDetail(e);
        return (
          <li key={e.id} className="relative">
            <span
              className={cx(
                'absolute -left-[21px] top-1.5 size-2 rounded-full',
                tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-warn' : tone === 'ok' ? 'bg-ok' : tone === 'paused' ? 'bg-paused' : 'bg-line-strong'
              )}
            />
            <p className="text-[13px] font-medium">{EVENT_LABEL[e.eventType] || e.eventType}</p>
            {detail && <p className="text-[13px] text-muted">{detail}</p>}
            <p className="text-xs text-faint">
              {fmtDateTime(e.timestamp)}
              {e.actorRole ? `, ${e.actorRole.toLowerCase().replace(/_/g, ' ')}` : ''}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/** Citizen-facing plain-language timeline from /tracking. */
export function PublicTimeline({ items = [] }) {
  if (!items.length) return <p className="text-sm text-muted">Nothing has happened yet.</p>;
  return (
    <ol className="relative space-y-3 border-l border-line pl-4">
      {[...items].reverse().map((t, i) => (
        <li key={i} className="relative">
          <span
            className={cx(
              'absolute -left-[21px] top-1.5 size-2 rounded-full',
              t.kind === 'SLA_BREACHED' ? 'bg-bad' : t.kind === 'APPLICATION_APPROVED' ? 'bg-ok' : i === 0 ? 'bg-accent' : 'bg-line-strong'
            )}
          />
          <p className="text-[13px]">{t.text}</p>
          <p className="text-xs text-faint">{fmtDateTime(t.at)}</p>
        </li>
      ))}
    </ol>
  );
}

/** Documents on file; uploaded files open through a short-lived signed link. */
export function DocumentList({ applicationId, documents = [], requests = [] }) {
  const toast = useToast();
  const [opening, setOpening] = useState(null);

  const open = async doc => {
    if (!doc.fileUrl?.startsWith('/uploads/')) {
      if (/^https?:\/\//.test(doc.fileUrl)) window.open(doc.fileUrl, '_blank', 'noopener');
      else toast('This document is a simulated record and has no file to open.', 'bad');
      return;
    }
    setOpening(doc.id);
    try {
      const { viewUrl } = await api.viewToken(applicationId, doc.id);
      window.open(viewUrl, '_blank', 'noopener');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setOpening(null);
    }
  };

  const pending = requests.filter(r => r.status === 'PENDING');
  return (
    <div className="space-y-3">
      {pending.length > 0 && (
        <ul className="space-y-1.5">
          {pending.map(r => (
            <li key={r.id} className="flex items-start justify-between gap-3 rounded-md border border-warn/30 bg-warn-soft px-3 py-2">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{r.title}</p>
                <p className="text-xs text-muted">{r.reason}</p>
              </div>
              <Badge tone="warn">Requested {fmtDateTime(r.requestedAt)}</Badge>
            </li>
          ))}
        </ul>
      )}
      {documents.length === 0 ? (
        <p className="text-sm text-muted">No documents on file.</p>
      ) : (
        <ul className="divide-y divide-line">
          {documents.map(d => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="size-4 shrink-0 text-muted" />
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{d.title}</p>
                  <p className="text-xs text-muted">
                    {d.documentType.replace(/_/g, ' ')}, {fmtDateTime(d.createdAt)}
                  </p>
                </div>
              </div>
              <button
                onClick={() => open(d)}
                disabled={opening === d.id}
                className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
              >
                Open <ExternalLink className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
