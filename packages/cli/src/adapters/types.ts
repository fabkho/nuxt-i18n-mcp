import type { I18nConfig, ProjectConfig } from '../config/types'
import type { LocaleFileFormat } from '../io/formats'

// The format is IO's concept; an adapter only names which one a project uses.
// Re-exported so an adapter keeps declaring it from the module it implements.
export type { LocaleFileFormat } from '../io/formats'

export interface FrameworkAdapter {
  readonly name: string
  readonly label: string
  readonly localeFileFormat: LocaleFileFormat
  /**
   * How strongly this adapter claims the project. `projectConfig` is the
   * project's own declaration when the caller already holds it — `null` when
   * the project declares nothing, `undefined` when no caller had loaded it yet
   * and an adapter that needs it has to read it for itself.
   */
  detect(projectDir: string, projectConfig?: ProjectConfig | null): Promise<number>
  /**
   * The project's own declaration is passed in rather than loaded here: it
   * walks ancestors, parses JSON and executes a TypeScript config, and every
   * adapter — the Nuxt one once per app — used to repeat all of that for the
   * same answer. `null` means the project declares nothing.
   */
  resolve(projectDir: string, projectConfig: ProjectConfig | null): Promise<I18nConfig>
}
