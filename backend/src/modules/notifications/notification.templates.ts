/**
 * Plain-language notification templates.
 *
 * Citizens get short, jargon-free text ("your file is with the Police Department") rather than
 * internal terms ("SLA breached at stage police_verification"). Each template renders:
 *  - title/message for the in-app inbox
 *  - sms: <= 160 chars (also used for WhatsApp)
 *  - emailSubject
 */
export type TemplateKey =
  | 'APPLICATION_RECEIVED'
  | 'STAGE_MOVED'
  | 'DOCUMENT_NEEDED'
  | 'DOCUMENT_REMINDER'
  | 'DOCUMENT_RECEIVED'
  | 'ON_HOLD'
  | 'RETURNED_FOR_CORRECTION'
  | 'RESUMED'
  | 'RUNNING_LATE'
  | 'DELAYED'
  | 'APPROVED'
  | 'REJECTED'
  | 'COMPENSATION_ELIGIBLE'
  | 'COMPENSATION_DECIDED'
  // staff-facing
  | 'STAFF_NEW_IN_QUEUE'
  | 'STAFF_DOCUMENT_RECEIVED'
  | 'STAFF_AT_RISK'
  | 'STAFF_BREACH_ESCALATION';

export interface TemplateVars {
  trackingNumber: string;
  serviceName?: string;
  stageName?: string;
  departmentName?: string;
  nextStageName?: string;
  documentTitle?: string;
  reason?: string;
  deadline?: Date | string | null;
  daysLate?: number;
  hoursLeft?: number;
  amount?: number;
  decision?: string;
}

export interface RenderedTemplate {
  type: string;
  title: string;
  message: string;
  sms: string;
  emailSubject: string;
}

