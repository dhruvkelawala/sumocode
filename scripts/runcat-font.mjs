#!/usr/bin/env node
import { checkInstalledRuncatFont, installRuncatFont, resolveUserFontDestination } from "./lib/runcat-font.mjs";

function printFollowUp(destination) {
	console.log(`RunCat font destination: ${destination}`);
	console.log("Restart Ghostty/Herdr/SumoCode after changing font mapping or env.");
	console.log("font-codepoint-map = U+E900-U+E904=icomoon");
	console.log("env = SUMOCODE_RUNCAT_FONT=1");
	console.log("Rollback: set env = SUMOCODE_RUNCAT_FONT=0 and restart to restore the orbital fallback.");
	console.log("Note: this verifies the font file and hash only, not Ghostty's live codepoint map.");
}

function main() {
	const command = process.argv[2];
	if (command !== "check" && command !== "install") {
		console.error("usage: node scripts/runcat-font.mjs check|install");
		process.exit(2);
	}

	if (command === "check") {
		const result = checkInstalledRuncatFont();
		if (!result.ok) {
			console.error(`RunCat font check failed: source=${result.source.status} destination=${result.destination.status}`);
			console.error(`Expected destination: ${resolveUserFontDestination()}`);
			process.exit(1);
		}
		console.log("RunCat font verified");
		printFollowUp(result.destination.path);
		return;
	}

	const result = installRuncatFont();
	if (!result.ok) {
		console.error(`RunCat font install refused: source=${result.source.status} destination=${result.destination.status}`);
		if (result.destination.reason) console.error(`Reason: ${result.destination.reason}`);
		process.exit(1);
	}
	console.log(result.action === "already-installed" ? "RunCat font already installed" : "RunCat font installed");
	printFollowUp(result.destination.path);
}

main();
