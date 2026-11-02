jsx
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
import ReferralClickTracker from '@/components/ReferralClickTracker';
// Add page imports here
import { Navigate, useLocation } from "react-router-dom";
import ProtectedRoute from "@/components/ProtectedRoute";
import { ProfileProvider } from "@/lib/ProfileContext";
import { ThemeProvider } from "@/lib/ThemeContext";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import AppShell from "@/components/AppShell";
import BanGate from "@/components/BanGate";
import Room from "@/pages/Room";
import FriendsWall from "@/pages/FriendsWall";
import NewsWall from "@/pages/NewsWall";
import OwnerOffice from "@/pages/OwnerOffice";
import CoOwnerOffice from "@/pages/CoOwnerOffice";
import QuizRoom from "@/pages/QuizRoom";
import WatchParty from "@/pages/WatchParty";
import Tutorials from "@/pages/Tutorials";
import Onboarding from "@/pages/Onboarding";
import Games from "@/pages/Games";
import TruthOrDare from "@/pages/TruthOrDare";
import Study from "@/pages/Study";
import Clubs from "@/pages/Clubs";
import Banned from "@/pages/Banned";
import Landing from "@/pages/Landing";
import PinterestRoom from "@/pages/PinterestRoom";
import PrivacyPolicy from "@/pages/PrivacyPolicy";

const PUBLIC_ROUTES = new Set(['/', '/landing', '/privacy', '/onboarding', '/login', '/register', '/forgot-password', '/reset-password']);

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();
  const location = useLocation();

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="tv-splash">
        <div className="tv-splash-bg" />
        <div className="tv-splash-logo">
          <span className="font-display font-black text-white text-3xl relative z-10">TV</span>
          <div className="tv-splash-ring" />
        </div>
        <h1 className="tv-splash-text">TeenVerse</h1>
        <p className="tv-splash-tagline">Your World. Your Space.</p>
        <div className="tv-splash-loader" />
      </div>
    );
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required' && !PUBLIC_ROUTES.has(location.pathname)) {
      // Redirect to login automatically — but only for non-public routes
      navigateToLogin();
      return null;
    }
  }

  // Render the main app
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/landing" element={<Landing />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/onboarding" element={<Onboarding />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        <Route path="/banned" element={<Banned />} />
        <Route element={<ProfileProvider><BanGate><AppShell /></BanGate></ProfileProvider>}>
          <Route path="/room/:roomId" element={<Room />} />
          <Route path="/friends" element={<FriendsWall />} />
          <Route path="/news" element={<NewsWall />} />
          <Route path="/owner-office" element={<OwnerOffice />} />
          <Route path="/owner" element={<OwnerOffice />} />
          <Route path="/co-owner-office" element={<CoOwnerOffice />} />
          <Route path="/room/quiz" element={<QuizRoom />} />
          <Route path="/watch" element={<WatchParty />} />
          <Route path="/tutorials" element={<Tutorials />} />
          <Route path="/games" element={<Games />} />
          <Route path="/games/tod" element={<TruthOrDare />} />
          <Route path="/study" element={<Study />} />
          <Route path="/clubs" element={<Clubs />} />
          <Route path="/pinterest" element={<PinterestRoom />} />
        </Route>
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClientInstance}>
          <Router>
            <ScrollToTop />
            <ReferralClickTracker />
            <AuthenticatedApp />
          </Router>
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </AuthProvider>
  )
}

export default App

