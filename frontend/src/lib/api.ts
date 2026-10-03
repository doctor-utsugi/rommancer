const BASE = '/api/v1'

export class ApiError extends Error {
  status: number
  data: unknown
  constructor(status: number, message: string, data?: unknown) {
    super(message)
    this.status = status
    this.data = data
  }
}

const store = {
  get access() {
    return localStorage.getItem('accessToken')
  },
  get refresh() {
    return localStorage.getItem('refreshToken')
  },
  // Token solo para ficheros (imagenes y descargas por URL)
  get files() {
    return localStorage.getItem('filesToken')
  },
  set(access: string, refresh: string, files?: string) {
    localStorage.setItem('accessToken', access)
    localStorage.setItem('refreshToken', refresh)
    if (files) localStorage.setItem('filesToken', files)
  },
  clear() {
    localStorage.removeItem('accessToken')
    localStorage.removeItem('refreshToken')
    localStorage.removeItem('filesToken')
  },
}

export const tokens = store

let refreshing: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
  const rt = store.refresh
  if (!rt) return false
  refreshing ??= fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
  })
    .then(async (r) => {
      if (!r.ok) return false
      const j = await r.json()
      store.set(j.accessToken, j.refreshToken, j.filesToken)
      return true
    })
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

export async function api<T = any>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const isForm = body instanceof FormData
  const headers: Record<string, string> = {}
  if (store.access) headers.Authorization = `Bearer ${store.access}`
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json'
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  if (r.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await tryRefresh()) return api<T>(method, path, body, false)
    store.clear()
    window.dispatchEvent(new Event('auth:logout'))
  }
  const text = await r.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!r.ok) throw new ApiError(r.status, data?.error ?? r.statusText, data)
  return data as T
}

export const get = <T = any>(p: string) => api<T>('GET', p)
export const post = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b ?? {})
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b)
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b)
export const del = <T = any>(p: string) => api<T>('DELETE', p)

/** URL con token para descargas directas e imagenes. */
export function authUrl(path: string) {
  const full = path.startsWith('/api/') ? path : `${BASE}${path}`
  const sep = full.includes('?') ? '&' : '?'
  return `${full}${sep}token=${encodeURIComponent(store.files ?? '')}`
}

/** Subida con progreso (XHR). */
export function upload<T = any>(path: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}${path}`)
    if (store.access) xhr.setRequestHeader('Authorization', `Bearer ${store.access}`)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100))
    xhr.onload = () => {
      let data: any = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        data = xhr.responseText
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else reject(new ApiError(xhr.status, data?.error ?? xhr.statusText, data))
    }
    xhr.onerror = () => reject(new ApiError(0, 'Network error'))
    xhr.send(form)
  })
}

export interface Paged<T> {
  total: number
  page: number
  pageSize: number
  items: T[]
}
