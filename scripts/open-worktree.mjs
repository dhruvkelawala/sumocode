import { resolve } from "node:path";
import { createJiti } from "jiti";

const root = process.env.SUMOCODE_ROOT_DIR || resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: true, tryNative: false });
const { openWorktree } = await jiti.import(resolve(root, "src/cli/open-worktree.ts"));

const name = process.argv[2];
process.exitCode = await openWorktree(name);
