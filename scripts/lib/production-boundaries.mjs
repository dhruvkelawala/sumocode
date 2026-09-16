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

/**
 * Follow only eager imports from an entry point. Dynamic local imports are lazy
 * boundaries, but a direct dynamic import of a forbidden package still fails.
 */
export function assertEagerClosureExcludesPackages(metafile, entryPoint, packageNames, artifact) {
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
			const forbidden = importedPackage(imported.path, packageNames);
			if (forbidden) {
				throw new Error(`${artifact} eager closure includes forbidden package ${forbidden} via ${[...current.trace, imported.path].join(" -> ")}`);
			}
			if (imported.kind === "dynamic-import" || imported.external) continue;
			const target = inputKeys.get(normalizePath(imported.path));
			if (target) pending.push({ input: target, trace: [...current.trace, target] });
		}
	}
}
