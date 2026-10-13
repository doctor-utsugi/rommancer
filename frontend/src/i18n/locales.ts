/** Languages the panel can show, with their native names. A new language is a JSON file in ./locales plus a line here. */
export const LOCALES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
] as const

export const FALLBACK_LOCALE = 'en'
export const isLocale = (code: string | null | undefined): code is string => LOCALES.some((l) => l.code === code)
