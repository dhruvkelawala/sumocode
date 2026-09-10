/**
 * Shared launcher CLI contract (issue 484).
 *
 * One table owns every SumoCode-owned command, alias, option, help line and
 * exit code so the native binary (`sc`, src/native/main.ts) and
 * `bin/sumocode.sh` cannot drift apart the way #483 did (`-w` worked in the
 * shell launcher and exited 64 in native).
 *
 * Consumers:
 *  - `src/native/main.ts` imports the tables directly (Bun bundle).
 *  - `bin/sumocode.sh` renders its help from this module through plain `node`
 *    and mirrors the tables in its case loop, which stays literal so the shell
 *    parser remains readable top-to-bottom.
 *  - `test/integration/launcher-runtime-contract.ts` derives its parity matrix
 *    from these tables and runs every spelling through BOTH launchers, so a
 *    one-sided command addition fails CI.
 *
 * Keep this module dependency-free and erasable-syntax-only: the shell loads it
 * with `node --input-type=module -e "await import(...)"`, which has no bundler
 * and no jiti. A relative import or a non-erasable construct breaks that path.
 */

export const LAUNCHER_BIN_NAME = "sumocode";

/** Exit statuses every launcher spelling must agree on. */
export const LAUNCHER_EXIT_CODES = Object.freeze({
	success: 0,
	usage: 64,
	doctorFailure: 70,
});

export type LauncherCommand = "run" | "doctor" | "diag" | "task" | "worktree";

export interface LauncherCommandSpec {
	/** Canonical spelling. */
	readonly command: LauncherCommand;
	/** Extra spellings that select the same command (`worktree`: -w/--worktree, #483). */
	readonly aliases: readonly string[];
	/** USAGE rows, rendered after the binary name. */
	readonly usage: readonly string[];
	/** COMMANDS block for the help output. */
	readonly help: string;
}

export const LAUNCHER_COMMANDS: readonly LauncherCommandSpec[] = [
	{
		command: "run",
		aliases: [],
		usage: ["[options] [path]"],
		help: `  run [path]
      Open SumoCode in [path] (the default when no command is given). Any
      remaining arguments are forwarded to Pi unchanged.`,
	},
	{
		command: "doctor",
		aliases: [],
		usage: ["doctor [options]"],
		help: `  doctor
      Check local SumoCode/Pi installation health: Node version, Pi binary,
      RPC host availability, Pi module resolution, and diagnostics path
      writability.`,
	},
	{
		command: "diag",
		aliases: [],
		usage: ["diag [file]"],
		help: `  diag [file]
      Summarize a diagnostics JSONL file. Defaults to /tmp/sumocode-manual.jsonl.`,
	},
	{
		command: "task",
		aliases: [],
		usage: ["task <prompt> [path]"],
		help: `  task <prompt> [path]
  task --prompt-file <abs-path> [path]
  task --task-dir <abs-path> [path]
      Open SumoCode and immediately start an agent turn on <prompt>.
      Skips the splash screen, forwards <prompt> to Pi as the kickoff user
      message, and stays interactive afterwards. Designed for the orchestrator
      bg_task hand-off flow: the spawned terminal pane goes straight into the
      agent loop with no manual typing.

      Use --prompt-file <path> instead of an inline prompt when the prompt is
      long or contains shell metacharacters — the launcher reads the file and
      forwards its contents as the kickoff message. This keeps the terminal
      respawn-pane command short so it doesn't flash a wall of text in the
      pane before Pi takes over the screen.

      Sets SUMOCODE_TASK_MODE=1 in the launched process so the extension
      knows to skip splash and other onboarding UI.`,
	},
	{
		command: "worktree",
		aliases: ["-w", "--worktree"],
		usage: ["-w [name]"],
		help: `  -w, --worktree [name]
      Create and open a new sumo/<name> worktree in the current terminal
      host, run the configured worktree setup, and start SumoCode there.
      If name is omitted, a unique wt-<timestamp> name is generated.`,
	},
];

export type LauncherOptionId =
	| "debug"
	| "diag-file"
	| "no-clear-diag"
	| "prompt-file"
	| "task-dir"
	| "no-sumo-tui"
	| "dry-run"
	| "version"
	| "help";

export interface LauncherOptionSpec {
	readonly id: LauncherOptionId;
	/** Every accepted spelling, canonical first. */
	readonly flags: readonly string[];
	readonly takesValue: boolean;
	/** OPTIONS block for the help output. */
	readonly help: string;
}

