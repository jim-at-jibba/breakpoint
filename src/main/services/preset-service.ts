import { DEFAULT_PRESETS, type Preset } from '../../shared/presets'
import { RouteError } from '../route-error'
import type { PresetStore } from './preset-store'

/**
 * Presets as the app serves them: seeded with the seven defaults the first time anyone
 * asks, and read from disk on every call after that, so an edit the developer makes in
 * their editor is felt by the next pane they add without restarting the app.
 *
 * Nothing is cached, and nothing is resolved here: turning a preset into a pane is a pure
 * function in the shared module ([ADR-0011]), and this only decides which presets exist.
 */
export class PresetService {
  constructor(private readonly store: PresetStore) {}

  async list(): Promise<{ presets: Preset[] }> {
    const loaded = await this.store.load()
    if (loaded.status === 'refused') {
      // Left untouched on disk: re-seeding over a file the developer wrote is how one
      // mistyped comma costs them every preset they ever edited.
      throw new RouteError('PRESETS_UNREADABLE', `${this.store.file}: ${loaded.message}`, {
        reason: loaded.reason,
        file: this.store.file
      })
    }
    if (loaded.status === 'loaded') return { presets: loaded.presets }

    const presets = [...DEFAULT_PRESETS]
    await this.store.save(presets)
    return { presets }
  }
}
