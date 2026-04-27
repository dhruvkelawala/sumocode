/** @jsxImportSource @opentui/react */

export type CathedralFooterIslandProps = {
	left?: string;
	right?: string;
	stateColor?: string;
	foreground?: string;
	foregroundDim?: string;
	background?: string;
};

export default function CathedralFooterIsland({
	left = "● READY · no-model · medium",
	right = "sumocode · ↑0 ↓0 · $0.00",
	stateColor = "#7FB069",
	foreground = "#F5E6C8",
	foregroundDim = "#8B7A63",
	background = "#1A1511",
}: CathedralFooterIslandProps) {
	return (
		<box
			style={{
				width: "100%",
				height: "100%",
				flexDirection: "row",
				justifyContent: "space-between",
				backgroundColor: background,
			}}
		>
			<box style={{ flexDirection: "row" }}>
				<text fg={stateColor}>● </text>
				<text fg={foreground}>{left}</text>
			</box>
			<text fg={foregroundDim}>{right}</text>
		</box>
	);
}
