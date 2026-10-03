import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from './en'
import { es } from './es'

const saved = localStorage.getItem('locale')
const browser = navigator.language?.startsWith('es') ? 'es' : 'en'

void i18n.use(initReactI18next).init({
  resources: { es: { translation: es }, en: { translation: en } },
  lng: saved ?? browser,
  fallbackLng: 'es',
  interpolation: { escapeValue: false },
})

i18n.on('languageChanged', (l) => {
  localStorage.setItem('locale', l)
  document.documentElement.lang = l
})

export default i18n
