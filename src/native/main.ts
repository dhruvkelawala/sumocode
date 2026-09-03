/**
 * Native executable entry (plan 117). Compiled by `scripts/build-native.mjs`
 * into the `bin/sumocode` host binary. Step 2 ships this placeholder so the
 * native build pipeline is real; Step 4 replaces it with the full launcher
 * contract (argv roles, child pre-spawn, host `main()`).
 */
declare const __SUMOCODE_VERSION__: string | undefined;

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
	// Inlined at build time by scripts/build-native.mjs (--define).
	console.log(`sumocode ${__SUMOCODE_VERSION__ ?? "0.0.0"}`);
	process.exit(0);
}

process.stderr.write("[sumocode] native entry is not implemented yet (plan 117 step 4 pending)\n");
process.exit(70);
