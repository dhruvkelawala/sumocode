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
# Set so the SumoCode `/sumo:reload` slash command knows it's running under
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
      Open SumoCode and immediately start an agent turn on <prompt>.
      Skips the splash screen, forwards <prompt> to Pi as the kickoff user
      message, and stays interactive afterwards. Designed for the orchestrator
      bg_task hand-off flow: the spawned cmux pane goes straight into the
      agent loop with no manual typing.

      Use --prompt-file <path> instead of an inline prompt when the prompt is
      long or contains shell metacharacters — the wrapper reads the file and
      forwards its contents as the kickoff message. This keeps the cmux
      respawn-pane command short so it doesn't flash a wall of text in the
      pane before Pi takes over the screen.

      Sets SUMOCODE_TASK_MODE=1 in the launched process so the extension
      knows to skip splash and other onboarding UI.

OPTIONS
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
      app_ready              first owned-shell render with the real session UI
      stable_chrome_ready    same reveal point, split out for startup budgeting
      input_ready            editor/input mounted and interactive
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
SUMOCODE_ARGS=()
while [[ $# -gt 0 ]]; do
	case "$1" in
		doctor|diag|task)
			if [[ "${COMMAND}" != "run" ]]; then usage_error "Only one command may be specified."; fi
			COMMAND="$1"
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

if [[ "${COMMAND}" == "doctor" && "${#SUMOCODE_ARGS[@]}" -gt 0 ]]; then
	usage_error "doctor does not accept a path argument."
fi
if [[ "${COMMAND}" == "diag" && "${#SUMOCODE_ARGS[@]}" -gt 1 ]]; then
	usage_error "diag accepts at most one diagnostics file path."
fi
if [[ -n "${PROMPT_FILE}" && "${COMMAND}" != "task" ]]; then
	usage_error "--prompt-file is only valid with the 'task' subcommand."
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
		# Append to SUMOCODE_ARGS so the prompt is the LAST argument when
		# pi sees it. Pi's CLI is `pi [options] [@files...] [messages...]`,
		# so flags forwarded by the caller (e.g. --model, --thinking) must
		# appear before the positional message for the parser to bind them
		# correctly.
		prompt_text="$(<"${PROMPT_FILE}")"
		if [[ "${#SUMOCODE_ARGS[@]}" -eq 0 ]]; then
			SUMOCODE_ARGS=("${prompt_text}")
		else
			SUMOCODE_ARGS=("${SUMOCODE_ARGS[@]}" "${prompt_text}")
		fi
	fi
	if [[ "${#SUMOCODE_ARGS[@]}" -eq 0 ]]; then
		usage_error "task requires a prompt argument or --prompt-file <path>. Example: sumocode task \"review the diff\"."
	fi
	IS_TASK_LAUNCH=1
	export SUMOCODE_TASK_MODE=1
fi

if [[ "${DEBUG_MODE}" == "1" ]]; then
	SUMO_TUI_DIAG_FILE="${DIAG_FILE:-/tmp/sumocode-manual.jsonl}"
	if [[ "${CLEAR_DIAG}" == "1" && "${DRY_RUN}" != "1" ]]; then rm -f "${SUMO_TUI_DIAG_FILE}"; fi
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
	for arg in "${SUMOCODE_ARGS[@]}"; do
		case "${arg}" in
			--print|-p|--mode|--mode=*) return 0 ;;
		esac
	done
	return 1
}

