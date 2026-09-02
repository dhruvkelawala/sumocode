#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "${SOURCE}" ]]; do
	SOURCE_DIR="$(cd "$(dirname "${SOURCE}")" && pwd)"
	TARGET="$(readlink "${SOURCE}")"
	if [[ "${TARGET}" == /* ]]; then
		SOURCE="${TARGET}"
	else
		SOURCE="${SOURCE_DIR}/${TARGET}"
	fi
done
SCRIPT_DIR="$(cd "$(dirname "${SOURCE}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# The RPC host owns the interactive foreground. Direct Pi launches keep the
# extension loaded for non-interactive modes and diagnostics, but never ask Pi
# to load the old retained runtime.
export SUMO_TUI=0
# Node 22+ can persist V8 compile cache for CommonJS/ESM modules. SumoCode and
# Pi execute TypeScript through jiti at runtime, so warm launches benefit from
# Node's built-in bytecode cache without adding a project build step.
if [[ -z "${NODE_COMPILE_CACHE:-}" ]]; then
	NODE_COMPILE_CACHE="${ROOT_DIR}/node_modules/.cache/node-compile-cache"
	mkdir -p "${NODE_COMPILE_CACHE}" 2>/dev/null || true
	export NODE_COMPILE_CACHE
fi
# Set so the SumoCode `/reload` slash command knows it's running under
# the loop-respawn launcher and can exit with the reload signal.
export SUMOCODE_LAUNCHER="${SOURCE}"

print_help() {
	cat <<EOF
SumoCode — Cathedral terminal AI coding agent

USAGE
  sumocode [options] [path]
  sumocode doctor [options]
  sumocode diag [file]
  sumocode task <prompt> [path]
  sumocode -w [name]

ARGUMENTS
  path
      Optional project directory to open. If omitted, SumoCode starts in the
      current working directory. The path is forwarded to Pi unchanged, so all
      normal Pi path handling still applies.

  Additional unknown flags are forwarded to Pi unchanged. This preserves Pi
  options such as --offline, --no-session, --no-extensions, --provider, and
  --model while SumoCode owns only the options documented below.

COMMANDS
  doctor
      Check local SumoCode/Pi installation health: Node version, Pi binary,
      RPC host availability, Pi module resolution, and diagnostics path
      writability.

  diag [file]
      Summarize a diagnostics JSONL file. Defaults to /tmp/sumocode-manual.jsonl.

  task <prompt> [path]
  task --prompt-file <abs-path> [path]
  task --task-dir <abs-path> [path]
      Open SumoCode and immediately start an agent turn on <prompt>.
      Skips the splash screen, forwards <prompt> to Pi as the kickoff user
      message, and stays interactive afterwards. Designed for the orchestrator
      bg_task hand-off flow: the spawned terminal pane goes straight into the
      agent loop with no manual typing.

      Use --prompt-file <path> instead of an inline prompt when the prompt is
      long or contains shell metacharacters — the wrapper reads the file and
      forwards its contents as the kickoff message. This keeps the terminal
      respawn-pane command short so it doesn't flash a wall of text in the
      pane before Pi takes over the screen.

      Sets SUMOCODE_TASK_MODE=1 in the launched process so the extension
      knows to skip splash and other onboarding UI.

  -w, --worktree [name]
      Create and open a new sumo/<name> worktree in the current terminal
      host, run the configured worktree setup, and start SumoCode there.
      If name is omitted, a unique wt-<timestamp> name is generated.

OPTIONS
  --
      End SumoCode option parsing. For run/task launches, one delimiter is
      preserved for Pi so following dash-leading tokens are treated as
      positionals/messages instead of SumoCode options.

  -d, --debug
      Enable manual-test diagnostics / flight-recorder mode.

      In debug mode, SumoCode writes structured JSONL diagnostics to:

        /tmp/sumocode-manual.jsonl

      unless SUMO_TUI_DIAG_FILE is already set. The file is cleared at startup
      so every debug run starts with a fresh trace.

      Debug mode also exports:
        SUMO_TUI_DEBUG=1
        SUMOCODE_DEBUG_BRANCH=<current git branch, when available>
        SUMOCODE_DEBUG_COMMIT=<current git commit summary, when available>

      Diagnostics are intentionally no-op in normal mode.

  --diag-file <path>
      Write debug diagnostics to <path>. Implies --debug.

  --no-clear-diag
      Do not delete the diagnostics file at debug startup. By default, debug
      mode starts with a fresh trace.

  --prompt-file <path>
      Used with 'sumocode task'. Reads the file at <path> and forwards its
      contents as the kickoff user message. The file must exist when the
      wrapper runs. Contents are read as a single argument (newlines and
      shell metacharacters survive intact).

  --task-dir <path>
      Internal orchestration contract for visible agents. Reads prompt.txt
      from the directory and writes task lifecycle files alongside it.

  --no-sumo-tui
      Bypass the foreground RPC host for this launch and execute Pi directly
      with the SumoCode extension loaded. Useful for diagnostics and
      non-runtime comparisons.

  --dry-run
      Print the resolved launch configuration and exit without starting Pi.

  -v, --version
      Print SumoCode package version and git commit, then exit.

  -h, --help
      Show this help message and exit.

EXAMPLES
  Start in the current directory:
      sumocode

  Start in an explicit project directory:
      sumocode .
      sumocode /path/to/project

  Open a named worktree and start SumoCode there:
      sumocode -w new-worktree

  Start with diagnostics enabled:
      sumocode -d
      sumocode --debug

  Start a specific project with diagnostics enabled:
      sumocode -d .
      sumocode --debug /path/to/project

  Use a custom diagnostics file:
      sumocode -d --diag-file /tmp/my-run.jsonl
      SUMO_TUI_DIAG_FILE=/tmp/my-run.jsonl sumocode -d

  Keep appending to an existing diagnostics file:
      sumocode -d --no-clear-diag

  Bypass the foreground RPC host for diagnostics:
      sumocode --no-sumo-tui .

  Check installation health:
      sumocode doctor

  Summarize a debug run:
      sumocode diag
      sumocode diag /tmp/my-run.jsonl
      node scripts/diag-summary.mjs /tmp/sumocode-manual.jsonl

DIAGNOSTICS EVENTS
  Debug mode may record events such as:
      process_preload_start  Node preload + argv baseline for startup traces
      process_module_load_*  slow module imports + aggregate module-load summary
      runtime_start          process, cwd, branch, commit, terminal size
      boot_screen_frame      first retained splash/boot frame written to terminal
      editor_ready           first retained frame painted; input can be edited
      input_ready            deprecated one-release alias for editor_ready
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
  0     Help/version/doctor succeeded, or Pi exited successfully.
  64    Command-line usage error, such as an unknown option or too many paths.
  70    Doctor found an installation problem.
  other Propagates the underlying Pi process exit status.

NOTES
  SumoCode wraps the project-local Pi binary when available:
      ./node_modules/.bin/pi

  Interactive TTY launches use the SumoCode RPC host and do not require the
  old Sumo retained-TUI patch. Non-interactive Pi modes such as --print or
  --mode, launches where stdout is not a TTY, and --no-sumo-tui bypass the RPC
  host and execute Pi directly with the SumoCode extension loaded.

  Use -- before a prompt that starts with '-' so SumoCode and Pi both treat it
  as a message rather than an option.
EOF
}

package_version() {
	node -e 'const pkg = require(process.argv[1]); console.log(pkg.version || "0.0.0");' "${ROOT_DIR}/package.json"
}

print_version() {
	printf "sumocode %s\n" "$(package_version)"
	if command -v git >/dev/null 2>&1 && git -C "${ROOT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		git -C "${ROOT_DIR}" log --oneline -1 2>/dev/null || true
	fi
}

usage_error() {
	cat >&2 <<EOF
[sumocode] $1

Run 'sumocode --help' for usage.
EOF
	exit 64
}

DEBUG_MODE=0
CLEAR_DIAG=1
DRY_RUN=0
COMMAND="run"
IS_TASK_LAUNCH=0
FORCE_DIRECT_PI=0
DIAG_FILE="${SUMO_TUI_DIAG_FILE:-}"
PROMPT_FILE=""
TASK_DIR=""
SUMOCODE_ARGS=()
while [[ $# -gt 0 ]]; do
	case "$1" in
		doctor|diag|task)
			if [[ "${COMMAND}" != "run" ]]; then usage_error "Only one command may be specified."; fi
			COMMAND="$1"
			shift
			;;
		-w|--worktree)
			if [[ "${COMMAND}" != "run" ]]; then usage_error "Only one command may be specified."; fi
			COMMAND="worktree"
			shift
			;;
		-d|--debug)
			DEBUG_MODE=1
			shift
			;;
		--diag-file)
			[[ $# -ge 2 ]] || usage_error "--diag-file requires a path."
			DEBUG_MODE=1
			DIAG_FILE="$2"
			shift 2
			;;
		--diag-file=*)
			DEBUG_MODE=1
			DIAG_FILE="${1#--diag-file=}"
			[[ -n "${DIAG_FILE}" ]] || usage_error "--diag-file requires a path."
			shift
			;;
		--no-clear-diag)
			CLEAR_DIAG=0
			shift
			;;
		--prompt-file)
			[[ $# -ge 2 ]] || usage_error "--prompt-file requires a path."
			PROMPT_FILE="$2"
			shift 2
			;;
		--prompt-file=*)
			PROMPT_FILE="${1#--prompt-file=}"
			[[ -n "${PROMPT_FILE}" ]] || usage_error "--prompt-file requires a path."
			shift
			;;
		--task-dir)
			[[ $# -ge 2 ]] || usage_error "--task-dir requires a path."
			TASK_DIR="$2"
			shift 2
			;;
		--task-dir=*)
			TASK_DIR="${1#--task-dir=}"
			[[ -n "${TASK_DIR}" ]] || usage_error "--task-dir requires a path."
			shift
			;;
		--no-sumo-tui)
			FORCE_DIRECT_PI=1
			shift
			;;
		--dry-run)
			DRY_RUN=1
			shift
			;;
		-v|--version)
			print_version
			exit 0
			;;
		-h|--help)
			print_help
			exit 0
			;;
		--)
			shift
			# Run/task launches need the delimiter later so mode selection and prompt
			# extraction treat --print/--mode tokens as messages. If the caller used
			# the historical double-`--` quirk, the remaining argv already starts with
			# the delimiter the extractor expects.
			# Tradeoff: coalescing preserves that quirk but collapses two literal delimiters.
			if [[ "${COMMAND}" == "run" || "${COMMAND}" == "task" ]]; then
				if [[ "${1-}" != "--" ]]; then
					SUMOCODE_ARGS+=("--")
				fi
			fi
			SUMOCODE_ARGS+=("$@")
			break
			;;
		-*)
			# Unknown flags belong to Pi. Preserve pass-through so existing visual
			# harness/runtime invocations keep working (`--offline`, `--no-session`,
			# `--no-extensions`, provider/model flags, etc.).
			SUMOCODE_ARGS+=("$1")
			shift
			;;
		*)
			SUMOCODE_ARGS+=("$1")
			shift
			;;
	esac
done

# Pure membership test so each Pi parser consumption class reads as a table.
_sumocode_arg_in() {
	local candidate="$1"
	shift
	local item
	for item in "$@"; do
		[[ "${candidate}" == "${item}" ]] && return 0
	done
	return 1
}

# Class 2: unconditional value flags in Pi's pinned parseArgs(). Kept global so
# mode selection and prompt extraction cannot disagree about a value-consuming
# bare `--` token.
SUMOCODE_PI_UNCONDITIONAL_VALUE_FLAGS=(
	--mode --provider --model --api-key --system-prompt
	--append-system-prompt --name -n --session --session-id --fork
	--session-dir --models --tools -t --exclude-tools -xt --thinking
	--export --extension -e --skill --prompt-template --theme
)
# Class 3: known boolean flags -- recognized BEFORE the generic unknown branch
# so a boolean like --offline never consumes the real prompt.
SUMOCODE_PI_BOOLEAN_FLAGS=(
	--help -h --version -v --continue -c --resume -r --no-session
	--no-tools -nt --no-builtin-tools -nbt --no-extensions -ne
	--no-skills -ns --no-prompt-templates -np --no-themes
	--no-context-files -nc --verbose --approve -a --no-approve -na
	--offline
)

_sumocode_is_pi_unconditional_value_flag() {
	_sumocode_arg_in "$1" "${SUMOCODE_PI_UNCONDITIONAL_VALUE_FLAGS[@]}"
}

_sumocode_is_pi_boolean_flag() {
	_sumocode_arg_in "$1" "${SUMOCODE_PI_BOOLEAN_FLAGS[@]}"
}

_sumocode_first_pi_delimiter_index() {
	local i=0
	local n="${#SUMOCODE_ARGS[@]}"
	local arg
	while [[ "${i}" -lt "${n}" ]]; do
		arg="${SUMOCODE_ARGS[i]}"
		if [[ "${arg}" == "--" ]]; then
			printf '%s\n' "${i}"
			return 0
		fi
		if _sumocode_is_pi_unconditional_value_flag "${arg}" && [[ $((i + 1)) -lt "${n}" ]]; then
			i=$((i + 2))
			continue
		fi
		i=$((i + 1))
	done
	return 1
}

_sumocode_insert_task_prompt_text() {
	local prompt_text="$1"
	local delimiter_index
	local -a before=()
	local -a after=()
	if delimiter_index="$(_sumocode_first_pi_delimiter_index)"; then
		before=("${SUMOCODE_ARGS[@]:0:$((delimiter_index + 1))}")
		after=("${SUMOCODE_ARGS[@]:$((delimiter_index + 1))}")
		if [[ "${#after[@]}" -eq 0 ]]; then
			SUMOCODE_ARGS=("${before[@]}" "${prompt_text}")
		else
			SUMOCODE_ARGS=("${before[@]}" "${prompt_text}" "${after[@]}")
		fi
	elif [[ "${#SUMOCODE_ARGS[@]}" -eq 0 ]]; then
		SUMOCODE_ARGS=("${prompt_text}")
	else
		SUMOCODE_ARGS=("${SUMOCODE_ARGS[@]}" "${prompt_text}")
	fi
}

_sumocode_first_positional_index() {
	local i=0
	local n="${#SUMOCODE_ARGS[@]}"
	local arg next
	while [[ "${i}" -lt "${n}" ]]; do
		arg="${SUMOCODE_ARGS[i]}"

		if [[ "${arg}" == "--" ]]; then
			i=$((i + 1))
			while [[ "${i}" -lt "${n}" ]]; do
				arg="${SUMOCODE_ARGS[i]}"
				if [[ "${arg}" != @* ]]; then
					printf '%s\n' "${i}"
					return 0
				fi
				i=$((i + 1))
			done
			return 1
		fi

		if [[ "${arg}" == --*=* ]]; then
			i=$((i + 1))
			continue
		fi

		if _sumocode_is_pi_unconditional_value_flag "${arg}"; then
			if [[ $((i + 1)) -lt "${n}" ]]; then
				i=$((i + 2))
			else
				i=$((i + 1))
			fi
			continue
		fi

		if _sumocode_is_pi_boolean_flag "${arg}"; then
			i=$((i + 1))
			continue
		fi

		if [[ "${arg}" == --print || "${arg}" == -p ]]; then
			if [[ $((i + 1)) -lt "${n}" ]]; then
				next="${SUMOCODE_ARGS[i+1]}"
				if [[ "${next}" != @* && ( "${next}" != -* || "${next}" == ---* ) ]]; then
					i=$((i + 2))
					continue
				fi
			fi
			i=$((i + 1))
			continue
		fi

		if [[ "${arg}" == --list-models ]]; then
			if [[ $((i + 1)) -lt "${n}" ]]; then
				next="${SUMOCODE_ARGS[i+1]}"
				if [[ "${next}" != -* && "${next}" != @* ]]; then
					i=$((i + 2))
					continue
				fi
			fi
			i=$((i + 1))
			continue
		fi

		if [[ "${arg}" == --tui-mode ]]; then
			if [[ $((i + 1)) -lt "${n}" ]]; then
				next="${SUMOCODE_ARGS[i+1]}"
				if [[ "${next}" != -* ]]; then
					i=$((i + 2))
					continue
				fi
			fi
			i=$((i + 1))
			continue
		fi

		if [[ "${arg}" == --use-theme ]]; then
			if [[ $((i + 1)) -lt "${n}" ]]; then
				next="${SUMOCODE_ARGS[i+1]}"
				if [[ "${next}" != -* ]]; then
					i=$((i + 2))
					continue
				fi
			fi
			i=$((i + 1))
			continue
		fi

		if [[ "${arg}" == @* ]]; then
			i=$((i + 1))
			continue
		fi

		if [[ "${arg}" == --* ]]; then
			if [[ $((i + 1)) -lt "${n}" ]]; then
				next="${SUMOCODE_ARGS[i+1]}"
				if [[ "${next}" != -* && "${next}" != @* ]]; then
					i=$((i + 2))
					continue
				fi
			fi
			i=$((i + 1))
			continue
		fi

		if [[ "${arg}" == -* ]]; then
			i=$((i + 1))
			continue
		fi

		printf '%s\n' "${i}"
		return 0
	done
	return 1
}

_sumocode_task_has_nonempty_prompt_arg() {
	local prompt_index
	if ! prompt_index="$(_sumocode_first_positional_index)"; then return 1; fi
	# Match the host's trimmed-semantics check: a prompt that is only
	# whitespace would open a task pane without starting an agent turn.
	[[ -n "${SUMOCODE_ARGS[prompt_index]//[[:space:]]/}" ]]
}

# Prints SUMOCODE_ARGS with prompt bytes and sensitive option values replaced
# by [redacted] (issue 391: --dry-run output is diagnostics and must never
# carry prompt content or secrets). Pass "1" to also redact the first plain
# positional (direct-Pi path, where the prompt positional still sits in the
# forwarded argv); pass "0" when extraction already removed it (RPC path) so
# a real forwarded message is not mistaken for the prompt. Mirrors
# _sumocode_first_positional_index's class table; -p/--print's consumed
# message and --api-key/--system-prompt/--append-system-prompt values are
# prompt/secret bytes too. Display only -- never mutates SUMOCODE_ARGS.
redact_sensitive_args() {
	local redact_positional="${1:-1}"
	local prompt_index=-1
	if [[ "${redact_positional}" == "1" ]]; then
		prompt_index="$(_sumocode_first_positional_index 2>/dev/null || echo -1)"
	fi
	local -a out=()
	local i=0
	local n="${#SUMOCODE_ARGS[@]}"
	local arg next
	while [[ "${i}" -lt "${n}" ]]; do
		arg="${SUMOCODE_ARGS[i]}"
		if [[ "${i}" -eq "${prompt_index}" ]]; then
			out+=("[redacted]")
			i=$((i + 1))
			continue
		fi
		case "${arg}" in
			--api-key|--system-prompt|--append-system-prompt)
				out+=("${arg}" "[redacted]")
				i=$((i + 2))
				continue
				;;
			--api-key=*|--system-prompt=*|--append-system-prompt=*|--print=*|-p=*)
				out+=("${arg%%=*}=[redacted]")
				i=$((i + 1))
				continue
				;;
			--print|-p)
				out+=("${arg}")
				if [[ $((i + 1)) -lt "${n}" ]]; then
					next="${SUMOCODE_ARGS[i+1]}"
					if [[ "${next}" != @* && ( "${next}" != -* || "${next}" == ---* ) ]]; then
						out+=("[redacted]")
						i=$((i + 2))
						continue
					fi
				fi
				i=$((i + 1))
				continue
				;;
		esac
		out+=("${arg}")
		i=$((i + 1))
	done
	if [[ "${#out[@]}" -eq 0 ]]; then
		printf ''
	else
		printf '%s' "${out[*]}"
	fi
}

if [[ "${COMMAND}" == "doctor" && "${#SUMOCODE_ARGS[@]}" -gt 0 ]]; then
	usage_error "doctor does not accept a path argument."
fi
if [[ "${COMMAND}" == "diag" && "${#SUMOCODE_ARGS[@]}" -gt 1 ]]; then
	usage_error "diag accepts at most one diagnostics file path."
fi
if [[ "${COMMAND}" == "worktree" ]]; then
	if [[ "${#SUMOCODE_ARGS[@]}" -gt 1 ]]; then
		usage_error "-w accepts at most one optional worktree name."
	fi
	if [[ "${#SUMOCODE_ARGS[@]}" -eq 1 && "${SUMOCODE_ARGS[0]}" == -* ]]; then
		usage_error "Unknown worktree option: ${SUMOCODE_ARGS[0]}"
	fi
fi
if [[ -n "${PROMPT_FILE}" && "${COMMAND}" != "task" ]]; then
	usage_error "--prompt-file is only valid with the 'task' subcommand."
fi
if [[ -n "${TASK_DIR}" && "${COMMAND}" != "task" ]]; then
	usage_error "--task-dir is only valid with the 'task' subcommand."
fi
if [[ -n "${TASK_DIR}" ]]; then
	[[ -d "${TASK_DIR}" ]] || usage_error "--task-dir path does not exist: ${TASK_DIR}"
	[[ -z "${PROMPT_FILE}" ]] || usage_error "--task-dir cannot be combined with --prompt-file."
	PROMPT_FILE="${TASK_DIR}/prompt.txt"
	export SUMOCODE_TASK_RESPONSE_FILE="${TASK_DIR}/response.md"
	export SUMOCODE_TASK_EXIT_FILE="${TASK_DIR}/exit.code"
	export SUMOCODE_TASK_STARTED_FILE="${TASK_DIR}/started.marker"
	export SUMOCODE_TASK_DIAG_FILE="${TASK_DIR}/diag.jsonl"
	export SUMOCODE_TASK_CONTROL_DIR="${TASK_DIR}/control"
fi
if [[ "${COMMAND}" == "task" ]]; then
	if [[ -n "${PROMPT_FILE}" ]]; then
		if [[ ! -f "${PROMPT_FILE}" ]]; then
			usage_error "--prompt-file path does not exist: ${PROMPT_FILE}"
		fi
		# Read the file contents as a single positional argument. `$(<file)`
		# strips a trailing newline, which is what we want — Pi treats the
		# positional as one message.
		#
		# Put the file prompt where Pi will parse it as the first task message:
		# after a real preserved `--` delimiter when one exists, otherwise after
		# forwarded flags so their values still bind correctly.
		prompt_text="$(<"${PROMPT_FILE}")"
		_sumocode_insert_task_prompt_text "${prompt_text}"
	fi
	if [[ "${#SUMOCODE_ARGS[@]}" -eq 0 ]] || ! _sumocode_task_has_nonempty_prompt_arg; then
		usage_error "task requires a non-empty prompt argument or --prompt-file <path>. Example: sumocode task \"review the diff\"."
	fi
	IS_TASK_LAUNCH=1
	export SUMOCODE_TASK_MODE=1
fi

if [[ "${DEBUG_MODE}" == "1" ]]; then
	SUMO_TUI_DIAG_FILE="${DIAG_FILE:-/tmp/sumocode-manual.jsonl}"
	if [[ "${CLEAR_DIAG}" == "1" && "${DRY_RUN}" != "1" ]]; then rm -f "${SUMO_TUI_DIAG_FILE}"; fi
	if [[ "${DRY_RUN}" != "1" ]]; then
		# Pre-create the trace owner-only (0600): it records low-level input
		# events, and the runtime's append mode only applies at file creation.
		# `>>` keeps existing content intact on the --no-clear-diag path; the
		# chmod tightens a pre-existing file at the predictable /tmp location.
		(umask 177 && : >>"${SUMO_TUI_DIAG_FILE}" && chmod 600 "${SUMO_TUI_DIAG_FILE}") 2>/dev/null || true
	fi
	export SUMO_TUI_DIAG_FILE
	export SUMO_TUI_DEBUG="${SUMO_TUI_DEBUG:-1}"
	STARTUP_PRELOAD="${ROOT_DIR}/scripts/startup-diagnostics-preload.cjs"
	if [[ -f "${STARTUP_PRELOAD}" ]]; then
		# Quote the path inside NODE_OPTIONS because the primary dev tree contains a
		# space. Node's option parser honours these quotes.
		export NODE_OPTIONS="${NODE_OPTIONS:-} --require \"${STARTUP_PRELOAD}\""
	fi
	if command -v git >/dev/null 2>&1 && git -C "${ROOT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		export SUMOCODE_DEBUG_BRANCH="$(git -C "${ROOT_DIR}" branch --show-current 2>/dev/null || true)"
		export SUMOCODE_DEBUG_COMMIT="$(git -C "${ROOT_DIR}" log --oneline -1 2>/dev/null || true)"
	fi
	if [[ "${DRY_RUN}" != "1" ]]; then
		cat >&2 <<EOF
[sumocode] Debug diagnostics enabled: ${SUMO_TUI_DIAG_FILE}
EOF
	fi
fi

# Honour a caller-provided PI_BIN env var first so harness/test fixtures can
# point the launcher at a stub binary without rewriting bin/sumocode.sh.
# Accept either an absolute/relative executable path OR a PATH-resolvable
# command name (e.g. `PI_BIN=pi-dev`).
if [[ -n "${PI_BIN:-}" ]]; then
	if [[ ! -x "${PI_BIN}" ]]; then
		resolved="$(command -v "${PI_BIN}" || true)"
		if [[ -n "${resolved}" ]]; then
			PI_BIN="${resolved}"
		fi
	fi
fi
if [[ -z "${PI_BIN:-}" || ! -x "${PI_BIN}" ]]; then
	PI_BIN="${ROOT_DIR}/node_modules/.bin/pi"
fi
if [[ ! -x "${PI_BIN}" ]]; then
	PI_BIN="$(command -v pi || true)"
fi

args_request_noninteractive_pi() {
	if [[ "${#SUMOCODE_ARGS[@]}" -eq 0 ]]; then return 1; fi
	local i=0
	local n="${#SUMOCODE_ARGS[@]}"
	local arg
	while [[ "${i}" -lt "${n}" ]]; do
		arg="${SUMOCODE_ARGS[i]}"
		case "${arg}" in
			--print|-p|--mode|--mode=*) return 0 ;;
		esac
		if [[ "${arg}" == "--" ]]; then break; fi
		if _sumocode_is_pi_unconditional_value_flag "${arg}" && [[ $((i + 1)) -lt "${n}" ]]; then
			i=$((i + 2))
			continue
		fi
		i=$((i + 1))
	done
	return 1
}

# Extracts the first actual message (parsed.messages[0]) from SUMOCODE_ARGS,
# mirroring Pi's own CLI contract: the first bare positional in argv order
# (see @earendil-works/pi-coding-agent's cli/args.js and
# cli/initial-message.js) becomes the kickoff/initial message in interactive
# mode. `--mode rpc` never reads this positional at all (rpc-mode.js only
# consumes stdin JSON commands), so on the RPC path this positional would
# silently vanish unless the launcher forwards it through a side channel.
#
# Sets EXTRACTED_INITIAL_PROMPT to the found value (empty if none) and
# rewrites SUMOCODE_ARGS in place with that single element removed, preserving
# order of everything else. Only the FIRST plain positional is extracted --
# this mirrors Pi's own single-`initialMessage` behavior and intentionally
# does not attempt to replicate `initialMessages` (multi-message replay) for
# any remaining positionals; those still forward to the RPC child's argv
# unchanged (and are still silently ignored there, same as before this fix,
# which is a pre-existing multi-positional limitation out of scope here).
#
# OPTION-CONSUMPTION CLASS TABLE -- mirrors
# node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js parseArgs()
# (pi-coding-agent 0.84.3) EXACTLY, so that this wrapper skips a flag's value
# together with the flag itself instead of mistaking the value for the first
# actual message. Every flag/value token stays in the forwarded argv; only
# the first real positional message is extracted. This is the same reason the
# wrapper's own arg loop above never needs to worry about ITS OWN
# value-taking flags (--diag-file, --prompt-file): those are consumed at the
# wrapper's parse stage before anything reaches SUMOCODE_ARGS. Only Pi's
# flags need a table here, since extension flags reach Pi through args.js's
# generic unknown-long-option branch, which is mirrored as class 6 below.
#
# PI-BUMP NOTE (pinned: pi-coding-agent 0.84.3, dist/cli/args.js): if
# @earendil-works/pi-coding-agent is upgraded, re-read parseArgs() in the NEW
# dist/cli/args.js and re-diff every consumption class below (`git diff` the
# file, or just re-read it) -- any newly added value-taking flag, changed
# lookahead rule, or changed `--`/unknown-short-option handling must be
# mirrored here, or it will silently corrupt the extracted kickoff prompt.
# Plan 101 (Pi compatibility matrix) owns the per-version rerun of this
# table.
#
# Class 1 -- end-of-options `--`: args.js checks it FIRST; every remaining
#   token becomes a message (or a fileArg when @-prefixed) and flag parsing
#   stops. `--` itself stays in the forwarded argv; the first post-`--`
#   non-@ token (possibly "") is parsed.messages[0] and is extracted.
#
# Class 2 -- unconditional space-form value flags: consume `args[++i]`
#   whenever a next token EXISTS (args.js checks `i + 1 < args.length` before
#   validity, so dash/@/invalid values are still consumed; --mode consumes
#   its next token even when the value is invalid):
#     --mode, --provider, --model, --api-key, --system-prompt,
#     --append-system-prompt, --name/-n, --session, --session-id, --fork,
#     --session-dir, --models, --tools/-t, --exclude-tools/-xt, --thinking,
#     --export, --extension/-e, --skill, --prompt-template, --theme
#
# Class 3 -- known boolean flags: never consume. These MUST be recognized
#   before the generic unknown branch (class 6) or a boolean such as
#   --offline would wrongly consume the real prompt as its value:
#     --help/-h, --version/-v, --continue/-c, --resume/-r, --no-session,
#     --no-tools/-nt, --no-builtin-tools/-nbt, --no-extensions/-ne,
#     --no-skills/-ns, --no-prompt-templates/-np, --no-themes,
#     --no-context-files/-nc, --verbose, --approve/-a, --no-approve/-na,
#     --offline
#
# Class 4 -- dedicated lookahead flags with distinct rules in args.js:
#   --print/-p    consumes the next token as a print message only when it is
#                 not an @file AND either does not start with `-` or starts
#                 with `---` (Pi's dash-leading-message exception).
#   --list-models consumes the next token as a search pattern only when it
#                 starts with neither `-` nor `@`; otherwise it stands
#                 boolean.
#   --tui-mode    consumes the next token only when it is exactly `regular`
#                 or `fullscreen`; a missing or dash-following value is NOT
#                 consumed (Pi errors); any other non-dash value, including
#                 @file, IS consumed as invalid.
#   --use-theme   consumes the next token unless it starts with `-`
#                 (@-prefixed theme names included); a missing or
#                 dash-following value is not consumed (Pi errors).
#
# Class 5 -- standalone `@file` tokens: args.js files them as fileArgs, never
#   messages; keep them and never extract them as the prompt.
#
# Class 6 -- unknown `--flag` (how extension flags reach Pi): consume ONE
#   next token exactly when args.js's generic branch would -- a next token
#   exists and does not start with `-` or `@`; otherwise the flag stands
#   alone. `--flag=value` is a single token in args.js's generic handler and
#   never consumes anything (known flags compared with `==` never match
#   equals form in args.js either; they fall into the same generic bucket).
#
# Class 7 -- unknown short option (any other single-dash token, including
#   bare `-`): args.js's final dash branch only records an "Unknown option"
#   diagnostic; the token never becomes a message and never consumes a
#   following value.
#
# Class 8 -- plain positional: the first remaining token that reaches this
#   class is parsed.messages[0]; args.js's final branch pushes ANY token
#   that does not start with `-`, INCLUDING the empty string (a bare `""`
#   positional is parsed.messages[0] === ""), so extraction carries no
#   non-empty guard. Extract it and remove it from the forwarded argv.
#
# Do not infer extension flag schemas beyond args.js's generic class-6 rule:
# Pi itself treats unknown flags opaquely, and so does this table.

extract_first_positional() {
	EXTRACTED_INITIAL_PROMPT=""
	local prompt_index
	if ! prompt_index="$(_sumocode_first_positional_index)"; then return 0; fi
	EXTRACTED_INITIAL_PROMPT="${SUMOCODE_ARGS[prompt_index]}"

	local -a kept=()
	local i=0
	local n="${#SUMOCODE_ARGS[@]}"
	while [[ "${i}" -lt "${n}" ]]; do
		if [[ "${i}" -ne "${prompt_index}" ]]; then
			kept+=("${SUMOCODE_ARGS[i]}")
		fi
		i=$((i + 1))
	done
	if [[ "${#kept[@]}" -eq 0 ]]; then
		SUMOCODE_ARGS=()
	else
		SUMOCODE_ARGS=("${kept[@]}")
	fi
}

pi_main_file() {
	local bin="$1"
	local resolved dir cli_target cli_path main_file fallback local_main

	# Fast path for the project-local launcher. This is the common `sumocode`
	# dev/install path and avoids parsing pnpm's shell shim on every startup.
	local_main="${ROOT_DIR}/node_modules/@earendil-works/pi-coding-agent/dist/main.js"
	if [[ "${bin}" == "${ROOT_DIR}/node_modules/.bin/pi" && -f "${local_main}" ]]; then
		realpath "${local_main}"
		return 0
	fi

	resolved="$(realpath "${bin}" 2>/dev/null || true)"
	[[ -n "${resolved}" ]] || return 1
	dir="$(dirname "${resolved}")"

	if [[ "${resolved}" == "$(realpath "${ROOT_DIR}/node_modules/.bin/pi" 2>/dev/null || true)" && -f "${local_main}" ]]; then
		realpath "${local_main}"
		return 0
	fi

	# Direct installs may expose dist/main.js next to the resolved binary.
	for fallback in "${dir}/main.js" "${dir}/../dist/main.js"; do
		if [[ -f "${fallback}" ]]; then
			realpath "${fallback}"
			return 0
		fi
	done

	# pnpm creates a shell shim at node_modules/.bin/pi that execs
	# ../@earendil-works/pi-coding-agent/dist/cli.js. Resolve that target so we
	# can inspect the adjacent dist/main.js for the Sumo constructor patch.
	cli_target="$(grep -Eo '([^"[:space:]]+/)?@earendil-works/pi-coding-agent/dist/cli\.js' "${resolved}" | head -n 1 || true)"
	[[ -n "${cli_target}" ]] || return 1
	cli_target="${cli_target#\$basedir/}"
	cli_path="$(cd "${dir}" && realpath "${cli_target}" 2>/dev/null || true)"
	[[ -n "${cli_path}" ]] || return 1
	main_file="${cli_path%/cli.js}/main.js"
	[[ -f "${main_file}" ]] || return 1
	realpath "${main_file}"
}

run_diag_summary() {
	local file="${1:-/tmp/sumocode-manual.jsonl}"
	exec node "${ROOT_DIR}/scripts/diag-summary.mjs" "${file}"
}

print_auth_expiry_result() {
	local provider="$1"
	local expires="$2"
	local now_ms="$3"
	if [[ -z "${provider}" || ! "${expires}" =~ ^[0-9]+$ ]]; then return 0; fi
	if [[ "${expires}" -ge "${now_ms}" ]]; then return 0; fi
	local days_ago
	days_ago=$(((now_ms - expires) / 86400000))
	printf "✗ %s oauth token expired %s days ago — run pi and /login to re-authenticate\n" "${provider}" "${days_ago}"
	return 1
}

check_auth_expiry_with_grep() {
	local auth_file="$1"
	local now_ms="$2"
	local expired=0
	local provider=""
	local line
	while IFS= read -r line; do
		if [[ "${line}" =~ ^[[:space:]]*\"([^\"]+)\"[[:space:]]*:[[:space:]]*\{ ]]; then
			provider="${BASH_REMATCH[1]}"
		fi
		if [[ -n "${provider}" && "${line}" =~ \"expires\"[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
			if ! print_auth_expiry_result "${provider}" "${BASH_REMATCH[1]}" "${now_ms}"; then expired=1; fi
		fi
	done < "${auth_file}"
	return "${expired}"
}

check_auth_expiry() {
	local auth_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
	local auth_file="${auth_dir}/auth.json"
	if [[ ! -r "${auth_file}" ]]; then
		printf -- "- auth: no auth.json (nothing to check)\n"
		return 0
	fi

	local now_ms
	now_ms=$(($(date +%s) * 1000))
	local expired=0
	if command -v jq >/dev/null 2>&1; then
		local entries provider expires
		if entries="$(jq -r 'to_entries[] | select(.value | type == "object") | select(.value.expires? | type == "number") | [.key, (.value.expires | tostring)] | @tsv' "${auth_file}" 2>/dev/null)"; then
			while IFS="$(printf '\t')" read -r provider expires; do
				if [[ -z "${provider}" ]]; then continue; fi
				if ! print_auth_expiry_result "${provider}" "${expires}" "${now_ms}"; then expired=1; fi
			done <<< "${entries}"
		else
			check_auth_expiry_with_grep "${auth_file}" "${now_ms}" || expired=1
		fi
	else
		check_auth_expiry_with_grep "${auth_file}" "${now_ms}" || expired=1
	fi

	if [[ "${expired}" -eq 0 ]]; then
		printf "✓ auth: no expired oauth tokens\n"
		return 0
	fi
	return 1
}

run_doctor() {
	local failures=0
	printf "SumoCode doctor\n\n"
	printf "Version: %s\n" "$(package_version)"
	printf "Root: %s\n" "${ROOT_DIR}"
	if command -v node >/dev/null 2>&1; then
		local node_version
		node_version="$(node -v)"
		printf "✓ Node: %s\n" "${node_version}"
	else
		printf "✗ Node: not found\n"
		failures=$((failures + 1))
	fi
	if [[ -n "${PI_BIN}" && -x "${PI_BIN}" ]]; then
		printf "✓ Pi binary: %s\n" "${PI_BIN}"
	else
		printf "✗ Pi binary: not found or not executable\n"
		failures=$((failures + 1))
	fi
	local main_file=""
	if [[ -n "${PI_BIN}" ]]; then main_file="$(pi_main_file "${PI_BIN}" 2>/dev/null || true)"; fi
	if [[ -n "${main_file}" ]]; then
		printf "✓ Pi main: %s\n" "${main_file}"
	else
		printf "✗ Pi main: could not resolve\n"
		failures=$((failures + 1))
	fi
	local rpc_host_path="${ROOT_DIR}/sumo-rpc-host.js"
	if [[ -f "${rpc_host_path}" ]]; then
		printf "✓ RPC host: %s\n" "${rpc_host_path}"
	else
		printf "✗ RPC host: missing at %s\n" "${rpc_host_path}"
		failures=$((failures + 1))
	fi
	local diag_path="${DIAG_FILE:-${SUMO_TUI_DIAG_FILE:-/tmp/sumocode-manual.jsonl}}"
	local diag_dir
	diag_dir="$(dirname "${diag_path}")"
	if [[ -d "${diag_dir}" && -w "${diag_dir}" ]]; then
		printf "✓ diagnostics path writable: %s\n" "${diag_path}"
	else
		printf "✗ diagnostics directory not writable: %s\n" "${diag_dir}"
		failures=$((failures + 1))
	fi
	if check_auth_expiry; then
		:
	else
		failures=$((failures + 1))
	fi
	if [[ -t 1 ]]; then
		printf "✓ stdout is TTY"
		if [[ -n "${COLUMNS:-}" && -n "${LINES:-}" ]]; then printf " (%sx%s)" "${COLUMNS}" "${LINES}"; fi
		printf "\n"
	else
		printf "! stdout is not a TTY\n"
	fi
	printf "\n"
	if [[ "${failures}" -eq 0 ]]; then
		printf "Doctor passed.\n"
		return 0
	fi
	printf "Doctor found %s problem(s).\n" "${failures}"
	return 70
}

if [[ "${COMMAND}" == "diag" ]]; then
	run_diag_summary "${SUMOCODE_ARGS[0]:-/tmp/sumocode-manual.jsonl}"
fi

if [[ "${COMMAND}" == "worktree" ]]; then
	if [[ "${DRY_RUN}" == "1" ]]; then
		printf "sumocode worktree dry run\nROOT_DIR=%s\nNAME=%s\nexec node %s/scripts/open-worktree.mjs %s\n" \
			"${ROOT_DIR}" "${SUMOCODE_ARGS[0]:-}" "${ROOT_DIR}" "${SUMOCODE_ARGS[0]:-}"
		exit 0
	fi
	export SUMOCODE_ROOT_DIR="${ROOT_DIR}"
	exec node "${ROOT_DIR}/scripts/open-worktree.mjs" "${SUMOCODE_ARGS[0]:-}"
fi

if [[ "${COMMAND}" == "doctor" ]]; then
	run_doctor
	exit $?
fi

if [[ -z "${PI_BIN}" ]]; then
	cat >&2 <<EOF
[sumocode] Could not find Pi binary. Run 'pnpm install' in ${ROOT_DIR} or install pi on PATH.
EOF
	exit 70
fi

USE_RPC_HOST=1
if [[ "${FORCE_DIRECT_PI}" -eq 1 ]]; then
	USE_RPC_HOST=0
elif [[ ! -t 1 ]]; then
	USE_RPC_HOST=0
elif args_request_noninteractive_pi; then
	USE_RPC_HOST=0
fi

if [[ "${USE_RPC_HOST}" -eq 1 ]]; then
	export SUMO_RPC=1
	export SUMO_TUI=0
else
	unset SUMO_RPC
	export SUMO_TUI=0
fi

if [[ "${DRY_RUN}" == "1" ]]; then
	# Mirror the real RPC-path argv rewrite (see extract_first_positional and
	# its call site below) so --dry-run output shows exactly what will be
	# forwarded to the RPC host/child, including the one-shot transport side
	# channel, instead of the pre-extraction argv. Prompt bytes NEVER appear:
	# the side channel shows presence only, and ARGS/exec go through
	# redact_sensitive_args (issue 391).
	DRY_RUN_INITIAL_PROMPT=""
	if [[ "${USE_RPC_HOST}" -eq 1 ]]; then
		extract_first_positional
		DRY_RUN_INITIAL_PROMPT="${EXTRACTED_INITIAL_PROMPT}"
	fi
	if [[ "${USE_RPC_HOST}" -eq 1 && -n "${DRY_RUN_INITIAL_PROMPT}" ]]; then
		KICKOFF_PROMPT_TRANSPORT="one-shot-file"
	else
		KICKOFF_PROMPT_TRANSPORT="(none)"
	fi
	if [[ "${USE_RPC_HOST}" -eq 1 ]]; then
		REDACTED_ARGS="$(redact_sensitive_args 0)"
	else
		REDACTED_ARGS="$(redact_sensitive_args 1)"
	fi
	cat <<EOF
sumocode dry run
PI_BIN=${PI_BIN}
ROOT_DIR=${ROOT_DIR}
SUMO_TUI=${SUMO_TUI:-}
SUMO_RPC=${SUMO_RPC:-}
SUMO_TUI_DIAG_FILE=${SUMO_TUI_DIAG_FILE:-}
SUMO_TUI_DEBUG=${SUMO_TUI_DEBUG:-}
COMMAND=${COMMAND}
ARGS=${REDACTED_ARGS}
KICKOFF_PROMPT_TRANSPORT=${KICKOFF_PROMPT_TRANSPORT}
exec $(if [[ "${USE_RPC_HOST}" -eq 1 ]]; then printf 'node %s' "${ROOT_DIR}/sumo-rpc-host.js"; else printf '%s -e %s/src/extension-entry.ts' "${PI_BIN}" "${ROOT_DIR}"; fi) ${REDACTED_ARGS}
EOF
	exit 0
fi

# `/reload` exits the inner pi with this code so we re-launch in place.
# Other exit codes propagate normally.
SUMOCODE_RELOAD_EXIT_CODE=100
IS_RELOAD_RESPAWN=0
ORIGINAL_TTY_STATE=""
if [[ -t 0 ]]; then
	ORIGINAL_TTY_STATE="$(stty -g <&0 2>/dev/null || true)"
fi

if [[ "${USE_RPC_HOST}" -eq 1 ]]; then
	# `pi --mode rpc` (spawned by the RPC host as its child) never reads argv
	# positionals as a kickoff message -- rpc-mode.js only consumes stdin JSON
	# commands (see extract_first_positional's comment). Pull the first plain
	# positional out of SUMOCODE_ARGS here and hand it to the host via
	# SUMOCODE_INITIAL_PROMPT instead, so runRpcHost can submit it through the
	# same onSubmit/submitRpcPrompt path a normal editor submit uses once the
	# child is up and hydrated. Must run BEFORE the argv is forwarded so the
	# child does not also see (and silently drop) the same positional.
	#
	# This extraction happens ONCE, outside the respawn loop below: on a
	# `/reload` respawn we deliberately do not want to re-submit the
	# original kickoff prompt into the resumed session (same reasoning as the
	# existing IS_TASK_LAUNCH handling inside the loop), so SUMOCODE_ARGS no
	# longer carries a prompt positional by the time the loop's first
	# iteration runs, and SUMOCODE_INITIAL_PROMPT is only ever exported on
	# that first iteration (see the loop body below).
	extract_first_positional
fi

RPC_INITIAL_PROMPT="${EXTRACTED_INITIAL_PROMPT:-}"

# Owner-only one-shot transport for the kickoff prompt (issue 391): the
# prompt bytes go into an 0600 mktemp file that sumo-rpc-host.js reads and
# unlinks BEFORE submitting, so no child's inherited environment ever
# carries prompt content. Empty when there is no kickoff prompt.
RPC_INITIAL_PROMPT_FILE=""
if [[ -n "${RPC_INITIAL_PROMPT}" ]]; then
	RPC_INITIAL_PROMPT_FILE="$(mktemp "${TMPDIR:-/tmp}/sumocode-kickoff.XXXXXX")"
	printf '%s' "${RPC_INITIAL_PROMPT}" >"${RPC_INITIAL_PROMPT_FILE}"
fi

# Headless direct-Pi launches (non-TTY stdin => Pi print mode) read piped
# stdin as the initial message, so the kickoff/task prompt travels through
# stdin instead of argv (issue 391). Interactive direct-Pi keeps the
# positional: Pi's interactive mode reads only argv, and its stdin is the
# live TTY. Caller-piped stdin is overridden only when an extracted prompt
# exists -- an explicit prompt argument is authoritative over piped content.
DIRECT_PI_STDIN_PROMPT=""
if [[ "${USE_RPC_HOST}" -eq 0 && ! -t 0 ]]; then
	direct_prompt_index="$(_sumocode_first_positional_index 2>/dev/null || true)"
	extract_first_positional
	DIRECT_PI_STDIN_PROMPT="${EXTRACTED_INITIAL_PROMPT:-}"
	# Fall back to the argv transport when extra message-bearing tokens
	# remain: a leftover positional (Pi print mode loops over every message
	# and buildInitialMessage would concatenate stdin with messages[0]), a
	# `-p/--print` flag with its own message value, or an explicit `--mode`
	# (rpc/json read stdin as a protocol/command channel, never as a message
	# — piping prompt text there corrupts the stream). Restoring the
	# extracted prompt keeps Pi's parsing semantics byte-identical to the
	# pre-stdin behavior.
	if [[ -n "${DIRECT_PI_STDIN_PROMPT}" ]]; then
		direct_fallback=0
		if _sumocode_first_positional_index >/dev/null 2>&1; then
			direct_fallback=1
		elif [[ "${#SUMOCODE_ARGS[@]}" -gt 0 ]]; then
			for direct_arg in "${SUMOCODE_ARGS[@]}"; do
				case "${direct_arg}" in
					-p|--print|--print=*|--mode|--mode=*) direct_fallback=1; break ;;
				esac
			done
		fi
		if [[ "${direct_fallback}" -eq 1 ]]; then
			reinserted=()
			n="${#SUMOCODE_ARGS[@]}"
			for ((j = 0; j < n; j++)); do
				if [[ "${j}" -eq "${direct_prompt_index}" ]]; then
					reinserted+=("${DIRECT_PI_STDIN_PROMPT}")
				fi
				reinserted+=("${SUMOCODE_ARGS[j]}")
			done
			if [[ "${direct_prompt_index}" -ge "${n}" ]]; then
				reinserted+=("${DIRECT_PI_STDIN_PROMPT}")
			fi
			SUMOCODE_ARGS=("${reinserted[@]}")
			DIRECT_PI_STDIN_PROMPT=""
		fi
	fi
fi

# The RPC host previously ran via `exec`, which replaced this shell's own pid
# outright -- the child WAS this script's pid, so a real terminal's Ctrl-C/
# SIGTERM (kernel/tty-driver-level, delivered to the whole foreground process
# group) and a PID-targeted kill (e.g. node-pty's `.kill()`, which calls
# `process.kill(pid)` on the pid node-pty itself spawned -- this script)
# landed on the exact same process either way. Switching the RPC-host branch
# to a plain foreground command (needed so the exit-100 respawn below can see
# it -- `exec` never returns) reintroduces bash as a separate live parent
# process: a PID-targeted kill now reaches only this shell, not its `node`
# child, unless this shell explicitly forwards the signal. Run the RPC host
# backgrounded + `wait`ed (only for this branch -- the direct-Pi branch below
# is unchanged, still a plain foreground command, since it already worked
# correctly via real terminals' process-group-wide delivery before this fix)
# so RPC_CHILD_PID is known to the trap below while it's running.
restore_original_tty_state() {
	if [[ -n "${ORIGINAL_TTY_STATE}" ]]; then
		stty "${ORIGINAL_TTY_STATE}" <&0 2>/dev/null || true
	fi
}

reset_terminal_modes() {
	printf '\033]112\033\\\033]111\033\\\033[<u\033[>4;0m\033[?2004l\033[?1003l\033[?1002l\033[?1006l\033[?1000l\033[?1049l\033[?25h\033[0m'
}

RPC_CHILD_PID=""
forward_signal_to_rpc_child() {
	local sig="$1"
	if [[ -n "${RPC_CHILD_PID}" ]] && kill -0 "${RPC_CHILD_PID}" 2>/dev/null; then
		kill "-${sig}" "${RPC_CHILD_PID}" 2>/dev/null || true
	elif [[ "${USE_RPC_HOST}" -eq 1 ]]; then
		# No child means the signal landed in the launcher-owned reload handoff.
		# Exit here rather than swallowing it or leaking it into a later reload.
		restore_original_tty_state
		reset_terminal_modes
		if [[ "${sig}" == "INT" ]]; then exit 130; else exit 0; fi
	fi
}
trap 'forward_signal_to_rpc_child INT' INT
trap 'forward_signal_to_rpc_child TERM' TERM
# Success, failure, cancellation (INT/TERM exits), and reload all funnel
# through process exit: the transport file is normally already consumed
# (unlinked) by the host, and this trap is the backstop for crashes/signal
# landings before the host ever read it.
trap 'rm -f "${RPC_INITIAL_PROMPT_FILE:-}" 2>/dev/null || true' EXIT

# `wait` on a backgrounded job can return as soon as the trap handler above
# runs (bash reports the interrupted `wait` itself, not necessarily the
# child's actual termination), well before the forwarded signal has actually
# reached and been handled by the RPC host's own graceful-shutdown path
# (terminal cleanup escape sequence, altscreen exit, etc. -- see host.ts's
# SIGINT/SIGTERM handlers). Exiting this script the instant that first `wait`
# call returns would race the child's cleanup and can leave the terminal in a
# dirty state.
#
# Deliberately does NOT re-invoke `wait "${pid}"` in a loop to confirm actual
# exit: bash's `wait PID` only blocks correctly the FIRST time for a given
# pid -- once that pid has been reaped from bash's job table (which can
# happen on the very first call, independent of whether the process has
# actually exited yet, on some bash versions/platforms), every subsequent
# `wait` on the same pid returns immediately without blocking, which turns a
# naive "loop wait until kill -0 fails" into a tight CPU-spinning busy loop.
# Polling `kill -0` with a short sleep is slower to notice exit than a true
# blocking wait, but is portable and never spins.
#
# Sets WAIT_FOR_CHILD_EXIT_STATUS instead of returning via `echo` + command
# substitution: `$(...)` always forks a subshell, and the INT/TERM traps set
# on this script (needed to forward signals to RPC_CHILD_PID -- see above)
# are not reliably applied inside that forked subshell, which would leave
# nothing able to react to a signal while this function's own `wait`/poll
# loop is running. Calling this as a plain function (no substitution) keeps
# everything in this script's own process, where the traps are already live.
WAIT_FOR_CHILD_EXIT_STATUS=0
wait_for_child_exit() {
	local pid="$1"
	local status=0
	# `|| status=$?` guards this under `set -e`: a nonzero exit status (the
	# normal case for a signal-terminated or nonzero-exiting child) would
	# otherwise abort this function -- and the whole script -- via -e
	# immediately, before the kill -0 polling loop below ever runs.
	wait "${pid}" || status=$?
	while kill -0 "${pid}" 2>/dev/null; do
		sleep 0.05
	done
	WAIT_FOR_CHILD_EXIT_STATUS="${status}"
}

restore_reload_terminal() {
	local ready_file="$1"
	local state=""
	if [[ "${IS_RELOAD_RESPAWN}" -ne 1 || ! -t 1 ]]; then
		return 0
	fi
	# Node's raw-mode baseline belongs to the replacement process, which starts
	# while the predecessor is already raw. Restore the exact pre-launch termios
	# state rather than `stty sane`, which would erase user customizations.
	restore_original_tty_state
	if [[ -n "${ready_file}" && -f "${ready_file}" ]]; then
		state="$(cat "${ready_file}" 2>/dev/null || true)"
	fi
	if [[ -z "${ready_file}" || "${state}" == "ready" ]]; then
		return 0
	fi
	# Last-resort mode cleanup when the replacement entry never took ownership.
	reset_terminal_modes
}

# WORKAROUND for a verified-unreliable bash 3.2 (macOS's system bash) `wait`
# builtin: on a SIGTERM-graceful shutdown, host.ts resolves and intends to
# exit with code 0 (see host.ts's handleSigterm -> exitProcess(0)), but
# wait_for_child_exit above was observed reporting 143 (128+SIGTERM) instead
# -- i.e. bash's own recovery of the backgrounded job's status does not
# reliably reflect the child's own chosen exit code across this signal path
# in this environment.
#
# The host writes its REAL final exit code to a file at
# SUMOCODE_EXIT_CODE_FILE (see host.ts's writeExitCodeFile / exitProcess --
# every host exit path, including this one, funnels through it) just before
# calling process.exit/returning. read_child_exit_code_file reads that file
# AFTER wait_for_child_exit has already confirmed the process is gone, so
# there is no race with the write. Only trusted when present and it parses as
# a plain non-negative integer; any other case (missing, empty, garbage) falls
# back to bash's own WAIT_FOR_CHILD_EXIT_STATUS, so a write failure (e.g.
# read-only tmp, disk full) degrades to the pre-existing (imperfect) behavior
# instead of the launcher itself failing.
read_child_exit_code_file() {
	local path="$1"
	local fallback="$2"
	local contents
	if [[ -n "${path}" && -f "${path}" ]]; then
		contents="$(cat "${path}" 2>/dev/null || true)"
		rm -f "${path}" 2>/dev/null || true
		if [[ "${contents}" =~ ^[0-9]+$ ]]; then
			printf '%s' "${contents}"
			return 0
		fi
	fi
	printf '%s' "${fallback}"
}

while :; do
	code=0
	SUMOCODE_RELOAD_READY_FILE=""
	if [[ "${IS_RELOAD_RESPAWN}" -eq 1 ]]; then
		SUMOCODE_RELOAD_READY_FILE="$(mktemp "${TMPDIR:-/tmp}/sumocode-reload-ready.XXXXXX" 2>/dev/null || true)"
		# Keep mktemp's private inode reserved. Empty means startup is pending;
		# the terminal owner overwrites it with "ready" after taking responsibility.
	fi
	if [[ "${USE_RPC_HOST}" -eq 1 ]]; then
		# The RPC host previously ran via `exec`, which replaced this shell
		# entirely -- so the respawn loop below was unreachable on the default
		# (RPC) launch path, and `/reload`'s exit(100) inside the RPC
		# child (surfaced to the host via client.onExit, then re-thrown as the
		# host's own process.exit(100) -- see host.ts's createRpcExitHandler /
		# runRpcHost) had nowhere to be caught. Running the host as a plain
		# foreground command (not exec) inside this same loop lets that exit
		# code fall through to the identical respawn handling the direct-Pi
		# path already has below.
		# `<&0`: without job control (`set -m`, off by default in scripts), bash
		# redirects a backgrounded command's stdin from /dev/null unless given
		# an explicit redirection -- silently starving the RPC host of the PTY
		# input a real interactive session depends on (keystrokes, Ctrl+/,
		# etc.). The explicit `<&0` overrides that default and reconnects the
		# backgrounded child to this script's own inherited stdin (the real
		# terminal/PTY), restoring identical input behavior to the pre-`&`
		# plain-foreground invocation.
		# See read_child_exit_code_file's comment above for why this file exists.
		# A fresh mktemp path per iteration so a stale file from a prior loop
		# iteration (or a previous run entirely) can never be misread as this
		# iteration's exit code.
		SUMOCODE_EXIT_CODE_FILE="$(mktemp "${TMPDIR:-/tmp}/sumocode-exit-code.XXXXXX")"
		if [[ "${#SUMOCODE_ARGS[@]}" -eq 0 ]]; then
			env SUMOCODE_ROOT_DIR="${ROOT_DIR}" SUMOCODE_PROJECT_CWD="${PWD}" SUMOCODE_INITIAL_PROMPT_FILE="${RPC_INITIAL_PROMPT_FILE}" SUMOCODE_RELOAD="${IS_RELOAD_RESPAWN}" SUMOCODE_RELOAD_READY_FILE="${SUMOCODE_RELOAD_READY_FILE}" PI_BIN="${PI_BIN}" SUMOCODE_EXIT_CODE_FILE="${SUMOCODE_EXIT_CODE_FILE}" node "${ROOT_DIR}/sumo-rpc-host.js" <&0 &
		else
			env SUMOCODE_ROOT_DIR="${ROOT_DIR}" SUMOCODE_PROJECT_CWD="${PWD}" SUMOCODE_INITIAL_PROMPT_FILE="${RPC_INITIAL_PROMPT_FILE}" SUMOCODE_RELOAD="${IS_RELOAD_RESPAWN}" SUMOCODE_RELOAD_READY_FILE="${SUMOCODE_RELOAD_READY_FILE}" PI_BIN="${PI_BIN}" SUMOCODE_EXIT_CODE_FILE="${SUMOCODE_EXIT_CODE_FILE}" node "${ROOT_DIR}/sumo-rpc-host.js" "${SUMOCODE_ARGS[@]}" <&0 &
		fi
		RPC_CHILD_PID=$!
		wait_for_child_exit "${RPC_CHILD_PID}"
		code="$(read_child_exit_code_file "${SUMOCODE_EXIT_CODE_FILE}" "${WAIT_FOR_CHILD_EXIT_STATUS}")"
		RPC_CHILD_PID=""
	elif [[ -n "${DIRECT_PI_STDIN_PROMPT}" ]]; then
		# Headless kickoff: the prompt rides stdin (Pi print mode reads it as
		# the initial message); argv keeps only flags. The caller's own piped
		# stdin is streamed first (cat), so Pi's composition — stdin bytes then
		# the message — stays byte-identical to the pre-stdin behavior, and the
		# upstream producer keeps its reader instead of taking SIGPIPE.
		# Pipeline exit status is Pi's, so the reload/exit handling below is
		# unchanged. Must precede the empty-argv branch: a sole prompt
		# positional empties SUMOCODE_ARGS during extraction.
		if [[ "${#SUMOCODE_ARGS[@]}" -eq 0 ]]; then
			{ cat; printf '%s' "${DIRECT_PI_STDIN_PROMPT}"; } | env SUMOCODE_RELOAD_READY_FILE="${SUMOCODE_RELOAD_READY_FILE}" "${PI_BIN}" -e "${ROOT_DIR}/src/extension-entry.ts" || code=$?
		else
			{ cat; printf '%s' "${DIRECT_PI_STDIN_PROMPT}"; } | env SUMOCODE_RELOAD_READY_FILE="${SUMOCODE_RELOAD_READY_FILE}" "${PI_BIN}" -e "${ROOT_DIR}/src/extension-entry.ts" "${SUMOCODE_ARGS[@]}" || code=$?
		fi
	elif [[ "${#SUMOCODE_ARGS[@]}" -eq 0 ]]; then
		env SUMOCODE_RELOAD_READY_FILE="${SUMOCODE_RELOAD_READY_FILE}" "${PI_BIN}" -e "${ROOT_DIR}/src/extension-entry.ts" || code=$?
	else
		env SUMOCODE_RELOAD_READY_FILE="${SUMOCODE_RELOAD_READY_FILE}" "${PI_BIN}" -e "${ROOT_DIR}/src/extension-entry.ts" "${SUMOCODE_ARGS[@]}" || code=$?
	fi
	if [[ "${code}" -ne "${SUMOCODE_RELOAD_EXIT_CODE}" ]]; then
		restore_reload_terminal "${SUMOCODE_RELOAD_READY_FILE:-}"
		rm -f "${SUMOCODE_RELOAD_READY_FILE:-}" 2>/dev/null || true
		exit "${code}"
	fi
	rm -f "${SUMOCODE_RELOAD_READY_FILE:-}" 2>/dev/null || true
	# The replacement host adopts the retained terminal frame and hydrates before
	# its first paint, avoiding a cold-start splash during an in-place reload.
	IS_RELOAD_RESPAWN=1
	# Only the first iteration's kickoff prompt (if any) is ever submitted;
	# a reload respawn resumes the existing session via --continue below and
	# must not re-submit it as a new message.
	RPC_INITIAL_PROMPT=""
	# The host already consumed (unlinked) the transport file; clear the path
	# so the exit trap has nothing to clean and a reload can never re-export it.
	# Cleared ONLY here, on the reload-respawn path: code 100 means the host
	# served a live session, so it already consumed (unlinked) the transport
	# file. Every other exit reaches `exit "${code}"` below with the path
	# still set, keeping the EXIT trap as the cleanup backstop for hosts that
	# die before reading it.
	RPC_INITIAL_PROMPT_FILE=""
	# Same one-shot rule for the headless stdin transport: iteration one's
	# prompt must never ride a reload respawn's stdin.
	DIRECT_PI_STDIN_PROMPT=""
	# After the kickoff turn has fired, do NOT re-pass the task prompt on
	# `/reload`. The reload loop adds `--continue` to resume the existing
	# session, and re-injecting the original prompt would send it again as a
	# new user message in the resumed session.
	#
	# Also clear SUMOCODE_TASK_MODE so the auto-exit lifecycle does NOT
	# re-arm on the next agent_end. The original hand-off was the kickoff;
	# anything happening in this session after a reload is the user actively
	# working in the pane and should not be auto-closed.
	if [[ "${IS_TASK_LAUNCH}" -eq 1 ]]; then
		SUMOCODE_ARGS=()
		IS_TASK_LAUNCH=0
		unset SUMOCODE_TASK_MODE
	fi
	# Re-launch with --continue so the in-progress session resumes after the
	# code change.
	#
	# `--resume`/`-r` means "open the session picker" (one-shot UX). On reload
	# the user wants to keep the session they already picked, so strip those
	# flags before injecting `--continue`. Skip the inject when `--continue`,
	# `-c`, or `--no-session` is already in argv.
	filtered_args=()
	have_continue=0
	for arg in "${SUMOCODE_ARGS[@]:-}"; do
		case "${arg}" in
			--resume|-r) ;;
			--continue|-c|--no-session) have_continue=1; filtered_args+=("${arg}") ;;
			*) filtered_args+=("${arg}") ;;
		esac
	done
	SUMOCODE_ARGS=("${filtered_args[@]:-}")
	# Drop any synthetic empty element introduced by `:-` on an empty array.
	if [[ "${#SUMOCODE_ARGS[@]}" -eq 1 && -z "${SUMOCODE_ARGS[0]}" ]]; then
		SUMOCODE_ARGS=()
	fi
	if [[ "${have_continue}" -eq 0 ]]; then
		# Spread without `:-` because `"${arr[@]:-}"` synthesizes an empty
		# string element when the array is empty, which would forward `""` to
		# pi as a phantom positional arg. Bash treats `"${arr[@]}"` of a
		# declared empty array as a no-op even under `set -u`.
		if [[ "${#SUMOCODE_ARGS[@]}" -eq 0 ]]; then
			SUMOCODE_ARGS=("--continue")
		else
			SUMOCODE_ARGS=("--continue" "${SUMOCODE_ARGS[@]}")
		fi
	fi
done
