import { useEffect, useState } from 'react';
import { onClockChange, serverNow } from './api.js';

/** Current server time (follows the simulation clock), re-rendering every `ms`. */
export function useServerNow(ms = 1000) {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), ms);
    const off = onClockChange(() => setNow(serverNow()));
    return () => {
      clearInterval(t);
      off();
    };
  }, [ms]);
  return now;
}

export const fmtDate = d =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '–';

export const fmtDateTime = d =>
  d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '–';

/** 30 -> "30 h", 50 -> "2.1 days" */
export function fmtHours(h) {
  if (h === null || h === undefined || Number.isNaN(h)) return '–';
  const abs = Math.abs(h);
  if (abs < 1) return `${Math.round(abs * 60)} min`;
  if (abs < 48) return `${Math.round(abs)} h`;
  return `${(abs / 24).toFixed(1)} days`;
}

/** Live countdown text to a deadline. */
export function countdown(deadline, now) {
  if (!deadline) return '–';
  const ms = new Date(deadline).getTime() - now.getTime();
  const sign = ms < 0 ? '-' : '';
  const s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${sign}${d > 0 ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(sec)}`;
}

export const SLA = {
  ON_TRACK: { label: 'On track', tone: 'ok' },
  AT_RISK: { label: 'Close to deadline', tone: 'warn' },
  BREACHED: { label: 'Overdue', tone: 'bad' },
  PAUSED: { label: 'Paused', tone: 'paused' },
  COMPLETED: { label: 'Closed', tone: 'neutral' },
};

export const STATUS = {
  CREATED: 'Submitted',
  IN_PROGRESS: 'In progress',
  ON_HOLD: 'On hold',
  COMPLETED: 'Approved',
  REJECTED: 'Not approved',
};

export const REASON = {
  ON_TRACK: { label: 'Waiting for pickup', tone: 'neutral' },
  IN_REVIEW: { label: 'Being reviewed', tone: 'ok' },
  WAITING_ON_CITIZEN: { label: 'Waiting for applicant', tone: 'paused' },
  RETURNED_FOR_CORRECTION: { label: 'Returned for correction', tone: 'paused' },
  ADMIN_HOLD: { label: 'On hold', tone: 'paused' },
  EXTERNAL_DEPENDENCY: { label: 'Waiting on another agency', tone: 'paused' },
  DEPARTMENT_BACKLOG: { label: 'Department backlog', tone: 'bad' },
  UNASSIGNED: { label: 'Not picked up', tone: 'warn' },
  OFFICER_IDLE: { label: 'No officer activity', tone: 'warn' },
  SLOW_PROCESSING: { label: 'Review running late', tone: 'warn' },
  COMPLETED: { label: 'Completed', tone: 'neutral' },
  REJECTED: { label: 'Closed', tone: 'neutral' },
};

export const SEVERITY_TONE = { CRITICAL: 'bad', HIGH: 'warn', MEDIUM: 'warn', LOW: 'paused', NONE: 'neutral' };

export const RESPONSIBLE = {
  CITIZEN: 'Applicant',
  DEPARTMENT: 'Department',
  OFFICER: 'Officer',
  EXTERNAL: 'Another agency',
  NONE: '–',
};

export const ROLE_LABEL = { CITIZEN: 'Citizen', OFFICER: 'Officer', SUPERVISOR: 'Supervisor', ADMIN: 'Administrator' };
