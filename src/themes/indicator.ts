import { getActiveTheme } from "./registry.js";
import type { ResolvedThemeWorkingIndicator, Theme } from "./types.js";

const TRUE_LIKE = new Set(["1", "true", "yes", "on"]);
const FALSE_LIKE = new Set(["", "0", "false", "no", "off"]);

export function resolveThemeWorkingIndicator(
	theme: Theme = getActiveTheme(),
	env: NodeJS.ProcessEnv = process.env,
): ResolvedThemeWorkingIndicator {
	const base = theme.workingIndicator;
	const enhanced = base.enhanced;
	if (!enhanced) {
		return {
			name: "default",
			frames: base.frames,
			intervalMs: base.intervalMs,
			capabilityState: "disabled",
		};
	}

	const raw = env[enhanced.capabilityEnv];
	const normalized = String(raw ?? "").trim().toLowerCase();
	if (TRUE_LIKE.has(normalized)) {
		return {
			name: enhanced.name,
			frames: enhanced.frames,
			intervalMs: enhanced.intervalMs,
			capabilityEnv: enhanced.capabilityEnv,
			capabilityState: "enabled",
		};
	}

	return {
		name: "default",
		frames: base.frames,
		intervalMs: base.intervalMs,
		capabilityEnv: enhanced.capabilityEnv,
		capabilityState: FALSE_LIKE.has(normalized) ? "disabled" : "unrecognized",
	};
}
