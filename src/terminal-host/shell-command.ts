/**
 * POSIX single-quote escape. Wraps `value` in single quotes and escapes any
 * literal single quote inside. Safe for paths with spaces, parentheses, and
 * shell metacharacters — including SumoCode's own `/Volumes/SumoDeus NVMe`
 * dev path.
 */
export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Build a login-shell command that changes directory before running a command. */
export function buildShellCommand(cwd: string, command: string): string {
	const shellCommand = ["cd", shellEscape(cwd), "&&", command].join(" ");
	return ["bash", "-lc", shellEscape(shellCommand)].join(" ");
}
