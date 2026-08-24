import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../cathedral/ansi.js";
import { renderCathedralMermaid } from "./mermaid-renderer.js";

const WIDE_SEQUENCE_SOURCE = `sequenceDiagram
participant SRC as Issue sources<br/>(issue-tracker.md / Linear / GitHub)
participant FA as Fleet Agent<br/>(planning LLM run)
participant D as Dhruv
participant CP as Control plane
participant W as Worker (Mini)<br/>SumoCode in Herdr
participant GH as GitHub / CI / Preview
FA->>SRC: read sources
FA->>FA: rank with legible factors
FA-->>D: Queue: "#1 because it unblocks #15"
D->>CP: Approve dispatch
CP->>W: route -> worktree + task launch
W-->>D: question (attention state)
W->>GH: push branch, open PR
GH-->>CP: CI failed
CP->>W: same run, delta task
GH-->>D: CI green + preview healthy
D->>CP: Approve merge
CP->>GH: verify: merged ✓ CI-on-main ✓ deploy ✓`;

describe("renderCathedralMermaid", () => {
	it("renders a wide sequence as complete width-safe interaction bands", () => {
		const outcome = renderCathedralMermaid(WIDE_SEQUENCE_SOURCE, 94);

		expect(outcome.kind).toBe("rendered");
		if (outcome.kind !== "rendered") return;
		expect(outcome.rows.every((row) => visibleWidth(row) <= 94)).toBe(true);
		const plain = outcome.rows.map(stripAnsi).join("\n");
		for (const participant of ["Issue sources", "Fleet Agent", "Dhruv", "Control plane", "Worker (Mini)", "GitHub / CI / Preview"]) {
			expect(plain).toContain(participant);
		}
		for (const message of [
			"read sources",
			"rank with legible factors",
			"Queue: \"#1 because it unblocks #15\"",
			"Approve dispatch",
			"route -> worktree + task launch",
			"question (attention state)",
			"push branch, open PR",
			"CI failed",
			"same run, delta task",
			"CI green + preview healthy",
			"Approve merge",
			"verify: merged ✓ CI-on-main ✓ deploy ✓",
		]) {
			expect(plain).toContain(message);
		}
	});

	it("does not band semicolon-separated statements with incomplete participant metadata", () => {
		const outcome = renderCathedralMermaid(`sequenceDiagram
participant C as Charlie the important standalone participant
A->>B: one; B->>C: two`, 20);

		expect(outcome.kind).toBe("fallback");
	});

	it("does not drop explicitly declared participants that have no messages", () => {
		const outcome = renderCathedralMermaid(`sequenceDiagram
participant A as Alpha participant
participant B as Bravo participant
participant UNUSED as Important standalone
A->>B: first message`, 50);

		expect(outcome.kind).toBe("fallback");
	});

	it("does not split compact activation state across interaction bands", () => {
		const outcome = renderCathedralMermaid(`sequenceDiagram
participant A as Alpha participant
participant B as Bravo participant
participant C as Charlie participant
A->>+B: activate
B-->>-A: deactivate
A->>C: continue`, 32);

		expect(outcome.kind).toBe("fallback");
	});

	it("stops banding when the cumulative diagram exceeds the row limit", () => {
		const messages = Array.from({ length: 300 }, (_, index) => `C->>D: step ${index}`);
		const outcome = renderCathedralMermaid([
			"sequenceDiagram",
			"participant A as Alpha",
			"participant B as Bravo",
			"participant C as Charlie",
			"participant D as Delta",
			"A->>B: first",
			"C->>D: start",
			...messages,
		].join("\n"), 30);

		expect(outcome.kind).toBe("fallback");
	});
});
