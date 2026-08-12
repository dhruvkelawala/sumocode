#!/usr/bin/env bash
# Mock pi binary used by `sumo-reload.test.ts` to verify that
# `bin/sumocode.sh` re-execs pi when the inner process exits with code 100
# (the `/reload` signal).
#
# State file tracks invocation count + the argv each time it was called.
# First call: print "RUN-1", exit 100 (simulate /reload).
# Second call: print "RUN-2 args:<argv>", exit 0 (simulate clean exit).
set -euo pipefail

state_file="${SUMOCODE_RELOAD_TEST_STATE:-/tmp/sumocode-reload-mock.state}"
count=0
if [[ -f "${state_file}" ]]; then
	count="$(cat "${state_file}")"
fi
count="$((count + 1))"
printf '%s' "${count}" > "${state_file}"

if [[ "${count}" -eq 1 ]]; then
	printf 'RUN-1 args:%s\n' "$*"
	exit 100
fi

printf 'RUN-2 args:%s\n' "$*"
second_exit_code="${SUMOCODE_RELOAD_TEST_SECOND_EXIT_CODE:-0}"
if [[ "${second_exit_code}" -eq 0 && -n "${SUMOCODE_RELOAD_READY_FILE:-}" ]]; then
	printf 'ready' > "${SUMOCODE_RELOAD_READY_FILE}"
fi
exit "${second_exit_code}"
