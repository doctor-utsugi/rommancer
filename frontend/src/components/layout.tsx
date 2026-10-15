import { NavLink, Outlet } from 'react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  BookOpen,
  Cable,
  GitMerge,
  Library,
  Menu,
  RefreshCw,
  Database,
  FileSearch,
  FolderSearch,
  Gamepad2,
  Home,
  ListChecks,
  LogOut,
  Puzzle,
  Save,
  SearchX,
  Upload,
  User,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import i18n, { setLanguage } from '@/i18n'
import { LOCALES } from '@/i18n/locales'
import { patch } from '@/lib/api'
import { ActivityDock } from '@/components/activity'

function Item({ to, icon: Icon, label }: { to: string; icon: typeof Home; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          isActive && 'bg-muted font-medium text-foreground',
        )
      }
    >
      <Icon className="size-4" />
      {label}
    </NavLink>
  )
}

export function Layout() {
  const { t } = useTranslation()
  const { user, logout, can } = useAuth()
  const [navigationOpen, setNavigationOpen] = useState(false)
  const switchLang = async (next: string) => {
    await setLanguage(next)
    await patch('/users/me', { locale: next }).catch(() => {})
  }
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <header className="flex items-center justify-between border-b bg-sidebar px-4 py-3 md:hidden"><span className="font-semibold">{t('app.name')}</span><Button variant="outline" size="sm" aria-expanded={navigationOpen} aria-controls="main-navigation" onClick={() => setNavigationOpen(!navigationOpen)}><Menu className="size-4" />{t('common.menu')}</Button></header>
      <aside id="main-navigation" onClick={(e) => { if ((e.target as HTMLElement).closest('a')) setNavigationOpen(false) }} className={cn('top-0 h-auto w-full shrink-0 flex-col gap-1 overflow-y-auto border-r bg-sidebar p-3 md:sticky md:flex md:h-screen md:w-60', navigationOpen ? 'flex' : 'hidden')}>
        <div className="mb-4 flex items-center gap-2 px-2 pt-1 text-lg font-semibold">
          <img src="/logo.png" alt="" className="size-7" />
          {t('app.name')}
        </div>
        <Item to="/" icon={Home} label={t('nav.dashboard')} />
        <Item to="/games" icon={Gamepad2} label={t('nav.games')} />
        <Item to="/missing" icon={SearchX} label={t('nav.missing')} />
        <Item to="/hacks" icon={Puzzle} label={t('nav.hacks')} />
        <Item to="/franchises" icon={Library} label={t('more.nav.franchises')} />
        {can('lists') && <Item to="/lists" icon={ListChecks} label={t('nav.lists')} />}
        {(can('roms.download') || can('saves')) && <Item to="/devices" icon={Cable} label={t('nav.devices')} />}
        {can('saves') && <Item to="/saves" icon={Save} label={t('nav.saves')} />}
        {(can('roms.download') || can('saves')) && <Item to="/guides" icon={BookOpen} label={t('more.guides.nav')} />}
        {(can('roms.upload') || can('roms.uploadUnverified')) && <Item to="/upload" icon={Upload} label={t('nav.upload')} />}
        {user?.role === 'ADMIN' && (
          <>
            <p className="mt-4 px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">{t('nav.admin')}</p>
            <Item to="/admin/paths" icon={FolderSearch} label={t('nav.paths')} />
            <Item to="/admin/files" icon={FileSearch} label={t('nav.files')} />
            <Item to="/admin/dats" icon={Database} label={t('nav.dats')} />
            <Item to="/admin/sync" icon={RefreshCw} label={t('more.nav.sync')} />
            <Item to="/admin/review" icon={GitMerge} label={t('more.nav.review')} />
            <Item to="/admin/users" icon={Users} label={t('nav.users')} />
            <Item to="/admin/integrations" icon={Cable} label={t('nav.integrations')} />
            <Item to="/admin/jobs" icon={Activity} label={t('nav.jobs')} />
          </>
        )}
        <div className="mt-auto space-y-1 pt-4">
          <Item to="/profile" icon={User} label={user?.username ?? t('nav.profile')} />
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" className="flex-1 justify-start" onClick={() => void logout()}>
              <LogOut className="size-4" />
              {t('nav.logout')}
            </Button>
            <select
              value={i18n.language}
              onChange={(e) => void switchLang(e.target.value)}
              aria-label={t('profile.language')}
              className="h-8 rounded-md bg-transparent px-1 text-sm uppercase text-muted-foreground hover:bg-accent"
            >
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.code}
                </option>
              ))}
            </select>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6 lg:p-8">
        <Outlet />
      </main>
      <ActivityDock />
    </div>
  )
}
