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
}

interface AuthCtx {
  user: Me | null
  loading: boolean
  login(username: string, password: string): Promise<void>
  register(data: { token: string; username: string; email: string; password: string }): Promise<void>
  logout(): Promise<void>
  reload(): Promise<void>
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
    async login(username, password) {
      const r = await api('POST', '/auth/login', { username, password })
      tokens.set(r.accessToken, r.refreshToken)
      await reload()
    },
    async register(data) {
      const r = await api('POST', '/auth/register', { ...data, locale: i18n.language })
      tokens.set(r.accessToken, r.refreshToken)
      await reload()
    },
    async logout() {
      if (tokens.refresh) await post('/auth/logout', { refreshToken: tokens.refresh }).catch(() => {})
      tokens.clear()
      qc.clear()
      setUser(null)
    },
    reload,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useAuth = () => useContext(Ctx)
