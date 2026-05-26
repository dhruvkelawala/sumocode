
========================================
FILE: src/spike/cmux-background/visible-spawn.ts:55
----------------------------------------
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Run visible task wrapper with pipefail-capable shell**

The wrapper is executed via `sh -lc` but the inner script uses `set -o pipefail`, which is a bash-only option and fails on common `/bin/sh` implementations like `dash` (Ubuntu/Debian). In that case the subshell aborts before running the user command, yet the surrounding `tee` pipeline still returns success and `exit.code` is written as `0`, so tasks can be reported as successful without ever executing. This will break visible background tasks on non-bash `sh` environments unless you switch to `bash -lc` (or remove the bashism with a POSIX-safe exit-capture approach).

Useful? React with 👍 / 👎.

========================================
FILE: src/spike/cmux-background/cmux-adapter.ts:189
----------------------------------------
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Restrict target surface lookup to the new split pane**

After `new-split`, this fallback loop returns the first surface ref that was not in the pre-split snapshot from **any** pane in the workspace. If another tab/surface is created concurrently in an existing pane, `openVisibleTaskInSplit()` can select that unrelated surface and run `respawn-pane` there, leaving the intended split unused and hijacking a different terminal. The lookup should stay scoped to the newly created pane (or use the split command’s returned surface ref) to avoid misrouting visible tasks.

Useful? React with 👍 / 👎.

========================================
FILE: src/background-tasks/task-manager.ts:166
----------------------------------------
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Catch rejected visible-spawn promises**

`spawnTask` fire-and-forgets `spawnVisibleTask` with `void`, so any thrown error from `openCommandInNewSplitWithRefs` (for example when `pi.exec` rejects) becomes an unhandled rejection and the task can stay stuck in `running` because `finalizeTask` is never reached. This makes `bg_task spawn` report success while no recoverable failure state is recorded.

Useful? React with 👍 / 👎.

========================================
FILE: src/background-tasks/task-manager.ts:411
----------------------------------------
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Prevent stopping visible tasks before cmux refs exist**

If `stopTask` is called while a visible task is still creating its split, `task.cmux` is still undefined so this branch skips termination and immediately marks the task stopped. The in-flight `spawnVisibleTask` can still finish `new-split`/`respawn-pane`, so the command starts after the user has already stopped it.

Useful? React with 👍 / 👎.

========================================
FILE: src/background-tasks/visible-spawn.ts:66
----------------------------------------
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Fail fast when visible task cwd cannot be entered**

The generated `run.sh` wrapper does `cd <cwd>` without checking its exit status, so a typo/missing directory causes the task command to run from whatever directory the pane starts in (often `$HOME`) instead of failing. For visible tasks this can execute writes in the wrong project while still producing a normal-looking task lifecycle. Make the `cd` step fatal (for example via `cd ... || exit 1` or equivalent strict mode before command execution).

Useful? React with 👍 / 👎.

========================================
FILE: src/background-tasks/task-manager.ts:301
----------------------------------------
**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Track completion for visible pi/sumocode runners**

Visible tasks are only polled for completion when `runner === "shell"`; for `runner: "pi"` or `"sumocode"` no poller or exit hook is installed, so these tasks remain `running` forever in `bg_task list`, cannot be cleared as finished, and never trigger `notifyOnExit` after the pane process exits. This breaks status accuracy for the new runner modes and should be handled by adding an exit-detection path for non-shell visible runners.

Useful? React with 👍 / 👎.

========================================
FILE: src/background-tasks/task-manager.ts:416
----------------------------------------
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Await cmux close before finalizing task as stopped**

`stopTask` fire-and-forgets `cmux close-surface` and immediately marks the task `stopped`. If the close command times out, exits non-zero, or rejects, the visible process can keep running while the manager reports success and stops tracking it, leaving users unable to reliably stop that task. The stop path should await and validate the close result, and only finalize on success (otherwise return an error and keep the task running).

Useful? React with 👍 / 👎.

========================================
FILE: src/background-tasks/task-manager.ts:168
----------------------------------------
**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Reject non-visible pi/sumocode task spawns**

