import { Navigate, Route, Routes } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { Layout } from '@/components/layout'
import { LoginPage, RegisterPage } from '@/pages/auth'
import { DashboardPage } from '@/pages/dashboard'
import { GamesPage } from '@/pages/games'
import { GamePage } from '@/pages/game'
import { MissingPage } from '@/pages/missing'
import { HacksPage } from '@/pages/hacks'
import { ListsPage } from '@/pages/lists'
import { ListPage } from '@/pages/list'
import { DevicesPage } from '@/pages/devices'
import { SavesPage } from '@/pages/saves'
import { UploadPage } from '@/pages/upload'
import { ProfilePage } from '@/pages/profile'
import { AdminPathsPage } from '@/pages/admin/paths'
import { StorageSetupPage } from '@/pages/admin/storage-setup'
import { AdminFilesPage } from '@/pages/admin/files'
import { AdminDatsPage } from '@/pages/admin/dats'
import { AdminUsersPage } from '@/pages/admin/users'
import { AdminJobsPage } from '@/pages/admin/jobs'
import { AdminIntegrationsPage } from '@/pages/admin/integrations'
import { AdminSyncPage } from '@/pages/admin/sync'
import { AdminReviewPage } from '@/pages/admin/review'
import { FranchisePage, FranchisesPage, WorkPage } from '@/pages/works'
import { LinkPage } from '@/pages/link'
import { GuidesPage } from '@/pages/guides'
import { DevicePage } from '@/pages/device'

export function App() {
  const { user, loading } = useAuth()
  const { t } = useTranslation()
  if (loading) return null
  if (!user)
    return (
      <Routes>
        <Route path="/register/:token" element={<RegisterPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    )
  // Contrasena inicial o debil: solo se permite cambiarla
  if (user.mustChangePassword)
    return (
      <div className="mx-auto max-w-2xl p-6">
        <p className="mb-4 rounded-lg border border-destructive/50 p-3 text-sm">{t('profile.mustChange')}</p>
        <ProfilePage />
      </div>
    )
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="games" element={<GamesPage />} />
        <Route path="games/:id" element={<GamePage />} />
        <Route path="missing" element={<MissingPage />} />
        <Route path="hacks" element={<HacksPage />} />
        <Route path="works/:id" element={<WorkPage />} />
        <Route path="franchises" element={<FranchisesPage />} />
        <Route path="franchises/:id" element={<FranchisePage />} />
        <Route path="lists" element={<ListsPage />} />
        <Route path="lists/:id" element={<ListPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="devices/:id" element={<DevicePage />} />
        <Route path="link" element={<LinkPage />} />
        <Route path="guides" element={<GuidesPage />} />
        <Route path="saves" element={<SavesPage />} />
        <Route path="upload" element={<UploadPage />} />
        <Route path="profile" element={<ProfilePage />} />
        {user.role === 'ADMIN' && (
          <>
            <Route path="admin/paths" element={<AdminPathsPage />} />
            <Route path="admin/storage-setup" element={<StorageSetupPage />} />
            <Route path="admin/files" element={<AdminFilesPage />} />
            <Route path="admin/dats" element={<AdminDatsPage />} />
            <Route path="admin/users" element={<AdminUsersPage />} />
            <Route path="admin/jobs" element={<AdminJobsPage />} />
            <Route path="admin/integrations" element={<AdminIntegrationsPage />} />
            <Route path="admin/sync" element={<AdminSyncPage />} />
            <Route path="admin/review" element={<AdminReviewPage />} />
          </>
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
