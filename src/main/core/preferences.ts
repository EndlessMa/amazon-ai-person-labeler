import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppPreferences } from '../../shared/contracts'
import { atomicWrite } from './runtime-fs'

const DEFAULT_PREFERENCES: AppPreferences = {
  recursive: true,
  showThumbnails: true,
  defaultOutputFolder: ''
}

export class PreferencesStore {
  private readonly path: string

  constructor(appDataDirectory: string) {
    this.path = join(appDataDirectory, 'preferences.json')
  }

  async get(): Promise<AppPreferences> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object') return DEFAULT_PREFERENCES
      const record = raw as Record<string, unknown>
      return {
        recursive:
          typeof record.recursive === 'boolean'
            ? record.recursive
            : DEFAULT_PREFERENCES.recursive,
        showThumbnails:
          typeof record.showThumbnails === 'boolean'
            ? record.showThumbnails
            : DEFAULT_PREFERENCES.showThumbnails,
        defaultOutputFolder:
          typeof record.defaultOutputFolder === 'string'
            ? record.defaultOutputFolder
            : DEFAULT_PREFERENCES.defaultOutputFolder
      }
    } catch {
      return DEFAULT_PREFERENCES
    }
  }

  async set(preferences: AppPreferences): Promise<void> {
    const validated: AppPreferences = {
      recursive: Boolean(preferences.recursive),
      showThumbnails: Boolean(preferences.showThumbnails),
      defaultOutputFolder:
        typeof preferences.defaultOutputFolder === 'string'
          ? preferences.defaultOutputFolder
          : ''
    }
    await atomicWrite(this.path, `${JSON.stringify(validated, null, 2)}\n`)
  }
}
