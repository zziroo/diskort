import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { User } from '@diskort/shared';
import { env } from './env';

interface SessionStore {
  token: string | null;
  user: User | null;
  setSession: (token: string, user: User) => void;
  setUser: (user: User) => void;
  /** Sunucu jetonu yeniledi (SESSION_TOKEN): bundan sonraki istekler ve yeniden bağlanma bununla */
  setToken: (token: string) => void;
  logout: () => void;
}

/**
 * Oturum jetonunun (JWT) dolacağı an (ms); okunamıyorsa null. İmza doğrulanmaz: yalnızca süre dolunca
 * uygulamanın sunucuya sormasını zamanlamak için.
 */
export function tokenExpiresAt(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// Depolama platformdan gelir; configureClient() çağrılınca okunur (bkz. configure.ts).
const platformStorage: StateStorage = {
  getItem: (name) => env().storage.getItem(name),
  setItem: (name, value) => env().storage.setItem(name, value),
  removeItem: (name) => env().storage.removeItem(name),
};

export const useSession = create<SessionStore>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setSession: (token, user) => set({ token, user }),
      setUser: (user) => set({ user }),
      setToken: (token) => set((s) => (s.token ? { token } : {})),
      logout: () => set({ token: null, user: null }),
    }),
    {
      name: 'diskort-session',
      storage: createJSONStorage(() => platformStorage),
      partialize: ({ token, user }) => ({ token, user }),
      skipHydration: true,
    },
  ),
);

// Oturum kapanınca (elle çıkış ya da zorunlu: 401, gateway 4004, INVALID_SESSION) platform haberdar edilir
useSession.subscribe((s, prev) => {
  if (!prev.token || s.token) return;
  try {
    env().onSessionEnded?.();
  } catch {
    // platform henüz yapılandırılmadı
  }
});
