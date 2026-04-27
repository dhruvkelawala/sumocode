/** @jsxImportSource @opentui/react */

export type CathedralShellIslandProps = {
	brand?: string;
	activeLabel?: string;
	stateColor?: string;
	accent?: string;
	foreground?: string;
	foregroundDim?: string;
	divider?: string;
	quote?: string;
	quoteAttribution?: string;
	hasMessages?: boolean;
	wordmarkRows?: string[];
};

const DEFAULT_WORDMARK = [
	"█████ █   █ █   █ █████ █████ █████ █████ █████ ",
	"█     █   █ ██ ██ █   █ █     █   █ █   █ █     ",
	"█████ █   █ █ █ █ █   █ █     █   █ █   █ ████  ",
	"    █ █   █ █   █ █   █ █     █   █ █   █ █     ",
	"█████ █████ █   █ █████ █████ █████ ████  █████ ",
];

const CAT_FACE = [
	"        /\\_____/\\        ",
	"       /  o   o  \\       ",
	"      ( ==  ^  == )      ",
	"       )         (       ",
	"      (           )      ",
	"     ( (  )   (  ) )     ",
	"    (__(__)___(__)__)    ",
];

function stateLabel(label: string): string {
	return label.toUpperCase();
}

export default function CathedralShellIsland({
	brand = "SUMOCODE",
	activeLabel = "READY",
	stateColor = "#7FB069",
	accent = "#D97706",
	foreground = "#F5E6C8",
	foregroundDim = "#8B7A63",
	divider = "#3A2F25",
	quote = '"PERFECTION IS ACHIEVED, NOT WHEN THERE IS NOTHING MORE TO ADD, BUT WHEN THERE IS NOTHING LEFT TO TAKE AWAY."',
	quoteAttribution = "— ANTOINE DE SAINT-EXUPÉRY",
	hasMessages = false,
	wordmarkRows = DEFAULT_WORDMARK,
}: CathedralShellIslandProps) {
	return (
		<box
			style={{
				width: "100%",
				height: "100%",
				flexDirection: "column",
				backgroundColor: "#1A1511",
			}}
		>
			<box style={{ width: "100%", height: 1, flexDirection: "row", paddingLeft: 0 }}>
				<text fg={accent}>{brand}</text>
				<text fg={foregroundDim}>   ║ </text>
				<text fg={stateColor}>●</text>
				<text fg={foreground}> {stateLabel(activeLabel)} </text>
				<text fg={foregroundDim}>║</text>
			</box>

			{hasMessages ? (
				<box style={{ flexGrow: 1, width: "100%" }} />
			) : (
				<box
					style={{
						width: "100%",
						flexGrow: 1,
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
					}}
				>
					{CAT_FACE.map((row, index) => (
						<text key={`cat:${index}`} fg={foregroundDim}>
							{row}
						</text>
					))}
					<box style={{ height: 1, width: "100%" }} />
					{wordmarkRows.map((row, index) => (
						<text key={`wordmark:${index}`} fg={accent}>
							{row}
						</text>
					))}
					<box style={{ height: 2, width: "100%" }} />
					<text fg={foregroundDim}>{quote}</text>
					<text fg={foregroundDim}>{quoteAttribution}</text>
				</box>
			)}

			<box style={{ width: "100%", height: 1, borderColor: divider }} />
		</box>
	);
}
