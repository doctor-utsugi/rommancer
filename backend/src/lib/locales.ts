import { z } from 'zod';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';

/** Per-language preferences that are not UI text. Adding a language is one entry here plus one JSON file in the frontend. */
export const LOCALES = {
  en: { regions: ['USA', 'World', 'Europe', 'Japan'], ssRegions: ['us', 'wor'], languages: ['en', 'es', 'fr'], favorites: 'Favorites' },
  es: { regions: ['Spain', 'Europe', 'USA', 'World', 'Japan'], ssRegions: ['sp', 'eu'], languages: ['es', 'en', 'fr'], favorites: 'Favoritos' },
} as const;

export type Locale = keyof typeof LOCALES;
export const LOCALE_CODES = Object.keys(LOCALES) as [Locale, ...Locale[]];
export const localeSchema = z.enum(LOCALE_CODES);

export function localePrefs(locale: string | null | undefined) {
  return LOCALES[(locale as Locale) in LOCALES ? (locale as Locale) : 'en'];
}

const KEY = 'default.locale';

/** Language for new accounts: the admin's choice, else DEFAULT_LOCALE, else English. */
export async function defaultLocale(): Promise<Locale> {
  const v = (await prisma.setting.findUnique({ where: { key: KEY } }))?.value ?? env.defaultLocale;
  return v in LOCALES ? (v as Locale) : 'en';
}

export async function setDefaultLocale(locale: Locale) {
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: locale }, update: { value: locale } });
}
