#!/usr/bin/env node
/**
 * Minimal stdio MCP server used to prove the subagent MCP capability handoff
 * (issue #568). It exposes one text tool and one tool that returns a native
 * image content block, and appends every call to $MCP_FIXTURE_LOG so a test can
 * assert the child actually reached it.
 *
 * Test fixture only: it implements just the subset of MCP that the adapter
 * negotiates for `tools/list` and `tools/call`.
 */
import { appendFileSync } from "node:fs";

const PROTOCOL_VERSION = "2025-06-18";
/** 1x1 transparent PNG. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const TOOLS = [
	{
		name: "echo",
		description: "Echo a text value back.",
		inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
	},
	{
		name: "image",
		description: "Return a synthetic image plus text metadata.",
		inputSchema: { type: "object", properties: {} },
	},
];

const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const logCall = (entry) => {
	const path = process.env.MCP_FIXTURE_LOG;
	if (path) appendFileSync(path, `${JSON.stringify(entry)}\n`);
};

function handle(request) {
	const { id, method, params } = request;
	if (method === "initialize") {
		return respond(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "sumocode-mcp-fixture", version: "1.0.0" } });
	}
	if (method === "tools/list") return respond(id, { tools: TOOLS });
	if (method === "tools/call") {
		const name = params?.name;
		logCall({ server: "fixture", tool: name, arguments: params?.arguments ?? {} });
		if (name === "echo") {
			return respond(id, { content: [{ type: "text", text: `echo:${params?.arguments?.value ?? ""}` }] });
		}
		if (name === "image") {
			return respond(id, {
				content: [
					{ type: "text", text: "fixture-image-metadata" },
					{ type: "image", mimeType: "image/png", data: PIXEL_PNG },
				],
			});
		}
		return respond(id, { isError: true, content: [{ type: "text", text: `unknown tool ${String(name)}` }] });
	}
	if (method?.startsWith("notifications/")) return undefined;
	// Unknown requests must still be answered so the client never stalls.
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported method ${String(method)}` } })}\n`);
	return undefined;
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) {
			try {
				handle(JSON.parse(line));
			} catch {
				// Malformed frames are the client's problem; stay alive for the next one.
			}
		}
		index = buffer.indexOf("\n");
	}
});
