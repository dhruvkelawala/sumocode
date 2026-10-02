// Pi imports Undici 8, which replaces Node 24's proxy-aware dispatcher.
// Test-only: use that same instance so the fake Jev still goes through srt's proxy.
import { createRequire } from "node:module";
const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const undici = require("undici");
undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ proxyTunnel: true }));
undici.install();
