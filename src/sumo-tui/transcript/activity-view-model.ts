import { isSettledActivityStatus, type ActivitySnapshot } from "../../activity/domain.js";
import type { ChatMessageViewModel } from "./view-model.js";

export interface ActivityPresentationSnapshot {
	readonly activities: readonly ActivitySnapshot[];
	readonly expansion: Readonly<Record<string, boolean>>;
	readonly defaultExpansion?: boolean;
}

/** Standalone retained card used by the host-side durable Activity feed. */
export function activityCardViewModel(activity: ActivitySnapshot): ChatMessageViewModel {
	const role = activity.kind === "terminal" && !isSettledActivityStatus(activity.status) ? "sumo" : "system";
	return {
		id: `live-activity:${activity.id}`,
		role,
		displayName: role === "sumo" ? "SUMO" : "ACTIVITY",
		...(activity.createdAt !== undefined && { timestamp: new Date(activity.createdAt) }),
		blocks: [{ type: "activity", activity }],
	};
}
