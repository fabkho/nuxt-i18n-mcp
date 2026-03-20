import { resolve } from 'node:path'
import type { I18nConfig } from '../../src/config/types.js'

const playgroundDir = resolve(import.meta.dirname, '../../playground')
const appAdminDir = resolve(playgroundDir, 'app-admin')

const locales = [
  { code: 'de', language: 'de-DE', file: 'de-DE.json' },
  { code: 'en', language: 'en-US', file: 'en-US.json' },
  { code: 'fr', language: 'fr-FR', file: 'fr-FR.json' },
  { code: 'es', language: 'es-ES', file: 'es-ES.json' },
]

const projectConfig = {
  context:
    'This is the anny playground project. It demonstrates a Nuxt app with i18n support, featuring a root layer with shared translations and an app-admin layer with admin-specific translations.',
  layerRules: [
    {
      layer: 'root',
      description:
        'Shared translations used across all apps. Keys like common.actions.*, common.messages.*, common.navigation.*',
      when: "The key is generic enough to be used in multiple apps (e.g., 'Save', 'Cancel', 'Loading...')",
    },
    {
      layer: 'app-admin',
      description:
        'Admin dashboard translations. Keys like admin.*, pages.*, components.* specific to the admin panel.',
      when: 'The key is only relevant to admin functionality',
    },
  ],
  glossary: {
    Buchung: "Booking (never 'Reservation')",
    Ressource: 'Resource (a bookable entity like a room, desk, or person)',
    Termin: 'Appointment',
  },
  translationPrompt:
    'You are translating for a SaaS booking platform. Use professional but approachable tone. Preserve all {placeholders}. Keep translations concise.',
  localeNotes: {
    'de-DE': 'German. Primary language of the platform.',
    'en-US': 'American English.',
    'fr-FR': 'French.',
    'es-ES': 'Spanish.',
  },
  examples: [
    {
      key: 'common.actions.save',
      'de-DE': 'Speichern',
      'en-US': 'Save',
      note: 'Concise, imperative',
    },
  ],
}

/**
 * Fixture config matching what `detectI18nConfig(playgroundDir)` would return.
 *
 * The playground is the root entry-point, so it has a single locale directory
 * under `playground/i18n/locales` with layer name `'root'`.
 */
export function createPlaygroundConfig(): I18nConfig {
  return {
    rootDir: playgroundDir,
    defaultLocale: 'de',
    fallbackLocale: { default: ['en'] },
    locales: structuredClone(locales),
    localeDirs: [
      {
        path: resolve(playgroundDir, 'i18n/locales'),
        layer: 'root',
        layerRootDir: playgroundDir,
      },
    ],
    projectConfig: structuredClone(projectConfig),
  }
}

/**
 * Fixture config matching what `detectI18nConfig(appAdminDir)` would return.
 *
 * When Nuxt is loaded from `playground/app-admin`, layers resolve as:
 *   - _layers[0] = app-admin itself → layer name `'root'` (the cwd)
 *   - _layers[1] = ../playground    → layer name `'playground'` (basename)
 *
 * So there are two locale directories.
 */
export function createAppAdminConfig(): I18nConfig {
  return {
    rootDir: appAdminDir,
    defaultLocale: 'de',
    fallbackLocale: { default: ['en'] },
    locales: structuredClone(locales),
    localeDirs: [
      {
        path: resolve(appAdminDir, 'i18n/locales'),
        layer: 'root',
        layerRootDir: appAdminDir,
      },
      {
        path: resolve(playgroundDir, 'i18n/locales'),
        layer: 'playground',
        layerRootDir: playgroundDir,
      },
    ],
    projectConfig: structuredClone(projectConfig),
  }
}
