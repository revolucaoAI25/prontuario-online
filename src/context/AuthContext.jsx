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
    // Admin and secretaries: the Financeiro screen (each sees what the database lets them).
    isReception: staff?.role === 'admin' || staff?.role === 'secretaria',
    isSuperAdmin: staff?.role === 'admin' && Boolean(staff?.is_superadmin),
    // Each person silences their own notification sounds.
    setMute: async (prefs) => {
      const next = { mute_whatsapp: staff?.mute_whatsapp ?? false, mute_chat: staff?.mute_chat ?? false, ...prefs };
      const { error } = await supabase.rpc('set_my_notification_prefs', { p_mute_whatsapp: next.mute_whatsapp, p_mute_chat: next.mute_chat });
      if (!error) setStaff((s) => ({ ...s, ...next }));
      return error;
    },
    signIn: (email, password) => supabase.auth.signInWithPassword({ email, password }),
    signOut: () => supabase.auth.signOut(),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
