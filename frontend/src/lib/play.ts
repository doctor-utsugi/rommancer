import { toast } from 'sonner'
import { authUrl, get } from '@/lib/api'
import { errMsg } from '@/components/common'

/** Systems the browser emulator plays (the server has the same list, backend/src/lib/websystems.ts) */
export const WEB_SYSTEMS = ['nes', 'fds', 'snes', 'gb', 'gbc', 'gba', 'md', 'sms', 'gg', 'sega32x', 'pcengine', 'ngp', 'ngpc', 'wswan', 'wswanc', 'lynx', 'a7800', 'atari2600', 'virtualboy', 'colecovision']

/**
 * Opens the browser emulator in a new tab with what the server's play endpoint (PATH) says: the system, the rom and,
 * for a save, its file, with their download links in the page's address fragment. Nothing played there is kept. The
 * tab opens at once (a tab opened after waiting for the server would be blocked as a popup)
 */
export async function openPlayer(path: string, t: (k: string) => string) {
  const tab = window.open('about:blank', '_blank')
  try {
    const p = await get<any>(path)
    const cfg = { ...p, romUrl: authUrl(p.romUrl), ...(p.fileUrl ? { fileUrl: authUrl(p.fileUrl) } : {}) }
    const url = `/emulatorjs/play.html#${encodeURIComponent(JSON.stringify(cfg))}`
    if (tab) tab.location.href = url
    else window.open(url, '_blank')
  } catch (e) {
    tab?.close()
    toast.error(`${t('more.saves.playFailed')}: ${errMsg(e)}`)
  }
}
