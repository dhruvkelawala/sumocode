import { eslintCompatPlugin } from "@oxlint/plugins";

import { noRestrictedImportsRule } from "./rules/no-restricted-imports.ts";
import { noServiceConstructorImportsRule } from "./rules/no-service-constructor-imports.ts";

/** Opt-in Oxlint rules for Effect service and Layer architecture. */
const antiSlopEffectPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop-effect" },
	rules: {
		"no-restricted-imports": noRestrictedImportsRule,
		"no-service-constructor-imports": noServiceConstructorImportsRule,
	},
});

export default antiSlopEffectPlugin;
