import { runRealRecovery } from "./plan112-real-recovery.js";

/** Every real cell selects an OS scenario explicitly; no fake fixture fallback. */
export async function runRealFault(name: string): Promise<void> {
	const local = (scenario: string) => runRealRecovery("headless", "same-process factory replacement", scenario);
	const remote = (scenario: string) => runRealRecovery("headless", "parent crash-restart", scenario);
	const handoff = /^ownership handoff: \/(new|resume|fork|reload) keeps/.exec(name);
	if (handoff) return local(`handoff:${handoff[1]}`);
	const crash = /^transition crash: (starting|pre-release|running|settling|post-manifest) preserves/.exec(name);
	if (crash) return remote(`crash:${crash[1]}`);
	if (name === "transition crash: spawned pre-release anchor must have a durable record") return remote("crash:pre-release");
	if (name === "ownership handoff: live-old-owner persist-only refuses the contender") return remote("persist-only");
	if (name === "ownership handoff: expired-owner CAS takeover records lost, not recovered pipes") return remote("expired-owner");
	if (name === "ownership handoff: two competing successors cannot acquire two controllers") return remote("competing");
	if (name === "writer death/takeover: former writer cannot publish after successor CAS") return remote("writer-death");
	if (name === "corrupt records: replacement preserves bytes and blocks all effects") return local("corrupt");
	if (name === "explicit cancel after recovery: only the successor interrupts once") return local("cancel");
	if (name === "exact-once delivery: settle-after-handoff sends one completion") return local("settle-after");
	if (name === "exact-once delivery: settle-before-handoff sends one completion") return local("settle-before");
	const delivery = /^exact-once delivery: (admission-before-call|send-before-ack|notice-before-ack) does not replay/.exec(name);
	if (delivery) return local(`delivery:${delivery[1]}`);
	const race = /^exact-once delivery: (check|wait|cancel|close) race/.exec(name);
	if (race) return local(`race:${race[1]}`);
	if (name === "cleanup: same original anchor, unknown never means zero") return remote("cleanup:same");
	if (name === "PID reuse denial: different anchor denies control and signals") return remote("stale-pid");
	if (name === "cleanup: retained anchor lifetime and installation census") return remote("census");
	if (name.includes("unknown") || name.includes("ambiguous-identity") || name.includes("different original anchor")) {
		throw new Error("capability: cannot force kernel identity inspection failure or PID recycling without replacing the real OS oracle; no fake fallback");
	}
	throw new Error(`real adapter incomplete: ${name}`);
}
