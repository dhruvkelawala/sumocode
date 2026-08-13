export type MermaidRenderingMode = "off" | "final" | "streaming";

export function isMermaidLanguage(lang: string): boolean {
	return lang.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}