# Extracts the first plain (non-flag) positional from SUMOCODE_ARGS, matching
# Pi's own CLI contract: `parsed.messages[0]` (the first bare positional in
# argv order -- see @earendil-works/pi-coding-agent's cli/args.js and
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
# KNOWN LIMITATION (pre-existing, not introduced by this function): this
# wrapper's own arg loop above forwards every unrecognized `-*` flag to
# SUMOCODE_ARGS opaquely -- it does not know which of those flags consume a
# following value (e.g. `--model foo/bar`), unlike Pi's own cli/args.js, which
# has an explicit per-flag table for this. So `sumocode --model foo/bar "review
# the diff"` on the RPC path extracts `foo/bar` (the flag's value) as the
# "first plain positional" instead of the real prompt. This exact ordering
# already behaves surprisingly today on the direct-Pi path too, just
# differently (Pi's own parser resolves it correctly there because Pi *does*
# know --model takes a value) -- it is a structural fact about this wrapper's
# opaque-forwarding model for unknown flags, not something this seam can fix
# without duplicating Pi's entire flag table here. Placing the prompt as the
# ONLY positional (`sumocode "prompt"`, `sumocode task "prompt"`) is unaffected
# and is the documented, common case this fix targets.
extract_first_positional() {
	EXTRACTED_INITIAL_PROMPT=""
	local -a kept=()
	local found=0
	local arg
	for arg in "${SUMOCODE_ARGS[@]:-}"; do
		if [[ "${found}" -eq 0 && -n "${arg}" && "${arg}" != -* ]]; then
			EXTRACTED_INITIAL_PROMPT="${arg}"
			found=1
			continue
		fi
		kept+=("${arg}")
	done
	SUMOCODE_ARGS=("${kept[@]:-}")
	if [[ "${#SUMOCODE_ARGS[@]}" -eq 1 && -z "${SUMOCODE_ARGS[0]}" ]]; then
		SUMOCODE_ARGS=()
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
	# forwarded to the RPC host/child, including the SUMOCODE_INITIAL_PROMPT
	# side channel, instead of the pre-extraction argv.
	DRY_RUN_INITIAL_PROMPT=""
	if [[ "${USE_RPC_HOST}" -eq 1 ]]; then
		extract_first_positional
		DRY_RUN_INITIAL_PROMPT="${EXTRACTED_INITIAL_PROMPT}"
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
ARGS=${SUMOCODE_ARGS[*]:-}
SUMOCODE_INITIAL_PROMPT=${DRY_RUN_INITIAL_PROMPT}
$(if [[ "${USE_RPC_HOST}" -eq 1 ]]; then printf 'run (inside respawn loop, for /sumo:reload): node %s' "${ROOT_DIR}/sumo-rpc-host.js"; else printf 'run (inside respawn loop, for /sumo:reload): %s -e %s/src/extension.ts' "${PI_BIN}" "${ROOT_DIR}"; fi) ${SUMOCODE_ARGS[*]:-}
EOF
	exit 0
fi

# `/sumo:reload` exits the inner pi with this code so we re-launch in place.
# Other exit codes propagate normally.
SUMOCODE_RELOAD_EXIT_CODE=100

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
	# `/sumo:reload` respawn we deliberately do not want to re-submit the
	# original kickoff prompt into the resumed session (same reasoning as the
	# existing IS_TASK_LAUNCH handling inside the loop), so SUMOCODE_ARGS no
	# longer carries a prompt positional by the time the loop's first
	# iteration runs, and SUMOCODE_INITIAL_PROMPT is only ever exported on
	# that first iteration (see the loop body below).
	extract_first_positional
fi

RPC_INITIAL_PROMPT="${EXTRACTED_INITIAL_PROMPT:-}"

while :; do
	code=0
	if [[ "${USE_RPC_HOST}" -eq 1 ]]; then
		# The RPC host previously ran via `exec`, which replaced this shell
		# entirely -- so the respawn loop below was unreachable on the default
		# (RPC) launch path, and `/sumo:reload`'s exit(100) inside the RPC
		# child (surfaced to the host via client.onExit, then re-thrown as the
		# host's own process.exit(100) -- see host.ts's createRpcExitHandler /
		# runRpcHost) had nowhere to be caught. Running the host as a plain
		# foreground command (not exec) inside this same loop lets that exit
		# code fall through to the identical respawn handling the direct-Pi
		# path already has below.
		if [[ "${#SUMOCODE_ARGS[@]}" -eq 0 ]]; then
			env SUMOCODE_ROOT_DIR="${ROOT_DIR}" SUMOCODE_PROJECT_CWD="${PWD}" SUMOCODE_INITIAL_PROMPT="${RPC_INITIAL_PROMPT}" PI_BIN="${PI_BIN}" node "${ROOT_DIR}/sumo-rpc-host.js" || code=$?
		else
			env SUMOCODE_ROOT_DIR="${ROOT_DIR}" SUMOCODE_PROJECT_CWD="${PWD}" SUMOCODE_INITIAL_PROMPT="${RPC_INITIAL_PROMPT}" PI_BIN="${PI_BIN}" node "${ROOT_DIR}/sumo-rpc-host.js" "${SUMOCODE_ARGS[@]}" || code=$?
		fi
	elif [[ "${#SUMOCODE_ARGS[@]}" -eq 0 ]]; then
		"${PI_BIN}" -e "${ROOT_DIR}/src/extension.ts" || code=$?
	else
		"${PI_BIN}" -e "${ROOT_DIR}/src/extension.ts" "${SUMOCODE_ARGS[@]}" || code=$?
	fi
	if [[ "${code}" -ne "${SUMOCODE_RELOAD_EXIT_CODE}" ]]; then
		exit "${code}"
	fi
	# Only the first iteration's kickoff prompt (if any) is ever submitted;
	# a reload respawn resumes the existing session via --continue below and
	# must not re-submit it as a new message.
	RPC_INITIAL_PROMPT=""
	# After the kickoff turn has fired, do NOT re-pass the task prompt on
	# `/sumo:reload`. The reload loop adds `--continue` to resume the existing
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
