// Fails when a language is missing keys, has extra ones, or changes the {{placeholders}} / plural forms of the English source.
import { readdirSync, readFileSync } from 'node:fs'

const dir = new URL('../src/i18n/locales/', import.meta.url)
const flat = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o)) typeof v === 'object' && v ? flat(v, `${p}${k}.`, out) : (out[p + k] = v)
  return out
}
const load = (f) => flat(JSON.parse(readFileSync(new URL(f, dir), 'utf8')))
const vars = (s) => [...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',')
const base = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '')

const en = load('en.json')
let bad = 0
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
  const tr = load(f)
  const enBases = new Set(Object.keys(en).map(base))
  const report = (m) => (bad++, console.error(`${f}: ${m}`))
  for (const k of Object.keys(tr)) if (!enBases.has(base(k))) report(`extra key ${k}`)
  for (const b of enBases) if (!Object.keys(tr).some((k) => base(k) === b)) report(`missing key ${b}`)
  for (const [k, v] of Object.entries(tr)) {
    const src = en[k] ?? en[`${base(k)}_one`] ?? en[`${base(k)}_other`]
    if (src !== undefined && typeof v === 'string' && vars(v) !== vars(src) && !/_(one|other)$/.test(k)) report(`placeholders differ in ${k}`)
    if (typeof v === 'string' && v.trim() === '') report(`empty ${k}`)
  }
}
if (bad) process.exit(1)
console.log('i18n: all locales match en.json')
