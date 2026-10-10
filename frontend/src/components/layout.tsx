import { NavLink, Outlet } from 'react-router'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  BookOpen,
  Cable,
  GitMerge,
  Library,
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
import i18n from '@/i18n'
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
  const switchLang = async () => {
    const next = i18n.language === 'es' ? 'en' : 'es'
    await i18n.changeLanguage(next)
    await patch('/users/me', { locale: next }).catch(() => {})
  }
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r bg-sidebar p-3">
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
            <Button variant="ghost" size="sm" onClick={() => void switchLang()} aria-label="language">
              {i18n.language === 'es' ? 'EN' : 'ES'}
            </Button>
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