function fmtDate(d?: Date | string | null): string {
  if (!d) return 'soon';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function clip(s: string, n = 160): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function renderTemplate(key: TemplateKey, v: TemplateVars): RenderedTemplate {
  const id = v.trackingNumber;
  const dept = v.departmentName || 'the concerned office';
  const stage = v.stageName || 'the current step';
  const svc = v.serviceName || 'application';

  let type: string = key;
  let title = '';
  let message = '';
  let sms = '';

  switch (key) {
    case 'APPLICATION_RECEIVED':
      type = 'APPLICATION_CREATED';
      title = 'Application received';
      message = `We have received your ${svc} application. Your tracking number is ${id}. It is now with ${dept} for "${stage}". Expected to finish this step by ${fmtDate(v.deadline)}.`;
      sms = `DocTrail: ${svc} application received. Track with ${id}. Now with ${dept}.`;
      break;
    case 'STAGE_MOVED':
      type = 'STAGE_TRANSITION';
      title = `Moved to ${v.nextStageName || stage}`;
      message = `Good news: your application ${id} has finished "${stage}" and has moved to ${dept} for "${v.nextStageName || stage}". Target date for this step: ${fmtDate(v.deadline)}.`;
      sms = `DocTrail ${id}: moved to ${dept} (${v.nextStageName || stage}). Target ${fmtDate(v.deadline)}.`;
      break;
    case 'DOCUMENT_NEEDED':
      type = 'DOCUMENT_REQUEST';
      title = `Action needed: upload ${v.documentTitle || 'a document'}`;
      message = `${dept} needs "${v.documentTitle}" to continue with your application ${id}. Reason: ${v.reason || 'verification'}. Your waiting time does not count against the department while we wait for you.`;
      sms = `DocTrail ${id}: please upload "${v.documentTitle}". The office is waiting for this to continue.`;
      break;
    case 'DOCUMENT_REMINDER':
      type = 'DOCUMENT_REMINDER';
      title = `Reminder: ${v.documentTitle || 'document'} still needed`;
      message = `Your application ${id} is paused until you upload "${v.documentTitle}". Please upload it so ${dept} can continue.`;
      sms = `Reminder DocTrail ${id}: upload "${v.documentTitle}" to continue your application.`;
      break;
    case 'DOCUMENT_RECEIVED':
      type = 'DOCUMENT_SUBMITTED';
      title = 'Document received';
      message = `Thank you. We received "${v.documentTitle}" for application ${id}. ${dept} will continue processing.`;
      sms = `DocTrail ${id}: "${v.documentTitle}" received. Processing continues.`;
      break;
    case 'ON_HOLD':
      type = 'SLA_PAUSED';
      title = 'Application on hold';
      message = `Your application ${id} is on hold at ${dept}. Reason: ${v.reason || 'administrative review'}. The waiting time is not counted as a delay.`;
      sms = `DocTrail ${id}: on hold at ${dept}. Reason: ${v.reason || 'administrative review'}.`;
      break;
    case 'RETURNED_FOR_CORRECTION':
      type = 'DECISION_RETURNED_FOR_CORRECTION';
      title = 'Correction needed';
      message = `${dept} has returned application ${id} for a correction: ${v.reason || 'please review your details'}. Fix it and resubmit from your dashboard.`;
      sms = `DocTrail ${id}: correction needed - ${v.reason || 'see portal'}. Please resubmit.`;
      break;
    case 'RESUMED':
      type = 'SLA_RESUMED';
      title = 'Processing resumed';
      message = `Processing of your application ${id} has resumed at ${dept}.`;
      sms = `DocTrail ${id}: processing resumed at ${dept}.`;
      break;
    case 'RUNNING_LATE':
      type = 'SLA_WARNING';
      title = 'Taking longer than usual';
      message = `Your application ${id} is still with ${dept} ("${stage}"). It is close to its target date (${fmtDate(v.deadline)}). The office has been alerted to prioritise it.`;
      sms = `DocTrail ${id}: close to target date at ${dept}. Office alerted.`;
      break;
    case 'DELAYED':
      type = 'SLA_BREACH';
      title = 'Your application is delayed';
      message = `Sorry - your application ${id} has passed the target time for "${stage}" at ${dept}. The delay has been escalated to a senior officer. You may be eligible for delay compensation.`;
      sms = `DocTrail ${id}: delayed at ${dept}. Escalated to senior officer. You may get compensation.`;
      break;
    case 'APPROVED':
      type = 'APPLICATION_APPROVED';
      title = 'Application approved';
      message = `Congratulations! Your ${svc} application ${id} has been approved.`;
      sms = `DocTrail ${id}: your ${svc} application is APPROVED.`;
      break;
    case 'REJECTED':
      type = 'DECISION_REJECTED';
      title = 'Application not approved';
      message = `Your ${svc} application ${id} was not approved by ${dept}. Reason: ${v.reason || 'see decision letter'}. You may appeal through the portal.`;
      sms = `DocTrail ${id}: not approved. Reason: ${v.reason || 'see portal'}.`;
      break;
    case 'COMPENSATION_ELIGIBLE':
      type = 'COMPENSATION_ELIGIBLE';
      title = 'Delay compensation';
      message = `Because application ${id} was delayed, you are eligible for ₹${v.amount ?? 0} compensation, pending supervisor approval.`;
      sms = `DocTrail ${id}: eligible for Rs.${v.amount ?? 0} delay compensation (pending approval).`;
      break;
    case 'COMPENSATION_DECIDED':
      type = `COMPENSATION_${(v.decision || 'DECIDED').toUpperCase()}`;
      title = `Compensation ${String(v.decision || 'decided').toLowerCase()}`;
      message = `Your delay compensation claim for ${id} has been ${String(v.decision || 'decided').toLowerCase()}.`;
      sms = `DocTrail ${id}: compensation claim ${String(v.decision || 'decided').toLowerCase()}.`;
      break;
    case 'STAFF_NEW_IN_QUEUE':
      type = 'QUEUE_ARRIVAL';
      title = `New file in queue: ${id}`;
      message = `${id} (${svc}) has arrived for "${stage}". Target completion: ${fmtDate(v.deadline)}.`;
      sms = `New file ${id} for ${stage}. Due ${fmtDate(v.deadline)}.`;
      break;
    case 'STAFF_DOCUMENT_RECEIVED':
      type = 'DOCUMENT_SUBMITTED';
      title = `Applicant uploaded a document: ${id}`;
      message = `The applicant uploaded "${v.documentTitle}" for ${id}. The clock has resumed if nothing else is pending.`;
      sms = `${id}: applicant uploaded ${v.documentTitle}.`;
      break;
    case 'STAFF_AT_RISK':
      type = 'SLA_WARNING';
      title = `At risk: ${id}`;
      message = `${id} at "${stage}" has ${v.hoursLeft ?? 0}h left before its deadline (${fmtDate(v.deadline)}). Please prioritise.`;
      sms = `${id} at risk: ${v.hoursLeft ?? 0}h left.`;
      break;
    case 'STAFF_BREACH_ESCALATION':
      type = 'SLA_BREACH_ESCALATION';
      title = `Escalation: ${id} overdue at ${dept}`;
      message = `${id} has breached its time target for "${stage}" at ${dept}. Supervisor attention required.`;
      sms = `ESCALATION ${id} overdue at ${dept}.`;
      break;
  }

  return { type, title, message, sms: clip(sms), emailSubject: `[DocTrail] ${title}` };
}
