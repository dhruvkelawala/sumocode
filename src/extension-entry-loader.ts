export interface ExtensionEntryImportOptions<T> {
	readonly bundlePath: string;
	readonly sourcePath: string;
	readonly useBundle: boolean;
	readonly bundleImporter: (path: string) => Promise<T>;
	readonly sourceImporter: (path: string) => Promise<T>;
	readonly onBundleFailure?: (error: unknown) => void;
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
			return await options.bundleImporter(options.bundlePath);
		} catch (error) {
			options.onBundleFailure?.(error);
		}
	}
	return options.sourceImporter(options.sourcePath);
}