export const LAUNCHER_OPTIONS: readonly LauncherOptionSpec[] = [
	{
		id: "debug",
		flags: ["-d", "--debug"],
		takesValue: false,
		help: `  -d, --debug
      Enable manual-test diagnostics / flight-recorder mode.

      In debug mode, SumoCode writes structured JSONL diagnostics to:

        /tmp/sumocode-manual.jsonl

      unless SUMO_TUI_DIAG_FILE is already set. The file is cleared at startup
      so every debug run starts with a fresh trace.

      Debug mode also exports:
        SUMO_TUI_DEBUG=1
        SUMOCODE_DEBUG_BRANCH=<current git branch, when available>
        SUMOCODE_DEBUG_COMMIT=<current git commit summary, when available>

      Diagnostics are intentionally no-op in normal mode.`,
	},
	{
		id: "diag-file",
		flags: ["--diag-file"],
		takesValue: true,
		help: `  --diag-file <path>
      Write debug diagnostics to <path>. Implies --debug.`,
	},
	{
		id: "no-clear-diag",
		flags: ["--no-clear-diag"],
		takesValue: false,
		help: `  --no-clear-diag
      Do not delete the diagnostics file at debug startup. By default, debug
      mode starts with a fresh trace.`,
	},
	{
		id: "prompt-file",
		flags: ["--prompt-file"],
		takesValue: true,
		help: `  --prompt-file <path>
      Used with 'sumocode task'. Reads the file at <path> and forwards its
      contents as the kickoff user message. The file must exist when the
      launcher runs. Contents are read as a single argument (newlines and
      shell metacharacters survive intact).`,
	},
	{
		id: "task-dir",
		flags: ["--task-dir"],
		takesValue: true,
		help: `  --task-dir <path>
      Internal orchestration contract for visible agents. Reads prompt.txt
      from the directory and writes task lifecycle files alongside it.`,
	},
	{
		id: "no-sumo-tui",
		flags: ["--no-sumo-tui"],
		takesValue: false,
		help: `  --no-sumo-tui
      Bypass the foreground RPC host for this launch and execute Pi directly
      with the SumoCode extension loaded. Useful for diagnostics and
      non-runtime comparisons.`,
	},
	{
		id: "dry-run",
		flags: ["--dry-run"],
		takesValue: false,
		help: `  --dry-run
      Print the resolved launch configuration and exit without starting Pi.`,
	},
	{
		id: "version",
		flags: ["-v", "--version"],
		takesValue: false,
		help: `  -v, --version
      Print SumoCode version (and git commit when available), then exit.`,
	},
	{
		id: "help",
		flags: ["-h", "--help"],
		takesValue: false,
		help: `  -h, --help
      Show this help message and exit.`,
	},
];

export function launcherCommandForToken(token: string): LauncherCommand | undefined {
	for (const spec of LAUNCHER_COMMANDS) {
		if (spec.command === token || spec.aliases.includes(token)) return spec.command;
	}
	return undefined;
}

export function launcherOptionForToken(token: string): LauncherOptionSpec | undefined {
	for (const spec of LAUNCHER_OPTIONS) {
		if (spec.flags.includes(token)) return spec;
	}
	return undefined;
}

/** `${flag}=${value}` spelling accepted for every value-taking option. */
export function launcherOptionForEqualsToken(token: string): LauncherOptionSpec | undefined {
	if (!token.startsWith("--")) return undefined;
	const equalsIndex = token.indexOf("=");
	if (equalsIndex === -1) return undefined;
	const option = launcherOptionForToken(token.slice(0, equalsIndex));
	return option !== undefined && option.takesValue ? option : undefined;
}

/**
 * The canonical `-h/--help` document. Both launchers render this exact text,
 * so the command and option blocks can never describe a different CLI than the
 * one the parsers accept.
 */
