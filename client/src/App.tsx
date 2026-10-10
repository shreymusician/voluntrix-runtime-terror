import type { ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { Role } from './api';
import { homeFor, useAuth } from './auth';
import { Icon, Logo, Spinner } from './components';
import { FacultyPage } from './pages/Faculty';
import { LoginPage } from './pages/Login';
import { RegisterPage } from './pages/Register';
import { EventDetailPage, EventsPage } from './pages/manage/Events';
import { ManageAssignmentsPage, ManagerDashboard, VolunteersPage } from './pages/manage/ManagePages';
import { ProfilePage } from './pages/student/Profile';
import { PerformancePage, QuestionsPage } from './pages/manage/Performance';
import { ChatPage } from './pages/Chat';
import { ActivitiesPage, AssignmentsPage, NotificationsPage, StudentDashboard } from './pages/student/StudentPages';

const ROLE_NAMES: Record<Role, string> = { student: 'Student', faculty: 'Faculty', organizer: 'Organizer' };

const NAV: Record<Role, { to: string; label: string; end?: boolean; icon: 'dashboard' | 'profile' | 'skills' | 'calendar' | 'tests' | 'leaderboard' | 'activity' | 'assignment' | 'feedback' | 'bell' | 'events' | 'users' | 'shield' | 'chat' }[]> = {
  student: [
    { to: '/student', label: 'Dashboard', end: true, icon: 'dashboard' },
    { to: '/student/profile', label: 'My Profile', icon: 'profile' },
    { to: '/student/availability', label: 'My Availability', icon: 'calendar' },
    { to: '/student/activities', label: 'Available Activities', icon: 'activity' },
    { to: '/student/assignments', label: 'My Assignments', icon: 'assignment' },
    { to: '/student/notifications', label: 'Notifications', icon: 'bell' },
    { to: '/chat', label: 'Chat', icon: 'chat' },
  ],
  faculty: [
    { to: '/faculty', label: 'Dashboard', end: true, icon: 'dashboard' },
    { to: '/manage/events', label: 'Events', icon: 'events' },
    { to: '/manage/volunteers', label: 'Volunteers', icon: 'users' },
    { to: '/manage/assignments', label: 'Assignments', icon: 'assignment' },
    { to: '/manage/performance', label: 'Performance', icon: 'leaderboard' },
    { to: '/faculty/questions', label: 'Question Bank', icon: 'tests' },
    { to: '/faculty/promotions', label: 'Promotions', icon: 'shield' },
    { to: '/manage/notifications', label: 'Notifications', icon: 'bell' },
    { to: '/chat', label: 'Chat', icon: 'chat' },
  ],
  organizer: [
    { to: '/organizer', label: 'Dashboard', end: true, icon: 'dashboard' },
    { to: '/manage/events', label: 'My Events', icon: 'events' },
    { to: '/manage/volunteers', label: 'Volunteers', icon: 'users' },
    { to: '/manage/assignments', label: 'Assignments', icon: 'assignment' },
    { to: '/manage/performance', label: 'Performance', icon: 'leaderboard' },
    { to: '/manage/notifications', label: 'Notifications', icon: 'bell' },
    { to: '/chat', label: 'Chat', icon: 'chat' },
  ],
};

/**
 * Routing convenience only. Every API these pages call checks the session
 * and role again on the server, which is where access is actually enforced.
 */
function Protected({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="Checking your session…" />;
  if (!me) return <Navigate to="/login" replace />;
  if (!roles.includes(me.user.role)) return <Navigate to={homeFor(me.user.role)} replace />;

  // A student sets up their volunteer profile before anything else. Faculty
  // and organizers are never sent to that form.
  const setupPaths = ['/student/profile', '/student/availability'];
  if (me.user.role === 'student' && !me.studentProfile?.profileComplete && !setupPaths.includes(location.pathname)) {
    return <Navigate to="/student/profile" replace />;
  }
  return <Shell>{children}</Shell>;
}

function Shell({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  if (!me) return null;
  const setupPending = me.user.role === 'student' && !me.studentProfile?.profileComplete;

  const signOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="shell">
      <header className="topbar">
        <Logo />
        <div className="topbar-user">
          <span className="topbar-name">
            {me.user.fullName}
            <span className={`role-chip role-chip-${me.user.role}`}>{ROLE_NAMES[me.user.role]}</span>
          </span>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={signOut}>
            <Icon name="logout" />
            <span>Sign out</span>
          </button>
        </div>
      </header>
      <div className="shell-body">
        {!setupPending && (
          <nav className="sidenav" aria-label="Main">
            {NAV[me.user.role].map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `sidenav-link sidenav-link-${item.icon}${isActive ? ' sidenav-link-active' : ''}`}>
                <span className="nav-icon"><Icon name={item.icon} /></span>
                <span>{item.label}</span>
              </NavLink>
            ))}
          </nav>
        )}
        <main className="shell-main">{children}</main>
      </div>
    </div>
  );
}

function Home() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner label="Checking your session…" />;
  return <Navigate to={me ? homeFor(me.user.role) : '/login'} replace />;
}

const student = (page: ReactNode) => <Protected roles={['student']}>{page}</Protected>;
const manager = (page: ReactNode) => <Protected roles={['faculty', 'organizer']}>{page}</Protected>;

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route path="/student" element={student(<StudentDashboard />)} />
      <Route path="/student/profile" element={student(<ProfilePage />)} />
      <Route path="/student/availability" element={student(<ProfilePage focus="availability" />)} />
      <Route path="/student/activities" element={student(<ActivitiesPage />)} />
      <Route path="/student/assignments" element={student(<AssignmentsPage />)} />
      <Route path="/student/notifications" element={student(<NotificationsPage />)} />
      <Route path="/chat" element={<Protected roles={['student', 'faculty', 'organizer']}><ChatPage /></Protected>} />

      <Route path="/faculty" element={<Protected roles={['faculty']}><ManagerDashboard /></Protected>} />
      <Route path="/faculty/promotions" element={<Protected roles={['faculty']}><FacultyPage /></Protected>} />
      <Route path="/organizer" element={<Protected roles={['organizer']}><ManagerDashboard /></Protected>} />
      <Route path="/manage/events" element={manager(<EventsPage />)} />
      <Route path="/manage/events/:id" element={manager(<EventDetailPage />)} />
      <Route path="/manage/volunteers" element={manager(<VolunteersPage />)} />
      <Route path="/manage/assignments" element={manager(<ManageAssignmentsPage />)} />
      <Route path="/manage/notifications" element={manager(<NotificationsPage />)} />
      <Route path="/manage/performance" element={manager(<PerformancePage />)} />
      <Route path="/faculty/questions" element={<Protected roles={['faculty']}><QuestionsPage /></Protected>} />

      <Route path="*" element={<Home />} />
    </Routes>
  );
}
