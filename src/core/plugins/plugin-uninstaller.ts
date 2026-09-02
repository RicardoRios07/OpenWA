import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../common/services/logger.service';
import { PluginInstance } from './plugin.interfaces';
import { PluginStorageService } from './plugin-storage.service';

/**
 * The uninstall half of the plugin loader: fully remove an installed user plugin — disable + unload
 * from the runtime, drop its persisted registry entry, and delete its directories from disk. Install,
 * download and unpack live feature-side (modules/plugins); this is the runtime-owned removal they and
 * the REST surface call through PluginLoaderService.
 *
 * Split out of PluginLoaderService so the loader reads as the public facade while the removal
 * contract — package-dir provenance, the traversal guard, split-dir storage cleanup — is reviewed on
 * its own. A plain class, not a Nest provider: the loader constructs it in its constructor (the same
 * pattern as PluginSandboxBridge / PluginCapabilityContext), so the loader's public constructor
 * signature — which specs build directly — is unchanged.
 */
export class PluginUninstaller {
  constructor(
    // The LOADER's logger, deliberately — uninstall lines carry the PluginLoaderService tag, and
    // that context is operator-visible. Creating a second logger here would silently retag every
    // uninstall log line the moment this moved.
    private readonly logger: ReturnType<typeof createLogger>,
    // The LOADER's plugin registry, passed BY REFERENCE (see the class doc): reads here see the same
    // map the loader, the scanner and the bridge share.
    private readonly plugins: Map<string, PluginInstance>,
    private readonly pluginStorage: PluginStorageService,
    private readonly pluginsDir: string,
    /** The lifecycle's unload — passed as a callback so this file never imports the lifecycle back. */
    private readonly unload: (pluginId: string) => Promise<void>,
  ) {}

  /** <plugins.dir>/<id> for an id with no loaded package, or null if the id escapes that root. */
  private resolveUninstallDir(pluginId: string): string | null {
    const base = path.resolve(this.pluginsDir);
    const dir = path.resolve(base, pluginId);
    return dir !== base && dir.startsWith(base + path.sep) ? dir : null;
  }

  /**
   * Fully remove an installed user plugin: disable + unload from the runtime, drop its persisted
   * registry entry, and delete its directory from disk. Built-ins (engines, bundled extensions) are
   * registered programmatically with no on-disk dir and must never be removable.
   */
  async uninstallPlugin(pluginId: string): Promise<void> {
    if (this.pluginStorage.getPluginEntry(pluginId)?.builtIn) {
      throw new Error(`Cannot uninstall built-in plugin ${pluginId}`);
    }

    // Read the package location BEFORE unloading: unloadPlugin drops the runtime record that holds
    // it, and for a plugin loaded from the legacy directory the configured root is the wrong tree —
    // deleting there removes the ctx.storage directory and leaves the code, so the plugin comes
    // back on the next boot having reported a successful uninstall.
    const recordedDir = this.plugins.get(pluginId)?.packageDir ?? null;

    if (this.plugins.has(pluginId)) {
      await this.unload(pluginId);
    }
    this.pluginStorage.deletePluginEntry(pluginId);

    // A recorded directory came from the boot scan and is already contained. Without one the id is
    // the only input, so it stays behind the traversal guard against the configured root.
    const dir = recordedDir ?? this.resolveUninstallDir(pluginId);
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // Drop the plugin's ctx.storage data dir. Under shipped defaults it lives INSIDE the package
    // dir (already gone above), but a split-dir deployment (PLUGINS_DIR outside the data dir) would
    // otherwise leak <dataDir>/plugins/<id> — persisted secrets included — on every uninstall.
    // Best-effort, and strictly that one plugin's directory.
    this.pluginStorage.deletePluginData(pluginId);

    this.logger.log(`Plugin uninstalled: ${pluginId}`, { pluginId, action: 'plugin_uninstalled' });
  }
}
