import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined);
  const [staff, setStaff] = useState(null);
  const [staffLoading, setStaffLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user?.id;
  useEffect(() => {
    if (!userId) {
      setStaff(null);
      return;
    }
    setStaffLoading(true);
    supabase.from('staff').select('*').eq('id', userId).maybeSingle()
      .then(({ data }) => setStaff(data ?? null))
      .finally(() => setStaffLoading(false));
  }, [userId]);

  const value = {
    session,
    staff,
    loading: session === undefined || staffLoading,
    isAdmin: staff?.role === 'admin',
    signIn: (email, password) => supabase.auth.signInWithPassword({ email, password }),
    signOut: () => supabase.auth.signOut(),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
