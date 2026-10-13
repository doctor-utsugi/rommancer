import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import { FALLBACK_LOCALE, isLocale } from './locales'

const loaders = import.meta.glob<{ default: object }>('./locales/*.json')

/** Loads a language's strings on first use, then switches to it. */
export async function setLanguage(code: string, remember = true) {
  const lng = isLocale(code) ? code : FALLBACK_LOCALE
  if (!i18n.hasResourceBundle(lng, 'translation')) {
    const load = loaders[`./locales/${lng}.json`]
    if (load) i18n.addResourceBundle(lng, 'translation', (await load()).default)
  }
  await i18n.changeLanguage(lng)
  if (remember) {
    try {
      localStorage.setItem('locale', lng)
    } catch {
      /* storage unavailable */
    }
  }
}

/** Language chosen on this browser; the browser's own language is deliberately ignored. */
const stored = () => {
  try {
    const v = localStorage.getItem('locale')
    return isLocale(v) ? v : null
  } catch {
    return null
  }
}

async function serverDefault() {
  try {
    const r = await fetch('/api/v1/auth/config', { signal: AbortSignal.timeout(2000) })
    const { defaultLocale } = await r.json()
    return isLocale(defaultLocale) ? defaultLocale : FALLBACK_LOCALE
  } catch {
    return FALLBACK_LOCALE
  }
}

await i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: FALLBACK_LOCALE,
  fallbackLng: FALLBACK_LOCALE,
  interpolation: { escapeValue: false },
})

i18n.on('languageChanged', (l) => {
  document.documentElement.lang = l
})

const saved = stored()
await setLanguage(saved ?? (await serverDefault()), !!saved)

export default i18n
