/**
 * DocTrail API client.
 * - Stores the JWT and user in localStorage.
 * - Tracks the server's (possibly simulated) clock from the X-Server-Now header so countdowns
 *   match the backend even while the simulation fast-forwards time.
 */
const TOKEN_KEY = 'doctrail_token';
const USER_KEY = 'doctrail_user';

let clockOffsetMs = 0;
const clockListeners = new Set();

export const serverNow = () => new Date(Date.now() + clockOffsetMs);
export const onClockChange = fn => {
  clockListeners.add(fn);
  return () => clockListeners.delete(fn);
};

function syncClock(header) {
  if (!header) return;
  const t = Date.parse(header);
  if (Number.isNaN(t)) return;
  const next = t - Date.now();
  if (Math.abs(next - clockOffsetMs) > 1500) {
    clockOffsetMs = next;
    clockListeners.forEach(fn => fn(clockOffsetMs));
  }
}

export const getSession = () => {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const user = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    return token && user ? { token, user } : null;
  } catch {
    return null;
  }
};

export const setSession = (token, user) => {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
};

export const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = fn => {
  onUnauthorized = fn;
};

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

export const getApiBaseUrl = () => API_BASE;

async function request(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const url = `${API_BASE}/api${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(
      API_BASE
        ? `Cannot reach DocTrail backend at ${API_BASE}. Ensure the server is online and accessible.`
        : 'Cannot reach the DocTrail server. Check that the backend is running on port 4000.',
      0
    );
  }

  syncClock(res.headers.get('X-Server-Now'));
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : null;

  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    const detail = data?.errors?.map(e => `${e.field}: ${e.message}`).join('; ');
    throw new ApiError(detail || data?.message || `Request failed (${res.status})`, res.status, data);
  }
  return data?.data;
}

const q = params => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)).toString();
  return s ? `?${s}` : '';
};

export const api = {
  // auth
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  register: payload => request('/auth/register', { method: 'POST', body: payload }),

  // services
  services: () => request('/services'),

  // applications
  listApplications: (params = {}) => request(`/applications${q(params)}`),
  application: id => request(`/applications/${id}`),
  tracking: id => request(`/applications/${id}/tracking`),
  timeline: id => request(`/applications/${id}/timeline`),
  checklists: id => request(`/applications/${id}/checklists`),
  documents: id => request(`/applications/${id}/documents`),
  viewToken: async (id, docId) => {
    const data = await request(`/applications/${id}/documents/${docId}/view-token`);
    if (data?.viewUrl && data.viewUrl.startsWith('/') && API_BASE) {
      return { ...data, viewUrl: `${API_BASE}${data.viewUrl}` };
    }
    return data;
  },
  verifyChain: id => request(`/applications/${id}/verify-audit-chain`),
  compensation: id => request(`/applications/${id}/compensation`),
  createApplication: payload => request('/applications', { method: 'POST', body: payload }),
  uploadAndRoute: formData => request('/documents/upload-and-route', { method: 'POST', form: formData }),
  uploadFile: formData => request('/documents/upload', { method: 'POST', form: formData }),
  submitDocument: (id, payload) => request(`/applications/${id}/documents/upload`, { method: 'POST', body: payload }),
  resubmit: (id, payload) => request(`/applications/${id}/resubmit`, { method: 'POST', body: payload }),

  // officer actions
  assign: id => request(`/applications/${id}/assign`, { method: 'POST', body: {} }),
  forward: (id, payload) => request(`/applications/${id}/forward`, { method: 'POST', body: payload }),
  decide: (id, payload) => request(`/applications/${id}/decision`, { method: 'POST', body: payload }),
  hold: (id, reason) => request(`/applications/${id}/hold`, { method: 'POST', body: { reason } }),
  resume: (id, remarks) => request(`/applications/${id}/resume`, { method: 'POST', body: { remarks } }),
  requestDocument: (id, payload) => request(`/applications/${id}/documents/request`, { method: 'POST', body: payload }),
  reviewCompensation: (id, payload) => request(`/applications/${id}/compensation/review`, { method: 'POST', body: payload }),
  officerQueue: (departmentCode) => request(`/officer/queue${q({ departmentCode })}`),

  // notifications
  notifications: () => request('/notifications'),
  markRead: id => request(`/notifications/${id}/read`, { method: 'PATCH' }),
  outbox: (params = {}) => request(`/notifications/outbox${q(params)}`),

  // dashboards
  overview: () => request('/dashboard/overview'),
  stuck: (params = {}) => request(`/dashboard/stuck${q(params)}`),
  bottlenecks: () => request('/dashboard/bottlenecks'),
  departments: () => request('/dashboard/departments'),
  trends: (days = 14, departmentCode) => request(`/dashboard/trends${q({ days, departmentCode })}`),

  // simulation
  simClock: () => request('/sim/clock'),
  simAdvance: hours => request('/sim/clock/advance', { method: 'POST', body: { hours } }),
  simResetClock: () => request('/sim/clock/reset', { method: 'POST' }),
  simStories: () => request('/sim/stories'),
  simStartStory: key => request(`/sim/stories/${key}/start`, { method: 'POST' }),
  simNextStep: () => request('/sim/stories/next', { method: 'POST' }),
  simScenarios: () => request('/sim/scenarios'),
  simRunScenario: (key, payload) => request(`/sim/scenarios/${key}/run`, { method: 'POST', body: payload }),
  simSamples: payload => request('/sim/samples', { method: 'POST', body: payload }),
  simReset: () => request('/sim/reset', { method: 'POST' }),
  demoReset: withSamples => request('/demo/reset', { method: 'POST', body: { withSamples } }),
  clearData: () => request('/demo/clear-data', { method: 'POST' }),
  resetAllData: () => request('/demo/clear-data', { method: 'POST' }),

  // admin
  staff: () => request('/admin/users'),
  createStaff: payload => request('/admin/users', { method: 'POST', body: payload }),
  adminDepartments: () => request('/admin/departments'),
};
