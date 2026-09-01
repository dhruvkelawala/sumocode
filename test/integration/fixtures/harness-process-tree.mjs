import { spawn } from "node:child_process";

if (process.argv[2] !== "child") {
	spawn(process.execPath, [import.meta.filename, "child"], { stdio: "ignore" });
}
setInterval(() => {}, 1_000);
