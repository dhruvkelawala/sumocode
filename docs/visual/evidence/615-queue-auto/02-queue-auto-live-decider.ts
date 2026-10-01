// Drives the checkout's real decider (src/sumo-tui/rpc/auto-delivery.ts + src/judgment.ts) against live TypeSafe.
// Run from the repo root with TYPESAFE_API_KEY set: node_modules/.bin/jiti <path to this file>
const { typesafeChoiceClassifier } = await import(`${process.cwd()}/src/judgment.ts`);
const { createJevDeliveryDecider } = await import(`${process.cwd()}/src/sumo-tui/rpc/auto-delivery.ts`);
const key = process.env.TYPESAFE_API_KEY ?? "";
const task = "Refactor prompt-scheduler.ts to extract the compaction queue";
const time = async (label: string, decide: ReturnType<typeof createJevDeliveryDecider>, message: string) => {
	const started = performance.now();
	const delivery = await decide(message, task);
	console.log(`${label.padEnd(22)} ${delivery.padEnd(9)} ${String(Math.round(performance.now() - started)).padStart(5)}ms  ${message}`);
};
console.log(`current_task: ${task}`);
const live = createJevDeliveryDecider(typesafeChoiceClassifier(key));
for (const message of ["use a Map instead of an array", "wait, don't touch host.ts", "make sure it handles attachments too", "after that, look at issue 412", "then open a PR", "and run the tests"]) {
	await time("live jev", live, message);
}
await time("invalid key (401)", createJevDeliveryDecider(typesafeChoiceClassifier("invalid-key")), "after that, look at issue 412");
// A server that accepts the request and never answers: the decider must give up at its 1.5 s budget.
const { createServer } = await import("node:http");
const silent = createServer(() => undefined);
await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
const port = (silent.address() as { port: number }).port;
await time("no answer (timeout)", createJevDeliveryDecider(typesafeChoiceClassifier(key, `http://127.0.0.1:${port}`)), "after that, look at issue 412");
silent.closeAllConnections();
silent.close();
