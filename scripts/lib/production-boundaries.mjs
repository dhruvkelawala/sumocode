// Effect itself is an approved production dependency; only its property-test
// and serialization transitive dependencies must stay out of shipped graphs.
const FORBIDDEN_PRODUCTION_PACKAGES = ["fast-check", "msgpackr"];

function normalizePath(path) {
	return path.replaceAll("\\", "/");
}

function importedPackage(path, packageNames) {
	const normalized = normalizePath(path);
	for (const packageName of packageNames) {
		if (normalized === packageName || normalized.startsWith(`${packageName}/`)) return packageName;
		if (`/${normalized}`.includes(`/node_modules/${packageName}/`) || normalized.endsWith(`/node_modules/${packageName}`)) return packageName;
	}
	return undefined;
}

function outputSpecifiers(outputText) {
	const specifiers = [];
	for (const pattern of [
		/\bfrom\s*["']([^"'\n]+)["']/gu,
		/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/gu,
		/\bimport\s*["']([^"'\n]+)["']/gu,
		/\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/gu,
	]) {
		for (const match of outputText.matchAll(pattern)) {
			if (match[1]) specifiers.push(match[1]);
		}
	}
	return specifiers;
}

/** Reject forbidden dependencies whether bundled or left as artifact imports. */
export function assertNoProductionDependencyLeakage(metafile, artifact, outputText = "") {
	const candidates = [
		...Object.keys(metafile.inputs ?? {}),
		...Object.values(metafile.outputs ?? {}).flatMap((output) => (output.imports ?? []).map((imported) => imported.path)),
		...outputSpecifiers(outputText),
	];
	const leaks = candidates.flatMap((path) => {
		const packageName = importedPackage(path, FORBIDDEN_PRODUCTION_PACKAGES);
		return packageName ? [{ packageName, path }] : [];
	});
	if (leaks.length === 0) return;
	const names = [...new Set(leaks.map(({ packageName }) => packageName))].sort();
	throw new Error(`${artifact} includes forbidden production package${names.length === 1 ? "" : "s"} ${names.join(", ")} (${leaks[0].path})`);
}

/**
 * Follow only eager imports from an entry point. Dynamic local imports are lazy
 * boundaries, but a direct dynamic import of a forbidden package still fails.
 */
export function assertNoEffectInEagerClosure(metafile, entryPoint, artifact) {
	const inputs = metafile.inputs ?? {};
	const inputKeys = new Map(Object.keys(inputs).map((path) => [normalizePath(path), path]));
	const entryKey = inputKeys.get(normalizePath(entryPoint));
	if (!entryKey) throw new Error(`${artifact} metafile is missing entry point ${entryPoint}`);

	const pending = [{ input: entryKey, trace: [entryKey] }];
	const visited = new Set();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || visited.has(current.input)) continue;
		visited.add(current.input);

		for (const imported of inputs[current.input]?.imports ?? []) {
			const forbidden = importedPackage(imported.path, ["effect"]);
			if (forbidden) {
				throw new Error(`${artifact} eager closure includes forbidden package ${forbidden} via ${[...current.trace, imported.path].join(" -> ")}`);
			}
			if (imported.kind === "dynamic-import" || imported.external) continue;
			const target = inputKeys.get(normalizePath(imported.path));
			if (target) pending.push({ input: target, trace: [...current.trace, target] });
		}
	}
}