export function renderLauncherHelp(binName: string = LAUNCHER_BIN_NAME): string {
	const usage = LAUNCHER_COMMANDS.flatMap((spec) => spec.usage.map((row) => `  ${binName} ${row}`));
	const commands = LAUNCHER_COMMANDS.map((spec) => spec.help).join("\n\n");
	const options = LAUNCHER_OPTIONS.map((spec) => spec.help).join("\n\n");
	return `SumoCode — Cathedral terminal AI coding agent

USAGE
${usage.join("\n")}

ARGUMENTS
  path
      Optional project directory to open. If omitted, SumoCode starts in the
      current working directory. The path is forwarded to Pi unchanged, so all
      normal Pi path handling still applies.

  Pi's own options are forwarded unchanged (for example --offline,
  --no-session, --no-extensions, --provider, and --model). Anything that is
  neither a SumoCode command/option nor a Pi option is rejected with a usage
  error instead of reaching Pi.

COMMANDS
${commands}

OPTIONS
  --
      End SumoCode option parsing. For run/task launches, one delimiter is
      preserved for Pi so following dash-leading tokens are treated as
      positionals/messages instead of SumoCode options.

${options}

EXAMPLES
  Start in the current directory:
      ${binName}

  Start in an explicit project directory:
      ${binName} .
      ${binName} /path/to/project

  Open a named worktree and start SumoCode there:
      ${binName} -w new-worktree

  Start with diagnostics enabled:
      ${binName} -d
      ${binName} --debug

  Start a specific project with diagnostics enabled:
      ${binName} -d .
      ${binName} --debug /path/to/project

  Use a custom diagnostics file:
      ${binName} -d --diag-file /tmp/my-run.jsonl
      SUMO_TUI_DIAG_FILE=/tmp/my-run.jsonl ${binName} -d

  Keep appending to an existing diagnostics file:
      ${binName} -d --no-clear-diag

  Bypass the foreground RPC host for diagnostics:
      ${binName} --no-sumo-tui .

  Check installation health:
      ${binName} doctor

  Summarize a debug run:
      ${binName} diag
      ${binName} diag /tmp/my-run.jsonl
      node scripts/diag-summary.mjs /tmp/sumocode-manual.jsonl

DIAGNOSTICS EVENTS
  Debug mode may record events such as:
      process_preload_start  Node preload + argv baseline for startup traces
      process_module_load_*  slow module imports + aggregate module-load summary
      host_import_ready      selected host source/bundle imported
      rpc_child_ready        first correlated RPC response received
      terminal_index_*       initial terminal-store index phase
      runtime_start          process, cwd, branch, commit, terminal size
      boot_screen_frame      first retained splash/boot frame written to terminal
      editor_ready           first retained frame painted; input can be edited
      input_ready            deprecated one-release alias for editor_ready
      hydration_committed    authoritative initial state/transcript applied
      app_ready              deprecated historical chrome-ready alias
      stable_chrome_ready    owned-shell render with the real session UI
      command_ready          hydration settled; commands can dispatch
      render_frame           retained render timings
      slow_frame             render frame over the slow-frame threshold
      render_patches         terminal patch count and cursor placement
      mouse_batch            parsed SGR mouse bytes per stdin batch
      mouse_dispatch         chat hit-testing and scroll offset transitions
      pi_event               Pi lifecycle events observed by SumoCode

  Event payloads are truncated/sanitized so logs stay readable and diagnostics
  never interrupt the interactive session.

ENVIRONMENT
  SUMO_TUI
      Set to 0 by this launcher. The RPC host owns SumoCode's interactive
      foreground, and direct Pi launches are reserved for non-interactive Pi
      behavior or diagnostics.

  SUMO_RPC
      Set automatically by the launcher for the default RPC host path.

  SUMO_TUI_DIAG_FILE
      Path to the diagnostics JSONL file used by --debug. Defaults to
      /tmp/sumocode-manual.jsonl in debug mode.

  SUMO_TUI_DEBUG
      Enables extra stderr debug messages in SumoTUI internals. Automatically
      set to 1 by --debug unless already set.

EXIT STATUS
  ${LAUNCHER_EXIT_CODES.success}     Help/version/doctor succeeded, or Pi exited successfully.
  ${LAUNCHER_EXIT_CODES.usage}    Command-line usage error, such as an unknown option or too many paths.
  ${LAUNCHER_EXIT_CODES.doctorFailure}    Doctor found an installation problem.
  other Propagates the underlying Pi process exit status.

NOTES
  SumoCode launches Pi with the SumoCode extension loaded. From a source
  checkout the project-local Pi binary (./node_modules/.bin/pi) is preferred;
  the native build uses the Pi child bundled beside its executable.

  Interactive TTY launches use the SumoCode RPC host and do not require the
  old Sumo retained-TUI patch. Non-interactive Pi modes such as --print or
  --mode, launches where stdout is not a TTY, and --no-sumo-tui bypass the RPC
  host and execute Pi directly with the SumoCode extension loaded.

  Use -- before a prompt that starts with '-' so SumoCode and Pi both treat it
  as a message rather than an option.
`;
}

/** The canonical usage-error document both launchers print to stderr. */
export function renderUsageError(message: string, binName: string = LAUNCHER_BIN_NAME): string {
	return `[sumocode] ${message}\n\nRun '${binName} --help' for usage.\n`;
}
