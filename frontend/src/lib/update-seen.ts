import { useSyncExternalStore } from 'react'

// The newest version this browser's admin has looked at in Administration > Update: Update's badge stays off until a
// newer one comes out
const KEY = 'rommancer-update-seen'
const EVENT = 'rommancer-update-seen'

const read = () => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function markUpdateSeen(version: string) {
  if (read() === version) return
  try {
    localStorage.setItem(KEY, version)
  } catch {
    // Without storage the badge shows until the update is done
  }
  window.dispatchEvent(new Event(EVENT))
}

export function useUpdateSeen() {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(EVENT, onChange)
      window.addEventListener('storage', onChange)
      return () => {
        window.removeEventListener(EVENT, onChange)
        window.removeEventListener('storage', onChange)
      }
    },
    read,
  )
}
