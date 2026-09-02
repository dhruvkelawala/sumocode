/**
 * Owner-only task-artifact boundary shared by the visible-subagent parent
 * (`src/subagents/backend-pane.ts`) and the task-mode child
 * (`src/task-mode.ts`).
 *
 * Prompt, response, lifecycle, and steering data travel through private files
 * inside one per-child task directory. Every access validates that the entry
 * is a regular file we own, owner-only, and a direct child of the canonical
 * task (or control) directory, so a replaced or redirected path fails closed
 * instead of leaking prompt/steer text, clobbering foreign files, or reading
 * attacker-planted content. New artifacts are created exclusively (`wx`),
 * which also refuses to follow a symlink planted at the artifact path.
 */

import { lstatSync } from "node:fs";
import { dirname } from "node:path";

/** Owner-only directories: they carry prompts and every steering message. */
export const PRIVATE_DIR_MODE = 0o700;
/** Owner-only files: private artifacts and control files. */
export const PRIVATE_FILE_MODE = 0o600;

/** Structural subset of `fs.Stats` the validators consume. */
export interface PrivateArtifactStat {
	isFile(): boolean;
	isDirectory(): boolean;
	mode: number;
	uid: number;
}

export interface PrivateArtifactFs {
	lstatSync(path: string): PrivateArtifactStat;
}

export const nodeArtifactFs: PrivateArtifactFs = {
	lstatSync: (path) =>
		// SAFETY: node's Stats satisfies the structural PrivateArtifactStat subset by construction.
		lstatSync(path) as PrivateArtifactStat,
};

/**
 * Boundary predicate over fs rejections: they arrive as `unknown` from catch
 * clauses, and the documented Node errno shape is the sanctioned parse.
 */
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- errno shape is the documented Node contract for fs rejections; the code check is the sanctioned parse.
export const isErrnoCode = (error: unknown, code: string): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === code;
// oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof

/** True when the entry belongs to this process's user. Windows has no uid. */
export const isOwnedByUs = (stat: PrivateArtifactStat): boolean => {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- platform capability probe: `getuid` is absent on Windows, which is the documented skip condition.
	if (typeof process.getuid !== "function") return true;
	return stat.uid === process.getuid();
};

// SAFETY: fs rejections arrive as `unknown` from catch clauses; isErrnoCode is the sanctioned boundary parse before the code check.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary predicate over catch-clause `unknown`
const isEnoent = (error: unknown): boolean => isErrnoCode(error, "ENOENT");

/** True when group/other hold no permissions on the entry. */
const isOwnerOnly = (stat: PrivateArtifactStat): boolean => (stat.mode & 0o077) === 0;

/**
 * Validate an existing private directory (task dir or control dir) before
 * consuming it. A planted symlink reports as non-directory, and a widened
 * mode fails closed.
 */
export const assertPrivateDir = (fs: PrivateArtifactFs, path: string, label: string): void => {
	const stat = fs.lstatSync(path);
	if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
	if (!isOwnerOnly(stat)) throw new Error(`${label} is not owner-only (mode ${stat.mode.toString(8)}): ${path}`);
	if (!isOwnedByUs(stat)) throw new Error(`${label} is not owned by this user: ${path}`);
};

/**
 * Validate an already-lstat'ed entry: regular-file identity (rejects symlinks
 * at the final component), owner-only mode, and ownership.
 */
const assertPrivateStat = (stat: PrivateArtifactStat, path: string, label: string): void => {
	if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
	if (!isOwnerOnly(stat)) throw new Error(`${label} is not owner-only (mode ${stat.mode.toString(8)}): ${path}`);
	if (!isOwnedByUs(stat)) throw new Error(`${label} is not owned by this user: ${path}`);
};

/**
 * Validate an existing artifact before reading, overwriting, or removing it.
 * `lstat` rejects symlinks at the final component, and the parent check
 * confines the entry to direct children of `parentDir`, so an env-var or
 * path-replacement redirect fails closed.
 */
export const assertPrivateArtifact = (fs: PrivateArtifactFs, path: string, parentDir: string, label: string): void => {
	assertArtifactInsideDir(path, parentDir, label);
	assertPrivateStat(fs.lstatSync(path), path, label);
};

/**
 * Validate an artifact that may not exist yet: returns its stat when a valid
 * private artifact is present, `undefined` when the path is absent (the caller
 * may then create it exclusively), and throws on any tamper — including a
 * dangling symlink, widened mode, or redirected parent.
 */
export const validatedArtifactStat = (fs: PrivateArtifactFs, path: string, parentDir: string, label: string): PrivateArtifactStat | undefined => {
	assertArtifactInsideDir(path, parentDir, label);
	try {
		const stat = fs.lstatSync(path);
		assertPrivateStat(stat, path, label);
		return stat;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
};

/**
 * Confinement check for an artifact that may not exist yet: once created it
 * must live directly inside `parentDir`. Use before writes that create the
 * file; use `assertPrivateArtifact` when the entry must already exist.
 */
export const assertArtifactInsideDir = (path: string, parentDir: string, label: string): void => {
	// Confinement is lexical direct-child identity. It does not resolve the
	// parent's own ancestor symlinks: replacing the (owner-only, 0700) task or
	// control directory itself requires owner access, so a symlinked ancestor is
	// outside this boundary's threat model — documented as a deliberate ceiling.
	if (dirname(path) !== parentDir) {
		throw new Error(`${label} is not a direct child of ${parentDir}: ${path}`);
	}
};
