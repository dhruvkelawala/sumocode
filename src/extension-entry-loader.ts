export interface ExtensionEntryImportOptions<T> {
	readonly bundlePath: string;
	readonly sourcePath: string;
	readonly useBundle: boolean;
	readonly bundleImporter: (path: string) => Promise<T>;
	readonly sourceImporter: (path: string) => Promise<T>;
	readonly onBundleFailure?: (error: Error) => void;
	/**
	 * Re-checked AFTER the bundle import resolves. A source edit or rebuild that
	 * lands in the check/import window makes this return false, so the shim
	 * discards the now-stale bundle and takes the source fallback.
	 */
	readonly revalidate?: () => boolean;
}

/**
 * Imports the validated bundle when possible, but keeps the source entry as
 * the final runtime fallback. Content freshness proves artifact identity, not
 * that native resolution of its external peer imports will succeed in every
 * Pi installation.
 */
export async function importExtensionEntry<T>(options: ExtensionEntryImportOptions<T>): Promise<T> {
	if (options.useBundle) {
		try {
			const bundleModule = await options.bundleImporter(options.bundlePath);
			if (options.revalidate && !options.revalidate()) {
				throw new Error("extension bundle changed during import");
			}
			return bundleModule;
		} catch (error) {
			options.onBundleFailure?.(error instanceof Error ? error : new Error(String(error)));
		}
	}
	return options.sourceImporter(options.sourcePath);
}
