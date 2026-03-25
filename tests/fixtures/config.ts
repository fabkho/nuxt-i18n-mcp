import { resolve } from 'node:path'
import type { I18nConfig } from '../../src/config/types.js'

export const projectRootDir = resolve(import.meta.dirname, '../..')
const playgroundDir = resolve(projectRootDir, 'playground')
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
  orphanScan: {
    root: {
      scanDirs: ['.', 'app-admin'],
    },
  },
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
    layerRootDirs: [playgroundDir],
    projectConfig: structuredClone(projectConfig),
  }
}

/**
 * Fixture config for monorepo discovery from the project root (no nuxt.config).
 * Discovers `playground/` as a Nuxt app with i18n. `rootDir` = discovery root.
 */
export function createMonorepoConfig(): I18nConfig {
  return {
    rootDir: projectRootDir,
    defaultLocale: 'de',
    fallbackLocale: { default: ['en'] },
    locales: structuredClone(locales),
    localeDirs: [
      {
        path: resolve(playgroundDir, 'i18n/locales'),
        layer: 'playground',
        layerRootDir: playgroundDir,
      },
    ],
    layerRootDirs: [playgroundDir],
    projectConfig: structuredClone(projectConfig),
  }
}
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
    layerRootDirs: [appAdminDir, playgroundDir],
    projectConfig: structuredClone(projectConfig),
  }
}
