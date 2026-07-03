import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	TranscriptController,
	type TaskPartialUpdate,
	type TranscriptControllerLiveStateSnapshot,
	type TranscriptControllerOptions,
} from "../transcript/controller.js";
import type { TranscriptViewModel } from "../transcript/view-model.js";

export type { TaskPartialUpdate };

export class RpcTranscriptPump {
	private readonly controller: TranscriptController;

	public constructor(options: TranscriptControllerOptions = {}) {
		this.controller = new TranscriptController(options);
	}

	public replaceFromMessages(messages: readonly unknown[]): TranscriptViewModel {
		return this.controller.replaceFromMessages(messages);
	}

	public handleAgentEvent(event: AgentSessionEvent | unknown): TranscriptViewModel {
		return this.controller.handleAgentEvent(event);
	}

	public viewModel(): TranscriptViewModel {
		return this.controller.viewModel();
	}

	public getTaskPartials(): readonly TaskPartialUpdate[] {
		return this.controller.getTaskPartials();
	}

	public getLiveStateSnapshot(): TranscriptControllerLiveStateSnapshot {
		return this.controller.getLiveStateSnapshot();
	}
}
