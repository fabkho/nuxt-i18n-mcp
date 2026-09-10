/**
 * The guided workflows the server offers as prompts.
 *
 * These are not operations and have no CLI counterpart: they are instructions
 * for a host agent, assembled from the project's own configuration so the plan
 * names the project's layers, locales and glossary rather than generic ones.
 */

import { z } from 'zod'
import { detectI18nConfig } from '@the-i18n-kit/cli'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ProjectConfig } from '@the-i18n-kit/cli'
import type { ProjectScope } from './scope.js'

export function registerPrompts(server: McpServer, scope: ProjectScope): void {
  server.registerPrompt(
    'add-feature-translations',
    {
      title: 'Add Feature Translations',
      description: 'Guided workflow for adding i18n translations when building a new feature.',
      argsSchema: z.object({
        layer: z.string().optional().describe('Target layer (e.g., "root", "app-admin"). If omitted, uses layerRules from project config.'),
        namespace: z.string().optional().describe('Key namespace for the feature (e.g., "admin.users", "common.actions")'),
        projectDir: z.string().optional().describe('Absolute path to the Nuxt project root. Defaults to I18N_PROJECT_DIR, then server cwd. A path outside a configured root is refused.'),
      }),
    },
    async ({ layer, namespace, projectDir }) => {
      // Outside the try: a refused directory is the caller's mistake to see,
      // not a project whose config happened to be unreadable.
      const dir = scope.projectDirFor(projectDir)
      let projectConfigSection = ''

      try {
        const config = await detectI18nConfig(dir)
        projectConfigSection = buildProjectConfigSection(config.projectConfig)
      }
      catch {
        // Config detection failed — still provide the prompt without project context
      }

      const layerHint = layer ? `Target layer: ${layer}` : 'Determine the target layer using the layer rules below, or ask the user.'
      const nsHint = namespace ? `Feature namespace: ${namespace}` : 'Determine the key namespace based on the feature.'

      const promptText = `You are adding i18n translations for a new feature.
${layerHint}
${nsHint}
${projectConfigSection}
Follow these steps:

1. Call \`discover\` to understand the project setup (locales, layers, default locale).
2. Call \`search_translations\` to check for existing similar keys — avoid duplicates.
3. Call \`write_translations\` with mode: 'add' to add keys for ALL locales in a single call.
   - Provide translations for every locale defined in the project.
   - Follow the glossary and style examples if provided above.
   - Preserve all {placeholders} and @:linked.references.
4. If you only provided translations for some locales, call \`translate_missing\` to fill in the rest.
   - Pass \`keys\` explicitly (the exact dot-path keys you just added) to skip the missing-key scan.
   - In provider mode (server env-configured with a provider), it translates and writes directly.
   - In agent mode, it returns fallbackContexts — translate them inline, then persist via \`write_translations\`.
5. Summarize what was added.`

      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: promptText },
          },
        ],
      }
    },
  )

  server.registerPrompt(
    'add-language',
    {
      title: 'Add Language',
      description: 'Add a new language to the project: update framework config, scaffold empty locale files, then translate all keys.',
      argsSchema: z.object({
        language: z.string().describe('Language to add (e.g., "Swedish", "sv", "sv-SE")'),
        projectDir: z.string().optional().describe('Absolute path to the project root. Defaults to I18N_PROJECT_DIR, then server cwd. A path outside a configured root is refused.'),
      }),
    },
    async ({ language, projectDir }) => {
      const dir = scope.projectDirFor(projectDir)
      let configSection = ''

      try {
        const config = await detectI18nConfig(dir)
        configSection += `\nDETECTED FRAMEWORK: ${config.framework ?? 'unknown'}`
        configSection += `\nDEFAULT LOCALE: ${config.defaultLocale}`
        configSection += `\nEXISTING LOCALES: ${config.locales.map(l => `${l.code} (${l.language})`).join(', ')}`
        configSection += `\nLAYERS: ${config.localeDirs.filter(d => !d.aliasOf).map(d => d.layer).join(', ')}`
        configSection += buildProjectConfigSection(config.projectConfig)
      }
      catch {
        configSection += '\nConfig detection failed — you will need to call discover manually.'
      }

      const promptText = `Add "${language}" as a new language to this project.
${configSection}

Follow these steps:

1. Add the new locale to the framework configuration:
   - **Nuxt**: Add the locale entry to \`i18n.locales\` in \`nuxt.config.ts\` (code, language, file).
   - **Laravel**: Add the locale code to the \`available_locales\` array in \`config/app.php\`.
2. Call \`scaffold_locale\` with the new locale code to create empty locale files in all layers.
3. Call \`translate_missing\` for each layer to translate all keys from the default locale. Concurrency is handled internally — each layer call is independent and can run in parallel.
   - In provider mode (server env-configured with a provider), it translates and writes directly.
   - In agent mode, it returns fallbackContexts — translate them inline, then call \`write_translations\` with mode: 'update'.
4. Call \`get_missing_translations\` to verify the new locale has zero missing keys in every layer.
5. Report a summary: locale code added, files created, keys translated per layer.`

      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: promptText },
          },
        ],
      }
    },
  )
}

function buildProjectConfigSection(pc: ProjectConfig | undefined): string {
  if (!pc) return ''
  let s = ''
  if (pc.context) s += `\nPROJECT CONTEXT: ${pc.context}\n`
  if (pc.layerRules?.length) {
    s += '\nLAYER RULES:\n'
    for (const rule of pc.layerRules) {
      s += `- ${rule.layer}: ${rule.description} (when: ${rule.when})\n`
    }
  }
  if (pc.glossary && Object.keys(pc.glossary).length > 0) {
    s += '\nGLOSSARY:\n'
    for (const [term, definition] of Object.entries(pc.glossary)) {
      s += `- ${term} → ${definition}\n`
    }
  }
  if (pc.translationPrompt) s += `\nTRANSLATION STYLE: ${pc.translationPrompt}\n`
  if (pc.localeNotes && Object.keys(pc.localeNotes).length > 0) {
    s += '\nLOCALE NOTES:\n'
    for (const [locale, note] of Object.entries(pc.localeNotes)) {
      s += `- ${locale}: ${note}\n`
    }
  }
  if (pc.examples?.length) {
    s += '\nEXAMPLES:\n'
    for (const ex of pc.examples) {
      const pairs = Object.entries(ex)
        .filter(([k]) => k !== 'key' && k !== 'note')
        .map(([locale, val]) => `${locale}: "${val}"`)
        .join(', ')
      s += `- ${ex.key}: ${pairs}${ex.note ? ` (${ex.note})` : ''}\n`
    }
  }
  return s
}
