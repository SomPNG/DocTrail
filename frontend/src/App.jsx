import { useEffect, useState } from 'react';
import { clearSession, getSession, setSession, setUnauthorizedHandler } from './lib/api.js';
import { ToastProvider } from './components/ui.jsx';
import TopBar, { NavTab } from './components/TopBar.jsx';
import SignIn from './pages/SignIn.jsx';
import CitizenHome from './pages/CitizenHome.jsx';
import OfficerDesk from './pages/OfficerDesk.jsx';
import Oversight from './pages/Oversight.jsx';

const OVERSIGHT_TABS = [
  ['overview', 'Dashboard'],
  ['simulation', 'Simulation'],
  ['messages', 'Messages'],
];

export default function App() {
  const [session, setSessionState] = useState(getSession);
  const [tab, setTab] = useState('overview');

  const signOut = () => {
    clearSession();
    setSessionState(null);
    setTab('overview');
  };

  useEffect(() => {
    setUnauthorizedHandler(signOut);
  }, []);

  const signedIn = (token, user) => {
    setSession(token, user);
    setSessionState({ token, user });
  };

  if (!session) {
    return (
      <ToastProvider>
        <SignIn onSignedIn={signedIn} />
      </ToastProvider>
    );
  }

  const { user } = session;
  const oversight = user.role === 'SUPERVISOR' || user.role === 'ADMIN';
  const tabs = user.role === 'ADMIN' ? [...OVERSIGHT_TABS, ['staff', 'Staff']] : OVERSIGHT_TABS;

  return (
    <ToastProvider>
      <div className="min-h-full">
        <TopBar user={user} onSignOut={signOut}>
          {oversight &&
            tabs.map(([k, label]) => (
              <NavTab key={k} active={tab === k} onClick={() => setTab(k)}>
                {label}
              </NavTab>
            ))}
        </TopBar>
        {user.role === 'CITIZEN' && <CitizenHome user={user} />}
        {user.role === 'OFFICER' && <OfficerDesk user={user} />}
        {oversight && <Oversight key={tab} user={user} tab={tab} onTab={setTab} />}
      </div>
    </ToastProvider>
  );
}