When `visible` is false this branch always routes to `spawnInvisibleTask`, which executes `command` as a shell string and ignores `runner`. Because `runner: "pi" | "sumocode"` is accepted by the tool schema, a valid-looking spawn request can treat natural-language prompt text as a shell command (usually `command not found`, or unintended shell execution) instead of launching the requested agent runner. This should fail fast (or force `visible=true`) so runner semantics are consistent.

Useful? React with 👍 / 👎.

========================================
FILE: src/background-tasks/task-manager.ts:179
----------------------------------------
**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Disconnect stdio when spawning detached shell tasks**

The invisible task path marks children as `detached` but still wires stdout/stderr as pipes to the parent process. In Node, detached children are not guaranteed to survive parent teardown when stdio remains connected, so long-running `bg_task` shell work can die on session restart/crash even though it is reported as background work and persisted via task metadata. This is most visible when a user starts a long build/test and then reloads or loses the orchestrator process.

Useful? React with 👍 / 👎.

========================================
FILE: src/background-tasks/background-task-tool.ts:25
----------------------------------------
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Preserve running bg tasks across session replacement**

`session_shutdown` is emitted not only on process exit but also during `/reload` and session replacement flows; wiring it directly to `manager.shutdown()` means every running invisible task is force-terminated (`process.kill(-pid, "SIGTERM")` in `task-manager.shutdown`) whenever the runtime reloads. In practice, long-running `bg_task spawn` jobs die on reload/new/resume instead of continuing in the background, so users lose work and never get completion notifications.

Useful? React with 👍 / 👎.

========================================
FILE: bin/sumocode.sh:552
----------------------------------------
**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Unset task-mode flag after first delegated reload cycle**

This reload branch removes the original prompt args but leaves `SUMOCODE_TASK_MODE=1` exported for all subsequent relaunches, so a session that was already taken over (auto-exit canceled by typing) can re-enter task mode after `/sumo:reload` and unexpectedly arm auto-close again on the next `agent_end`. In practice this can close an actively used pane during later turns in the same resumed session; clear the task-mode env (or persist a keep-open override) once the initial kickoff handoff has been consumed.

Useful? React with 👍 / 👎.

========================================
FILE: src/background-tasks/task-manager.ts:55
----------------------------------------
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Read only tail bytes when polling visible task logs**

`pollVisibleTask` runs every 500ms for each visible shell task, but `readLogTail` does a full `readFileSync` of `output.log` before slicing the last characters. Once a task emits large logs, each poll becomes an O(file_size) synchronous disk read, which can spike CPU/IO and block the extension event loop while tasks are still running. This should read only the tail region (or avoid log scanning when `exit.code` exists) so polling cost stays bounded.

Useful? React with 👍 / 👎.

========================================
FILE: src/background-tasks/task-manager.ts:401
----------------------------------------
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Verify child exit before finalizing task as stopped**

`stopTask` sends a single `SIGTERM` to the detached process group and then unconditionally marks the task as `stopped`, but many long-running commands trap or ignore `SIGTERM`. In that case `bg_task stop` reports success while the process keeps running in the background and is no longer tracked, which leaves users with orphaned work they cannot manage through `bg_task` anymore. Wait for process exit (and escalate to `SIGKILL` on timeout) before finalizing.

Useful? React with 👍 / 👎.

========================================
FILE: src/background-tasks/visible-spawn.ts:150
----------------------------------------
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Route `pi` runner through task-mode handoff**

The `runner === "pi"` launch path executes `pi` directly with only `SUMOCODE_TASK_RESPONSE_FILE`/`SUMOCODE_TASK_DIAG_FILE`, but it never enables task mode like the `sumocode task` branch does. Because `installTaskModeAutoExit` only runs when `SUMOCODE_TASK_MODE=1` (`src/task-mode.ts`), the child never writes `response.md`; meanwhile `BackgroundTaskManager.armResponseWatcher` marks agent tasks complete only when that file appears. In practice, visible `runner: "pi"` tasks can remain `running` indefinitely and `bg_task log` stays in the “still working” state even after the child exits.

Useful? React with 👍 / 👎.
