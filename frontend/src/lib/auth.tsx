import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import i18n from '@/i18n'
import { api, get, post, tokens } from './api'

export interface Me {
  id: number
  username: string
  email: string
  role: 'ADMIN' | 'USER'
  locale: string
  hasScreenScraper: boolean
  hasRetroAchievements: boolean
  raUser: string | null
  ssUser: string | null
  raConsoles: boolean
  hasTheGamesDb: boolean
  permissions: string[]
  mustChangePassword: boolean
}

interface AuthCtx {
  user: Me | null
  loading: boolean
  login(username: string, password: string, remember?: boolean): Promise<void>
  register(data: { token: string; username: string; email: string; password: string }): Promise<void>
  signup(data: { username: string; email: string; password: string }): Promise<void>
  logout(): Promise<void>
  reload(): Promise<void>
  can(perm: string): boolean
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const qc = useQueryClient()

  const reload = async () => {
    if (!tokens.access) {
      setUser(null)
      setLoading(false)
      return
    }
    try {
      const me = await get<Me>('/users/me')
      setUser(me)
      if (me.locale && me.locale !== i18n.language) await i18n.changeLanguage(me.locale)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    const onLogout = () => setUser(null)
    window.addEventListener('auth:logout', onLogout)
    return () => window.removeEventListener('auth:logout', onLogout)
  }, [])

  const value: AuthCtx = {
    user,
    loading,
    async login(username, password, remember = true) {
      const r = await api('POST', '/auth/login', { username, password, remember })
      tokens.set(r.accessToken, r.refreshToken, r.filesToken, remember)
      await reload()
    },
    async signup(data) {
      const r = await api('POST', '/auth/signup', { ...data, locale: i18n.language })
      tokens.set(r.accessToken, r.refreshToken, r.filesToken)
      await reload()
    },
    async register(data) {
      const r = await api('POST', '/auth/register', { ...data, locale: i18n.language })
      tokens.set(r.accessToken, r.refreshToken, r.filesToken)
      await reload()
    },
    async logout() {
      if (tokens.refresh) await post('/auth/logout', { refreshToken: tokens.refresh }).catch(() => {})
      tokens.clear()
      qc.clear()
      setUser(null)
    },
    reload,
    can: (perm) => !!user && (user.role === 'ADMIN' || user.permissions?.includes(perm)),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useAuth = () => useContext(Ctx)
