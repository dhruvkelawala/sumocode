// src/extension.ts
import { existsSync as existsSync14, readFileSync as readFileSync18, realpathSync as realpathSync5 } from "node:fs";
import { homedir as homedir16 } from "node:os";
import { dirname as dirname14, join as join22, resolve as resolve9, sep } from "node:path";
import { fileURLToPath as fileURLToPath5 } from "node:url";

// src/cathedral/input-hints.ts
import { visibleWidth as visibleWidth2 } from "@earendil-works/pi-tui";

// src/footer.ts
import { homedir as homedir2 } from "node:os";
import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// src/fast-mode.ts
import {
  clampThinkingLevel,
  getApiProvider,
  registerApiProvider,
  streamOpenAICodexResponses,
  streamOpenAIResponses,
  streamSimpleOpenAICodexResponses,
  streamSimpleOpenAIResponses
} from "@earendil-works/pi-ai/compat";

// src/fast-mode-status.ts
var FAST_MODE_STATUS_KEY = "sumocode.fast-mode";
var FAST_MODE_STATUS_TEXT = "fast";

// src/fast-mode.ts
var SERVICE_TIER = "priority";
var SUPPORTED_PROVIDERS = /* @__PURE__ */ new Set(["openai", "openai-codex"]);
var SUPPORTED_APIS = /* @__PURE__ */ new Set(["openai-responses", "openai-codex-responses"]);
var DEFAULT_FAST_MODELS = [
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai/gpt-5.6-sol",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.6-sol"
];
var OPENAI_RESPONSES_FAST_SOURCE = "sumocode:fast-mode:openai-responses";
var OPENAI_CODEX_RESPONSES_FAST_SOURCE = "sumocode:fast-mode:openai-codex-responses";
function streamNativeApiProvider(model, context, options) {
  const provider = getApiProvider(model.api);
  if (!provider) throw new Error(`sumocode fast mode: unsupported API override ${String(model.api)}`);
  return provider.streamSimple(model, context, options);
}
var DEFAULT_STREAMERS = {
  streamOpenAIResponses,
  streamSimpleOpenAIResponses,
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
  streamUnsupportedApi: streamNativeApiProvider
};
function normalizeModelRef(ref) {
  return ref.trim().toLowerCase();
}
function isConfiguredFastModel(config, model) {
  if (!model) return false;
  if (!SUPPORTED_PROVIDERS.has(model.provider)) return false;
  const bare = normalizeModelRef(model.id);
  const full = normalizeModelRef(`${model.provider}/${model.id}`);
  return config.models.some((entry) => {
    const normalized = normalizeModelRef(entry);
    return normalized === bare || normalized === full;
  });
}
function shouldApplyFastMode(config, model) {
  return config.enabled && isConfiguredFastModel(config, model) && SUPPORTED_APIS.has(model?.api ?? "");
}
var DEFAULT_MAX_OUTPUT_TOKENS = 32e3;
var CONTEXT_WINDOW_OUTPUT_TOLERANCE = 1024;
function defaultMaxTokens(model) {
  if (model.maxTokens <= 0) return void 0;
  if (model.maxTokens >= model.contextWindow - CONTEXT_WINDOW_OUTPUT_TOLERANCE) {
    return Math.min(model.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  }
  return model.maxTokens;
}
function buildBaseProviderOptions(model, options) {
  return {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens ?? defaultMaxTokens(model),
    signal: options?.signal,
    apiKey: options?.apiKey,
    transport: options?.transport,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    headers: options?.headers,
    timeoutMs: options?.timeoutMs,
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata
  };
}
function clampReasoning(model, reasoning) {
  if (!reasoning) return void 0;
  const clamped = clampThinkingLevel(model, reasoning);
  return clamped === "off" ? void 0 : clamped;
}
function buildOpenAIResponsesFastOptions(model, options) {
  return {
    ...buildBaseProviderOptions(model, options),
    reasoningEffort: clampReasoning(model, options?.reasoning),
    serviceTier: SERVICE_TIER
  };
}
function buildOpenAICodexResponsesFastOptions(model, options) {
  return {
    ...buildBaseProviderOptions(model, options),
    // SAFETY: clampReasoning already narrowed to the reasoningEffort union;
    // Codex accepts the same values as the Responses reasoningEffort type.
    reasoningEffort: clampReasoning(model, options?.reasoning),
    serviceTier: SERVICE_TIER
  };
}
function createFastModeStream(config, streamers) {
  return (model, context, options) => {
    const currentConfig = config();
    if (model.api === "openai-responses") {
      return shouldApplyFastMode(currentConfig, model) ? streamers.streamOpenAIResponses(model, context, buildOpenAIResponsesFastOptions(model, options)) : streamers.streamSimpleOpenAIResponses(model, context, options);
    }
    if (model.api === "openai-codex-responses") {
      return shouldApplyFastMode(currentConfig, model) ? streamers.streamOpenAICodexResponses(model, context, buildOpenAICodexResponsesFastOptions(model, options)) : streamers.streamSimpleOpenAICodexResponses(model, context, options);
    }
    return streamers.streamUnsupportedApi(model, context, options);
  };
}
function describeFastMode(state, model) {
  const stateText = state.enabled ? "ON" : "OFF";
  if (!model) return `Fast mode ${stateText}. No model selected.`;
  const modelKey = `${model.provider}/${model.id}`;
  if (shouldApplyFastMode(state, model)) return `Fast mode ${stateText}. Applying ${SERVICE_TIER} service tier to ${modelKey}.`;
  if (state.enabled && !isConfiguredFastModel(state, model)) return `Fast mode ${stateText}, inactive for unsupported model ${modelKey}.`;
  return `Fast mode ${stateText}. Current model: ${modelKey}.`;
}
function notify(ctx, message, level) {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}
function publishFastModeStatus(ctx, state, model) {
  if (!ctx?.hasUI) return;
  const setStatus = ctx.ui.setStatus;
  if (!isSetStatusFunction(setStatus)) return;
  setStatus.call(ctx.ui, FAST_MODE_STATUS_KEY, shouldApplyFastMode(state, model) ? FAST_MODE_STATUS_TEXT : void 0);
}
function isSetStatusFunction(value) {
  return typeof value === "function";
}
function installFastMode(pi, options = {}) {
  const state = {
    enabled: options.initialEnabled ?? false,
    models: DEFAULT_FAST_MODELS
  };
  let currentModel;
  let activeUiContext;
  const nativeOpenAIResponses = getApiProvider("openai-responses");
  const nativeOpenAICodexResponses = getApiProvider("openai-codex-responses");
  const streamSimple = createFastModeStream(
    () => state,
    {
      ...DEFAULT_STREAMERS,
      streamSimpleOpenAIResponses: nativeOpenAIResponses?.streamSimple ?? DEFAULT_STREAMERS.streamSimpleOpenAIResponses,
      streamSimpleOpenAICodexResponses: nativeOpenAICodexResponses?.streamSimple ?? DEFAULT_STREAMERS.streamSimpleOpenAICodexResponses,
      ...options.streamers
    }
  );
  registerApiProvider({
    api: "openai-responses",
    // SAFETY: the api discriminator keys the stream; the fallback path casts
    // the generic model/options to the provider's concrete shapes.
    stream: nativeOpenAIResponses?.stream ?? ((model, context, streamOptions) => streamOpenAIResponses(model, context, streamOptions)),
    streamSimple
  }, OPENAI_RESPONSES_FAST_SOURCE);
  registerApiProvider({
    api: "openai-codex-responses",
    // SAFETY: the api discriminator keys the stream; the fallback path casts
    // the generic model/options to the provider's concrete shapes.
    stream: nativeOpenAICodexResponses?.stream ?? ((model, context, streamOptions) => streamOpenAICodexResponses(model, context, streamOptions)),
    streamSimple
  }, OPENAI_CODEX_RESPONSES_FAST_SOURCE);
  pi.on("session_start", async (_event, ctx) => {
    state.enabled = false;
    currentModel = ctx.model;
    activeUiContext = ctx;
    publishFastModeStatus(activeUiContext, state, currentModel);
    options.onChange?.();
  });
  pi.on("model_select", async (event) => {
    currentModel = event.model;
    publishFastModeStatus(activeUiContext, state, currentModel);
  });
  pi.registerCommand("fast", {
    description: "Toggle OpenAI/Codex fast mode",
    handler: async (args, ctx) => {
      currentModel = ctx.model;
      const arg = args.trim().toLowerCase();
      if (!arg || arg === "toggle") state.enabled = !state.enabled;
      else if (arg === "on") state.enabled = true;
      else if (arg === "off") state.enabled = false;
      else if (arg === "status") {
        notify(ctx, describeFastMode(state, currentModel), "info");
        return;
      } else {
        notify(ctx, "Usage: /fast [on|off|toggle|status]", "error");
        return;
      }
      publishFastModeStatus(ctx, state, currentModel);
      options.onChange?.();
      notify(ctx, describeFastMode(state, currentModel), state.enabled ? "warning" : "info");
    }
  });
  return state;
}

// src/session-cache.ts
import { execFile, execFileSync } from "node:child_process";

// src/sumo-tui/runtime/diagnostics.ts
import { appendFileSync } from "node:fs";
var PREVIEW_MAX = 160;
function diagnosticsFile() {
  const file = process.env.SUMO_TUI_DIAG_FILE;
  return file && file.trim().length > 0 ? file : void 0;
}
function isDiagnosticsEnabled() {
  return diagnosticsFile() !== void 0;
}
function isDiagnosticString(value) {
  return typeof value === "string";
}
function isScalarDiagnosticValue(value) {
  return typeof value === "number" || typeof value === "boolean" || value === null || value === void 0;
}
function sanitizeDiagnosticValue(value) {
  if (isDiagnosticString(value)) return value.length > PREVIEW_MAX ? `${value.slice(0, PREVIEW_MAX)}\u2026` : value;
  if (isScalarDiagnosticValue(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnosticValue(entry));
  const next = {};
  for (const [key, entry] of Object.entries(value)) next[key] = sanitizeDiagnosticValue(entry);
  return next;
}
var diagnosticsStart = performance.now();
var lastMark = diagnosticsStart;
function logDiagnostic(event, fields = {}) {
  const file = diagnosticsFile();
  if (!file) return;
  try {
    const now = performance.now();
    const sanitized = {};
    for (const [key, value] of Object.entries(fields)) sanitized[key] = sanitizeDiagnosticValue(value);
    appendFileSync(file, `${JSON.stringify({ ts: Date.now(), event, sinceDiagnosticsMs: Math.round((now - diagnosticsStart) * 100) / 100, deltaMs: Math.round((now - lastMark) * 100) / 100, ...sanitized })}
`, { encoding: "utf8", mode: 384 });
    lastMark = now;
  } catch {
  }
}
function createPiEventInstrumentation() {
  if (!isDiagnosticsEnabled()) return void 0;
  const instrumented = /* @__PURE__ */ new WeakSet();
  return {
    wrap(eventName, listener) {
      if (instrumented.has(listener)) return listener;
      instrumented.add(listener);
      return (...args) => {
        logDiagnostic("pi_event", { name: eventName });
        return listener(...args);
      };
    }
  };
}
function logPiEventInstrumented() {
  logDiagnostic("pi_event_instrumentation", { enabled: true });
}

// src/render-diagnostics.ts
import { createRequire } from "node:module";
import { performance as performance2 } from "node:perf_hooks";

// src/sumo-tui/runtime/terminal-errors.ts
var TERMINAL_IO_ERROR_CODES = /* @__PURE__ */ new Set([
  "EPIPE",
  "EIO",
  "ENOTTY",
  "EBADF",
  "ERR_STREAM_DESTROYED"
]);
function isErrorString(value) {
  return typeof value === "string";
}
function isTerminalIoError(cause) {
  if (cause === null || cause === void 0) return false;
  const candidate = cause;
  if (isErrorString(candidate.code) && TERMINAL_IO_ERROR_CODES.has(candidate.code)) return true;
  const message = isErrorString(candidate.message) ? candidate.message : "";
  return message === "Object has been destroyed" || /\b(?:write|read) EIO\b/i.test(message) || /\b(?:write|read) EPIPE\b/i.test(message) || /\bsetRawMode ENOTTY\b/i.test(message);
}

// src/render-diagnostics.ts
var SLOW_RENDER_THRESHOLD_MS = 4;
var SLOW_STDOUT_THRESHOLD_MS = 4;
var SLOW_KEYSTROKE_THRESHOLD_MS = 32;
var SLOW_STDIN_HANDLER_THRESHOLD_MS = 16;
var SLOW_EVENT_LOOP_LAG_MS = 50;
var EVENT_LOOP_PROBE_MS = 100;
var SLOW_MODULE_LOAD_MS = 8;
var STATS_FLUSH_MS = 1e3;
var RenderStats = class {
  buckets = /* @__PURE__ */ new Map();
  getBranchCalls = 0;
  cacheUsageHits = 0;
  cacheUsageMisses = 0;
  cacheBranchHits = 0;
  cacheBranchMisses = 0;
  cacheBranchChanges = 0;
  piEvents = 0;
  keystrokes = 0;
  keystrokeBytes = 0;
  stdoutByStream = /* @__PURE__ */ new Map();
  keystrokeLatency = { count: 0, totalMs: 0, maxMs: 0 };
  stdinHandlerLatency = { count: 0, totalMs: 0, maxMs: 0 };
  eventLoopLag = { count: 0, totalMs: 0, maxMs: 0 };
  moduleLoad = { count: 0, totalMs: 0, maxMs: 0, slowestSpec: void 0 };
  flushTimer;
  start() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), STATS_FLUSH_MS);
    this.flushTimer.unref?.();
  }
  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = void 0;
    this.flush();
  }
  recordRender(target, durationMs, width, lines) {
    const bucket = this.buckets.get(target) ?? { count: 0, totalMs: 0, maxMs: 0 };
    bucket.count += 1;
    bucket.totalMs += durationMs;
    if (durationMs > bucket.maxMs) bucket.maxMs = durationMs;
    this.buckets.set(target, bucket);
    if (durationMs >= SLOW_RENDER_THRESHOLD_MS) {
      logDiagnostic("render_sample", { target, durationMs: round(durationMs), width, lines });
    }
  }
  recordGetBranch() {
    this.getBranchCalls += 1;
  }
  recordCacheUsageHit() {
    this.cacheUsageHits += 1;
  }
  recordCacheUsageMiss() {
    this.cacheUsageMisses += 1;
  }
  recordCacheBranchHit() {
    this.cacheBranchHits += 1;
  }
  recordCacheBranchMiss() {
    this.cacheBranchMisses += 1;
  }
  recordCacheBranchChange() {
    this.cacheBranchChanges += 1;
  }
  recordPiEvent() {
    this.piEvents += 1;
  }
  recordKeystroke(bytes) {
    this.keystrokes += 1;
    this.keystrokeBytes += bytes;
  }
  recordKeystrokeLatency(durationMs, bytes) {
    this.keystrokeLatency.count += 1;
    this.keystrokeLatency.totalMs += durationMs;
    if (durationMs > this.keystrokeLatency.maxMs) this.keystrokeLatency.maxMs = durationMs;
    if (durationMs >= SLOW_KEYSTROKE_THRESHOLD_MS) {
      logDiagnostic("keystroke_slow", { durationMs: round(durationMs), bytes });
    }
  }
  recordStdinHandler(durationMs, bytes) {
    this.stdinHandlerLatency.count += 1;
    this.stdinHandlerLatency.totalMs += durationMs;
    if (durationMs > this.stdinHandlerLatency.maxMs) this.stdinHandlerLatency.maxMs = durationMs;
    if (durationMs >= SLOW_STDIN_HANDLER_THRESHOLD_MS) {
      logDiagnostic("stdin_handler_slow", { durationMs: round(durationMs), bytes });
    }
  }
  recordEventLoopLag(actualMs, expectedMs) {
    const lag = Math.max(0, actualMs - expectedMs);
    this.eventLoopLag.count += 1;
    this.eventLoopLag.totalMs += lag;
    if (lag > this.eventLoopLag.maxMs) this.eventLoopLag.maxMs = lag;
    if (lag >= SLOW_EVENT_LOOP_LAG_MS) {
      logDiagnostic("event_loop_lag", { lagMs: round(lag), actualMs: round(actualMs), expectedMs });
    }
  }
  recordModuleLoad(spec, durationMs, fields = {}) {
    this.moduleLoad.count += 1;
    this.moduleLoad.totalMs += durationMs;
    if (durationMs > this.moduleLoad.maxMs) {
      this.moduleLoad.maxMs = durationMs;
      this.moduleLoad.slowestSpec = spec;
    }
    if (durationMs >= SLOW_MODULE_LOAD_MS) {
      logDiagnostic("module_load_slow", { spec, durationMs: round(durationMs), ...fields });
    }
  }
  recordWrite(stream, bytes, durationMs) {
    const bucket = this.stdoutByStream.get(stream) ?? { writes: 0, bytes: 0, writeMs: 0, maxWriteMs: 0, maxBytes: 0 };
    bucket.writes += 1;
    bucket.bytes += bytes;
    bucket.writeMs += durationMs;
    if (durationMs > bucket.maxWriteMs) bucket.maxWriteMs = durationMs;
    if (bytes > bucket.maxBytes) bucket.maxBytes = bytes;
    this.stdoutByStream.set(stream, bucket);
    if (durationMs >= SLOW_STDOUT_THRESHOLD_MS) {
      logDiagnostic("stdout_slow", { stream, bytes, durationMs: round(durationMs) });
    }
  }
  flush() {
    const nothingToReport = this.buckets.size === 0 && this.getBranchCalls === 0 && this.cacheUsageHits === 0 && this.cacheUsageMisses === 0 && this.cacheBranchHits === 0 && this.cacheBranchMisses === 0 && this.cacheBranchChanges === 0 && this.piEvents === 0 && this.keystrokes === 0 && this.stdoutByStream.size === 0 && this.keystrokeLatency.count === 0 && this.stdinHandlerLatency.count === 0 && this.eventLoopLag.count === 0 && this.moduleLoad.count === 0;
    if (nothingToReport) return;
    const targets = {};
    for (const [target, bucket] of this.buckets.entries()) {
      targets[target] = {
        count: bucket.count,
        totalMs: round(bucket.totalMs),
        maxMs: round(bucket.maxMs),
        avgMs: round(bucket.totalMs / bucket.count)
      };
    }
    const io = {};
    for (const [stream, bucket] of this.stdoutByStream.entries()) {
      io[stream] = {
        writes: bucket.writes,
        bytes: bucket.bytes,
        writeMs: round(bucket.writeMs),
        maxWriteMs: round(bucket.maxWriteMs),
        maxBytes: bucket.maxBytes,
        avgWriteMs: round(bucket.writeMs / bucket.writes),
        avgBytes: Math.round(bucket.bytes / bucket.writes)
      };
    }
    const keystrokeStats = this.keystrokeLatency.count > 0 ? {
      count: this.keystrokeLatency.count,
      totalMs: round(this.keystrokeLatency.totalMs),
      maxMs: round(this.keystrokeLatency.maxMs),
      avgMs: round(this.keystrokeLatency.totalMs / this.keystrokeLatency.count)
    } : void 0;
    const stdinHandlerStats = this.stdinHandlerLatency.count > 0 ? {
      count: this.stdinHandlerLatency.count,
      totalMs: round(this.stdinHandlerLatency.totalMs),
      maxMs: round(this.stdinHandlerLatency.maxMs),
      avgMs: round(this.stdinHandlerLatency.totalMs / this.stdinHandlerLatency.count)
    } : void 0;
    const loopLagStats = this.eventLoopLag.count > 0 ? {
      count: this.eventLoopLag.count,
      totalMs: round(this.eventLoopLag.totalMs),
      maxMs: round(this.eventLoopLag.maxMs),
      avgMs: round(this.eventLoopLag.totalMs / this.eventLoopLag.count)
    } : void 0;
    const moduleLoadStats = this.moduleLoad.count > 0 ? {
      count: this.moduleLoad.count,
      totalMs: round(this.moduleLoad.totalMs),
      maxMs: round(this.moduleLoad.maxMs),
      avgMs: round(this.moduleLoad.totalMs / this.moduleLoad.count),
      slowestSpec: this.moduleLoad.slowestSpec
    } : void 0;
    logDiagnostic("render_stats", {
      windowMs: STATS_FLUSH_MS,
      targets,
      io,
      getBranchCalls: this.getBranchCalls,
      sessionCacheHits: this.cacheUsageHits,
      sessionCacheMisses: this.cacheUsageMisses,
      branchCacheHits: this.cacheBranchHits,
      branchCacheMisses: this.cacheBranchMisses,
      branchCacheChanges: this.cacheBranchChanges,
      piEvents: this.piEvents,
      keystrokes: this.keystrokes,
      keystrokeBytes: this.keystrokeBytes,
      keystrokeLatency: keystrokeStats,
      stdinHandler: stdinHandlerStats,
      eventLoopLag: loopLagStats,
      moduleLoad: moduleLoadStats
    });
    this.buckets.clear();
    this.getBranchCalls = 0;
    this.cacheUsageHits = 0;
    this.cacheUsageMisses = 0;
    this.cacheBranchHits = 0;
    this.cacheBranchMisses = 0;
    this.cacheBranchChanges = 0;
    this.piEvents = 0;
    this.keystrokes = 0;
    this.keystrokeBytes = 0;
    this.stdoutByStream.clear();
    this.keystrokeLatency.count = 0;
    this.keystrokeLatency.totalMs = 0;
    this.keystrokeLatency.maxMs = 0;
    this.stdinHandlerLatency.count = 0;
    this.stdinHandlerLatency.totalMs = 0;
    this.stdinHandlerLatency.maxMs = 0;
    this.eventLoopLag.count = 0;
    this.eventLoopLag.totalMs = 0;
    this.eventLoopLag.maxMs = 0;
    this.moduleLoad.count = 0;
    this.moduleLoad.totalMs = 0;
    this.moduleLoad.maxMs = 0;
    this.moduleLoad.slowestSpec = void 0;
  }
};
function round(n) {
  return Math.round(n * 100) / 100;
}
var GLOBAL_RENDER_STATS_KEY = "__sumoRenderDiagnosticsStats";
var GLOBAL_EVENT_LOOP_PROBE_KEY = "__sumoRenderDiagnosticsEventLoopProbeStarted";
var globalForRenderDiagnostics = globalThis;
if (!globalForRenderDiagnostics[GLOBAL_RENDER_STATS_KEY]) globalForRenderDiagnostics[GLOBAL_RENDER_STATS_KEY] = new RenderStats();
var stats = globalForRenderDiagnostics[GLOBAL_RENDER_STATS_KEY];
var renderDiagnosticsCounters = {
  noteCacheHit() {
    if (isDiagnosticsEnabled()) stats.recordCacheUsageHit();
  },
  noteCacheMiss() {
    if (isDiagnosticsEnabled()) stats.recordCacheUsageMiss();
  },
  noteBranchCacheHit() {
    if (isDiagnosticsEnabled()) stats.recordCacheBranchHit();
  },
  noteBranchCacheMiss() {
    if (isDiagnosticsEnabled()) stats.recordCacheBranchMiss();
  },
  noteBranchChange() {
    if (isDiagnosticsEnabled()) stats.recordCacheBranchChange();
  }
};
function withTerminalIoGuard(write, args, onSuccess, onTerminalUnavailable) {
  const nextArgs = [...args];
  const last = nextArgs.at(-1);
  if (typeof last === "function") {
    nextArgs[nextArgs.length - 1] = (error) => {
      if (isTerminalIoError(error)) {
        onTerminalUnavailable();
        return void 0;
      }
      return last(error);
    };
  }
  try {
    const result = write(...nextArgs);
    onSuccess();
    return result;
  } catch (error) {
    onSuccess();
    if (isTerminalIoError(error)) {
      onTerminalUnavailable();
      return false;
    }
    throw error;
  }
}
function patchRender(target, component) {
  const original = component.render.bind(component);
  component.render = (width) => {
    const start = performance2.now();
    const result = original(width);
    const duration = performance2.now() - start;
    stats.recordRender(target, duration, width, Array.isArray(result) ? result.length : 0);
    return result;
  };
}
function instrumentUi(ctx) {
  const ui = ctx.ui;
  if (!ui) return;
  if (typeof ui.setFooter === "function") {
    const original = ui.setFooter.bind(ui);
    ui.setFooter = (factory) => {
      if (typeof factory !== "function") return original(factory);
      const wrapped = (...args) => {
        const result = factory(...args);
        if (result && typeof result.render === "function") {
          patchRender("footer", result);
        }
        return result;
      };
      return original(wrapped);
    };
  }
  if (typeof ui.setHeader === "function") {
    const original = ui.setHeader.bind(ui);
    ui.setHeader = (factory) => {
      if (typeof factory !== "function") return original(factory);
      const wrapped = (...args) => {
        const result = factory(...args);
        if (result && typeof result.render === "function") {
          patchRender("header", result);
        }
        return result;
      };
      return original(wrapped);
    };
  }
  if (typeof ui.setEditorComponent === "function") {
    const original = ui.setEditorComponent.bind(ui);
    ui.setEditorComponent = (factory) => {
      if (typeof factory !== "function") return original(factory);
      const wrapped = (...args) => {
        const result = factory(...args);
        if (result && typeof result.render === "function") {
          patchRender("editor", result);
        }
        return result;
      };
      return original(wrapped);
    };
  }
  if (typeof ui.setWidget === "function") {
    const original = ui.setWidget.bind(ui);
    ui.setWidget = (key, content, options) => {
      if (typeof content !== "function") return original(key, content, options);
      const wrapped = (...args) => {
        const result = content(...args);
        if (result && typeof result.render === "function") {
          patchRender(`widget:${key}`, result);
        }
        return result;
      };
      return original(key, wrapped, options);
    };
  }
}
function instrumentSessionManager(ctx) {
  const sm = ctx.sessionManager;
  if (!sm || typeof sm.getBranch !== "function") return;
  const original = sm.getBranch.bind(sm);
  sm.getBranch = (...args) => {
    stats.recordGetBranch();
    return original(...args);
  };
}
function instrumentWritable(stream, label) {
  const marker = `__sumoTuiDiagnosticsWritePatched_${label}`;
  const target = stream;
  if (target[marker]) return;
  const original = target.write.bind(stream);
  let streamUnavailable = false;
  target.write = ((chunk, ...rest) => {
    if (streamUnavailable) return false;
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    const start = performance2.now();
    return withTerminalIoGuard(
      original,
      [chunk, ...rest],
      () => {
        const duration = performance2.now() - start;
        stats.recordWrite(label, bytes, duration);
      },
      () => {
        streamUnavailable = true;
      }
    );
  });
  target[marker] = true;
}
function instrumentStdin() {
  const stdin = process.stdin;
  if (stdin.__sumoTuiDiagnosticsStdinPatched) return;
  stdin.__sumoTuiDiagnosticsStdinPatched = true;
  let pendingSince;
  let pendingBytes = 0;
  const stdinTyped = stdin;
  const originalEmit = stdinTyped.emit.bind(stdinTyped);
  stdinTyped.emit = ((eventName, ...args) => {
    if (eventName !== "data") return originalEmit(eventName, ...args);
    const chunk = args[0];
    const bytes = chunk === void 0 ? 0 : typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    stats.recordKeystroke(bytes);
    if (chunk !== void 0 && bytes > 0) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const sliced = buf.subarray(0, 64);
      let hex = "";
      let ascii = "";
      for (const b of sliced) {
        hex += b.toString(16).padStart(2, "0") + " ";
        ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : ".";
      }
      logDiagnostic("stdin_raw", {
        bytes,
        truncated: bytes > 64,
        hex: hex.trimEnd(),
        ascii
      });
    }
    if (pendingSince === void 0) {
      pendingSince = performance2.now();
      pendingBytes = bytes;
    } else {
      pendingBytes += bytes;
    }
    const start = performance2.now();
    const result = originalEmit(eventName, ...args);
    const duration = performance2.now() - start;
    stats.recordStdinHandler(duration, bytes);
    return result;
  });
  const stdoutPatchedKey = "__sumoTuiDiagnosticsKeystrokeLatencyHooked";
  const stdoutTarget = process.stdout;
  if (stdoutTarget[stdoutPatchedKey]) return;
  stdoutTarget[stdoutPatchedKey] = true;
  const originalWrite = stdoutTarget.write.bind(process.stdout);
  let stdoutUnavailable = false;
  stdoutTarget.write = ((chunk, ...rest) => {
    if (stdoutUnavailable) return false;
    if (pendingSince !== void 0) {
      const duration = performance2.now() - pendingSince;
      stats.recordKeystrokeLatency(duration, pendingBytes);
      pendingSince = void 0;
      pendingBytes = 0;
    }
    return withTerminalIoGuard(
      originalWrite,
      [chunk, ...rest],
      () => void 0,
      () => {
        stdoutUnavailable = true;
      }
    );
  });
}
function instrumentModuleLoad() {
  try {
    const require2 = createRequire(import.meta.url);
    const Module = require2("module");
    if (Module.__sumoTuiDiagnosticsModuleLoadPatched) return;
    const proto = Module.prototype;
    if (!proto || typeof proto.require !== "function") return;
    const original = proto.require;
    proto.require = function patchedRequire(id) {
      const start = performance2.now();
      let resolved;
      let parentId;
      try {
        const parent = this;
        parentId = typeof parent.filename === "string" ? parent.filename : typeof parent.id === "string" ? parent.id : void 0;
        const resolveFilename = parent.constructor?._resolveFilename;
        if (typeof resolveFilename === "function") resolved = resolveFilename(id, this);
      } catch {
      }
      try {
        return original.call(this, id);
      } finally {
        const duration = performance2.now() - start;
        stats.recordModuleLoad(id, duration, { resolved, parent: parentId });
      }
    };
    Module.__sumoTuiDiagnosticsModuleLoadPatched = true;
  } catch {
  }
}
function startEventLoopLagProbe() {
  if (globalForRenderDiagnostics[GLOBAL_EVENT_LOOP_PROBE_KEY]) return;
  globalForRenderDiagnostics[GLOBAL_EVENT_LOOP_PROBE_KEY] = true;
  let lastTick = performance2.now();
  const probe = () => {
    const now = performance2.now();
    const elapsed2 = now - lastTick;
    stats.recordEventLoopLag(elapsed2, EVENT_LOOP_PROBE_MS);
    lastTick = now;
    const t2 = setTimeout(probe, EVENT_LOOP_PROBE_MS);
    t2.unref?.();
  };
  const t = setTimeout(probe, EVENT_LOOP_PROBE_MS);
  t.unref?.();
}
function instrumentPiEvents(pi) {
  const marker = "__sumoTuiDiagnosticsRenderPiInstrumented";
  const target = pi;
  if (target[marker]) return;
  const originalOn = target.on.bind(pi);
  target.on = ((eventName, handler) => {
    if (typeof handler !== "function") return originalOn(eventName, handler);
    const wrapped = (...args) => {
      stats.recordPiEvent();
      return handler(...args);
    };
    return originalOn(eventName, wrapped);
  });
  target[marker] = true;
}
function installRenderDiagnostics(pi) {
  if (!isDiagnosticsEnabled()) return;
  stats.start();
  logDiagnostic("render_diagnostics_install", {
    renderThresholdMs: SLOW_RENDER_THRESHOLD_MS,
    stdoutThresholdMs: SLOW_STDOUT_THRESHOLD_MS,
    keystrokeThresholdMs: SLOW_KEYSTROKE_THRESHOLD_MS,
    flushMs: STATS_FLUSH_MS
  });
  instrumentWritable(process.stdout, "stdout");
  instrumentWritable(process.stderr, "stderr");
  instrumentStdin();
  instrumentPiEvents(pi);
  instrumentModuleLoad();
  startEventLoopLagProbe();
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    instrumentUi(ctx);
    instrumentSessionManager(ctx);
    logDiagnostic("render_diagnostics_session", { cwd: ctx.cwd });
  });
}

// src/session-cache.ts
var liveSessionHasMessages = false;
var cache = /* @__PURE__ */ new WeakMap();
function entryFor(ctx) {
  let entry = cache.get(ctx);
  if (!entry) {
    entry = { usage: void 0, branch: void 0, asyncRefreshInFlight: false };
    cache.set(ctx, entry);
  }
  return entry;
}
function invalidateSessionUsage(ctx) {
  const e = cache.get(ctx);
  if (e) e.usage = void 0;
  logDiagnostic("session_cache_invalidate", { liveSessionHasMessages });
}
function noteSessionMessage() {
  liveSessionHasMessages = true;
  logDiagnostic("session_cache_note_message", { liveSessionHasMessages: true });
}
function getSessionUsage(ctx) {
  const entry = entryFor(ctx);
  if (entry.usage) {
    renderDiagnosticsCounters.noteCacheHit();
    return entry.usage;
  }
  renderDiagnosticsCounters.noteCacheMiss();
  let input = 0;
  let output = 0;
  let cost = 0;
  let hasMessages = false;
  let branchLen = 0;
  for (const e of ctx.sessionManager.getBranch()) {
    branchLen += 1;
    if (e.type !== "message") continue;
    hasMessages = true;
    const message = e.message;
    if (!message || message.role !== "assistant" || !message.usage) continue;
    input += message.usage.input ?? 0;
    output += message.usage.output ?? 0;
    cost += message.usage.cost?.total ?? 0;
  }
  const result = { input, output, cost, hasMessages: hasMessages || liveSessionHasMessages };
  logDiagnostic("session_cache_walk", { branchLen, hasMessagesFromWalk: hasMessages, liveSessionHasMessages, result: result.hasMessages });
  entry.usage = result;
  return entry.usage;
}
function sessionHasMessages(ctx) {
  if (liveSessionHasMessages) return true;
  return getSessionUsage(ctx).hasMessages;
}
var linkedBranchProvider = null;
var linkedProviderUnsubscribe = null;
function linkGitBranchProvider(provider) {
  linkedProviderUnsubscribe?.();
  linkedProviderUnsubscribe = null;
  linkedBranchProvider = provider;
  if (!provider) return () => void 0;
  let active = true;
  linkedProviderUnsubscribe = provider.onBranchChange(() => {
    renderDiagnosticsCounters.noteBranchChange();
  });
  return () => {
    if (!active) return;
    active = false;
    if (linkedBranchProvider !== provider) return;
    linkedProviderUnsubscribe?.();
    linkedProviderUnsubscribe = null;
    linkedBranchProvider = null;
  };
}
function getGitBranch(ctx) {
  if (linkedBranchProvider) return linkedBranchProvider.getGitBranch();
  const entry = entryFor(ctx);
  if (entry.branch === void 0) {
    renderDiagnosticsCounters.noteBranchCacheMiss();
    return null;
  }
  renderDiagnosticsCounters.noteBranchCacheHit();
  return entry.branch;
}
async function resolveBranchAsync(cwd, runGit) {
  try {
    const out = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
    return out.trim() || null;
  } catch {
    try {
      const out = await runGit(["rev-parse", "--short", "HEAD"], cwd);
      const detached = out.trim();
      return detached ? "detached" : null;
    } catch {
      return null;
    }
  }
}
function refreshGitBranchAsync(ctx, runGit = defaultAsyncGitRunner) {
  const entry = entryFor(ctx);
  if (entry.asyncRefreshInFlight) return Promise.resolve(entry.branch ?? null);
  entry.asyncRefreshInFlight = true;
  return resolveBranchAsync(ctx.cwd, runGit).then((result) => {
    entry.branch = result;
    return result;
  }).finally(() => {
    entry.asyncRefreshInFlight = false;
  });
}
function defaultAsyncGitRunner(args, cwd) {
  return new Promise((resolve10, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve10(stdout);
    });
  });
}
function installSessionCache(pi) {
  const drop = (_event, ctx) => {
    invalidateSessionUsage(ctx);
  };
  pi.on("session_start", (_event, ctx) => {
    liveSessionHasMessages = false;
    invalidateSessionUsage(ctx);
    void refreshGitBranchAsync(ctx).catch(() => void 0);
  });
  pi.on("message_start", () => {
    noteSessionMessage();
  });
  pi.on("message_end", drop);
  pi.on("agent_end", (_event, ctx) => {
    invalidateSessionUsage(ctx);
    void refreshGitBranchAsync(ctx).catch(() => void 0);
  });
  pi.on("tool_result", drop);
  pi.on("session_compact", drop);
}

// src/themes/types.ts
var DEFAULT_CHROME = {
  frame: { topLeft: "\u256D", topRight: "\u256E", bottomLeft: "\u2570", bottomRight: "\u256F", horizontal: "\u2500", vertical: "\u2502" },
  sectionGlyphs: {},
  sectionTracked: true,
  ruleChar: "\u2501",
  tabActive: "\u25C6",
  tabInactive: "\u25A2",
  bullet: "\u2767"
};

// src/themes/amber-crt.ts
var AMBER_CRT_INDICATOR_FRAMES = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];
var AMBER_CRT_INDICATOR_INTERVAL_MS = 90;
var AMBER_CRT_THEME = {
  name: "amber-crt",
  displayName: "Amber CRT",
  description: "Mission Control mirror: warm-brown CRT chassis, amber P3 phosphor text, scanline indicator.",
  tokens: {
    colors: {
      background: "#0A0806",
      // warm dark brown-black CRT chassis
      surface: "#14100A",
      // top bar / status footer chassis trim
      surfaceRecess: "#070504",
      // input prompt void / depressed surface
      surfaceLifted: "#1F180F",
      // sidebar / lifted panels — caramel chassis
      foreground: "#FFB000",
      // P3 amber phosphor — classic CRT body text
      foregroundDim: "#CC8C00",
      // softer phosphor for muted text
      divider: "#4D3500",
      // burnt-amber line work, carved chassis edge
      accent: "#FFD700",
      // bright amber-gold — focus / titles
      states: {
        idle: "#00FF66",
        // P1 green phosphor — ready
        thinking: "#F0F0F0",
        // white phosphor — electric cogitation
        tool: "#00E5FF",
        // cyan phosphor — tooling
        approval: "#FF5500",
        // CRT-orange-red phosphor — danger
        learning: "#FF66FF"
        // magenta phosphor — sacred memory writes
      }
    }
  },
  workingIndicator: {
    frames: AMBER_CRT_INDICATOR_FRAMES,
    intervalMs: AMBER_CRT_INDICATOR_INTERVAL_MS
  },
  chrome: {
    // CRT chassis aesthetic. The chat-message frame, modal frame, and sidebar
    // dividers all read from `chrome.*`, so changing these glyphs gives Amber
    // CRT a visibly different identity from Cathedral (rounded `╭╮╰╯`) and
    // Obsidian (square `┌┐└┘` + Egyptian section glyphs).
    ...DEFAULT_CHROME,
    // Double-line box drawing reads straight from DOS / VGA serial terminal
    // chrome and pairs naturally with the `═` rule char that the Stitch ref
    // uses for its `════ TITLE ════` banner headers.
    frame: { topLeft: "\u2554", topRight: "\u2557", bottomLeft: "\u255A", bottomRight: "\u255D", horizontal: "\u2550", vertical: "\u2551" },
    // Stitch ref renders banner-style section titles without prefix glyphs;
    // the double-line rule above each section is the visual marker.
    sectionGlyphs: {},
    sectionTracked: false,
    // compact "CONTEXT" reads denser like htop
    ruleChar: "\u2550",
    // double-line horizontal rule for chassis dividers
    // Filled / hollow status circles match the Stitch `║ ● work-... ║` tab
    // affordance and read as live LED indicators.
    tabActive: "\u25CF",
    tabInactive: "\u25CB",
    // Stitch ref keeps the fleur-de-lis memory bullet from Cathedral; the
    // shared glyph reinforces "SumoCode" identity across themes while the
    // override colour pulls it into the CRT palette.
    bullet: "\u2767",
    bulletColor: "#FFD700"
    // amber-gold bullets stand out against the chassis
  }
};

// src/themes/cathedral.ts
var CATHEDRAL_INDICATOR_FRAMES = ["\u25CC", "\u2726", "\u2756", "\u273A", "\u274B", "\u2749"];
var CATHEDRAL_INDICATOR_INTERVAL_MS = 150;
var CATHEDRAL_THEME = {
  name: "cathedral",
  displayName: "Cathedral",
  description: "19th-century scriptorium: warm walnut, parchment foreground, burnt-orange accents.",
  tokens: {
    colors: {
      background: "#1A1511",
      surface: "#241D17",
      surfaceRecess: "#120D0A",
      surfaceLifted: "#3D3024",
      foreground: "#F5E6C8",
      foregroundDim: "#8B7A63",
      divider: "#5A4D3C",
      accent: "#D97706",
      states: {
        idle: "#7FB069",
        thinking: "#E8B339",
        tool: "#5B9BD5",
        approval: "#C1443E",
        learning: "#8E7AB5"
      }
    }
  },
  workingIndicator: {
    frames: CATHEDRAL_INDICATOR_FRAMES,
    intervalMs: CATHEDRAL_INDICATOR_INTERVAL_MS
  },
  chrome: { ...DEFAULT_CHROME }
};

// src/themes/herdr.ts
var HERDR_INDICATOR_FRAMES = [".", ":", "+", "*", "#", "%", "@", ">"];
var HERDR_INDICATOR_INTERVAL_MS = 110;
var HERDR_THEME = {
  name: "herdr",
  displayName: "Herdr Terminal",
  description: "Electric-green operator terminal \u2014 phosphor focus, amber execution, sharp hacker chrome.",
  tokens: {
    colors: {
      background: "#040704",
      // approved Ghostty chassis / OSC 11 value
      surface: "#070C08",
      // calm green-black content/sidebar plane
      surfaceRecess: "#050905",
      // input/editor well
      surfaceLifted: "#0F3D17",
      // approved active/selected surface
      foreground: "#39FF14",
      // approved electric-green body foreground
      foregroundDim: "#29B938",
      // text-safe derivative of host-muted #1FA82F
      divider: "#176B22",
      // decorative structure; never sole carrier of text/state
      accent: "#39FF14",
      // active frame, focus, cursor and routing
      states: {
        idle: "#29B938",
        // ready/healthy, quieter than active focus
        thinking: "#39FF14",
        // active reasoning/routing
        tool: "#FFB000",
        // tool execution and warning
        approval: "#FF706D",
        // text-safe derivative of host error #FF625F
        learning: "#FFD166"
        // durable write / learned state / bright amber
      }
    }
  },
  workingIndicator: {
    frames: HERDR_INDICATOR_FRAMES,
    intervalMs: HERDR_INDICATOR_INTERVAL_MS
  },
  chrome: {
    ...DEFAULT_CHROME,
    // Sharp 90-degree box chrome and single-cell ASCII sigils — terminal
    // identity without changing layout measurements or double-width risk.
    frame: { topLeft: "\u250C", topRight: "\u2510", bottomLeft: "\u2514", bottomRight: "\u2518", horizontal: "\u2500", vertical: "\u2502" },
    sectionGlyphs: { context: ">", memory: "#", mcp: "@", session: "$", registry: "%" },
    sectionTracked: false,
    ruleChar: "\u2500",
    tabActive: "\u25B8",
    tabInactive: "\xB7",
    bullet: ">"
  }
};

// src/themes/obsidian.ts
var OBSIDIAN_INDICATOR_FRAMES = ["\u25AB", "\u25C7", "\u25C8", "\u25C9", "\u229B", "\u229A"];
var OBSIDIAN_INDICATOR_INTERVAL_MS = 180;
var OBSIDIAN_THEME = {
  name: "obsidian",
  displayName: "Obsidian",
  description: "Sacred-tech: deep obsidian altar, bronze body, electrum gold, lapis cyan, sacred magenta accents.",
  tokens: {
    colors: {
      background: "#050308",
      // deep obsidian, near-black with violet undertone
      surface: "#0E0917",
      // polished granite — subtle violet, stone not glass
      surfaceRecess: "#020104",
      // input prompt void
      surfaceLifted: "#160C22",
      // sidebar / lifted panels — muted violet stone, distinct from `background`
      foreground: "#D4B896",
      // aged papyrus / warm bronze
      foregroundDim: "#8B7355",
      // oxidized bronze
      divider: "#2A1F40",
      // deep violet-purple, carved stone border
      accent: "#F0B400",
      // electrum gold — warm, not bright yellow
      states: {
        idle: "#00C896",
        // malachite life / sacred green
        thinking: "#00E5FF",
        // neon cyan — thinking ignition
        tool: "#F0B400",
        // electrum gold — tool action
        approval: "#B91C1C",
        // carnelian / burial red
        learning: "#FF00AA"
        // neon magenta — sacred memory writes
      }
    }
  },
  workingIndicator: {
    frames: OBSIDIAN_INDICATOR_FRAMES,
    intervalMs: OBSIDIAN_INDICATOR_INTERVAL_MS
  },
  chrome: {
    ...DEFAULT_CHROME,
    frame: { topLeft: "\u250C", topRight: "\u2510", bottomLeft: "\u2514", bottomRight: "\u2518", horizontal: "\u2500", vertical: "\u2502" },
    sectionGlyphs: { context: "\u{13080}", memory: "\u{133DB}", mcp: "\u269B", session: "\u{1329D}", registry: "\u{132F9}" },
    sectionTracked: false,
    ruleChar: "\u2500",
    tabActive: "\u25C6",
    tabInactive: "\u25C7",
    bullet: "\u2767",
    bulletColor: "#FF00AA"
  }
};

// src/themes/ultraviolet-core.ts
var ULTRAVIOLET_CORE_INDICATOR_FRAMES = [".", ":", "o", "O", "@", "O", "o", ":"];
var ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS = 120;
var ULTRAVIOLET_RUNCAT_FRAMES = ["\uE900", "\uE901", "\uE902", "\uE903", "\uE904"];
var ULTRAVIOLET_RUNCAT_INTERVAL_MS = 167;
var ULTRAVIOLET_RUNCAT_CAPABILITY_ENV = "SUMOCODE_RUNCAT_FONT";
var ULTRAVIOLET_CORE_THEME = {
  name: "ultraviolet-core",
  displayName: "Ultraviolet Core",
  description: "Ultraviolet command layer \u2014 violet focus, ice signal, deep spatial surfaces.",
  tokens: {
    colors: {
      background: "#06050B",
      surface: "#0D0917",
      surfaceRecess: "#0A0711",
      surfaceLifted: "#1B102E",
      foreground: "#DCC7FF",
      foregroundDim: "#9B7BBE",
      divider: "#56347A",
      accent: "#B974FF",
      states: {
        idle: "#DCC7FF",
        thinking: "#B974FF",
        tool: "#FFC857",
        approval: "#FF668F",
        learning: "#75E8FF"
      }
    }
  },
  workingIndicator: {
    frames: ULTRAVIOLET_CORE_INDICATOR_FRAMES,
    intervalMs: ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS,
    enhanced: {
      name: "runcat",
      frames: ULTRAVIOLET_RUNCAT_FRAMES,
      intervalMs: ULTRAVIOLET_RUNCAT_INTERVAL_MS,
      capabilityEnv: ULTRAVIOLET_RUNCAT_CAPABILITY_ENV,
      // The icomoon cat overdraws its cell; one space visually vanishes
      // (observed live in Ghostty: cat glued to "Working…").
      labelGapCells: 2
    }
  },
  chrome: {
    ...DEFAULT_CHROME,
    frame: { topLeft: "\u256D", topRight: "\u256E", bottomLeft: "\u2570", bottomRight: "\u256F", horizontal: "\u2500", vertical: "\u2502" },
    sectionGlyphs: { context: ">", memory: "+", mcp: "*", session: "~", registry: "#" },
    sectionTracked: false,
    ruleChar: "\u2500",
    tabActive: ">",
    tabInactive: ".",
    bullet: ">"
  },
  applicationRoles: {
    toolLedger: {
      // In-family with the violet palette (mirrors the `code` roles below
      // and how every other theme colors its tool ledger). The prior
      // gold/brown values were authored out-of-palette and clashed with
      // the theme's violet chat frames.
      surface: "#100A1D",
      border: "#56347A",
      label: "#B974FF",
      target: "#DCC7FF",
      body: "#DCC7FF",
      bodyMuted: "#9B7BBE"
    },
    code: {
      surface: "#100A1D",
      border: "#56347A",
      foreground: "#DCC7FF",
      gutter: "#9B7BBE",
      comment: "#9B7BBE",
      keyword: "#B974FF",
      string: "#75E8FF",
      number: "#FFC857",
      function: "#75E8FF"
    }
  }
};

// src/themes/registry.ts
var REGISTRY_KEY = /* @__PURE__ */ Symbol.for("sumocode.themeRegistry");
function ensureState() {
  const host = globalThis;
  let state = host[REGISTRY_KEY];
  if (!state) {
    state = {
      registry: /* @__PURE__ */ new Map([
        [CATHEDRAL_THEME.name, CATHEDRAL_THEME],
        [AMBER_CRT_THEME.name, AMBER_CRT_THEME],
        [OBSIDIAN_THEME.name, OBSIDIAN_THEME],
        [HERDR_THEME.name, HERDR_THEME],
        [ULTRAVIOLET_CORE_THEME.name, ULTRAVIOLET_CORE_THEME]
      ]),
      listeners: /* @__PURE__ */ new Set(),
      activeThemeName: CATHEDRAL_THEME.name,
      themeVersion: 0
    };
    host[REGISTRY_KEY] = state;
    return state;
  }
  if (!state.registry.has(CATHEDRAL_THEME.name)) state.registry.set(CATHEDRAL_THEME.name, CATHEDRAL_THEME);
  if (!state.registry.has(AMBER_CRT_THEME.name)) state.registry.set(AMBER_CRT_THEME.name, AMBER_CRT_THEME);
  if (!state.registry.has(OBSIDIAN_THEME.name)) state.registry.set(OBSIDIAN_THEME.name, OBSIDIAN_THEME);
  if (!state.registry.has(HERDR_THEME.name)) state.registry.set(HERDR_THEME.name, HERDR_THEME);
  if (!state.registry.has(ULTRAVIOLET_CORE_THEME.name)) state.registry.set(ULTRAVIOLET_CORE_THEME.name, ULTRAVIOLET_CORE_THEME);
  return state;
}
function normalizeThemeName(name) {
  return name.trim().toLowerCase();
}
function listThemes() {
  return [...ensureState().registry.values()];
}
function getTheme(name) {
  return ensureState().registry.get(normalizeThemeName(name));
}
function getActiveTheme() {
  const state = ensureState();
  return state.registry.get(state.activeThemeName) ?? CATHEDRAL_THEME;
}
function activeThemeColors() {
  return getActiveTheme().tokens.colors;
}
function activeThemeChrome() {
  return getActiveTheme().chrome;
}
function setActiveTheme(name) {
  const state = ensureState();
  const theme = state.registry.get(normalizeThemeName(name));
  if (!theme) return { success: false, error: `Unknown SumoCode theme: ${name}` };
  state.activeThemeName = theme.name;
  state.themeVersion += 1;
  for (const listener of state.listeners) listener(theme);
  return { success: true, theme };
}
function nextThemeName(currentName = getActiveTheme().name) {
  const names = listThemes().map((theme) => theme.name);
  if (names.length === 0) return currentName;
  const currentIndex = names.indexOf(currentName);
  const nextIndex2 = currentIndex === -1 ? 0 : (currentIndex + 1) % names.length;
  return names[nextIndex2];
}
function onThemeChanged(listener) {
  const state = ensureState();
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

// src/themes/indicator.ts
var TRUE_LIKE = /* @__PURE__ */ new Set(["1", "true", "yes", "on"]);
var FALSE_LIKE = /* @__PURE__ */ new Set(["", "0", "false", "no", "off"]);
function resolveThemeWorkingIndicator(theme = getActiveTheme(), env = process.env) {
  const base = theme.workingIndicator;
  const enhanced = base.enhanced;
  if (!enhanced) {
    return {
      name: "default",
      frames: base.frames,
      intervalMs: base.intervalMs,
      capabilityState: "disabled",
      labelGapCells: 1
    };
  }
  const raw = env[enhanced.capabilityEnv];
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (TRUE_LIKE.has(normalized)) {
    return {
      name: enhanced.name,
      frames: enhanced.frames,
      intervalMs: enhanced.intervalMs,
      capabilityEnv: enhanced.capabilityEnv,
      capabilityState: "enabled",
      labelGapCells: Math.max(1, enhanced.labelGapCells ?? 1)
    };
  }
  return {
    name: "default",
    frames: base.frames,
    intervalMs: base.intervalMs,
    capabilityEnv: enhanced.capabilityEnv,
    capabilityState: FALSE_LIKE.has(normalized) ? "disabled" : "unrecognized",
    labelGapCells: 1
  };
}

// src/config/sumocode-config.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
var DEFAULT_SUMOCODE_CONFIG = {
  primaryAgentName: "SUMO"
};
function resolveGlobalSumoCodeConfigPath(homeDir = homedir(), env = process.env) {
  const piAgentDir = env.PI_CODING_AGENT_DIR;
  if (piAgentDir) return join(resolve(piAgentDir), "sumocode.json");
  return join(resolve(homeDir), ".pi", "agent", "sumocode.json");
}
function resolveSumoCodeConfigCandidates(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const homeDir = resolve(options.homeDir ?? homedir());
  const env = options.env ?? process.env;
  return [
    { kind: "project", path: join(cwd, ".sumocode.json") },
    { kind: "project-pi", path: join(cwd, ".pi", "sumocode.json") },
    { kind: "global", path: resolveGlobalSumoCodeConfigPath(homeDir, env) }
  ];
}
function loadSumoCodeConfig(options = {}) {
  const readFile = options.readFile ?? readConfigFile;
  let merged;
  let source = "defaults";
  let path2;
  for (const candidate of resolveSumoCodeConfigCandidates(options)) {
    let raw;
    try {
      raw = readFile(candidate.path);
    } catch {
      continue;
    }
    if (raw === void 0) continue;
    const config2 = parseSumoCodeConfig(raw);
    if (!config2) continue;
    merged = mergeMissingSumoCodeConfig(merged, config2);
    if (source === "defaults") {
      source = candidate.kind;
      path2 = candidate.path;
    }
  }
  if (!merged) return { config: DEFAULT_SUMOCODE_CONFIG, source: "defaults" };
  const config = finalizeSumoCodeConfig(merged);
  return path2 === void 0 ? { config, source } : { config, source, path: path2 };
}
function saveSumoCodeConfigPatch(patch, options = {}) {
  const path2 = resolveGlobalSumoCodeConfigPath(options.homeDir, options.env);
  const readFile = options.readFile ?? readConfigFile;
  const writeFile = options.writeFile ?? writeConfigFileAtomic;
  let existing = {};
  let raw;
  try {
    raw = readFile(path2);
  } catch (error) {
    return { success: false, path: path2, error: error instanceof Error ? error.message : String(error) };
  }
  if (raw !== void 0) {
    try {
      const parsed = JSON.parse(raw);
      if (!isObjectValue(parsed) || parsed === null || Array.isArray(parsed)) return { success: false, path: path2, error: "Existing SumoCode config is not a JSON object" };
      existing = parsed;
    } catch (error) {
      return { success: false, path: path2, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const next = { ...existing };
  if (patch.primaryAgentName !== void 0) next.primaryAgentName = patch.primaryAgentName;
  if (patch.themeName !== void 0) next.themeName = patch.themeName;
  try {
    writeFile(path2, `${JSON.stringify(next, null, "	")}
`);
    return { success: true, path: path2 };
  } catch (error) {
    return { success: false, path: path2, error: error instanceof Error ? error.message : String(error) };
  }
}
function mergeMissingSumoCodeConfig(primary, fallback) {
  if (!primary) return fallback;
  return {
    primaryAgentName: primary.primaryAgentName ?? fallback.primaryAgentName,
    themeName: primary.themeName ?? fallback.themeName
  };
}
function finalizeSumoCodeConfig(config) {
  return {
    primaryAgentName: config.primaryAgentName ?? DEFAULT_SUMOCODE_CONFIG.primaryAgentName,
    ...config.themeName !== void 0 && { themeName: config.themeName }
  };
}
function readConfigFile(path2) {
  if (!existsSync(path2)) return void 0;
  return readFileSync(path2, "utf8");
}
function writeConfigFileAtomic(path2, content) {
  mkdirSync(dirname(path2), { recursive: true });
  const tmpPath = `${path2}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path2);
}
function isObjectValue(value) {
  return typeof value === "object";
}
function isString(value) {
  return typeof value === "string";
}
function parseSumoCodeConfig(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return void 0;
  }
  if (!isObjectValue(parsed) || parsed === null || Array.isArray(parsed)) return void 0;
  const record = parsed;
  if (record.primaryAgentName === void 0 && record.themeName === void 0) return void 0;
  if (record.primaryAgentName !== void 0 && (!isString(record.primaryAgentName) || record.primaryAgentName.trim().length === 0)) return void 0;
  const primaryAgentName = isString(record.primaryAgentName) ? record.primaryAgentName.trim() : void 0;
  const themeName = isString(record.themeName) && record.themeName.trim().length > 0 ? record.themeName.trim().toLowerCase() : void 0;
  return { ...primaryAgentName !== void 0 && { primaryAgentName }, ...themeName !== void 0 && { themeName } };
}

// src/themes/startup.ts
function resolveStartupThemeName(options = {}) {
  const configuredThemeName = loadSumoCodeConfig(options).config.themeName;
  return configuredThemeName && getTheme(configuredThemeName) ? configuredThemeName : "obsidian";
}
function applyStartupTheme(options = {}) {
  const themeName = resolveStartupThemeName(options);
  setActiveTheme(themeName);
  return themeName;
}

// src/voice.ts
var VOICE = {
  status: {
    idle: "READY",
    thinking: "MEDITATING",
    tool: "ILLUMINATING",
    approval: "DEFERRING",
    learning: "INSCRIBING"
  },
  sections: {
    context: "context",
    mcp: "mcp",
    memory: "memory"
  },
  errors: {
    daemonDown: "memory unavailable"
  },
  empty: {
    memory: "no memory match"
  }
};

// src/footer.ts
var SPLASH_VERSION_LINE = "SUMOCODE V0.4.1 \xB7 CATHEDRAL \xB7 160 \xD7 45 MONOSPACE";
var RESET = "\x1B[0m";
var SPLASH_VERSION_TOP_GAP_ROWS = 2;
var SPLASH_VERSION_BOTTOM_GAP_ROWS = 7;
var FOOTER_HORIZONTAL_PADDING = 1;
function colorHex(text, hex) {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `\x1B[38;2;${red};${green};${blue}m${text}${RESET}`;
}
function formatTokenCount(count) {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1e3) return Math.round(count).toString();
  if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1e3)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}
function formatCwd(cwd) {
  const home = homedir2();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
  return basename(cwd) || cwd;
}
function formatFooterLine(snapshot, width = 160) {
  const pad = width > FOOTER_HORIZONTAL_PADDING * 2 ? FOOTER_HORIZONTAL_PADDING : 0;
  const contentWidth = Math.max(0, width - pad * 2);
  const inner = formatFooterLineInner(snapshot, contentWidth);
  if (pad === 0) return inner;
  return `${" ".repeat(pad)}${padAnsiToWidth(inner, contentWidth)}${" ".repeat(pad)}`;
}
function padAnsiToWidth(line, width) {
  const visible = visibleWidth(line);
  if (visible >= width) return truncateToWidth(line, width);
  return `${line}${" ".repeat(width - visible)}`;
}
function formatFooterLineInner(snapshot, width) {
  const dot = colorHex("\u25CF", activeThemeColors().states[snapshot.state]);
  const stateLabel = colorHex(VOICE.status[snapshot.state], activeThemeColors().foreground);
  const model = colorHex(snapshot.modelId, activeThemeColors().foreground);
  const thinking2 = colorHex(snapshot.thinkingLevel, activeThemeColors().foreground);
  const sep2 = colorHex(" \xB7 ", activeThemeColors().foregroundDim);
  const leftParts = [`${dot} ${stateLabel}`, model, thinking2];
  if (snapshot.showFastMode) leftParts.push(colorHex("fast", activeThemeColors().foreground));
  const leftZone = leftParts.join(sep2);
  const leftLen = visibleWidth(leftZone);
  const contextTokens = snapshot.contextTokens ?? snapshot.inputTokens + snapshot.outputTokens;
  const contextWindow = snapshot.contextWindow ?? 0;
  const tokensText = contextWindow > 0 ? `${formatTokenCount(contextTokens)}/${formatTokenCount(contextWindow)}` : formatTokenCount(contextTokens);
  const tokens = colorHex(tokensText, activeThemeColors().foreground);
  const cost = colorHex(`$${snapshot.costUsd.toFixed(2)}`, activeThemeColors().foreground);
  const rightCandidates = [
    [tokens, cost],
    [tokens],
    []
  ];
  const MIN_GAP = 3;
  for (const candidate of rightCandidates) {
    const rightZone = candidate.join(sep2);
    const rightLen = visibleWidth(rightZone);
    const totalNeeded = leftLen + (rightLen > 0 ? MIN_GAP + rightLen : 0);
    if (totalNeeded <= width) {
      if (rightLen === 0) {
        return truncateToWidth(leftZone, width);
      }
      const gap = width - leftLen - rightLen;
      return `${leftZone}${" ".repeat(gap)}${rightZone}`;
    }
  }
  return truncateToWidth(leftZone, width);
}
function renderSplashVersionLine(width) {
  if (width <= 0 || SPLASH_VERSION_LINE.length > width) return "";
  const padLeft = Math.floor((width - SPLASH_VERSION_LINE.length) / 2);
  const padRight2 = width - SPLASH_VERSION_LINE.length - padLeft;
  const dim5 = colorHex(SPLASH_VERSION_LINE, activeThemeColors().foregroundDim);
  return `${" ".repeat(padLeft)}${dim5}${" ".repeat(padRight2)}`;
}
function renderFooterBlock(snapshot, width = 160) {
  if (!snapshot.isSplash) return [formatFooterLine(snapshot, width)];
  const version = renderSplashVersionLine(width);
  return [
    ...Array.from({ length: SPLASH_VERSION_TOP_GAP_ROWS }, () => ""),
    ...version === "" ? [] : [version],
    ...Array.from({ length: SPLASH_VERSION_BOTTOM_GAP_ROWS }, () => "")
  ];
}
function installFooter(pi, options = {}) {
  let state = "idle";
  let render;
  let activeCtx;
  let activeFooterData;
  const setState = (next) => {
    state = next;
    render?.();
  };
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    activeCtx = ctx;
    ctx.ui.setFooter((tui, _theme, footerData) => {
      activeFooterData = footerData;
      const componentRender = () => tui.requestRender();
      render = componentRender;
      const unsubscribe = footerData.onBranchChange(componentRender);
      const unlinkBranchProvider = linkGitBranchProvider(footerData);
      return {
        dispose() {
          unsubscribe();
          unlinkBranchProvider();
          if (render === componentRender) render = void 0;
          if (activeCtx === ctx) activeCtx = void 0;
          if (activeFooterData === footerData) activeFooterData = void 0;
        },
        invalidate() {
        },
        render(width) {
          const renderCtx = resolveRenderContext(activeCtx, ctx);
          const branchProvider = activeFooterData ?? footerData;
          const branch = safeRead(() => branchProvider.getGitBranch(), null);
          return renderFooterBlock(createSnapshot(pi, renderCtx, branch, state, options.fastModeState), width);
        }
      };
    });
  });
  pi.on("before_agent_start", () => setState("thinking"));
  pi.on("agent_start", () => setState("thinking"));
  pi.on("tool_call", () => setState("tool"));
  pi.on("tool_result", () => setState("thinking"));
  pi.on("agent_end", () => setState("idle"));
  pi.on("model_select", () => render?.());
  return () => render?.();
}
function resolveRenderContext(...candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!safeRead(() => {
      void candidate.cwd;
      return true;
    }, false)) continue;
    return candidate;
  }
  return void 0;
}
function createSnapshot(pi, ctx, branch, state, fastModeState) {
  if (!ctx) {
    return {
      cwd: "",
      branch,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      contextWindow: 0,
      costUsd: 0,
      state,
      modelId: "no-model",
      thinkingLevel: "medium",
      showFastMode: false,
      isSplash: false
    };
  }
  const usage = getSessionUsage2(ctx);
  const model = safeRead(() => ctx.model, void 0);
  return {
    cwd: safeRead(() => ctx.cwd, ""),
    branch,
    inputTokens: usage.input,
    outputTokens: usage.output,
    contextTokens: getContextTokens(ctx, usage),
    contextWindow: getContextWindow(ctx),
    costUsd: usage.cost,
    state,
    modelId: model?.id ?? "no-model",
    thinkingLevel: getThinkingLevel(pi, ctx),
    showFastMode: shouldShowFastModeInFooter(fastModeState, model),
    isSplash: !sessionHasMessages2(ctx)
  };
}
function shouldShowFastModeInFooter(fastModeState, model) {
  return shouldApplyFastMode(fastModeState ?? { enabled: false, models: [] }, model);
}
function safeRead(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}
function sessionHasMessages2(ctx) {
  try {
    return sessionHasMessages(ctx);
  } catch {
    return false;
  }
}
function getThinkingLevel(pi, ctx) {
  try {
    const piGetter = pi.getThinkingLevel;
    if (typeof piGetter === "function") return piGetter.call(pi);
  } catch {
  }
  try {
    const ctxGetter = ctx.getThinkingLevel;
    if (typeof ctxGetter === "function") return ctxGetter.call(ctx);
  } catch {
  }
  return safeRead(() => ctx.thinkingLevel, void 0) ?? "medium";
}
function getContextTokens(ctx, usage) {
  try {
    const contextUsage = ctx.getContextUsage?.();
    if (typeof contextUsage?.tokens === "number") return contextUsage.tokens;
  } catch {
  }
  return usage.input + usage.output;
}
function getContextWindow(ctx) {
  try {
    const contextUsage = ctx.getContextUsage?.();
    if (typeof contextUsage?.contextWindow === "number") return contextUsage.contextWindow;
  } catch {
  }
  return safeRead(() => ctx.model?.contextWindow, void 0) ?? 0;
}
function getSessionUsage2(ctx) {
  try {
    const cached = getSessionUsage(ctx);
    return { input: cached.input, output: cached.output, cost: cached.cost };
  } catch {
    return { input: 0, output: 0, cost: 0 };
  }
}

// src/cathedral/input-frame.ts
var RESET2 = "\x1B[0m";
var INPUT_FRAME_LABEL_SPLASH = "DIVINE INVOCATION";
var INPUT_FRAME_LABEL_ACTIVE = "";
var INPUT_FRAME_PLACEHOLDER = 'Ask anything... "Refactor the auth flow."';
var INPUT_FRAME_HINT_KEYBINDS = "CTRL+/ \xB7 COMMANDS";
function fg(hex) {
  const n = hex.replace("#", "");
  const r = Number.parseInt(n.slice(0, 2), 16);
  const g = Number.parseInt(n.slice(2, 4), 16);
  const b = Number.parseInt(n.slice(4, 6), 16);
  return `\x1B[38;2;${r};${g};${b}m`;
}
function color(text, hex) {
  return `${fg(hex)}${text}${RESET2}`;
}
function ellipsize(text, max) {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "\u2026";
  return `${text.slice(0, max - 1)}\u2026`;
}
function renderInputHints(width, options = {}) {
  if (width <= 0) return "";
  const rightPlain = INPUT_FRAME_HINT_KEYBINDS;
  const rightLen = rightPlain.length;
  const left = options.leftHint;
  const dimFg = fg(activeThemeColors().foregroundDim);
  const accent4 = fg(activeThemeColors().accent);
  const rightColored = `${accent4}CTRL+/${RESET2} ${dimFg}\xB7 COMMANDS${RESET2}`;
  const colorLeftHint = (text) => {
    if (options.leftHintStyle === "model-thinking") {
      const prefix = "\u2570\u2500 ";
      const separator = " \xB7 ";
      if (!text.startsWith(prefix)) return `${dimFg}${text}${RESET2}`;
      const rest = text.slice(prefix.length);
      const separatorIndex = rest.lastIndexOf(separator);
      if (separatorIndex === -1) return `${dimFg}${prefix}${RESET2}${color(rest, activeThemeColors().accent)}`;
      const model = rest.slice(0, separatorIndex);
      const thinking2 = rest.slice(separatorIndex + separator.length);
      return `${dimFg}${prefix}${RESET2}${color(model, activeThemeColors().accent)}${dimFg}${separator}${thinking2}${RESET2}`;
    }
    if (options.leftHintStyle !== "project-branch") return `${dimFg}${text}${RESET2}`;
    const branchStart = text.indexOf(" (");
    if (branchStart === -1) return color(text, activeThemeColors().foreground);
    const project = text.slice(0, branchStart);
    const branch = text.slice(branchStart);
    return `${color(project, activeThemeColors().foreground)}${dimFg}${branch}${RESET2}`;
  };
  const minGap = 4;
  const leftFitsAlongside = left !== void 0 && rightLen + minGap + left.length <= width;
  if (leftFitsAlongside) {
    const gap = width - rightLen - left.length;
    return `${colorLeftHint(left)}${" ".repeat(gap)}${rightColored}`;
  }
  if (left !== void 0 && options.leftHintOverflow === "truncate" && width > rightLen + minGap) {
    const maxLeft = width - rightLen - minGap;
    const truncatedLeft = ellipsize(left, maxLeft);
    if (truncatedLeft.length > 0) {
      const gap = width - rightLen - truncatedLeft.length;
      return `${colorLeftHint(truncatedLeft)}${" ".repeat(gap)}${rightColored}`;
    }
  }
  if (rightLen > width) {
    const truncated = rightPlain.slice(0, width);
    return `${dimFg}${truncated}${RESET2}`;
  }
  const padding = " ".repeat(width - rightLen);
  return `${padding}${rightColored}`;
}

// src/cathedral/input-hints.ts
var SPLASH_INPUT_FRAME_WIDTH = 60;
var ACTIVE_HINT_HORIZONTAL_PADDING = 1;
var ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
function centerAnsi(line, width) {
  const visible = visibleWidth2(line.replace(ANSI_PATTERN, ""));
  if (visible >= width) return line;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return `${" ".repeat(left)}${line}${" ".repeat(right)}`;
}
var InputHintsComponent = class {
  constructor(isSplash, splashLeftHint, activeLeftHint) {
    this.isSplash = isSplash;
    this.splashLeftHint = splashLeftHint;
    this.activeLeftHint = activeLeftHint;
  }
  isSplash;
  splashLeftHint;
  activeLeftHint;
  invalidate() {
  }
  render(width) {
    if (this.isSplash()) {
      const frameWidth = Math.min(width, SPLASH_INPUT_FRAME_WIDTH);
      return [centerAnsi(renderInputHints(frameWidth, { leftHint: this.splashLeftHint(), leftHintStyle: "model-thinking" }), width)];
    }
    const pad = width > ACTIVE_HINT_HORIZONTAL_PADDING * 2 ? ACTIVE_HINT_HORIZONTAL_PADDING : 0;
    const innerWidth = Math.max(0, width - pad * 2);
    const hint = renderInputHints(innerWidth, { leftHint: this.activeLeftHint(), leftHintOverflow: "truncate", leftHintStyle: "project-branch" });
    return [`${" ".repeat(pad)}${hint}${" ".repeat(pad)}`];
  }
};
function activeContextHint(ctx) {
  const cwd = ctx.cwd;
  if (!cwd) return void 0;
  const project = formatCwd(cwd);
  const branch = getGitBranch(ctx);
  return branch ? `${project} (${branch})` : project;
}
function latestThinkingLevel(ctx) {
  let latest;
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "thinking_level_change") {
        latest = entry.thinkingLevel;
      }
    }
  } catch {
    return void 0;
  }
  return latest;
}
function modelDisplayName(ctx) {
  return ctx.model?.id ?? "no model";
}
function splashInvocationHint(modelId, thinkingLevel) {
  return `\u2570\u2500 ${modelId} \xB7 ${thinkingLevel ?? "thinking"}`;
}
function sessionHasMessages3(ctx) {
  try {
    return sessionHasMessages(ctx);
  } catch {
    return false;
  }
}
function installInputHints(pi) {
  let requestRender;
  let currentModelId = "no model";
  let currentThinkingLevel;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentModelId = modelDisplayName(ctx);
    currentThinkingLevel = latestThinkingLevel(ctx);
    ctx.ui.setWidget(
      "sumocode-input-hints",
      (tui) => {
        requestRender = () => tui.requestRender();
        return new InputHintsComponent(
          () => !sessionHasMessages3(ctx),
          () => splashInvocationHint(currentModelId, currentThinkingLevel),
          () => activeContextHint(ctx)
        );
      },
      { placement: "belowEditor" }
    );
  });
  pi.on("model_select", (event) => {
    currentModelId = event.model.id;
    requestRender?.();
  });
  pi.on("thinking_level_select", (event) => {
    currentThinkingLevel = event.level;
    requestRender?.();
  });
}

// src/answer-tool.ts
import { complete } from "@earendil-works/pi-ai/compat";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey as matchesKey2, truncateToWidth as truncateToWidth3, visibleWidth as visibleWidth4, wrapTextWithAnsi as wrapTextWithAnsi2 } from "@earendil-works/pi-tui";

// src/divine-query.ts
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// src/cathedral/scriptorium-chrome.ts
import { truncateToWidth as truncateToWidth2, visibleWidth as visibleWidth3 } from "@earendil-works/pi-tui";
var RESET3 = "\x1B[0m";
var ANSI_PATTERN2 = /\u001b\[[0-9;]*m/g;
var TITLE_FLOWER = "\u273E";
var FOCUSED_MARK = "\u2748";
var UNFOCUSED_MARK = "\xB7";
function visibleLength(text) {
  return visibleWidth3(text.replace(ANSI_PATTERN2, ""));
}
function sgr(hex, mode) {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `\x1B[${mode};2;${red};${green};${blue}m`;
}
function fg2(text, hex) {
  return `${sgr(hex, 38)}${text}${RESET3}`;
}
function persistentBg(text, fgHex2, bgHex) {
  const style = `${sgr(fgHex2, 38)}${sgr(bgHex, 48)}`;
  return `${style}${text.replace(/\u001b\[0m/g, `${RESET3}${style}`)}${RESET3}`;
}
function fitLine(line, width) {
  if (width <= 0) return "";
  return visibleLength(line) > width ? truncateToWidth2(line, width, "\u2026") : line;
}
function padRight(line, width) {
  const fitted = fitLine(line, width);
  const length = visibleLength(fitted);
  if (length >= width) return fitted;
  return `${fitted}${" ".repeat(width - length)}`;
}
function center(line, width) {
  const fitted = fitLine(line, width);
  const length = visibleLength(fitted);
  if (length >= width) return fitted;
  const left = Math.floor((width - length) / 2);
  return `${" ".repeat(left)}${fitted}${" ".repeat(width - length - left)}`;
}
function splitRule(width) {
  const ruleLen = Math.max(1, Math.min(30, Math.floor((width - 5) / 2)));
  const div = activeThemeColors().divider;
  const piece = `${fg2("\u2500".repeat(ruleLen), div)}  ${fg2("\xB7", div)}  ${fg2("\u2500".repeat(ruleLen), div)}`;
  return center(piece, width);
}
function titleRow(text, width) {
  const accent4 = activeThemeColors().accent;
  return center(`${fg2(TITLE_FLOWER, accent4)}  ${fg2(text, accent4)}  ${fg2(TITLE_FLOWER, accent4)}`, width);
}
function focusMarker(focused) {
  const colors = activeThemeColors();
  return focused ? fg2(FOCUSED_MARK, colors.accent) : fg2(UNFOCUSED_MARK, colors.divider);
}
function wrapPanelRow(inner, width) {
  return persistentBg(
    padRight(inner, width),
    activeThemeColors().foreground,
    activeThemeColors().surfaceLifted
  );
}

// src/divine-query.ts
function wrapIndentedText(text, width, indent) {
  const contentWidth = Math.max(1, width - visibleLength(indent));
  const rows = [];
  for (const paragraph of text.split("\n")) {
    const wrapped = wrapTextWithAnsi(paragraph, contentWidth);
    rows.push(...(wrapped.length > 0 ? wrapped : [""]).map((line) => `${indent}${line}`));
  }
  return rows;
}
function optionLabel(index) {
  return `${String.fromCharCode(65 + index)}) `;
}
function buildInnerRows(snapshot, contentWidth, extras, compact) {
  const inner = [];
  const indent = "     ";
  const colors = activeThemeColors();
  inner.push("");
  inner.push(titleRow("DIVINE QUERY", contentWidth));
  inner.push("");
  inner.push(splitRule(contentWidth));
  inner.push("");
  for (const questionLine of wrapIndentedText(snapshot.title, Math.max(1, contentWidth - 7), indent)) {
    inner.push(fg2(questionLine, colors.foreground));
  }
  if (!compact) inner.push("");
  for (let i = 0; i < snapshot.options.length; i += 1) {
    const focused = i === snapshot.focusedIndex;
    const mark = focusMarker(focused);
    const optionIndent = `${indent}${mark}   `;
    const continuationIndent = `${indent}    `;
    const label = `${optionLabel(i)}${snapshot.options[i]}`;
    const wrappedOption = wrapIndentedText(label, contentWidth, continuationIndent);
    for (let optionRow = 0; optionRow < wrappedOption.length; optionRow += 1) {
      const raw = (wrappedOption[optionRow] ?? "").slice(continuationIndent.length);
      const prefix = optionRow === 0 ? optionIndent : continuationIndent;
      const text = focused ? fg2(raw, colors.foreground) : fg2(raw, colors.foregroundDim);
      inner.push(`${prefix}${text}`);
    }
  }
  if (!compact) {
    inner.push("");
    inner.push(splitRule(contentWidth));
    inner.push(center(fg2("\u2191\u2193 wander    \u23CE answer    \u238B retreat", colors.foregroundDim), contentWidth));
  }
  for (const extra of extras) inner.push(extra);
  inner.push("");
  return inner;
}
function renderDivineQuery(snapshot, width, options = {}) {
  if (width < 1) return [];
  const inner = buildInnerRows(snapshot, width, options.extras ?? [], options.compact === true);
  return inner.map((innerLine) => wrapPanelRow(innerLine, width));
}
function updateDivineQuery(snapshot, data) {
  const count = snapshot.options.length;
  if (count === 0) return { snapshot };
  const lower = data.toLowerCase();
  const letterIndex = lower.charCodeAt(0) - 97;
  if (lower.length === 1 && letterIndex >= 0 && letterIndex < count) {
    return { snapshot: { ...snapshot, focusedIndex: letterIndex }, done: letterIndex };
  }
  if (data === "down" || matchesKey(data, "down") || data === "tab" || matchesKey(data, "tab") || data === "j") {
    return { snapshot: { ...snapshot, focusedIndex: (snapshot.focusedIndex + 1) % count } };
  }
  if (data === "up" || matchesKey(data, "up") || data === "shift+tab" || matchesKey(data, "shift+tab") || data === "k") {
    return { snapshot: { ...snapshot, focusedIndex: (snapshot.focusedIndex - 1 + count) % count } };
  }
  if (data === "enter" || matchesKey(data, "enter") || data === "return" || matchesKey(data, "return")) {
    return { snapshot, done: snapshot.focusedIndex };
  }
  if (data === "escape" || matchesKey(data, "escape")) {
    return { snapshot, done: -1 };
  }
  return { snapshot };
}
var DivineQueryComponent = class {
  constructor(snapshot, done) {
    this.snapshot = snapshot;
    this.done = done;
  }
  snapshot;
  done;
  invalidate() {
  }
  handleInput(data) {
    const result = updateDivineQuery(this.snapshot, data);
    this.snapshot = result.snapshot;
    if (result.done !== void 0) this.done(result.done);
  }
  render(width) {
    return renderDivineQuery(this.snapshot, width);
  }
};
var DIVINE_QUERY_OVERLAY_OPTIONS = {
  anchor: "center",
  width: 80,
  minWidth: 56,
  maxHeight: "65%"
};
async function showDivineQuery(ctx, title, options) {
  if (ctx.mode === "rpc") {
    const selected = await ctx.ui.select(title, [...options]);
    return selected === void 0 ? void 0 : selected;
  }
  const initialSnapshot = {
    title,
    options,
    focusedIndex: 0
  };
  const selectedIndex = await ctx.ui.custom(
    (_tui, _theme, _kb, done) => new DivineQueryComponent(initialSnapshot, done),
    { overlay: true, overlayOptions: DIVINE_QUERY_OVERLAY_OPTIONS }
  );
  if (selectedIndex < 0 || selectedIndex >= options.length) return void 0;
  return options[selectedIndex];
}

// src/answer-tool.ts
var SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}`;
var HAIKU_MODEL_ID = "claude-haiku-4-5";
var GPT_FALLBACK_MODEL_ID = "gpt-5.4-mini";
async function selectExtractionModel(currentModel, modelRegistry) {
  const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
  if (haikuModel) {
    const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
    if (auth.ok) return haikuModel;
  }
  const gptFallback = modelRegistry.find("openai-codex", GPT_FALLBACK_MODEL_ID);
  if (gptFallback) {
    const auth = await modelRegistry.getApiKeyAndHeaders(gptFallback);
    if (auth.ok) return gptFallback;
  }
  return currentModel;
}
function parseExtractionResult(text) {
  try {
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    const parsed = JSON.parse(jsonStr);
    return parsed && Array.isArray(parsed.questions) ? parsed : null;
  } catch {
    return null;
  }
}
async function extractQuestionsFromText(text, extractionModel, modelRegistry, signal, completeFn = complete) {
  const auth = await modelRegistry.getApiKeyAndHeaders(extractionModel);
  if (!auth.ok) throw new Error(auth.error);
  const userMessage = {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now()
  };
  const response = await completeFn(
    extractionModel,
    { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal }
  );
  if (response.stopReason === "aborted") return null;
  const responseText = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return parseExtractionResult(responseText);
}
function buildQnAResult(questions, answers) {
  const entries = questions.map((q, i) => ({
    ...q,
    answer: answers[i]?.trim() || "(no answer)"
  }));
  const parts = [];
  for (const entry of entries) {
    parts.push(`Q: ${entry.question}`);
    if (entry.context) parts.push(`> ${entry.context}`);
    parts.push(`A: ${entry.answer}`);
    parts.push("");
  }
  return { entries, formatted: parts.join("\n").trim() };
}
async function runRpcQuestionnaire(ctx, questions) {
  const answers = [];
  for (const question of questions) {
    const title = question.context ? `${question.question}
${question.context}` : question.question;
    const answer = await ctx.ui.input(title, "type your answer");
    const trimmed = answer?.trim() ?? "";
    if (!trimmed) return null;
    answers.push(trimmed);
  }
  return buildQnAResult(questions, answers);
}
var RESET4 = "\x1B[0m";
function cathedralFg(text, hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1B[38;2;${r};${g};${b}m${text}${RESET4}`;
}
var accent = (s) => cathedralFg(s, activeThemeColors().accent);
var fg3 = (s) => cathedralFg(s, activeThemeColors().foreground);
var dim = (s) => cathedralFg(s, activeThemeColors().foregroundDim);
var divider = (s) => cathedralFg(s, activeThemeColors().divider);
var idle = (s) => cathedralFg(s, activeThemeColors().states.idle);
var thinking = (s) => cathedralFg(s, activeThemeColors().states.thinking);
var liftedBg = `\x1B[48;2;61;48;36m`;
var CathedralQnAComponent = class {
  questions;
  answers;
  currentIndex = 0;
  editor;
  tui;
  onDone;
  showingConfirmation = false;
  cachedLines;
  constructor(questions, tui, onDone) {
    this.questions = questions;
    this.answers = questions.map(() => "");
    this.tui = tui;
    this.onDone = onDone;
    const editorTheme = {
      borderColor: (s) => cathedralFg(s, activeThemeColors().accent),
      selectList: {
        selectedPrefix: (t) => cathedralFg(t, activeThemeColors().accent),
        selectedText: (t) => cathedralFg(t, activeThemeColors().accent),
        description: (t) => cathedralFg(t, activeThemeColors().foregroundDim),
        scrollInfo: (t) => cathedralFg(t, activeThemeColors().foregroundDim),
        noMatch: (t) => cathedralFg(t, activeThemeColors().states.approval)
      }
    };
    this.editor = new Editor(tui, editorTheme);
    this.editor.disableSubmit = true;
    this.editor.onChange = () => {
      this.invalidate();
      this.tui.requestRender();
    };
  }
  saveCurrentAnswer() {
    this.answers[this.currentIndex] = this.editor.getText();
  }
  navigateTo(index) {
    if (index < 0 || index >= this.questions.length) return;
    this.saveCurrentAnswer();
    this.currentIndex = index;
    this.editor.setText(this.answers[index] || "");
    this.invalidate();
  }
  submit() {
    this.saveCurrentAnswer();
    this.onDone(buildQnAResult(this.questions, this.answers));
  }
  invalidate() {
    this.cachedLines = void 0;
  }
  handleInput(data) {
    if (this.showingConfirmation) {
      if (matchesKey2(data, Key.enter) || data.toLowerCase() === "y") {
        this.submit();
        return;
      }
      if (matchesKey2(data, Key.escape) || data.toLowerCase() === "n") {
        this.showingConfirmation = false;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      return;
    }
    if (matchesKey2(data, Key.escape) || matchesKey2(data, Key.ctrl("c"))) {
      this.onDone(null);
      return;
    }
    if (matchesKey2(data, Key.tab)) {
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1);
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey2(data, Key.shift("tab"))) {
      if (this.currentIndex > 0) {
        this.navigateTo(this.currentIndex - 1);
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey2(data, Key.enter) && !matchesKey2(data, Key.shift("enter"))) {
      this.saveCurrentAnswer();
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1);
      } else {
        this.showingConfirmation = true;
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    this.editor.handleInput(data);
    this.invalidate();
    this.tui.requestRender();
  }
  render(width) {
    if (this.cachedLines) return this.cachedLines;
    const boxWidth = Math.min(width, 120);
    const contentWidth = boxWidth - 4;
    const horizontalLine = (count) => "\u2500".repeat(count);
    const boxLine = (content, leftPad = 2) => {
      const paddedContent = " ".repeat(leftPad) + content;
      const contentLen = visibleWidth4(paddedContent);
      const rightPad = Math.max(0, boxWidth - contentLen - 2);
      return `${liftedBg}${divider("\u2502")}${paddedContent}${" ".repeat(rightPad)}${divider("\u2502")}${RESET4}`;
    };
    const emptyBoxLine = () => `${liftedBg}${divider("\u2502")}${" ".repeat(boxWidth - 2)}${divider("\u2502")}${RESET4}`;
    const padToWidth4 = (line) => {
      const len = visibleWidth4(line);
      return line + " ".repeat(Math.max(0, width - len));
    };
    const lines = [];
    lines.push(padToWidth4(`${liftedBg}${divider("\u256D" + horizontalLine(boxWidth - 2) + "\u256E")}${RESET4}`));
    const title = `${accent("\u273E")}  ${accent("DIVINE QUERY")}  ${accent("\u273E")}  ${dim(`${this.currentIndex + 1}/${this.questions.length}`)}`;
    lines.push(padToWidth4(boxLine(title)));
    const ruleLen = Math.max(1, Math.floor((contentWidth - 6) / 2 - 5));
    const splitRule2 = `${divider("\u2500".repeat(ruleLen))}  ${divider("\xB7")}  ${divider("\u2500".repeat(ruleLen))}`;
    lines.push(padToWidth4(boxLine(splitRule2)));
    const progressParts = [];
    for (let i = 0; i < this.questions.length; i++) {
      const answered = (this.answers[i]?.trim() || "").length > 0;
      const current = i === this.currentIndex;
      if (current) progressParts.push(accent("\u2748"));
      else if (answered) progressParts.push(idle("\u2713"));
      else progressParts.push(divider("\xB7"));
    }
    lines.push(padToWidth4(boxLine(progressParts.join(" "))));
    lines.push(padToWidth4(emptyBoxLine()));
    const q = this.questions[this.currentIndex];
    const questionText = `${accent("Q:")} ${fg3(q.question)}`;
    for (const line of wrapTextWithAnsi2(questionText, contentWidth)) {
      lines.push(padToWidth4(boxLine(line)));
    }
    if (q.context) {
      lines.push(padToWidth4(emptyBoxLine()));
      for (const line of wrapTextWithAnsi2(dim(`> ${q.context}`), contentWidth - 2)) {
        lines.push(padToWidth4(boxLine(line)));
      }
    }
    lines.push(padToWidth4(emptyBoxLine()));
    const answerPrefix = accent("A: ");
    const editorWidth = contentWidth - 4 - 3;
    const editorLines = this.editor.render(editorWidth);
    for (let i = 1; i < editorLines.length - 1; i++) {
      const prefix = i === 1 ? answerPrefix : "   ";
      lines.push(padToWidth4(boxLine(prefix + editorLines[i])));
    }
    lines.push(padToWidth4(emptyBoxLine()));
    lines.push(padToWidth4(boxLine(splitRule2)));
    if (this.showingConfirmation) {
      const confirmMsg = `${thinking("Submit all answers?")} ${dim("(Enter/y to confirm, Esc/n to cancel)")}`;
      lines.push(padToWidth4(boxLine(truncateToWidth3(confirmMsg, contentWidth))));
    } else {
      const controls = dim("\u21C5 wander    \u23CE answer    \u21E7\u21E5 retreat    \u238B cancel");
      lines.push(padToWidth4(boxLine(truncateToWidth3(controls, contentWidth))));
    }
    lines.push(padToWidth4(`${liftedBg}${divider("\u2570" + horizontalLine(boxWidth - 2) + "\u256F")}${RESET4}`));
    this.cachedLines = lines;
    return lines;
  }
};
function installAnswerTool(pi, deps = {}) {
  const extractQuestions = deps.extractQuestionsFromText ?? extractQuestionsFromText;
  const runQuestionnaire = async (ctx, questions) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("questionnaire requires interactive mode", "error");
      return null;
    }
    if (ctx.mode === "rpc") return runRpcQuestionnaire(ctx, questions);
    return ctx.ui.custom(
      (tui, _theme, _kb, done) => new CathedralQnAComponent(questions, tui, done),
      { overlay: true, overlayOptions: DIVINE_QUERY_OVERLAY_OPTIONS }
    );
  };
  const answerHandler = async (ctx) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("answer requires interactive mode", "error");
      return;
    }
    if (!ctx.model) {
      ctx.ui.notify("No model selected", "error");
      return;
    }
    const branch = ctx.sessionManager.getBranch();
    let lastAssistantText;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message") {
        const msg = entry.message;
        if ("role" in msg && msg.role === "assistant") {
          if (msg.stopReason !== "stop") {
            ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
            return;
          }
          const textParts = msg.content.filter((c) => c.type === "text").map((c) => c.text);
          if (textParts.length > 0) {
            lastAssistantText = textParts.join("\n");
            break;
          }
        }
      }
    }
    if (!lastAssistantText) {
      ctx.ui.notify("No assistant messages found", "error");
      return;
    }
    const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);
    const extractionResult = ctx.mode === "rpc" ? await extractQuestions(lastAssistantText, extractionModel, ctx.modelRegistry, ctx.signal).catch(() => null) : await ctx.ui.custom((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
      loader.onAbort = () => done(null);
      extractQuestions(lastAssistantText, extractionModel, ctx.modelRegistry, loader.signal).then(done).catch(() => done(null));
      return loader;
    });
    if (!extractionResult) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    if (extractionResult.questions.length === 0) {
      ctx.ui.notify("No questions found in the last message", "info");
      return;
    }
    const answersResult = await runQuestionnaire(ctx, extractionResult.questions);
    if (!answersResult) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    pi.sendMessage(
      {
        customType: "answers",
        content: "I answered your questions in the following way:\n\n" + answersResult.formatted,
        display: true,
        details: { entries: answersResult.entries }
      },
      { triggerTurn: true }
    );
  };
  pi.registerCommand("answer", {
    description: "Extract questions from last assistant message into interactive Q&A",
    handler: (_args, ctx) => answerHandler(ctx)
  });
  pi.registerShortcut("ctrl+.", {
    description: "Extract and answer questions",
    handler: answerHandler
  });
}

// src/question-tool.ts
import { Editor as Editor2, Key as Key2, matchesKey as matchesKey3, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
var OptionParam = Type.Union([
  Type.String({ description: "Option label shown to the user" }),
  Type.Object({
    label: Type.String({ description: "Option label shown to the user" }),
    description: Type.Optional(Type.String({ description: "Optional helper text for the option" }))
  })
]);
var QuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  context: Type.Optional(Type.String({ description: "Optional context/help text shown under the question" })),
  options: Type.Optional(Type.Array(OptionParam, { description: "Options for the user to choose from. Do not prefix with A)/B)/1./2.; the UI adds labels automatically." })),
  questions: Type.Optional(
    Type.Array(
      Type.Object({
        question: Type.String({ description: "Question text to ask the user" }),
        context: Type.Optional(Type.String({ description: "Optional context/help text shown under the question" })),
        options: Type.Optional(Type.Array(OptionParam, { description: "Options for this question. Omit for free-text input." }))
      }),
      { minItems: 1, description: "Questions to ask, in order" }
    )
  )
});
var FREE_TEXT_LABEL = "Type something\u2026";
var isStringOption = (option) => typeof option === "string";
function normalizeQuestionOptions(options) {
  if (!options?.length) return [];
  return options.map((option) => {
    if (isStringOption(option)) {
      const label = option.trim();
      return { label, value: label };
    }
    const value = option.label.trim();
    const description = option.description?.trim();
    return { label: description ? `${value} \u2014 ${description}` : value, value };
  }).filter((option) => option.value.length > 0);
}
function dialogOptionsFor(options) {
  const normalized = normalizeQuestionOptions(options);
  return [
    ...normalized.map((option) => ({ ...option, isFreeText: false })),
    { label: FREE_TEXT_LABEL, value: "", isFreeText: true }
  ];
}
var FG_RESET = "\x1B[39m";
var RESET5 = "\x1B[0m";
var CATHEDRAL_FG = "\x1B[38;2;245;230;200m";
function withCathedralForeground(line) {
  const reCathedralized = line.replaceAll(RESET5, `${RESET5}${CATHEDRAL_FG}`).replaceAll(FG_RESET, `${FG_RESET}${CATHEDRAL_FG}`);
  return `${CATHEDRAL_FG}${reCathedralized}${FG_RESET}`;
}
async function showCathedralQuestion(ctx, title, options) {
  const freeTextOnly = options.length === 1 && options[0]?.isFreeText === true;
  return ctx.ui.custom(
    (tui, theme, _kb, done) => {
      let snapshot = { title, options: freeTextOnly ? [] : options.map((option) => option.label), focusedIndex: 0 };
      let editMode = freeTextOnly;
      let cachedLines;
      const editorTheme = {
        borderColor: (s) => theme.fg("accent", s),
        selectList: {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t)
        }
      };
      const editor = new Editor2(tui, editorTheme);
      editor.onSubmit = (value) => {
        const trimmed = value.trim();
        if (trimmed) {
          done({ answer: trimmed, wasCustom: true });
        } else if (freeTextOnly) {
          editor.setText("");
          refresh();
        } else {
          editMode = false;
          editor.setText("");
          refresh();
        }
      };
      function refresh() {
        cachedLines = void 0;
        tui.requestRender();
      }
      function handleInput(data) {
        if (editMode) {
          if (matchesKey3(data, Key2.escape)) {
            if (freeTextOnly) {
              done(null);
              return;
            }
            editMode = false;
            editor.setText("");
            refresh();
            return;
          }
          editor.handleInput(data);
          refresh();
          return;
        }
        const result = updateDivineQuery(snapshot, data);
        snapshot = result.snapshot;
        if (result.done !== void 0) {
          if (result.done === -1) {
            done(null);
            return;
          }
          const selected = options[result.done];
          if (selected?.isFreeText) {
            editMode = true;
            refresh();
            return;
          }
          done({ answer: selected?.value ?? "", wasCustom: false });
          return;
        }
        refresh();
      }
      function render(width) {
        if (cachedLines) return cachedLines;
        const extras = [];
        if (editMode) {
          const editorInnerWidth = Math.max(1, width - 6);
          extras.push(`     ${theme.fg("muted", "Your answer:")}`);
          for (const line of editor.render(editorInnerWidth)) {
            extras.push(`     ${withCathedralForeground(line)}`);
          }
          extras.push("");
          extras.push(`     ${theme.fg("dim", "Enter to submit \xB7 Esc to go back")}`);
        }
        const lines = renderDivineQuery(snapshot, width, { extras });
        cachedLines = lines;
        return lines;
      }
      return {
        render,
        invalidate: () => {
          cachedLines = void 0;
        },
        handleInput
      };
    },
    { overlay: true, overlayOptions: DIVINE_QUERY_OVERLAY_OPTIONS }
  );
}
async function showRpcQuestion(ctx, title, options) {
  const realOptions = options.filter((option) => !option.isFreeText);
  async function askForText() {
    const answer = await ctx.ui.input(title, "type your answer");
    const trimmed = answer?.trim() ?? "";
    if (!trimmed) return null;
    return { answer: trimmed, wasCustom: true };
  }
  if (realOptions.length === 0) return askForText();
  const selected = await ctx.ui.select(title, [
    ...realOptions.map((option) => option.label),
    FREE_TEXT_LABEL
  ]);
  if (selected === void 0) return null;
  const selectedOption = realOptions.find((option) => option.label === selected);
  if (selectedOption) return { answer: selectedOption.value, wasCustom: false };
  if (selected === FREE_TEXT_LABEL) return askForText();
  return null;
}
async function askQuestion(ctx, title, options) {
  if (ctx.mode === "rpc") return showRpcQuestion(ctx, title, options);
  return showCathedralQuestion(ctx, title, options);
}
function installQuestionTool(pi) {
  pi.registerTool({
    name: "question",
    label: "Question",
    description: "Ask the user a question and let them pick from options, or omit options for free-text input. Use when you need user input to proceed. Do NOT prefix options with A)/B)/1./2. \u2014 the Cathedral UI adds labels automatically.",
    parameters: QuestionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: UI not available" }],
          details: { cancelled: true, reason: "no_ui" }
        };
      }
      const questions = params.questions?.length ? params.questions : params.question ? [{ question: params.question, context: params.context, options: params.options }] : [];
      if (questions.length === 0) {
        return {
          content: [{ type: "text", text: "No questions provided." }],
          details: { cancelled: true, reason: "empty" }
        };
      }
      if (questions.length === 1) {
        const q = questions[0];
        const title = q.context ? `${q.question}
${q.context}` : q.question;
        const result = await askQuestion(ctx, title, dialogOptionsFor(q.options));
        if (!result) {
          return {
            content: [{ type: "text", text: "User cancelled." }],
            details: { cancelled: true }
          };
        }
        return {
          content: [{ type: "text", text: `User answered: ${result.answer}` }],
          details: { cancelled: false, answer: result.answer, wasCustom: result.wasCustom }
        };
      }
      const answers = [];
      for (const q of questions) {
        const title = q.context ? `${q.question}
${q.context}` : q.question;
        const result = await askQuestion(ctx, title, dialogOptionsFor(q.options));
        if (!result) {
          return {
            content: [{ type: "text", text: "User cancelled." }],
            details: { cancelled: true, answeredSoFar: answers }
          };
        }
        answers.push({ question: q.question, answer: result.answer });
      }
      const formatted = answers.map((a) => `Q: ${a.question}
A: ${a.answer}`).join("\n\n");
      return {
        content: [{ type: "text", text: `User answered:

${formatted}` }],
        details: { cancelled: false, entries: answers }
      };
    },
    renderCall(args, theme) {
      const q = args.question ?? (Array.isArray(args.questions) ? args.questions[0]?.question : "");
      return new Text(theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", q), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details;
      if (!details || details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const answer = details.answer ?? details.entries?.map((e) => e.answer).join(", ") ?? "";
      return new Text(theme.fg("success", "\u2713 ") + theme.fg("accent", answer), 0, 0);
    }
  });
}

// src/native-task-tool.ts
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getAgentDir,
  loadSkills,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
import { Text as Text2 } from "@earendil-works/pi-tui";
import { Type as Type2 } from "typebox";

// src/native-task-params.ts
var MAX_PARALLEL_TASKS = 8;
var VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
var VALID_THINKING_OPTIONS = ["inherit", ...VALID_THINKING_LEVELS];
var isRecord = (value) => {
  return value !== null && typeof value === "object";
};
var isTaskThinking = (value) => {
  return VALID_THINKING_OPTIONS.includes(value);
};
var parseProviderModel = (value) => {
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return { ok: false, error: `Invalid model format: "${value}". Expected provider/modelId.` };
  }
  const provider = trimmed.slice(0, slashIndex);
  const modelId = trimmed.slice(slashIndex + 1);
  return { ok: true, model: { provider, modelId, label: `${provider}/${modelId}` } };
};
var resolveModel = (modelOverride, ctxModel) => {
  if (modelOverride) {
    const parsed = parseProviderModel(modelOverride);
    if (!parsed.ok) return parsed;
    return { ok: true, model: parsed.model };
  }
  if (!ctxModel) return { ok: true, model: void 0 };
  return {
    ok: true,
    model: { provider: ctxModel.provider, modelId: ctxModel.id, label: `${ctxModel.provider}/${ctxModel.id}` }
  };
};
var normalizeModelInput = (value, label) => {
  if (value === void 0) return { ok: true, value: void 0 };
  if (typeof value !== "string") return { ok: false, error: `Invalid parameters: ${label} must be a string.` };
  const trimmed = value.trim();
  return { ok: true, value: trimmed ? trimmed : void 0 };
};
var normalizeThinkingInput = (value, label) => {
  if (value === void 0) return { ok: true, value: void 0 };
  if (typeof value !== "string") return { ok: false, error: `Invalid parameters: ${label} must be a string.` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: void 0 };
  if (!isTaskThinking(trimmed)) {
    return {
      ok: false,
      error: `Invalid parameters: ${label} must be one of ${VALID_THINKING_OPTIONS.join(", ")}.`
    };
  }
  return { ok: true, value: trimmed };
};
var normalizeForkInput = (value, label) => {
  if (value === void 0) return { ok: true, value: true };
  if (typeof value !== "boolean") return { ok: false, error: `Invalid parameters: ${label} must be a boolean.` };
  return { ok: true, value };
};
var parseTaskItems = (rawTasks) => {
  const items = [];
  for (const [index, taskEntry] of rawTasks.entries()) {
    if (!isRecord(taskEntry)) return { ok: false, error: "Invalid task item: expected an object." };
    const prompt = typeof taskEntry.prompt === "string" ? taskEntry.prompt.trim() : "";
    const skill = typeof taskEntry.skill === "string" ? taskEntry.skill.trim() : void 0;
    if (!prompt && !skill) {
      return { ok: false, error: 'Invalid task item: provide a non-empty "prompt" or "skill".' };
    }
    const modelResult = normalizeModelInput(taskEntry.model, `"tasks[${index}].model"`);
    if (!modelResult.ok) return modelResult;
    const thinkingResult = normalizeThinkingInput(taskEntry.thinking, `"tasks[${index}].thinking"`);
    if (!thinkingResult.ok) return thinkingResult;
    const forkResult = normalizeForkInput(taskEntry.fork, `"tasks[${index}].fork"`);
    if (!forkResult.ok) return forkResult;
    items.push({
      prompt,
      skill,
      model: modelResult.value,
      thinking: thinkingResult.value,
      fork: forkResult.value
    });
  }
  return { ok: true, items };
};
var normalizeTaskParams = (params, options = { maxParallelTasks: MAX_PARALLEL_TASKS }) => {
  if (!isRecord(params)) return { ok: false, error: "Invalid parameters: expected an object." };
  const mode = params.type;
  if (typeof mode !== "string") return { ok: false, error: 'Invalid parameters: "type" must be a string.' };
  const modelResult = normalizeModelInput(params.model, '"model"');
  if (!modelResult.ok) return modelResult;
  const model = modelResult.value;
  const thinkingResult = normalizeThinkingInput(params.thinking, '"thinking"');
  if (!thinkingResult.ok) return thinkingResult;
  const thinking2 = thinkingResult.value ?? "inherit";
  const rawTasks = Array.isArray(params.tasks) ? params.tasks : [];
  if (mode === "single") {
    if (rawTasks.length !== 1) {
      return { ok: false, error: 'Invalid parameters: type="single" requires exactly one task in "tasks".' };
    }
    const parsed = parseTaskItems(rawTasks);
    if (!parsed.ok) return parsed;
    return { ok: true, value: { mode: "single", model, thinking: thinking2, items: [parsed.items[0]] } };
  }
  if (mode === "parallel") {
    if (rawTasks.length === 0) {
      return { ok: false, error: 'Invalid parameters: type="parallel" requires a non-empty "tasks" array.' };
    }
    if (rawTasks.length > options.maxParallelTasks) {
      return {
        ok: false,
        error: `Too many parallel tasks (${rawTasks.length}). Max is ${options.maxParallelTasks}.`
      };
    }
    const parsed = parseTaskItems(rawTasks);
    if (!parsed.ok) return parsed;
    return { ok: true, value: { mode: "parallel", model, thinking: thinking2, items: parsed.items } };
  }
  if (mode === "chain") {
    if (rawTasks.length === 0) {
      return { ok: false, error: 'Invalid parameters: type="chain" requires a non-empty "tasks" array.' };
    }
    if (rawTasks.length > options.maxParallelTasks) {
      return {
        ok: false,
        error: `Too many chain tasks (${rawTasks.length}). Max is ${options.maxParallelTasks}.`
      };
    }
    const parsed = parseTaskItems(rawTasks);
    if (!parsed.ok) return parsed;
    return { ok: true, value: { mode: "chain", model, thinking: thinking2, items: parsed.items } };
  }
  return { ok: false, error: 'Invalid parameters: "type" must be "single", "chain", or "parallel".' };
};

// src/native-task-config.ts
var BUILT_IN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
var isBuiltInToolName = (toolName) => {
  return BUILT_IN_TOOLS.includes(toolName);
};
var getBuiltInToolsFromActiveTools = (activeTools) => {
  return activeTools.filter(isBuiltInToolName);
};
var resolveThinkingLevel = (thinking2, inherited) => {
  return thinking2 === "inherit" ? inherited : thinking2;
};
var buildSubprocessArgs = (options) => {
  const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
  if (options.model) {
    args.push("--provider", options.model.provider);
    args.push("--model", options.model.modelId);
  }
  args.push("--thinking", options.thinkingLevel);
  if (options.builtInTools.length === 0) {
    args.push("--no-tools");
  } else {
    args.push("--tools", options.builtInTools.join(","));
  }
  return args;
};
var resolveTaskConfig = (options) => {
  const modelOverride = options.item.model ?? options.defaultModel;
  const modelResolution = resolveModel(modelOverride, options.ctxModel);
  if (!modelResolution.ok) return modelResolution;
  const thinking2 = resolveThinkingLevel(options.item.thinking ?? options.defaultThinking, options.inheritedThinking);
  const subprocessArgs = buildSubprocessArgs({
    model: modelResolution.model,
    thinkingLevel: thinking2,
    builtInTools: options.builtInTools
  });
  return { ok: true, thinkingLevel: thinking2, subprocessArgs, modelLabel: modelResolution.model?.label };
};

// src/native-task-tool.ts
var DEFAULT_OPTIONS = {
  name: "task",
  label: "Task",
  description: [
    "Run isolated pi subprocess tasks (single, chain, or parallel).",
    "Supports optional skill wrapper (matches /skill: behavior) and optional model override (provider/modelId)."
  ].join(" "),
  maxParallelTasks: MAX_PARALLEL_TASKS,
  maxConcurrency: 4,
  collapsedItemCount: 10,
  skillListLimit: 30,
  systemPromptPatches: [
    {
      match: /\n\s*\n\s*in addition to the tools above, you may have access to other custom tools depending on the project\./i,
      replace: "\n- task: Run isolated pi subprocess tasks (single, chain, or parallel)."
    },
    {
      match: /Use the read tool to load a skill's file when the task matches its description\./i,
      replace: "Use skill directly: Use the read tool to load a skill's file when the task matches its description. Use skill in task: Pass the skill to the task tool and the task context will load it."
    }
  ]
};
var loadSkillDiscovery = (cwd) => {
  const settingsManager = SettingsManager.create(cwd);
  const agentDir = getAgentDir();
  const skillPaths = settingsManager.getSkillPaths();
  return loadSkills({ cwd, agentDir, skillPaths, includeDefaults: true });
};
var applyPromptPatches = (prompt, patches) => {
  return patches.reduce((value, patch) => value.replace(patch.match, patch.replace), prompt);
};
var createForkSession = async (sessionFile) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-task-tool-"));
  const seedPath = path.join(tmpDir, "seed.jsonl");
  try {
    await fs.promises.copyFile(sessionFile, seedPath);
    return { dir: tmpDir, seedPath };
  } catch (error) {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
    }
    throw error;
  }
};
var cleanupForkSession = async (session) => {
  if (!session) return;
  try {
    await fs.promises.rm(session.dir, { recursive: true, force: true });
  } catch {
  }
};
var applyForkSessionArgs = (baseArgs, session) => {
  if (!session) return baseArgs;
  const filtered = baseArgs.filter((arg) => arg !== "--no-session");
  return [...filtered, "--session", session.seedPath, "--session-dir", session.dir];
};
var shortenPath = (filePath) => {
  const home = os.homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
};
var formatTokens = (count) => {
  if (count < 1e3) return count.toString();
  if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1e3)}k`;
  return `${(count / 1e6).toFixed(1)}M`;
};
var formatUsageStats = (usage, model, thinking2) => {
  const parts = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`\u2191${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`\u2193${formatTokens(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  if (thinking2) parts.push(`thinking:${thinking2}`);
  return parts.join(" ");
};
var formatTaskConfig = (result) => {
  const parts = [];
  if (result.model) parts.push(result.model);
  if (result.thinking) parts.push(`thinking:${result.thinking}`);
  const contextLabel = getTaskContextLabel(result);
  if (contextLabel) parts.push(`context:${contextLabel}`);
  return parts.length > 0 ? parts.join(" ") : void 0;
};
var stripYamlFrontmatter = (content) => {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
};
var formatToolCall = (toolName, args, themeFg) => {
  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : "...";
    const preview2 = command.length > 60 ? `${command.slice(0, 60)}...` : command;
    return themeFg("muted", "$ ") + themeFg("toolOutput", preview2);
  }
  if (toolName === "read") {
    const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
    const offset = typeof args.offset === "number" ? args.offset : void 0;
    const limit = typeof args.limit === "number" ? args.limit : void 0;
    let text = themeFg("accent", shortenPath(rawPath));
    if (offset !== void 0 || limit !== void 0) {
      const startLine = offset ?? 1;
      const endLine = limit !== void 0 ? startLine + limit - 1 : "";
      text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
    }
    return themeFg("muted", "read ") + text;
  }
  if (toolName === "write") {
    const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
    const content = typeof args.content === "string" ? args.content : "";
    const lines = content.split("\n").length;
    let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
    if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
    return text;
  }
  if (toolName === "edit") {
    const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
    return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
  }
  if (toolName === "ls") {
    const rawPath = typeof args.path === "string" ? args.path : ".";
    return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
  }
  if (toolName === "find") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "*";
    const rawPath = typeof args.path === "string" ? args.path : ".";
    return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
  }
  if (toolName === "grep") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    const rawPath = typeof args.path === "string" ? args.path : ".";
    return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
  }
  const argsStr = JSON.stringify(args);
  const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
  return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
};
var getFinalOutput = (messages) => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
};
var indentLine = (text, indent) => `${" ".repeat(indent)}${text}`;
var indentText = (text, indent) => {
  return text.split("\n").map((line) => indentLine(line, indent)).join("\n");
};
var formatLabeledLine = (label, value, indent) => {
  const lines = value.split("\n");
  const header = indentLine(`${label}: ${lines[0] ?? ""}`, indent);
  if (lines.length === 1) return header;
  const rest = lines.slice(1).map((line) => indentLine(line, indent + 2));
  return [header, ...rest].join("\n");
};
var formatSection = (label, body, indent) => {
  return `${indentLine(`${label}:`, indent)}
${indentText(body, indent + 2)}`;
};
var isTaskRunning = (result) => result.exitCode === -1;
var isTaskPending = (result) => result.exitCode === -2;
var getTaskStatus = (result) => {
  if (isTaskPending(result)) return "Pending";
  if (isTaskRunning(result)) return "Running";
  return isTaskError(result) ? "Failed" : "Done";
};
var getParallelStatus = (results) => {
  const hasInProgress = results.some((result) => isTaskRunning(result) || isTaskPending(result));
  if (hasInProgress) return "Running";
  return results.some(isTaskError) ? "Failed" : "Done";
};
var getChainStatus = (results) => {
  const hasError = results.some(isTaskError);
  if (hasError) return "Failed";
  const hasInProgress = results.some((result) => isTaskRunning(result) || isTaskPending(result));
  return hasInProgress ? "Running" : "Done";
};
var getStatusIcon = (status, theme) => {
  if (status === "Done") return theme.fg("success", "\u2713");
  if (status === "Failed") return theme.fg("error", "\u2717");
  return theme.fg("warning", "\u23F3");
};
var getToolCallItems = (result) => {
  if (result.toolEvents.length > 0) return result.toolEvents;
  const items = [];
  for (const message of result.messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") items.push({ id: part.id, name: part.name, args: part.arguments, status: "running" });
      }
    }
  }
  return items;
};
var getToolCallLines = (result, theme) => {
  const items = getToolCallItems(result);
  const themeFg = theme.fg.bind(theme);
  return items.map((item) => {
    const icon = item.status === "success" ? themeFg("success", "\u2713 ") : item.status === "error" ? themeFg("error", "\u2717 ") : themeFg("warning", "\u2192 ");
    const output = item.output ? themeFg("dim", ` \u2014 ${item.output.slice(0, 80)}`) : "";
    return `${icon}${formatToolCall(item.name, item.args, themeFg)}${output}`;
  });
};
var getTaskOutputText = (result) => {
  if (isTaskError(result)) return getTaskErrorText(result);
  return getFinalOutput(result.messages);
};
var formatFinalOutputText = (result) => {
  const output = getTaskOutputText(result).trim();
  return output ? output : "(no output)";
};
var formatStatusLine = (status, indent, detail) => {
  const base = `Status: ${status}`;
  return indentLine(detail ? `${base} \u2014 ${detail}` : base, indent);
};
var buildTaskBlockLines = (options) => {
  const { label, result, theme, indent } = options;
  const status = getTaskStatus(result);
  const lines = [indentLine(`${theme.fg("toolTitle", label)} ${getStatusIcon(status, theme)}`, indent)];
  lines.push(formatStatusLine(status, indent + 2));
  const skillLabel = getTaskSkillLabel(result);
  if (skillLabel) lines.push(formatLabeledLine("Skill", skillLabel, indent + 2));
  const configLine = formatTaskConfig(result);
  if (configLine) lines.push(formatLabeledLine("Subprocess", configLine, indent + 2));
  lines.push(formatLabeledLine("Prompt", result.prompt.trim(), indent + 2));
  const logLines = status === "Pending" ? [] : getToolCallLines(result, theme);
  if (status !== "Pending") {
    if (logLines.length > 0) lines.push(formatSection("Logs", logLines.join("\n"), indent + 2));
    else lines.push(indentLine("Logs:", indent + 2));
  }
  if (status === "Done" || status === "Failed") {
    lines.push(formatSection("Final output", formatFinalOutputText(result), indent + 2));
    const usageStr = formatUsageStats(result.usage, result.model, result.thinking);
    if (usageStr) lines.push(indentLine(`Usage: ${usageStr}`, indent + 2));
  }
  return lines;
};
var buildChainPrompt = (prompt, previousOutput) => {
  return prompt.replace(/\{previous\}/g, previousOutput);
};
var buildPendingPrompt = (prompt) => {
  return buildChainPrompt(prompt, "\u2026");
};
var countCompletedTasks = (results) => {
  let count = 0;
  for (const result of results) {
    if (!isTaskRunning(result) && !isTaskPending(result)) count += 1;
  }
  return count;
};
var aggregateUsage = (results) => {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
  for (const result of results) {
    total.input += result.usage.input;
    total.output += result.usage.output;
    total.cacheRead += result.usage.cacheRead;
    total.cacheWrite += result.usage.cacheWrite;
    total.cost += result.usage.cost;
    total.turns += result.usage.turns;
  }
  return total;
};
var formatAvailableSkills = (skills, maxItems) => {
  if (skills.length === 0) return { text: "none", remaining: 0 };
  const listed = skills.slice(0, maxItems);
  const remaining = skills.length - listed.length;
  return {
    text: listed.map((skill) => skill.name).join(", "),
    remaining
  };
};
var buildSkillMessageBase = (skill) => {
  const content = fs.readFileSync(skill.filePath, "utf-8");
  const body = stripYamlFrontmatter(content);
  const header = `Skill location: ${skill.filePath}
References are relative to ${skill.baseDir}.`;
  return `${header}

${body}`;
};
var createSkillPromptState = (skills) => {
  const skillByName = /* @__PURE__ */ new Map();
  for (const skill of skills) skillByName.set(skill.name, skill);
  return { skills, skillByName, baseCache: /* @__PURE__ */ new Map() };
};
var buildSubprocessPrompt = (item, state, skillListLimit) => {
  if (!item.skill) return { ok: true, prompt: item.prompt };
  const skill = state.skillByName.get(item.skill);
  if (!skill) {
    const available = formatAvailableSkills(state.skills, skillListLimit);
    const suffix = available.remaining > 0 ? `, ... +${available.remaining} more` : "";
    return {
      ok: false,
      error: `Unknown skill: ${item.skill}
Available skills: ${available.text}${suffix}`
    };
  }
  let base = state.baseCache.get(skill.name);
  if (!base) {
    try {
      base = buildSkillMessageBase(skill);
      state.baseCache.set(skill.name, base);
    } catch (err) {
      return {
        ok: false,
        error: `Failed to load skill "${skill.name}": ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }
  return { ok: true, prompt: `${base}

---

User: ${item.prompt}` };
};
var createPlaceholderResult = (item, index, thinking2, model, exitCode = -1) => {
  return {
    prompt: item.prompt,
    skill: item.skill,
    index,
    exitCode,
    messages: [],
    toolEvents: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model,
    thinking: thinking2,
    fork: item.fork
  };
};
var getTaskSkillLabel = (result) => {
  const skill = result?.skill?.trim();
  return skill ? skill : void 0;
};
var getTaskSummaryLabel = (result) => {
  const skillLabel = getTaskSkillLabel(result);
  if (skillLabel) return skillLabel;
  if (result.index) return `task ${result.index}`;
  return "task";
};
var getTaskContextLabel = (result) => {
  if (result.fork === void 0) return void 0;
  return result.fork ? "fork" : "fresh";
};
var isTaskError = (result) => {
  return result.exitCode > 0 || result.stopReason === "error" || result.stopReason === "aborted";
};
var getTaskErrorText = (result) => {
  return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
};
var attachAbortSignal = (proc, signal) => {
  let aborted = false;
  if (!signal) return { isAborted: () => aborted };
  const killProcess = () => {
    aborted = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5e3);
  };
  if (signal.aborted) killProcess();
  else signal.addEventListener("abort", killProcess, { once: true });
  return { isAborted: () => aborted };
};
var parseJsonLine = (line) => {
  if (!line.trim()) return void 0;
  try {
    const parsed = JSON.parse(line);
    return isRecord(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
};
var isMessage = (value) => {
  if (!isRecord(value)) return false;
  const role = value.role;
  return role === "assistant" || role === "user" || role === "toolResult";
};
var applyAssistantUsage = (result, message) => {
  result.usage.turns += 1;
  const usage = message.usage;
  result.usage.input += usage.input ?? 0;
  result.usage.output += usage.output ?? 0;
  result.usage.cacheRead += usage.cacheRead ?? 0;
  result.usage.cacheWrite += usage.cacheWrite ?? 0;
  result.usage.cost += usage.cost?.total ?? 0;
  result.usage.contextTokens = usage.totalTokens ?? 0;
};
var handleEventMessage = (result, message) => {
  result.messages.push(message);
  if (message.role !== "assistant") return;
  applyAssistantUsage(result, message);
  if (!result.model && message.model) result.model = message.model;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
};
var prepareTaskExecutions = (options) => {
  const executions = [];
  for (const item of options.items) {
    const prepared = buildSubprocessPrompt(item, options.state, options.skillListLimit);
    if (!prepared.ok) return prepared;
    const config = resolveTaskConfig({
      item,
      defaultModel: options.defaultModel,
      defaultThinking: options.defaultThinking,
      inheritedThinking: options.inheritedThinking,
      ctxModel: options.ctxModel,
      builtInTools: options.builtInTools
    });
    if (!config.ok) return config;
    executions.push({
      task: { item, subprocessPrompt: prepared.prompt },
      config: {
        thinkingLevel: config.thinkingLevel,
        subprocessArgs: config.subprocessArgs,
        modelLabel: config.modelLabel
      }
    });
  }
  return { ok: true, executions };
};
var stringifyToolOutput = (value) => {
  if (value === void 0) return void 0;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const content = value.content;
    if (Array.isArray(content)) {
      const text = content.map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : void 0).filter((part) => part !== void 0).join("\n");
      if (text.trim().length > 0) return text;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
var upsertToolEvent = (result, event) => {
  const key = event.id ?? `${event.name}:${JSON.stringify(event.args)}`;
  const index = result.toolEvents.findIndex((item) => (item.id ?? `${item.name}:${JSON.stringify(item.args)}`) === key);
  if (index === -1) {
    result.toolEvents.push(event);
    return;
  }
  result.toolEvents[index] = { ...result.toolEvents[index], ...event };
};
var mapWithConcurrencyLimit = async (items, concurrency, fn) => {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length });
  let nextIndex2 = 0;
  const runWorker = async () => {
    const currentIndex = nextIndex2;
    nextIndex2 += 1;
    if (currentIndex >= items.length) return;
    results[currentIndex] = await fn(items[currentIndex], currentIndex);
    await runWorker();
  };
  await Promise.all(Array.from({ length: limit }, () => null).map(async () => runWorker()));
  return results;
};
var runSingleTask = async (options) => {
  const currentResult = {
    prompt: options.item.prompt,
    skill: options.item.skill,
    index: options.index,
    exitCode: -1,
    messages: [],
    toolEvents: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: options.modelLabel,
    thinking: options.thinking,
    fork: options.fork
  };
  const emitUpdate = () => {
    options.onResultUpdate?.(currentResult);
  };
  let forkSession;
  if (options.fork) {
    if (!options.sessionFile) {
      currentResult.exitCode = 1;
      currentResult.errorMessage = "Forked tasks require a persisted session file.";
      return currentResult;
    }
    try {
      forkSession = await createForkSession(options.sessionFile);
    } catch (error) {
      currentResult.exitCode = 1;
      currentResult.errorMessage = error instanceof Error ? error.message : String(error);
      return currentResult;
    }
  }
  try {
    const args = [...applyForkSessionArgs(options.subprocessArgs, forkSession), options.subprocessPrompt];
    const exitCode = await new Promise((resolve10) => {
      const proc = spawn("pi", args, {
        cwd: options.defaultCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
      proc.stdin.end();
      const abortState = attachAbortSignal(proc, options.signal);
      let buffer = "";
      const processLine = (line) => {
        const event = parseJsonLine(line);
        if (!event) return;
        const typeValue = event.type;
        const typeText = typeof typeValue === "string" ? typeValue : "";
        if (typeText === "message_update") {
          const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : void 0;
          if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
            currentResult.streamingText = `${currentResult.streamingText ?? ""}${assistantEvent.delta}`;
            emitUpdate();
          }
        }
        if (typeText === "tool_execution_start") {
          upsertToolEvent(currentResult, {
            id: typeof event.toolCallId === "string" ? event.toolCallId : void 0,
            name: typeof event.toolName === "string" ? event.toolName : "tool",
            args: isRecord(event.args) ? event.args : {},
            status: "running"
          });
          emitUpdate();
        }
        if (typeText === "tool_execution_update") {
          upsertToolEvent(currentResult, {
            id: typeof event.toolCallId === "string" ? event.toolCallId : void 0,
            name: typeof event.toolName === "string" ? event.toolName : "tool",
            args: isRecord(event.args) ? event.args : {},
            status: "running",
            output: stringifyToolOutput(event.partialResult)
          });
          emitUpdate();
        }
        if (typeText === "tool_execution_end") {
          upsertToolEvent(currentResult, {
            id: typeof event.toolCallId === "string" ? event.toolCallId : void 0,
            name: typeof event.toolName === "string" ? event.toolName : "tool",
            args: isRecord(event.args) ? event.args : {},
            status: event.isError === true ? "error" : "success",
            output: stringifyToolOutput(event.result)
          });
          emitUpdate();
        }
        const messageValue = event.message;
        if ((typeText === "message_end" || typeText === "tool_result_end") && isMessage(messageValue)) {
          handleEventMessage(currentResult, messageValue);
          emitUpdate();
        }
      };
      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        currentResult.exitCode = code ?? 0;
        if (abortState.isAborted()) currentResult.stopReason = "aborted";
        resolve10(code ?? 0);
      });
      proc.on("error", () => {
        currentResult.exitCode = 1;
        resolve10(1);
      });
    });
    currentResult.exitCode = exitCode;
    return currentResult;
  } finally {
    await cleanupForkSession(forkSession);
  }
};
var ModelOverrideSchema = Type2.Optional(Type2.String({ description: "Optional model override: provider/modelId" }));
var ThinkingOverrideSchema = Type2.Optional(
  Type2.String({
    enum: [...VALID_THINKING_OPTIONS],
    description: "Thinking level override: off, minimal, low, medium, high, xhigh, max, or inherit"
  })
);
var TaskItemSchema = Type2.Object({
  prompt: Type2.String({ description: "Task prompt" }),
  skill: Type2.Optional(Type2.String({ description: "Optional skill name" })),
  model: ModelOverrideSchema,
  thinking: ThinkingOverrideSchema,
  fork: Type2.Optional(Type2.Boolean({ description: "Fork context from current session (default: true)" }))
});
var TaskParams = Type2.Object({
  type: Type2.String({
    enum: ["single", "chain", "parallel"],
    description: "Execution mode: single prompt, chain or parallel tasks"
  }),
  tasks: Type2.Array(TaskItemSchema, {
    minItems: 1,
    description: "Tasks to run (single expects exactly one)."
  }),
  model: ModelOverrideSchema,
  thinking: ThinkingOverrideSchema
});
var renderSingleResult = (result, _expanded, theme) => {
  const lines = buildTaskBlockLines({ label: "task", result, theme, indent: 0 });
  return new Text2(lines.join("\n"), 0, 0);
};
var renderParallelResult = (results, _expanded, theme) => {
  const status = getParallelStatus(results);
  const doneCount = countCompletedTasks(results);
  const lines = [
    indentLine(`${theme.fg("toolTitle", "task (parallel)")} ${getStatusIcon(status, theme)}`, 0),
    formatStatusLine(status, 2, status === "Running" ? `${doneCount}/${results.length} done` : void 0),
    indentLine("Tasks:", 2)
  ];
  for (let index = 0; index < results.length; index++) {
    if (index > 0) lines.push("");
    lines.push(...buildTaskBlockLines({ label: "task", result: results[index], theme, indent: 4 }));
  }
  const usageStr = formatUsageStats(aggregateUsage(results));
  if (usageStr) {
    lines.push("");
    const totalLabel = status === "Running" ? "Total usage so far" : "Total usage";
    lines.push(indentLine(`${totalLabel}: ${usageStr}`, 2));
  }
  return new Text2(lines.join("\n"), 0, 0);
};
var renderChainResult = (results, _expanded, theme) => {
  const status = getChainStatus(results);
  const doneCount = countCompletedTasks(results);
  const lines = [
    indentLine(`${theme.fg("toolTitle", "task (chain)")} ${getStatusIcon(status, theme)}`, 0),
    formatStatusLine(status, 2, status === "Running" ? `${doneCount}/${results.length} done` : void 0),
    indentLine("Steps:", 2)
  ];
  for (let index = 0; index < results.length; index++) {
    if (index > 0) lines.push("");
    const result = results[index];
    const stepNumber = result.index ?? index + 1;
    lines.push(...buildTaskBlockLines({ label: `Step ${stepNumber} (task)`, result, theme, indent: 4 }));
  }
  const usageStr = formatUsageStats(aggregateUsage(results));
  if (usageStr) {
    lines.push("");
    const totalLabel = status === "Running" ? "Total usage so far" : "Total usage";
    lines.push(indentLine(`${totalLabel}: ${usageStr}`, 2));
  }
  return new Text2(lines.join("\n"), 0, 0);
};
var taskTool = (options = DEFAULT_OPTIONS) => (pi) => {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  pi.registerTool({
    name: merged.name,
    label: merged.label,
    description: merged.description,
    parameters: TaskParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const normalized = normalizeTaskParams(params, { maxParallelTasks: merged.maxParallelTasks });
      if (!normalized.ok) {
        const discovery2 = loadSkillDiscovery(ctx.cwd);
        const available = formatAvailableSkills(discovery2.skills, merged.skillListLimit);
        const suffix = available.remaining > 0 ? `, ... +${available.remaining} more` : "";
        return {
          content: [{ type: "text", text: `${normalized.error}
Available skills: ${available.text}${suffix}` }],
          details: { mode: "single", results: [] },
          isError: true
        };
      }
      const discovery = loadSkillDiscovery(ctx.cwd);
      const skillState = createSkillPromptState(discovery.skills);
      const inheritedThinking = pi.getThinkingLevel();
      const builtInTools = getBuiltInToolsFromActiveTools(pi.getActiveTools());
      const ctxModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : void 0;
      const taskStartedAt = Date.now();
      const makeDetails = (results2) => {
        return {
          mode: normalized.value.mode,
          modelOverride: normalized.value.model,
          results: results2,
          startedAt: taskStartedAt,
          updatedAt: Date.now()
        };
      };
      const requiresFork = normalized.value.items.some((item) => item.fork);
      const sessionFile = requiresFork ? ctx.sessionManager.getSessionFile() : void 0;
      if (requiresFork && !sessionFile) {
        return {
          content: [
            {
              type: "text",
              text: "Forked tasks require a persisted session file. Set fork: false or start pi with sessions enabled."
            }
          ],
          details: makeDetails([]),
          isError: true
        };
      }
      if (normalized.value.mode === "single") {
        const prepared2 = prepareTaskExecutions({
          items: normalized.value.items,
          state: skillState,
          skillListLimit: merged.skillListLimit,
          defaultModel: normalized.value.model,
          defaultThinking: normalized.value.thinking,
          inheritedThinking,
          ctxModel,
          builtInTools
        });
        if (!prepared2.ok) {
          return {
            content: [{ type: "text", text: prepared2.error }],
            details: makeDetails([]),
            isError: true
          };
        }
        const execution = prepared2.executions[0];
        const initial = createPlaceholderResult(
          execution.task.item,
          void 0,
          execution.config.thinkingLevel,
          execution.config.modelLabel
        );
        const emitSingleUpdate = (result2) => {
          if (!onUpdate) return;
          onUpdate({
            content: [{ type: "text", text: getFinalOutput(result2.messages) || "(running...)" }],
            details: makeDetails([result2])
          });
        };
        emitSingleUpdate(initial);
        const result = await runSingleTask({
          defaultCwd: ctx.cwd,
          item: execution.task.item,
          subprocessPrompt: execution.task.subprocessPrompt,
          index: void 0,
          subprocessArgs: execution.config.subprocessArgs,
          modelLabel: execution.config.modelLabel,
          thinking: execution.config.thinkingLevel,
          fork: execution.task.item.fork,
          sessionFile,
          signal,
          onResultUpdate: emitSingleUpdate
        });
        const error = isTaskError(result);
        if (error) {
          return {
            content: [{ type: "text", text: `Task failed: ${getTaskErrorText(result)}` }],
            details: makeDetails([result]),
            isError: true
          };
        }
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
          details: makeDetails([result])
        };
      }
      if (normalized.value.mode === "chain") {
        const results2 = normalized.value.items.map(
          (item, index) => createPlaceholderResult(
            { ...item, prompt: buildPendingPrompt(item.prompt) },
            index + 1,
            void 0,
            void 0,
            -2
          )
        );
        let previousOutput = "";
        for (let index = 0; index < normalized.value.items.length; index++) {
          const item = normalized.value.items[index];
          const prompt = buildChainPrompt(item.prompt, previousOutput);
          const stepItem = { ...item, prompt };
          const config = resolveTaskConfig({
            item,
            defaultModel: normalized.value.model,
            defaultThinking: normalized.value.thinking,
            inheritedThinking,
            ctxModel,
            builtInTools
          });
          if (!config.ok) {
            return {
              content: [{ type: "text", text: config.error }],
              details: makeDetails([...results2]),
              isError: true
            };
          }
          const preparedPrompt = buildSubprocessPrompt(stepItem, skillState, merged.skillListLimit);
          if (!preparedPrompt.ok) {
            return {
              content: [{ type: "text", text: preparedPrompt.error }],
              details: makeDetails([...results2]),
              isError: true
            };
          }
          results2[index] = createPlaceholderResult(
            stepItem,
            index + 1,
            config.thinkingLevel,
            config.modelLabel
          );
          if (onUpdate) {
            onUpdate({
              content: [{ type: "text", text: "(running...)" }],
              details: makeDetails([...results2])
            });
          }
          const chainUpdate = onUpdate ? (partial) => {
            results2[index] = partial;
            onUpdate({
              content: [{ type: "text", text: getFinalOutput(partial.messages) || "(running...)" }],
              details: makeDetails([...results2])
            });
          } : void 0;
          const result = await runSingleTask({
            defaultCwd: ctx.cwd,
            item: stepItem,
            subprocessPrompt: preparedPrompt.prompt,
            index: index + 1,
            subprocessArgs: config.subprocessArgs,
            modelLabel: config.modelLabel,
            thinking: config.thinkingLevel,
            fork: stepItem.fork,
            sessionFile,
            signal,
            onResultUpdate: chainUpdate
          });
          results2[index] = result;
          if (onUpdate) {
            onUpdate({
              content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
              details: makeDetails([...results2])
            });
          }
          if (isTaskError(result)) {
            return {
              content: [
                { type: "text", text: `Chain stopped at step ${index + 1}: ${getTaskErrorText(result)}` }
              ],
              details: makeDetails([...results2]),
              isError: true
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        const last = results2[results2.length - 1];
        return {
          content: [{ type: "text", text: getFinalOutput(last.messages) || "(no output)" }],
          details: makeDetails([...results2])
        };
      }
      const prepared = prepareTaskExecutions({
        items: normalized.value.items,
        state: skillState,
        skillListLimit: merged.skillListLimit,
        defaultModel: normalized.value.model,
        defaultThinking: normalized.value.thinking,
        inheritedThinking,
        ctxModel,
        builtInTools
      });
      if (!prepared.ok) {
        return {
          content: [{ type: "text", text: prepared.error }],
          details: makeDetails([]),
          isError: true
        };
      }
      const allResults = prepared.executions.map(
        (execution, index) => createPlaceholderResult(
          execution.task.item,
          index + 1,
          execution.config.thinkingLevel,
          execution.config.modelLabel,
          -2
        )
      );
      const emitParallelUpdate = () => {
        if (!onUpdate) return;
        const running = allResults.filter((result) => result.exitCode === -1).length;
        const done = allResults.filter((result) => result.exitCode !== -1 && result.exitCode !== -2).length;
        onUpdate({
          content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
          details: makeDetails([...allResults])
        });
      };
      emitParallelUpdate();
      const results = await mapWithConcurrencyLimit(
        prepared.executions,
        merged.maxConcurrency,
        async (execution, index) => {
          allResults[index] = createPlaceholderResult(
            execution.task.item,
            index + 1,
            execution.config.thinkingLevel,
            execution.config.modelLabel
          );
          emitParallelUpdate();
          const result = await runSingleTask({
            defaultCwd: ctx.cwd,
            item: execution.task.item,
            subprocessPrompt: execution.task.subprocessPrompt,
            index: index + 1,
            subprocessArgs: execution.config.subprocessArgs,
            modelLabel: execution.config.modelLabel,
            thinking: execution.config.thinkingLevel,
            fork: execution.task.item.fork,
            sessionFile,
            signal,
            onResultUpdate: (partial) => {
              allResults[index] = partial;
              emitParallelUpdate();
            }
          });
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        }
      );
      const successCount = results.filter((result) => !isTaskError(result)).length;
      const summaries = results.map((result) => {
        const output = getFinalOutput(result.messages);
        const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
        return `[${getTaskSummaryLabel(result)}] ${isTaskError(result) ? "failed" : "completed"}: ${preview || "(no output)"}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `Parallel: ${successCount}/${results.length} succeeded

${summaries.join("\n\n")}`
          }
        ],
        details: makeDetails(results)
      };
    },
    renderCall(_args, _theme) {
      return new Text2("", 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      if (!details || details.results.length === 0) {
        const textBlock2 = result.content[0];
        return new Text2(textBlock2?.type === "text" ? textBlock2.text : "(no output)", 0, 0);
      }
      if (details.mode === "single" && details.results.length === 1) {
        return renderSingleResult(details.results[0], expanded, theme);
      }
      if (details.mode === "chain") {
        return renderChainResult(details.results, expanded, theme);
      }
      if (details.mode === "parallel") {
        return renderParallelResult(details.results, expanded, theme);
      }
      const textBlock = result.content[0];
      return new Text2(textBlock?.type === "text" ? textBlock.text : "(no output)", 0, 0);
    }
  });
  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt: applyPromptPatches(event.systemPrompt, merged.systemPromptPatches)
    };
  });
};

// src/skill-inline.ts
import * as fs2 from "node:fs";
import {
  DefaultResourceLoader,
  getAgentDir as getAgentDir2,
  SettingsManager as SettingsManager2,
  stripFrontmatter
} from "@earendil-works/pi-coding-agent";
var SKILL_TOKEN = /(^|(?<=\s))\/skill:([A-Za-z0-9][A-Za-z0-9_-]*)/g;
var ATTACHED_SKILL_SUFFIX = /^(?:[,.;:!?%‰°)\]}]|['’](?:s|t|re|ve|ll|d|m)\b)/iu;
var readSkillBodyFromDisk = (skill) => stripFrontmatter(fs2.readFileSync(skill.filePath, "utf-8")).trim();
function removeInlineSkillToken(text, offset, length) {
  const tokenEnd = offset + length;
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const nextNewline = text.indexOf("\n", tokenEnd);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  const beforeOnLine = text.slice(lineStart, offset);
  const afterOnLine = text.slice(tokenEnd, lineEnd);
  if (/^[ \t]*$/.test(beforeOnLine) && /^[ \t]*$/.test(afterOnLine)) {
    const beforeEnd = nextNewline === -1 && lineStart > 0 ? lineStart - 1 : lineStart;
    const before2 = text.slice(0, beforeEnd);
    const after2 = nextNewline === -1 ? "" : text.slice(nextNewline + 1);
    return `${before2}${after2}`;
  }
  const rawBefore = text.slice(0, offset);
  const rawAfter = text.slice(tokenEnd);
  const beforeCurrentLine = rawBefore.slice(rawBefore.lastIndexOf("\n") + 1);
  const preservesLineIndent = /^[ \t]*$/.test(beforeCurrentLine);
  const before = preservesLineIndent ? rawBefore : rawBefore.replace(/[ \t]+$/, "");
  const after = rawAfter.replace(/^[ \t]+/, "");
  const separator = before.length > 0 && after.length > 0 ? preservesLineIndent || before.endsWith("\n") || after.startsWith("\n") || ATTACHED_SKILL_SUFFIX.test(after) ? "" : " " : "";
  return `${before}${separator}${after}`;
}
var expandInlineSkillTokens = (text, skills, readSkillBody = readSkillBodyFromDisk) => {
  if (text.startsWith("/skill:")) return { text, expanded: [] };
  const byName = /* @__PURE__ */ new Map();
  for (const skill of skills) byName.set(skill.name, skill);
  for (const match of text.matchAll(SKILL_TOKEN)) {
    const offset = match.index;
    if (offset === 0) continue;
    const name = match[2];
    const skill = name ? byName.get(name) : void 0;
    if (!skill) continue;
    let body = "";
    try {
      body = readSkillBody(skill).trim();
    } catch {
      continue;
    }
    const userMessage = removeInlineSkillToken(text, offset, match[0].length);
    const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">
References are relative to ${skill.baseDir}.

${body}
</skill>`;
    return { text: userMessage ? `${skillBlock}

${userMessage}` : skillBlock, expanded: [name] };
  }
  return { text, expanded: [] };
};
async function discoverSkills(cwd) {
  const resolvedCwd = cwd ?? process.cwd();
  const settingsManager = SettingsManager2.create(resolvedCwd);
  const loader = new DefaultResourceLoader({
    cwd: resolvedCwd,
    agentDir: getAgentDir2(),
    settingsManager,
    // Resource discovery needs package/.agents paths, not another recursive
    // activation of SumoCode or unrelated extensions.
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await loader.reload();
  return loader.getSkills().skills;
}
function installSkillInlineExpansion(pi, options = {}) {
  let cache2;
  const loadSkillsOnce = () => {
    if (cache2) return cache2;
    const pending = (options.discoverSkills ?? discoverSkills)(options.cwd);
    const cached = pending.catch((error) => {
      if (cache2 === cached) cache2 = void 0;
      throw error;
    });
    cache2 = cached;
    return cached;
  };
  pi.on("session_start", () => {
    cache2 = void 0;
  });
  pi.on("input", async (event) => {
    if (!event.text.includes("/skill:")) return { action: "continue" };
    try {
      const { text, expanded } = expandInlineSkillTokens(
        event.text,
        await loadSkillsOnce(),
        options.readSkillBody ?? readSkillBodyFromDisk
      );
      if (expanded.length === 0) return { action: "continue" };
      return { action: "transform", text };
    } catch {
      return { action: "continue" };
    }
  });
}

// src/sumo-tui/runtime/lifecycle.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join3 } from "node:path";

// src/cathedral/editor-draft-state.ts
var IMAGE_PATH_PATTERN = /^(?:(?:\/|~\/|\.\.?\/)[^\n]+|(?:[^\n/]*\/)?pi-clipboard-[\w-]+)\.(?:png|jpe?g|gif|webp)$/i;
var EditorImageDraftState = class {
  nextImageIndex = 1;
  images = /* @__PURE__ */ new Map();
  addImage(path2) {
    const token = `[Image ${this.nextImageIndex}]`;
    this.nextImageIndex += 1;
    this.images.set(token, path2);
    return token;
  }
  expandTokensToPaths(text) {
    let expanded = text;
    for (const [token, path2] of this.images) {
      const replacement = /\s/.test(path2) ? `"${path2}"` : path2;
      expanded = expanded.split(token).join(replacement);
    }
    return expanded;
  }
  pruneMissingTokens(text) {
    for (const token of this.images.keys()) {
      if (!text.includes(token)) this.images.delete(token);
    }
  }
  clear() {
    this.images.clear();
    this.nextImageIndex = 1;
  }
  list() {
    return [...this.images.entries()].map(([token, path2]) => ({ token, path: path2 }));
  }
};
function isLikelyClipboardImagePath(value) {
  return IMAGE_PATH_PATTERN.test(value.trim());
}
function normalizePastedImagePath(value) {
  let candidate = value.trim();
  if (candidate.length >= 2 && (candidate.startsWith('"') && candidate.endsWith('"') || candidate.startsWith("'") && candidate.endsWith("'"))) {
    candidate = candidate.slice(1, -1);
  }
  return candidate.replace(/\\ /g, " ");
}
var activeController;
function setActiveEditorDraftController(controller) {
  activeController = controller;
}
function consumeActiveEditorDraftClear() {
  if (!activeController?.hasDraft()) return false;
  activeController.clearDraft();
  return true;
}

// src/sumo-tui/runtime/frame-scheduler.ts
var FrameScheduler = class {
  renderCallback;
  frameIntervalMs;
  maxQueueDepth;
  setTimer;
  clearTimer;
  queue = [];
  idleTimer;
  streamingTimer;
  streaming = false;
  inFlight = false;
  sequence = 0;
  renderHistory = [];
  constructor(options) {
    this.renderCallback = options.render;
    this.frameIntervalMs = options.frameIntervalMs ?? 16;
    this.maxQueueDepth = options.maxQueueDepth ?? 3;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }
  requestRender() {
    this.enqueueDirtyFrame();
    if (this.streaming) {
      this.ensureStreamingTimer();
      return;
    }
    this.ensureIdleTimer();
  }
  enterStreamingMode() {
    if (this.streaming) return;
    this.streaming = true;
    if (this.idleTimer) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = void 0;
    }
    if (this.queue.length > 0) this.ensureStreamingTimer();
  }
  exitStreamingMode() {
    if (!this.streaming) return;
    this.streaming = false;
    if (this.streamingTimer) {
      this.clearTimer(this.streamingTimer);
      this.streamingTimer = void 0;
    }
    if (this.queue.length > 0) this.ensureIdleTimer();
  }
  isStreamingMode() {
    return this.streaming;
  }
  getQueueDepth() {
    return this.queue.length;
  }
  getRendersPerSecond() {
    const cutoff = Date.now() - 1e3;
    this.trimRenderHistory(cutoff);
    return this.renderHistory.length;
  }
  dispose() {
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    if (this.streamingTimer) this.clearTimer(this.streamingTimer);
    this.idleTimer = void 0;
    this.streamingTimer = void 0;
    this.queue = [];
    this.renderHistory = [];
  }
  enqueueDirtyFrame() {
    this.sequence += 1;
    if (this.queue.length >= this.maxQueueDepth) this.queue.shift();
    this.queue.push(this.sequence);
  }
  ensureIdleTimer() {
    if (this.idleTimer) return;
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = void 0;
      void this.flushOnce();
    }, 0);
  }
  ensureStreamingTimer() {
    if (!this.streaming || this.streamingTimer) return;
    this.streamingTimer = this.setTimer(() => {
      this.streamingTimer = void 0;
      void this.flushStreamingTick();
    }, this.frameIntervalMs);
  }
  async flushStreamingTick() {
    if (this.queue.length > 0) await this.flushOnce();
    if (this.streaming && this.queue.length > 0) this.ensureStreamingTimer();
  }
  trimRenderHistory(cutoff = Date.now() - 6e4) {
    const firstRecent = this.renderHistory.findIndex((timestamp) => timestamp >= cutoff);
    if (firstRecent === -1) {
      this.renderHistory = [];
      return;
    }
    if (firstRecent > 0) this.renderHistory.splice(0, firstRecent);
  }
  recordRender() {
    const now = Date.now();
    this.renderHistory.push(now);
    this.trimRenderHistory(now - 6e4);
  }
  async flushOnce() {
    if (this.inFlight || this.queue.length === 0) return;
    this.inFlight = true;
    const queuedFrames = this.queue.length;
    this.queue = [];
    try {
      logDiagnostic("frame_scheduler_render", { streaming: this.streaming, queuedFrames });
      await this.renderCallback();
      this.recordRender();
    } finally {
      this.inFlight = false;
    }
    if (!this.streaming && this.queue.length > 0) this.ensureIdleTimer();
  }
};

// src/sumo-tui/runtime/terminal-controller.ts
var ALTSCREEN_ENTER_SEQUENCE = "\x1B[?1049h\x1B[?2004h\x1B[>7u\x1B[>4;2m\x1B[?25h\x1B[H";
var CATHEDRAL_TERMINAL_PALETTE = { background: "#1A1511", accent: "#D97706" };
var CURSOR_COLOR_RESET = "\x1B]112\x1B\\";
var TERMINAL_BG_RESET = "\x1B]111\x1B\\";
var MOUSE_SGR_ENABLE_SEQUENCE = "\x1B[?1000h\x1B[?1002h\x1B[?1006h";
var MOUSE_SGR_DISABLE_SEQUENCE = "\x1B[?1003l\x1B[?1002l\x1B[?1006l\x1B[?1000l";
var TERMINAL_CLEANUP_SEQUENCE = "\x1B[<u\x1B[>4;0m\x1B[?2004l" + // bracketed paste off
MOUSE_SGR_DISABLE_SEQUENCE + // mouse off
"\x1B[?1049l\x1B[?25h\x1B[0m";
var HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
function assertHexColor(hex) {
  if (!HEX_COLOR_PATTERN.test(hex)) throw new Error(`Invalid terminal palette color: ${hex}`);
  return hex;
}
function cursorColorSetSequence(hex) {
  return `\x1B]12;${assertHexColor(hex)}\x1B\\`;
}
function terminalBackgroundSetSequence(hex) {
  return `\x1B]11;${assertHexColor(hex)}\x1B\\`;
}
var TerminalSessionOwner = class {
  restored = false;
  output;
  paintBackground;
  terminalUnavailable = false;
  altscreenActive = false;
  mouseSGREnabled = false;
  backgroundPainted = false;
  cursorColorOverridden = false;
  lastCursorColor;
  lastBackgroundColor;
  /**
   * Retained terminal palette. Starts as Cathedral for the classic extension
   * path; the RPC runtime pushes the active theme's palette via
   * `applyPalette()` before terminal ownership begins, and again on live theme
   * switches. Suspend/resume and repeated `startRetainedSession()` calls
   * restore whatever palette is retained here, never a hardcoded theme.
   */
  palette = CATHEDRAL_TERMINAL_PALETTE;
  /**
   * Last cursor position we emitted to the terminal. Used to skip redundant
   * cursor-reposition writes when the frame doesn't move the cursor. Reset
   * on `exitTerminal` so a re-entered altscreen always re-emits.
   *
   * Borrowed from OpenTUI's renderer (`zig/renderer.zig` ~1180): a
   * "lastEmittedCursor" cache that pairs with the lazy frame-start to
   * suppress no-op ticks entirely.
   */
  lastEmittedCursor = null;
  /** Tracks whether we last emitted \x1b[?25h or \x1b[?25l so we don't re-emit the same. */
  hardwareCursorVisible = true;
  constructor(options = {}) {
    this.output = options.output ?? process.stdout;
    this.paintBackground = options.paintBackground ?? true;
  }
  /** Edge case 10.1: no-op terminal ownership when stdout is not a TTY. */
  isTTY() {
    return this.output.isTTY === true;
  }
  getState() {
    return {
      altscreenActive: this.altscreenActive,
      mouseSGREnabled: this.mouseSGREnabled,
      backgroundPainted: this.backgroundPainted,
      cursorColorOverridden: this.cursorColorOverridden,
      restored: this.restored
    };
  }
  startRetainedSession() {
    this.enterAltscreen();
    this.enableMouseSGR();
    this.setCursorColor();
  }
  /** Adopt terminal modes deliberately left active by a reload predecessor. */
  adoptRetainedSession() {
    if (!this.isTTY()) return;
    this.restored = false;
    this.altscreenActive = true;
    this.mouseSGREnabled = true;
    this.backgroundPainted = this.paintBackground;
    this.cursorColorOverridden = true;
    this.lastBackgroundColor = void 0;
    this.lastCursorColor = void 0;
    this.lastEmittedCursor = null;
  }
  enterAltscreen() {
    if (!this.isTTY() || this.altscreenActive) return;
    this.restored = false;
    let output = ALTSCREEN_ENTER_SEQUENCE;
    if (this.paintBackground) {
      output += terminalBackgroundSetSequence(this.palette.background);
      this.backgroundPainted = true;
      this.lastBackgroundColor = this.palette.background;
    }
    this.write(output);
    this.altscreenActive = true;
    logDiagnostic("altscreen_enter_written", {
      containsKittyPush: output.includes("\x1B[>7u"),
      containsModifyOtherKeys: output.includes("\x1B[>4;2m"),
      containsBracketedPaste: output.includes("\x1B[?2004h"),
      bytes: output.length
    });
  }
  enableMouseSGR() {
    if (!this.isTTY() || this.mouseSGREnabled) return;
    this.restored = false;
    this.write(MOUSE_SGR_ENABLE_SEQUENCE);
    this.mouseSGREnabled = true;
  }
  /**
   * Sync the retained palette with the active theme. Always updates retained
   * state so suspend/resume and future `startRetainedSession()` calls use the
   * new colours. While altscreen is active, immediately re-emits OSC 11; OSC
   * 12 is re-emitted only when the cursor override is currently active, so an
   * explicit `/sumo:cursor reset` opt-out survives theme changes. Duplicate
   * writes for an unchanged palette are suppressed.
   */
  applyPalette(palette) {
    this.palette = palette;
    if (!this.isTTY()) return;
    if (this.altscreenActive && this.paintBackground && this.backgroundPainted && this.lastBackgroundColor !== palette.background) {
      this.write(terminalBackgroundSetSequence(palette.background));
      this.lastBackgroundColor = palette.background;
    }
    if (this.cursorColorOverridden) this.setCursorColor(palette.accent);
  }
  /** Explicit cursor-color override hook for `/sumo:cursor accent`. */
  setCursorColor(hex = this.palette.accent) {
    if (!this.isTTY()) return;
    this.restored = false;
    if (this.cursorColorOverridden && this.lastCursorColor === hex) return;
    this.write(cursorColorSetSequence(hex));
    this.cursorColorOverridden = true;
    this.lastCursorColor = hex;
  }
  /** Explicit cursor-color reset hook for `/sumo:cursor reset`. */
  resetCursorColor() {
    if (!this.isTTY()) return;
    this.write(CURSOR_COLOR_RESET);
    this.cursorColorOverridden = false;
    this.lastCursorColor = void 0;
  }
  writeChatViewport(top, left, lines) {
    if (!this.isTTY() || this.restored || lines.length === 0) return false;
    const safeTop = Math.max(0, Math.floor(top));
    const safeLeft = Math.max(0, Math.floor(left));
    let output = "\x1B[?2026h\x1B7";
    for (let row3 = 0; row3 < lines.length; row3 += 1) {
      output += `\x1B[${safeTop + row3 + 1};${safeLeft + 1}H${lines[row3] ?? ""}`;
    }
    output += "\x1B8\x1B[?2026l";
    this.write(output);
    return true;
  }
  writeClipboardSequence(sequence) {
    if (!this.isTTY() || this.restored || sequence.length === 0) return false;
    this.write(sequence);
    return true;
  }
  writeFramePatches(patches, cursor) {
    if (!this.isTTY() || this.restored) return;
    const cursorMoved = cursor !== null && (this.lastEmittedCursor === null || cursor.row !== this.lastEmittedCursor.row || cursor.col !== this.lastEmittedCursor.col);
    const shouldHideCursor = cursor === null && this.hardwareCursorVisible;
    if (patches.length === 0 && !cursorMoved && !shouldHideCursor) return;
    let output = "\x1B[?2026h";
    for (const patch of patches) {
      const startCol = patch.startCol ?? 0;
      output += `\x1B[${patch.row + 1};${startCol + 1}H`;
      if (startCol === 0 && patch.type !== "scroll") output += "\x1B[K";
      output += patch.ansi;
    }
    if (cursor && (patches.length > 0 || cursorMoved)) {
      output += `\x1B[${cursor.row + 1};${cursor.col + 1}H\x1B[?25h`;
      this.lastEmittedCursor = { row: cursor.row, col: cursor.col };
      this.hardwareCursorVisible = true;
    } else if (cursor === null) {
      this.lastEmittedCursor = null;
      if (this.hardwareCursorVisible) {
        output += "\x1B[?25l";
        this.hardwareCursorVisible = false;
      }
    }
    output += "\x1B[?2026l";
    this.write(output);
  }
  /**
   * Restore every terminal mode that Pi/sumo-tui may have enabled. The order is
   * intentional and covered by tests because Ctrl+C leakage has historically
   * left shells in kitty keyboard / modifyOtherKeys mode.
   */
  exitTerminal() {
    if (this.restored) return;
    this.restored = true;
    const shouldResetCursorColor = this.cursorColorOverridden;
    const shouldResetBackground = this.backgroundPainted;
    this.altscreenActive = false;
    this.mouseSGREnabled = false;
    this.backgroundPainted = false;
    this.cursorColorOverridden = false;
    this.lastCursorColor = void 0;
    this.lastBackgroundColor = void 0;
    this.lastEmittedCursor = null;
    this.hardwareCursorVisible = true;
    if (!this.isTTY()) return;
    let output = "";
    if (shouldResetCursorColor) output += CURSOR_COLOR_RESET;
    if (shouldResetBackground) output += TERMINAL_BG_RESET;
    output += TERMINAL_CLEANUP_SEQUENCE;
    this.write(output);
  }
  write(data) {
    if (this.terminalUnavailable) return;
    try {
      this.output.write(data);
    } catch (error) {
      if (isTerminalIoError(error)) {
        this.terminalUnavailable = true;
        return;
      }
      throw error;
    }
  }
};
var GLOBAL_OWNER_KEY = "__sumoDefaultTerminalSessionOwner";
var globalForOwner = globalThis;
if (!globalForOwner[GLOBAL_OWNER_KEY]) globalForOwner[GLOBAL_OWNER_KEY] = new TerminalSessionOwner();
var existingOwner = globalForOwner[GLOBAL_OWNER_KEY] ?? (globalForOwner[GLOBAL_OWNER_KEY] = new TerminalSessionOwner());
var defaultTerminalSessionOwner = existingOwner;

// src/sumo-tui/runtime/lifecycle.ts
var EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
var ACTIVE_SUMO_RUNTIME_KEY = /* @__PURE__ */ Symbol.for("sumocode.activeSumoRuntime");
function isRetainedSumoRuntimeActive() {
  const host = globalThis;
  if (host[ACTIVE_SUMO_RUNTIME_KEY]?.runtime) return true;
  return process.env.SUMO_TUI === "1";
}
function getNodeProcess() {
  const processLike = process;
  return {
    pid: process.pid,
    on: (event, listener) => processLike.on(event, listener),
    removeListener: (event, listener) => processLike.removeListener(event, listener),
    kill: (pid, signal) => processLike.kill(pid, signal),
    exit: (code) => process.exit(code)
  };
}
function getNodeInput() {
  const stdin = process.stdin;
  if (stdin.isTTY !== true) return void 0;
  return {
    on: (event, listener) => stdin.on(event, listener),
    setRawMode: (enabled) => stdin.setRawMode?.(enabled)
  };
}
function crashText(cause) {
  if (cause instanceof Error) return cause.stack ?? `${cause.name}: ${cause.message}`;
  return String(cause);
}
var LifecycleRuntime = class {
  terminalSession;
  lifecycleProcess;
  input;
  scheduler;
  getHomeDir;
  makeDir;
  appendFile;
  processHandlersInstalled = false;
  piEventsInstrumented = false;
  sigtstpInstalled = false;
  suspended = false;
  signalHandlers = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.terminalSession = options.terminalSession ?? defaultTerminalSessionOwner;
    this.lifecycleProcess = options.process ?? getNodeProcess();
    this.input = options.input ?? getNodeInput();
    this.scheduler = options.scheduler ?? new FrameScheduler({ render: options.render ?? (() => void 0) });
    this.getHomeDir = options.homeDir ?? homedir4;
    this.makeDir = options.mkdirSync ?? mkdirSync2;
    this.appendFile = options.appendFileSync ?? appendFileSync2;
  }
  installLifecycle(pi) {
    this.installProcessHandlers();
    this.instrumentPiEvents(pi);
    pi.on("session_start", (_event, ctx) => {
      if (!ctx.hasUI) return;
      this.acquireRawMode();
      this.terminalSession.startRetainedSession();
    });
    pi.on("session_shutdown", (event) => {
      if (isRetainedSumoRuntimeActive() && (event.reason === "new" || event.reason === "resume" || event.reason === "fork")) {
        this.releaseRawMode();
        return;
      }
      this.restoreTerminal();
    });
    return this.getRenderControls();
  }
  scheduleRender() {
    this.scheduler.requestRender();
  }
  setStreamingMode(enabled) {
    if (enabled) this.scheduler.enterStreamingMode();
    else this.scheduler.exitStreamingMode();
  }
  getRenderControls() {
    return {
      scheduleRender: () => this.scheduleRender(),
      setStreamingMode: (enabled) => this.setStreamingMode(enabled)
    };
  }
  installProcessHandlers() {
    if (this.processHandlersInstalled) return;
    this.processHandlersInstalled = true;
    for (const signal of EXIT_SIGNALS) {
      this.registerReraisingSignal(signal);
    }
    this.registerSuspendSignal();
    this.registerContinueSignal();
    this.lifecycleProcess.on("uncaughtException", (error) => {
      logDiagnostic("process_event", { name: "uncaughtException" });
      this.restoreTerminal();
      this.logCrash(error);
      throw error;
    });
    this.lifecycleProcess.on("exit", () => {
      logDiagnostic("process_event", { name: "exit" });
      this.restoreTerminal();
    });
  }
  restoreTerminal() {
    this.releaseRawMode();
    try {
      this.terminalSession.exitTerminal();
    } catch (error) {
      if (!isTerminalIoError(error)) throw error;
    }
  }
  instrumentPiEvents(pi) {
    if (this.piEventsInstrumented) return;
    const instrumentation = createPiEventInstrumentation();
    if (!instrumentation) return;
    const registrar = pi.on.bind(pi);
    const instrumented = (eventName, listener, ...rest) => registrar(eventName, instrumentation.wrap(eventName, listener), ...rest);
    Object.assign(pi, { on: instrumented });
    this.piEventsInstrumented = true;
    logPiEventInstrumented();
  }
  registerReraisingSignal(signal) {
    let reraised = false;
    const handler = () => {
      logDiagnostic("process_event", { name: signal });
      if (signal === "SIGINT" && consumeActiveEditorDraftClear()) {
        logDiagnostic("process_event", { name: "SIGINT_clear_editor_draft" });
        return;
      }
      if (reraised) return;
      reraised = true;
      this.restoreTerminal();
      this.lifecycleProcess.removeListener(signal, handler);
      this.lifecycleProcess.kill(this.lifecycleProcess.pid, signal);
    };
    this.signalHandlers.set(signal, handler);
    this.lifecycleProcess.on(signal, handler);
  }
  registerSuspendSignal() {
    if (this.sigtstpInstalled) return;
    const existingHandler = this.signalHandlers.get("SIGTSTP");
    let handler;
    if (existingHandler) {
      handler = existingHandler;
    } else {
      handler = () => {
        logDiagnostic("process_event", { name: "SIGTSTP" });
        if (this.suspended) return;
        this.suspended = true;
        this.restoreTerminal();
        this.sigtstpInstalled = false;
        this.lifecycleProcess.removeListener("SIGTSTP", handler);
        this.lifecycleProcess.kill(this.lifecycleProcess.pid, "SIGTSTP");
      };
    }
    this.signalHandlers.set("SIGTSTP", handler);
    this.lifecycleProcess.on("SIGTSTP", handler);
    this.sigtstpInstalled = true;
  }
  registerContinueSignal() {
    const handler = () => {
      logDiagnostic("process_event", { name: "SIGCONT" });
      this.suspended = false;
      this.acquireRawMode();
      this.terminalSession.startRetainedSession();
      this.registerSuspendSignal();
    };
    this.signalHandlers.set("SIGCONT", handler);
    this.lifecycleProcess.on("SIGCONT", handler);
  }
  releaseRawMode() {
    try {
      this.input?.setRawMode?.(false);
    } catch {
    }
  }
  acquireRawMode() {
    try {
      this.input?.setRawMode?.(true);
    } catch {
    }
  }
  logCrash(cause) {
    try {
      const logDir = join3(this.getHomeDir(), ".sumocode");
      this.makeDir(logDir, { recursive: true });
      this.appendFile(join3(logDir, "crash.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] uncaughtException
${crashText(cause)}

`, "utf8");
    } catch {
    }
  }
};
function createLifecycleRuntime(options = {}) {
  return new LifecycleRuntime(options);
}
var GLOBAL_LIFECYCLE_KEY = "__sumoDefaultLifecycleRuntime";
var globalForLifecycle = globalThis;
if (!globalForLifecycle[GLOBAL_LIFECYCLE_KEY]) globalForLifecycle[GLOBAL_LIFECYCLE_KEY] = createLifecycleRuntime();
var defaultLifecycle = globalForLifecycle[GLOBAL_LIFECYCLE_KEY];
defaultLifecycle.installProcessHandlers();
function installLifecycle(pi) {
  return defaultLifecycle.installLifecycle(pi);
}

// src/cathedral/altscreen.ts
function installAltscreen(pi) {
  installLifecycle(pi);
}

// src/cathedral/cathedral-editor.ts
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth as truncateToWidth4, visibleWidth as visibleWidth5 } from "@earendil-works/pi-tui";

// src/cathedral/multiline-paste.ts
var CSI_U_SHIFT_ENTER = "\x1B[13;2u";
function countLegacyModifierEnterPresses(data) {
  if (data === "\n") return 1;
  if (/^(?:\x1b[\r\n])+$/.test(data)) return data.length / 2;
  return 0;
}
function normalizeRawMultilinePasteInput(data) {
  if (!data.includes("\r") || data.includes("\x1B[200~")) return data;
  if (data === "\r") return data;
  if (/^(?:\x1b[\r\n])+$/.test(data)) return data;
  return data.replace(/\r\n?/g, "\n");
}

// src/cathedral/cathedral-editor.ts
var RESET6 = "\x1B[0m";
var RESET_FG = "\x1B[39m";
var ANSI_PATTERN3 = /\u001b\[[0-9;]*m/g;
var SPLASH_INPUT_FRAME_WIDTH2 = 60;
var RAW_PASTE_CR_WINDOW_MS = 50;
var ACTIVE_AUTOCOMPLETE_LEFT_OFFSET = 4;
function visibleLength2(text) {
  return visibleWidth5(text);
}
function ellipsize2(text, max) {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "\u2026";
  return `${text.slice(0, max - 1)}\u2026`;
}
function fitAnsiToWidth(text, width) {
  if (width <= 0) return "";
  return visibleLength2(text) > width ? truncateToWidth4(text, width, "\u2026") : text;
}
function fg4(hex) {
  const n = hex.replace("#", "");
  const r = Number.parseInt(n.slice(0, 2), 16);
  const g = Number.parseInt(n.slice(2, 4), 16);
  const b = Number.parseInt(n.slice(4, 6), 16);
  return `\x1B[38;2;${r};${g};${b}m`;
}
function bg(hex) {
  const n = hex.replace("#", "");
  const r = Number.parseInt(n.slice(0, 2), 16);
  const g = Number.parseInt(n.slice(2, 4), 16);
  const b = Number.parseInt(n.slice(4, 6), 16);
  return `\x1B[48;2;${r};${g};${b}m`;
}
function color2(text, hex) {
  return `${fg4(hex)}${text}${RESET6}`;
}
var INLINE_SKILL_TOKEN = /(?:^|(?<=\s))\/skill:([A-Za-z0-9][A-Za-z0-9_-]*)/g;
function splitEditorRowUnits(row3) {
  const units = [];
  for (let index = 0; index < row3.length; ) {
    if (row3.startsWith(CURSOR_MARKER, index)) {
      units.push({ raw: CURSOR_MARKER, visible: "" });
      index += CURSOR_MARKER.length;
      continue;
    }
    if (row3[index] === "\x1B") {
      if (row3[index + 1] === "[") {
        let end2 = index + 2;
        while (end2 < row3.length && !/[\x40-\x7e]/.test(row3[end2])) end2 += 1;
        end2 = Math.min(row3.length, end2 + 1);
        units.push({ raw: row3.slice(index, end2), visible: "" });
        index = end2;
        continue;
      }
      const st = row3.indexOf("\x1B\\", index + 2);
      const end = st === -1 ? Math.min(row3.length, index + 2) : st + 2;
      units.push({ raw: row3.slice(index, end), visible: "" });
      index = end;
      continue;
    }
    const glyph = String.fromCodePoint(row3.codePointAt(index));
    units.push({ raw: glyph, visible: glyph });
    index += glyph.length;
  }
  return units;
}
function formatInlineSkillRowsForEditor(rows, colors = { accent: activeThemeColors().accent }, source) {
  const parsed = rows.map((row3) => {
    const units = splitEditorRowUnits(row3);
    return { row: row3, units, visible: units.map((unit) => unit.visible).join("") };
  });
  let fallbackOffset = 0;
  const sourceRows = source?.rows ?? parsed.map((row3) => {
    const range = { start: fallbackOffset, end: fallbackOffset + row3.visible.length };
    fallbackOffset = range.end;
    return range;
  });
  const sourceText = source?.text ?? parsed.map((row3) => row3.visible).join("");
  if (!sourceText.includes("/skill:")) return [...rows];
  const tokenRanges = [...sourceText.matchAll(INLINE_SKILL_TOKEN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length
  }));
  if (tokenRanges.length === 0) return [...rows];
  const accentedByRow = sourceRows.map((row3) => {
    const accented = /* @__PURE__ */ new Set();
    for (const token of tokenRanges) {
      const start = Math.max(row3.start, token.start);
      const end = Math.min(row3.end, token.end);
      for (let index = start; index < end; index += 1) accented.add(index - row3.start);
    }
    return accented;
  });
  return parsed.map(({ units }, rowIndex) => {
    const accented = accentedByRow[rowIndex] ?? /* @__PURE__ */ new Set();
    let output = "";
    let visibleIndex = 0;
    let accentActive = false;
    for (const unit of units) {
      if (unit.visible.length === 0) {
        output += unit.raw;
        if (unit.raw === RESET6) accentActive = false;
        continue;
      }
      const desired = accented.has(visibleIndex);
      if (desired !== accentActive) {
        output += desired ? fg4(colors.accent) : RESET_FG;
        accentActive = desired;
      }
      output += unit.raw;
      visibleIndex += unit.visible.length;
    }
    if (accentActive) output += RESET_FG;
    return output;
  });
}
function dividerFg() {
  return fg4(activeThemeColors().divider);
}
function recessBg() {
  return bg(activeThemeColors().surfaceRecess);
}
var RESET_BG = "\x1B[49m";
function withFrameBackground(line) {
  const frameBg = recessBg();
  return `${frameBg}${line.replaceAll(RESET6, `${RESET6}${frameBg}`)}${RESET_BG}`;
}
function maybeWithFrameBackground(line, enabled) {
  return enabled ? withFrameBackground(line) : line;
}
function renderTopBorder(width, label, paintBackground) {
  if (width < 6) return maybeWithFrameBackground(color2("\u2500".repeat(width), activeThemeColors().divider), paintBackground);
  const inner = width - 2;
  if (!label) return maybeWithFrameBackground(color2(`\u250C${"\u2500".repeat(inner)}\u2510`, activeThemeColors().divider), paintBackground);
  const leftDashes = "\u2500".repeat(Math.min(1, inner));
  const maxLabelText = Math.max(0, inner - leftDashes.length - 2);
  const labelText = ellipsize2(label, maxLabelText);
  const labelInner = labelText.length > 0 ? ` ${labelText} ` : "";
  const rightDashes = "\u2500".repeat(Math.max(0, inner - leftDashes.length - labelInner.length));
  const divider2 = dividerFg();
  const left = `${divider2}\u250C${leftDashes}`;
  const labelSegment = color2(labelInner, activeThemeColors().accent);
  const right = `${divider2}${rightDashes}\u2510${RESET6}`;
  return maybeWithFrameBackground(`${left}${labelSegment}${right}`, paintBackground);
}
function renderBottomBorder(width, paintBackground) {
  if (width < 6) return maybeWithFrameBackground(color2("\u2500".repeat(width), activeThemeColors().divider), paintBackground);
  return maybeWithFrameBackground(color2(`\u2514${"\u2500".repeat(width - 2)}\u2518`, activeThemeColors().divider), paintBackground);
}
function wrapRow(inner, width, paintBackground) {
  const innerWidth = Math.max(0, width - 2);
  const fitted = fitAnsiToWidth(inner, innerWidth);
  const visible = visibleLength2(fitted);
  const pad = Math.max(0, innerWidth - visible);
  const padded = `${fitted}${" ".repeat(pad)}`;
  const divider2 = dividerFg();
  return maybeWithFrameBackground(`${divider2}\u2502${RESET6}${padded}${divider2}\u2502${RESET6}`, paintBackground);
}
function wrapActiveRow(inner, width, paintBackground, isFirstRow) {
  const innerWidth = Math.max(0, width - 2);
  const promptCells = 3;
  const contentWidth = Math.max(0, innerWidth - promptCells);
  const fitted = fitAnsiToWidth(inner, contentWidth);
  const visible = visibleLength2(fitted);
  const pad = Math.max(0, contentWidth - visible);
  const padded = `${fitted}${" ".repeat(pad)}`;
  const prompt = isFirstRow ? ` ${color2(">", activeThemeColors().accent)} ` : "   ";
  const divider2 = dividerFg();
  return maybeWithFrameBackground(`${divider2}\u2502${RESET6}${prompt}${padded}${divider2}\u2502${RESET6}`, paintBackground);
}
function centerRow(row3, width) {
  const visible = visibleLength2(row3);
  if (visible > width) return truncateToWidth4(row3, width, "\u2026");
  if (visible === width) return row3;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return `${" ".repeat(left)}${row3}${" ".repeat(right)}`;
}
function alignAutocompleteRow(row3, width, options) {
  if (width <= 0) return "";
  const left = options.splash ? Math.min(
    Math.max(0, Math.floor((width - Math.min(width, options.frameWidth ?? width)) / 2) + 1),
    Math.max(0, width - 1)
  ) : Math.min(ACTIVE_AUTOCOMPLETE_LEFT_OFFSET, Math.max(0, width - 1));
  const frameContentWidth = options.splash ? Math.max(0, Math.min(width, options.frameWidth ?? width) - 2) : void 0;
  const available = Math.max(0, Math.min(width - left, frameContentWidth ?? width));
  const fitted = fitAnsiToWidth(row3, available);
  const pad = Math.max(0, width - left - visibleLength2(fitted));
  return `${" ".repeat(left)}${fitted}${" ".repeat(pad)}`;
}
function isPiBorderRow(row3) {
  const stripped = row3.replace(ANSI_PATTERN3, "").trimEnd();
  if (stripped.length === 0) return false;
  if (/^─+$/.test(stripped)) return true;
  if (/^─+\s*[↑↓]\s*\d+\s*more\s*─+$/.test(stripped)) return true;
  return false;
}
var CathedralEditor = class extends CustomEditor {
  constructor(cathedralTui, theme, keybindings, isSplash) {
    super(cathedralTui, theme, keybindings);
    this.cathedralTui = cathedralTui;
    this.isSplash = isSplash;
    unsafeCast(this).handlePaste = this.cathedralHandlePaste;
    delete this.onSubmit;
    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      get: () => this.submitHandler,
      set: (handler) => {
        this.submitHandler = handler ? (text) => {
          handler(this.imageDraftState.expandTokensToPaths(text));
          this.imageDraftState.clear();
        } : void 0;
      }
    });
    setActiveEditorDraftController({
      hasDraft: () => this.getText().length > 0,
      clearDraft: () => {
        this.setText("");
        this.imageDraftState.clear();
        this.cathedralTui.requestRender();
      }
    });
  }
  cathedralTui;
  isSplash;
  lastPrintableInputAt = 0;
  imageDraftState = new EditorImageDraftState();
  submitHandler;
  insertTextAtCursor(text) {
    if (this.collapseImagePath(text)) return;
    super.insertTextAtCursor(text);
  }
  /**
   * Collapse a pasted/dropped image path into an `[Image N]` token. Returns
   * true when the text was consumed. Candidates are normalized first
   * (surrounding quotes stripped, `\ ` escapes unescaped) so terminal
   * drag/paste forms of paths with spaces still collapse and the draft
   * state stores the real on-disk path.
   */
  /**
   * Expand `[Image N]` draft tokens to their temp-file paths WITHOUT clearing
   * the draft state. Used by queue-time consumers (Alt+Enter follow-up
   * queueing) that must capture real paths before the editor is cleared, but
   * only commit the clear once the queue accepts the message — a busy→idle
   * race can decline the queue, and clearing early would leave dangling
   * tokens in the editor. The Enter-submit wrapper above stays atomic
   * (expand + clear).
   */
  expandDraftTokens(text) {
    return this.imageDraftState.expandTokensToPaths(text);
  }
  /** Commit-side of {@link expandDraftTokens}: clear the image draft state. */
  clearImageDrafts() {
    this.imageDraftState.clear();
  }
  collapseImagePath(text) {
    const candidate = normalizePastedImagePath(text);
    if (!isLikelyClipboardImagePath(candidate)) return false;
    const token = this.imageDraftState.addImage(candidate);
    super.insertTextAtCursor(token);
    this.cathedralTui.requestRender();
    return true;
  }
  /**
   * Bracketed-paste interception. Terminal paste (Cmd+V) and file drops
   * arrive as bracketed paste and flow through pi-tui `Editor.handlePaste`
   * → `insertTextAtCursorInternal`, BYPASSING the public
   * `insertTextAtCursor` override above — so image paths pasted that way
   * splattered as raw text. `handlePaste` is declared private in pi-tui's
   * d.ts but is a regular prototype method at runtime; this instance
   * property shadows it (`this.handlePaste(...)` inside Editor.handleInput
   * resolves to the instance property first). Kept as an assigned arrow
   * rather than a method declaration because TypeScript refuses subclass
   * overrides of private-declared members.
   */
  cathedralHandlePaste = (pastedText) => {
    if (this.collapseImagePath(pastedText)) return;
    unsafeCast(CustomEditor.prototype).handlePaste.call(this, pastedText);
  };
  handleInput(data) {
    const now = Date.now();
    if (data === "\r" && now - this.lastPrintableInputAt <= RAW_PASTE_CR_WINDOW_MS) {
      super.handleInput("\n");
      return;
    }
    const presses = countLegacyModifierEnterPresses(data);
    if (presses > 0) {
      for (let press = 0; press < presses; press += 1) super.handleInput(CSI_U_SHIFT_ENTER);
      return;
    }
    const normalized = normalizeRawMultilinePasteInput(data);
    if (/[^\x00-\x1f\x7f]/.test(normalized)) this.lastPrintableInputAt = now;
    super.handleInput(normalized);
    this.imageDraftState.pruneMissingTokens(this.getText());
    this.maybeTriggerMidLineSlashMenu(data);
  }
  /**
   * pi-tui auto-triggers the slash menu only when "/" starts the message; a
   * "/" typed after whitespace MID-sentence never opens it. Its trigger-
   * character API explicitly rejects "/", so nudge the private trigger
   * directly (same precedent as the handlePaste shadow above). This only
   * OPENS the menu — serving mid-line command suggestions is the
   * autocomplete provider's job (see rpc/editor.ts); providers without
   * mid-line support return null and the nudge is a harmless no-op.
   * A "/" inside a token (e.g. "src/foo") does not trigger: the character
   * before it must be whitespace.
   */
  maybeTriggerMidLineSlashMenu(data) {
    if (data !== "/") return;
    const internals = unsafeCast(this);
    if (internals.autocompleteState) return;
    const { line, col } = this.getCursor();
    const textBeforeCursor = (this.getText().split("\n")[line] ?? "").slice(0, col);
    if (!textBeforeCursor.endsWith("/")) return;
    const beforeSlash = textBeforeCursor.slice(0, -1);
    if (beforeSlash.length === 0) return;
    const boundary = beforeSlash[beforeSlash.length - 1];
    if (boundary !== " " && boundary !== "	") return;
    internals.tryTriggerAutocomplete();
  }
  visibleRowSourceRanges(layoutWidth, visibleRowCount) {
    const internals = unsafeCast(this);
    const layoutRows = internals.layoutText(layoutWidth);
    const allRanges = [];
    let layoutIndex = 0;
    let lineOffset = 0;
    for (const line of this.getLines()) {
      let lineIndex = 0;
      do {
        const chunk = layoutRows[layoutIndex++];
        if (!chunk) break;
        const end = Math.min(line.length, lineIndex + chunk.text.length);
        allRanges.push({ start: lineOffset + lineIndex, end: lineOffset + end });
        lineIndex = end;
        if (chunk.text.length === 0 && line.length > 0) lineIndex = line.length;
      } while (lineIndex < line.length);
      lineOffset += line.length + 1;
    }
    return allRanges.slice(internals.scrollOffset, internals.scrollOffset + visibleRowCount);
  }
  render(width) {
    if (width < 8) return super.render(width);
    const splash = this.isSplash();
    const frameWidth = splash ? Math.min(width, SPLASH_INPUT_FRAME_WIDTH2) : width;
    const piContentWidth = splash ? frameWidth - 2 : frameWidth - 5;
    const innerRows = super.render(Math.max(1, piContentWidth));
    if (innerRows.length === 0) return innerRows;
    const fullRow = (row3) => splash ? centerRow(row3, width) : row3;
    const label = splash ? INPUT_FRAME_LABEL_SPLASH : INPUT_FRAME_LABEL_ACTIVE;
    const paintFrameBackground = !splash;
    let bottomIdx = -1;
    for (let i = 1; i < innerRows.length; i++) {
      if (isPiBorderRow(innerRows[i])) {
        bottomIdx = i;
        break;
      }
    }
    const text = this.getText();
    const showPlaceholder = splash && text.length === 0;
    const lastContentIdx = bottomIdx === -1 ? innerRows.length : bottomIdx;
    const contentRows = innerRows.slice(1, lastContentIdx);
    const visibleSourceRanges = this.visibleRowSourceRanges(Math.max(1, piContentWidth - 1), contentRows.length);
    const decoratedContentRows = showPlaceholder ? contentRows : formatInlineSkillRowsForEditor(contentRows, void 0, { text, rows: visibleSourceRanges });
    const renderContent = (row3, isFirstContent) => {
      if (showPlaceholder && isFirstContent) {
        const prompt = ` ${color2(">", activeThemeColors().accent)} ${CURSOR_MARKER}`;
        const maxPlaceholder = Math.max(0, frameWidth - 2 - visibleLength2(prompt));
        const placeholder = ellipsize2(INPUT_FRAME_PLACEHOLDER, maxPlaceholder);
        const ghost = `${prompt}${color2(placeholder, activeThemeColors().foregroundDim)}`;
        return fullRow(wrapRow(ghost, frameWidth, paintFrameBackground));
      }
      if (!splash) return wrapActiveRow(row3, frameWidth, paintFrameBackground, isFirstContent);
      return fullRow(wrapRow(row3, frameWidth, paintFrameBackground));
    };
    const result = [fullRow(renderTopBorder(frameWidth, label, paintFrameBackground))];
    let contentSeen = false;
    for (const row3 of decoratedContentRows) {
      result.push(renderContent(row3, !contentSeen));
      contentSeen = true;
    }
    result.push(fullRow(renderBottomBorder(frameWidth, paintFrameBackground)));
    if (bottomIdx !== -1) {
      for (let i = bottomIdx + 1; i < innerRows.length; i++) {
        result.push(alignAutocompleteRow(innerRows[i], width, { splash, frameWidth }));
      }
    }
    return result;
  }
};
function createCathedralEditor(tui, theme, keybindings, options = {}) {
  return new CathedralEditor(tui, theme, keybindings, options.isSplash ?? (() => false));
}
function sessionHasMessages4(ctx) {
  try {
    return sessionHasMessages(ctx);
  } catch {
    return false;
  }
}
function unsafeCast(...[value]) {
  return value;
}
function installCathedralEditor(pi) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.getEditorComponent?.();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      return createCathedralEditor(tui, theme, keybindings, { isSplash: () => !sessionHasMessages4(ctx) });
    });
  });
}

// src/commands/reload.ts
import { writeFileSync as writeFileSync2 } from "node:fs";
var SUMOCODE_RELOAD_EXIT_CODE = 100;
var FLUSH_DELAY_MS = 60;
function defaultDelay(ms) {
  return new Promise((resolve10) => setTimeout(resolve10, ms));
}
async function executeSumoReload(ctx, deps = {}) {
  const env = deps.env ?? process.env;
  const exit = deps.exit ?? ((code) => process.exit(code));
  const delay = deps.delay ?? defaultDelay;
  if (!env.SUMOCODE_LAUNCHER) {
    ctx.ui.notify(
      "reload needs the bin/sumocode.sh launcher; please rerun via `sumocode` or quit + relaunch",
      "warning"
    );
    return;
  }
  ctx.ui.notify("hard reloading SumoCode\u2026", "info");
  await delay(FLUSH_DELAY_MS);
  exit(SUMOCODE_RELOAD_EXIT_CODE);
}
function registerSumoReloadCommand(pi, deps = {}) {
  pi.on("session_start", () => {
    const env = deps.env ?? process.env;
    const readyFile = env.SUMOCODE_RELOAD_READY_FILE;
    if (!readyFile || env.SUMOCODE_RPC_CHILD === "1") return;
    try {
      writeFileSync2(readyFile, "ready", { mode: 384 });
    } catch {
    }
  });
  pi.registerCommand("reload", {
    description: "Reload SumoCode source and resume this session",
    handler: async (_args, ctx) => {
      await executeSumoReload(ctx, deps);
    }
  });
}

// src/commands/roles.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync5, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2 } from "node:path";

// src/subagents/roles.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join4 } from "node:path";
var MAX_ROLES_FILE_BYTES = 256 * 1024;
var THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
var ROLE_FIELDS = /* @__PURE__ */ new Set(["id", "label", "description", "systemPrompt", "model", "thinking", "tools", "defaultWorktree", "defaultVisible"]);
var BUILT_IN_ROLES = [
  {
    id: "research",
    label: "Research",
    description: "use proactively for read-only investigation and evidence gathering",
    systemPrompt: "act as a read-only investigator. never modify files. answer with evidence using file:line references or urls. state what was not checked. report findings only, not fixes.",
    tools: ["read", "grep", "find", "ls", "bash"]
  },
  {
    id: "review",
    label: "Review",
    description: "use for evidence-backed technical review of a bounded change",
    systemPrompt: "review like a tech lead. verify claims by opening cited code. report findings ordered by severity with file:line evidence. never edit files. flag out-of-scope diff hunks explicitly.",
    tools: ["read", "grep", "find", "ls", "bash"]
  },
  {
    id: "documentor",
    label: "Documentor",
    description: "use for writing or updating repository documentation",
    systemPrompt: "write or update documentation only. match the repository's existing documentation voice and structure. never change source code semantics. list every file touched.",
    defaultWorktree: true
  },
  {
    id: "designer",
    label: "Designer",
    description: "use for ui and ux changes that require visual review evidence",
    systemPrompt: "perform ui and ux work. read the repository's design conventions and visual specifications before changing any surface. produce capture and review evidence for visual changes. never promote goldens.",
    defaultWorktree: true
  },
  {
    id: "implement-cheap",
    label: "Implement Cheap",
    description: "use for a precise, fully specified implementation slice or verification run",
    systemPrompt: "implement exactly the specified slice. make the smallest diff that passes verification. run the named verification commands. if the specification is ambiguous, stop and report instead of improvising.",
    thinking: "low",
    defaultWorktree: true
  },
  {
    id: "implement-smart",
    label: "Implement Smart",
    description: "use for a bounded implementation slice that needs judgment or tradeoffs mid-flight",
    systemPrompt: "implement with judgment. keep scope tight. document tradeoffs made. run full relevant verification.",
    thinking: "high",
    defaultWorktree: true
  }
];
function resolveRolesPath(env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join4(homedir5(), ".pi", "agent");
  return join4(agentDir, "sumocode", "roles.json");
}
var isRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var hasOwn = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
var isThinking = (value) => THINKING_LEVELS.includes(value);
function normalizedOverlay(value, index, builtIn, warnings) {
  if (!isRecord2(value)) {
    warnings.push(`roles[${index}] must be an object; entry skipped`);
    return void 0;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    warnings.push(`roles[${index}] has an invalid id; entry skipped`);
    return void 0;
  }
  if (!builtIn && (typeof value.label !== "string" || !value.label.trim() || typeof value.systemPrompt !== "string" || !value.systemPrompt.trim())) {
    warnings.push(`role ${id} is new and requires label and systemPrompt; entry skipped`);
    return void 0;
  }
  for (const field of Object.keys(value)) {
    if (!ROLE_FIELDS.has(field)) warnings.push(`role ${id} ignores unknown field ${field}`);
  }
  for (const field of ["label", "description", "systemPrompt"]) {
    if (hasOwn(value, field) && (typeof value[field] !== "string" || !value[field].trim())) {
      warnings.push(`role ${id} has an invalid ${field}; entry skipped`);
      return void 0;
    }
  }
  if (hasOwn(value, "model") && (typeof value.model !== "string" || !value.model.trim())) {
    warnings.push(`role ${id} has an invalid model; entry skipped`);
    return void 0;
  }
  if (hasOwn(value, "thinking") && (typeof value.thinking !== "string" || value.thinking !== "inherit" && !isThinking(value.thinking))) {
    warnings.push(`role ${id} has an invalid thinking level; entry skipped`);
    return void 0;
  }
  for (const field of ["defaultWorktree", "defaultVisible"]) {
    if (hasOwn(value, field) && typeof value[field] !== "boolean" && value[field] !== "inherit") {
      warnings.push(`role ${id} has an invalid ${field}; entry skipped`);
      return void 0;
    }
  }
  if (hasOwn(value, "tools") && !Array.isArray(value.tools) && value.tools !== "inherit") {
    warnings.push(`role ${id} has an invalid tools list; entry skipped`);
    return void 0;
  }
  const overlay = { id };
  for (const field of ["label", "description", "systemPrompt"]) {
    if (typeof value[field] === "string") overlay[field] = value[field];
  }
  if (hasOwn(value, "model")) overlay.model = value.model === "inherit" ? void 0 : value.model.trim();
  if (hasOwn(value, "thinking")) overlay.thinking = value.thinking === "inherit" ? void 0 : value.thinking;
  if (hasOwn(value, "defaultWorktree")) overlay.defaultWorktree = value.defaultWorktree === "inherit" ? void 0 : value.defaultWorktree;
  if (hasOwn(value, "defaultVisible")) overlay.defaultVisible = value.defaultVisible === "inherit" ? void 0 : value.defaultVisible;
  if (value.tools === "inherit") overlay.tools = void 0;
  else if (Array.isArray(value.tools)) {
    const tools = [];
    for (const tool of value.tools) {
      if (typeof tool !== "string" || !BUILT_IN_TOOLS.includes(tool)) {
        warnings.push(`role ${id} ignores invalid tool ${String(tool)}`);
        continue;
      }
      if (!tools.includes(tool)) tools.push(tool);
    }
    overlay.tools = tools;
  }
  return overlay;
}
function loadRoles(dependencies = {}) {
  const readFile = dependencies.readFile ?? readFileSync4;
  const path2 = resolveRolesPath(dependencies.env);
  let contents;
  try {
    contents = readFile(path2, "utf8");
  } catch (error) {
    const code = isRecord2(error) && typeof error.code === "string" ? error.code : void 0;
    return code === "ENOENT" ? { roles: BUILT_IN_ROLES, warnings: [] } : { roles: BUILT_IN_ROLES, warnings: [`unable to read roles.json: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_ROLES_FILE_BYTES) {
    return { roles: BUILT_IN_ROLES, warnings: ["roles.json exceeds 256 KB; using built-in roles"] };
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return { roles: BUILT_IN_ROLES, warnings: [`invalid roles.json: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isRecord2(parsed) || !Array.isArray(parsed.roles)) {
    return { roles: BUILT_IN_ROLES, warnings: ["roles.json must contain a roles array; using built-in roles"] };
  }
  const warnings = [];
  const roles = BUILT_IN_ROLES.map((role) => ({ ...role }));
  for (let index = 0; index < parsed.roles.length; index += 1) {
    const raw = parsed.roles[index];
    const rawId = isRecord2(raw) && typeof raw.id === "string" ? raw.id.trim() : "";
    const roleIndex = roles.findIndex((role) => role.id === rawId);
    const overlay = normalizedOverlay(raw, index, roleIndex >= 0, warnings);
    if (!overlay) continue;
    if (roleIndex >= 0) {
      roles[roleIndex] = { ...roles[roleIndex], ...overlay };
      continue;
    }
    roles.push((() => {
      const role = {
        id: overlay.id,
        label: overlay.label,
        description: overlay.description ?? "use for a custom operator-defined delegation role",
        systemPrompt: overlay.systemPrompt
      };
      if (hasOwn(overlay, "model")) role.model = overlay.model;
      if (overlay.thinking !== void 0) role.thinking = overlay.thinking;
      if (overlay.tools !== void 0) role.tools = overlay.tools;
      if (overlay.defaultWorktree !== void 0) role.defaultWorktree = overlay.defaultWorktree;
      if (overlay.defaultVisible !== void 0) role.defaultVisible = overlay.defaultVisible;
      return role;
    })());
  }
  return { roles, warnings };
}

// src/commands/roles-palette.ts
import { Key as Key3, matchesKey as matchesKey4 } from "@earendil-works/pi-tui";

// src/sumo-tui/render/primitives.ts
import { truncateToWidth as truncateToWidth5, visibleWidth as visibleWidth6 } from "@earendil-works/pi-tui";

// src/sumo-tui/render/cell.ts
var DEFAULT_CELL_ATTRS = Object.freeze({
  bold: false,
  italic: false,
  underline: false,
  dim: false,
  inverse: false
});
var BLANK_CELL = Object.freeze({
  char: " ",
  attrs: DEFAULT_CELL_ATTRS
});

// src/sumo-tui/render/primitives.ts
var SEGMENTER_CTOR = Intl.Segmenter;
var GRAPHEME_SEGMENTER = SEGMENTER_CTOR ? new SEGMENTER_CTOR(void 0, { granularity: "grapheme" }) : void 0;
var RESET7 = "\x1B[0m";
function parseHex(hex) {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return void 0;
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ];
}
function sgrForStyle(style) {
  let output = "";
  const attrs = [];
  if (style.bold) attrs.push("1");
  if (style.italic) attrs.push("3");
  if (style.underline) attrs.push("4");
  if (style.dim) attrs.push("2");
  if (style.inverse) attrs.push("7");
  if (attrs.length > 0) output += `\x1B[${attrs.join(";")}m`;
  const fg8 = style.fg ? parseHex(style.fg) : void 0;
  if (fg8) output += `\x1B[38;2;${fg8[0]};${fg8[1]};${fg8[2]}m`;
  const bg2 = style.bg ? parseHex(style.bg) : void 0;
  if (bg2) output += `\x1B[48;2;${bg2[0]};${bg2[1]};${bg2[2]}m`;
  return output;
}
function mergeStyle(base, override) {
  if (!base && !override) return {};
  return {
    fg: override?.fg ?? base?.fg,
    bg: override?.bg ?? base?.bg,
    bold: override?.bold ?? base?.bold,
    italic: override?.italic ?? base?.italic,
    underline: override?.underline ?? base?.underline,
    dim: override?.dim ?? base?.dim,
    inverse: override?.inverse ?? base?.inverse
  };
}
function hasStyle(style) {
  return style.fg !== void 0 || style.bg !== void 0 || style.bold === true || style.italic === true || style.underline === true || style.dim === true || style.inverse === true;
}
function isString2(value) {
  return typeof value === "string";
}
function toSpan(part) {
  return isString2(part) ? { text: part } : part;
}
function span(text, style) {
  return { text, style };
}
function textLine(parts = [], style) {
  return { spans: parts.map(toSpan), style };
}
function lineWidth(line) {
  return line.spans.reduce((width, part) => width + visibleWidth6(part.text), 0);
}
function truncateLine(line, width) {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return { spans: [], style: line.style };
  let remaining = safeWidth;
  const spans = [];
  for (const part of line.spans) {
    if (remaining <= 0) break;
    const partWidth = visibleWidth6(part.text);
    if (partWidth <= remaining) {
      spans.push(part);
      remaining -= partWidth;
      continue;
    }
    const truncated = truncateToWidth5(part.text, remaining, "");
    if (truncated.length > 0) spans.push({ ...part, text: truncated });
    remaining = 0;
  }
  return { spans, style: line.style };
}
function padLine(line, width, style) {
  const safeWidth = Math.max(0, Math.floor(width));
  const truncated = truncateLine(line, safeWidth);
  const padding = Math.max(0, safeWidth - lineWidth(truncated));
  if (padding === 0) return truncated;
  return {
    spans: [...truncated.spans, { text: " ".repeat(padding), style }],
    style: truncated.style
  };
}
function lineToAnsi(line, options = {}) {
  const prepared = options.width === void 0 ? line : padLine(line, options.width, options.style ?? line.style);
  const baseStyle = mergeStyle(options.style, prepared.style);
  let output = "";
  for (const part of prepared.spans) {
    if (part.text.length === 0) continue;
    const effectiveStyle = mergeStyle(baseStyle, part.style);
    if (hasStyle(effectiveStyle)) output += `${RESET7}${sgrForStyle(effectiveStyle)}`;
    else if (output.length > 0) output += RESET7;
    output += part.text;
  }
  return output.length === 0 ? "" : `${output}${RESET7}`;
}

// src/commands/roles-palette.ts
var HINT_ROW = "\u2191\u2193 wander    \u238F filter    \u23CE attend    \u238B retreat";
var MAX_VISIBLE_ROWS = 9;
var ROLES_PALETTE_OVERLAY_OPTIONS = {
  anchor: "center",
  width: 80,
  minWidth: 50,
  maxHeight: 20
};
function panelStyle() {
  const colors = activeThemeColors();
  return { fg: colors.foreground, bg: colors.surfaceLifted };
}
function colored(text, fg8) {
  return span(text, { fg: fg8 });
}
function dim2(text) {
  return colored(text, activeThemeColors().foregroundDim);
}
function accent2(text) {
  return colored(text, activeThemeColors().accent);
}
function dividerText(text) {
  return colored(text, activeThemeColors().divider);
}
function foreground(text) {
  return colored(text, activeThemeColors().foreground);
}
function cursorCell() {
  const colors = activeThemeColors();
  return span(" ", { fg: colors.background, bg: colors.accent });
}
function panelLine(parts, width) {
  const style = panelStyle();
  return lineToAnsi(textLine(parts, style), { width, style });
}
function centered(parts, width) {
  const content = truncateLine(textLine(parts), width);
  const contentWidth = lineWidth(content);
  const left = Math.floor((width - contentWidth) / 2);
  const right = width - contentWidth - left;
  return [" ".repeat(left), ...content.spans, " ".repeat(right)];
}
function filterRows(rows, searchQuery) {
  const query = searchQuery.trim().toLowerCase();
  if (query.length === 0) return [...rows];
  return rows.filter((row3) => `${row3.label} ${row3.value}`.toLowerCase().includes(query));
}
function normalizedActiveIndex(state, rows) {
  if (rows.length === 0) return 0;
  return Math.min(Math.max(0, state.activeIndex), rows.length - 1);
}
function visibleRows(rows, activeIndex) {
  if (rows.length <= MAX_VISIBLE_ROWS) return { rows, offset: 0 };
  const maxOffset = rows.length - MAX_VISIBLE_ROWS;
  const offset = Math.min(maxOffset, Math.max(0, activeIndex - Math.floor(MAX_VISIBLE_ROWS / 2)));
  return { rows: rows.slice(offset, offset + MAX_VISIBLE_ROWS), offset };
}
function renderPalette(options, state, width) {
  const w = Math.max(1, Math.floor(width));
  const filtered = filterRows(state.rows, state.searchQuery);
  const active = normalizedActiveIndex(state, filtered);
  const window = visibleRows(filtered, active);
  const searchText = state.searchQuery.length > 0 ? state.searchQuery : options.placeholder;
  const halfRule = "\u2500".repeat(22);
  const lines = [];
  lines.push(panelLine([], w));
  lines.push(panelLine(centered([accent2("\u273E"), "  ", accent2(options.title), "  ", accent2("\u273E")], w), w));
  lines.push(panelLine([], w));
  lines.push(panelLine(centered([dividerText(halfRule), "  ", dividerText("\xB7"), "  ", dividerText(halfRule)], w), w));
  lines.push(panelLine([], w));
  lines.push(panelLine(state.searchQuery.length > 0 ? ["     ", accent2("\u276F"), "  ", foreground(searchText), cursorCell()] : ["     ", accent2("\u276F"), "  ", cursorCell(), dim2(searchText)], w));
  lines.push(panelLine([], w));
  if (filtered.length === 0) {
    lines.push(panelLine(["     ", dividerText("\xB7"), "   ", dim2("no matching option")], w));
  } else {
    for (const [visibleIndex, row3] of window.rows.entries()) {
      const focused = visibleIndex + window.offset === active;
      const marker = focused ? accent2("\u2748") : dividerText("\xB7");
      const label = focused ? foreground(row3.label) : dim2(row3.label);
      const value = focused ? foreground(row3.value) : dim2(row3.value);
      const left = textLine(["     ", marker, "   ", label]);
      const padBetween = Math.max(2, w - lineWidth(left) - lineWidth(textLine([value])) - 5);
      lines.push(panelLine([...left.spans, " ".repeat(padBetween), value], w));
    }
  }
  lines.push(panelLine([], w));
  lines.push(panelLine(centered([dividerText(halfRule), "  ", dividerText("\xB7"), "  ", dividerText(halfRule)], w), w));
  lines.push(panelLine(centered([dim2(HINT_ROW)], w), w));
  lines.push(panelLine([], w));
  return lines;
}
function keyEq(data, ...ids) {
  for (const id of ids) {
    if (data === id) return true;
    if (matchesKey4(data, id)) return true;
  }
  return false;
}
function updatePaletteState(state, data) {
  const rows = filterRows(state.rows, state.searchQuery);
  const active = normalizedActiveIndex(state, rows);
  if (keyEq(data, Key3.escape, Key3.esc)) return { state, done: true, selection: void 0 };
  if (keyEq(data, Key3.enter, Key3.return)) {
    return { state: { ...state, activeIndex: active }, done: true, selection: rows[active]?.id };
  }
  if (keyEq(data, Key3.down, Key3.tab)) {
    return { state: { ...state, activeIndex: rows.length === 0 ? 0 : (active + 1) % rows.length } };
  }
  if (keyEq(data, Key3.up, Key3.shift(Key3.tab))) {
    return { state: { ...state, activeIndex: rows.length === 0 ? 0 : (active - 1 + rows.length) % rows.length } };
  }
  if (keyEq(data, Key3.backspace)) {
    return { state: { ...state, searchQuery: state.searchQuery.slice(0, -1), activeIndex: 0 } };
  }
  if (data.length === 1 && !new RegExp("\\p{Cc}", "u").test(data)) {
    return { state: { ...state, searchQuery: `${state.searchQuery}${data}`, activeIndex: 0 } };
  }
  return { state: { ...state, activeIndex: active } };
}
var SearchPaletteComponent = class {
  constructor(options, state, done) {
    this.options = options;
    this.state = state;
    this.done = done;
  }
  options;
  state;
  done;
  invalidate() {
  }
  handleInput(data) {
    const result = updatePaletteState(this.state, data);
    this.state = result.state;
    if (result.done) this.done(result.selection);
  }
  render(width) {
    return renderPalette(this.options, this.state, width);
  }
};
function rowLabel(row3) {
  return row3.value.length > 0 ? `${row3.label}  ${row3.value}` : row3.label;
}
async function showSearchPalette(ctx, options) {
  if (ctx.mode === "rpc") {
    const labels = options.rows.map(rowLabel);
    const selected = await ctx.ui.select(options.title, labels);
    const selectedIndex = selected === void 0 ? -1 : labels.indexOf(selected);
    return selectedIndex < 0 ? void 0 : options.rows[selectedIndex]?.id;
  }
  return ctx.ui.custom(
    (_tui, _theme, _keybindings, done) => new SearchPaletteComponent(options, {
      searchQuery: "",
      activeIndex: 0,
      rows: options.rows
    }, done),
    { overlay: true, overlayOptions: ROLES_PALETTE_OVERLAY_OPTIONS }
  );
}

// src/commands/roles.ts
var READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];
var THINKING_LEVELS2 = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
var errorText = (error) => error instanceof Error ? error.message : String(error);
async function writeMutation(deps, mutation) {
  try {
    await deps.writeRolesFile(mutation);
    return void 0;
  } catch (error) {
    return { kind: "error", opened: false, message: `unable to update roles.json: ${errorText(error)}` };
  }
}
function sameTools(actual, expected) {
  return actual.length === expected.length && actual.every((tool, index) => tool === expected[index]);
}
function toolsValue(role) {
  if (!role.tools) return "inherit parent";
  if (sameTools(role.tools, READ_ONLY_TOOLS)) return "read-only";
  if (sameTools(role.tools, BUILT_IN_TOOLS)) return "full built-in set";
  return role.tools.join(", ");
}
function booleanValue(value) {
  return value === void 0 ? "inherit default" : String(value);
}
function systemPromptValue(role) {
  const builtIn = BUILT_IN_ROLES.find((candidate) => candidate.id === role.id);
  return builtIn?.systemPrompt === role.systemPrompt ? "(built-in)" : "(custom)";
}
function roleFieldId(roleId, field) {
  return `field:${roleId}:${field}`;
}
function roleSummary(role) {
  const worktree = role.defaultWorktree === true ? "worktree" : role.defaultWorktree === false ? "no worktree" : "inherit wt";
  return `${role.model ?? "inherit"} \xB7 ${role.thinking ?? "inherit"} \xB7 ${worktree}`;
}
function roleListRows(roles) {
  return roles.map((role) => ({ id: `role:${role.id}`, label: role.id, value: roleSummary(role) }));
}
function roleFieldRows(role) {
  const rows = [];
  const selections = /* @__PURE__ */ new Map();
  const add = (field, label, value) => {
    const id = roleFieldId(role.id, field);
    rows.push({ id, label, value });
    selections.set(id, { role, field });
  };
  add("model", "model", role.model ?? "inherit");
  add("thinking", "thinking", role.thinking ?? "inherit");
  add("tools", "tools", toolsValue(role));
  add("worktree", "worktree", booleanValue(role.defaultWorktree));
  add("visible", "visible", booleanValue(role.defaultVisible));
  add("systemPrompt", "system prompt", systemPromptValue(role));
  return { rows, selections };
}
function pickerRows(values) {
  return values.map((value) => ({ id: value, label: value, value: "" }));
}
function modelValue(model) {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}
async function chooseMutation(deps, selection) {
  const { role, field } = selection;
  if (field === "model") {
    const models = deps.getAvailableModels();
    const rows = [
      { id: "inherit", label: "inherit", value: "use parent session's model" },
      ...models.map((model2, index) => ({ id: `registry:${index}`, label: model2.id, value: model2.provider ?? "" })),
      { id: "other", label: "other", value: "type provider/modelId\u2026" }
    ];
    const selected = await deps.showPalette({ title: `${role.id.toUpperCase()} MODEL`, placeholder: "choose a model\u2026", rows });
    if (selected === void 0) return void 0;
    if (selected === "inherit") return { kind: "set", roleId: role.id, field: "model", value: "inherit" };
    if (selected === "other") {
      const model2 = await deps.input("model (provider/modelId)", role.model ?? "");
      if (model2 === void 0 || !model2.trim()) return void 0;
      return { kind: "set", roleId: role.id, field: "model", value: model2.trim() };
    }
    const model = models[Number(selected.replace("registry:", ""))];
    return model ? { kind: "set", roleId: role.id, field: "model", value: modelValue(model) } : void 0;
  }
  if (field === "thinking") {
    const thinking2 = await deps.showPalette({ title: `${role.id.toUpperCase()} THINKING`, placeholder: "choose a thinking level\u2026", rows: pickerRows(THINKING_LEVELS2) });
    return thinking2 === void 0 ? void 0 : { kind: "set", roleId: role.id, field: "thinking", value: thinking2 };
  }
  if (field === "tools") {
    const tools = await deps.showPalette({
      title: `${role.id.toUpperCase()} TOOLS`,
      placeholder: "choose a tool policy\u2026",
      rows: pickerRows(["inherit parent", "read-only (read, grep, find, ls, bash)", "full built-in set"])
    });
    if (tools === void 0) return void 0;
    return {
      kind: "set",
      roleId: role.id,
      field: "tools",
      value: tools === "inherit parent" ? "inherit" : tools.startsWith("read-only") ? [...READ_ONLY_TOOLS] : [...BUILT_IN_TOOLS]
    };
  }
  if (field === "worktree" || field === "visible") {
    const value = await deps.showPalette({
      title: `${role.id.toUpperCase()} ${field.toUpperCase()}`,
      placeholder: "choose a default\u2026",
      rows: pickerRows(["inherit default", "true", "false"])
    });
    return value === void 0 ? void 0 : {
      kind: "set",
      roleId: role.id,
      field: field === "worktree" ? "defaultWorktree" : "defaultVisible",
      value: value === "inherit default" ? "inherit" : value === "true"
    };
  }
  return void 0;
}
var successResult = (opened) => ({
  kind: "success",
  opened,
  message: "role updated \u2014 applies to the next spawn"
});
async function runRolesCommand(deps) {
  if (!deps.isTTY) {
    return {
      kind: "instructions",
      opened: false,
      message: `roles file: ${deps.rolesPath} \u2014 edit it directly; changes apply to the next spawn`
    };
  }
  let latestResult;
  while (true) {
    const roles = deps.loadRoles().roles;
    const selectedRole = await deps.showPalette({
      title: "SUBAGENT ROLES",
      placeholder: "which role shall we attend to\u2026",
      rows: roleListRows(roles)
    });
    if (selectedRole === void 0) return latestResult;
    const roleId = selectedRole.startsWith("role:") ? selectedRole.slice("role:".length) : void 0;
    const role = roles.find((candidate) => candidate.id === roleId);
    if (!role) continue;
    while (true) {
      const surface = roleFieldRows(deps.loadRoles().roles.find((candidate) => candidate.id === role.id) ?? role);
      const selected = await deps.showPalette({
        title: `ROLE \u2014 ${role.id.toUpperCase()}`,
        placeholder: "what shall we tune\u2026",
        rows: surface.rows
      });
      if (selected === void 0) break;
      const fieldSelection = surface.selections.get(selected);
      if (!fieldSelection) break;
      if (fieldSelection.field === "systemPrompt") {
        latestResult = {
          kind: "instructions",
          opened: false,
          message: `role system prompts live in ${deps.rolesPath} under "systemPrompt" \u2014 edit the file directly; changes apply to the next spawn`
        };
        continue;
      }
      const mutation = await chooseMutation(deps, fieldSelection);
      if (!mutation) continue;
      const failed = await writeMutation(deps, mutation);
      if (failed) return failed;
      latestResult = successResult(false);
    }
  }
}
function readRolesDocument(path2) {
  if (!existsSync2(path2)) return { roles: [] };
  const parsed = JSON.parse(readFileSync5(path2, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.roles)) {
    throw new Error("roles.json must contain a roles array");
  }
  const roles = parsed.roles;
  if (!roles.every((entry) => typeof entry === "object" && entry !== null && typeof entry.id === "string")) {
    throw new Error("roles.json contains an invalid role entry");
  }
  return parsed;
}
function writeRolesFile(path2, mutation) {
  const document = readRolesDocument(path2);
  const overlay = document.roles.find((role) => role.id === mutation.roleId);
  if (overlay && mutation.value === void 0) delete overlay[mutation.field];
  else if (overlay) overlay[mutation.field] = mutation.value;
  else document.roles.push({ id: mutation.roleId, [mutation.field]: mutation.value });
  mkdirSync3(dirname2(path2), { recursive: true });
  writeFileSync3(path2, `${JSON.stringify(document, null, 2)}
`, { mode: 384 });
}
function notify2(ctx, result) {
  const type = result.kind === "error" ? "error" : "info";
  if (ctx.hasUI) {
    ctx.ui.notify(result.message, type);
    return;
  }
  const stream = type === "error" ? process.stderr : process.stdout;
  stream.write(`${result.message}
`);
}
function registerRolesCommand(pi) {
  pi.registerCommand("sumo:roles", {
    description: "Edit subagent role presets",
    handler: async (_args, ctx) => {
      const path2 = resolveRolesPath();
      try {
        const result = await runRolesCommand({
          rolesPath: path2,
          isTTY: ctx.hasUI,
          loadRoles,
          writeRolesFile: (mutation) => writeRolesFile(path2, mutation),
          showPalette: (options) => showSearchPalette(ctx, options),
          getAvailableModels: () => ctx.modelRegistry.getAvailable().map((model) => ({ id: model.id, provider: model.provider })),
          input: (title, placeholder) => ctx.ui.input(title, placeholder)
        });
        if (result) notify2(ctx, result);
      } catch (error) {
        notify2(ctx, { kind: "error", opened: false, message: `unable to edit roles: ${errorText(error)}` });
      }
    }
  });
}

// src/command-palette.ts
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Key as Key4, matchesKey as matchesKey5, truncateToWidth as truncateToWidth6, visibleWidth as visibleWidth7 } from "@earendil-works/pi-tui";
var COMMAND_PALETTE_HINT_ROW = "\u2191\u2193 wander    \u23CE attend    \u238B retreat";
var COMMAND_PALETTE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
var COMMAND_PALETTE_SHORTCUT = "ctrl+/";
var COMMAND_PALETTE_OVERLAY_OPTIONS = {
  anchor: "center",
  width: 80,
  minWidth: 50,
  maxHeight: 20
};
var RESET8 = "\x1B[0m";
var FG_RESET2 = "\x1B[39m";
function panelBg() {
  return activeThemeColors().surfaceLifted;
}
function paletteDivider() {
  return activeThemeColors().divider;
}
function ansiColor(hex, channel) {
  const normalized = hex.replace("#", "");
  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  return `\x1B[${channel};2;${red};${green};${blue}m`;
}
function fg5(text, hex) {
  return `${ansiColor(hex, 38)}${text}${FG_RESET2}`;
}
function dim3(text) {
  return fg5(text, activeThemeColors().foregroundDim);
}
function accent3(text) {
  return fg5(text, activeThemeColors().accent);
}
function dividerText2(text) {
  return fg5(text, paletteDivider());
}
function foreground2(text) {
  return fg5(text, activeThemeColors().foreground);
}
function cursorCell2() {
  return `${ansiColor(activeThemeColors().accent, 48)}${ansiColor(activeThemeColors().background, 38)} ${FG_RESET2}${ansiColor(panelBg(), 48)}`;
}
function padToWidth(text, width) {
  const len = visibleWidth7(text);
  if (len >= width) return truncateToWidth6(text, width, "");
  return `${text}${" ".repeat(width - len)}`;
}
function panelLine2(text, width) {
  return `${ansiColor(panelBg(), 48)}${ansiColor(activeThemeColors().foreground, 38)}${padToWidth(text, width)}${RESET8}`;
}
function center2(text, width) {
  const len = visibleWidth7(text);
  if (len >= width) return truncateToWidth6(text, width, "");
  const left = Math.floor((width - len) / 2);
  const right = width - len - left;
  return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}
function filterPaletteRows(rows, searchQuery) {
  const query = searchQuery.trim().toLowerCase();
  if (query.length === 0) return [...rows];
  return rows.filter((row3) => row3.label.toLowerCase().includes(query));
}
function normalizedActiveIndex2(snapshot, rows) {
  if (rows.length === 0) return 0;
  return Math.min(Math.max(0, snapshot.activeIndex), rows.length - 1);
}
function renderCommandPalette(snapshot, width, renderOptions = {}) {
  const w = Math.max(1, Math.floor(width));
  const rows = renderOptions.prefiltered ? [...snapshot.rows] : filterPaletteRows(snapshot.rows, snapshot.searchQuery);
  const active = normalizedActiveIndex2(snapshot, rows);
  const searchText = snapshot.searchQuery.length > 0 ? snapshot.searchQuery : renderOptions.placeholder ?? "what shall we attend to\u2026";
  const halfRule = "\u2500".repeat(22);
  const lines = [];
  lines.push(panelLine2("", w));
  lines.push(panelLine2(center2(`${accent3("\u273E")}  ${accent3(renderOptions.title ?? "COMMAND PALETTE")}  ${accent3("\u273E")}`, w), w));
  lines.push(panelLine2("", w));
  lines.push(panelLine2(center2(`${dividerText2(halfRule)}  ${dividerText2("\xB7")}  ${dividerText2(halfRule)}`, w), w));
  lines.push(panelLine2("", w));
  lines.push(panelLine2(snapshot.searchQuery.length > 0 ? `     ${accent3("\u276F")}  ${foreground2(searchText)}${cursorCell2()}` : `     ${accent3("\u276F")}  ${cursorCell2()}${dim3(searchText)}`, w));
  lines.push(panelLine2("", w));
  if (rows.length === 0) {
    lines.push(panelLine2(`     ${dividerText2("\xB7")}   ${dim3(renderOptions.emptyText ?? "no matching command")}`, w));
  } else {
    const cap = renderOptions.maxVisibleRows !== void 0 ? Math.max(1, renderOptions.maxVisibleRows) : rows.length;
    const offset = rows.length <= cap ? 0 : Math.min(rows.length - cap, Math.max(0, active - Math.floor(cap / 2)));
    const windowRows = rows.slice(offset, offset + cap);
    const hiddenAbove = offset;
    const hiddenBelow = rows.length - offset - windowRows.length;
    if (hiddenAbove > 0) lines.push(panelLine2(`         ${dim3(`\u2026 ${hiddenAbove} more`)}`, w));
    for (const [windowIndex, row3] of windowRows.entries()) {
      const index = windowIndex + offset;
      const focused = index === active;
      const marker = focused ? accent3("\u2748") : dividerText2("\xB7");
      const label = focused ? foreground2(row3.label) : dim3(row3.label);
      const value = displayPaletteValue(row3);
      const valueText = value.length > 0 ? focused ? foreground2(value) : dim3(value) : "";
      const left = `     ${marker}   ${label}`;
      const padBetween = Math.max(2, w - visibleWidth7(left) - visibleWidth7(valueText) - 5);
      lines.push(panelLine2(`${left}${" ".repeat(padBetween)}${valueText}`, w));
    }
    if (hiddenBelow > 0) lines.push(panelLine2(`         ${dim3(`\u2026 ${hiddenBelow} more`)}`, w));
  }
  lines.push(panelLine2("", w));
  lines.push(panelLine2(center2(`${dividerText2(halfRule)}  ${dividerText2("\xB7")}  ${dividerText2(halfRule)}`, w), w));
  lines.push(panelLine2(center2(dim3(COMMAND_PALETTE_HINT_ROW), w), w));
  lines.push(panelLine2("", w));
  return lines;
}
function displayPaletteValue(row3) {
  return row3.currentValue.replace(/^CURRENT:\s*/i, "").trim();
}
function keyEq2(data, ...ids) {
  for (const id of ids) {
    if (data === id) return true;
    if (matchesKey5(data, id)) return true;
  }
  return false;
}
function updateCommandPaletteSnapshot(snapshot, data) {
  const rows = filterPaletteRows(snapshot.rows, snapshot.searchQuery);
  const active = normalizedActiveIndex2(snapshot, rows);
  if (keyEq2(data, Key4.escape, Key4.esc)) {
    return { snapshot, done: true, selection: void 0 };
  }
  if (keyEq2(data, Key4.enter, Key4.return)) {
    return { snapshot: { ...snapshot, activeIndex: active }, done: true, selection: rows[active]?.label };
  }
  if (keyEq2(data, Key4.down)) {
    return { snapshot: { ...snapshot, activeIndex: Math.min(Math.max(0, rows.length - 1), active + 1) } };
  }
  if (keyEq2(data, Key4.up)) {
    return { snapshot: { ...snapshot, activeIndex: Math.max(0, active - 1) } };
  }
  if (keyEq2(data, Key4.backspace)) {
    return { snapshot: { ...snapshot, searchQuery: snapshot.searchQuery.slice(0, -1), activeIndex: 0 } };
  }
  if (data.length === 1 && !new RegExp("\\p{Cc}", "u").test(data)) {
    return { snapshot: { ...snapshot, searchQuery: `${snapshot.searchQuery}${data}`, activeIndex: 0 } };
  }
  return { snapshot: { ...snapshot, activeIndex: active } };
}
var CommandPaletteComponent = class {
  constructor(snapshot, done) {
    this.snapshot = snapshot;
    this.done = done;
  }
  snapshot;
  done;
  invalidate() {
  }
  handleInput(data) {
    const result = updateCommandPaletteSnapshot(this.snapshot, data);
    this.snapshot = result.snapshot;
    if (result.done) this.done(result.selection);
  }
  render(width) {
    return renderCommandPalette(this.snapshot, width);
  }
};
function buildPaletteSnapshot(ctx) {
  const sessionLabel = ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId().split("-")[0] ?? "current-session";
  const modelId = ctx.model?.id ?? "no-model";
  const thinkingLevel = ctx.getThinkingLevel?.() ?? "medium";
  const themeName = getActiveTheme().name;
  return {
    searchQuery: "",
    activeIndex: 1,
    rows: [
      { label: "SESSION", currentValue: sessionLabel },
      { label: "MODEL", currentValue: modelId },
      { label: "THINKING", currentValue: thinkingLevel },
      { label: "MEMORY", currentValue: "55 facts" },
      { label: "THEME", currentValue: themeName },
      { label: "SETTINGS", currentValue: "" }
    ]
  };
}
function thinkingLevelsForContext(ctx) {
  const model = ctx.model;
  if (!model) return COMMAND_PALETTE_THINKING_LEVELS;
  return getSupportedThinkingLevels(model);
}
async function handlePaletteSelection(mode, ctx, pi) {
  if (mode === void 0) return;
  if (mode === "SESSION") {
    ctx.ui.setEditorText("/sessions");
    return;
  }
  if (mode === "MODEL") {
    const models = ctx.modelRegistry.getAvailable();
    const selected = await showDivineQuery(ctx, "Choose a model", models.map((model2) => model2.id));
    const model = models.find((candidate) => candidate.id === selected);
    if (model) await pi.setModel(model);
    return;
  }
  if (mode === "THINKING") {
    const levels = thinkingLevelsForContext(ctx);
    const selected = await showDivineQuery(ctx, "Set thinking level", [...levels]);
    if (selected && levels.includes(selected)) {
      pi.setThinkingLevel(selected);
    }
    return;
  }
  if (mode === "MEMORY") {
    ctx.ui.setEditorText("/sumo:memory");
    return;
  }
  if (mode === "THEME") {
    const themes = ctx.ui.getAllThemes().map((theme) => theme.name);
    const selected = await showDivineQuery(ctx, "Choose a theme", themes);
    if (selected) ctx.ui.setTheme(selected);
    return;
  }
  if (mode === "SETTINGS") {
    ctx.ui.setEditorText("/settings");
    return;
  }
}
function installCommandPalette(pi) {
  pi.registerShortcut(COMMAND_PALETTE_SHORTCUT, {
    description: "Open SumoCode command palette",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      const selection = await ctx.ui.custom(
        (_tui, _theme, _keybindings, done) => (
          // SAFETY: the palette component receives the ctx surface it reads
          // (model/registry/thinking-level accessors) plus a getThinkingLevel
          // bound to the live Pi instance.
          new CommandPaletteComponent(
            buildPaletteSnapshot({ ...ctx, getThinkingLevel: () => pi.getThinkingLevel() }),
            done
          )
        ),
        { overlay: true, overlayOptions: COMMAND_PALETTE_OVERLAY_OPTIONS }
      );
      await handlePaletteSelection(selection, ctx, pi);
    }
  });
}

// src/commands/cursor.ts
function normalizeCursorCommand(args) {
  const value = args.trim().toLowerCase();
  if (value === "" || value === "status") return "status";
  if (["accent", "orange", "cathedral"].includes(value)) return "accent";
  if (["reset", "default", "system"].includes(value)) return "reset";
  return void 0;
}
function report(ctx, message, level = "info") {
  if (!ctx.hasUI) {
    process.stdout.write(`${message}
`);
    return;
  }
  ctx.ui.notify(message, level);
}
function registerCursorCommand(pi, terminalSession = defaultTerminalSessionOwner) {
  pi.registerCommand("sumo:cursor", {
    description: "Explicitly set or reset the terminal cursor color",
    handler: async (args, ctx) => {
      const mode = normalizeCursorCommand(args);
      if (mode === "accent") {
        terminalSession.setCursorColor(activeThemeColors().accent);
        report(ctx, "cursor color: theme accent", "info");
        return;
      }
      if (mode === "reset") {
        terminalSession.resetCursorColor();
        report(ctx, "cursor color: terminal default", "info");
        return;
      }
      if (mode === "status") {
        const state = terminalSession.getState();
        report(ctx, `cursor color: ${state.cursorColorOverridden ? "theme accent" : "terminal default"}`, "info");
        return;
      }
      report(ctx, "usage: /sumo:cursor accent|reset|status", "warning");
    }
  });
}

// src/terminal-host/shell-command.ts
function shellEscape(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function buildShellCommand(cwd, command) {
  const shellCommand = ["cd", shellEscape(cwd), "&&", command].join(" ");
  return ["bash", "-lc", shellEscape(shellCommand)].join(" ");
}

// src/terminal-host/detect.ts
function detectTerminalHost(env = process.env) {
  return env.HERDR_ENV === "1" && env.HERDR_PANE_ID ? "herdr" : "none";
}

// src/terminal-host/herdr.ts
function parseEnvelope(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return { ok: true, ...parsed.result };
  } catch {
    return { ok: false, error: `Malformed herdr JSON: ${stdout.trim() || "<empty>"}` };
  }
}
var execFailure = (operation, result) => ({
  ok: false,
  error: result.stderr || result.stdout || `${operation} exited ${result.code}`
});
function parseHerdrError(result) {
  for (const text of [result.stderr, result.stdout]) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) return parsed.error;
    } catch {
    }
  }
  return void 0;
}
var HERDR_AGENT_PROMPT_TIMEOUT_MS = 1e4;
var hasHerdrCaller = (env = process.env) => env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID);
function workspaceIdFromPaneEnv(env) {
  const paneId2 = env.HERDR_PANE_ID;
  if (!paneId2) return void 0;
  const workspace = paneId2.split(":")[0];
  return workspace && /^w[0-9A-Za-z]+$/.test(workspace) ? workspace : void 0;
}
async function currentPane(pi) {
  const result = await pi.exec("herdr", ["pane", "current", "--current"], { timeout: 5e3 });
  if (result.code !== 0) return execFailure("herdr pane current", result);
  const parsed = parseEnvelope(result.stdout);
  if (!parsed.ok) return parsed;
  return parsed.pane?.pane_id ? { ok: true, pane: parsed.pane } : { ok: false, error: "herdr pane current did not return a pane_id" };
}
async function resolveCallerWorkspaceId(pi, env = process.env) {
  if (hasHerdrCaller(env)) {
    const current = await currentPane(pi);
    if (current.ok && current.pane.workspace_id) return current.pane.workspace_id;
  }
  return workspaceIdFromPaneEnv(env);
}
function workspaceIdFromWorktreeResult(parsed) {
  return parsed.workspace?.workspace_id ?? parsed.root_pane?.workspace_id;
}
async function runInWorktreeWorkspace(pi, workspaceId, shellCommand) {
  const panesResult = await pi.exec("herdr", ["pane", "list", "--workspace", workspaceId], { timeout: 5e3 });
  if (panesResult.code !== 0) return execFailure("herdr pane list", panesResult);
  const panesParsed = parseEnvelope(panesResult.stdout);
  if (!panesParsed.ok) return panesParsed;
  const paneId2 = panesParsed.panes?.[0]?.pane_id;
  if (!paneId2) return { ok: false, error: `herdr pane list returned no panes for workspace ${workspaceId}` };
  if (shellCommand !== void 0) {
    const runResult = await pi.exec("herdr", ["pane", "run", paneId2, shellCommand], { timeout: 5e3 });
    if (runResult.code !== 0) return execFailure("herdr pane run", runResult);
  }
  return { ok: true, pane: { host: "herdr", paneId: paneId2, workspaceId } };
}
var slugAgentPrefix = (prefix) => prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "sumocode";
function uniqueHerdrAgentName(prefix = "sumocode") {
  return `${slugAgentPrefix(prefix)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
async function listWorkspacePanes(pi, workspaceId) {
  const result = await pi.exec("herdr", ["pane", "list", "--workspace", workspaceId], { timeout: 5e3 });
  if (result.code !== 0) return execFailure("herdr pane list", result);
  const parsed = parseEnvelope(result.stdout);
  if (!parsed.ok) return parsed;
  return { ok: true, panes: parsed.panes ?? [] };
}
async function paneForTab(pi, tabId) {
  const workspaceId = tabId.split(":")[0];
  if (!workspaceId) return { ok: false, error: `invalid herdr tab id: ${tabId}` };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const listed = await listWorkspacePanes(pi, workspaceId);
    if (!listed.ok) return listed;
    const pane = listed.panes.find((candidate) => candidate.tab_id === tabId);
    if (pane?.pane_id) return { ok: true, pane };
    if (attempt < 3) await new Promise((resolve10) => setTimeout(resolve10, 25));
  }
  return { ok: false, error: `herdr returned no pane for tab ${tabId}` };
}
function paneTargetArgs(target) {
  return target.kind === "current" ? ["--current"] : [target.paneId];
}
async function splitPane(pi, target, direction, cwd) {
  const result = await pi.exec("herdr", ["pane", "split", ...paneTargetArgs(target), "--direction", direction, "--cwd", cwd, "--no-focus"], { timeout: 5e3 });
  if (result.code !== 0) return execFailure("herdr pane split", result);
  const parsed = parseEnvelope(result.stdout);
  if (!parsed.ok) return parsed;
  return parsed.pane?.pane_id ? { ok: true, pane: parsed.pane } : { ok: false, error: "herdr pane split did not return a pane_id" };
}
async function createTabPane(pi, cwd, label) {
  const workspaceId = await resolveCallerWorkspaceId(pi, process.env);
  const workspaceArgs = workspaceId ? ["--workspace", workspaceId] : [];
  const result = await pi.exec("herdr", ["tab", "create", ...workspaceArgs, "--cwd", cwd, "--label", label, "--no-focus"], { timeout: 5e3 });
  if (result.code !== 0) return execFailure("herdr tab create", result);
  const parsed = parseEnvelope(result.stdout);
  if (!parsed.ok) return parsed;
  if (parsed.root_pane?.pane_id) return { ok: true, pane: parsed.root_pane };
  const tabId = parsed.tab?.tab_id ?? parsed.tab_id;
  if (!tabId) return { ok: false, error: "herdr tab create did not return a tab_id" };
  return paneForTab(pi, tabId);
}
async function runPaneCommand(pi, pane, command) {
  if (!pane.pane_id) return { ok: false, error: "herdr pane has no pane_id" };
  const result = await pi.exec("herdr", ["pane", "run", pane.pane_id, command], { timeout: 5e3 });
  return result.code === 0 ? { ok: true } : execFailure("herdr pane run", result);
}
async function startAgentPane(pi, options) {
  let target;
  if (options.placement.kind === "workspace") {
    let anchorPaneId = options.placement.paneId;
    if (!anchorPaneId) {
      const listed = await listWorkspacePanes(pi, options.placement.workspaceId);
      if (!listed.ok) return listed;
      anchorPaneId = listed.panes[0]?.pane_id;
    }
    if (!anchorPaneId) return { ok: false, error: `herdr returned no pane for workspace ${options.placement.workspaceId}` };
    target = await splitPane(pi, { kind: "id", paneId: anchorPaneId }, "right", options.cwd);
    if (target.ok) {
      await pi.exec("herdr", ["pane", "move", anchorPaneId, "--new-tab", "--workspace", options.placement.workspaceId, "--label", "shell", "--no-focus"], { timeout: 5e3 }).catch(() => void 0);
    }
  } else if (options.placement.kind === "tab") {
    const anchor = await paneForTab(pi, options.placement.tabId);
    target = anchor.ok && anchor.pane.pane_id ? await splitPane(pi, { kind: "id", paneId: anchor.pane.pane_id }, options.placement.direction, options.cwd) : anchor;
  } else {
    target = await createTabPane(pi, options.cwd, options.placement.label);
  }
  if (!target.ok) return target;
  const started = await runPaneCommand(pi, target.pane, options.shellCommand);
  if (!started.ok) return started;
  const agentName = uniqueHerdrAgentName(options.name);
  const paneId2 = target.pane.pane_id;
  const workspaceId = target.pane.workspace_id ?? (options.placement.kind === "workspace" ? options.placement.workspaceId : void 0);
  const tabId = target.pane.tab_id ?? (options.placement.kind === "tab" ? options.placement.tabId : void 0);
  await pi.exec("herdr", ["pane", "rename", paneId2, options.name], { timeout: 5e3 }).catch(() => void 0);
  return {
    ok: true,
    pane: { host: "herdr", paneId: paneId2, workspaceId },
    agentName,
    workspaceId,
    tabId,
    paneId: paneId2
  };
}
var herdrTerminalHost = {
  kind: "herdr",
  startAgentPane,
  async sendPaneText(pi, pane, text) {
    try {
      const prompted = await pi.exec("herdr", ["agent", "prompt", pane.paneId, text], { timeout: HERDR_AGENT_PROMPT_TIMEOUT_MS });
      if (prompted.code === 0) return { ok: true };
      const error = parseHerdrError(prompted);
      if (error?.code === "agent_prompt_stalled") return { ok: true };
      if (error?.code === "agent_blocked") return { ok: false, error: error.message || "agent is blocked" };
      if (error?.code === "agent_not_found") return { ok: false, error: error.message || "Herdr does not recognize an agent in this pane yet" };
      return execFailure("herdr agent prompt", prompted);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  async openCommandInSplit(pi, direction, options) {
    const target = hasHerdrCaller() ? await splitPane(pi, { kind: "current" }, direction, options.cwd) : await createTabPane(pi, options.cwd, "sumocode");
    if (!target.ok) return target;
    const started = await runPaneCommand(pi, target.pane, options.shellCommand);
    if (!started.ok) return started;
    const paneId2 = target.pane.pane_id;
    return { ok: true, pane: { host: "herdr", paneId: paneId2, workspaceId: target.pane.workspace_id } };
  },
  async openWorktreeWorkspace(pi, options) {
    const result = await pi.exec(
      "herdr",
      ["worktree", "create", "--cwd", options.sourceCwd, "--branch", options.branch, "--base", options.baseRef, "--path", options.path, "--label", options.label, options.focus === false ? "--no-focus" : "--focus", "--json"],
      { timeout: 5e3 }
    );
    if (result.code !== 0) return execFailure("herdr worktree create", result);
    const parsed = parseEnvelope(result.stdout);
    if (!parsed.ok) return parsed;
    const workspaceId = workspaceIdFromWorktreeResult(parsed);
    if (!workspaceId) return { ok: false, error: "herdr worktree create did not return a workspace_id" };
    return await runInWorktreeWorkspace(pi, workspaceId, options.shellCommand);
  },
  async openExistingWorktreeWorkspace(pi, options) {
    const result = await pi.exec(
      "herdr",
      ["worktree", "open", "--cwd", options.sourceCwd, "--path", options.path, "--label", options.label, options.focus === false ? "--no-focus" : "--focus", "--json"],
      { timeout: 5e3 }
    );
    if (result.code !== 0) return execFailure("herdr worktree open", result);
    const parsed = parseEnvelope(result.stdout);
    if (!parsed.ok) return parsed;
    const workspaceId = workspaceIdFromWorktreeResult(parsed);
    if (!workspaceId) return { ok: false, error: "herdr worktree open did not return a workspace_id" };
    return await runInWorktreeWorkspace(pi, workspaceId, options.shellCommand);
  },
  async closePane(pi, pane) {
    const result = await pi.exec("herdr", ["pane", "close", pane.paneId], { timeout: 5e3 });
    if (result.code !== 0) return execFailure("herdr pane close", result);
    return { ok: true };
  },
  async notify(pi, title, body) {
    await pi.exec("herdr", ["notification", "show", title, "--body", body, "--sound", "done"], { timeout: 5e3 }).catch(() => void 0);
  }
};

// src/terminal-host/index.ts
var noneTerminalHost = {
  kind: "none",
  async startAgentPane() {
    return { ok: false, error: "requires a running herdr terminal host" };
  },
  async sendPaneText() {
    return { ok: false, error: "requires a running herdr terminal host" };
  },
  async openCommandInSplit() {
    return { ok: false, error: "requires a running herdr terminal host" };
  },
  async closePane() {
    return { ok: false, error: "requires a running herdr terminal host" };
  },
  async notify() {
  }
};
function getTerminalHost(env = process.env) {
  const kind = detectTerminalHost(env);
  return kind === "herdr" ? herdrTerminalHost : noneTerminalHost;
}

// src/commands/diff.ts
var HUNK_SUBCOMMANDS = /* @__PURE__ */ new Set(["diff", "show", "patch", "pager"]);
var SPLIT_FLAG_PATTERN = /(^|\s)(--down|--right)(?=\s|$)/g;
function parseDiffArgs(rawArgs) {
  let forcedDirection;
  for (const match of rawArgs.matchAll(SPLIT_FLAG_PATTERN)) {
    forcedDirection = match[2] === "--down" ? "down" : "right";
  }
  const hunkArgs = rawArgs.replace(SPLIT_FLAG_PATTERN, " ").trim();
  return { hunkArgs, forcedDirection };
}
function chooseDiffSplitDirection(size, forcedDirection) {
  if (forcedDirection) return forcedDirection;
  const columns = size.columns ?? 0;
  const rows = size.rows ?? 0;
  return rows > columns ? "down" : "right";
}
function getTerminalSize() {
  return {
    columns: process.stdout.columns,
    rows: process.stdout.rows
  };
}
function buildHunkCommand(rawArgs) {
  const trimmed = rawArgs.trim();
  if (!trimmed) return "hunk diff";
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0] ?? "";
  if (HUNK_SUBCOMMANDS.has(first)) return `hunk ${trimmed}`;
  return `hunk diff ${trimmed}`;
}
async function isHunkInstalled(pi) {
  try {
    const result = await pi.exec("sh", ["-lc", "command -v hunk >/dev/null 2>&1"], { timeout: 2e3 });
    return result.code === 0 && !result.killed;
  } catch {
    return false;
  }
}
function registerDiffCommand(pi, options = {}) {
  const configuredTerminalHost = options.terminalHost;
  const getSize = options.terminalSize ?? getTerminalSize;
  pi.registerCommand("sumo:diff", {
    description: "Open hunk diff in an orientation-aware terminal-host split for quick review",
    handler: async (args, ctx) => {
      try {
        if (!ctx.hasUI) {
          ctx.ui.notify("/sumo:diff requires interactive UI", "warning");
          return;
        }
        if (!await isHunkInstalled(pi)) {
          ctx.ui.notify(
            "/sumo:diff needs hunkdiff. install with `npm i -g hunkdiff` or `brew install modem-dev/tap/hunk`",
            "warning"
          );
          return;
        }
        const { hunkArgs, forcedDirection } = parseDiffArgs(args ?? "");
        const hunkCmd = buildHunkCommand(hunkArgs);
        const shellCmd = buildShellCommand(ctx.cwd, hunkCmd);
        const direction = chooseDiffSplitDirection(getSize(), forcedDirection);
        const host = configuredTerminalHost ?? getTerminalHost();
        const result = await host.openCommandInSplit(pi, direction, { cwd: ctx.cwd, shellCommand: shellCmd });
        if (result.ok) {
          ctx.ui.notify(`opened ${hunkCmd} in a new ${host.kind} pane`, "info");
        } else {
          ctx.ui.notify(`/sumo:diff: ${result.error}`, "warning");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/sumo:diff: ${message}`, "warning");
      }
    }
  });
}

// src/commands/divine-query.ts
var TEST_TITLE = "Divine Query test modal\nUse this to verify the runtime overlay without waiting for the LLM.";
var TEST_OPTIONS = [
  "Looks good \u2014 ship it",
  "Needs visual polish",
  "Cancel / escape path works"
];
function registerDivineQueryCommand(pi) {
  pi.registerCommand("sumo:query", {
    description: "Open a test Cathedral Divine Query modal",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        process.stdout.write("sumo:query requires interactive UI\n");
        return;
      }
      const selected = await showDivineQuery(ctx, TEST_TITLE, TEST_OPTIONS);
      if (selected === void 0) {
        ctx.ui.notify("Divine Query cancelled", "warning");
        return;
      }
      ctx.ui.notify(`Divine Query selected: ${selected}`, "info");
    }
  });
}

// src/commands/exit.ts
function registerExitCommand(pi) {
  pi.registerCommand("exit", {
    description: "Exit SumoCode cleanly",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    }
  });
}

// src/commands/slate.ts
import { Type as Type3 } from "typebox";

// src/slate.ts
var SLATE_ENTRY_TYPE = "slate";
var Slate = class _Slate {
  items = [];
  add(text) {
    this.items.push(text);
    return this.items.length;
  }
  list() {
    return this.items;
  }
  get length() {
    return this.items.length;
  }
  get isEmpty() {
    return this.items.length === 0;
  }
  /**
   * Remove item at 1-based index. No argument or 0 pops the first item.
   * Returns the removed text, or undefined if index is out of bounds.
   */
  remove(oneBasedIndex) {
    const raw = oneBasedIndex ?? 1;
    if (!Number.isInteger(raw) || raw < 1) return void 0;
    const index = raw - 1;
    if (index >= this.items.length) return void 0;
    return this.items.splice(index, 1)[0];
  }
  /** Remove and return the first item (stack pop). */
  pop() {
    return this.remove(1);
  }
  clear() {
    const count = this.items.length;
    this.items = [];
    return count;
  }
  /** Serialize for `pi.appendEntry`. */
  toJSON() {
    return { items: [...this.items] };
  }
  /**
   * Reconstruct from session entries. Takes the latest slate entry
   * (last write wins across compactions/resumes).
   */
  static fromEntries(entries) {
    const slate2 = new _Slate();
    let latestItems;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === SLATE_ENTRY_TYPE && Array.isArray(entry.data?.items)) {
        latestItems = entry.data.items;
      }
    }
    if (latestItems) slate2.items = [...latestItems];
    return slate2;
  }
  /** Format for the agent's `slate_list` tool response. */
  formatForAgent() {
    if (this.items.length === 0) return "The slate is empty. No parked ideas.";
    const lines = this.items.map((item, index) => `${index + 1}. ${item}`);
    return `Slated items (${this.items.length}):
${lines.join("\n")}`;
  }
};
var SLATE_CUSTOM_TYPE = SLATE_ENTRY_TYPE;

// src/commands/slate.ts
var slate = new Slate();
function reconstructSlate(ctx) {
  try {
    const entries = ctx.sessionManager.getBranch();
    slate = Slate.fromEntries(entries);
  } catch {
    slate = new Slate();
  }
}
function persistSlate(pi) {
  pi.appendEntry(SLATE_CUSTOM_TYPE, slate.toJSON());
}
function parseSubcommand(rawArgs) {
  const joined = rawArgs.trim();
  if (joined === "") return { action: "list" };
  if (joined === "clear") return { action: "clear" };
  if (joined === "done" || joined.startsWith("done ")) {
    const rest = joined.slice(4).trim();
    if (rest === "") return { action: "done" };
    const num = Number.parseInt(rest, 10);
    if (Number.isFinite(num) && num > 0) return { action: "done", index: num };
    return { action: "add", text: joined };
  }
  return { action: "add", text: joined };
}
async function handleSlateCommand(args, ctx, pi) {
  const parsed = parseSubcommand(args);
  switch (parsed.action) {
    case "add": {
      const count = slate.add(parsed.text);
      ctx.ui.notify(`\u2726 slated: ${parsed.text} (${count} pending)`, "info");
      return;
    }
    case "clear": {
      const removed = slate.clear();
      ctx.ui.notify(`\u2726 slate cleared (${removed} item${removed === 1 ? "" : "s"} removed)`, "info");
      return;
    }
    case "done": {
      const removed = slate.remove(parsed.index);
      if (removed !== void 0) {
        ctx.ui.notify(`\u2726 resolved: ${removed} (${slate.length} remaining)`, "info");
      } else {
        ctx.ui.notify("slate is empty or index out of range", "warning");
      }
      return;
    }
    case "list": {
      if (slate.isEmpty) {
        ctx.ui.notify("slate is empty", "info");
        return;
      }
      const items = [...slate.list()];
      const options = items.map((item2, index) => `${index + 1}. ${item2}`);
      const selectedText = await showDivineQuery(ctx, "SLATE \u2014 parked ideas", options);
      if (selectedText === void 0) return;
      const selectedIndex = options.indexOf(selectedText);
      if (selectedIndex < 0 || selectedIndex >= items.length) return;
      const item = items[selectedIndex];
      try {
        pi.sendUserMessage(`[slate] Pick up: ${item}`, { deliverAs: "followUp" });
        ctx.ui.notify(`\u2726 picking up: ${item}`, "info");
      } catch {
        pi.sendUserMessage(`[slate] Pick up: ${item}`);
        ctx.ui.notify(`\u2726 picking up: ${item}`, "info");
      }
      return;
    }
  }
}
function registerSlateTools(pi) {
  pi.registerTool({
    name: "slate_list",
    label: "Slate List",
    description: "List all items currently parked in the user's Slate",
    promptSnippet: "List parked ideas from the user's Slate",
    parameters: Type3.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: slate.formatForAgent() }],
        details: void 0
      };
    }
  });
  pi.registerTool({
    name: "slate_done",
    label: "Slate Done",
    description: "Mark a slated item as done and remove it from the Slate",
    promptSnippet: "Remove a completed item from the user's Slate",
    promptGuidelines: [
      "Always ask the user for confirmation before calling slate_done. Never auto-remove slated items."
    ],
    parameters: Type3.Object({
      index: Type3.Number({ description: "1-based index of the item to remove" })
    }),
    async execute(_toolCallId, params) {
      const index = params.index;
      const removed = slate.remove(index);
      if (!removed) {
        return {
          content: [{ type: "text", text: `No item at index ${index}. ${slate.formatForAgent()}` }],
          details: void 0,
          isError: true
        };
      }
      return {
        content: [{ type: "text", text: `Resolved: "${removed}". ${slate.formatForAgent()}` }],
        details: void 0
      };
    }
  });
}
function registerSlateCommand(pi) {
  pi.registerCommand("slate", {
    description: "Park an idea for later \u2014 /slate <text> to add, /slate to review",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        process.stdout.write("slate requires interactive UI\n");
        return;
      }
      await handleSlateCommand(args, ctx, pi);
    }
  });
  registerSlateTools(pi);
  pi.on("session_start", (_event, ctx) => {
    reconstructSlate(ctx);
  });
  pi.on("session_shutdown", () => {
    persistSlate(pi);
  });
}

// src/commands/ship.ts
function notify3(ctx, message, type = "info") {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  process.stdout.write(`${message}
`);
}
function changedFiles(statusPorcelainZ) {
  const out = [];
  const records = statusPorcelainZ.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const xy = record.slice(0, 2);
    let path2 = record.slice(3);
    if (xy[0] === "R" || xy[0] === "C") {
      i += 1;
    }
    path2 = path2.trim();
    if (path2) out.push(path2);
  }
  return out;
}
function draftCommitMessage(branch, files) {
  const branchSlug = branch.replace(/^sumo\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  const scope = branchSlug || "changes";
  const noun = files.length === 1 ? "file" : "files";
  return `chore(${scope}): update ${files.length} ${noun}`;
}
async function exec(pi, cmd, args, cwd) {
  return pi.exec(cmd, [...args], { cwd, timeout: 3e4 });
}
async function ensureOk(result, label) {
  if (result.code === 0 && !result.killed) return;
  throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
}
function registerShipCommand(pi, options = {}) {
  const ask = options.ask ?? ((ctx, title, choices) => showDivineQuery(ctx, title, choices));
  pi.registerCommand("sumo:ship", {
    description: "Commit locally, then human-gate push and PR creation",
    handler: async (_args, ctx) => {
      try {
        const status = await exec(pi, "git", ["status", "--porcelain", "-z"], ctx.cwd);
        await ensureOk(status, "git status");
        const files = changedFiles(status.stdout);
        if (files.length === 0) {
          notify3(ctx, "/sumo:ship: no working-tree changes to commit", "warning");
          return;
        }
        const branchResult = await exec(pi, "git", ["branch", "--show-current"], ctx.cwd);
        await ensureOk(branchResult, "git branch");
        const branch = branchResult.stdout.trim() || "HEAD";
        const message = draftCommitMessage(branch, files);
        const summary = files.slice(0, 8).join(", ") + (files.length > 8 ? `, +${files.length - 8} more` : "");
        if (ctx.hasUI) {
          const commitChoice = await ask(ctx, `Commit ${files.length} change(s) on ${branch}?
Message: ${message}
Files: ${summary}`, ["Commit", "Cancel"]);
          if (commitChoice !== "Commit") {
            notify3(ctx, "/sumo:ship stopped before commit");
            return;
          }
        }
        await ensureOk(await exec(pi, "git", ["add", "-A"], ctx.cwd), "git add");
        await ensureOk(await exec(pi, "git", ["commit", "-m", message], ctx.cwd), "git commit");
        notify3(ctx, `committed locally: ${message} \xB7 ${summary}`);
        if (!ctx.hasUI) {
          notify3(ctx, "/sumo:ship stopped before push: interactive confirmation required", "warning");
          return;
        }
        const pushChoice = await ask(ctx, `Push branch ${branch}?
Commit: ${message}
Files: ${summary}`, ["Push", "Cancel"]);
        if (pushChoice !== "Push") {
          notify3(ctx, "/sumo:ship stopped before push");
          return;
        }
        await ensureOk(await exec(pi, "git", ["push", "-u", "origin", "HEAD"], ctx.cwd), "git push");
        notify3(ctx, `pushed ${branch}`);
        const prChoice = await ask(ctx, `Open PR for ${branch}?
Title: ${message}`, ["Open PR", "Cancel"]);
        if (prChoice !== "Open PR") {
          notify3(ctx, "/sumo:ship stopped before PR creation");
          return;
        }
        await ensureOk(await exec(pi, "gh", ["pr", "create", "--fill"], ctx.cwd), "gh pr create");
        notify3(ctx, `PR opened for ${branch}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify3(ctx, `/sumo:ship: ${message}`, "warning");
      }
    }
  });
}

// src/commands/persona.ts
import { existsSync as existsSync3 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join5 } from "node:path";
import { spawnSync } from "node:child_process";
var DEFAULT_PERSONA_PATH = join5(homedir6(), ".pi", "agent", "APPEND_SYSTEM.md");
function runPersonaCommand(deps) {
  if (!deps.fileExists(deps.personaPath)) {
    return {
      kind: "error",
      opened: false,
      message: `persona file not found: ${deps.personaPath} \u2014 run sumocode-config/bootstrap.sh first`
    };
  }
  if (!deps.isTTY) {
    return {
      kind: "instructions",
      opened: false,
      message: `persona file: ${deps.personaPath} \u2014 edit it directly, then reload Pi`
    };
  }
  const outcome = deps.runEditor(deps.editor, deps.personaPath);
  if (outcome.status === 0) {
    return {
      kind: "success",
      opened: true,
      message: "persona updated \u2014 reload Pi to apply"
    };
  }
  if (outcome.error) {
    return {
      kind: "error",
      opened: true,
      message: `failed to launch editor "${deps.editor}": ${outcome.error}`
    };
  }
  return {
    kind: "error",
    opened: true,
    message: `editor "${deps.editor}" exited with code ${outcome.status}`
  };
}
function notify4(ctx, result) {
  const type = result.kind === "error" ? "error" : "info";
  if (ctx.hasUI) {
    ctx.ui.notify(result.message, type);
    return;
  }
  const stream = type === "error" ? process.stderr : process.stdout;
  stream.write(`${result.message}
`);
}
function parsePersonaEditorCommand(editor, pathExists3 = existsSync3) {
  const trimmed = editor.trim();
  if (trimmed && pathExists3(trimmed)) return { command: trimmed, args: [] };
  const parts = [];
  let current = "";
  let quote;
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== "double") {
      quote = quote === "single" ? void 0 : "single";
      continue;
    }
    if (char === '"' && quote !== "single") {
      quote = quote === "double" ? void 0 : "double";
      continue;
    }
    if (/\s/u.test(char) && quote === void 0) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) parts.push(current);
  if (quote !== void 0) return { command: trimmed || editor, args: [] };
  return { command: parts[0] ?? editor, args: parts.slice(1) };
}
function defaultRunEditor(editor, file) {
  const { command, args } = parsePersonaEditorCommand(editor);
  const child = spawnSync(command, [...args, file], { stdio: "inherit", env: process.env });
  return {
    status: child.status ?? 1,
    error: child.error?.message
  };
}
function registerPersonaCommand(pi, overrides = {}) {
  const personaPath = overrides.personaPath ?? DEFAULT_PERSONA_PATH;
  const fileExists = overrides.fileExists ?? existsSync3;
  const runEditor = overrides.runEditor ?? defaultRunEditor;
  pi.registerCommand("sumo:persona", {
    description: "Edit the Zeus persona prompt in $EDITOR",
    handler: async (_args, ctx) => {
      if (ctx.mode === "rpc") {
        notify4(ctx, {
          kind: "instructions",
          opened: false,
          message: `persona file: ${personaPath} \u2014 $EDITOR cannot run inside the rpc host \u2014 edit it directly, then reload Pi`
        });
        return;
      }
      const result = runPersonaCommand({
        personaPath,
        isTTY: ctx.hasUI,
        editor: process.env.EDITOR?.trim() || "vi",
        fileExists,
        runEditor
      });
      notify4(ctx, result);
    }
  });
}

// src/commands/review.ts
var DEFAULT_REVIEW_MODEL = "openai-codex/gpt-5.3-codex";
var MODEL_ALIASES = {
  codex: "openai-codex/gpt-5.3-codex",
  opus: "anthropic/claude-opus-4.6",
  sonnet: "anthropic/claude-sonnet-4.6",
  deepseek: "deepseek/deepseek-v4-pro"
};
function resolveReviewModel(env = process.env) {
  return env.SUMOCODE_REVIEW_MODEL?.trim() || DEFAULT_REVIEW_MODEL;
}
function extractModelAlias(args) {
  const trimmed = args.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const firstWord = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const alias = firstWord in MODEL_ALIASES ? MODEL_ALIASES[firstWord] : void 0;
  if (alias) {
    const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
    return { model: alias, scopeArgs: rest };
  }
  return { model: void 0, scopeArgs: trimmed };
}
function parseReviewScope(args) {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "working-tree" };
  const prMatch = /^#?(\d+)$/.exec(trimmed);
  if (prMatch) return { kind: "pr", number: prMatch[1] };
  return { kind: "explicit", raw: trimmed };
}
function scopeDescription(scope) {
  if (scope.kind === "working-tree") return "the current branch diff (working tree changes or branch vs main)";
  if (scope.kind === "pr") return `PR #${scope.number}`;
  return scope.raw;
}
function reviewScopeLabel(scope) {
  if (scope.kind === "working-tree") return "branch diff";
  if (scope.kind === "pr") return `PR #${scope.number}`;
  return scope.raw;
}
function inspectInstructions(scope) {
  if (scope.kind === "pr") {
    return `How to inspect:
1. Run \`gh pr diff ${scope.number}\` to get the full PR diff. If that fails, try \`gh pr diff ${scope.number} --repo <owner/repo>\`.
2. Run \`gh pr view ${scope.number}\` to read the PR title and description \u2014 this is the intent context.
3. For every changed function/method in the diff, read the full enclosing function body from the file on disk \u2014 not just the diff hunk.
4. Read the test files for each changed module.
5. Run \`pnpm exec tsc --noEmit\` to confirm no type errors.
6. Run \`pnpm vitest run <changed test files>\` to confirm tests pass.`;
  }
  if (scope.kind === "explicit") {
    return `How to inspect:
1. Run \`git diff ${scope.raw}\` to get the diff for the requested scope.
2. For every changed function/method, read the full enclosing function body from disk \u2014 not just the diff hunk.
3. Read the test files for each changed module.
4. Run \`pnpm exec tsc --noEmit\` to confirm no type errors.
5. Run \`pnpm vitest run <changed test files>\` to confirm tests pass.`;
  }
  return `How to inspect:
1. Run \`git diff HEAD\` to see uncommitted changes. Also run \`git status\` to find untracked files and read them directly.
2. IMPORTANT: if \`git diff HEAD\` is empty (working tree is clean), do NOT return GREEN \u2014 instead run \`git diff origin/main...HEAD\` to get the full branch diff vs main. If that is also empty (already on main with no commits ahead), explicitly state "scope is empty \u2014 nothing to review" rather than returning GREEN.
3. For every changed function/method, read the full enclosing function body from disk \u2014 not just the diff hunk. Bugs caused by interaction with surrounding code are invisible from hunks alone.
4. Read the test files for each changed module to assess test adequacy.
5. Run \`pnpm exec tsc --noEmit\` to confirm no type errors.
6. Run \`pnpm vitest run <changed test files>\` to confirm tests pass.`;
}
function buildReviewPrompt(args, model = DEFAULT_REVIEW_MODEL) {
  const scope = parseReviewScope(args);
  const description = scopeDescription(scope);
  const inspect = inspectInstructions(scope);
  return `Run SumoCode diff review for ${description}.

You are the reviewer running in your own tracked SumoCode subagent with model ${model}.
Review only: inspect the requested scope directly, report findings precisely, and stop after one complete review pass. Do not fix code in this child task unless the parent explicitly asks in a later turn.

Project context:
- Language: TypeScript (strict, no emit \u2014 jiti runs TS directly)
- Test runner: vitest (pnpm vitest run <file> or pnpm test)
- Type check: pnpm exec tsc --noEmit
- Build check: pnpm build
- Integration tests: pnpm test:integration
- Conventions: tabs, no unused locals/params, colocated tests (foo.ts next to foo.test.ts)

Review scope: ${description}

Your job: find bugs that matter. A false positive is worse than a missed finding \u2014 err on the side of precision.

IMPORTANT: You are the reviewer. Do NOT use the task tool or delegate to any sub-agent. Use only bash, read, and write. Perform the entire review yourself in this session.

DO NOT flag any of the following:
- Code style, formatting, naming conventions, whitespace, or import ordering
- Missing comments or documentation
- Refactor opportunities that do not carry direct bug risk
- Speculative "could be an issue if..." concerns \u2014 if you can't trace a concrete execution path to a failure, omit it
- Test file structure, test naming, or test verbosity

${inspect}

Regression-contract discipline:
- For each changed code path that replaces or wraps existing behavior, compare the old and new success, failure, and no-op paths from the diff. Preserve old failure semantics unless the PR explicitly says otherwise.
- If a changed call returns a result object such as \`{ success, error }\`, verify the error path is handled before any success notification, persistence write, subscriber event, cache update, or internal state mutation.
- For code that coordinates two state systems (for example external UI/API state plus internal registry/cache state), treat the boundary as transactional: internal state must not advance if the external operation failed.
- Tests are inadequate if they cover only the happy path and unknown-input path while omitting a known-input failure from a mocked dependency.

Reasoning discipline \u2014 for every finding you report:
- State the premise: what you observed in the code.
- Trace the concrete execution path that leads to the failure.
- State the conclusion: what breaks, under what condition.
- If you cannot complete this trace, omit the finding.

Severity rubric:
- P0: release blocker. Causes data loss, security/privacy exposure, destructive behavior, unrecoverable crashes on core flows, or breaks build/startup for most users.
- P1: must fix before merge. Causes incorrect behavior, significant regression, broken important workflow, race/leak, stale state, failed error handling, or missing validation likely to affect users. Build failure or test failure is always P1.
- P2: should fix before merge when practical. Risky edge case, incomplete test coverage for changed behavior, confusing failure mode, maintainability issue with plausible bug risk.

GREEN signal criteria:
Return GREEN only when ALL of the following are true:
- No P0/P1/P2 findings remain.
- \`pnpm exec tsc --noEmit\` passes (or was already clean before this change).
- Relevant tests pass.
- You have read the enclosing function for every changed hunk, not just the diff lines.
- Test coverage is adequate for the changed behavior, or any gap is explicitly low-risk and justified.
- The diff was non-empty \u2014 if scope was empty, state that explicitly instead of returning GREEN.

Output format:
- First line: one of GREEN, P0, P1, P2 (highest severity found), or EMPTY (scope had no diff to review).
- Findings: one block per issue, ordered by severity. Each block must contain:
  - Severity, File, Line range
  - Premise: what you observed
  - Execution path: the concrete trace to failure
  - Impact: what breaks
  - Fix: concrete recommendation
- Omit any severity level you have no finding for \u2014 do not write "No P1 issues found".
- Tests/verification section: what commands you ran and what they returned.
- If GREEN: state every file you read, every command you ran, and why no blocking issues remain.`;
}
function notify5(ctx, message, type = "info") {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  process.stdout.write(`${message}
`);
}
function registerReviewCommand(pi, options = {}) {
  pi.registerCommand("sumo:review", {
    description: `Run a tracked subagent diff review. Args: [${Object.keys(MODEL_ALIASES).join("|")}] [scope]. Scope: empty=branch diff, #51=PR, or git range/path`,
    handler: async (args, ctx) => {
      const subagentSpawner = options.subagentSpawner;
      if (!subagentSpawner) {
        notify5(ctx, "/sumo:review cannot start: subagent manager is not available", "warning");
        return;
      }
      const { model: aliasModel, scopeArgs } = extractModelAlias(args ?? "");
      const model = aliasModel ?? resolveReviewModel();
      const prompt = buildReviewPrompt(scopeArgs, model);
      const scope = parseReviewScope(scopeArgs);
      const label = reviewScopeLabel(scope);
      try {
        const subagent = await subagentSpawner.spawn({
          prompt,
          cwd: ctx.cwd,
          title: `review: ${label} \xB7 ${model}`,
          visible: true,
          model,
          thinking: "xhigh",
          // Mirror the subagent_spawn tool: a narrowed parent session (e.g.
          // `--tools read`) must narrow the visible reviewer too, or it would
          // launch unrestricted. model/thinking are always explicit here, so
          // only the tool allowlist needs threading.
          builtInTools: pi.getActiveTools()
        });
        if (subagent.status === "at_capacity") {
          notify5(ctx, `/sumo:review is at capacity (${subagent.runningCount}/${subagent.capacity}): ${subagent.retryHint}`, "warning");
          return;
        }
        if (subagent.status !== "running") {
          notify5(ctx, `/sumo:review failed to start subagent: ${subagent.errorText ?? "unknown error"}`, "warning");
          return;
        }
        notify5(ctx, `review started: ${subagent.id} \xB7 ${model} \xB7 ${label}. it is running in a watchable herdr pane; its result will arrive as a card automatically.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify5(ctx, `/sumo:review failed to start subagent: ${message}`, "warning");
      }
    }
  });
}

// src/working-indicator.ts
var RESET9 = "\x1B[0m";
function indicatorFrameAt(tick, frames) {
  const length = frames.length;
  if (length === 0) return "";
  const index = (tick % length + length) % length;
  return frames[index];
}
function renderIndicator(tick, frames, hex) {
  const frame = indicatorFrameAt(tick, frames);
  if (!frame) return "";
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `\x1B[38;2;${red};${green};${blue}m${frame}${RESET9}`;
}
var WORKING_INDICATOR_MIN_WIDTH = 80;
var WORKING_INDICATOR_WIDGET_KEY = "sumocode-working-indicator";
function buildActiveThemeIndicatorFrames(env = process.env) {
  const theme = getActiveTheme();
  const indicator = resolveThemeWorkingIndicator(theme, env);
  return indicator.frames.map((_, i) => renderIndicator(i, indicator.frames, theme.tokens.colors.accent));
}
function currentTerminalWidth() {
  const envColumns = Number.parseInt(process.env.COLUMNS ?? "", 10);
  if (Number.isFinite(envColumns) && envColumns > 0) return envColumns;
  const stdoutColumns = process.stdout.columns;
  if (Number.isFinite(stdoutColumns) && stdoutColumns > 0) return stdoutColumns;
  return 80;
}
function shouldInstallWorkingIndicator(width = currentTerminalWidth()) {
  return width >= WORKING_INDICATOR_MIN_WIDTH;
}
function formatSpinnerInspection(frames, hex, intervalMs) {
  const lines = [`${frames.length} frames \xB7 ${intervalMs}ms per frame`];
  for (let i = 0; i < frames.length; i++) {
    const num = String(i + 1).padStart(2, " ");
    const colored2 = renderIndicator(i, frames, hex);
    lines.push(`  ${num}. ${colored2}  ${frames[i]}`);
  }
  return lines.join("\n");
}
function dimAnsi(hex) {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `\x1B[38;2;${red};${green};${blue}m`;
}
var WorkingIndicatorComponent = class {
  constructor(tui, env = process.env) {
    this.tui = tui;
    this.env = env;
    this.themeUnsubscribe = onThemeChanged(() => {
      this.tui.requestRender();
      if (this.busy) this.restartTimer();
    });
  }
  tui;
  env;
  busy = false;
  tick = 0;
  interval;
  themeUnsubscribe;
  invalidate() {
  }
  render(_width) {
    if (!this.busy) return [""];
    const theme = getActiveTheme();
    const indicator = resolveThemeWorkingIndicator(theme, this.env);
    const frame = renderIndicator(this.tick, indicator.frames, theme.tokens.colors.accent);
    const label = `${dimAnsi(theme.tokens.colors.foregroundDim)}Working\u2026${RESET9}`;
    return [` ${frame}${" ".repeat(indicator.labelGapCells)}${label}`];
  }
  start() {
    if (this.busy) return;
    this.busy = true;
    this.tick = 0;
    this.startTimer();
    this.tui.requestRender();
  }
  stop() {
    if (!this.busy) return;
    this.busy = false;
    this.clearTimer();
    this.tick = 0;
    this.tui.requestRender();
  }
  dispose() {
    this.clearTimer();
    this.themeUnsubscribe?.();
    this.themeUnsubscribe = void 0;
  }
  isBusy() {
    return this.busy;
  }
  startTimer() {
    this.clearTimer();
    const intervalMs = resolveThemeWorkingIndicator(getActiveTheme(), this.env).intervalMs;
    this.interval = setInterval(() => {
      this.tick += 1;
      this.tui.requestRender();
    }, intervalMs);
  }
  restartTimer() {
    this.startTimer();
  }
  clearTimer() {
    if (this.interval !== void 0) {
      clearInterval(this.interval);
      this.interval = void 0;
    }
  }
};
function isRetainedMode(env = process.env) {
  const flag = env.SUMO_TUI;
  return flag === "1" || flag === "true" || flag === "TRUE" || flag === "yes" || flag === "YES" || flag === "on" || flag === "ON";
}
function installWorkingIndicator(pi) {
  let component;
  let classicThemeUnsubscribe;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    classicThemeUnsubscribe?.();
    classicThemeUnsubscribe = void 0;
    if (!shouldInstallWorkingIndicator()) return;
    if (isRetainedMode()) {
      const workingUi = ctx.ui;
      if (typeof workingUi.setWorkingVisible === "function") workingUi.setWorkingVisible(false);
      else ctx.ui.setWorkingIndicator({ frames: [] });
      ctx.ui.setWidget(
        WORKING_INDICATOR_WIDGET_KEY,
        (tui) => {
          component?.dispose();
          component = new WorkingIndicatorComponent(tui);
          return component;
        },
        { placement: "aboveEditor" }
      );
      return;
    }
    const applyClassicIndicator = () => {
      const theme = getActiveTheme();
      const indicator = resolveThemeWorkingIndicator(theme);
      ctx.ui.setWorkingIndicator({
        frames: buildActiveThemeIndicatorFrames(),
        intervalMs: indicator.intervalMs
      });
    };
    applyClassicIndicator();
    classicThemeUnsubscribe = onThemeChanged(applyClassicIndicator);
  });
  pi.on("agent_start", () => component?.start());
  pi.on("agent_end", () => component?.stop());
  pi.on("session_shutdown", () => {
    component?.dispose();
    component = void 0;
    classicThemeUnsubscribe?.();
    classicThemeUnsubscribe = void 0;
  });
}

// src/commands/spinner.ts
function formatActiveSpinnerInspection(env = process.env) {
  const theme = getActiveTheme();
  const indicator = resolveThemeWorkingIndicator(theme, env);
  const lines = [
    `theme=${theme.name}`,
    `variant=${indicator.name}`
  ];
  if (indicator.capabilityEnv) {
    lines.push(`capability=${indicator.capabilityEnv}`);
    lines.push(`capabilityState=${indicator.capabilityState}`);
  }
  if (indicator.capabilityState === "unrecognized" && indicator.capabilityEnv) {
    lines.push(`warning: ${indicator.capabilityEnv}=${env[indicator.capabilityEnv]} is unrecognized; previewing fallback frames`);
  }
  lines.push(formatSpinnerInspection(indicator.frames, theme.tokens.colors.accent, indicator.intervalMs));
  return lines.join("\n");
}
function registerSpinnerCommand(pi) {
  pi.registerCommand("sumo:spinner", {
    description: "Preview every frame of the active working indicator",
    handler: async (_args, ctx) => {
      const report2 = formatActiveSpinnerInspection();
      if (!ctx.hasUI) {
        process.stdout.write(`${report2}
`);
        return;
      }
      ctx.ui.notify(report2, "info");
    }
  });
}

// src/commands/sync.ts
import { execFile as execFileCallback } from "node:child_process";
import { existsSync as existsSync4, lstatSync, mkdirSync as mkdirSync4, readFileSync as readFileSync6, realpathSync, renameSync as renameSync2, rmSync, symlinkSync, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { dirname as dirname3, join as join6, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// src/commands/accounts-config.ts
var CLAUDE_ACCOUNTS_MIGRATION_FIELD = "_sumocodeClaudeAccountsMigrated";

// src/commands/sync.ts
var execFile2 = promisify(execFileCallback);
var DEFAULT_TIMEOUT_MS = 12e4;
var CONFIG_REPO_NAME = "sumocode";
var CONFIG_REPO_URL = "git@github.com:dhruvkelawala/sumocode-config.git";
var MANAGED_CONFIG_ITEMS = [
  "APPEND_SYSTEM.md",
  "settings.json",
  "mcp.json",
  "models.json",
  "sumocode.json",
  "claude-accounts.json",
  "xl0-pi-lovely-web.json",
  "extensions",
  "themes",
  "prompts",
  "skills"
];
function moduleUrlToPath(moduleUrl) {
  return moduleUrl.startsWith("file:") ? fileURLToPath(moduleUrl) : moduleUrl;
}
function packageRootFromModule(moduleUrl, deps) {
  const exists = deps.exists ?? existsSync4;
  const modulePath = moduleUrlToPath(moduleUrl);
  let current = dirname3(modulePath);
  while (true) {
    if (packageNameAt(current, deps) === "@dhruvkelawala/sumocode" && exists(join6(current, "src", "extension.ts"))) return current;
    const parent = dirname3(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve2(dirname3(modulePath), "..", "..");
}
function resolveConfigRepo(deps) {
  const env = deps.env ?? process.env;
  if (env.SUMOCODE_CONFIG_DIR) return resolve2(env.SUMOCODE_CONFIG_DIR);
  const homeDir = deps.homeDir ?? homedir7();
  return join6(homeDir, ".config", CONFIG_REPO_NAME);
}
function resolvePiAgentDir(deps) {
  const homeDir = deps.homeDir ?? homedir7();
  return join6(homeDir, ".pi", "agent");
}
function isGitRepo(dir, deps) {
  const exists = deps.exists ?? existsSync4;
  return exists(join6(dir, ".git"));
}
function isNamedPackage(value) {
  return typeof value.name === "string";
}
function packageNameAt(dir, deps) {
  const exists = deps.exists ?? existsSync4;
  const readFile = deps.readFile ?? ((path2, encoding) => readFileSync6(path2, encoding));
  const packagePath = join6(dir, "package.json");
  if (!exists(packagePath)) return void 0;
  try {
    const parsed = JSON.parse(readFile(packagePath, "utf8"));
    return isNamedPackage(parsed) ? parsed.name : void 0;
  } catch {
    return void 0;
  }
}
function findActiveSumoDevTree(cwd, deps) {
  const exists = deps.exists ?? existsSync4;
  let current = resolve2(cwd);
  while (true) {
    const isSumocodePackage = packageNameAt(current, deps) === "@dhruvkelawala/sumocode";
    if (isSumocodePackage && exists(join6(current, "src", "extension.ts")) && exists(join6(current, ".git"))) return current;
    const parent = dirname3(current);
    if (parent === current) return void 0;
    current = parent;
  }
}
function resolveSumoCodeRepo(deps) {
  const cwd = deps.cwd ?? process.cwd();
  const devTree = findActiveSumoDevTree(cwd, deps);
  if (devTree) return devTree;
  return packageRootFromModule(deps.moduleUrl ?? import.meta.url, deps);
}
function pathExists(path2) {
  try {
    lstatSync(path2);
    return true;
  } catch {
    return false;
  }
}
function resolvesToSamePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}
function readAccountsLikeDocument(path2) {
  if (!existsSync4(path2)) return void 0;
  try {
    const parsed = JSON.parse(readFileSync6(path2, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
    return parsed;
  } catch {
    return void 0;
  }
}
function subscriptionIdentity(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const candidate = value;
  if (typeof candidate.provider !== "string" || typeof candidate.index !== "number" || !Number.isInteger(candidate.index)) return void 0;
  return `${candidate.provider}\0${candidate.index}`;
}
function subscriptionMergeKey(value) {
  const identity = subscriptionIdentity(value);
  return identity ? `identity:${identity}` : `value:${JSON.stringify(value)}`;
}
function mergeSubscriptions(existing, incoming) {
  const merged = [...existing];
  const keys = new Set(existing.map(subscriptionMergeKey));
  for (const entry of incoming) {
    const key = subscriptionMergeKey(entry);
    if (keys.has(key)) continue;
    merged.push(entry);
    keys.add(key);
  }
  return merged;
}
function writeAccountsMigration(source, document) {
  const temporary = `${source}.${process.pid}.tmp`;
  writeFileSync4(temporary, `${JSON.stringify(document, null, 2)}
`, { encoding: "utf8", mode: 384 });
  renameSync2(temporary, source);
}
function requireValidSubscriptions(document, path2) {
  if (document?.subscriptions !== void 0 && !Array.isArray(document.subscriptions)) {
    throw new Error(`Invalid accounts subscriptions; expected an array: ${path2}`);
  }
}
function seedUnmigratedPrivateAccounts(source, target) {
  const primary = readAccountsLikeDocument(source);
  if (!primary) throw new Error(`Invalid private accounts config; repair before syncing: ${source}`);
  requireValidSubscriptions(primary, source);
  const targetAlreadyManaged = resolvesToSamePath(source, target);
  if (primary[CLAUDE_ACCOUNTS_MIGRATION_FIELD] === true && targetAlreadyManaged) return;
  const agentDocument = targetAlreadyManaged ? void 0 : readAccountsLikeDocument(target);
  const legacyPath = join6(dirname3(target), "multi-pass.json");
  const legacyDocument = readAccountsLikeDocument(legacyPath);
  requireValidSubscriptions(agentDocument, target);
  requireValidSubscriptions(legacyDocument, legacyPath);
  const privateSubscriptions = Array.isArray(primary.subscriptions) ? primary.subscriptions : [];
  const agentSubscriptions = Array.isArray(agentDocument?.subscriptions) ? agentDocument.subscriptions : [];
  const legacySubscriptions = Array.isArray(legacyDocument?.subscriptions) ? legacyDocument.subscriptions : [];
  const next = {
    ...legacyDocument,
    ...agentDocument,
    ...primary,
    [CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
    subscriptions: mergeSubscriptions(mergeSubscriptions(privateSubscriptions, agentSubscriptions), legacySubscriptions)
  };
  writeAccountsMigration(source, next);
}
function initialManagedConfigContent(item, target) {
  if (item !== "claude-accounts.json") return void 0;
  try {
    const targetStat = lstatSync(target);
    if (targetStat.isFile() || targetStat.isSymbolicLink()) return readFileSync6(target, "utf8");
  } catch {
  }
  const legacyPath = join6(dirname3(target), "multi-pass.json");
  if (existsSync4(legacyPath)) {
    try {
      return readFileSync6(legacyPath, "utf8");
    } catch {
    }
  }
  return `${JSON.stringify({ subscriptions: [] }, null, 2)}
`;
}
function ensureConfigSymlinks(configRepo, agentDir) {
  mkdirSync4(agentDir, { recursive: true });
  let backupDir;
  let linked = 0;
  let backedUp = 0;
  for (const item of MANAGED_CONFIG_ITEMS) {
    const source = join6(configRepo, item);
    const target = join6(agentDir, item);
    if (!pathExists(source)) {
      const initialContent = initialManagedConfigContent(item, target);
      if (initialContent === void 0) continue;
      writeFileSync4(source, initialContent, { encoding: "utf8", mode: 384 });
    }
    if (item === "claude-accounts.json") seedUnmigratedPrivateAccounts(source, target);
    if (pathExists(target)) {
      if (resolvesToSamePath(source, target)) {
        linked += 1;
        continue;
      }
      const targetStat = lstatSync(target);
      if (targetStat.isSymbolicLink()) {
        rmSync(target);
      } else {
        backupDir ??= join6(
          agentDir,
          "pre-sumocode-backup",
          `sync-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}`
        );
        mkdirSync4(backupDir, { recursive: true });
        renameSync2(target, join6(backupDir, item));
        backedUp += 1;
      }
    }
    symlinkSync(source, target);
    linked += 1;
  }
  return {
    label: "config symlinks",
    ok: true,
    output: `Linked ${linked} config item(s) into ${agentDir}${backedUp > 0 ? `; backed up ${backedUp} existing item(s) to ${backupDir}` : ""}`
  };
}
function runConfigLinkStep(configRepo, agentDir, deps) {
  const linkConfig = deps.linkConfig ?? ensureConfigSymlinks;
  try {
    return linkConfig(configRepo, agentDir);
  } catch (error) {
    return {
      label: "config symlinks",
      ok: false,
      output: error instanceof Error ? error.message : String(error)
    };
  }
}
async function runStep(label, file, args, options, deps) {
  const run = deps.exec ?? execFile2;
  try {
    const result = await run(file, args, { cwd: options.cwd, timeout: options.timeout ?? DEFAULT_TIMEOUT_MS });
    return { label, ok: true, output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() };
  } catch (error) {
    const err = error;
    return {
      label,
      ok: false,
      output: [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim()
    };
  }
}
function notifyFailure(command, ctx, step) {
  ctx.ui.notify(`/sumo:${command} failed at ${step.label}`, "warning");
}
async function executeSumoSync(ctx, deps = {}) {
  const configRepo = resolveConfigRepo(deps);
  const agentDir = resolvePiAgentDir(deps);
  const sumocodeRepo = resolveSumoCodeRepo(deps);
  const steps = [];
  ctx.ui.notify("syncing SumoCode config + source\u2026", "info");
  if (isGitRepo(configRepo, deps)) {
    steps.push(await runStep("config repo git pull", "git", ["pull", "--ff-only"], { cwd: configRepo }, deps));
  } else {
    steps.push({
      label: "config repo git pull",
      ok: false,
      output: `No git repo at ${configRepo}. Run /sumo:bootstrap first.`
    });
  }
  if (!steps[steps.length - 1].ok) {
    notifyFailure("sync", ctx, steps[steps.length - 1]);
    return steps;
  }
  steps.push(runConfigLinkStep(configRepo, agentDir, deps));
  if (!steps[steps.length - 1].ok) {
    notifyFailure("sync", ctx, steps[steps.length - 1]);
    return steps;
  }
  steps.push(await runStep("sumocode source git pull", "git", ["pull", "--ff-only"], { cwd: sumocodeRepo }, deps));
  if (!steps[steps.length - 1].ok) {
    notifyFailure("sync", ctx, steps[steps.length - 1]);
    return steps;
  }
  ctx.ui.notify("SumoCode sync complete \u2014 run /reload if source changed", "info");
  return steps;
}
async function executeSumoBootstrap(ctx, deps = {}) {
  const configRepo = resolveConfigRepo(deps);
  const agentDir = resolvePiAgentDir(deps);
  const steps = [];
  ctx.ui.notify("bootstrapping SumoCode on this machine\u2026", "info");
  if (!isGitRepo(configRepo, deps)) {
    const exists = deps.exists ?? existsSync4;
    if (exists(configRepo)) {
      steps.push({
        label: "clone sumocode-config",
        ok: false,
        output: `${configRepo} already exists but is not a git repo. Move it aside or set SUMOCODE_CONFIG_DIR to a valid sumocode-config checkout.`
      });
    } else {
      steps.push(await runStep("clone sumocode-config", "git", ["clone", CONFIG_REPO_URL, configRepo], {}, deps));
    }
  } else {
    steps.push({ label: "clone sumocode-config", ok: true, output: `Already exists at ${configRepo}` });
  }
  if (!steps[steps.length - 1].ok) {
    notifyFailure("bootstrap", ctx, steps[steps.length - 1]);
    return steps;
  }
  steps.push(await runStep("pull latest config", "git", ["pull", "--ff-only"], { cwd: configRepo }, deps));
  if (!steps[steps.length - 1].ok) {
    notifyFailure("bootstrap", ctx, steps[steps.length - 1]);
    return steps;
  }
  steps.push(runConfigLinkStep(configRepo, agentDir, deps));
  if (!steps[steps.length - 1].ok) {
    notifyFailure("bootstrap", ctx, steps[steps.length - 1]);
    return steps;
  }
  steps.push({
    label: "next step",
    ok: true,
    output: "Restart SumoCode. Keep PI_CODING_AGENT_DIR unset so Pi sessions and package caches remain under ~/.pi/agent."
  });
  ctx.ui.notify("SumoCode bootstrap complete \u2014 restart; keep PI_CODING_AGENT_DIR unset", "info");
  return steps;
}
function registerSumoSyncCommand(pi, deps = {}) {
  pi.registerCommand("sumo:sync", {
    description: "Pull SumoCode config/source and refresh ~/.pi/agent symlinks",
    handler: async (_args, ctx) => {
      await executeSumoSync(ctx, deps);
    }
  });
  pi.registerCommand("sumo:bootstrap", {
    description: "First-time SumoCode setup: clone config repo and link it into ~/.pi/agent",
    handler: async (_args, ctx) => {
      await executeSumoBootstrap(ctx, deps);
    }
  });
}

// src/commands/tabs.ts
import { existsSync as existsSync5, readFileSync as readFileSync7, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { join as join7 } from "node:path";
var TABS_LOCAL_CONFIG_KEY = "topChromeHidden";
var DEFAULT_TABS_CONFIG_PATH = join7(homedir8(), ".sumocode", "local-config.json");
function isConfigObject(value) {
  return typeof value === "object" && value !== null;
}
function isTopChromeHidden(configPath = DEFAULT_TABS_CONFIG_PATH) {
  try {
    if (!existsSync5(configPath)) return false;
    const raw = readFileSync7(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed[TABS_LOCAL_CONFIG_KEY] === true;
  } catch {
    return false;
  }
}
function setTopChromeHidden(hidden, configPath = DEFAULT_TABS_CONFIG_PATH) {
  let parsed = {};
  try {
    if (existsSync5(configPath)) {
      const decoded = JSON.parse(readFileSync7(configPath, "utf8"));
      if (!isConfigObject(decoded)) parsed = {};
      else parsed = decoded;
    }
  } catch {
    parsed = {};
  }
  parsed[TABS_LOCAL_CONFIG_KEY] = hidden;
  writeFileSync5(configPath, `${JSON.stringify(parsed, null, 2)}
`);
}
function registerTabsCommand(pi, options = {}) {
  const configPath = options.configPath ?? DEFAULT_TABS_CONFIG_PATH;
  pi.registerCommand("sumo:tabs", {
    description: "show or hide the top chrome bar (SUMOCODE label always stays)",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "hide") {
        setTopChromeHidden(true, configPath);
        ctx.ui.notify("top chrome hidden \u2014 restart pi to apply", "info");
        return;
      }
      if (arg === "show") {
        setTopChromeHidden(false, configPath);
        ctx.ui.notify("top chrome visible \u2014 restart pi to apply", "info");
        return;
      }
      const current = isTopChromeHidden(configPath);
      ctx.ui.notify(`top chrome currently ${current ? "hidden" : "visible"}`, "info");
    }
  });
}

// src/commands/theme.ts
import { truncateToWidth as truncateToWidth7, visibleWidth as visibleWidth8 } from "@earendil-works/pi-tui";

// src/sumo-tui/cathedral/theme-bridge.ts
var bridgeThemeVersion = 0;
var bridgeThemeListeners = /* @__PURE__ */ new Set();
function emitCathedralThemeChanged(themeName) {
  setActiveTheme(themeName);
  bridgeThemeVersion += 1;
  for (const listener of bridgeThemeListeners) listener(themeName);
}

// src/commands/theme.ts
function applyKnownTheme(theme, applyPiTheme, persistTheme = (name) => saveSumoCodeConfigPatch({ themeName: name })) {
  let piWarning;
  if (applyPiTheme) {
    const result2 = applyPiTheme(theme.name);
    if (!result2.success) piWarning = result2.error ?? theme.name;
  }
  emitCathedralThemeChanged(theme.name);
  const persistResult = persistTheme?.(theme.name);
  const persistenceWarning = persistResult && !persistResult.success ? persistResult.error ?? theme.name : void 0;
  const result = {};
  if (piWarning !== void 0) result.piWarning = piWarning;
  if (persistenceWarning !== void 0) result.persistenceWarning = persistenceWarning;
  return result;
}
var THEME_RESULT_CUSTOM_TYPE = "sumocode-theme-result";
function isThemeResultDetails(details) {
  if (typeof details !== "object" || details === null) return false;
  return (details.tone === "info" || details.tone === "warning") && Array.isArray(details.lines) && details.lines.every((line) => typeof line === "string");
}
function rgbAnsi(hex, channel) {
  const n = hex.replace("#", "");
  const r = Number.parseInt(n.slice(0, 2), 16);
  const g = Number.parseInt(n.slice(2, 4), 16);
  const b = Number.parseInt(n.slice(4, 6), 16);
  return `\x1B[${channel};2;${r};${g};${b}m`;
}
function styleLine(line, hex) {
  return `${rgbAnsi(hex, 38)}${line}\x1B[0m`;
}
function renderThemeResultLines(details, width) {
  const colors = activeThemeColors();
  const accent4 = details.tone === "warning" ? colors.states.approval : colors.accent;
  const fg8 = colors.foreground;
  const dim5 = colors.foregroundDim;
  const safeWidth = Math.max(8, width);
  const label = details.tone === "warning" ? "/sumo:theme \xB7 failed" : "/sumo:theme";
  const headPrefix = "\u250C\u2500 ";
  const headInnerWidth = Math.max(0, safeWidth - visibleWidth8(headPrefix) - 1);
  const headLabel = truncateToWidth7(label, headInnerWidth, "\u2026");
  const headRule = "\u2500".repeat(Math.max(0, safeWidth - visibleWidth8(headPrefix) - visibleWidth8(headLabel) - 1));
  const out = [];
  out.push(`${styleLine(headPrefix, dim5)}${styleLine(headLabel, accent4)} ${styleLine(headRule, dim5)}`);
  const bodyPrefix = "\u2502 ";
  const bodyInnerWidth = Math.max(0, safeWidth - visibleWidth8(bodyPrefix));
  for (const raw of details.lines) {
    const clipped = truncateToWidth7(raw, bodyInnerWidth, "\u2026");
    out.push(`${styleLine(bodyPrefix, dim5)}${styleLine(clipped, fg8)}`);
  }
  const tailRule = "\u2500".repeat(Math.max(0, safeWidth - 1));
  out.push(`${styleLine("\u2514", dim5)}${styleLine(tailRule, dim5)}`);
  return out;
}
var ThemeResultComponent = class {
  constructor(details) {
    this.details = details;
  }
  details;
  invalidate() {
  }
  render(width) {
    return renderThemeResultLines(this.details, width);
  }
};
function registerThemeResultRenderer(pi) {
  pi.registerMessageRenderer(THEME_RESULT_CUSTOM_TYPE, (message) => {
    if (!isThemeResultDetails(message.details)) return void 0;
    return new ThemeResultComponent(message.details);
  });
}
function pushThemeResult(pi, ctx, lines, tone) {
  if (ctx.hasUI) {
    pi.sendMessage(
      {
        customType: THEME_RESULT_CUSTOM_TYPE,
        content: lines.join("\n"),
        display: true,
        details: { tone, lines }
      },
      { triggerTurn: false }
    );
    ctx.ui.notify(lines[0] ?? "", tone);
    return;
  }
  process.stdout.write(`${lines.join("\n")}
`);
}
function formatActiveThemeMessage() {
  const theme = getActiveTheme();
  return `theme: ${theme.name} \u2014 ${theme.description}`;
}
function formatThemeList() {
  const active = getActiveTheme().name;
  return listThemes().map((theme) => `${theme.name === active ? "*" : " "} ${theme.name} \u2014 ${theme.description}`);
}
function registerThemeCycleShortcuts(pi, options = {}) {
  const handler = (ctx) => {
    const nextName = nextThemeName();
    const theme = getTheme(nextName);
    if (!theme) {
      if (ctx.hasUI) ctx.ui.notify(`theme cycle failed: ${nextName}`, "warning");
      return;
    }
    const applyPi = ctx.hasUI ? (name) => ctx.ui.setTheme(name) : void 0;
    const outcome = applyKnownTheme(theme, applyPi, options.persistTheme);
    if (ctx.hasUI) {
      const warning = outcome.persistenceWarning ?? outcome.piWarning;
      ctx.ui.notify(warning ? `theme: ${theme.name} (${warning})` : `theme: ${theme.name}`, outcome.persistenceWarning ? "warning" : "info");
    }
  };
  pi.registerShortcut("ctrl+shift+t", { description: "Cycle SumoCode theme", handler });
  pi.registerShortcut("alt+t", { description: "Cycle SumoCode theme (terminals that grab Ctrl+Shift)", handler });
}
function registerThemeCommand(pi, options = {}) {
  registerThemeResultRenderer(pi);
  registerThemeCycleShortcuts(pi, options);
  pi.registerCommand("sumo:theme", {
    description: "Show or switch the active SumoCode theme",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (!requested) {
        pushThemeResult(pi, ctx, [formatActiveThemeMessage()], "info");
        return;
      }
      if (requested.toLowerCase() === "list") {
        pushThemeResult(pi, ctx, formatThemeList(), "info");
        return;
      }
      const theme = getTheme(requested);
      if (!theme) {
        pushThemeResult(pi, ctx, [`Unknown SumoCode theme: ${requested}`], "warning");
        return;
      }
      const applyPi = ctx.hasUI ? (name) => ctx.ui.setTheme(name) : void 0;
      const outcome = applyKnownTheme(theme, applyPi, options.persistTheme);
      const lines = [`theme set: ${theme.name}`];
      if (outcome.piWarning) lines.push(`(Pi theme not found: ${outcome.piWarning})`);
      if (outcome.persistenceWarning) lines.push(`(theme preference not saved: ${outcome.persistenceWarning})`);
      pushThemeResult(pi, ctx, lines, outcome.persistenceWarning ? "warning" : "info");
    }
  });
}

// src/theme-check.ts
function banner(theme, title, width) {
  const inner = ` ${title} `;
  const flank = Math.max(2, Math.floor((width - inner.length) / 2));
  const left = "\u2550".repeat(flank);
  const right = "\u2550".repeat(Math.max(0, width - left.length - inner.length));
  return theme.fg("accent", `${left}${inner}${right}`);
}
function sectionHeading(theme, title) {
  return theme.fg("accent", title);
}
function row(theme, slot, label) {
  return `  ${theme.fg(slot, "\u25CF ")}${theme.fg(slot, label.padEnd(20))} ${theme.fg("muted", `(${slot})`)}`;
}
function bgRow(theme, slot, label) {
  return `  ${theme.bg(slot, ` ${label.padEnd(28)} `)} ${theme.fg("muted", `(${slot})`)}`;
}
function renderThemeCheck(theme, width) {
  const lines = [];
  lines.push(banner(theme, "CATHEDRAL THEME CHECK", width));
  lines.push("");
  lines.push(sectionHeading(theme, "STATES"));
  lines.push(row(theme, "success", "ready"));
  lines.push(row(theme, "warning", "thinking"));
  lines.push(row(theme, "border", "tool"));
  lines.push(row(theme, "error", "needs you"));
  lines.push(row(theme, "borderAccent", "learning"));
  lines.push("");
  lines.push(sectionHeading(theme, "SURFACES"));
  lines.push(`  ${theme.fg("muted", "muted text sample")} ${theme.fg("dim", "dim text sample")}`);
  lines.push(`  ${theme.fg("accent", "burnt orange focal")} ${theme.fg("borderMuted", "border muted")}`);
  lines.push(`  ${theme.fg("thinkingText", "thinking text")} ${theme.fg("toolOutput", "tool output")}`);
  lines.push("");
  lines.push(sectionHeading(theme, "MESSAGE BACKGROUNDS"));
  lines.push(bgRow(theme, "selectedBg", "selected"));
  lines.push(bgRow(theme, "userMessageBg", "user message"));
  lines.push(bgRow(theme, "customMessageBg", "custom message"));
  lines.push(bgRow(theme, "toolPendingBg", "tool pending"));
  lines.push(bgRow(theme, "toolSuccessBg", "tool success"));
  lines.push(bgRow(theme, "toolErrorBg", "tool error"));
  lines.push(`  ${theme.fg("userMessageText", "user message text")} ${theme.fg("customMessageText", "custom message text")} ${theme.fg("customMessageLabel", "[label]")}`);
  lines.push("");
  lines.push(sectionHeading(theme, "MARKDOWN"));
  lines.push(`  ${theme.fg("mdHeading", "# heading")}`);
  lines.push(`  ${theme.fg("mdLink", "link text")} ${theme.fg("mdLinkUrl", "(https://example)")} `);
  lines.push(`  ${theme.fg("mdCode", "`inline code`")} ${theme.fg("mdCodeBlock", "code block body")} ${theme.fg("mdCodeBlockBorder", "\u2502")}`);
  lines.push(`  ${theme.fg("mdQuoteBorder", "\u2502 ")}${theme.fg("mdQuote", "block quote")}`);
  lines.push(`  ${theme.fg("mdHr", "\u2500".repeat(20))}`);
  lines.push(`  ${theme.fg("mdListBullet", "\u2022")} list bullet`);
  lines.push("");
  lines.push(sectionHeading(theme, "SYNTAX"));
  lines.push(
    `  ${theme.fg("syntaxComment", "// cathedral syntax sample")}`
  );
  lines.push(
    `  ${theme.fg("syntaxKeyword", "const")} ${theme.fg("syntaxVariable", "greeting")} ${theme.fg("syntaxOperator", "=")} ${theme.fg("syntaxString", '"hello"')}${theme.fg("syntaxPunctuation", ";")}`
  );
  lines.push(
    `  ${theme.fg("syntaxKeyword", "function")} ${theme.fg("syntaxFunction", "answer")}${theme.fg("syntaxPunctuation", "()")} ${theme.fg("syntaxOperator", ":")} ${theme.fg("syntaxType", "number")} ${theme.fg("syntaxPunctuation", "{")} ${theme.fg("syntaxKeyword", "return")} ${theme.fg("syntaxNumber", "42")}${theme.fg("syntaxPunctuation", ";")} ${theme.fg("syntaxPunctuation", "}")}`
  );
  lines.push("");
  lines.push(sectionHeading(theme, "TOOLS"));
  lines.push(
    `  ${theme.fg("toolTitle", "[bash]")} ${theme.fg("muted", "pnpm test")} ${theme.fg("success", "\u2713")} ${theme.fg("toolDiffAdded", "+++")} ${theme.fg("toolDiffRemoved", "---")} ${theme.fg("toolDiffContext", "context")} ${theme.fg("bashMode", "bash mode")} ${theme.fg("warning", "warn")} ${theme.fg("error", "error")}`
  );
  lines.push("");
  lines.push(sectionHeading(theme, "THINKING RAMP"));
  lines.push(
    `  ${theme.fg("thinkingOff", "off")}  ${theme.fg("thinkingMinimal", "minimal")}  ${theme.fg("thinkingLow", "low")}  ${theme.fg("thinkingMedium", "medium")}  ${theme.fg("thinkingHigh", "high")}  ${theme.fg("thinkingXhigh", "xhigh")}`
  );
  lines.push("");
  lines.push(theme.fg("muted", "press any key to dismiss"));
  return lines;
}

// src/commands/theme-check.ts
function registerThemeCheckCommand(pi) {
  pi.registerCommand("sumo:theme-check", {
    description: "Open a Cathedral theme verification card",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        process.stdout.write("theme-check requires a TTY\n");
        return;
      }
      if (ctx.mode === "rpc") {
        ctx.ui.notify("theme-check overlay unavailable in RPC mode", "warning");
        return;
      }
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          const reader = {
            fg: (slot, text) => theme.fg(slot, text),
            bg: (slot, text) => theme.bg(slot, text)
          };
          return {
            invalidate() {
              tui.requestRender();
            },
            render(width) {
              return renderThemeCheck(reader, Math.max(40, Math.min(width, 120)));
            },
            handleInput(_data) {
              done();
            }
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: 120,
            maxHeight: "100%"
          }
        }
      );
    }
  });
}

// src/commands/worktree.ts
import { existsSync as existsSync7 } from "node:fs";

// src/git/worktree.ts
import { execFile as execFile3, execFileSync as execFileSync2 } from "node:child_process";
import { existsSync as existsSync6, mkdirSync as mkdirSync5 } from "node:fs";
import { basename as basename2, dirname as dirname4, join as join8 } from "node:path";
import { promisify as promisify2 } from "node:util";
var execFileAsync = promisify2(execFile3);
var DEFAULT_GIT_TIMEOUT_MS = 15e3;
function failure(error, message, output = {}) {
  return { ok: false, error, message, stdout: output.stdout, stderr: output.stderr };
}
async function git(repoRoot, args) {
  const { stdout, stderr } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: DEFAULT_GIT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout, stderr };
}
async function gitOk(repoRoot, args) {
  try {
    await git(repoRoot, args);
    return true;
  } catch {
    return false;
  }
}
function isString3(value) {
  return typeof value === "string";
}
function gitFailure(cause) {
  const maybe = cause;
  const stdout = isString3(maybe.stdout) ? maybe.stdout : void 0;
  const stderr = isString3(maybe.stderr) ? maybe.stderr : void 0;
  const message = stderr?.trim() || (isString3(maybe.message) ? maybe.message : "git command failed");
  return failure("git_failed", message, { stdout, stderr });
}
function slugifyBranch(task) {
  const slug = task.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return slug || "task";
}
function worktreeRoot(repoRoot = process.cwd()) {
  return join8(dirname4(repoRoot), `${basename2(repoRoot)}.sumo-worktrees`);
}
function pathSegmentForBranch(branch) {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, "__");
}
async function branchExists(repoRoot, branch) {
  return gitOk(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}
function resolveCreateOptions(options) {
  const baseRef = options.baseRef ?? "HEAD";
  const branch = options.branch ?? `sumo/${slugifyBranch(options.task ?? "task")}`;
  const path2 = options.path ?? join8(worktreeRoot(options.repoRoot), pathSegmentForBranch(branch));
  return { branch, baseRef, path: path2 };
}
async function createWorktree(options) {
  const { branch, baseRef, path: path2 } = resolveCreateOptions(options);
  if (await branchExists(options.repoRoot, branch)) {
    return failure("branch_already_exists", `branch already exists: ${branch}`);
  }
  if (existsSync6(path2)) {
    return failure("path_already_exists", `worktree path already exists: ${path2}`);
  }
  try {
    mkdirSync5(dirname4(path2), { recursive: true });
    await git(options.repoRoot, ["worktree", "add", "-b", branch, path2, baseRef]);
    return { ok: true, path: path2, branch, baseRef };
  } catch (error) {
    return gitFailure(error);
  }
}
function parseWorktreePorcelain(output) {
  const records = output.trim().split(/\n\s*\n/).filter(Boolean);
  return records.map((record) => {
    const info = {};
    for (const line of record.split("\n")) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") info.path = value;
      else if (key === "HEAD") info.head = value;
      else if (key === "branch") info.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "detached") info.detached = true;
    }
    if (!info.path) {
      throw new Error(`missing worktree path in porcelain record: ${record}`);
    }
    return {
      path: info.path,
      head: info.head,
      branch: info.branch,
      detached: info.detached ?? !info.branch
    };
  });
}
async function listWorktrees(repoRoot) {
  try {
    const { stdout } = await git(repoRoot, ["worktree", "list", "--porcelain"]);
    return { ok: true, worktrees: parseWorktreePorcelain(stdout) };
  } catch (error) {
    if (error instanceof Error && error.message.includes("missing worktree path")) {
      return failure("parse_failed", error.message);
    }
    return gitFailure(error);
  }
}
async function removeWorktree(options) {
  const repoRoot = options.repoRoot ?? options.path;
  const args = ["worktree", "remove", ...options.force ? ["--force"] : [], options.path];
  try {
    await git(repoRoot, args);
    return { ok: true };
  } catch (error) {
    return gitFailure(error);
  }
}

// src/commands/worktree.ts
var DEFAULT_SETUP_ACTION = "pnpm install";
function terminalSize() {
  return { columns: process.stdout.columns, rows: process.stdout.rows };
}
function parseWorktreeArgs(args) {
  const trimmed = args.trim();
  const baseMatch = /(^|\s)--base(?:\s+(\S+))?(?=\s|$)/.exec(trimmed);
  const baseRef = baseMatch ? baseMatch[2] ?? "" : void 0;
  const withoutBase = baseMatch ? [trimmed.slice(0, baseMatch.index).trimEnd(), trimmed.slice(baseMatch.index + baseMatch[0].length).trimStart()].filter(Boolean).join(" ") : trimmed;
  const parsedBase = baseRef === void 0 ? {} : { baseRef };
  if (!withoutBase || withoutBase === "new" || withoutBase.startsWith("new ")) {
    return { mode: "fresh", value: withoutBase.slice("new".length).trim(), ...parsedBase };
  }
  if (withoutBase === "open" || withoutBase.startsWith("open ")) {
    return { mode: "reopen", value: withoutBase.slice("open".length).trim(), ...parsedBase };
  }
  if (withoutBase === "prune" || withoutBase.startsWith("prune ")) {
    return { mode: "prune", value: withoutBase.slice("prune".length).trim(), ...parsedBase };
  }
  return { mode: "delegate", value: withoutBase, ...parsedBase };
}
function notify6(_pi, ctx, message, type = "info") {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  process.stdout.write(`${message}
`);
}
function commandForWorktree(task, setupAction) {
  const setup = setupAction.trim();
  const setupPrefix = setup ? `${setup} && ` : "";
  return `${setupPrefix}SUMOCODE_TASK_KEEP_OPEN=1 exec sumocode task ${shellEscape(task)}`;
}
function commandForFreshWorktree(setupAction) {
  const setup = setupAction.trim();
  const setupPrefix = setup ? `${setup} && ` : "";
  return `${setupPrefix}exec sumocode`;
}
function worktreeWorkspaceLabel(branch) {
  return branch.replace(/^sumo\//, "sumo \xB7 ");
}
function listSumoWorktrees(worktrees) {
  return worktrees.filter((worktree) => worktree.branch?.startsWith("sumo/"));
}
function findSumoWorktree(worktrees, target) {
  return listSumoWorktrees(worktrees).find((worktree) => worktree.path === target || worktree.branch === target);
}
async function handlePrune(pi, ctx, target, list, remove) {
  const listed = await list(ctx.cwd);
  if (!listed.ok) {
    notify6(pi, ctx, `/sumo:worktree prune: ${listed.message}`, "warning");
    return;
  }
  const sumoWorktrees = listSumoWorktrees(listed.worktrees);
  if (!target) {
    if (sumoWorktrees.length === 0) {
      notify6(pi, ctx, "no sumo worktrees found");
      return;
    }
    const lines = sumoWorktrees.map((worktree) => `${worktree.branch ?? "detached"} \xB7 ${worktree.path}`);
    notify6(pi, ctx, `sumo worktrees:
${lines.join("\n")}
run /sumo:worktree prune <branch-or-path> to remove one`);
    return;
  }
  const match = findSumoWorktree(listed.worktrees, target);
  if (!match) {
    notify6(pi, ctx, `/sumo:worktree prune: no tracked sumo worktree matched ${target}`, "warning");
    return;
  }
  const removed = await remove({ repoRoot: ctx.cwd, path: match.path });
  if (!removed.ok) {
    notify6(pi, ctx, `/sumo:worktree prune: ${removed.message}`, "warning");
    return;
  }
  notify6(pi, ctx, `removed worktree ${match.branch ?? match.path}`);
}
function registerWorktreeCommand(pi, options = {}) {
  const create = options.create ?? createWorktree;
  const list = options.list ?? listWorktrees;
  const remove = options.remove ?? removeWorktree;
  const configuredTerminalHost = options.terminalHost;
  const pathExists3 = options.pathExists ?? existsSync7;
  const getTerminalSize2 = options.terminalSize ?? terminalSize;
  const setupAction = options.setupAction ?? process.env.SUMOCODE_WORKTREE_SETUP ?? DEFAULT_SETUP_ACTION;
  pi.registerCommand("sumo:worktree", {
    description: "Open a fresh worktree session, reopen one with open <target>, delegate <task>, or prune [target]; fresh/delegate accept --base <ref>",
    handler: async (args, ctx) => {
      try {
        const parsed = parseWorktreeArgs(args ?? "");
        if (parsed.baseRef === "") {
          notify6(pi, ctx, "Usage: /sumo:worktree [new [name] | open <branch-or-path> | <task> | prune [branch-or-path]] [--base <ref>]", "warning");
          return;
        }
        if (parsed.baseRef !== void 0 && (parsed.mode === "reopen" || parsed.mode === "prune")) {
          notify6(pi, ctx, "/sumo:worktree: --base is only valid for fresh or delegated worktrees", "warning");
          return;
        }
        if (parsed.mode === "prune") {
          await handlePrune(pi, ctx, parsed.value, list, remove);
          return;
        }
        if (!ctx.hasUI) {
          notify6(pi, ctx, "/sumo:worktree requires interactive UI", "warning");
          return;
        }
        const terminalHost = configuredTerminalHost ?? getTerminalHost();
        if (terminalHost.kind === "none") {
          notify6(pi, ctx, "/sumo:worktree requires a running herdr terminal host", "warning");
          return;
        }
        if (parsed.mode === "reopen") {
          if (!parsed.value) {
            notify6(pi, ctx, "Usage: /sumo:worktree open <branch-or-path>", "warning");
            return;
          }
          const listed = await list(ctx.cwd);
          if (!listed.ok) {
            notify6(pi, ctx, `/sumo:worktree open: ${listed.message}`, "warning");
            return;
          }
          const match = findSumoWorktree(listed.worktrees, parsed.value);
          if (!match) {
            const available = listSumoWorktrees(listed.worktrees).map((worktree) => worktree.branch ?? worktree.path);
            notify6(
              pi,
              ctx,
              `/sumo:worktree open: no tracked sumo worktree matched ${parsed.value} \xB7 available: ${available.join(", ") || "none"}`,
              "warning"
            );
            return;
          }
          const paneCommand2 = commandForFreshWorktree(setupAction);
          const label2 = worktreeWorkspaceLabel(match.branch ?? match.path);
          if (terminalHost.openExistingWorktreeWorkspace) {
            const opened3 = await terminalHost.openExistingWorktreeWorkspace(pi, { path: match.path, label: label2, shellCommand: paneCommand2, sourceCwd: ctx.cwd });
            if (opened3.ok) {
              notify6(pi, ctx, `opened ${match.branch ?? match.path} as herdr workspace "${label2}" \xB7 setup: ${setupAction || "none"}`);
              return;
            }
            notify6(pi, ctx, `/sumo:worktree: herdr workspace open failed (${opened3.error}); falling back to split`, "warning");
          }
          const direction2 = chooseDiffSplitDirection(getTerminalSize2());
          const command2 = buildShellCommand(match.path, paneCommand2);
          const opened2 = await terminalHost.openCommandInSplit(pi, direction2, { cwd: match.path, shellCommand: command2 });
          if (!opened2.ok) {
            notify6(pi, ctx, `/sumo:worktree: ${opened2.error}`, "warning");
            return;
          }
          notify6(pi, ctx, `reopened ${match.branch ?? match.path} in ${direction2} split`);
          return;
        }
        const task = parsed.mode === "fresh" ? parsed.value || `wt-${Date.now().toString(36)}` : parsed.value;
        const resolved = resolveCreateOptions({ repoRoot: ctx.cwd, task, baseRef: parsed.baseRef ?? "HEAD" });
        const paneCommand = parsed.mode === "fresh" ? commandForFreshWorktree(setupAction) : commandForWorktree(parsed.value, setupAction);
        const label = worktreeWorkspaceLabel(resolved.branch);
        let created;
        if (terminalHost.openWorktreeWorkspace) {
          const opened2 = await terminalHost.openWorktreeWorkspace(pi, { ...resolved, label, shellCommand: paneCommand, sourceCwd: ctx.cwd });
          if (opened2.ok) {
            const freshLabel2 = parsed.mode === "fresh" ? " (fresh session)" : "";
            notify6(pi, ctx, `opened ${resolved.branch}${freshLabel2} as herdr workspace "${label}" \xB7 setup: ${setupAction || "none"}`);
            return;
          }
          if (pathExists3(resolved.path)) {
            const recovery = parsed.mode === "fresh" ? `Open it with /sumo:worktree open ${resolved.branch}` : `Open it with /sumo:worktree open ${resolved.branch} (opens a fresh session \u2014 re-issue your task there; the delegated prompt was not delivered)`;
            notify6(
              pi,
              ctx,
              `/sumo:worktree: herdr created workspace "${label}" but launching the session failed (${opened2.error}). ${recovery}`,
              "warning"
            );
            return;
          }
          notify6(pi, ctx, `/sumo:worktree: herdr workspace create failed (${opened2.error}); falling back to split`, "warning");
        }
        created = await create({ repoRoot: ctx.cwd, task, baseRef: parsed.baseRef ?? "HEAD" });
        if (!created.ok) {
          notify6(pi, ctx, `/sumo:worktree: ${created.message}`, "warning");
          return;
        }
        const command = buildShellCommand(created.path, paneCommand);
        if (parsed.mode === "fresh" && !sessionHasMessages(ctx) && terminalHost.replaceCurrentPane) {
          const opened2 = await terminalHost.replaceCurrentPane(pi, { cwd: created.path, shellCommand: command });
          if (!opened2.ok) notify6(pi, ctx, `/sumo:worktree: ${opened2.error}`, "warning");
          return;
        }
        const direction = chooseDiffSplitDirection(getTerminalSize2());
        const opened = await terminalHost.openCommandInSplit(pi, direction, { cwd: created.path, shellCommand: command });
        if (!opened.ok) {
          notify6(pi, ctx, `/sumo:worktree: ${opened.error}`, "warning");
          return;
        }
        const freshLabel = parsed.mode === "fresh" ? " (fresh session)" : "";
        notify6(pi, ctx, `opened ${created.branch}${freshLabel} in ${direction} split \xB7 setup: ${setupAction || "none"}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify6(pi, ctx, `/sumo:worktree: ${message}`, "warning");
      }
    }
  });
}

// src/memory-editor.ts
import { matchesKey as matchesKey6, wrapTextWithAnsi as wrapTextWithAnsi3 } from "@earendil-works/pi-tui";

// src/memory.ts
import { readFileSync as readFileSync8 } from "node:fs";
import { homedir as homedir9 } from "node:os";
import { join as join9 } from "node:path";
var MemoryClientError = class extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "MemoryClientError";
  }
  code;
  cause;
};
var DEFAULT_REMNIC_BASE_URL = "http://127.0.0.1:7749";
var DEFAULT_REMNIC_TIMEOUT_MS = 3e3;
var DEFAULT_REMNIC_TOKEN_PATH = join9(homedir9(), ".sumocode", "remnic-auth-token");
function defaultTokenProvider() {
  try {
    return readFileSync8(DEFAULT_REMNIC_TOKEN_PATH, "utf8").trim() || void 0;
  } catch {
    return void 0;
  }
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function asStringArray(value) {
  if (!Array.isArray(value)) return void 0;
  const strings = value.filter((item) => typeof item === "string");
  return strings.length === 0 ? void 0 : strings;
}
function factFromUnknown(value) {
  const raw = isRecord3(value) && isRecord3(value.memory) ? value.memory : value;
  if (!isRecord3(raw)) return void 0;
  const id = asString(raw.id) ?? asString(raw.memoryId) ?? (isRecord3(value) ? asString(value.memoryId) : void 0);
  const text = asString(raw.content) ?? asString(raw.text) ?? asString(raw.summary) ?? asString(raw.preview);
  if (!id || !text) return void 0;
  return {
    id,
    text,
    category: asString(raw.category),
    score: asNumber(raw.score) ?? (isRecord3(value) ? asNumber(value.score) : void 0),
    createdAt: asString(raw.createdAt) ?? asString(raw.created_at) ?? asString(raw.created),
    updatedAt: asString(raw.updatedAt) ?? asString(raw.updated_at) ?? asString(raw.updated),
    tags: asStringArray(raw.tags),
    entityRef: asString(raw.entityRef) ?? asString(raw.entity_ref),
    status: asString(raw.status)
  };
}
function errorCodeForStatus(status) {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 502 || status === 503 || status === 504) return "daemon_down";
  return "request_failed";
}
function jsonHeaders(token) {
  return {
    "content-type": "application/json",
    ...token && { authorization: `Bearer ${token}` }
  };
}
function withTimeout(timeoutMs) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller;
}
function createRemnicMemoryClient(options = {}) {
  const baseUrl = (options.baseUrl ?? DEFAULT_REMNIC_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const tokenProvider = options.tokenProvider ?? defaultTokenProvider;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMNIC_TIMEOUT_MS;
  async function requestJson(path2, init = {}) {
    const controller = withTimeout(timeoutMs);
    const token = tokenProvider();
    try {
      const response = await fetchImpl(`${baseUrl}${path2}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...jsonHeaders(token),
          ...init.headers ?? void 0
        }
      });
      if (!response.ok) {
        const code = errorCodeForStatus(response.status);
        throw new MemoryClientError(code, `Remnic request failed with ${response.status}`);
      }
      try {
        return await response.json();
      } catch (err) {
        throw new MemoryClientError("malformed_response", "Remnic returned invalid JSON", err);
      }
    } catch (err) {
      if (err instanceof MemoryClientError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new MemoryClientError("timeout", "Remnic request timed out", err);
      }
      throw new MemoryClientError("daemon_down", "memory unavailable", err);
    }
  }
  return {
    async query(prompt, n = 5) {
      const body = JSON.stringify({ query: prompt.trim() || " ", topK: n, mode: "full" });
      const payload = await requestJson("/engram/v1/recall", { method: "POST", body });
      if (!isRecord3(payload)) {
        throw new MemoryClientError("malformed_response", "Remnic recall response was not an object");
      }
      const rawResults = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.memories) ? payload.memories : void 0;
      if (!rawResults) {
        throw new MemoryClientError("malformed_response", "Remnic recall response had no results array");
      }
      return rawResults.map(factFromUnknown).filter((fact) => fact !== void 0).slice(0, n);
    },
    async status() {
      try {
        await requestJson("/engram/v1/health", { method: "GET" });
        const browse = await requestJson("/engram/v1/memories?limit=1&sort=updated_desc", { method: "GET" });
        if (!isRecord3(browse)) return { ok: true, factCount: 0 };
        const memories = Array.isArray(browse.memories) ? browse.memories : [];
        const latest = factFromUnknown(memories[0]);
        return {
          ok: true,
          factCount: asNumber(browse.total) ?? asNumber(browse.count) ?? memories.length,
          lastExtractionAt: latest?.updatedAt ?? latest?.createdAt
        };
      } catch (err) {
        return { ok: false, factCount: 0, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async add(text, category) {
      const payload = await requestJson("/engram/v1/memories", {
        method: "POST",
        body: JSON.stringify({ content: text, ...category && { category } })
      });
      const immediate = factFromUnknown(payload);
      if (immediate) return immediate;
      const lookup = await requestJson(
        `/engram/v1/memories?q=${encodeURIComponent(text)}&limit=1&sort=updated_desc`,
        { method: "GET" }
      );
      if (isRecord3(lookup) && Array.isArray(lookup.memories)) {
        const fact = factFromUnknown(lookup.memories[0]);
        if (fact) return fact;
      }
      throw new MemoryClientError("malformed_response", "Remnic add response did not contain a memory fact");
    },
    async forget(factId) {
      await requestJson("/engram/v1/review-disposition", {
        method: "POST",
        body: JSON.stringify({
          memoryId: factId,
          status: "archived",
          reasonCode: "sumocode_forget"
        })
      });
    },
    async observe(sessionKey, messages) {
      await requestJson("/engram/v1/observe", {
        method: "POST",
        body: JSON.stringify({
          sessionKey,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content
          }))
        })
      });
    },
    async browse(params = {}) {
      const search = new URLSearchParams();
      if (params.status && params.status !== "all") search.set("status", params.status);
      else if (!params.status) search.set("status", "active");
      if (params.q) search.set("q", params.q);
      search.set("limit", String(params.limit ?? 200));
      search.set("offset", String(params.offset ?? 0));
      search.set("sort", "updated_desc");
      const payload = await requestJson(`/engram/v1/memories?${search.toString()}`, { method: "GET" });
      if (!isRecord3(payload)) {
        throw new MemoryClientError("malformed_response", "Remnic browse response was not an object");
      }
      const memories = Array.isArray(payload.memories) ? payload.memories : [];
      return memories.map(factFromUnknown).filter((fact) => fact !== void 0);
    }
  };
}

// src/memory-categorization.ts
var MEMORY_PANELS = [
  "IDENTITY",
  "PREFERENCES",
  "WORKFLOW",
  "PROJECTS",
  "SYSTEM",
  "GENERAL"
];
var KNOWN_PANEL_SET = new Set(MEMORY_PANELS);
function routeFactToPanel(fact) {
  for (const tag of fact.tags ?? []) {
    const lower = tag.toLowerCase();
    if (!lower.startsWith("sumocode:")) continue;
    const panel = lower.slice("sumocode:".length).toUpperCase();
    if (KNOWN_PANEL_SET.has(panel)) return panel;
  }
  const cat = fact.category?.toLowerCase();
  if (cat === "preference" || cat === "rule" || cat === "principle") return "PREFERENCES";
  if (cat === "procedure" || cat === "skill" || cat === "decision") return "WORKFLOW";
  if (cat === "entity" || cat === "relationship") return "IDENTITY";
  const text = (fact.text ?? "").toLowerCase();
  if (/\b(works\s+at|based\s+in|located\s+in|lives\s+in|senior\s+(frontend|backend|engineer|developer)|software\s+engineer|principal\s+engineer|staff\s+engineer|lead\s+engineer)\b/.test(text)) return "IDENTITY";
  if (/\b(herdr|portrait|landscape|terminal|libghostty|visual verification)\b/.test(text)) return "SYSTEM";
  if (/\b(sumocode|openclaw|cathedral|project:)\b/.test(text)) return "PROJECTS";
  if (/\b(tdd|workflow|always|never|prefer)\b/.test(text)) return "WORKFLOW";
  if (/\b(typescript|pnpm|react|vite|tailwind|next\.?js|bun|node)\b/.test(text)) return "PREFERENCES";
  return "GENERAL";
}
function groupFactsByPanel(facts) {
  const buckets = /* @__PURE__ */ new Map();
  for (const panel of MEMORY_PANELS) buckets.set(panel, []);
  for (const fact of facts) {
    const panel = routeFactToPanel(fact);
    buckets.get(panel).push(fact);
  }
  const result = [];
  for (const panel of MEMORY_PANELS) {
    const bucket = buckets.get(panel);
    if (panel === "GENERAL" && bucket.length === 0) continue;
    result.push({ panel, facts: bucket });
  }
  return result;
}

// src/memory-editor.ts
var SEARCH_PROMPT_GLYPH = "\u276F";
var PANEL_INDENT = "   ";
var PANEL_GAP = "   ";
var MEMORY_EDITOR_HINTS = "\u2191\u2193 wander    /  search    e  revise    d  forget    \u238B retreat";
var MEMORY_EDITOR_OVERLAY_OPTIONS = {
  anchor: "center",
  // Match the V2 Bible and the other Cathedral modals: the Scriptorium
  // content is designed as a 100-column panel. Percentage sizing made it
  // balloon across landscape terminals while the inner two-column grid stayed
  // sparse and awkward.
  width: 100,
  minWidth: 56,
  maxHeight: "90%"
};
function filterGroups(groups, query) {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return groups.map((group) => ({ panel: group.panel, facts: [...group.facts] }));
  return groups.map((group) => ({
    panel: group.panel,
    facts: group.facts.filter((fact) => fact.text.toLowerCase().includes(trimmed))
  }));
}
function flatVisibleFacts(filtered) {
  const out = [];
  for (const group of filtered) for (const fact of group.facts) out.push(fact);
  return out;
}
function ensureFocusedFact(snapshot) {
  if (snapshot.focusedFactId !== null) return snapshot;
  const visible = flatVisibleFacts(filterGroups(snapshot.groups, snapshot.searchQuery));
  if (visible.length === 0) return snapshot;
  return { ...snapshot, focusedFactId: visible[0].id };
}
function renderPanelRows(group, width, focusedFactId) {
  const colors = activeThemeColors();
  const inner = Math.max(20, width);
  const labelInner = ` ${group.panel} `;
  const dashes = Math.max(2, inner - labelInner.length - 3);
  const top = `\u256D\u2500${fg2(labelInner, colors.accent)}${fg2("\u2500".repeat(dashes), colors.divider)}\u256E`;
  const bottom = `\u2570${"\u2500".repeat(inner - 2)}\u256F`;
  const rows = [];
  rows.push(`${fg2("\u256D\u2500", colors.divider)}${fg2(labelInner, colors.accent)}${fg2(`${"\u2500".repeat(dashes)}\u256E`, colors.divider)}`);
  if (group.facts.length === 0) {
    const left = fg2("\u2502", colors.divider);
    const right = fg2("\u2502", colors.divider);
    const body = ` ${fg2("(empty)", colors.foregroundDim)} `;
    const padCount = Math.max(0, inner - 2 - visibleLength(body));
    rows.push(`${left}${body}${" ".repeat(padCount)}${right}`);
  } else {
    for (const fact of group.facts) {
      const focused = fact.id === focusedFactId;
      const marker = focusMarker(focused);
      const maxBody = inner - 6;
      const body = fact.text.length > maxBody ? `${fact.text.slice(0, maxBody - 1)}\u2026` : fact.text;
      const text = fg2(body, colors.foreground);
      const left = fg2("\u2502", colors.divider);
      const right = fg2("\u2502", colors.divider);
      const content = ` ${marker} ${text}`;
      const padCount = Math.max(0, inner - 2 - visibleLength(content));
      rows.push(`${left}${content}${" ".repeat(padCount)}${right}`);
    }
  }
  rows.push(fg2(bottom, colors.divider));
  void top;
  return rows;
}
function buildInnerRows2(snapshot, contentWidth) {
  const filtered = filterGroups(snapshot.groups, snapshot.searchQuery);
  const colors = activeThemeColors();
  const inner = [];
  inner.push("");
  inner.push(titleRow("MEMORY SCRIPTORIUM", contentWidth));
  inner.push("");
  inner.push(splitRule(contentWidth));
  inner.push("");
  const chevron = fg2(SEARCH_PROMPT_GLYPH, colors.accent);
  const searchDisplay = snapshot.searchQuery === "" ? fg2("search remembered facts\u2026", colors.foregroundDim) : fg2(snapshot.searchQuery, colors.foreground);
  const factsLabel = fg2(`${snapshot.factsTotal} facts`, colors.foregroundDim);
  const left = `${PANEL_INDENT}${chevron}  ${searchDisplay}`;
  const right = `${factsLabel}${PANEL_INDENT}`;
  const gap = Math.max(2, contentWidth - visibleLength(left) - visibleLength(right));
  inner.push(`${left}${" ".repeat(gap)}${right}`);
  inner.push("");
  const visibleGroups = filtered.filter((group) => group.panel !== "GENERAL" || group.facts.length > 0);
  const indentWidth = visibleLength(PANEL_INDENT) * 2 + visibleLength(PANEL_GAP);
  const panelInner = Math.max(20, Math.floor((contentWidth - indentWidth) / 2));
  for (let i = 0; i < visibleGroups.length; i += 2) {
    const leftPanel = renderPanelRows(visibleGroups[i], panelInner, snapshot.focusedFactId);
    const rightPanel = i + 1 < visibleGroups.length ? renderPanelRows(visibleGroups[i + 1], panelInner, snapshot.focusedFactId) : null;
    const rowCount = rightPanel ? Math.max(leftPanel.length, rightPanel.length) : leftPanel.length;
    for (let r = 0; r < rowCount; r++) {
      const leftRow = leftPanel[r] ?? "";
      const leftPad = Math.max(0, panelInner - visibleLength(leftRow));
      const rightRow = rightPanel ? rightPanel[r] ?? "" : "";
      const rightPad = rightPanel ? Math.max(0, panelInner - visibleLength(rightRow)) : 0;
      const composed = rightPanel ? `${PANEL_INDENT}${leftRow}${" ".repeat(leftPad)}${PANEL_GAP}${rightRow}${" ".repeat(rightPad)}` : `${PANEL_INDENT}${leftRow}${" ".repeat(leftPad)}`;
      inner.push(composed);
    }
    inner.push("");
  }
  inner.push(splitRule(contentWidth));
  inner.push(center(fg2(MEMORY_EDITOR_HINTS, colors.foregroundDim), contentWidth));
  inner.push("");
  return inner;
}
function renderMemoryEditor(snapshot, width) {
  if (width < 1) return [];
  const wrapped = wrapTextWithAnsi3("", width);
  void wrapped;
  const rows = buildInnerRows2(snapshot, width);
  return rows.map((row3) => wrapPanelRow(row3, width));
}
function nextFocusAfterRemoval(previousVisible, currentVisible, previousFocusId) {
  if (currentVisible.length === 0) return null;
  if (previousFocusId === null) return currentVisible[0]?.id ?? null;
  const prevIndex = previousVisible.findIndex((fact) => fact.id === previousFocusId);
  if (prevIndex === -1) return currentVisible[0]?.id ?? null;
  const stillVisible = currentVisible.find((fact) => fact.id === previousFocusId);
  if (stillVisible) return stillVisible.id;
  const fallbackIndex = Math.min(prevIndex, currentVisible.length - 1);
  return currentVisible[fallbackIndex]?.id ?? currentVisible[0]?.id ?? null;
}
var MemoryEditorComponent = class {
  snapshot;
  deps;
  busy = false;
  constructor(initial, deps) {
    this.snapshot = ensureFocusedFact(initial);
    this.deps = deps;
  }
  invalidate() {
    this.deps.invalidate();
  }
  render(width) {
    return renderMemoryEditor(this.snapshot, width);
  }
  handleInput(data) {
    const mode = this.snapshot.mode ?? "command";
    if (mode === "search") {
      if (matchesKey6(data, "escape") || data === "escape" || data === "\x1B") {
        this.snapshot = { ...this.snapshot, mode: "command" };
        this.deps.invalidate();
        return;
      }
      if (matchesKey6(data, "backspace") || data === "backspace") {
        this.updateSearch(this.snapshot.searchQuery.slice(0, -1));
        return;
      }
      if (matchesKey6(data, "enter") || data === "enter" || matchesKey6(data, "return") || data === "return" || data === "\r" || data === "\n") {
        this.snapshot = { ...this.snapshot, mode: "command" };
        this.deps.invalidate();
        return;
      }
      if (data.length === 1 && !new RegExp("\\p{Cc}", "u").test(data)) {
        this.updateSearch(`${this.snapshot.searchQuery}${data}`);
      }
      return;
    }
    if (matchesKey6(data, "escape") || data === "escape" || data === "\x1B") {
      this.deps.close();
      return;
    }
    if (data === "/") {
      this.snapshot = { ...this.snapshot, mode: "search" };
      this.deps.invalidate();
      return;
    }
    if (matchesKey6(data, "up") || data === "up") {
      this.moveFocus(-1);
      return;
    }
    if (matchesKey6(data, "down") || data === "down") {
      this.moveFocus(1);
      return;
    }
    if (data === "d" && !this.busy) {
      void this.handleForget();
      return;
    }
    if (data === "e") {
      this.deps.notify("revise inline coming soon \u2014 use /sumo:memory forget <id> + /sumo:memory add <text>", "info");
      return;
    }
  }
  updateSearch(query) {
    const previousVisible = flatVisibleFacts(filterGroups(this.snapshot.groups, this.snapshot.searchQuery));
    const nextVisible = flatVisibleFacts(filterGroups(this.snapshot.groups, query));
    const focusedFactId = nextFocusAfterRemoval(previousVisible, nextVisible, this.snapshot.focusedFactId);
    this.snapshot = { ...this.snapshot, searchQuery: query, focusedFactId };
    this.deps.invalidate();
  }
  moveFocus(delta) {
    const visible = flatVisibleFacts(filterGroups(this.snapshot.groups, this.snapshot.searchQuery));
    if (visible.length === 0) {
      this.snapshot = { ...this.snapshot, focusedFactId: null };
      this.deps.invalidate();
      return;
    }
    const currentIndex = this.snapshot.focusedFactId === null ? -1 : visible.findIndex((fact) => fact.id === this.snapshot.focusedFactId);
    const nextIndex2 = currentIndex === -1 ? delta > 0 ? 0 : visible.length - 1 : (currentIndex + delta + visible.length) % visible.length;
    this.snapshot = { ...this.snapshot, focusedFactId: visible[nextIndex2].id };
    this.deps.invalidate();
  }
  async handleForget() {
    const focusId = this.snapshot.focusedFactId;
    if (!focusId) {
      this.deps.notify("nothing focused to forget", "info");
      return;
    }
    this.busy = true;
    const previousGroups = this.snapshot.groups;
    const previousSearch = this.snapshot.searchQuery;
    const previousFactsTotal = this.snapshot.factsTotal;
    const optimisticGroups = previousGroups.map((group) => ({
      panel: group.panel,
      facts: group.facts.filter((fact) => fact.id !== focusId)
    }));
    const previousVisible = flatVisibleFacts(filterGroups(previousGroups, previousSearch));
    const nextVisible = flatVisibleFacts(filterGroups(optimisticGroups, previousSearch));
    this.snapshot = {
      ...this.snapshot,
      groups: optimisticGroups,
      factsTotal: optimisticGroups.reduce((total, group) => total + group.facts.length, 0),
      focusedFactId: nextFocusAfterRemoval(previousVisible, nextVisible, focusId)
    };
    this.deps.invalidate();
    try {
      await this.deps.client.forget(focusId);
      this.deps.notify("forgotten", "info");
    } catch (error) {
      const restoredVisible = flatVisibleFacts(filterGroups(previousGroups, this.snapshot.searchQuery));
      const restoredFocus = restoredVisible.some((fact) => fact.id === focusId) ? focusId : nextFocusAfterRemoval(restoredVisible, restoredVisible, null);
      this.snapshot = {
        ...this.snapshot,
        groups: previousGroups,
        factsTotal: previousFactsTotal,
        focusedFactId: restoredFocus
      };
      this.deps.invalidate();
      this.deps.notify(`forget failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } finally {
      this.busy = false;
    }
  }
};
async function showMemoryEditor(ctx, client = createRemnicMemoryClient()) {
  if (ctx.mode === "rpc") {
    ctx.ui.notify("memory editor overlay unavailable in RPC mode; use status/add/forget", "warning");
    return;
  }
  let facts = [];
  let unavailable = null;
  try {
    facts = await client.browse({ status: "active", limit: 500 });
  } catch (err) {
    unavailable = err instanceof MemoryClientError ? err.message : String(err);
  }
  if (unavailable) {
    ctx.ui.notify(`memory unavailable: ${unavailable}`, "warning");
    return;
  }
  const groups = groupFactsByPanel(facts);
  const initial = {
    searchQuery: "",
    groups,
    factsTotal: facts.length,
    focusedFactId: null
  };
  await ctx.ui.custom(
    (_tui, _theme, _kb, done) => new MemoryEditorComponent(initial, {
      client,
      notify: (message, level) => ctx.ui.notify(message, level ?? "info"),
      invalidate: () => _tui.requestRender(),
      close: () => done()
    }),
    {
      overlay: true,
      overlayOptions: MEMORY_EDITOR_OVERLAY_OPTIONS,
      onHandle: (_handle) => {
      }
    }
  );
}
function formatMemoryStatus(status) {
  if (!status.ok) return `memory unavailable${status.error ? `: ${status.error}` : ""}`;
  const count = `${status.factCount} ${status.factCount === 1 ? "fact" : "facts"}`;
  const latest = status.lastExtractionAt ? ` \xB7 last extraction ${status.lastExtractionAt}` : " \xB7 no extraction recorded";
  return `memory ok \xB7 ${count}${latest}`;
}
function registerMemoryCommand(pi, createClient = createRemnicMemoryClient) {
  pi.registerCommand("sumo:memory", {
    description: "open the cathedral memory scriptorium (or `add` / `forget` / `status` for direct ops)",
    handler: async (args, ctx) => {
      const arg = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (arg === "" || arg === "edit") {
        await showMemoryEditor(ctx, createClient());
        return;
      }
      if (arg === "add") {
        const text = args.replace(/^\s*add\s+/, "").trim();
        if (!text) {
          ctx.ui.notify("usage: /sumo:memory add <text>", "info");
          return;
        }
        try {
          const client = createClient();
          await client.add(text);
          ctx.ui.notify(`memory added: ${text.slice(0, 40)}${text.length > 40 ? "\u2026" : ""}`, "info");
        } catch (err) {
          ctx.ui.notify(
            `memory add failed: ${err instanceof Error ? err.message : String(err)}`,
            "warning"
          );
        }
        return;
      }
      if (arg === "forget") {
        const id = args.replace(/^\s*forget\s+/, "").trim();
        if (!id) {
          ctx.ui.notify("usage: /sumo:memory forget <fact-id>", "info");
          return;
        }
        try {
          const client = createClient();
          await client.forget(id);
          ctx.ui.notify(`memory forgotten: ${id}`, "info");
        } catch (err) {
          ctx.ui.notify(
            `memory forget failed: ${err instanceof Error ? err.message : String(err)}`,
            "warning"
          );
        }
        return;
      }
      if (arg === "status") {
        try {
          const client = createClient();
          ctx.ui.notify(formatMemoryStatus(await client.status()), "info");
        } catch (err) {
          ctx.ui.notify(`memory status failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
        }
        return;
      }
      ctx.ui.notify("usage: /sumo:memory [edit|add <text>|forget <id>|status]", "info");
    }
  });
}

// src/sidebar.ts
import { homedir as homedir11 } from "node:os";
import { basename as basename3, join as join11 } from "node:path";

// src/mcp-config-reader.ts
import { existsSync as existsSync8, readFileSync as readFileSync9 } from "node:fs";
import { homedir as homedir10 } from "node:os";
import { join as join10 } from "node:path";
function resolveMcpConfigCandidates(opts) {
  const home = homedir10();
  return [
    join10(home, ".config", "mcp", "mcp.json"),
    join10(opts.piAgentDir, "mcp.json"),
    join10(opts.cwd, ".mcp.json"),
    join10(opts.cwd, ".pi", "mcp.json")
  ];
}
function readMcpConfig(path2) {
  try {
    if (!existsSync8(path2)) return void 0;
    const raw = readFileSync9(path2, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !isObjectValue2(parsed)) return void 0;
    return parsed;
  } catch {
    return void 0;
  }
}
function isObjectValue2(value) {
  return typeof value === "object";
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasNonEmptyImports(cfg) {
  return Array.isArray(cfg.imports) && cfg.imports.length > 0;
}
var mcpDiagnosticHandler;
function setMcpDiagnosticHandler(handler) {
  mcpDiagnosticHandler = handler;
}
function loadConfiguredMcpServers(opts) {
  const merged = /* @__PURE__ */ new Map();
  for (const path2 of resolveMcpConfigCandidates(opts)) {
    const cfg = readMcpConfig(path2);
    if (!cfg) continue;
    if (hasNonEmptyImports(cfg)) {
      mcpDiagnosticHandler?.({
        type: "mcp_imports_unresolved",
        path: path2,
        // SAFETY: guarded by hasNonEmptyImports, which checks Array.isArray.
        importsCount: cfg.imports.length
      });
    }
    if (!isPlainObject(cfg.mcpServers)) continue;
    for (const name of Object.keys(cfg.mcpServers)) {
      merged.set(name, { name, status: "idle" });
    }
  }
  return [...merged.values()];
}
var cachedRosters = /* @__PURE__ */ new Map();
function cacheKey(opts) {
  return `${opts.cwd}\0${opts.piAgentDir}`;
}
function getCachedMcpRoster(opts) {
  const key = cacheKey(opts);
  let roster = cachedRosters.get(key);
  if (roster === void 0) {
    roster = loadConfiguredMcpServers(opts);
    cachedRosters.set(key, roster);
  }
  return roster;
}

// src/sumo-tui/cathedral/ansi.ts
import { truncateToWidth as truncateToWidth8, visibleWidth as visibleWidth9 } from "@earendil-works/pi-tui";
var SIDEBAR_INDENT = "  ";
function parseHex2(hex) {
  const normalized = hex.replace("#", "");
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}
function fgHex(hex) {
  const { r, g, b } = parseHex2(hex);
  return `\x1B[38;2;${r};${g};${b}m`;
}
function visibleLength3(text) {
  return visibleWidth9(text);
}
function padAnsiToWidth2(line, width) {
  const safeWidth = Math.max(0, Math.floor(width));
  const truncated = visibleWidth9(line) > safeWidth ? truncateToWidth8(line, safeWidth, "") : line;
  const padding = Math.max(0, safeWidth - visibleWidth9(truncated));
  return `${truncated}${" ".repeat(padding)}`;
}
function surfaceLine(content, width) {
  return lineToAnsi(textLine([span(content)], {
    fg: activeThemeColors().foreground,
    bg: activeThemeColors().surface
  }), { width });
}

// src/sumo-tui/cathedral/metrics-hud.ts
var HISTORY_SIZE = 10;
function pushSample(history, value) {
  history.push(Number.isFinite(value) ? value : 0);
  while (history.length > HISTORY_SIZE) history.shift();
}
var MetricsHud = class {
  getRendersPerSecond;
  sampleIntervalMs;
  setTimer;
  clearTimer;
  now;
  cpuUsageFn;
  memoryUsageFn;
  timer;
  lastCpu;
  lastWallMs;
  cpuPercent = 0;
  memoryMiB = 0;
  fps = 0;
  cpuHistory = [];
  memoryHistory = [];
  fpsHistory = [];
  constructor(options = {}) {
    this.getRendersPerSecond = options.getRendersPerSecond ?? (() => 0);
    this.sampleIntervalMs = options.sampleIntervalMs ?? 1e3;
    this.setTimer = options.setInterval ?? setInterval;
    this.clearTimer = options.clearInterval ?? clearInterval;
    this.now = options.now ?? (() => Date.now());
    this.cpuUsageFn = options.cpuUsage ?? (() => process.cpuUsage());
    this.memoryUsageFn = options.memoryUsage ?? (() => process.memoryUsage());
    this.lastCpu = this.cpuUsageFn();
    this.lastWallMs = this.now();
  }
  start(onSample) {
    if (this.timer) return;
    this.sample();
    this.timer = this.setTimer(() => {
      this.sample();
      onSample?.();
    }, this.sampleIntervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = void 0;
  }
  sample() {
    const nowMs = this.now();
    const usage = this.cpuUsageFn();
    const elapsedMicros = Math.max(1, (nowMs - this.lastWallMs) * 1e3);
    const cpuDeltaMicros = Math.max(0, usage.user - this.lastCpu.user + (usage.system - this.lastCpu.system));
    this.cpuPercent = cpuDeltaMicros / elapsedMicros * 100;
    this.memoryMiB = this.memoryUsageFn().rss / 1024 / 1024;
    this.fps = this.getRendersPerSecond();
    this.lastCpu = usage;
    this.lastWallMs = nowMs;
    pushSample(this.cpuHistory, this.cpuPercent);
    pushSample(this.memoryHistory, this.memoryMiB);
    pushSample(this.fpsHistory, this.fps);
    return this.snapshot();
  }
  snapshot() {
    return {
      cpuPercent: this.cpuPercent,
      memoryMiB: this.memoryMiB,
      fps: this.fps,
      cpuHistory: [...this.cpuHistory],
      memoryHistory: [...this.memoryHistory],
      fpsHistory: [...this.fpsHistory]
    };
  }
};

// src/sumo-tui/runtime/worker-runtime.ts
var CancellableWorkerRuntime = class {
  nextId = 0;
  exclusiveWorkers = /* @__PURE__ */ new Map();
  start(options) {
    const id = ++this.nextId;
    const controller = new AbortController();
    let handle;
    let resolveResult;
    const result = new Promise((resolve10) => {
      resolveResult = resolve10;
    });
    const isCurrent = () => !options.exclusiveGroup || this.exclusiveWorkers.get(options.exclusiveGroup) === handle;
    handle = {
      id,
      name: options.name,
      exclusiveGroup: options.exclusiveGroup,
      signal: controller.signal,
      controller,
      isCurrent,
      cancel: () => controller.abort(),
      result
    };
    if (options.exclusiveGroup) {
      this.exclusiveWorkers.get(options.exclusiveGroup)?.cancel();
      this.exclusiveWorkers.set(options.exclusiveGroup, handle);
    }
    void this.execute(options, handle).then(resolveResult);
    return handle;
  }
  cancelGroup(exclusiveGroup) {
    const current = this.exclusiveWorkers.get(exclusiveGroup);
    if (!current) return false;
    current.cancel();
    this.exclusiveWorkers.delete(exclusiveGroup);
    return true;
  }
  async execute(options, handle) {
    try {
      const value = await options.run({
        id: handle.id,
        name: options.name,
        exclusiveGroup: options.exclusiveGroup,
        signal: handle.signal,
        isCurrent: handle.isCurrent
      });
      if (handle.signal.aborted || !handle.isCurrent()) return this.cancelled(handle);
      return { status: "completed", value };
    } catch (error) {
      if (handle.signal.aborted || !handle.isCurrent()) return this.cancelled(handle);
      return { status: "failed", error };
    } finally {
      if (handle.exclusiveGroup && this.exclusiveWorkers.get(handle.exclusiveGroup) === handle) {
        this.exclusiveWorkers.delete(handle.exclusiveGroup);
      }
    }
  }
  cancelled(handle) {
    return {
      status: "cancelled",
      id: handle.id,
      name: handle.name,
      exclusiveGroup: handle.exclusiveGroup
    };
  }
};

// src/sumo-tui/cathedral/sidebar-rendering.ts
var SIDEBAR_SUB_TABS = ["CONTEXT", "MEMORY"];
var TOKEN_BAR_CELLS = 22;
var MEMORY_DISPLAY_LIMIT = 5;
var FG_RESET3 = "\x1B[39m";
var DIM_OFF = "\x1B[22m";
function colorHex3(text, hex) {
  return `${fgHex(hex)}${text}${FG_RESET3}`;
}
function dim4(text) {
  return `\x1B[2m${text}${DIM_OFF}`;
}
function tokenUsageRatio(used, total) {
  if (total <= 0 || !Number.isFinite(used) || !Number.isFinite(total)) return 0;
  return Math.max(0, used / total);
}
function clampRatio(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
function truncatePlainText(text, maxWidth) {
  if (maxWidth <= 0) return "";
  if (visibleLength3(text) <= maxWidth) return text;
  return `${text.slice(0, Math.max(0, maxWidth - 1))}\u2026`;
}
function indented(content) {
  return `${SIDEBAR_INDENT}${content}`;
}
function sectionLabel(text) {
  const chrome = activeThemeChrome();
  const label = chrome.sectionTracked ? text.split("").join("\u202F") : text;
  const glyph = chrome.sectionGlyphs[text.toLowerCase()] ?? "";
  return glyph ? `${glyph}  ${label}` : label;
}
function blank(width) {
  return padAnsiToWidth2("", width);
}
function rule(width) {
  const chrome = activeThemeChrome();
  const count = Math.max(1, width - visibleLength3(SIDEBAR_INDENT) - 2);
  return padAnsiToWidth2(indented(colorHex3(chrome.ruleChar.repeat(count), activeThemeColors().divider)), width);
}
function row2(content, width) {
  return padAnsiToWidth2(indented(content), width);
}
function tokenMeterColor(used, total) {
  const ratio = tokenUsageRatio(used, total);
  if (ratio > 1) return activeThemeColors().states.approval;
  if (ratio >= 0.8) return activeThemeColors().accent;
  if (ratio >= 0.5) return activeThemeColors().states.thinking;
  return activeThemeColors().states.idle;
}
function renderTokenMeter(used, total) {
  const ratio = tokenUsageRatio(used, total);
  const filled = ratio > 1 ? TOKEN_BAR_CELLS : Math.round(clampRatio(ratio) * TOKEN_BAR_CELLS);
  const empty = TOKEN_BAR_CELLS - filled;
  const meterColor = tokenMeterColor(used, total);
  return `${colorHex3("\u2589".repeat(filled), meterColor)}${colorHex3("\u2591".repeat(empty), activeThemeColors().divider)}`;
}
function contextLines(snapshot, width) {
  const used = snapshot.currentContextTokens ?? snapshot.inputTokens + snapshot.outputTokens;
  const overBudget = snapshot.contextWindow > 0 && used > snapshot.contextWindow;
  return [
    row2(colorHex3(snapshot.projectName, activeThemeColors().foreground), width),
    row2(colorHex3(`on ${snapshot.branch ?? "unknown"}`, activeThemeColors().foregroundDim), width),
    blank(width),
    row2(colorHex3(sectionLabel("CONTEXT"), activeThemeColors().foregroundDim), width),
    row2(renderTokenMeter(used, snapshot.contextWindow), width),
    row2(
      `${colorHex3(formatTokenCount(used), overBudget ? activeThemeColors().states.approval : activeThemeColors().foreground)} ${colorHex3(`/ ${formatTokenCount(snapshot.contextWindow)}`, activeThemeColors().foregroundDim)}` + (overBudget ? ` ${colorHex3("OVER", activeThemeColors().states.approval)}` : ""),
      width
    ),
    blank(width),
    row2(colorHex3(sectionLabel("SESSION"), activeThemeColors().foregroundDim), width),
    row2(
      `${colorHex3(`$${snapshot.costUsd.toFixed(2)}`, activeThemeColors().foreground)} ${colorHex3(`\xB7 ${formatTokenCount(snapshot.cumulativeTokens ?? used)} cumul`, activeThemeColors().foregroundDim)}`,
      width
    )
  ];
}
function normalizeMcpStatus(status) {
  switch (status) {
    case "ok":
    case "idle":
    case "in-flight":
    case "error":
    case "down":
      return status;
    case "thinking":
    case "tool":
      return "in-flight";
    case "approval":
      return "error";
    case "learning":
      return "ok";
  }
}
function mcpStatusColor(status) {
  switch (normalizeMcpStatus(status)) {
    case "ok":
      return activeThemeColors().states.idle;
    case "idle":
      return activeThemeColors().foregroundDim;
    case "in-flight":
      return activeThemeColors().states.thinking;
    case "error":
    case "down":
      return activeThemeColors().states.approval;
  }
}
function mcpStatusLabel(status) {
  return normalizeMcpStatus(status);
}
function renderMcpServerRow(server, width) {
  const status = mcpStatusLabel(server.status);
  const dot = colorHex3("\u25CF", mcpStatusColor(server.status));
  const statusText = colorHex3(status, activeThemeColors().foregroundDim);
  const reserve = visibleLength3(SIDEBAR_INDENT) + 1 + 1 + status.length + 2;
  const name = truncatePlainText(server.name, Math.max(1, width - reserve));
  const gap = Math.max(1, width - visibleLength3(SIDEBAR_INDENT) - 2 - visibleLength3(name) - status.length - 2);
  return padAnsiToWidth2(indented(`${dot} ${colorHex3(name, activeThemeColors().foreground)}${" ".repeat(gap)}${statusText}  `), width);
}
function mcpLines(snapshot, width) {
  const lines = [row2(colorHex3(sectionLabel("MCP"), activeThemeColors().foregroundDim), width), blank(width)];
  for (const server of snapshot.mcpServers) lines.push(renderMcpServerRow(server, width));
  return lines;
}
function renderMemoryFactLine(item, width) {
  const available = Math.max(0, width - visibleLength3(SIDEBAR_INDENT) - 2);
  const chrome = activeThemeChrome();
  const bullet = colorHex3(chrome.bullet, chrome.bulletColor ?? activeThemeColors().accent);
  const text = colorHex3(truncatePlainText(item, available), activeThemeColors().foreground);
  return padAnsiToWidth2(indented(`${bullet} ${text}`), width);
}
function memoryLines(snapshot, width) {
  const lines = [row2(colorHex3(sectionLabel("MEMORY"), activeThemeColors().foregroundDim), width), blank(width)];
  if (snapshot.memoryUnavailable) {
    lines.push(row2(dim4(VOICE.errors.daemonDown), width));
    return lines;
  }
  if (snapshot.memory.length === 0) {
    lines.push(row2(dim4(VOICE.empty.memory), width));
    return lines;
  }
  const shown = snapshot.memory.slice(0, MEMORY_DISPLAY_LIMIT);
  for (const item of shown) lines.push(renderMemoryFactLine(item, width));
  const total = snapshot.memoryTotal ?? snapshot.memory.length;
  const hidden = Math.max(0, total - shown.length);
  if (hidden > 0) {
    lines.push(blank(width));
    lines.push(rule(width));
    lines.push(row2(colorHex3(`${hidden} more \xB7 \u2318M`, activeThemeColors().foregroundDim), width));
  }
  return lines;
}
function renderRegistryHeaderLines(snapshot, width) {
  const active = snapshot.activeSubTab ?? "CONTEXT";
  const lines = [
    blank(width),
    row2(colorHex3("REGISTRY", activeThemeColors().accent), width),
    blank(width)
  ];
  for (const tab of SIDEBAR_SUB_TABS) {
    const isActive2 = tab === active;
    const chrome = activeThemeChrome();
    const marker = colorHex3(isActive2 ? chrome.tabActive : chrome.tabInactive, isActive2 ? activeThemeColors().accent : activeThemeColors().foregroundDim);
    const label = colorHex3(sectionLabel(tab), isActive2 ? activeThemeColors().foreground : activeThemeColors().foregroundDim);
    lines.push(padAnsiToWidth2(indented(`${marker} ${label}`), width));
  }
  lines.push(blank(width));
  lines.push(rule(width));
  lines.push(blank(width));
  return lines;
}
function renderRegistrySidebarLines(snapshot, width) {
  const active = snapshot.activeSubTab ?? "CONTEXT";
  const lines = [...renderRegistryHeaderLines(snapshot, width)];
  if (active === "CONTEXT") {
    lines.push(...contextLines(snapshot, width));
    lines.push(blank(width));
    lines.push(rule(width));
    lines.push(blank(width));
    lines.push(...mcpLines(snapshot, width));
  } else {
    lines.push(...memoryLines(snapshot, width));
  }
  return lines.map((line) => padAnsiToWidth2(line, width));
}

// src/sidebar-placement.ts
import { truncateToWidth as truncateToWidth9, visibleWidth as visibleWidth10 } from "@earendil-works/pi-tui";
var SIDEBAR_MIN_TERMINAL_WIDTH = 120;
var SIDEBAR_WIDTH = 30;
var SIDEBAR_GUTTER_WIDTH = 2;
var SIDEBAR_OVERLAY_TOP_MARGIN_ROWS = 2;
var SIDEBAR_OVERLAY_BOTTOM_RESERVED_ROWS = 8;
function sidebarOverlayTargetRows(termHeight) {
  return Math.max(1, Math.floor(termHeight) - SIDEBAR_OVERLAY_TOP_MARGIN_ROWS - SIDEBAR_OVERLAY_BOTTOM_RESERVED_ROWS);
}
var STATIC_SIDEBAR_DOCK_MARKER = /* @__PURE__ */ Symbol("sumocode.staticSidebarDock");
function padToWidth2(line, width) {
  const truncated = visibleWidth10(line) > width ? truncateToWidth9(line, width, "") : line;
  const padding = Math.max(0, width - visibleWidth10(truncated));
  return `${truncated}${" ".repeat(padding)}`;
}
function renderComponents(components, width) {
  return components.flatMap((component) => component.render(width));
}
var StaticSidebarDock = class {
  constructor(mainComponents, sidebarComponent, shouldShowSidebar) {
    this.mainComponents = mainComponents;
    this.sidebarComponent = sidebarComponent;
    this.shouldShowSidebar = shouldShowSidebar;
  }
  mainComponents;
  sidebarComponent;
  shouldShowSidebar;
  [STATIC_SIDEBAR_DOCK_MARKER] = true;
  invalidate() {
    for (const component of [...this.mainComponents, this.sidebarComponent]) {
      component.invalidate?.();
    }
  }
  render(width) {
    if (width < SIDEBAR_MIN_TERMINAL_WIDTH || !this.shouldShowSidebar()) {
      return renderComponents(this.mainComponents, width);
    }
    const mainWidth = Math.max(1, width - SIDEBAR_WIDTH - SIDEBAR_GUTTER_WIDTH);
    const mainLines = renderComponents(this.mainComponents, mainWidth);
    const sidebarLines = this.sidebarComponent.render(SIDEBAR_WIDTH);
    const rowCount = mainLines.length;
    const lines = [];
    const blankSidebarRow = surfaceLine("", SIDEBAR_WIDTH);
    for (let i = 0; i < rowCount; i++) {
      const left = padToWidth2(mainLines[i] ?? "", mainWidth);
      const right = i < sidebarLines.length ? padToWidth2(sidebarLines[i], SIDEBAR_WIDTH) : blankSidebarRow;
      lines.push(`${left}${" ".repeat(SIDEBAR_GUTTER_WIDTH)}${right}`);
    }
    return lines;
  }
};
function installNonCapturingSidebarOverlay(tui, sidebarComponent, shouldShowSidebar) {
  const overlayOptions = {
    width: SIDEBAR_WIDTH,
    anchor: "top-right",
    margin: { top: SIDEBAR_OVERLAY_TOP_MARGIN_ROWS, right: 0, bottom: SIDEBAR_OVERLAY_BOTTOM_RESERVED_ROWS, left: 0 },
    maxHeight: "100%",
    nonCapturing: true,
    visible: (termWidth) => termWidth >= SIDEBAR_MIN_TERMINAL_WIDTH && shouldShowSidebar()
  };
  const overlay = tui.showOverlay(sidebarComponent, overlayOptions);
  tui.requestRender(true);
  return overlay;
}

// src/sidebar.ts
var SIDEBAR_MEMORY_DEBOUNCE_MS = 200;
var SIDEBAR_MEMORY_RETRY_MS = 5e3;
function resolvePiAgentDir2() {
  return process.env.PI_CODING_AGENT_DIR ?? join11(homedir11(), ".pi", "agent");
}
setMcpDiagnosticHandler((event) => {
  logDiagnostic(event.type, { path: event.path, importsCount: event.importsCount });
});
function renderSidebar(snapshot, width) {
  return renderRegistrySidebarLines(snapshot, width).map((line) => surfaceLine(line, width));
}
var SidebarComponent = class {
  constructor(loadSnapshot, extra, targetRows) {
    this.loadSnapshot = loadSnapshot;
    this.extra = extra;
    this.targetRows = targetRows;
  }
  loadSnapshot;
  extra;
  targetRows;
  invalidate() {
    this.extra?.invalidate?.();
  }
  render(width) {
    const lines = renderSidebar(this.loadSnapshot(), width);
    const extraLines = this.extra?.render(width) ?? [];
    const rows = extraLines.length > 0 ? [...lines, ...extraLines] : lines;
    const targetRows = this.targetRows?.() ?? rows.length;
    return [
      ...rows,
      ...Array.from({ length: Math.max(0, targetRows - rows.length) }, () => surfaceLine("", width))
    ];
  }
};
function createSidebarComponent(loadSnapshot, extra, targetRows) {
  return new SidebarComponent(loadSnapshot, extra, targetRows);
}
var MEMORY_DISPLAY_LIMIT2 = 5;
var SIDEBAR_MEMORY_WORKER_GROUP = "sidebar-memory";
function createSidebarMemoryCache(memoryClient, debounceMs = SIDEBAR_MEMORY_DEBOUNCE_MS, workerRuntime = new CancellableWorkerRuntime()) {
  let memory = [];
  let memoryUnavailable = false;
  let timer;
  let retryTimer;
  function setSnapshot(nextMemory, nextUnavailable) {
    const changed = memoryUnavailable !== nextUnavailable || memory.length !== nextMemory.length || memory.some((item, index) => item !== nextMemory[index]);
    memory = nextMemory;
    memoryUnavailable = nextUnavailable;
    return changed;
  }
  async function refresh(prompt) {
    const handle = workerRuntime.start({
      name: "sidebar-memory.refresh",
      exclusiveGroup: SIDEBAR_MEMORY_WORKER_GROUP,
      run: async ({ signal }) => {
        try {
          const facts = await memoryClient.query(prompt, MEMORY_DISPLAY_LIMIT2);
          if (signal.aborted) return false;
          return setSnapshot(facts.map((fact) => fact.text), false);
        } catch {
          if (signal.aborted) return false;
          return setSnapshot([], true);
        }
      }
    });
    const result = await handle.result;
    return result.status === "completed" ? result.value : false;
  }
  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = void 0;
  }
  function scheduleRetry(prompt, onChange) {
    if (prompt.trim().length === 0) return;
    clearRetry();
    retryTimer = setTimeout(() => {
      void refresh(prompt).then((changed) => {
        if (changed) onChange();
        if (memoryUnavailable) scheduleRetry(prompt, onChange);
      });
    }, SIDEBAR_MEMORY_RETRY_MS);
    retryTimer.unref?.();
  }
  return {
    refresh,
    schedule(prompt, onChange) {
      if (timer) clearTimeout(timer);
      clearRetry();
      workerRuntime.cancelGroup(SIDEBAR_MEMORY_WORKER_GROUP);
      const normalizedPrompt = prompt.trim();
      if (normalizedPrompt.length === 0) return;
      timer = setTimeout(() => {
        void refresh(normalizedPrompt).then((changed) => {
          if (changed) onChange();
          if (memoryUnavailable) scheduleRetry(normalizedPrompt, onChange);
        });
      }, debounceMs);
      timer.unref?.();
    },
    snapshot() {
      return { memory, memoryUnavailable };
    }
  };
}
function isObjectMessage(value) {
  return typeof value === "object" && value !== null;
}
function isString4(value) {
  return typeof value === "string";
}
function isTextPart(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  return record.type === "text" && isString4(record.text);
}
function messageText(message) {
  if (!isObjectMessage(message)) return "";
  const maybe = message;
  if (maybe.role !== "user") return "";
  if (isString4(maybe.content)) return maybe.content;
  if (Array.isArray(maybe.content)) {
    return maybe.content.map((part) => {
      if (isTextPart(part)) return part.text;
      return void 0;
    }).filter((part) => typeof part === "string").join("\n");
  }
  return "";
}
function isNumber(value) {
  return typeof value === "number";
}
function sessionHasMessages5(ctx) {
  return sessionHasMessages(ctx);
}
function snapshotFromContext(ctx, memorySnapshot, activeSubTab, metrics) {
  const { input, output, cost } = getSessionUsage(ctx);
  const contextUsage = ctx.getContextUsage();
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const currentContextTokens = isNumber(contextUsage?.tokens) ? contextUsage.tokens : void 0;
  const branch = getGitBranch(ctx) ?? void 0;
  return {
    projectName: basename3(ctx.cwd) || ctx.cwd,
    branch,
    inputTokens: input,
    outputTokens: output,
    currentContextTokens,
    contextWindow,
    cumulativeTokens: input + output,
    costUsd: cost,
    mcpServers: getCachedMcpRoster({ cwd: ctx.cwd, piAgentDir: resolvePiAgentDir2() }),
    memory: memorySnapshot.memory,
    memoryTotal: memorySnapshot.memory.length,
    memoryUnavailable: memorySnapshot.memoryUnavailable,
    activeSubTab,
    metrics
  };
}
function installSidebar(pi) {
  let requestRender;
  let memoryCache;
  let activeMetricsHud;
  let activeSubTab = "CONTEXT";
  pi.registerShortcut("ctrl+1", {
    description: "sidebar: show CONTEXT sub-tab",
    handler: () => {
      activeSubTab = "CONTEXT";
      requestRender?.();
    }
  });
  pi.registerShortcut("ctrl+2", {
    description: "sidebar: show MEMORY sub-tab",
    handler: () => {
      activeSubTab = "MEMORY";
      requestRender?.();
    }
  });
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    activeSubTab = "CONTEXT";
    memoryCache = createSidebarMemoryCache(createRemnicMemoryClient());
    ctx.ui.setWidget("sumocode-sidebar-dock", (tui) => {
      requestRender = () => tui.requestRender();
      activeMetricsHud?.stop();
      const metricsHud = new MetricsHud();
      activeMetricsHud = metricsHud;
      const metricsHudDisabled = process.env.SUMOCODE_DISABLE_METRICS_HUD === "1";
      logDiagnostic("sidebar_metrics_hud", { disabled: metricsHudDisabled });
      if (!metricsHudDisabled) {
        metricsHud.start(() => {
          if (sessionHasMessages5(ctx)) requestRender?.();
        });
      }
      const sidebarComponent = createSidebarComponent(
        () => snapshotFromContext(ctx, memoryCache?.snapshot() ?? { memory: [] }, activeSubTab, metricsHud.snapshot()),
        void 0,
        // SAFETY: the TUI terminal exposes an optional rows field; a missing
        // value falls back to the default overlay row target.
        () => sidebarOverlayTargetRows(tui.terminal?.rows ?? 0)
      );
      const overlay = installNonCapturingSidebarOverlay(tui, sidebarComponent, () => sessionHasMessages5(ctx));
      return {
        invalidate() {
        },
        render() {
          return [];
        },
        dispose() {
          metricsHud.stop();
          if (activeMetricsHud === metricsHud) activeMetricsHud = void 0;
          overlay?.hide();
          requestRender = void 0;
        }
      };
    });
  });
  pi.on("message_start", (event) => {
    const prompt = messageText(event.message);
    if (!prompt) return;
    memoryCache?.schedule(prompt, () => requestRender?.());
  });
  pi.on("agent_end", () => requestRender?.());
  pi.on("tool_result", () => requestRender?.());
}

// src/interaction-registry.ts
function defaultReporter(diagnostics) {
  if (diagnostics.length === 0) return;
  console.warn(`[sumocode] interaction-conflicts ${JSON.stringify({ diagnostics })}`);
}
var InteractionRegistry = class {
  constructor(pi, reporter = defaultReporter) {
    this.pi = pi;
    this.reporter = reporter;
  }
  pi;
  reporter;
  commands = /* @__PURE__ */ new Map();
  shortcuts = /* @__PURE__ */ new Map();
  diagnostics = [];
  activeOwner = "unknown";
  install(owner, installer) {
    const previousOwner = this.activeOwner;
    const originalRegisterCommand = this.pi.registerCommand;
    const originalRegisterShortcut = this.pi.registerShortcut;
    this.activeOwner = owner;
    this.pi.registerCommand = (name, options) => {
      if (!this.claim("command", name, this.commands)) return;
      originalRegisterCommand.call(this.pi, name, options);
    };
    this.pi.registerShortcut = (shortcut, options) => {
      if (!this.claim("shortcut", String(shortcut), this.shortcuts)) return;
      originalRegisterShortcut.call(this.pi, shortcut, options);
    };
    try {
      installer(this.pi);
    } finally {
      this.pi.registerCommand = originalRegisterCommand;
      this.pi.registerShortcut = originalRegisterShortcut;
      this.activeOwner = previousOwner;
    }
  }
  flushDiagnostics() {
    this.reporter(this.diagnostics);
  }
  getSnapshot() {
    return {
      commands: [...this.commands.entries()],
      shortcuts: [...this.shortcuts.entries()],
      diagnostics: [...this.diagnostics]
    };
  }
  claim(kind, id, owners) {
    const existingOwner2 = owners.get(id);
    if (existingOwner2) {
      this.diagnostics.push({
        kind,
        id,
        owner: this.activeOwner,
        conflictsWith: existingOwner2,
        action: "skipped"
      });
      return false;
    }
    owners.set(id, this.activeOwner);
    return true;
  }
};
function createInteractionRegistry(pi, reporter) {
  return new InteractionRegistry(pi, reporter);
}
function installSumoInteractions(pi, options = {}) {
  const registry = createInteractionRegistry(pi, options.reporter);
  if (options.includeUiSurfaces !== false) {
    registry.install("command-palette", installCommandPalette);
    registry.install("sidebar", installSidebar);
  }
  registry.install("commands.cursor", registerCursorCommand);
  registry.install("commands.diff", registerDiffCommand);
  registry.install("commands.divine-query", registerDivineQueryCommand);
  registry.install("commands.exit", registerExitCommand);
  registry.install("commands.slate", registerSlateCommand);
  registry.install("commands.persona", registerPersonaCommand);
  registry.install("commands.review", (targetPi) => registerReviewCommand(targetPi, { subagentSpawner: options.subagentManager }));
  registry.install("commands.ship", registerShipCommand);
  registry.install("commands.spinner", registerSpinnerCommand);
  registry.install("commands.sync", registerSumoSyncCommand);
  registry.install("commands.tabs", registerTabsCommand);
  registry.install("commands.theme", registerThemeCommand);
  registry.install("commands.theme-check", registerThemeCheckCommand);
  registry.install("commands.worktree", registerWorktreeCommand);
  registry.install("commands.memory", registerMemoryCommand);
  registry.flushDiagnostics();
  return registry.getSnapshot();
}

// src/memory-extraction.ts
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : void 0;
}
function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}
function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const chunks = [];
  for (const item of content) {
    if (typeof item === "string") {
      const text2 = item.trim();
      if (text2) chunks.push(text2);
      continue;
    }
    const record = asRecord(item);
    const type = typeof record?.type === "string" ? record.type : "";
    const text = asText(record?.text) || asText(record?.content) || (type === "input_text" ? asText(record?.value) : "");
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n").trim();
}
function observedMessagesFromAgentMessages(messages) {
  const observed = [];
  for (const message of messages) {
    const record = asRecord(message);
    const role = record?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = textFromContent(record?.content);
    if (!content) continue;
    observed.push({ role, content });
  }
  return observed;
}
function sessionKeyFromContext(ctx) {
  return asText(safeCall(() => ctx.sessionManager.getSessionId())) || asText(safeCall(() => ctx.sessionManager.getSessionFile())) || asText(safeCall(() => ctx.cwd));
}
function safeCall(read) {
  try {
    return read();
  } catch {
    return void 0;
  }
}
function installMemoryExtraction(pi, createClient = createRemnicMemoryClient) {
  const client = createClient();
  pi.on("agent_end", (event, ctx) => {
    const sessionKey = sessionKeyFromContext(ctx);
    if (!sessionKey) return;
    const messages = observedMessagesFromAgentMessages(event.messages);
    if (messages.length === 0) return;
    logDiagnostic("remnic_observe_enqueue", { sessionKey, messages: messages.length });
    void client.observe(sessionKey, messages).then(() => {
      logDiagnostic("remnic_observe_ok", { sessionKey, messages: messages.length });
    }).catch((error) => {
      logDiagnostic("remnic_observe_failed", {
        sessionKey,
        messages: messages.length,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

// src/splash.ts
import { readFileSync as readFileSync10 } from "node:fs";
import { dirname as dirname5, resolve as resolve3 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { truncateToWidth as truncateToWidth10 } from "@earendil-works/pi-tui";
var RESET10 = "\x1B[0m";
var ANSI_PATTERN4 = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
var CURSOR_VISIBILITY_PATTERN = /\u001b\[\?25[lh]/g;
function fg6(hex) {
  const n = hex.replace("#", "");
  const r = Number.parseInt(n.slice(0, 2), 16);
  const g = Number.parseInt(n.slice(2, 4), 16);
  const b = Number.parseInt(n.slice(4, 6), 16);
  return `\x1B[38;2;${r};${g};${b}m`;
}
function accentFg() {
  return fg6(activeThemeColors().accent);
}
function mutedFg() {
  return fg6(activeThemeColors().foregroundDim);
}
var DIM = "\x1B[2m";
function visibleLength4(text) {
  return text.replace(ANSI_PATTERN4, "").length;
}
function center3(line, width) {
  const len = visibleLength4(line);
  if (len >= width) return truncateToWidth10(line, width, "");
  const pad = Math.floor((width - len) / 2);
  return `${" ".repeat(pad)}${line}`;
}
var SUMOCODE_WORDMARK = (() => {
  const glyphs = {
    S: ["\u2588\u2588\u2588\u2588\u2588 ", "\u2588     ", "\u2588\u2588\u2588\u2588\u2588 ", "    \u2588 ", "\u2588\u2588\u2588\u2588\u2588 "],
    U: ["\u2588   \u2588 ", "\u2588   \u2588 ", "\u2588   \u2588 ", "\u2588   \u2588 ", "\u2588\u2588\u2588\u2588\u2588 "],
    M: ["\u2588   \u2588 ", "\u2588\u2588 \u2588\u2588 ", "\u2588 \u2588 \u2588 ", "\u2588   \u2588 ", "\u2588   \u2588 "],
    O: ["\u2588\u2588\u2588\u2588\u2588 ", "\u2588   \u2588 ", "\u2588   \u2588 ", "\u2588   \u2588 ", "\u2588\u2588\u2588\u2588\u2588 "],
    C: ["\u2588\u2588\u2588\u2588\u2588 ", "\u2588     ", "\u2588     ", "\u2588     ", "\u2588\u2588\u2588\u2588\u2588 "],
    D: ["\u2588\u2588\u2588\u2588  ", "\u2588   \u2588 ", "\u2588   \u2588 ", "\u2588   \u2588 ", "\u2588\u2588\u2588\u2588  "],
    E: ["\u2588\u2588\u2588\u2588\u2588 ", "\u2588     ", "\u2588\u2588\u2588\u2588  ", "\u2588     ", "\u2588\u2588\u2588\u2588\u2588 "]
  };
  const letters = "SUMOCODE".split("");
  const rows = Array.from(
    { length: 5 },
    (_, i) => letters.map((ch) => glyphs[ch][i] ?? "      ").join("")
  );
  return rows;
})();
var ASSET_DIR = resolve3(dirname5(fileURLToPath2(import.meta.url)), "assets");
var FACE_PATH = resolve3(ASSET_DIR, "sumo-face.ans");
function loadFace() {
  try {
    const raw = readFileSync10(FACE_PATH, "utf8").replace(CURSOR_VISIBILITY_PATTERN, "");
    return raw.replace(/\r?\n$/, "").split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}
var SUMO_FACE = loadFace();
var SUMOCODE_QUOTE = '"Meow meow meow... meow meow"';
var SUMOCODE_QUOTE_ATTRIBUTION = "\u2014 SUMO";
function renderSplashContent(snapshot, width) {
  if (snapshot.hasMessages) return [];
  const content = [];
  for (const row3 of SUMO_FACE) content.push(center3(row3, width));
  if (SUMO_FACE.length > 0) {
    content.push("");
    content.push("");
  }
  for (const row3 of SUMOCODE_WORDMARK) {
    content.push(center3(`${accentFg()}${row3}${RESET10}`, width));
  }
  content.push("");
  content.push("");
  content.push(center3(`${DIM}${mutedFg()}${snapshot.quote}${RESET10}`, width));
  content.push(center3(`${DIM}${mutedFg()}${snapshot.quoteAttribution}${RESET10}`, width));
  return content;
}
function renderSplash(snapshot, width, terminalHeight) {
  const content = renderSplashContent(snapshot, width);
  if (content.length === 0) return [];
  if (terminalHeight && terminalHeight > content.length) {
    const topPad = Math.max(0, Math.floor((terminalHeight - content.length) / 2));
    return [...Array.from({ length: topPad }, () => ""), ...content];
  }
  return content;
}
function sessionHasMessages6(ctx) {
  try {
    return sessionHasMessages(ctx);
  } catch {
    return false;
  }
}
function shouldUseRetainedSplash(env = process.env) {
  return env.SUMO_TUI === "1";
}
var SplashComponent = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  ctx;
  invalidate() {
  }
  render(width) {
    return renderSplash(
      {
        quote: SUMOCODE_QUOTE,
        quoteAttribution: SUMOCODE_QUOTE_ATTRIBUTION,
        hasMessages: sessionHasMessages6(this.ctx)
      },
      width,
      process.stdout.rows
    );
  }
};
function installSplash(pi) {
  let render;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || shouldUseRetainedSplash()) return;
    ctx.ui.setWidget("sumocode-splash", (tui) => {
      render = () => tui.requestRender();
      return new SplashComponent(ctx);
    });
  });
  pi.on("message_start", () => render?.());
  pi.on("message_end", () => render?.());
}

// src/top-chrome.ts
var RESET11 = "\x1B[0m";
var ANSI_PATTERN5 = /\u001b\[[0-9;]*m/g;
var TOP_CHROME_BRAND = "SUMOCODE";
function visibleLength5(text) {
  return text.replace(ANSI_PATTERN5, "").length;
}
function fg7(hex) {
  const n = hex.replace("#", "");
  const r = Number.parseInt(n.slice(0, 2), 16);
  const g = Number.parseInt(n.slice(2, 4), 16);
  const b = Number.parseInt(n.slice(4, 6), 16);
  return `\x1B[38;2;${r};${g};${b}m`;
}
function color3(text, hex) {
  return `${fg7(hex)}${text}${RESET11}`;
}
function ellipsize3(text, max) {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "\u2026";
  return `${text.slice(0, max - 1)}\u2026`;
}
var ICON_TERMINAL = "\uF489";
var ICON_SETTINGS = "\uF423";
var ICON_GAP = "  ";
var ARCHIVE_LABEL = "ARCHIVE";
var OUTER_PAD = 1;
var BRAND_ACTIVE_GAP = 2;
var COMPACT_TOP_CHROME_WIDTH = 80;
var PORTRAIT_CHROME_BREATHING_WIDTH = 80;
var DOT_GLYPHS = {
  small: "\xB7",
  medium: "\u2022",
  large: "\u25CF"
};
function activeSegment(active, maxLabel, dotSize) {
  const label = ellipsize3(active.label, maxLabel);
  const dot = color3(DOT_GLYPHS[dotSize], activeThemeColors().accent);
  const dim5 = (ch) => color3(ch, activeThemeColors().foregroundDim);
  return `${dim5("\u2551 ")}${dot}${dim5(" " + label + " \u2551")}`;
}
var ACTIVE_OVERHEAD = 6;
function recentSegment(label) {
  const sep2 = color3("\u2502", activeThemeColors().foregroundDim);
  const text = color3(label, activeThemeColors().foregroundDim);
  return `   ${sep2} ${text}`;
}
function archiveSegment() {
  const sep2 = color3("\u2502", activeThemeColors().foregroundDim);
  const text = color3(ARCHIVE_LABEL, activeThemeColors().foregroundDim);
  return `   ${sep2} ${text}`;
}
function iconsSegment() {
  const term = color3(ICON_TERMINAL, activeThemeColors().foreground);
  const gear = color3(ICON_SETTINGS, activeThemeColors().foreground);
  return `${term}${ICON_GAP}${gear}`;
}
function brandSegment() {
  return color3(TOP_CHROME_BRAND, activeThemeColors().accent);
}
function padToWidth3(text, width) {
  const len = visibleLength5(text);
  if (len >= width) return text;
  return `${text}${" ".repeat(width - len)}`;
}
function renderTopChrome(snapshot, width) {
  if (width <= 0) return "";
  const outerPad = width >= OUTER_PAD * 2 ? " ".repeat(OUTER_PAD) : "";
  const innerWidth = Math.max(0, width - visibleLength5(outerPad) * 2);
  if (innerWidth <= 0) return " ".repeat(width);
  const brand = brandSegment();
  if (snapshot.hidden) {
    return `${outerPad}${padToWidth3(brand, innerWidth)}${outerPad}`;
  }
  const brandLen = visibleLength5(brand);
  const dotSize = snapshot.dotSize ?? "medium";
  const fullActive = activeSegment(snapshot.activeSession, snapshot.activeSession.label.length, dotSize);
  const fullActiveLen = visibleLength5(fullActive);
  let active;
  if (brandLen + BRAND_ACTIVE_GAP + fullActiveLen <= innerWidth) {
    active = fullActive;
  } else {
    const maxActiveLabel = Math.max(1, innerWidth - brandLen - BRAND_ACTIVE_GAP - ACTIVE_OVERHEAD);
    active = activeSegment(snapshot.activeSession, maxActiveLabel, dotSize);
  }
  const brandGap = color3(" ".repeat(BRAND_ACTIVE_GAP), activeThemeColors().foregroundDim);
  let consumed = brandLen + BRAND_ACTIVE_GAP + visibleLength5(active);
  let line = `${brand}${brandGap}${active}`;
  const compact = innerWidth < COMPACT_TOP_CHROME_WIDTH;
  if (!compact) {
    for (const recent of snapshot.recentSessions) {
      const seg = recentSegment(recent.label);
      const segLen = visibleLength5(seg);
      if (consumed + segLen > width) break;
      line += seg;
      consumed += segLen;
    }
  }
  {
    const iconBlock = iconsSegment();
    const iconLen = visibleLength5(iconBlock);
    const archiveBlock = compact ? "" : archiveSegment();
    const archiveLen = compact ? 0 : visibleLength5(archiveBlock);
    const rightBlock = `${archiveBlock}${" ".repeat(archiveLen > 0 ? 3 : 0)}${iconBlock}`;
    const rightLen = archiveLen + (archiveLen > 0 ? 3 : 0) + iconLen;
    if (consumed + 1 + rightLen <= innerWidth) {
      const gap = innerWidth - consumed - rightLen;
      line += `${" ".repeat(gap)}${rightBlock}`;
      consumed = innerWidth;
    } else if (consumed + 1 + iconLen <= innerWidth) {
      const gap = innerWidth - consumed - iconLen;
      line += `${" ".repeat(gap)}${iconBlock}`;
      consumed = innerWidth;
    }
  }
  return `${outerPad}${padToWidth3(line, innerWidth)}${outerPad}`;
}
function renderTopChromeBlock(snapshot, width) {
  const line = renderTopChrome(snapshot, width);
  if (width > 0 && width < PORTRAIT_CHROME_BREATHING_WIDTH) {
    const blank2 = " ".repeat(width);
    return [blank2, line, blank2];
  }
  return [line];
}
var TopChromeComponent = class {
  constructor(loadSnapshot, shouldRender, opts = {}) {
    this.loadSnapshot = loadSnapshot;
    this.shouldRender = shouldRender;
    this.opts = opts;
  }
  loadSnapshot;
  shouldRender;
  opts;
  invalidate() {
  }
  render(width) {
    if (!this.shouldRender()) return [];
    const block = renderTopChromeBlock(this.loadSnapshot(), width);
    return this.opts.leadingBlankAtWidth !== void 0 && width >= this.opts.leadingBlankAtWidth ? ["", ...block] : block;
  }
};
function createTopChromePublication(loader, shouldRender, opts = {}) {
  return {
    component: new TopChromeComponent(loader, shouldRender, opts)
  };
}
function installTopChrome(pi, loader) {
  let state = "idle";
  let render;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    state = "idle";
    const publication = createTopChromePublication(
      () => loader ? loader() : defaultSnapshot(ctx, state),
      () => sessionHasMessages7(ctx)
    );
    ctx.ui.setHeader((tui) => {
      render = () => {
        tui.requestRender();
      };
      return {
        dispose() {
          render = void 0;
        },
        invalidate() {
        },
        render(width) {
          return publication.component.render(width);
        }
      };
    });
  });
  pi.on("before_agent_start", () => {
    state = "thinking";
    render?.();
  });
  pi.on("agent_start", () => {
    state = "thinking";
    render?.();
  });
  pi.on("tool_call", () => {
    state = "tool";
    render?.();
  });
  pi.on("tool_result", () => {
    state = "thinking";
    render?.();
  });
  pi.on("agent_end", () => {
    state = "idle";
    render?.();
  });
  pi.on("message_start", () => render?.());
  pi.on("message_end", () => render?.());
  pi.on("session_shutdown", () => {
    render = void 0;
  });
}
function sessionHasMessages7(ctx) {
  try {
    if (
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- shape probe for real ExtensionContext vs test mock
      typeof ctx.cwd === "string" && ctx.sessionManager && // oxlint-disable-next-line anti-slop/no-runtime-typeof -- callability guard before invoking getBranch
      typeof ctx.sessionManager.getBranch === "function"
    ) {
      return sessionHasMessages(ctx);
    }
    return ctx.sessionManager?.getBranch?.().some((entry) => entry.type === "message") ?? false;
  } catch {
    return false;
  }
}
function defaultSnapshot(ctx, state) {
  const id = ctx.sessionManager.getSessionId();
  const named = ctx.sessionManager.getSessionName();
  const fallback = id.split("-")[0] ?? "session";
  const label = named ?? fallback;
  return {
    activeSession: { id, label, state },
    recentSessions: [],
    hidden: isTopChromeHidden()
  };
}

// src/compaction-state.ts
var COMPACTION_REASON_KEY = /* @__PURE__ */ Symbol.for("sumocode.compactionReason");
function setGlobal(reason) {
  globalThis[COMPACTION_REASON_KEY] = reason;
}
function setCompactionReason(reason) {
  setGlobal(reason);
}
function getCompactionReason() {
  const stored = globalThis[COMPACTION_REASON_KEY];
  return stored ?? null;
}

// src/compaction-status-row.ts
var PLATEAU_TICKS = 400;
var PLATEAU_RATIO = 0.9;
var SPARK_FRAMES = ["\u25C7", "\u25C8", "\u25C9", "\u25C8"];
var GLYPH_TICK_DIVISOR = 5;
function compactionStatusLabelForReason(reason, options = {}) {
  if (reason === "manual" || reason == null && options.fallbackManual === true) return "Compacting\u2026";
  return "Auto-compacting\u2026";
}
function renderCompactionStatusRow(options) {
  const theme = getActiveTheme();
  const accent4 = theme.tokens.colors.accent;
  const dim5 = theme.tokens.colors.foregroundDim;
  const width = Math.max(0, Math.floor(options.width));
  const labelStr = ` ${options.label}`;
  const available = Math.max(0, width - 1 - labelStr.length);
  const barWidth = Math.max(4, Math.min(30, available));
  const fillRatio = options.completed === true ? 1 : Math.min(options.tick / PLATEAU_TICKS, 1) * PLATEAU_RATIO;
  const filledCells = options.completed === true ? barWidth : Math.max(0, Math.floor(fillRatio * barWidth));
  const barParts = [];
  if (options.completed === true || filledCells >= barWidth) {
    barParts.push(span("\u2501".repeat(barWidth), { fg: accent4 }));
  } else {
    if (filledCells > 0) barParts.push(span("\u2501".repeat(filledCells), { fg: accent4 }));
    const sparkIdx = Math.floor(options.tick / GLYPH_TICK_DIVISOR) % SPARK_FRAMES.length;
    const glyph = SPARK_FRAMES[sparkIdx] ?? "\u25C8";
    barParts.push(span(glyph, { fg: accent4 }));
    const trackWidth = barWidth - filledCells - 1;
    if (trackWidth > 0) barParts.push(span("\u2500".repeat(trackWidth), { fg: dim5 }));
  }
  const row3 = textLine(
    [" ", ...barParts, span(labelStr, { fg: dim5 })],
    { fg: dim5 }
  );
  return [lineToAnsi(truncateLine(row3, width))];
}

// src/compaction-indicator.ts
var COMPACTION_INDICATOR_WIDGET_KEY = "sumocode-compaction-status";
var TICK_MS = 100;
var COMPLETE_HOLD_MS = 700;
var CompactionStatusComponent = class {
  constructor(label, tui) {
    this.label = label;
    this.tui = tui;
    this.interval = setInterval(() => {
      this.tick += 1;
      this.tui.requestRender();
    }, TICK_MS);
    this.themeUnsubscribe = onThemeChanged(() => {
      this.tui.requestRender();
    });
  }
  label;
  tui;
  tick = 0;
  completed = false;
  interval;
  themeUnsubscribe;
  invalidate() {
  }
  /**
   * Snap the trace to 100 %, request a final render, then resolve after
   * `COMPLETE_HOLD_MS` so the caller can clear the widget.
   */
  markComplete() {
    this.completed = true;
    this.tui.requestRender();
    return new Promise((resolve10) => {
      const t = setTimeout(resolve10, COMPLETE_HOLD_MS);
      t.unref?.();
    });
  }
  render(width) {
    return renderCompactionStatusRow({
      width,
      label: this.label,
      tick: this.tick,
      completed: this.completed
    });
  }
  dispose() {
    if (this.interval !== void 0) {
      clearInterval(this.interval);
      this.interval = void 0;
    }
    this.themeUnsubscribe?.();
    this.themeUnsubscribe = void 0;
  }
};
function installCompactionIndicator(pi) {
  if (!isRetainedMode()) return;
  let active = false;
  let currentComponent;
  const clearWidget = (ctx) => {
    currentComponent?.dispose();
    currentComponent = void 0;
    active = false;
    if (ctx.hasUI) ctx.ui.setWidget(COMPACTION_INDICATOR_WIDGET_KEY, void 0, { placement: "aboveEditor" });
  };
  pi.on("session_before_compact", async (event, ctx) => {
    if (!ctx.hasUI) return void 0;
    const reason = getCompactionReason();
    const label = compactionStatusLabelForReason(reason, { fallbackManual: event.customInstructions !== void 0 });
    const factory = (tui) => {
      currentComponent?.dispose();
      currentComponent = new CompactionStatusComponent(label, tui);
      return currentComponent;
    };
    ctx.ui.setWidget(COMPACTION_INDICATOR_WIDGET_KEY, factory, { placement: "aboveEditor" });
    active = true;
    return void 0;
  });
  pi.on("session_compact", async (_event, ctx) => {
    if (!active) return;
    if (currentComponent) await currentComponent.markComplete();
    setCompactionReason(null);
    clearWidget(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (!active) return;
    setCompactionReason(null);
    clearWidget(ctx);
  });
}

// src/background-tasks/task-manager.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import {
  chmodSync as chmodSync2,
  closeSync as closeSync2,
  constants as constants2,
  fchmodSync as fchmodSync2,
  fstatSync as fstatSync2,
  ftruncateSync,
  mkdirSync as mkdirSync7,
  openSync as openSync2,
  readFileSync as readFileSync12,
  readSync,
  writeFileSync as writeFileSync7
} from "node:fs";
import { dirname as dirname8, join as join14 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/background-tasks/process-tree.ts
import { execFile as execFile4, execFileSync as execFileSync3 } from "node:child_process";
function isPowerShellJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSafeIntegerAtLeast(value, min) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function errorCode(error) {
  const code = error.code;
  return code === void 0 || code === null ? void 0 : String(code);
}
function positivePidStatus(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (!(error instanceof Error)) return "unknown";
    const code = errorCode(error);
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}
function posixGroupEmpty(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && errorCode(error) === "ESRCH") return true;
    return false;
  }
}
function listWindowsProcesses() {
  try {
    const script = [
      "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 -and $null -ne $_.CreationDate } | ForEach-Object {",
      "[PSCustomObject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; processStartTime = $_.CreationDate.ToUniversalTime().ToString('o') }",
      "} | ConvertTo-Json -Compress"
    ].join(" ");
    const output = execFileSync3("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const rows = [];
    for (const value of values) {
      if (!isPowerShellJsonObject(value)) return void 0;
      if (!isSafeIntegerAtLeast(value.pid, 1) || !isSafeIntegerAtLeast(value.parentPid, 0) || !isNonEmptyString(value.processStartTime)) return void 0;
      rows.push({ pid: value.pid, parentPid: value.parentPid, processStartTime: value.processStartTime });
    }
    return rows;
  } catch {
    return void 0;
  }
}
function listWindowsTreeMembers(pid) {
  const rows = listWindowsProcesses();
  if (!rows) return void 0;
  const treePids = /* @__PURE__ */ new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row3 of rows) {
      if (treePids.has(row3.pid) || !treePids.has(row3.parentPid)) continue;
      treePids.add(row3.pid);
      changed = true;
    }
  }
  return rows.filter((row3) => treePids.has(row3.pid)).map(({ pid: memberPid, processStartTime }) => ({ pid: memberPid, processStartTime }));
}
function listPosixGroupMembers(processGroupId) {
  try {
    const rows = execFileSync3("ps", ["-axo", "pid=,pgid=,lstart="], { encoding: "utf8" }).split("\n");
    const members = [];
    for (const row3 of rows) {
      const match = row3.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match || Number.parseInt(match[2], 10) !== processGroupId) continue;
      members.push({ pid: Number.parseInt(match[1], 10), processStartTime: match[3].trim() });
    }
    return members;
  } catch {
    return void 0;
  }
}
function identityStatusAfterLeaderGone(platform, posixGroupIsEmpty) {
  if (platform === "win32") return "unknown";
  return posixGroupIsEmpty ? "different" : "unknown";
}
function verificationStatus(identity, verification) {
  const current = process.platform === "win32" ? listWindowsProcesses()?.map(({ pid, processStartTime }) => ({ pid, processStartTime })) : listPosixGroupMembers(identity.processGroupId);
  if (!current) return "unknown";
  if (current.length === 0) return "different";
  return verification.members.some((anchor) => current.some(
    (member) => member.pid === anchor.pid && member.processStartTime === anchor.processStartTime
  )) ? "same" : "different";
}
function captureProcessBirthTime(pid, platform = process.platform) {
  try {
    if (platform === "win32") {
      return execFileSync3(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`],
        { encoding: "utf8" }
      ).trim() || void 0;
    }
    return execFileSync3("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim() || void 0;
  } catch {
    return void 0;
  }
}
function captureProcessStartTime(pid, platform = process.platform) {
  try {
    if (platform === "win32") {
      return execFileSync3(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`],
        { encoding: "utf8" }
      ).trim() || void 0;
    }
    return execFileSync3("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8" }).trim() || void 0;
  } catch {
    return void 0;
  }
}
var executeWindowsTaskkill = (args, callback) => {
  execFile4("taskkill.exe", [...args], (error) => callback(error));
};
function runWindowsTaskkill(pid, force, execute = executeWindowsTaskkill) {
  return new Promise((resolve10) => {
    const args = ["/PID", String(pid), "/T", ...force ? ["/F"] : []];
    execute(args, (error) => {
      if (!error) {
        resolve10({ ok: true, gone: true });
        return;
      }
      resolve10({ ok: false, gone: false, forceRequired: !force, error: error.message });
    });
  });
}
async function runWindowsVerifiedForceTaskkill(verification, execute = executeWindowsTaskkill, listMembers = () => listWindowsProcesses()) {
  const before = listMembers();
  if (!before) return { ok: false, gone: false, error: "Windows process tree could not be reverified" };
  const liveAnchors = verification.members.filter((anchor) => before.some(
    (member) => member.pid === anchor.pid && member.processStartTime === anchor.processStartTime
  ));
  if (liveAnchors.length === 0) return { ok: true, gone: true };
  const failures = [];
  for (const anchor of liveAnchors) {
    const result = await runWindowsTaskkill(anchor.pid, true, execute);
    if (!result.ok && result.error) failures.push(result.error);
  }
  const after = listMembers();
  if (!after) return { ok: false, gone: false, error: "Windows process tree could not be verified after forced taskkill" };
  const remains = verification.members.some((anchor) => after.some(
    (member) => member.pid === anchor.pid && member.processStartTime === anchor.processStartTime
  ));
  if (!remains) return { ok: true, gone: true };
  return { ok: false, gone: false, error: failures[0] ?? "verified Windows process-tree members remain alive" };
}
async function rawSystemSignal(identity, signal, verification) {
  if (process.platform === "win32") {
    return signal === "SIGKILL" && verification ? runWindowsVerifiedForceTaskkill(verification) : runWindowsTaskkill(identity.pid, signal === "SIGKILL");
  }
  try {
    process.kill(-identity.processGroupId, signal);
    return { ok: true, gone: false };
  } catch (error) {
    const code = error instanceof Error ? errorCode(error) : void 0;
    if (code === "ESRCH") return { ok: true, gone: true };
    return { ok: false, gone: false, error: error instanceof Error ? error.message : String(error) };
  }
}
var systemProcessTree = {
  captureStartTime: captureProcessStartTime,
  identityMatches(identity) {
    const leader = positivePidStatus(identity.pid);
    if (leader === "gone") {
      return identityStatusAfterLeaderGone(process.platform, process.platform === "win32" || posixGroupEmpty(identity.processGroupId));
    }
    if (leader === "unknown") return "unknown";
    const actual = captureProcessStartTime(identity.pid);
    if (!actual) return "unknown";
    return actual === identity.processStartTime ? "same" : "different";
  },
  captureTreeVerification(identity) {
    if (this.identityMatches(identity) !== "same") return void 0;
    const members = process.platform === "win32" ? listWindowsTreeMembers(identity.pid) : listPosixGroupMembers(identity.processGroupId);
    if (!members || members.length === 0) return void 0;
    if (this.identityMatches(identity) !== "same") return void 0;
    if (!members.some((member) => member.pid === identity.pid)) return void 0;
    return { members };
  },
  verificationMatches: verificationStatus,
  isTreeEmpty(identity, verification) {
    return process.platform === "win32" ? verification !== void 0 && verificationStatus(identity, verification) === "different" : posixGroupEmpty(identity.processGroupId);
  },
  async signalTree(identity, signal, verification) {
    let identityStatus = this.identityMatches(identity);
    if (identityStatus === "unknown" && verification) identityStatus = verificationStatus(identity, verification);
    if (identityStatus !== "same") {
      return {
        ok: false,
        gone: false,
        identityStatus,
        error: identityStatus === "different" ? "process identity changed" : "process identity could not be verified"
      };
    }
    return rawSystemSignal(identity, signal, verification);
  },
  signalFreshTree: rawSystemSignal,
  waitForTreeEmpty(identity, timeoutMs, verification) {
    return new Promise((resolve10) => {
      if (this.isTreeEmpty(identity, verification)) {
        resolve10(true);
        return;
      }
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const poll = () => {
        if (this.isTreeEmpty(identity, verification)) {
          resolve10(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve10(false);
          return;
        }
        const timer = setTimeout(poll, 25);
        timer.unref?.();
      };
      poll();
    });
  }
};
async function signalVerifiedProcessTree(operations, identity, signal, verification) {
  let identityStatus = operations.identityMatches(identity);
  if (identityStatus === "unknown" && verification && operations.verificationMatches) {
    identityStatus = operations.verificationMatches(identity, verification);
  }
  if (identityStatus !== "same") {
    return {
      ok: false,
      gone: false,
      identityStatus,
      error: identityStatus === "different" ? "process identity changed" : "process identity could not be verified"
    };
  }
  return verification ? operations.signalTree(identity, signal, verification) : operations.signalTree(identity, signal);
}
async function terminateProcessTree(operations, identity, options) {
  const verification = operations.captureTreeVerification?.(identity);
  const term = await signalVerifiedProcessTree(operations, identity, "SIGTERM", verification);
  if (!term.ok && !term.forceRequired) return false;
  if (term.ok && (term.gone || await operations.waitForTreeEmpty(identity, options.termGraceMs, verification))) return true;
  const kill = await signalVerifiedProcessTree(operations, identity, "SIGKILL", verification);
  if (!kill.ok) return false;
  return kill.gone || await operations.waitForTreeEmpty(identity, options.killGraceMs, verification);
}
async function terminateFreshProcessTree(operations, identity, options) {
  const signal = operations.signalFreshTree ?? operations.signalTree.bind(operations);
  const term = await signal(identity, "SIGTERM");
  if (!term.ok && !term.forceRequired) return false;
  if (term.ok && (term.gone || await operations.waitForTreeEmpty(identity, options.termGraceMs))) return true;
  const kill = await signal(identity, "SIGKILL");
  if (!kill.ok) return false;
  return kill.gone || await operations.waitForTreeEmpty(identity, options.killGraceMs);
}

// src/background-tasks/task-store.ts
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync6,
  openSync,
  readFileSync as readFileSync11,
  readdirSync,
  realpathSync as realpathSync2,
  renameSync as renameSync3,
  rmSync as rmSync2,
  unlinkSync,
  writeFileSync as writeFileSync6
} from "node:fs";
import { homedir as homedir12 } from "node:os";
import { basename as basename4, dirname as dirname6, isAbsolute, join as join12, relative, resolve as resolve4 } from "node:path";

// src/activity/domain.ts
var ACTIVITY_KINDS = /* @__PURE__ */ new Set(["tool", "task", "subagent", "terminal"]);
var ACTIVITY_STATUSES = /* @__PURE__ */ new Set(["queued", "running", "succeeded", "failed", "cancelled", "lost"]);
var TERMINAL_STATUS = /* @__PURE__ */ new Set(["succeeded", "failed", "cancelled", "lost"]);
var MAX_MERGED_ACTIVE_TOOLS = 16;
var SECRET_KEY_WORDS = /* @__PURE__ */ new Set([
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passwd",
  "secret",
  "token"
]);
function isActivityKind(value) {
  if (!isStringValue(value)) return false;
  return ACTIVITY_KINDS.has(value);
}
function isActivityStatus(value) {
  if (!isStringValue(value)) return false;
  return ACTIVITY_STATUSES.has(value);
}
function isSettledActivityStatus(status) {
  return TERMINAL_STATUS.has(status);
}
function isRecordLike(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isStringValue(value) {
  return typeof value === "string";
}
function isNumberValue(value) {
  return typeof value === "number";
}
function stringOrUndefined(value) {
  return isStringValue(value) ? value : void 0;
}
function numberOrUndefined(value) {
  return isNumberValue(value) ? value : void 0;
}
function recordOf(value) {
  return isRecordLike(value) ? value : void 0;
}
function optionalString(value) {
  return value === void 0 || typeof value === "string";
}
function optionalFiniteNumber(value) {
  return value === void 0 || typeof value === "number" && Number.isFinite(value);
}
function parseActivityBody(value) {
  if (value === void 0) return void 0;
  const body = recordOf(value);
  if (!body || !isStringValue(body.kind) || !isStringValue(body.text)) return void 0;
  switch (body.kind) {
    case "text":
    case "diff":
      return { kind: body.kind, text: body.text };
    case "source": {
      if (!optionalFiniteNumber(body.startLine) || !optionalFiniteNumber(body.totalLines)) return void 0;
      const parsed = { kind: "source", text: body.text };
      if (body.startLine !== void 0) parsed.startLine = body.startLine;
      if (body.totalLines !== void 0) parsed.totalLines = body.totalLines;
      return parsed;
    }
    case "terminal":
      if (!optionalString(body.command)) return void 0;
      if (body.command === void 0) return { kind: "terminal", text: body.text };
      return { kind: "terminal", text: body.text, command: body.command };
    default:
      return void 0;
  }
}
function parseActivitySnapshot(value, depth = 0) {
  if (depth > 8) return void 0;
  const record = recordOf(value);
  if (!record || !isStringValue(record.id) || !isStringValue(record.title)) return void 0;
  if (!isActivityKind(record.kind) || !isActivityStatus(record.status)) return void 0;
  for (const candidate of [record.sourceId, record.subject, record.currentStep, record.outputTail, record.ownerSessionId, record.model, record.thinking]) {
    if (!optionalString(candidate)) return void 0;
  }
  for (const candidate of [record.createdAt, record.updatedAt, record.settledAt]) {
    if (!optionalFiniteNumber(candidate)) return void 0;
  }
  const sourceId = stringOrUndefined(record.sourceId);
  const subject = stringOrUndefined(record.subject);
  const currentStep = stringOrUndefined(record.currentStep);
  const outputTail = stringOrUndefined(record.outputTail);
  const ownerSessionId2 = stringOrUndefined(record.ownerSessionId);
  const model = stringOrUndefined(record.model);
  const thinking2 = stringOrUndefined(record.thinking);
  const createdAt = numberOrUndefined(record.createdAt);
  const updatedAt = numberOrUndefined(record.updatedAt);
  const settledAt = numberOrUndefined(record.settledAt);
  const body = parseActivityBody(record.body);
  if (record.body !== void 0 && body === void 0) return void 0;
  let activeTools;
  if (record.activeTools !== void 0) {
    if (!Array.isArray(record.activeTools) || record.activeTools.length > 256) return void 0;
    activeTools = [];
    for (const child of record.activeTools) {
      const parsed = parseActivitySnapshot(child, depth + 1);
      if (!parsed) return void 0;
      activeTools.push(parsed);
    }
  }
  let result;
  if (record.result !== void 0) {
    const resultRecord = recordOf(record.result);
    if (!resultRecord || !optionalString(resultRecord.summary) || !optionalString(resultRecord.error)) return void 0;
    const parsedResult = {};
    if (resultRecord.summary !== void 0) parsedResult.summary = resultRecord.summary;
    if (resultRecord.error !== void 0) parsedResult.error = resultRecord.error;
    result = parsedResult;
  }
  let metrics;
  if (record.metrics !== void 0) {
    const metricRecord = recordOf(record.metrics);
    if (!metricRecord) return void 0;
    for (const candidate of [metricRecord.tokens, metricRecord.tokensIn, metricRecord.tokensOut, metricRecord.contextWindow, metricRecord.costUsd, metricRecord.turns, metricRecord.elapsedMs]) {
      if (!optionalFiniteNumber(candidate)) return void 0;
    }
    const parsedMetrics = {};
    if (isNumberValue(metricRecord.tokens)) parsedMetrics.tokens = metricRecord.tokens;
    if (isNumberValue(metricRecord.tokensIn)) parsedMetrics.tokensIn = metricRecord.tokensIn;
    if (isNumberValue(metricRecord.tokensOut)) parsedMetrics.tokensOut = metricRecord.tokensOut;
    if (isNumberValue(metricRecord.contextWindow)) parsedMetrics.contextWindow = metricRecord.contextWindow;
    if (isNumberValue(metricRecord.costUsd)) parsedMetrics.costUsd = metricRecord.costUsd;
    if (isNumberValue(metricRecord.turns)) parsedMetrics.turns = metricRecord.turns;
    if (isNumberValue(metricRecord.elapsedMs)) parsedMetrics.elapsedMs = metricRecord.elapsedMs;
    metrics = parsedMetrics;
  }
  const snapshot = { id: record.id, kind: record.kind, title: record.title, status: record.status };
  if (sourceId !== void 0) snapshot.sourceId = sourceId;
  if (record.invocation !== void 0) snapshot.invocation = record.invocation;
  if (subject !== void 0) snapshot.subject = subject;
  if (currentStep !== void 0) snapshot.currentStep = currentStep;
  if (outputTail !== void 0) snapshot.outputTail = outputTail;
  if (body !== void 0) snapshot.body = body;
  if (activeTools !== void 0) snapshot.activeTools = activeTools;
  if (result !== void 0) snapshot.result = result;
  if (ownerSessionId2 !== void 0) snapshot.ownerSessionId = ownerSessionId2;
  if (createdAt !== void 0) snapshot.createdAt = createdAt;
  if (updatedAt !== void 0) snapshot.updatedAt = updatedAt;
  if (settledAt !== void 0) snapshot.settledAt = settledAt;
  if (model !== void 0) snapshot.model = model;
  if (thinking2 !== void 0) snapshot.thinking = thinking2;
  if (metrics !== void 0) snapshot.metrics = metrics;
  return snapshot;
}
function skipControlString(text, start) {
  let index = start + 2;
  while (index < text.length && text[index] !== "\n") {
    if (text[index] === "\x07" || text.charCodeAt(index) === 156) return index + 1;
    if (text[index] === "\x1B" && text[index + 1] === "\\") return index + 2;
    index += 1;
  }
  return index;
}
function skipC1ControlString(text, start) {
  let index = start + 1;
  while (index < text.length && text[index] !== "\n") {
    if (text[index] === "\x07" || text.charCodeAt(index) === 156) return index + 1;
    if (text[index] === "\x1B" && text[index + 1] === "\\") return index + 2;
    index += 1;
  }
  return index;
}
function skipEscapeSequence(text, start) {
  const next = text[start + 1];
  if (next === void 0 || next === "\n") return start + 1;
  if (next === "]" || next === "_" || next === "P" || next === "X" || next === "^") return skipControlString(text, start);
  if (next === "[") {
    let index = start + 2;
    while (index < text.length && text[index] !== "\n") {
      const code = text.charCodeAt(index);
      index += 1;
      if (code >= 64 && code <= 126) break;
    }
    return index;
  }
  if (next === "(" || next === ")" || next === "%" || next === "*" || next === "+" || next === "#") {
    return start + (text[start + 2] === void 0 || text[start + 2] === "\n" ? 2 : 3);
  }
  return start + 2;
}
function sanitizeActivityText(text) {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\x1B") {
      index = skipEscapeSequence(text, index);
      continue;
    }
    const code = text.charCodeAt(index);
    if (code === 155) {
      index += 1;
      while (index < text.length && text[index] !== "\n") {
        const finalCode = text.charCodeAt(index);
        index += 1;
        if (finalCode >= 64 && finalCode <= 126) break;
      }
      continue;
    }
    if (code === 144 || code === 152 || code === 157 || code === 158 || code === 159) {
      index = skipC1ControlString(text, index);
      continue;
    }
    if (char === "	") {
      output += "    ";
      index += 1;
      continue;
    }
    if (char === "\r") {
      output += "\n";
      index += text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    if ((code < 32 || code >= 127 && code <= 159) && char !== "\n") {
      index += 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}
function sanitizeActivityTextTail(text, options) {
  const maxChars = Math.max(1, Math.floor(options.maxChars));
  const maxLines = Math.max(1, Math.floor(options.maxLines));
  const completedLines = [];
  let currentLine = "";
  let chunk = "";
  let index = 0;
  const flushChunk = () => {
    if (!chunk) return;
    currentLine += chunk;
    chunk = "";
    if (currentLine.length > maxChars) currentLine = currentLine.slice(-maxChars);
  };
  const finishLine = () => {
    flushChunk();
    completedLines.push(currentLine);
    if (completedLines.length > maxLines) completedLines.shift();
    currentLine = "";
  };
  const append = (value) => {
    chunk += value;
    if (chunk.length >= 4096) flushChunk();
  };
  while (index < text.length) {
    const char = text[index];
    if (char === "\x1B") {
      index = skipEscapeSequence(text, index);
      continue;
    }
    const code = text.charCodeAt(index);
    if (code === 155) {
      index += 1;
      while (index < text.length && text[index] !== "\n") {
        const finalCode = text.charCodeAt(index);
        index += 1;
        if (finalCode >= 64 && finalCode <= 126) break;
      }
      continue;
    }
    if (code === 144 || code === 152 || code === 157 || code === 158 || code === 159) {
      index = skipC1ControlString(text, index);
      continue;
    }
    if (char === "	") {
      append("    ");
      index += 1;
      continue;
    }
    if (char === "\r") {
      finishLine();
      index += text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (char === "\n") {
      finishLine();
      index += 1;
      continue;
    }
    if (code < 32 || code >= 127 && code <= 159) {
      index += 1;
      continue;
    }
    append(char);
    index += 1;
  }
  flushChunk();
  const lines = [...completedLines, currentLine].slice(-maxLines);
  const output = lines.join("\n");
  return output.length <= maxChars ? output : output.slice(-maxChars);
}
function isSecretKey(key) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.toLowerCase());
  const normalized = words.join("");
  const hasCompoundApiKey = words.some((word, index) => word === "api" && words[index + 1] === "key");
  return words.some((word) => SECRET_KEY_WORDS.has(word)) || SECRET_KEY_WORDS.has(normalized) || normalized === "privatekey" || hasCompoundApiKey;
}
function boundedText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}\u2026`;
}
function isBooleanValue(value) {
  return typeof value === "boolean";
}
function isBigIntValue(value) {
  return typeof value === "bigint";
}
function isSymbolValue(value) {
  return typeof value === "symbol";
}
function isFunctionValue(value) {
  return typeof value === "function";
}
function isPreviewContainer(value) {
  return typeof value === "object";
}
function safeValuePreview(value, options = {}) {
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? 2e3));
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 4));
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 20));
  const maxStringChars = Math.max(1, Math.floor(options.maxStringChars ?? 500));
  let remainingNodes = Math.max(1, Math.floor(options.maxNodes ?? 256));
  let remainingStringChars = Math.max(1, Math.floor(options.maxTotalStringChars ?? maxChars));
  const seen = /* @__PURE__ */ new WeakSet();
  const inspectString = (text) => {
    if (remainingStringChars <= 0) return { text: "[Truncated]", truncated: true };
    const inspectedChars = Math.min(text.length, maxStringChars, remainingStringChars);
    remainingStringChars -= inspectedChars;
    const sanitized = sanitizeActivityText(text.slice(0, inspectedChars));
    const truncated = text.length > inspectedChars;
    return {
      text: truncated ? boundedText(`${sanitized}\u2026`, maxStringChars) : boundedText(sanitized, maxStringChars),
      truncated
    };
  };
  const visit = (current, depth) => {
    if (remainingNodes <= 0) return "[Truncated]";
    remainingNodes -= 1;
    if (isStringValue(current)) return inspectString(current).text;
    if (current === null || isBooleanValue(current) || isNumberValue(current)) return current;
    if (isBigIntValue(current)) return `${current.toString()}n`;
    if (current === void 0) return "[undefined]";
    if (isFunctionValue(current)) return "[Function]";
    if (isSymbolValue(current)) return current.toString();
    if (!isPreviewContainer(current)) return sanitizeActivityText(String(current));
    if (seen.has(current)) return "[Circular]";
    if (depth >= maxDepth) return "[Truncated]";
    seen.add(current);
    if (Array.isArray(current)) {
      const inspected = current.slice(0, maxEntries);
      const result2 = inspected.map((item) => visit(item, depth + 1));
      if (current.length > inspected.length) result2.push(`\u2026 ${current.length - inspected.length} more`);
      return result2;
    }
    const result = {};
    const keys = [];
    let hasMore = false;
    try {
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        if (keys.length >= maxEntries) {
          hasMore = true;
          break;
        }
        keys.push(key);
      }
    } catch {
      return "[Uninspectable]";
    }
    for (const key of keys) {
      const inspectedKey = inspectString(key);
      const displayKey = inspectedKey.text || "[empty key]";
      if (inspectedKey.truncated || isSecretKey(displayKey)) {
        result[displayKey] = "[REDACTED]";
        continue;
      }
      try {
        result[displayKey] = visit(current[key], depth + 1);
      } catch {
        result[displayKey] = "[Uninspectable]";
      }
    }
    if (hasMore) result["\u2026"] = "more";
    return result;
  };
  let serialized;
  try {
    serialized = JSON.stringify(visit(value, 0));
  } catch {
    serialized = "[Unserializable]";
  }
  return boundedText(sanitizeActivityText(serialized ?? "[undefined]"), maxChars);
}
function isToolCanonicalTransition(existing, incoming) {
  return existing.kind === "tool" && incoming.kind !== "tool" || existing.kind !== "tool" && incoming.kind === "tool";
}
function sameActivity(existing, incoming) {
  if (existing.id === incoming.id) {
    if (existing.kind === "subagent" && incoming.kind === "subagent") {
      if (existing.sourceId !== void 0 || incoming.sourceId !== void 0) {
        return existing.sourceId !== void 0 && existing.sourceId === incoming.sourceId;
      }
      if (existing.createdAt !== void 0 && incoming.createdAt !== void 0) {
        return existing.createdAt === incoming.createdAt;
      }
    }
    return true;
  }
  if (existing.kind === "subagent" && incoming.kind === "subagent" && existing.sourceId !== void 0 && existing.sourceId === incoming.sourceId) return true;
  if (!isToolCanonicalTransition(existing, incoming)) return false;
  return existing.sourceId === incoming.id || incoming.sourceId === existing.id || existing.sourceId !== void 0 && existing.sourceId === incoming.sourceId;
}
function canonicalIdentity(existing, incoming) {
  if (!isToolCanonicalTransition(existing, incoming) || !sameActivity(existing, incoming)) {
    const sourceId2 = incoming.sourceId ?? existing.sourceId;
    const identity2 = {
      id: incoming.id,
      kind: incoming.kind,
      title: incoming.title
    };
    if (sourceId2) identity2.sourceId = sourceId2;
    return identity2;
  }
  const canonical = existing.kind === "tool" ? incoming : existing;
  const tool = existing.kind === "tool" ? existing : incoming;
  const sourceId = canonical.sourceId && canonical.sourceId !== canonical.id ? canonical.sourceId : tool.id !== canonical.id ? tool.id : tool.sourceId;
  const identity = {
    id: canonical.id,
    kind: canonical.kind,
    title: canonical.title
  };
  if (sourceId) identity.sourceId = sourceId;
  return identity;
}
function mergeBody(existing, incoming) {
  if (!incoming) return existing;
  if (!existing || existing.kind !== incoming.kind) return incoming;
  if (existing.kind === "source" && incoming.kind === "source") {
    return {
      kind: "source",
      text: incoming.text || existing.text,
      startLine: incoming.startLine ?? existing.startLine,
      totalLines: incoming.totalLines ?? existing.totalLines
    };
  }
  if (existing.kind === "terminal" && incoming.kind === "terminal") {
    return { kind: "terminal", command: incoming.command ?? existing.command, text: incoming.text || existing.text };
  }
  return { ...existing, ...incoming, text: incoming.text || existing.text };
}
function mergeChildren(existing, incoming) {
  if (incoming === void 0) return existing;
  if (incoming.length === 0) return [];
  if (!existing || existing.length === 0) return incoming.slice(0, MAX_MERGED_ACTIVE_TOOLS);
  const merged = incoming.map((child) => {
    const previous = existing.find((candidate) => sameActivity(candidate, child));
    return previous ? mergeActivitySnapshot(previous, child) : child;
  });
  for (const child of existing) {
    if (merged.length >= MAX_MERGED_ACTIVE_TOOLS) break;
    if (!incoming.some((candidate) => sameActivity(candidate, child))) merged.push(child);
  }
  return merged.slice(0, MAX_MERGED_ACTIVE_TOOLS);
}
function mergeActivitySnapshot(existing, incoming) {
  const status = isSettledActivityStatus(existing.status) && !isSettledActivityStatus(incoming.status) ? existing.status : incoming.status;
  const identity = canonicalIdentity(existing, incoming);
  const invocation = incoming.invocation ?? existing.invocation;
  const subject = incoming.subject ?? existing.subject;
  const currentStep = incoming.currentStep ?? existing.currentStep;
  const outputTail = incoming.outputTail ?? existing.outputTail;
  const body = mergeBody(existing.body, incoming.body);
  const activeTools = mergeChildren(existing.activeTools, incoming.activeTools);
  const result = incoming.result || existing.result ? { ...existing.result, ...incoming.result } : void 0;
  const ownerSessionId2 = incoming.ownerSessionId ?? existing.ownerSessionId;
  const createdAt = incoming.createdAt ?? existing.createdAt;
  const updatedAt = incoming.updatedAt ?? existing.updatedAt;
  const settledAt = incoming.settledAt ?? existing.settledAt;
  const model = incoming.model ?? existing.model;
  const thinking2 = incoming.thinking ?? existing.thinking;
  const metrics = incoming.metrics || existing.metrics ? { ...existing.metrics, ...incoming.metrics } : void 0;
  const merged = {
    ...existing,
    ...incoming,
    ...identity,
    status
  };
  if (invocation !== void 0) merged.invocation = invocation;
  if (subject !== void 0) merged.subject = subject;
  if (currentStep !== void 0) merged.currentStep = currentStep;
  if (outputTail !== void 0) merged.outputTail = outputTail;
  if (body !== void 0) merged.body = body;
  if (activeTools !== void 0) merged.activeTools = activeTools;
  if (result !== void 0) merged.result = result;
  if (ownerSessionId2 !== void 0) merged.ownerSessionId = ownerSessionId2;
  if (createdAt !== void 0) merged.createdAt = createdAt;
  if (updatedAt !== void 0) merged.updatedAt = updatedAt;
  if (settledAt !== void 0) merged.settledAt = settledAt;
  if (model !== void 0) merged.model = model;
  if (thinking2 !== void 0) merged.thinking = thinking2;
  if (metrics !== void 0) merged.metrics = metrics;
  return merged;
}

// src/activity/output-tail.ts
var ACTIVITY_OUTPUT_MAX_BYTES = 16 * 1024;
var ACTIVITY_OUTPUT_MAX_LINES = 25;
function positiveInteger(value, fallback) {
  return value !== void 0 && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function startsWithUtf8Continuation(bytes) {
  return bytes.length > 0 && (bytes[0] & 192) === 128;
}
function decodeValidUtf8Tail(bytes, maxBytes) {
  let tail = bytes.subarray(Math.max(0, bytes.byteLength - maxBytes));
  while (startsWithUtf8Continuation(tail)) tail = tail.subarray(1);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let endTrim = 0; endTrim <= Math.min(3, tail.byteLength); endTrim += 1) {
    try {
      return decoder.decode(endTrim === 0 ? tail : tail.subarray(0, tail.byteLength - endTrim));
    } catch {
    }
  }
  return new TextDecoder("utf-8").decode(tail);
}
function trimStringToUtf8Tail(text, maxBytes) {
  return decodeValidUtf8Tail(Buffer.from(text, "utf8"), maxBytes);
}
function boundedOutputTail(value, options = {}) {
  const maxBytes = positiveInteger(options.maxBytes, ACTIVITY_OUTPUT_MAX_BYTES);
  const maxLines = positiveInteger(options.maxLines, ACTIVITY_OUTPUT_MAX_LINES);
  const decoded = value instanceof Uint8Array ? decodeValidUtf8Tail(value, value.byteLength) : value;
  const sanitized = sanitizeActivityTextTail(decoded, { maxChars: maxBytes, maxLines });
  const byteBounded = trimStringToUtf8Tail(sanitized, maxBytes);
  const lines = byteBounded.split("\n");
  const rowBounded = lines.length > maxLines ? lines.slice(lines.length - maxLines).join("\n") : byteBounded;
  return trimStringToUtf8Tail(rowBounded, maxBytes);
}

// src/background-tasks/task-types.ts
var TERMINAL_TASK_SCHEMA_VERSION = 4;
var SETTLED_STATUSES = /* @__PURE__ */ new Set(["completed", "failed", "cancelled", "lost"]);
function isTerminalTaskSettled(status) {
  return SETTLED_STATUSES.has(status);
}
function terminalActivityStatus(status) {
  switch (status) {
    case "starting":
      return "queued";
    case "running":
    case "stopping":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "lost":
      return "lost";
  }
}
function terminalActivitySnapshot(task, outputTail) {
  const title = sanitizeActivityText(task.title).slice(0, 512);
  const command = sanitizeActivityText(task.command).slice(0, 4 * 1024);
  const cwd = sanitizeActivityText(task.cwd).slice(0, 2 * 1024);
  const output = boundedOutputTail(outputTail);
  const leading = {};
  if (task.sourceId) leading.sourceId = task.sourceId;
  return {
    id: task.id,
    ...leading,
    kind: "terminal",
    title,
    status: terminalActivityStatus(task.status),
    invocation: { command, cwd },
    subject: cwd,
    currentStep: task.status === "stopping" ? "stopping" : void 0,
    outputTail: output,
    body: { kind: "terminal", command, text: output },
    result: task.status === "failed" || task.status === "lost" ? { error: task.status === "lost" ? "terminal process was lost" : `terminal exited with code ${task.exitCode ?? "unknown"}` } : task.status === "completed" || task.status === "cancelled" ? { summary: task.status === "cancelled" ? "terminal cancelled" : `terminal exited with code ${task.exitCode ?? 0}` } : void 0,
    ownerSessionId: task.ownerSessionId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    settledAt: task.settledAt,
    metrics: task.settledAt === void 0 ? void 0 : { elapsedMs: Math.max(0, task.settledAt - task.createdAt) }
  };
}

// src/background-tasks/task-store.ts
var StaleTerminalTaskRevisionError = class extends Error {
  constructor(id, expectedRevision, actualRevision) {
    super(`Stale terminal task transition for ${id}: expected revision ${expectedRevision}, found ${actualRevision}`);
    this.id = id;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
  id;
  expectedRevision;
  actualRevision;
};
var CorruptTerminalTaskRecordError = class extends Error {
};
var TerminalTaskLockBusyError = class extends Error {
};
var STATUSES = /* @__PURE__ */ new Set(["starting", "running", "stopping", "completed", "failed", "cancelled", "lost"]);
var POLICIES = /* @__PURE__ */ new Set(["passive", "wake"]);
var DELIVERY_STATES = /* @__PURE__ */ new Set(["none", "pending", "claimed", "delivered", "suppressed"]);
var ACTIVE_STATUSES = /* @__PURE__ */ new Set(["starting", "running", "stopping"]);
var TERMINAL_ID_PATTERN = /^term-[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126})$/;
var PRIVATE_FILE_MODE = 384;
var PRIVATE_DIRECTORY_MODE = 448;
var DEFAULT_LOCK_TIMEOUT_MS = 5e3;
var DEFAULT_LOCK_POLL_MS = 10;
var NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
var LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
var KNOWN_ARTIFACT_NAMES = ["output.log", "exit.code", "launch.ready", "run.sh", "run.cmd"];
function isSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isOptionalTimestamp(value) {
  return value === void 0 || isSafeInteger(value);
}
function isOptionalString(value) {
  return value === void 0 || typeof value === "string";
}
function isStringValue2(value) {
  return typeof value === "string";
}
function isNumberValue2(value) {
  return typeof value === "number";
}
function isStoredObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isProcessTreeVerification(value) {
  if (value === void 0) return true;
  if (!isStoredObject(value)) return false;
  const { members } = value;
  if (!Array.isArray(members) || members.length === 0 || members.length > 4096) return false;
  const pids = /* @__PURE__ */ new Set();
  for (const member of members) {
    if (!isStoredObject(member)) return false;
    if (!isPositiveInteger(member.pid) || !hasText(member.processStartTime) || pids.has(member.pid)) return false;
    pids.add(member.pid);
  }
  return true;
}
function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function hasPrivateMode(mode, directory) {
  if (process.platform === "win32") return true;
  const expected = directory ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE;
  return (mode & 511) === expected;
}
function pathExists2(path2) {
  try {
    lstatSync2(path2);
    return true;
  } catch (error) {
    return error instanceof Error && errorHasCode(error) && !errorMatches(error, "ENOENT");
  }
}
function errorCode2(error) {
  const code = error.code;
  return code === void 0 || code === null ? void 0 : String(code);
}
function errorMatches(cause, code) {
  return causeIsError(cause) && errorCode2(cause) === code;
}
function causeIsError(cause) {
  return cause instanceof Error;
}
function errorHasCode(error) {
  return error.code !== void 0 && error.code !== null;
}
function sleepSync(milliseconds) {
  Atomics.wait(LOCK_SLEEP, 0, 0, Math.max(1, milliseconds));
}
function isValidTerminalTaskId(id) {
  return TERMINAL_ID_PATTERN.test(id) && !id.includes("..");
}
function isStatusValue(value) {
  return typeof value === "string" && STATUSES.has(value);
}
function isPolicyValue(value) {
  return typeof value === "string" && POLICIES.has(value);
}
function isDeliveryStateValue(value) {
  return typeof value === "string" && DELIVERY_STATES.has(value);
}
function parseTerminalTaskSnapshot(value) {
  if (!isStoredObject(value)) return void 0;
  const record = value;
  if (record.schemaVersion !== TERMINAL_TASK_SCHEMA_VERSION || !isPositiveInteger(record.revision) || !isStringValue2(record.id) || !isValidTerminalTaskId(record.id) || !(record.sourceId === void 0 || hasText(record.sourceId) && record.sourceId.length <= 512) || !hasText(record.ownerSessionId) || !hasText(record.command) || !hasText(record.cwd) || !hasText(record.title) || !isStatusValue(record.status) || !isPolicyValue(record.completionPolicy) || !isPositiveInteger(record.createdAt) || !isPositiveInteger(record.updatedAt) || record.updatedAt < record.createdAt || !isOptionalTimestamp(record.settledAt) || !(record.exitCode === void 0 || record.exitCode === null || Number.isSafeInteger(record.exitCode)) || !isOptionalTimestamp(record.observedAt) || !isOptionalTimestamp(record.consumedAt) || !isDeliveryStateValue(record.deliveryState) || !isOptionalString(record.completionId) || !isOptionalString(record.deliveryClaimToken) || !(record.pid === void 0 || isPositiveInteger(record.pid)) || !(record.processGroupId === void 0 || isPositiveInteger(record.processGroupId)) || !isOptionalString(record.processStartTime) || !isProcessTreeVerification(record.processTreeVerification) || !hasText(record.logFile) || !isAbsolute(record.logFile) || resolve4(record.logFile) !== record.logFile) {
    return void 0;
  }
  const status = isStatusValue(record.status) ? record.status : void 0;
  if (status === void 0) return void 0;
  const settled = isTerminalTaskSettled(status);
  const hasIdentity = record.pid !== void 0 || record.processGroupId !== void 0 || record.processStartTime !== void 0;
  const completeIdentity = isPositiveInteger(record.pid) && isPositiveInteger(record.processGroupId) && hasText(record.processStartTime);
  if (hasIdentity && !completeIdentity) return void 0;
  if ((status === "running" || status === "stopping") && !completeIdentity) return void 0;
  if (status === "starting" && (hasIdentity || record.processTreeVerification !== void 0)) return void 0;
  if (record.processTreeVerification !== void 0 && !completeIdentity) return void 0;
  if (ACTIVE_STATUSES.has(status)) {
    if (record.settledAt !== void 0 || record.exitCode !== void 0 || record.observedAt !== void 0 || record.consumedAt !== void 0 || record.completionId !== void 0 || record.deliveryState !== "none") return void 0;
  } else {
    if (!isPositiveInteger(record.settledAt) || record.settledAt < record.createdAt || record.settledAt > record.updatedAt || !hasText(record.completionId) || record.deliveryState === "none") return void 0;
    if (status === "completed" && record.exitCode !== 0) return void 0;
    if (status === "failed" && !(record.exitCode === null || Number.isSafeInteger(record.exitCode) && record.exitCode !== 0)) return void 0;
    if (status === "cancelled" && record.exitCode !== null) return void 0;
    if (status === "lost" && !(record.exitCode === null || Number.isSafeInteger(record.exitCode))) return void 0;
  }
  for (const timestamp of [record.observedAt, record.consumedAt]) {
    if (timestamp !== void 0 && (timestamp < record.createdAt || timestamp > record.updatedAt)) return void 0;
  }
  if (record.consumedAt !== void 0 && record.observedAt === void 0) return void 0;
  if (record.deliveryState === "suppressed" && record.observedAt === void 0) return void 0;
  if ((record.deliveryState === "pending" || record.deliveryState === "claimed") && (record.observedAt !== void 0 || record.consumedAt !== void 0)) return void 0;
  if (record.deliveryState === "claimed" ? !hasText(record.deliveryClaimToken) : record.deliveryClaimToken !== void 0) return void 0;
  if (!settled && record.deliveryState !== "none") return void 0;
  return record;
}
function schemaVersionOf(value) {
  if (!isStoredObject(value)) return void 0;
  return isNumberValue2(value.schemaVersion) ? value.schemaVersion : void 0;
}
function assertOwnedByCurrentUser(path2, uid) {
  const stat = lstatSync2(path2);
  if (stat.uid !== uid) throw new Error(`Terminal store path is owned by a different user: ${path2}`);
}
function assertPrivateDirectory(path2) {
  const stat = lstatSync2(path2);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected private directory: ${path2}`);
  if (!hasPrivateMode(stat.mode, true)) throw new Error(`Directory permissions must be 0700: ${path2}`);
}
function defaultTerminalStoreRoot() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join12(homedir12(), ".pi", "agent");
  return join12(agentDir, "state", "sumocode-terminals");
}
function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function openPrivateExistingFile(path2, flags) {
  const resolvedPath = resolve4(path2);
  const before = lstatSync2(resolvedPath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Expected regular non-reparse file: ${resolvedPath}`);
  if (!hasPrivateMode(before.mode, false)) throw new Error(`File permissions must be 0600: ${resolvedPath}`);
  if (realpathSync2(resolvedPath) !== resolvedPath) throw new Error(`Terminal artifact path must be canonical: ${resolvedPath}`);
  const descriptor = openSync(resolvedPath, flags | NO_FOLLOW);
  try {
    const opened = fstatSync(descriptor);
    const after = lstatSync2(resolvedPath);
    if (!opened.isFile() || after.isSymbolicLink() || !after.isFile()) throw new Error(`Expected regular non-reparse file: ${resolvedPath}`);
    if (!sameFileIdentity(before, opened) || !sameFileIdentity(opened, after)) throw new Error(`Terminal artifact changed during safe open: ${resolvedPath}`);
    if (!hasPrivateMode(opened.mode, false) || !hasPrivateMode(after.mode, false)) throw new Error(`File permissions must be 0600: ${resolvedPath}`);
    if (realpathSync2(resolvedPath) !== resolvedPath) throw new Error(`Terminal artifact path must be canonical: ${resolvedPath}`);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
function assertPrivateFile(path2) {
  const descriptor = openPrivateExistingFile(path2, constants.O_RDONLY);
  closeSync(descriptor);
}
function readFileNoFollow(path2) {
  const descriptor = openPrivateExistingFile(path2, constants.O_RDONLY);
  try {
    return readFileSync11(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}
function writeExclusivePrivateFile(path2, contents) {
  const descriptor = openSync(path2, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE);
  try {
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    writeFileSync6(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function atomicWriteJson(path2, value) {
  const temporary = join12(dirname6(path2), `.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE);
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    writeFileSync6(descriptor, `${JSON.stringify(value, null, 2)}
`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = void 0;
    renameSync3(temporary, path2);
    try {
      const directoryDescriptor = openSync(dirname6(path2), constants.O_RDONLY | NO_FOLLOW);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {
    }
  } finally {
    if (descriptor !== void 0) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
    }
  }
}
function isBooleanValue2(value) {
  return typeof value === "boolean";
}
function parseLockOwner(path2) {
  try {
    const value = JSON.parse(readFileNoFollow(path2));
    if (!hasText(value.token) || !isPositiveInteger(value.pid) || !isBooleanValue2(value.verifiable)) return void 0;
    if (value.verifiable && !hasText(value.processStartTime)) return void 0;
    if (!value.verifiable && value.processStartTime !== void 0) return void 0;
    return value;
  } catch {
    return void 0;
  }
}
function processProvesOwnerGone(owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (errorMatches(error, "ESRCH")) return true;
    if (!errorMatches(error, "EPERM")) return false;
  }
  if (!owner.verifiable || !owner.processStartTime) return false;
  const actualStartTime = captureProcessStartTime(owner.pid);
  return actualStartTime !== void 0 && actualStartTime !== owner.processStartTime;
}
var TerminalTaskStore = class {
  rootDir;
  metaPathById = /* @__PURE__ */ new Map();
  onDiagnostic;
  lockTimeoutMs;
  lockPollMs;
  processStartTime;
  beforeAbandonedLockRename;
  constructor(options = {}) {
    const requestedRoot = resolve4(options.rootDir ?? defaultTerminalStoreRoot());
    const uid = process.getuid?.();
    try {
      const existing = lstatSync2(requestedRoot);
      if (existing.isSymbolicLink()) throw new Error(`Terminal store root must not be a symlink: ${requestedRoot}`);
      if (uid !== void 0) assertOwnedByCurrentUser(requestedRoot, uid);
    } catch (error) {
      if (!errorMatches(error, "ENOENT")) throw error;
    }
    mkdirSync6(requestedRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (uid !== void 0) assertOwnedByCurrentUser(requestedRoot, uid);
    chmodSync(requestedRoot, PRIVATE_DIRECTORY_MODE);
    assertPrivateDirectory(requestedRoot);
    this.rootDir = realpathSync2(requestedRoot);
    assertPrivateDirectory(this.rootDir);
    this.onDiagnostic = options.onDiagnostic;
    this.lockTimeoutMs = Math.max(1, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    this.lockPollMs = Math.max(1, options.lockPollMs ?? DEFAULT_LOCK_POLL_MS);
    this.processStartTime = captureProcessStartTime(process.pid);
    this.beforeAbandonedLockRename = options.beforeAbandonedLockRename;
  }
  loadAll() {
    this.metaPathById.clear();
    let entries;
    try {
      entries = readdirSync(this.rootDir, { withFileTypes: true });
    } catch (error) {
      this.diagnostic("io", this.rootDir, error);
      return [];
    }
    const snapshots = [];
    for (const entry of entries) {
      const taskDirectory = join12(this.rootDir, entry.name);
      if (entry.isSymbolicLink()) {
        this.diagnostic("corrupt", taskDirectory, "symlink/reparse task directories are not allowed");
        continue;
      }
      if (!entry.isDirectory()) continue;
      try {
        this.assertTaskDirectory(taskDirectory);
      } catch (error) {
        this.diagnostic("corrupt", taskDirectory, error);
        continue;
      }
      const metaPath = join12(taskDirectory, "meta.json");
      if (!pathExists2(metaPath)) continue;
      const snapshot = this.readCandidate(metaPath);
      if (!snapshot) continue;
      if (this.metaPathById.has(snapshot.id)) {
        this.diagnostic("duplicate", metaPath, `duplicate terminal id ${snapshot.id}`);
        continue;
      }
      this.metaPathById.set(snapshot.id, metaPath);
      snapshots.push(snapshot);
    }
    return snapshots;
  }
  listOwned(ownerSessionId2) {
    return this.loadAll().filter((task) => task.ownerSessionId === ownerSessionId2).sort((left, right) => right.createdAt - left.createdAt);
  }
  create(snapshot, metaPath) {
    if (snapshot.schemaVersion !== TERMINAL_TASK_SCHEMA_VERSION || snapshot.revision !== 1) {
      throw new Error("New terminal records must start at the current schema and revision 1");
    }
    const resolvedMetaPath = this.assertStoreMetaPath(metaPath);
    this.assertSnapshotPath(snapshot, resolvedMetaPath);
    return this.withTaskLock(resolvedMetaPath, () => {
      if (pathExists2(resolvedMetaPath)) throw new Error(`Terminal metadata already exists: ${resolvedMetaPath}`);
      atomicWriteJson(resolvedMetaPath, snapshot);
      this.metaPathById.set(snapshot.id, resolvedMetaPath);
      return snapshot;
    });
  }
  get(id) {
    let path2 = this.metaPathById.get(id);
    if (!path2) {
      this.loadAll();
      path2 = this.metaPathById.get(id);
    }
    if (!path2) return void 0;
    return this.readCurrent(path2);
  }
  getOwned(id, ownerSessionId2) {
    const snapshot = this.get(id);
    return snapshot?.ownerSessionId === ownerSessionId2 ? snapshot : void 0;
  }
  /** Verify a direct child directory before creating or opening task artifacts. */
  assertTaskDirectory(path2) {
    const resolvedPath = resolve4(path2);
    const relativePath = relative(this.rootDir, resolvedPath);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || dirname6(relativePath) !== ".") {
      throw new Error("Terminal task directory must be a direct child of the store root");
    }
    assertPrivateDirectory(this.rootDir);
    if (realpathSync2(this.rootDir) !== this.rootDir) throw new Error(`Terminal store root must be canonical: ${this.rootDir}`);
    assertPrivateDirectory(resolvedPath);
    if (realpathSync2(resolvedPath) !== resolvedPath) throw new Error(`Terminal task directory must be canonical and non-reparse: ${resolvedPath}`);
    return resolvedPath;
  }
  /** Safely open an existing regular artifact confined to a verified task directory. */
  openArtifact(path2, flags) {
    const resolvedPath = resolve4(path2);
    const taskDirectory = this.assertTaskDirectory(dirname6(resolvedPath));
    if (dirname6(resolvedPath) !== taskDirectory || basename4(resolvedPath) !== basename4(path2)) {
      throw new Error("Terminal artifact must be a direct child of its task directory");
    }
    return openPrivateExistingFile(resolvedPath, flags);
  }
  transition(id, expectedRevision, update) {
    let path2 = this.metaPathById.get(id);
    if (!path2) {
      this.loadAll();
      path2 = this.metaPathById.get(id);
    }
    if (!path2) throw new Error(`Unknown terminal task ${id}`);
    return this.withTaskLock(path2, () => {
      const current = this.readCurrent(path2);
      if (!current) throw new CorruptTerminalTaskRecordError(`Terminal record ${id} is corrupt or unreadable`);
      if (current.revision !== expectedRevision) {
        throw new StaleTerminalTaskRevisionError(id, expectedRevision, current.revision);
      }
      const next = { ...update(current), revision: current.revision + 1 };
      if (next.id !== current.id || next.ownerSessionId !== current.ownerSessionId || next.schemaVersion !== current.schemaVersion || next.createdAt !== current.createdAt || next.logFile !== current.logFile) {
        throw new Error("Terminal task identity fields are immutable");
      }
      this.assertSnapshotPath(next, path2);
      atomicWriteJson(path2, next);
      return next;
    });
  }
  assertStoreMetaPath(path2) {
    const resolvedPath = resolve4(path2);
    const relativePath = relative(this.rootDir, resolvedPath);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || basename4(resolvedPath) !== "meta.json") {
      throw new Error("Terminal metadata must live in a task directory under the store root");
    }
    const taskDirectory = dirname6(resolvedPath);
    this.assertTaskDirectory(taskDirectory);
    return resolvedPath;
  }
  assertSnapshotPath(snapshot, metaPath) {
    if (!parseTerminalTaskSnapshot(snapshot)) throw new Error("Invalid terminal task snapshot");
    const resolvedMetaPath = this.assertStoreMetaPath(metaPath);
    const taskDirectory = dirname6(resolvedMetaPath);
    if (basename4(taskDirectory) !== `${snapshot.id}-${snapshot.createdAt}`) throw new Error("Terminal task directory does not match id and creation time");
    const expectedLogFile = join12(taskDirectory, "output.log");
    if (snapshot.logFile !== expectedLogFile) throw new Error("Terminal log path must be canonical and store-confined");
    for (const name of KNOWN_ARTIFACT_NAMES) {
      const artifact = join12(taskDirectory, name);
      if (!pathExists2(artifact)) continue;
      assertPrivateFile(artifact);
      if (realpathSync2(artifact) !== artifact) throw new Error(`Terminal artifact must not escape its task directory: ${artifact}`);
    }
    assertPrivateFile(snapshot.logFile);
  }
  readCandidate(path2) {
    let value;
    try {
      value = JSON.parse(readFileNoFollow(path2));
    } catch (error) {
      this.diagnostic("corrupt", path2, error);
      return void 0;
    }
    const version = schemaVersionOf(value);
    if (version === 2 || version === 3) {
      this.diagnostic("legacy", path2, `legacy schema v${version} retained for diagnostics only`);
      return void 0;
    }
    const snapshot = parseTerminalTaskSnapshot(value);
    if (!snapshot) {
      this.diagnostic("corrupt", path2, `invalid or unsupported terminal record schema ${String(version)}`);
      return void 0;
    }
    try {
      this.assertSnapshotPath(snapshot, path2);
    } catch (error) {
      this.diagnostic("corrupt", path2, error);
      return void 0;
    }
    return snapshot;
  }
  readCurrent(path2) {
    return this.readCandidate(path2);
  }
  withTaskLock(metaPath, operation) {
    const lockPath = join12(dirname6(metaPath), ".meta.lock");
    const token = randomUUID();
    const owner = this.processStartTime ? { token, pid: process.pid, processStartTime: this.processStartTime, verifiable: true } : { token, pid: process.pid, verifiable: false };
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      if (this.hasBlockingTakeover(lockPath, token)) {
        if (Date.now() >= deadline) throw new TerminalTaskLockBusyError(`Timed out waiting for terminal task lock: ${lockPath}`);
        sleepSync(this.lockPollMs);
        continue;
      }
      const candidate = join12(dirname6(metaPath), `.meta.lock-candidate-${token}`);
      try {
        mkdirSync6(candidate, { mode: PRIVATE_DIRECTORY_MODE });
        chmodSync(candidate, PRIVATE_DIRECTORY_MODE);
        writeExclusivePrivateFile(join12(candidate, "owner.json"), `${JSON.stringify(owner)}
`);
        try {
          renameSync3(candidate, lockPath);
          if (this.ownsLock(lockPath, token) && !this.hasBlockingTakeover(lockPath, token)) break;
          this.releaseLock(lockPath, owner);
        } catch (error) {
          rmSync2(candidate, { recursive: true, force: true });
          if (!errorMatches(error, "EEXIST") && !errorMatches(error, "ENOTEMPTY")) throw error;
        }
      } catch (error) {
        try {
          rmSync2(candidate, { recursive: true, force: true });
        } catch {
        }
        if (!errorMatches(error, "EEXIST") && !errorMatches(error, "ENOTEMPTY")) throw error;
      }
      if (this.breakAbandonedLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new TerminalTaskLockBusyError(`Timed out waiting for terminal task lock: ${lockPath}`);
      sleepSync(this.lockPollMs);
    }
    try {
      return operation();
    } finally {
      this.releaseLock(lockPath, owner);
    }
  }
  takeoverPaths(lockPath) {
    const prefix = `${basename4(lockPath)}.takeover-`;
    try {
      return readdirSync(dirname6(lockPath), { encoding: "utf8" }).filter((name) => name.startsWith(prefix)).map((name) => join12(dirname6(lockPath), name));
    } catch {
      return [];
    }
  }
  hasBlockingTakeover(lockPath, ownToken) {
    let blocked = false;
    for (const path2 of this.takeoverPaths(lockPath)) {
      const owner = parseLockOwner(join12(path2, "owner.json"));
      if (owner?.token === ownToken) continue;
      if (owner && processProvesOwnerGone(owner)) {
        rmSync2(path2, { recursive: true, force: true });
        continue;
      }
      blocked = true;
    }
    return blocked;
  }
  ownsLock(lockPath, token) {
    const canonicalOwner = parseLockOwner(join12(lockPath, "owner.json"));
    if (canonicalOwner?.token === token) return true;
    return this.takeoverPaths(lockPath).some((path2) => parseLockOwner(join12(path2, "owner.json"))?.token === token);
  }
  breakAbandonedLock(lockPath) {
    const owner = parseLockOwner(join12(lockPath, "owner.json"));
    if (!owner || !processProvesOwnerGone(owner)) return false;
    this.beforeAbandonedLockRename?.();
    const takeoverPath = `${lockPath}.takeover-${randomUUID()}`;
    try {
      renameSync3(lockPath, takeoverPath);
    } catch (error) {
      if (errorMatches(error, "ENOENT")) return true;
      return false;
    }
    const movedOwner = parseLockOwner(join12(takeoverPath, "owner.json"));
    if (!movedOwner || movedOwner.token !== owner.token) {
      return false;
    }
    rmSync2(takeoverPath, { recursive: true, force: true });
    return true;
  }
  releaseLock(lockPath, owner) {
    for (let pass = 0; pass < 2; pass += 1) {
      for (const path2 of [lockPath, ...this.takeoverPaths(lockPath)]) {
        const currentOwner = parseLockOwner(join12(path2, "owner.json"));
        if (!currentOwner || currentOwner.token !== owner.token) continue;
        const releasePath = `${path2}.release-${owner.token}-${randomUUID()}`;
        try {
          renameSync3(path2, releasePath);
          rmSync2(releasePath, { recursive: true, force: true });
        } catch (error) {
          if (!errorMatches(error, "ENOENT")) this.diagnostic("io", path2, error);
        }
      }
    }
  }
  diagnostic(kind, path2, error) {
    this.onDiagnostic?.({
      kind,
      path: path2,
      message: error instanceof Error ? error.message : String(error)
    });
  }
};

// src/background-tasks/visible-spawn.ts
import { dirname as dirname7, join as join13 } from "node:path";
function buildVisibleTaskPaths(taskId, startedAtMs, baseDir) {
  const root = baseDir ?? join13(process.env.TMPDIR ?? "/tmp", "sumocode-bg");
  const dir = join13(root, `${taskId}-${startedAtMs}`);
  return {
    logFile: join13(dir, "output.log"),
    exitFile: join13(dir, "exit.code"),
    markerFile: join13(dir, "started.marker"),
    scriptFile: join13(dir, "run.sh"),
    metaFile: join13(dir, "meta.json"),
    promptFile: join13(dir, "prompt.txt"),
    responseFile: join13(dir, "response.md"),
    diagFile: join13(dir, "diag.jsonl"),
    controlDir: join13(dir, "control")
  };
}
function shellEscape2(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function buildVisibleAgentArgs(options) {
  const modelFlags = options.model ? ["--model", options.model] : [];
  const thinkingFlags = options.thinking ? ["--thinking", options.thinking] : [];
  const toolsFlags = options.tools === void 0 ? [] : options.tools.length === 0 ? ["--no-tools"] : ["--tools", options.tools.join(",")];
  return ["task", ...modelFlags, ...thinkingFlags, ...toolsFlags, "--task-dir", dirname7(options.paths.promptFile)];
}
function buildVisibleAgentCommand(options) {
  return [
    "cd",
    shellEscape2(options.cwd),
    "&&",
    "exec",
    "sumocode",
    ...buildVisibleAgentArgs(options).map(shellEscape2)
  ].join(" ");
}
function readExitCodeFromFile(contents) {
  const trimmed = contents.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

// src/background-tasks/task-manager.ts
var DEFAULT_POLL_INTERVAL_MS = 250;
var DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;
var DEFAULT_TERM_GRACE_MS = 5e3;
var DEFAULT_KILL_GRACE_MS = 2e3;
var DEFAULT_CLAIM_LEASE_MS = 3e4;
var DEFAULT_STARTING_RECOVERY_GRACE_MS = 3e4;
var MAX_REPLAYED_SETTLED_TERMINALS = 64;
var BOUNDED_TERMINAL_RUNNER_FILE = fileURLToPath3(new URL("./bounded-terminal-runner.mjs", import.meta.url));
var TREE_VERIFICATION_REFRESH_MS = 5e3;
var CHECK_OUTPUT_BYTES = 16 * 1024;
var WAIT_OUTPUT_BYTES = 16 * 1024;
var PRIVATE_FILE_MODE2 = 384;
var PRIVATE_DIRECTORY_MODE2 = 448;
var NO_FOLLOW2 = constants2.O_NOFOLLOW ?? 0;
var MAX_TRANSITION_RETRIES = 16;
function normalizePositive(value, fallback) {
  return value !== void 0 && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function errnoIs(error, code) {
  return error.code === code;
}
function taskPaths(store, id, createdAt) {
  const visiblePaths = buildVisibleTaskPaths(id, createdAt, store.rootDir);
  const directory = dirname8(visiblePaths.logFile);
  return {
    ...visiblePaths,
    directory,
    launchFile: join14(directory, "launch.ready"),
    commandFile: join14(directory, process.platform === "win32" ? "command.cmd" : "command.sh"),
    windowsScriptFile: join14(directory, "run.cmd")
  };
}
function openPrivateFile(store, path2, flags) {
  return store.openArtifact(path2, flags);
}
function createPrivateFile(store, path2, contents) {
  store.assertTaskDirectory(dirname8(path2));
  const descriptor = openSync2(path2, constants2.O_WRONLY | constants2.O_CREAT | constants2.O_EXCL | NO_FOLLOW2, PRIVATE_FILE_MODE2);
  try {
    fchmodSync2(descriptor, PRIVATE_FILE_MODE2);
    writeFileSync7(descriptor, contents, "utf8");
  } finally {
    closeSync2(descriptor);
  }
  const verified = store.openArtifact(path2, constants2.O_RDONLY);
  closeSync2(verified);
}
function createPrivateTaskDirectory(store, path2) {
  mkdirSync7(path2, { mode: PRIVATE_DIRECTORY_MODE2 });
  chmodSync2(path2, PRIVATE_DIRECTORY_MODE2);
  store.assertTaskDirectory(path2);
}
function readExitCode(store, path2) {
  let descriptor;
  try {
    descriptor = openPrivateFile(store, path2, constants2.O_RDONLY);
    const text = readFileSync12(descriptor, "utf8").trim();
    if (!/^-?\d+$/.test(text)) return void 0;
    const exitCode = Number.parseInt(text, 10);
    return Number.isSafeInteger(exitCode) ? exitCode : void 0;
  } catch {
    return void 0;
  } finally {
    if (descriptor !== void 0) closeSync2(descriptor);
  }
}
function immutableTerminalSnapshot(snapshot) {
  const clone = structuredClone(snapshot);
  const freeze = (value) => {
    if (Object.isFrozen(value)) return;
    for (const child of Object.values(value)) {
      if (child !== null && child instanceof Object) freeze(child);
    }
    Object.freeze(value);
  };
  freeze(clone);
  return clone;
}
function readLogTailBytes(store, path2, maxBytes) {
  let descriptor;
  try {
    descriptor = openPrivateFile(store, path2, constants2.O_RDONLY);
    const size = fstatSync2(descriptor).size;
    if (size === 0) return { bytes: new Uint8Array(), truncated: false };
    const bytes = Math.min(size, Math.max(0, maxBytes));
    const buffer = Buffer.alloc(bytes);
    const bytesRead = readSync(descriptor, buffer, 0, bytes, size - bytes);
    return { bytes: buffer.subarray(0, bytesRead), truncated: size > bytes };
  } finally {
    if (descriptor !== void 0) closeSync2(descriptor);
  }
}
function readLogTail(store, path2, maxBytes) {
  let descriptor;
  try {
    descriptor = openPrivateFile(store, path2, constants2.O_RDONLY);
    const size = fstatSync2(descriptor).size;
    if (size === 0) return "";
    const bytes = Math.min(size, Math.max(0, maxBytes));
    const offset = size - bytes;
    const buffer = Buffer.alloc(bytes);
    const bytesRead = readSync(descriptor, buffer, 0, bytes, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
      const newline = text.indexOf("\n");
      if (newline >= 0) text = text.slice(newline + 1);
    }
    return text;
  } catch {
    return "";
  } finally {
    if (descriptor !== void 0) closeSync2(descriptor);
  }
}
function capSettledLog(store, path2, maxBytes) {
  try {
    let descriptor = openPrivateFile(store, path2, constants2.O_RDONLY);
    const size = fstatSync2(descriptor).size;
    closeSync2(descriptor);
    if (size <= maxBytes) return;
    const marker = "[sumocode-terminal] log truncated to bounded tail\n";
    const tail = readLogTail(store, path2, Math.max(0, maxBytes - Buffer.byteLength(marker)));
    descriptor = openPrivateFile(store, path2, constants2.O_WRONLY);
    try {
      ftruncateSync(descriptor, 0);
      writeFileSync7(descriptor, `${marker}${tail}`.slice(-maxBytes), "utf8");
    } finally {
      closeSync2(descriptor);
    }
  } catch {
  }
}
function appendPrivateFile(store, path2, contents) {
  let descriptor;
  try {
    descriptor = openPrivateFile(store, path2, constants2.O_WRONLY | constants2.O_APPEND);
    writeFileSync7(descriptor, contents, "utf8");
  } catch {
  } finally {
    if (descriptor !== void 0) closeSync2(descriptor);
  }
}
function identityOf(task) {
  if (task.pid === void 0 || task.processGroupId === void 0 || task.processStartTime === void 0) return void 0;
  return { pid: task.pid, processGroupId: task.processGroupId, processStartTime: task.processStartTime };
}
function sameTreeVerification(left, right) {
  if (left === void 0 || right === void 0) return left === right;
  if (left.members.length !== right.members.length) return false;
  return left.members.every((anchor, index) => {
    const candidate = right.members[index];
    return candidate?.pid === anchor.pid && candidate.processStartTime === anchor.processStartTime;
  });
}
function buildPosixScript(options) {
  return [
    "#!/usr/bin/env bash",
    "umask 077",
    "set +e",
    "launch_wait=0",
    `while [ ! -f ${shellEscape2(options.launchFile)} ]; do`,
    '  if [ "$launch_wait" -ge 3000 ]; then',
    `    printf '%s\\n' '[sumocode-terminal] launch gate timed out' >> ${shellEscape2(options.logFile)}`,
    `    printf '%s' 125 > ${shellEscape2(options.exitFile)}`,
    "    exit 125",
    "  fi",
    "  sleep 0.01",
    "  launch_wait=$((launch_wait + 1))",
    "done",
    `if ! cd ${shellEscape2(options.cwd)}; then`,
    `  printf '%s\\n' ${shellEscape2(`[sumocode-terminal] working directory unavailable: ${options.cwd}`)} >> ${shellEscape2(options.logFile)}`,
    "  code=1",
    "else",
    "  export SUMOCODE_BG_CHILD=1",
    `  ${shellEscape2(process.execPath)} ${shellEscape2(BOUNDED_TERMINAL_RUNNER_FILE)} posix ${shellEscape2(options.commandFile)} ${shellEscape2(options.logFile)} ${options.logMaxBytes}`,
    "  code=$?",
    "fi",
    `printf '%s' "$code" > ${shellEscape2(options.exitFile)}`,
    // Retain the verified group leader until the manager disposes the complete
    // tree and records the command's already-captured natural exit code.
    "while :; do sleep 1; done"
  ].join("\n");
}
function quoteWindows(value) {
  return `"${value.replace(/%/g, "%%").replace(/"/g, '""')}"`;
}
function buildWindowsScript(options) {
  return [
    "@echo off",
    "set launch_wait=0",
    ":wait_for_launch",
    `if exist ${quoteWindows(options.launchFile)} goto launch_ready`,
    "set /a launch_wait+=1",
    "if %launch_wait% GEQ 30 goto launch_timeout",
    "ping 127.0.0.1 -n 2 >nul",
    "goto wait_for_launch",
    ":launch_timeout",
    `>> ${quoteWindows(options.logFile)} echo [sumocode-terminal] launch gate timed out`,
    `> ${quoteWindows(options.exitFile)} echo 125`,
    "exit /b 125",
    ":launch_ready",
    `cd /d ${quoteWindows(options.cwd)}`,
    "if errorlevel 1 (",
    `  >> ${quoteWindows(options.logFile)} echo [sumocode-terminal] working directory unavailable`,
    `  > ${quoteWindows(options.exitFile)} echo 1`,
    "  goto wait_for_tree_reconcile",
    ")",
    `${quoteWindows(process.execPath)} ${quoteWindows(BOUNDED_TERMINAL_RUNNER_FILE)} win32 ${quoteWindows(options.commandFile)} ${quoteWindows(options.logFile)} ${options.logMaxBytes}`,
    "set terminal_exit=%errorlevel%",
    `> ${quoteWindows(options.exitFile)} echo %terminal_exit%`,
    // Keep the verified leader alive until the manager performs taskkill /T.
    // This prevents a short-lived shell from orphaning background descendants.
    ":wait_for_tree_reconcile",
    "ping 127.0.0.1 -n 2 >nul",
    "goto wait_for_tree_reconcile"
  ].join("\r\n");
}
function abortError() {
  const error = new Error("Terminal wait aborted");
  error.name = "AbortError";
  return error;
}
var TerminalTaskManager = class {
  store;
  processTree;
  spawn;
  now;
  createId;
  createCompletionId;
  createClaimToken;
  pollIntervalMs;
  logMaxBytes;
  termGraceMs;
  killGraceMs;
  claimLeaseMs;
  startingRecoveryGraceMs;
  onDiagnostic;
  tasks = /* @__PURE__ */ new Map();
  runtime = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  snapshotListeners = /* @__PURE__ */ new Set();
  detached = false;
  constructor(options = {}) {
    this.store = options.store ?? new TerminalTaskStore({ onDiagnostic: options.onDiagnostic });
    this.processTree = options.processTree ?? systemProcessTree;
    this.spawn = options.spawn ?? spawnChild;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `term-${this.now().toString(36)}-${randomUUID2().slice(0, 8)}`);
    this.createCompletionId = options.createCompletionId ?? (() => `completion-${randomUUID2()}`);
    this.createClaimToken = options.createClaimToken ?? (() => `claim-${randomUUID2()}`);
    this.pollIntervalMs = normalizePositive(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.logMaxBytes = normalizePositive(options.logMaxBytes, DEFAULT_LOG_MAX_BYTES);
    this.termGraceMs = normalizePositive(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
    this.killGraceMs = normalizePositive(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
    this.claimLeaseMs = normalizePositive(options.claimLeaseMs, DEFAULT_CLAIM_LEASE_MS);
    this.startingRecoveryGraceMs = normalizePositive(options.startingRecoveryGraceMs, DEFAULT_STARTING_RECOVERY_GRACE_MS);
    this.onDiagnostic = options.onDiagnostic;
    for (const snapshot of this.store.loadAll()) {
      this.adopt(snapshot, false);
      this.recover(snapshot);
    }
  }
  async start(options) {
    if (this.detached) throw new Error("Terminal task manager is detached");
    const command = options.command.trim();
    const title = options.title.trim();
    const ownerSessionId2 = options.ownerSessionId.trim();
    const sourceId = options.sourceId?.trim();
    const cwd = options.cwd.trim();
    if (!command) throw new Error("command is required");
    if (!title) throw new Error("title is required");
    if (!ownerSessionId2) throw new Error("owner session id is required");
    if (sourceId && sourceId.length > 512) throw new Error("source id is too long");
    if (!cwd) throw new Error("working directory is required");
    const createdAt = Math.max(1, Math.floor(this.now()));
    let id;
    let paths;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = this.createId();
      if (!isValidTerminalTaskId(candidate)) throw new Error(`Invalid generated terminal id: ${candidate}`);
      const candidatePaths = taskPaths(this.store, candidate, createdAt);
      try {
        createPrivateTaskDirectory(this.store, candidatePaths.directory);
        id = candidate;
        paths = candidatePaths;
        break;
      } catch (error) {
        if (!(error instanceof Error) || !errnoIs(error, "EEXIST")) throw error;
      }
    }
    if (!id || !paths) throw new Error("Unable to allocate a unique terminal task directory");
    createPrivateFile(this.store, paths.logFile, "");
    createPrivateFile(this.store, paths.exitFile, "");
    createPrivateFile(this.store, paths.commandFile, process.platform === "win32" ? command : `exec 2>&1
set -o pipefail
${command}
`);
    const scriptFile = process.platform === "win32" ? paths.windowsScriptFile : paths.scriptFile;
    const runnerOptions = {
      cwd,
      launchFile: paths.launchFile,
      commandFile: paths.commandFile,
      logFile: paths.logFile,
      exitFile: paths.exitFile,
      logMaxBytes: this.logMaxBytes
    };
    createPrivateFile(this.store, scriptFile, process.platform === "win32" ? buildWindowsScript(runnerOptions) : buildPosixScript(runnerOptions));
    const initialWithoutSourceId = {
      schemaVersion: TERMINAL_TASK_SCHEMA_VERSION,
      revision: 1,
      id,
      ownerSessionId: ownerSessionId2,
      command,
      cwd,
      title,
      status: "starting",
      completionPolicy: options.completionPolicy ?? "passive",
      createdAt,
      updatedAt: createdAt,
      deliveryState: "none",
      logFile: paths.logFile
    };
    const initial = sourceId ? { ...initialWithoutSourceId, sourceId } : initialWithoutSourceId;
    this.store.create(initial, paths.metaFile);
    this.adopt(initial, true);
    let child;
    const processOwnerToken = `sumocode-owner-${randomUUID2()}`;
    try {
      child = this.spawn(
        process.platform === "win32" ? "cmd.exe" : "/bin/bash",
        process.platform === "win32" ? ["/d", "/s", "/c", scriptFile] : [scriptFile, processOwnerToken],
        { cwd, detached: true, stdio: "ignore", env: { ...process.env, SUMOCODE_BG_CHILD: "1" } }
      );
    } catch (error) {
      this.failUnlaunched(id, error);
      throw error;
    }
    this.ensureRuntime(initial).child = child;
    child.on("error", (error) => this.runGuarded(id, "child error reconciliation", () => this.handleChildError(id, error)));
    child.on("close", () => this.scheduleReconcile(id));
    const pid = child.pid;
    if (pid === void 0) {
      this.failUnlaunched(id, new Error("spawn returned no process id"));
      throw new Error("Unable to start terminal: spawn returned no process id");
    }
    const processStartTime = this.processTree.captureStartTime(pid);
    const identity = { pid, processGroupId: pid, processStartTime: processStartTime ?? "" };
    if (!processStartTime) {
      const terminated = await terminateFreshProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
      if (!terminated) throw new Error(`Unable to capture terminal process identity and unable to prove fresh process group ${pid} terminated`);
      this.failUnlaunched(id, new Error("unable to capture process start time"));
      throw new Error("Unable to start terminal: process identity could not be captured");
    }
    let running;
    try {
      running = this.mutate(id, (current) => current.status === "starting" ? {
        ...current,
        status: "running",
        updatedAt: this.timestamp(current),
        pid,
        processGroupId: pid,
        processStartTime
      } : void 0);
    } catch (error) {
      const terminated = await terminateFreshProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
      if (!terminated) throw new Error(`Spawn identity persistence failed and fresh process group ${pid} could not be proven terminated`);
      throw error;
    }
    if (!running.changed || running.snapshot.status !== "running") {
      const terminated = await terminateFreshProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
      if (!terminated) throw new Error(`Spawn identity persistence failed and fresh process group ${pid} could not be proven terminated`);
      throw new Error("Spawn identity persistence failed");
    }
    this.ensureRuntime(running.snapshot).treeVerification = this.processTree.captureTreeVerification?.(identity);
    try {
      createPrivateFile(this.store, paths.launchFile, "ready\n");
    } catch (error) {
      const terminated = await terminateProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
      if (!terminated) throw new Error(`Terminal launch release failed and process group ${pid} could not be proven terminated`);
      this.settleFailedLaunch(id);
      throw error;
    }
    child.unref();
    this.arm(id);
    return running.snapshot;
  }
  /** Pure inventory read: no recovery, delivery reconciliation, observation, or listener notification. */
  list(ownerSessionId2) {
    return this.store.listOwned(ownerSessionId2);
  }
  get(id, ownerSessionId2) {
    const task = this.store.getOwned(id, ownerSessionId2);
    if (!task) return void 0;
    this.adopt(task, false);
    if (!isTerminalTaskSettled(task.status)) this.arm(id);
    return task;
  }
  check(id, ownerSessionId2) {
    const current = this.get(id, ownerSessionId2);
    if (!current) return void 0;
    const task = isTerminalTaskSettled(current.status) ? this.observe(current.id, false) : current;
    return { task, output: this.getOutput(task, CHECK_OUTPUT_BYTES) };
  }
  async wait(ids, ownerSessionId2, timeoutMs, signal) {
    const uniqueIds = [...new Set(ids)];
    const known = uniqueIds.filter((id) => this.get(id, ownerSessionId2) !== void 0);
    const knownSet = new Set(known);
    const unknownIds = uniqueIds.filter((id) => !knownSet.has(id));
    const complete2 = () => known.every((id) => {
      const task = this.get(id, ownerSessionId2);
      return task !== void 0 && isTerminalTaskSettled(task.status);
    });
    if (!complete2() && timeoutMs > 0) {
      await new Promise((resolve10, reject) => {
        let finished = false;
        let timer;
        let unsubscribe = () => {
        };
        const finish = (error) => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve10();
        };
        const onAbort = () => finish(abortError());
        unsubscribe = this.addChangeListener(() => {
          if (complete2()) finish();
        });
        if (complete2()) {
          finish();
          return;
        }
        timer = setTimeout(() => finish(), timeoutMs);
        timer.unref?.();
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    const settled = [];
    const pendingIds = [];
    for (const id of known) {
      const current = this.get(id, ownerSessionId2);
      if (!isTerminalTaskSettled(current.status)) {
        pendingIds.push(id);
        continue;
      }
      const task = this.observe(id, true);
      settled.push({ task, output: this.getOutput(task, WAIT_OUTPUT_BYTES) });
    }
    return { settled, pendingIds, unknownIds, timedOut: pendingIds.length > 0 };
  }
  async stop(ids, ownerSessionId2) {
    const uniqueIds = [...new Set(ids)];
    const results = /* @__PURE__ */ new Map();
    const targets = [];
    for (const id of uniqueIds) {
      const current = this.get(id, ownerSessionId2);
      if (!current) {
        results.set(id, { id, outcome: "unknown", message: `Unknown terminal ${id}.` });
        continue;
      }
      if (isTerminalTaskSettled(current.status)) {
        const observed = this.observe(id, false);
        results.set(id, {
          id,
          outcome: "already-settled",
          task: observed,
          output: this.getOutput(observed, WAIT_OUTPUT_BYTES),
          message: `Terminal ${id} was already ${observed.status}.`
        });
        continue;
      }
      const identity = identityOf(current);
      if (!identity) {
        results.set(id, { id, outcome: "failed", task: current, message: `Terminal ${id} has no verified process-group identity.` });
        continue;
      }
      const paths = taskPaths(this.store, current.id, current.createdAt);
      const naturalExitCode = readExitCode(this.store, paths.exitFile);
      if (this.processTree.isTreeEmpty(identity, current.processTreeVerification)) {
        if (naturalExitCode !== void 0) {
          const settled = this.settleNatural(id, naturalExitCode);
          const observed = this.observe(id, false);
          results.set(id, {
            id,
            outcome: "already-settled",
            task: observed,
            output: this.getOutput(observed, WAIT_OUTPUT_BYTES),
            message: `Terminal ${id} completed before its stop signal with exit ${settled.exitCode ?? "unknown"}.`
          });
        } else {
          this.settleLost(id, null, false);
          const observed = this.observe(id, true);
          results.set(id, {
            id,
            outcome: "failed",
            task: observed,
            output: this.getOutput(observed, WAIT_OUTPUT_BYTES),
            message: `Terminal ${id} process tree was already empty without exit evidence; recorded lost.`
          });
        }
        continue;
      }
      const retainedVerification = current.processTreeVerification ?? this.runtime.get(id)?.treeVerification;
      let identityStatus = this.processTree.identityMatches(identity);
      let verifiedByRetainedAnchors = false;
      if (identityStatus === "unknown" && retainedVerification && this.processTree.verificationMatches) {
        identityStatus = this.processTree.verificationMatches(identity, retainedVerification);
        verifiedByRetainedAnchors = identityStatus === "same";
      }
      if (identityStatus === "different") {
        this.settleLost(id, null, false);
        const lost = this.observe(id, false);
        results.set(id, { id, outcome: "failed", task: lost, message: `Terminal ${id} process identity changed; recorded lost without signalling.` });
        continue;
      }
      if (identityStatus === "unknown") {
        results.set(id, { id, outcome: "failed", task: current, message: `Terminal ${id} process identity could not be verified; refusing to signal.` });
        continue;
      }
      const capturedVerification = this.processTree.captureTreeVerification?.(identity);
      if (naturalExitCode !== void 0) {
        const verification2 = capturedVerification ?? (verifiedByRetainedAnchors ? retainedVerification : current.processTreeVerification);
        if (this.processTree.captureTreeVerification && !verification2) {
          results.set(id, { id, outcome: "failed", task: current, message: `Terminal ${id} process-tree anchors could not be persisted; refusing natural-disposition signal.` });
          continue;
        }
        const disposing = verification2 && !sameTreeVerification(current.processTreeVerification, verification2) ? this.mutate(id, (task) => !isTerminalTaskSettled(task.status) && !sameTreeVerification(task.processTreeVerification, verification2) ? { ...task, processTreeVerification: verification2, updatedAt: this.timestamp(task) } : void 0).snapshot : current;
        if (isTerminalTaskSettled(disposing.status)) {
          const observed = this.observe(id, false);
          results.set(id, { id, outcome: "already-settled", task: observed, message: `Terminal ${id} was already ${observed.status}.` });
          continue;
        }
        this.clearPoll(id);
        targets.push({ task: disposing, identity, verification: disposing.processTreeVerification ?? verification2, naturalExitCode });
        continue;
      }
      const verification = current.status === "stopping" ? current.processTreeVerification ?? capturedVerification ?? retainedVerification : capturedVerification ?? (verifiedByRetainedAnchors ? retainedVerification : void 0);
      if (this.processTree.captureTreeVerification && !verification) {
        results.set(id, { id, outcome: "failed", task: current, message: `Terminal ${id} process-tree anchors could not be persisted; refusing to signal.` });
        continue;
      }
      const stopping = this.mutate(id, (task) => {
        if (isTerminalTaskSettled(task.status)) return void 0;
        const nextVerification = verification ?? task.processTreeVerification;
        if (task.status === "stopping" && sameTreeVerification(task.processTreeVerification, nextVerification)) return void 0;
        return {
          ...task,
          status: "stopping",
          updatedAt: this.timestamp(task),
          processTreeVerification: nextVerification
        };
      }).snapshot;
      if (isTerminalTaskSettled(stopping.status)) {
        const observed = this.observe(id, false);
        results.set(id, { id, outcome: "already-settled", task: observed, message: `Terminal ${id} was already ${observed.status}.` });
        continue;
      }
      this.clearPoll(id);
      targets.push({ task: stopping, identity, verification });
    }
    const termSignals = await Promise.all(targets.map(({ identity, verification, naturalExitCode }) => this.safeVerifiedSignal(identity, naturalExitCode === void 0 ? "SIGTERM" : "SIGKILL", verification)));
    await Promise.all(targets.map(async ({ task, identity, verification, naturalExitCode }, index) => {
      results.set(task.id, naturalExitCode === void 0 ? await this.finishStop(task.id, identity, termSignals[index], true, verification) : await this.finishNaturalStop(task.id, identity, naturalExitCode, termSignals[index], verification));
    }));
    return uniqueIds.map((id) => results.get(id));
  }
  claimPending(ownerSessionId2, includeWake, maxWake = 1) {
    const claimed = [];
    let claimedWake = 0;
    for (const candidate of this.store.listOwned(ownerSessionId2)) {
      if (!isTerminalTaskSettled(candidate.status)) continue;
      if (candidate.completionPolicy === "wake" && (!includeWake || claimedWake >= maxWake)) continue;
      const result = this.mutate(candidate.id, (current) => {
        if (current.ownerSessionId !== ownerSessionId2 || !isTerminalTaskSettled(current.status)) return void 0;
        const expiredClaim = current.deliveryState === "claimed" && this.now() - current.updatedAt >= this.claimLeaseMs;
        if (current.deliveryState !== "pending" && !expiredClaim) return void 0;
        if (current.completionPolicy === "wake" && (!includeWake || claimedWake >= maxWake)) return void 0;
        return {
          ...current,
          deliveryState: "claimed",
          deliveryClaimToken: this.createClaimToken(),
          updatedAt: this.timestamp(current)
        };
      });
      if (!result.changed) continue;
      claimed.push(result.snapshot);
      if (result.snapshot.completionPolicy === "wake") claimedWake += 1;
    }
    return claimed;
  }
  acknowledge(ownerSessionId2, receipts) {
    const receiptKeys = new Set(receipts.map(({ completionId, claimToken }) => `${completionId}\0${claimToken}`));
    const acknowledged = [];
    for (const candidate of this.store.listOwned(ownerSessionId2)) {
      if (!candidate.completionId || !candidate.deliveryClaimToken || !receiptKeys.has(`${candidate.completionId}\0${candidate.deliveryClaimToken}`)) continue;
      const result = this.mutate(candidate.id, (current) => {
        if (current.ownerSessionId !== ownerSessionId2 || current.deliveryState !== "claimed" || !current.completionId || !current.deliveryClaimToken || !receiptKeys.has(`${current.completionId}\0${current.deliveryClaimToken}`)) return void 0;
        return { ...current, deliveryState: "delivered", deliveryClaimToken: void 0, updatedAt: this.timestamp(current) };
      });
      if (result.changed) acknowledged.push(result.snapshot);
    }
    return acknowledged;
  }
  getClaimRetryDelay(ownerSessionId2) {
    const delays = this.store.listOwned(ownerSessionId2).filter((task) => task.deliveryState === "claimed").map((task) => Math.max(0, this.claimLeaseMs - (this.now() - task.updatedAt)));
    return delays.length > 0 ? Math.min(...delays) : void 0;
  }
  addChangeListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Replay one complete immutable manager projection, then publish transitions. */
  subscribeChanges(listener) {
    this.snapshotListeners.add(listener);
    listener(this.getSnapshots());
    return () => this.snapshotListeners.delete(listener);
  }
  /**
   * Adopt records created or advanced by another process after this manager was
   * constructed. Recovery re-verifies durable process identity before any
   * lifecycle transition; callers receive the refreshed immutable projection.
   */
  refreshSnapshotsFromStore() {
    if (this.detached) return this.getSnapshots();
    for (const snapshot of this.store.loadAll()) {
      const previous = this.tasks.get(snapshot.id);
      if (previous?.revision === snapshot.revision) continue;
      this.adopt(snapshot, false);
      this.recover(snapshot);
    }
    return this.getSnapshots();
  }
  getSnapshots() {
    const snapshots = [...this.tasks.values()];
    const replayed = snapshots.filter((snapshot) => !isTerminalTaskSettled(snapshot.status));
    const settledByOwner = /* @__PURE__ */ new Map();
    for (const snapshot of snapshots) {
      if (!isTerminalTaskSettled(snapshot.status)) continue;
      const owned = settledByOwner.get(snapshot.ownerSessionId) ?? [];
      owned.push(snapshot);
      settledByOwner.set(snapshot.ownerSessionId, owned);
    }
    for (const owned of settledByOwner.values()) {
      replayed.push(...owned.sort((left, right) => (right.settledAt ?? right.updatedAt) - (left.settledAt ?? left.updatedAt)).slice(0, MAX_REPLAYED_SETTLED_TERMINALS));
    }
    return replayed.sort((left, right) => left.createdAt - right.createdAt).map(immutableTerminalSnapshot);
  }
  getOutput(task, maxBytes = CHECK_OUTPUT_BYTES) {
    return readLogTail(this.store, task.logFile, maxBytes);
  }
  /** Raw tail for UTF-8-safe durable Activity projection during concurrent appends. */
  getOutputTailBytes(task, maxBytes = CHECK_OUTPUT_BYTES) {
    return readLogTailBytes(this.store, task.logFile, maxBytes);
  }
  getOutputBytes(task, maxBytes = CHECK_OUTPUT_BYTES) {
    return this.getOutputTailBytes(task, maxBytes).bytes;
  }
  async stopOwned(ownerSessionId2) {
    const running = this.store.listOwned(ownerSessionId2).filter((task) => !isTerminalTaskSettled(task.status));
    return this.stop(running.map((task) => task.id), ownerSessionId2);
  }
  detach() {
    if (this.detached) return;
    this.detached = true;
    for (const runtime of this.runtime.values()) {
      if (runtime.pollTimer) clearInterval(runtime.pollTimer);
      runtime.pollTimer = void 0;
    }
    this.listeners.clear();
    this.snapshotListeners.clear();
  }
  recover(snapshot) {
    if (isTerminalTaskSettled(snapshot.status)) {
      capSettledLog(this.store, snapshot.logFile, this.logMaxBytes);
      return;
    }
    if (snapshot.status === "starting") {
      this.arm(snapshot.id);
      this.scheduleReconcile(snapshot.id);
      return;
    }
    const paths = taskPaths(this.store, snapshot.id, snapshot.createdAt);
    if (snapshot.status === "running") {
      try {
        createPrivateFile(this.store, paths.launchFile, "recovered\n");
      } catch (error) {
        if (!(error instanceof Error) || !errnoIs(error, "EEXIST")) {
          this.diagnostic(snapshot.id, `unable to release recovered launch gate: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    this.arm(snapshot.id);
    this.scheduleReconcile(snapshot.id);
  }
  ensureRuntime(task) {
    let runtime = this.runtime.get(task.id);
    if (!runtime) {
      runtime = { lastTreeVerificationAt: Number.NEGATIVE_INFINITY };
      this.runtime.set(task.id, runtime);
    }
    return runtime;
  }
  arm(id) {
    if (this.detached) return;
    const task = this.tasks.get(id) ?? this.store.get(id);
    if (!task || isTerminalTaskSettled(task.status)) return;
    const runtime = this.ensureRuntime(task);
    if (runtime.pollTimer) return;
    runtime.pollTimer = setInterval(() => this.scheduleReconcile(id), this.pollIntervalMs);
    runtime.pollTimer.unref?.();
  }
  scheduleReconcile(id) {
    if (this.detached) return;
    const task = this.tasks.get(id) ?? this.store.get(id);
    if (!task) return;
    const runtime = this.ensureRuntime(task);
    if (runtime.reconcilePromise) return;
    runtime.reconcilePromise = this.reconcile(id).catch((error) => this.diagnostic(id, `reconciliation failed safely: ${error instanceof Error ? error.message : String(error)}`)).finally(() => {
      runtime.reconcilePromise = void 0;
    });
  }
  async reconcile(id) {
    if (this.detached) return;
    const current = this.store.get(id);
    if (!current) return;
    this.adopt(current, true);
    if (isTerminalTaskSettled(current.status)) {
      this.clearPoll(id);
      return;
    }
    const runtime = this.ensureRuntime(current);
    if (current.status === "starting") {
      if (this.now() - current.updatedAt >= this.startingRecoveryGraceMs) this.settleLost(id, null, true);
      return;
    }
    const identity = identityOf(current);
    if (!identity) {
      this.settleLost(id, null, true);
      return;
    }
    if (current.status === "stopping") {
      await this.recoverStopping(id, identity);
      return;
    }
    const paths = taskPaths(this.store, current.id, current.createdAt);
    const exitCode = readExitCode(this.store, paths.exitFile);
    if (exitCode !== void 0) {
      await this.finishNaturalCompletion(id, identity, exitCode);
      return;
    }
    if (this.now() - runtime.lastTreeVerificationAt < TREE_VERIFICATION_REFRESH_MS) return;
    runtime.lastTreeVerificationAt = this.now();
    const verification = this.processTree.captureTreeVerification?.(identity);
    if (verification) {
      runtime.treeVerification = verification;
      if (!sameTreeVerification(current.processTreeVerification, verification)) {
        this.mutate(id, (task) => task.status === "running" && !sameTreeVerification(task.processTreeVerification, verification) ? { ...task, processTreeVerification: verification, updatedAt: this.timestamp(task) } : void 0);
      }
      return;
    }
    const identityStatus = this.processTree.identityMatches(identity);
    if (identityStatus === "different" && this.store.get(id)?.status === "running") this.settleLost(id, null, false);
  }
  async finishNaturalCompletion(id, identity, exitCode) {
    let current = this.store.get(id);
    if (current?.status !== "running") return;
    if (this.processTree.isTreeEmpty(identity, current.processTreeVerification)) {
      this.settleNatural(id, exitCode);
      return;
    }
    const retainedVerification = current.processTreeVerification ?? this.runtime.get(id)?.treeVerification;
    let verification;
    let identityStatus = this.processTree.identityMatches(identity);
    if (identityStatus === "same") {
      verification = this.processTree.captureTreeVerification?.(identity) ?? retainedVerification;
    } else if (identityStatus === "unknown" && retainedVerification && this.processTree.verificationMatches) {
      identityStatus = this.processTree.verificationMatches(identity, retainedVerification);
      if (identityStatus === "same") verification = retainedVerification;
    }
    if (identityStatus === "different") {
      if (this.processTree.isTreeEmpty(identity, retainedVerification)) this.settleNatural(id, exitCode);
      else this.settleLost(id, exitCode, false);
      return;
    }
    if (identityStatus === "unknown" || this.processTree.captureTreeVerification && !verification) {
      this.diagnostic(id, "natural completion process-tree identity or member anchors are unverified; refusing tree signal");
      return;
    }
    if (verification && !sameTreeVerification(current.processTreeVerification, verification)) {
      current = this.mutate(id, (task) => task.status === "running" && !sameTreeVerification(task.processTreeVerification, verification) ? { ...task, processTreeVerification: verification, updatedAt: this.timestamp(task) } : void 0).snapshot;
      verification = current.processTreeVerification;
    }
    if (this.processTree.isTreeEmpty(identity, verification)) {
      this.settleNatural(id, exitCode);
      return;
    }
    const killed = await this.safeVerifiedSignal(identity, "SIGKILL", verification);
    const gone = killed.gone || killed.ok && await this.processTree.waitForTreeEmpty(identity, this.killGraceMs, verification);
    if (killed.ok && gone) {
      if (this.store.get(id)?.status === "running") this.settleNatural(id, exitCode);
      return;
    }
    if (killed.identityStatus === "different" && this.processTree.isTreeEmpty(identity, verification)) {
      this.settleNatural(id, exitCode);
      return;
    }
    this.diagnostic(id, `natural completion tree disposition unproven; refusing settlement: ${killed.error ?? "tree did not become empty"}`);
  }
  async recoverStopping(id, identity) {
    const current = this.store.get(id);
    if (this.processTree.isTreeEmpty(identity, current?.processTreeVerification)) {
      this.settleDisposedStop(id);
      return;
    }
    let verification = current?.processTreeVerification;
    let identityStatus = this.processTree.identityMatches(identity);
    if (identityStatus === "unknown" && verification && this.processTree.verificationMatches) {
      identityStatus = this.processTree.verificationMatches(identity, verification);
    }
    if (identityStatus === "different") {
      if (this.processTree.isTreeEmpty(identity, verification)) this.settleDisposedStop(id);
      else this.settleLost(id, null, false);
      return;
    }
    if (identityStatus === "unknown") {
      this.diagnostic(id, "persisted stopping task identity and descendant anchors are unknown; refusing recovery signal");
      return;
    }
    if (!verification) {
      verification = this.processTree.captureTreeVerification?.(identity);
      if (this.processTree.captureTreeVerification && !verification) {
        this.diagnostic(id, "persisted stopping task has no verifiable process-tree anchors; refusing recovery signal");
        return;
      }
      if (verification) {
        const persisted = this.mutate(id, (task) => task.status === "stopping" && !task.processTreeVerification ? { ...task, processTreeVerification: verification, updatedAt: this.timestamp(task) } : void 0).snapshot;
        verification = persisted.processTreeVerification;
      }
    }
    const term = await this.safeVerifiedSignal(identity, "SIGTERM", verification);
    await this.finishStop(id, identity, term, false, verification);
  }
  settleNatural(id, exitCode) {
    return this.settle(id, exitCode === 0 ? "completed" : "failed", exitCode, false);
  }
  settleLost(id, exitCode, suppress) {
    return this.settle(id, "lost", exitCode, suppress);
  }
  settle(id, status, exitCode, suppress) {
    const result = this.mutate(id, (task) => {
      if (isTerminalTaskSettled(task.status)) return void 0;
      const now = this.timestamp(task);
      return {
        ...task,
        status,
        updatedAt: now,
        settledAt: now,
        exitCode,
        observedAt: suppress ? now : void 0,
        consumedAt: suppress ? now : void 0,
        deliveryState: suppress ? "suppressed" : "pending",
        completionId: task.completionId ?? this.createCompletionId()
      };
    });
    if (isTerminalTaskSettled(result.snapshot.status)) {
      this.clearPoll(id);
      capSettledLog(this.store, result.snapshot.logFile, this.logMaxBytes);
    }
    return result.snapshot;
  }
  settleCancelled(id) {
    const result = this.mutate(id, (task) => {
      if (isTerminalTaskSettled(task.status)) return void 0;
      const now = this.timestamp(task);
      return {
        ...task,
        status: "cancelled",
        updatedAt: now,
        settledAt: now,
        exitCode: null,
        observedAt: task.observedAt ?? now,
        consumedAt: task.consumedAt ?? now,
        deliveryState: "suppressed",
        completionId: task.completionId ?? this.createCompletionId()
      };
    });
    if (result.snapshot.status === "cancelled") {
      this.clearPoll(id);
      capSettledLog(this.store, result.snapshot.logFile, this.logMaxBytes);
    }
    return result.snapshot;
  }
  observe(id, consume) {
    return this.mutate(id, (task) => {
      if (!isTerminalTaskSettled(task.status)) return void 0;
      const deliveryState = task.deliveryState === "pending" || task.deliveryState === "claimed" ? "suppressed" : task.deliveryState;
      const needsObservation = task.observedAt === void 0;
      const needsConsumption = consume && task.consumedAt === void 0;
      const needsSuppression = deliveryState !== task.deliveryState;
      if (!needsObservation && !needsConsumption && !needsSuppression) return void 0;
      const now = this.timestamp(task);
      return {
        ...task,
        updatedAt: now,
        observedAt: task.observedAt ?? now,
        consumedAt: consume ? task.consumedAt ?? now : task.consumedAt,
        deliveryState,
        deliveryClaimToken: void 0
      };
    }).snapshot;
  }
  async finishNaturalStop(id, identity, exitCode, signal, verification) {
    const gone = signal.gone || signal.ok && await this.processTree.waitForTreeEmpty(identity, this.killGraceMs, verification);
    if (!signal.ok || !gone) {
      if (!this.processTree.isTreeEmpty(identity, verification)) return this.handleStopSignalFailure(id, signal, false, true);
    }
    const settled = this.settleNatural(id, exitCode);
    const observed = this.observe(id, false);
    return {
      id,
      outcome: "already-settled",
      task: observed,
      output: this.getOutput(observed, WAIT_OUTPUT_BYTES),
      message: `Terminal ${id} completed before its stop signal with exit ${settled.exitCode ?? "unknown"}.`
    };
  }
  settleDisposedStop(id) {
    const current = this.store.get(id);
    if (!current) return { id, outcome: "failed", message: `Failed to settle terminal ${id}: durable record unavailable.` };
    const exitCode = readExitCode(this.store, taskPaths(this.store, current.id, current.createdAt).exitFile);
    if (exitCode !== void 0) {
      const settled = this.settleNatural(id, exitCode);
      const observed = this.observe(id, false);
      return {
        id,
        outcome: "already-settled",
        task: observed,
        output: this.getOutput(observed, WAIT_OUTPUT_BYTES),
        message: `Terminal ${id} completed before stop disposition with exit ${settled.exitCode ?? "unknown"}.`
      };
    }
    const cancelled2 = this.settleCancelled(id);
    return {
      id,
      outcome: "cancelled",
      task: cancelled2,
      output: this.getOutput(cancelled2, WAIT_OUTPUT_BYTES),
      message: `Cancelled terminal ${id}.`
    };
  }
  async finishStop(id, identity, termSignal, restoreOnFailure, verification) {
    if (!termSignal.ok && !termSignal.forceRequired) return this.handleStopSignalFailure(id, termSignal, restoreOnFailure);
    let empty = termSignal.ok && (termSignal.gone || await this.processTree.waitForTreeEmpty(identity, this.termGraceMs, verification));
    if (!empty) {
      const kill = await this.safeVerifiedSignal(identity, "SIGKILL", verification);
      if (!kill.ok) return this.handleStopSignalFailure(id, kill, false);
      empty = kill.gone || await this.processTree.waitForTreeEmpty(identity, this.killGraceMs, verification);
    }
    if (!empty) return this.failedStop(id, "process tree remains alive after SIGKILL", false);
    return this.settleDisposedStop(id);
  }
  handleStopSignalFailure(id, signal, restoreOnFailure, suppressOnSettlement = restoreOnFailure) {
    const current = this.store.get(id);
    const identity = current ? identityOf(current) : void 0;
    if (identity && this.processTree.isTreeEmpty(identity, current?.processTreeVerification)) {
      return this.settleDisposedStop(id);
    }
    if (signal.identityStatus === "different") {
      this.settleLost(id, null, false);
      const lost = suppressOnSettlement ? this.observe(id, false) : this.store.get(id);
      return { id, outcome: "failed", task: lost, message: `Terminal ${id} process identity changed; recorded lost without signalling.` };
    }
    const reason = signal.identityStatus === "unknown" ? "process identity could not be verified; refusing to signal" : signal.error ?? "process-tree signal failed";
    return this.failedStop(id, reason, restoreOnFailure);
  }
  failedStop(id, reason, restore) {
    const result = restore ? this.mutate(id, (task) => task.status === "stopping" ? { ...task, status: "running", updatedAt: this.timestamp(task) } : void 0).snapshot : this.store.get(id);
    if (result && !isTerminalTaskSettled(result.status)) this.arm(id);
    if (!restore) this.diagnostic(id, `persisted stop remains pending: ${reason}`);
    return { id, outcome: "failed", task: result, message: `Failed to stop terminal ${id}: ${reason}.` };
  }
  failUnlaunched(id, cause) {
    this.settleFailedLaunch(id);
    const current = this.store.get(id);
    if (current) appendPrivateFile(this.store, current.logFile, `
[spawn error] ${cause instanceof Error ? cause.message : String(cause)}
`);
  }
  settleFailedLaunch(id) {
    const result = this.mutate(id, (task) => {
      if (isTerminalTaskSettled(task.status)) return void 0;
      const now = this.timestamp(task);
      return {
        ...task,
        status: "failed",
        updatedAt: now,
        settledAt: now,
        exitCode: null,
        observedAt: now,
        consumedAt: now,
        deliveryState: "suppressed",
        completionId: task.completionId ?? this.createCompletionId()
      };
    });
    this.clearPoll(id);
    return result.snapshot;
  }
  async handleChildError(id, error) {
    if (this.detached) return;
    const current = this.store.get(id);
    if (!current || isTerminalTaskSettled(current.status)) return;
    this.adopt(current, false);
    const identity = identityOf(current);
    if (identity) {
      const identityStatus = this.processTree.identityMatches(identity);
      if (identityStatus === "different") {
        this.settleLost(id, null, false);
        return;
      }
      if (identityStatus === "unknown") {
        this.diagnostic(id, `child error left process tree unverifiable; refusing signal: ${error.message}`);
        return;
      }
      const terminated = await terminateProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
      if (!terminated) {
        this.diagnostic(id, `child error left process tree unverified: ${error.message}`);
        return;
      }
    }
    this.failUnlaunched(id, error);
  }
  mutate(id, update) {
    let latest = this.store.get(id);
    if (!latest) throw new Error(`Unknown terminal task ${id}`);
    for (let attempt = 0; attempt < MAX_TRANSITION_RETRIES; attempt += 1) {
      this.adopt(latest, false);
      const next = update(latest);
      if (!next) return { snapshot: latest, changed: false };
      try {
        const transitioned = this.store.transition(id, latest.revision, () => next);
        this.adopt(transitioned, true);
        return { snapshot: transitioned, changed: true };
      } catch (error) {
        if (!(error instanceof StaleTerminalTaskRevisionError)) throw error;
        const reloaded = this.store.get(id);
        if (!reloaded) throw new Error(`Terminal task ${id} disappeared during transition`);
        latest = reloaded;
      }
    }
    this.diagnostic(id, "abandoned transition after repeated stale revisions");
    const current = this.store.get(id) ?? latest;
    this.adopt(current, false);
    return { snapshot: current, changed: false };
  }
  adopt(snapshot, notify7) {
    const previous = this.tasks.get(snapshot.id);
    this.tasks.set(snapshot.id, snapshot);
    this.ensureRuntime(snapshot);
    if (!notify7 || previous?.revision === snapshot.revision) return;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
      }
    }
    if (this.snapshotListeners.size === 0) return;
    const snapshots = this.getSnapshots();
    for (const listener of this.snapshotListeners) {
      try {
        listener(snapshots);
      } catch {
      }
    }
  }
  clearPoll(id) {
    const runtime = this.runtime.get(id);
    if (!runtime?.pollTimer) return;
    clearInterval(runtime.pollTimer);
    runtime.pollTimer = void 0;
  }
  timestamp(task) {
    return Math.max(task.updatedAt, Math.max(1, Math.floor(this.now())));
  }
  async safeVerifiedSignal(identity, signal, verification) {
    try {
      return await signalVerifiedProcessTree(this.processTree, identity, signal, verification);
    } catch (error) {
      return { ok: false, gone: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  runGuarded(id, operation, run) {
    run().catch((error) => this.diagnostic(id, `${operation} failed safely: ${error instanceof Error ? error.message : String(error)}`));
  }
  diagnostic(id, message) {
    this.onDiagnostic?.({ kind: "manager", id, message });
  }
};

// src/background-tasks/background-task-tool.ts
var PROCESS_LIFECYCLE_KEY = /* @__PURE__ */ Symbol.for("@dhruvkelawala/sumocode/terminal-process-lifecycle");
function processLifecycle() {
  const global = globalThis;
  const lifecycle = global[PROCESS_LIFECYCLE_KEY] ??= {};
  lifecycle.ownerSessionIds ??= /* @__PURE__ */ new Set();
  lifecycle.activityWriterTokens ??= /* @__PURE__ */ new Map();
  return lifecycle;
}
function processOwnedTerminalSessionIds() {
  return [...processLifecycle().ownerSessionIds];
}
function claimProcessActivitySession(ownerSessionId2, token) {
  const lifecycle = processLifecycle();
  if (!lifecycle.ownerSessionIds.has(ownerSessionId2)) return false;
  const current = lifecycle.activityWriterTokens.get(ownerSessionId2);
  if (current !== void 0 && current !== token) return false;
  lifecycle.activityWriterTokens.set(ownerSessionId2, token);
  return true;
}
function releaseProcessActivitySession(ownerSessionId2, token) {
  const lifecycle = processLifecycle();
  if (lifecycle.activityWriterTokens.get(ownerSessionId2) === token) lifecycle.activityWriterTokens.delete(ownerSessionId2);
}
function installBackgroundTasks(pi, managerOptions = {}) {
  const manager = new TerminalTaskManager(managerOptions);
  const lifecycle = processLifecycle();
  pi.on("session_start", (_event, ctx) => {
    const ownerSessionId2 = ctx.sessionManager.getSessionId();
    if (ownerSessionId2) lifecycle.ownerSessionIds.add(ownerSessionId2);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "quit") {
      manager.detach();
      return;
    }
    const currentSessionId = ctx.sessionManager.getSessionId();
    if (currentSessionId) lifecycle.ownerSessionIds.add(currentSessionId);
    try {
      await Promise.all([...lifecycle.ownerSessionIds].map((ownerSessionId2) => manager.stopOwned(ownerSessionId2)));
    } finally {
      lifecycle.ownerSessionIds.clear();
      lifecycle.activityWriterTokens.clear();
      manager.detach();
    }
  });
  return manager;
}

// src/background-tasks/terminal-tools.ts
import { Type as Type4 } from "typebox";

// src/background-tasks/terminal-prompt.ts
var TERMINAL_TOOL_GUIDELINES = [
  "Use terminal_start for servers, watchers, long builds, and other non-interactive shell commands that should continue while you work; use bash for quick commands.",
  "terminal_start completion is passive by default and never triggers an agent turn. Use completion: wake only when the terminal result must resume work automatically.",
  "Use terminal_check for a non-blocking snapshot, terminal_wait for explicit bounded waiting, terminal_stop to cancel process trees, and terminal_list for a side-effect-free inventory.",
  "Managed terminals receive no stdin. Never use terminal_start for interactive commands, prompts, or terminal user interfaces."
];
var TERMINAL_TOOL_DESCRIPTIONS = {
  start: "Start a non-interactive shell command in a durable managed terminal and return its stable id immediately. Completion is passive unless completion is set to wake.",
  check: "Return one current or final immutable terminal snapshot and a bounded output tail without blocking. Observing settlement suppresses an unclaimed wake.",
  wait: "Wait for all requested terminal ids, or return settled and pending ids normally when the bounded timeout expires. Aborting cancels only this wait.",
  stop: "Signal every requested running terminal process tree, escalate after the grace period, and report cancellation only after each whole tree is gone.",
  list: "List current-session managed terminals newest first, including completion disposition, without observing or consuming them."
};
function bounded(value, maxChars) {
  const clean = sanitizeActivityText(value).trimEnd();
  if (clean.length <= maxChars) return clean;
  return `[output tail truncated]
${clean.slice(-maxChars)}`;
}
function elapsed(task, currentTime = Date.now()) {
  const end = task.settledAt ?? Math.max(task.updatedAt, currentTime);
  const milliseconds = Math.max(0, end - task.createdAt);
  if (milliseconds < 1e3) return `${milliseconds}ms`;
  const seconds = Math.floor(milliseconds / 1e3);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function describeTerminal(task) {
  const exit = task.exitCode === void 0 ? "" : ` \xB7 exit ${task.exitCode ?? "unknown"}`;
  return `${task.id} \xB7 ${task.status}${exit} \xB7 ${task.deliveryState} \xB7 ${elapsed(task)} \xB7 ${sanitizeActivityText(task.title)}`;
}
function buildStartResult(task) {
  return [
    `Started terminal ${task.id} \xB7 ${sanitizeActivityText(task.title)}.`,
    `status: ${task.status} \xB7 completion: ${task.completionPolicy} \xB7 pid: ${task.pid ?? "pending"}`,
    `cwd: ${sanitizeActivityText(task.cwd)}`,
    "stdin: unavailable \u2014 interactive commands will not work",
    `Full log: ${task.logFile}`
  ].join("\n");
}
function buildObservationResult(observation) {
  return [
    describeTerminal(observation.task),
    `cwd: ${sanitizeActivityText(observation.task.cwd)}`,
    `Full log: ${observation.task.logFile}`,
    "",
    "Output tail:",
    bounded(observation.output, 16 * 1024) || "(no output)"
  ].join("\n");
}
function buildWaitResult(result) {
  const sections = result.settled.map(buildObservationResult);
  const summary = [
    `settled: ${result.settled.map(({ task }) => task.id).join(", ") || "none"}`,
    `pending: ${result.pendingIds.join(", ") || "none"}`,
    `unknown: ${result.unknownIds.join(", ") || "none"}`,
    `timed out: ${result.timedOut ? "yes" : "no"}`
  ].join("\n");
  return [summary, ...sections].join("\n\n---\n\n");
}
function buildStopResult(results) {
  return results.map((result) => {
    const output = result.output ? `
${bounded(result.output, 8 * 1024)}` : "";
    return `${result.message}${output}`;
  }).join("\n\n");
}
function buildTerminalResultMessage(task, output) {
  return [
    `Terminal ${task.id} "${sanitizeActivityText(task.title)}" ${task.status}.`,
    `exit: ${task.exitCode ?? "unknown"} \xB7 elapsed: ${elapsed(task)} \xB7 cwd: ${sanitizeActivityText(task.cwd)}`,
    "",
    "Final output tail:",
    bounded(output, 8 * 1024) || "(no output)",
    "",
    `Full log: ${task.logFile}`
  ].join("\n");
}

// src/background-tasks/terminal-tools.ts
var DEFAULT_WAIT_TIMEOUT_MS = 3e4;
var MAX_WAIT_TIMEOUT_MS = 3e5;
var MAX_TERMINAL_IDS = 64;
var COMPLETION_OUTPUT_BYTES = 8 * 1024;
var StringEnum = (values, options) => {
  const schema = { type: "string", enum: [...values] };
  if (options?.description !== void 0) schema.description = options.description;
  return Type4.Unsafe(schema);
};
function makeToolResult(text, details) {
  return { content: [{ type: "text", text }], details };
}
function terminalActivityFromStopResult(manager, result) {
  if (!result.task) return void 0;
  return terminalActivitySnapshot(result.task, result.output ?? manager.getOutput(result.task, COMPLETION_OUTPUT_BYTES));
}
function sessionId(ctx) {
  const id = ctx.sessionManager.getSessionId();
  if (!id) throw new Error("Current Pi session has no stable session id");
  return id;
}
function isPayloadObject(value) {
  return typeof value === "object" && value !== null;
}
function isPayloadString(value) {
  return typeof value === "string";
}
function branchDetails(record) {
  return record.details ?? null;
}
function completionsFromContext(ctx) {
  const ids = /* @__PURE__ */ new Set();
  const receipts = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (!isPayloadObject(entry)) continue;
    let details;
    if (entry.type === "custom_message") details = branchDetails(entry);
    else if (entry.type === "message") {
      const message = entry.message;
      details = isPayloadObject(message) && message.role === "custom" ? branchDetails(message) : null;
    } else details = null;
    if (!isPayloadObject(details)) continue;
    const completionId = details.completionId;
    const claimToken = details.deliveryClaimToken;
    if (!isPayloadString(completionId)) continue;
    ids.add(completionId);
    if (isPayloadString(claimToken)) receipts.push({ completionId, claimToken });
  }
  return { ids, receipts };
}
function completionDetails(manager, task) {
  const output = sanitizeActivityText(manager.getOutput(task, COMPLETION_OUTPUT_BYTES)).slice(-COMPLETION_OUTPUT_BYTES);
  return {
    completionId: task.completionId,
    deliveryClaimToken: task.deliveryClaimToken,
    ownerSessionId: task.ownerSessionId,
    activity: terminalActivitySnapshot(task, output)
  };
}
var TerminalDeliveryCoordinator = class {
  constructor(pi, manager) {
    this.pi = pi;
    this.manager = manager;
    this.unsubscribe = manager.addChangeListener((task) => {
      if (task.ownerSessionId === this.active?.ownerSessionId) this.requestFlush();
    });
  }
  pi;
  manager;
  active;
  unsubscribe;
  retryTimer;
  flushQueued = false;
  flushing = false;
  bind(ctx) {
    this.active = { ownerSessionId: sessionId(ctx), ctx };
    this.safeReconcile(ctx);
    this.requestFlush();
  }
  touch(ctx) {
    if (this.active?.ownerSessionId !== sessionId(ctx)) return;
    this.active = { ownerSessionId: this.active.ownerSessionId, ctx };
    this.safeReconcile(ctx);
  }
  flushWhenIdle(ctx) {
    this.touch(ctx);
    if (this.active?.ownerSessionId === sessionId(ctx) && ctx.isIdle()) this.requestFlush();
  }
  unbind() {
    this.active = void 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = void 0;
  }
  dispose() {
    this.unbind();
    this.unsubscribe?.();
    this.unsubscribe = void 0;
  }
  reconcile(ctx) {
    const ownerSessionId2 = sessionId(ctx);
    this.manager.acknowledge(ownerSessionId2, completionsFromContext(ctx).receipts);
    const retryDelay = this.manager.getClaimRetryDelay(ownerSessionId2);
    if (retryDelay === void 0 && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = void 0;
    }
  }
  safeReconcile(ctx) {
    try {
      this.reconcile(ctx);
    } catch {
      this.scheduleLeaseRetry(50);
    }
  }
  requestFlush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      try {
        this.flush();
      } catch {
        this.scheduleLeaseRetry(50);
      }
    });
  }
  flush() {
    const active = this.active;
    if (!active || this.flushing || !active.ctx.isIdle()) return;
    this.flushing = true;
    try {
      this.reconcile(active.ctx);
      const claimed = this.manager.claimPending(active.ownerSessionId, true, 1).sort((left, right) => Number(left.completionPolicy === "wake") - Number(right.completionPolicy === "wake"));
      for (const task of claimed) {
        const current = this.manager.get(task.id, active.ownerSessionId);
        if (current?.deliveryState !== "claimed" || !current.deliveryClaimToken || current.completionId !== task.completionId || current.deliveryClaimToken !== task.deliveryClaimToken) continue;
        const observable = completionsFromContext(active.ctx);
        if (current.completionId && observable.ids.has(current.completionId)) {
          this.manager.acknowledge(active.ownerSessionId, [{
            completionId: current.completionId,
            claimToken: current.deliveryClaimToken
          }]);
          continue;
        }
        const details = completionDetails(this.manager, current);
        this.pi.sendMessage(
          {
            customType: "terminal-result",
            content: buildTerminalResultMessage(current, this.manager.getOutput(current, COMPLETION_OUTPUT_BYTES)),
            display: true,
            details
          },
          { deliverAs: "followUp", triggerTurn: current.completionPolicy === "wake" }
        );
        if (current.completionPolicy === "wake") break;
      }
      queueMicrotask(() => {
        if (this.active?.ownerSessionId !== active.ownerSessionId) return;
        this.safeReconcile(this.active.ctx);
      });
      const retryDelay = this.manager.getClaimRetryDelay(active.ownerSessionId);
      if (retryDelay !== void 0) this.scheduleLeaseRetry(retryDelay);
    } finally {
      this.flushing = false;
    }
  }
  scheduleLeaseRetry(delayMs) {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = void 0;
      this.requestFlush();
    }, Math.max(0, delayMs) + 10);
    this.retryTimer.unref?.();
  }
};
function installTerminalTools(pi, manager) {
  const coordinator = new TerminalDeliveryCoordinator(pi, manager);
  pi.registerTool({
    name: "terminal_start",
    label: "Terminal Start",
    description: TERMINAL_TOOL_DESCRIPTIONS.start,
    promptSnippet: "Start a durable non-interactive shell terminal that runs independently.",
    promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
    parameters: Type4.Object({
      command: Type4.String({ description: "Shell command to run without stdin." }),
      title: Type4.String({ description: "Short human-readable terminal title." }),
      working_dir: Type4.Optional(Type4.String({ description: "Working directory. Defaults to the current project directory." })),
      completion: Type4.Optional(StringEnum(["passive", "wake"], { description: "Completion disposition. Defaults to passive." }))
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      coordinator.touch(ctx);
      const task = await manager.start({
        ownerSessionId: sessionId(ctx),
        sourceId: toolCallId,
        command: params.command,
        cwd: params.working_dir ?? ctx.cwd,
        title: params.title,
        completionPolicy: params.completion ?? "passive"
      });
      return makeToolResult(buildStartResult(task), { task, activity: terminalActivitySnapshot(task, "") });
    }
  });
  pi.registerTool({
    name: "terminal_check",
    label: "Terminal Check",
    description: TERMINAL_TOOL_DESCRIPTIONS.check,
    promptSnippet: "Inspect one managed terminal without blocking.",
    promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
    parameters: Type4.Object({ id: Type4.String({ description: "Terminal id returned by terminal_start." }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      coordinator.touch(ctx);
      const observation = manager.check(params.id, sessionId(ctx));
      if (!observation) return makeToolResult(`Unknown terminal ${params.id}.`, { id: params.id, status: "unknown" });
      return makeToolResult(buildObservationResult(observation), {
        task: observation.task,
        activity: terminalActivitySnapshot(observation.task, observation.output)
      });
    }
  });
  pi.registerTool({
    name: "terminal_wait",
    label: "Terminal Wait",
    description: TERMINAL_TOOL_DESCRIPTIONS.wait,
    promptSnippet: "Wait for managed terminals with a bounded normal timeout result.",
    promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
    parameters: Type4.Object({
      ids: Type4.Array(Type4.String(), { minItems: 1, maxItems: MAX_TERMINAL_IDS, description: "Terminal ids to wait for." }),
      timeout_ms: Type4.Optional(Type4.Integer({ minimum: 0, maximum: MAX_WAIT_TIMEOUT_MS, description: "Wait timeout in milliseconds. Defaults to 30000." }))
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      coordinator.touch(ctx);
      const result = await manager.wait(params.ids, sessionId(ctx), params.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS, signal);
      return makeToolResult(buildWaitResult(result), {
        ...result,
        activities: result.settled.map(({ task, output }) => terminalActivitySnapshot(task, output))
      });
    }
  });
  pi.registerTool({
    name: "terminal_stop",
    label: "Terminal Stop",
    description: TERMINAL_TOOL_DESCRIPTIONS.stop,
    promptSnippet: "Stop one or more complete managed terminal process trees.",
    promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
    parameters: Type4.Object({
      ids: Type4.Array(Type4.String(), { minItems: 1, maxItems: MAX_TERMINAL_IDS, description: "Terminal ids to stop." })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      coordinator.touch(ctx);
      const results = await manager.stop(params.ids, sessionId(ctx));
      return makeToolResult(buildStopResult(results), {
        results,
        activities: results.map((result) => terminalActivityFromStopResult(manager, result)).filter((activity) => activity !== void 0)
      });
    }
  });
  pi.registerTool({
    name: "terminal_list",
    label: "Terminal List",
    description: TERMINAL_TOOL_DESCRIPTIONS.list,
    promptSnippet: "List current-session durable managed terminals and completion disposition.",
    promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
    parameters: Type4.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const tasks = manager.list(sessionId(ctx));
      return makeToolResult(
        tasks.length > 0 ? tasks.map(describeTerminal).join("\n") : "No terminals tracked for this session.",
        { tasks }
      );
    }
  });
  pi.on("session_start", (_event, ctx) => coordinator.bind(ctx));
  pi.on("agent_start", (_event, ctx) => coordinator.touch(ctx));
  pi.on("agent_end", (_event, ctx) => coordinator.flushWhenIdle(ctx));
  pi.on("agent_settled", (_event, ctx) => coordinator.flushWhenIdle(ctx));
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "custom") return;
    try {
      coordinator.reconcile(ctx);
    } catch {
    }
  });
  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit") coordinator.dispose();
    else coordinator.unbind();
  });
  return coordinator;
}

// src/activity/manager-bridge.ts
import { createHash as createHash2, randomUUID as randomUUID5 } from "node:crypto";

// src/activity/feed-publisher.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { existsSync as existsSync9, linkSync as linkSync2, readdirSync as readdirSync3, renameSync as renameSync5, rmSync as rmSync3 } from "node:fs";
import { basename as basename6, dirname as dirname10, join as join16 } from "node:path";

// src/activity/persistence.ts
import { createHash, randomUUID as randomUUID3 } from "node:crypto";
import {
  chmodSync as chmodSync3,
  closeSync as closeSync3,
  constants as constants3,
  fchmodSync as fchmodSync3,
  fsyncSync as fsyncSync2,
  fstatSync as fstatSync3,
  linkSync,
  lstatSync as lstatSync3,
  mkdirSync as mkdirSync8,
  openSync as openSync3,
  readFileSync as readFileSync13,
  readdirSync as readdirSync2,
  realpathSync as realpathSync3,
  renameSync as renameSync4,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync8
} from "node:fs";
import { homedir as homedir13 } from "node:os";
import { basename as basename5, dirname as dirname9, join as join15, resolve as resolve5 } from "node:path";
var ACTIVITY_SCHEMA_VERSION = 1;
var PRIVATE_ACTIVITY_DIRECTORY_MODE = 448;
var PRIVATE_ACTIVITY_FILE_MODE = 384;
var ACTIVITY_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
var ACTIVITY_FEED_MAX_BYTES = 64 * 1024 * 1024;
var ACTIVITY_UI_MAX_BYTES = 64 * 1024 * 1024;
var NO_FOLLOW3 = constants3.O_NOFOLLOW ?? 0;
function errorCode3(error) {
  const code = error.code;
  return code === void 0 || code === null ? void 0 : String(code);
}
function errorMatches2(error, code) {
  return error instanceof Error && errorCode3(error) === code;
}
function assertOwnedDirectory(path2) {
  const stat = lstatSync3(path2);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Activity state path is not a directory: ${path2}`);
  const uid = process.getuid?.();
  if (uid !== void 0 && stat.uid !== uid) {
    throw new Error(`Activity state path is owned by a different user: ${path2}`);
  }
}
function assertPrivateDirectory2(path2) {
  assertOwnedDirectory(path2);
  const stat = lstatSync3(path2);
  if (process.platform !== "win32" && (stat.mode & 511) !== PRIVATE_ACTIVITY_DIRECTORY_MODE) {
    throw new Error(`Activity state directory permissions must be 0700: ${path2}`);
  }
}
function ensureCanonicalBaseDirectory(path2) {
  let cursor = resolve5(path2);
  const missing = [];
  while (true) {
    try {
      const stat = lstatSync3(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Activity state path is not a directory: ${cursor}`);
      break;
    } catch (error) {
      if (!errorMatches2(error, "ENOENT")) throw error;
      missing.unshift(basename5(cursor));
      const parent = dirname9(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  let canonical = realpathSync3(cursor);
  for (const segment of missing) {
    const candidate = join15(canonical, segment);
    try {
      mkdirSync8(candidate, { mode: PRIVATE_ACTIVITY_DIRECTORY_MODE });
    } catch (error) {
      if (!errorMatches2(error, "EEXIST")) throw error;
    }
    assertOwnedDirectory(candidate);
    canonical = candidate;
  }
  assertOwnedDirectory(canonical);
  return canonical;
}
function ensurePrivateChildDirectory(parent, name) {
  assertPrivateDirectory2(parent);
  const candidate = join15(parent, name);
  try {
    mkdirSync8(candidate, { mode: PRIVATE_ACTIVITY_DIRECTORY_MODE });
  } catch (error) {
    if (!errorMatches2(error, "EEXIST")) throw error;
  }
  assertOwnedDirectory(candidate);
  chmodSync3(candidate, PRIVATE_ACTIVITY_DIRECTORY_MODE);
  assertPrivateDirectory2(candidate);
  return candidate;
}
function defaultActivityStateRoot(env = process.env) {
  if (env.SUMOCODE_STATE_DIR) return resolve5(env.SUMOCODE_STATE_DIR);
  const agentDir = env.PI_CODING_AGENT_DIR ?? join15(homedir13(), ".pi", "agent");
  return resolve5(agentDir, "state");
}
function ensurePrivateSumocodeDirectory(segments, rootDir = defaultActivityStateRoot()) {
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || basename5(segment) !== segment)) {
    throw new Error("SumoCode state directory segments must be simple names");
  }
  const base = ensureCanonicalBaseDirectory(rootDir);
  let root = base;
  for (const segment of ["sumocode", ...segments]) {
    try {
      mkdirSync8(join15(root, segment), { mode: PRIVATE_ACTIVITY_DIRECTORY_MODE });
    } catch (error) {
      if (!errorMatches2(error, "EEXIST")) throw error;
    }
    const candidate = join15(root, segment);
    assertOwnedDirectory(candidate);
    chmodSync3(candidate, PRIVATE_ACTIVITY_DIRECTORY_MODE);
    assertPrivateDirectory2(candidate);
    root = candidate;
  }
  return root;
}
function hashedSessionId(ownerSessionId2) {
  return createHash("sha256").update(ownerSessionId2, "utf8").digest("hex");
}
function ensureActivityRoot(rootDir = defaultActivityStateRoot()) {
  return ensurePrivateSumocodeDirectory(["activity", "v1"], rootDir);
}
function activityPaths(ownerSessionId2, rootDir = defaultActivityStateRoot()) {
  if (!ownerSessionId2.trim()) throw new Error("Activity state requires a non-empty owner session id");
  const root = ensureActivityRoot(rootDir);
  const directory = ensurePrivateChildDirectory(root, hashedSessionId(ownerSessionId2));
  return {
    directory,
    feedFile: join15(directory, "feed.json"),
    uiFile: join15(directory, "ui.json"),
    writerFile: join15(directory, "writer.json")
  };
}
function readPrivateJson(path2, maxBytes = ACTIVITY_DOCUMENT_MAX_BYTES) {
  let descriptor;
  try {
    const before = lstatSync3(path2);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Activity state file is not a regular file: ${path2}`);
    if (process.platform !== "win32" && (before.mode & 511) !== PRIVATE_ACTIVITY_FILE_MODE) {
      throw new Error(`Activity state file permissions must be 0600: ${path2}`);
    }
    descriptor = openSync3(path2, constants3.O_RDONLY | NO_FOLLOW3);
    const opened = fstatSync3(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Activity state file changed during read: ${path2}`);
    }
    if (opened.size > maxBytes) throw new Error(`Activity state file exceeds ${maxBytes} bytes: ${path2}`);
    return JSON.parse(readFileSync13(descriptor, "utf8"));
  } catch (error) {
    if (errorMatches2(error, "ENOENT")) return void 0;
    throw error;
  } finally {
    if (descriptor !== void 0) closeSync3(descriptor);
  }
}
function writePrivateJsonExclusive(path2, value) {
  const directory = dirname9(path2);
  assertPrivateDirectory2(directory);
  const temporary = join15(directory, `.${randomUUID3()}.claim`);
  let descriptor;
  try {
    descriptor = openSync3(temporary, constants3.O_WRONLY | constants3.O_CREAT | constants3.O_EXCL | NO_FOLLOW3, PRIVATE_ACTIVITY_FILE_MODE);
    fchmodSync3(descriptor, PRIVATE_ACTIVITY_FILE_MODE);
    writeFileSync8(descriptor, `${JSON.stringify(value, null, 2)}
`, "utf8");
    fsyncSync2(descriptor);
    closeSync3(descriptor);
    descriptor = void 0;
    linkSync(temporary, path2);
    try {
      const directoryDescriptor = openSync3(directory, constants3.O_RDONLY | NO_FOLLOW3);
      try {
        fsyncSync2(directoryDescriptor);
      } finally {
        closeSync3(directoryDescriptor);
      }
    } catch {
    }
  } finally {
    if (descriptor !== void 0) closeSync3(descriptor);
    try {
      unlinkSync2(temporary);
    } catch {
    }
  }
}
function atomicWritePrivateJson(path2, value) {
  const directory = dirname9(path2);
  assertPrivateDirectory2(directory);
  const temporary = join15(directory, `.${randomUUID3()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync3(temporary, constants3.O_WRONLY | constants3.O_CREAT | constants3.O_EXCL | NO_FOLLOW3, PRIVATE_ACTIVITY_FILE_MODE);
    fchmodSync3(descriptor, PRIVATE_ACTIVITY_FILE_MODE);
    writeFileSync8(descriptor, `${JSON.stringify(value, null, 2)}
`, "utf8");
    fsyncSync2(descriptor);
    closeSync3(descriptor);
    descriptor = void 0;
    renameSync4(temporary, path2);
    try {
      const directoryDescriptor = openSync3(directory, constants3.O_RDONLY | NO_FOLLOW3);
      try {
        fsyncSync2(directoryDescriptor);
      } finally {
        closeSync3(directoryDescriptor);
      }
    } catch {
    }
  } finally {
    if (descriptor !== void 0) closeSync3(descriptor);
    try {
      unlinkSync2(temporary);
    } catch {
    }
  }
}

// src/activity/feed-publisher.ts
var ACTIVITY_SETTLED_RETENTION_COUNT = 64;
var ACTIVITY_SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var ACTIVITY_WRITER_SCHEMA_VERSION = 1;
var MAX_ACTIVE_TOOLS = 16;
var MAX_TITLE_CHARS = 512;
var MAX_ID_CHARS = 512;
var MAX_SUBJECT_CHARS = 2 * 1024;
function isStringValue3(value) {
  return typeof value === "string";
}
function positiveInteger2(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isRecordLike2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function recordOf2(value) {
  return isRecordLike2(value) ? value : void 0;
}
function errorCode4(error) {
  const code = error.code;
  return code === void 0 || code === null ? void 0 : String(code);
}
function errorMatches3(error, code) {
  return error instanceof Error && errorCode4(error) === code;
}
function parseWriterIdentity(value) {
  const record = recordOf2(value);
  if (!record || record.schemaVersion !== ACTIVITY_WRITER_SCHEMA_VERSION || !isStringValue3(record.token) || !record.token || !positiveInteger2(record.pid) || !isStringValue3(record.processStartTime) || !record.processStartTime) return void 0;
  return { token: record.token, pid: record.pid, processStartTime: record.processStartTime };
}
function writerDocument(writer) {
  return { schemaVersion: ACTIVITY_WRITER_SCHEMA_VERSION, token: writer.token, pid: writer.pid, processStartTime: writer.processStartTime };
}
function sameWriter(left, right) {
  return left.token === right.token && left.pid === right.pid && left.processStartTime === right.processStartTime;
}
function sameWriterProcess(left, right) {
  return left.pid === right.pid && left.processStartTime === right.processStartTime;
}
function writerTakeoverPaths(writerFile) {
  const prefix = `${basename6(writerFile)}.takeover-`;
  try {
    return readdirSync3(dirname10(writerFile), { encoding: "utf8" }).filter((name) => name.startsWith(prefix)).map((name) => join16(dirname10(writerFile), name));
  } catch {
    return [];
  }
}
function readWriter(path2) {
  const value = readPrivateJson(path2, 16 * 1024);
  return value === void 0 ? void 0 : parseWriterIdentity(value);
}
function restoreTakeoverLease(path2, writerFile) {
  try {
    linkSync2(path2, writerFile);
  } catch (error) {
    if (!errorMatches3(error, "EEXIST")) throw error;
  }
  const canonical = readWriter(writerFile);
  if (canonical) rmSync3(path2, { force: true });
  return canonical;
}
function recoverOwnTakeover(writerFile, writer) {
  for (const path2 of writerTakeoverPaths(writerFile)) {
    const displaced = readWriter(path2);
    if (!displaced || !sameWriter(displaced, writer)) continue;
    restoreTakeoverLease(path2, writerFile);
    return;
  }
}
function claimWriter(writerFile, candidate, inspectWriter) {
  let abandonedWriterDeathProven = false;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let blockedByTakeover = false;
    for (const path2 of writerTakeoverPaths(writerFile)) {
      const writer = readWriter(path2);
      if (!writer) {
        blockedByTakeover = true;
        continue;
      }
      if (sameWriterProcess(writer, candidate)) {
        restoreTakeoverLease(path2, writerFile);
        continue;
      }
      if (inspectWriter(writer) !== "dead") {
        blockedByTakeover = true;
        continue;
      }
      abandonedWriterDeathProven = true;
      rmSync3(path2, { force: true });
    }
    if (blockedByTakeover) return { owned: false, writerDeathProven: false };
    let current;
    try {
      current = readWriter(writerFile);
    } catch {
      return { owned: false, writerDeathProven: false };
    }
    if (!current) {
      try {
        writePrivateJsonExclusive(writerFile, writerDocument(candidate));
        return { owned: true, writerDeathProven: abandonedWriterDeathProven };
      } catch (error) {
        if (errorMatches3(error, "EEXIST")) continue;
        throw error;
      }
    }
    if (sameWriter(current, candidate)) return { owned: true, writerDeathProven: false };
    const sameProcessHandoff = sameWriterProcess(current, candidate);
    const previousWriterDead = !sameProcessHandoff && inspectWriter(current) === "dead";
    if (!sameProcessHandoff && !previousWriterDead) return { owned: false, writerDeathProven: false };
    const takeover = `${writerFile}.takeover-${randomUUID4()}`;
    try {
      renameSync5(writerFile, takeover);
    } catch (error) {
      if (errorMatches3(error, "ENOENT")) continue;
      throw error;
    }
    const moved = readWriter(takeover);
    if (!moved || !sameWriter(moved, current)) {
      restoreTakeoverLease(takeover, writerFile);
      continue;
    }
    try {
      writePrivateJsonExclusive(writerFile, writerDocument(candidate));
      rmSync3(takeover, { force: true });
      return { owned: true, writerDeathProven: previousWriterDead || abandonedWriterDeathProven };
    } catch (error) {
      if (!errorMatches3(error, "EEXIST")) throw error;
    }
  }
  return { owned: false, writerDeathProven: false };
}
function redactActivitySecrets(text) {
  return sanitizeActivityText(text).replace(/-----BEGIN [^-\n]+PRIVATE KEY-----[\s\S]*?-----END [^-\n]+PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]").replace(/(?:^|\n)(?:(?:[A-Za-z0-9+/]{40,}={0,2})\n?){2,}/gu, "\n[REDACTED KEY MATERIAL]\n").replace(/\b((?:proxy-)?authorization\s*:)[^\n\r]*/giu, "$1 [REDACTED]").replace(/\b((?:set-cookie|cookie|[A-Za-z0-9-]*(?:api-key|token|secret|credential)[A-Za-z0-9-]*)\s*:)[^\n\r]*/giu, "$1 [REDACTED]").replace(/\b(?:bearer|basic)\s+[^\s"',;]+/giu, "[REDACTED AUTH]").replace(/\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key[_-]?id|access[_-]?token|auth[_-]?token|token|password|passwd|passphrase|credential|secret|private[_-]?key|client[_-]?secret|database[_-]?url|aws[_-]?secret[_-]?access[_-]?key)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu, "$1[REDACTED]").replace(/(\bcurl\b[^\n]*?(?:\s-u|\s--user))(?:\s+|=)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu, "$1 [REDACTED]").replace(/(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|passphrase|secret|credential|client[-_]?secret|private[-_]?key))(?:\s+|=)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu, "$1 [REDACTED]").replace(/\b((?:(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|passphrase|credential|secret|private[_-]?key|client[_-]?secret)|api\s+key|access\s+token|auth\s+token|client\s+secret|private\s+key))\s+(?:is\s+)?(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu, "$1 [REDACTED]").replace(/\b([A-Z][A-Z0-9_]{2,}\s*=\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gu, "$1[REDACTED]").replace(/\b(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu, "[REDACTED]").replace(/(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=]))(?=[A-Za-z0-9/+=]*[a-z])(?=[A-Za-z0-9/+=]*[A-Z])(?=[A-Za-z0-9/+=]*[0-9])[A-Za-z0-9/+=]{40}/gu, "[REDACTED POSSIBLE SECRET]").replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@");
}
function boundedHead(text, maxChars) {
  return Array.from(sanitizeActivityText(text)).slice(0, maxChars).join("");
}
function boundedSafeHead(text, maxChars) {
  return Array.from(redactActivitySecrets(text)).slice(0, maxChars).join("");
}
function sanitizeBody(body) {
  if (!body) return void 0;
  const text = boundedOutputTail(redactActivitySecrets(body.text));
  if (body.kind === "terminal") return { kind: "terminal", text };
  if (body.kind === "source") {
    const source = { kind: "source", text };
    if (body.startLine !== void 0) source.startLine = body.startLine;
    if (body.totalLines !== void 0) source.totalLines = body.totalLines;
    return source;
  }
  return { kind: body.kind, text };
}
function sanitizeActivityForFeed(activity, ownerSessionId2, depth = 0) {
  const activeTools = depth >= 4 ? void 0 : activity.activeTools?.slice(0, MAX_ACTIVE_TOOLS).map((child) => sanitizeActivityForFeed(child, ownerSessionId2, depth + 1));
  const outputTail = activity.outputTail === void 0 ? void 0 : boundedOutputTail(redactActivitySecrets(activity.outputTail));
  const body = sanitizeBody(activity.body);
  const summary = activity.result?.summary === void 0 ? void 0 : boundedOutputTail(redactActivitySecrets(activity.result.summary));
  const error = activity.result?.error === void 0 ? void 0 : boundedOutputTail(redactActivitySecrets(activity.result.error));
  const leading = {};
  if (activity.sourceId) leading.sourceId = boundedHead(activity.sourceId, MAX_ID_CHARS);
  const projected = {
    id: boundedHead(activity.id, MAX_ID_CHARS),
    ...leading,
    kind: activity.kind,
    title: boundedSafeHead(activity.title, MAX_TITLE_CHARS) || "activity",
    status: activity.status
  };
  if (activity.kind !== "terminal" && activity.subject !== void 0) projected.subject = boundedSafeHead(activity.subject, MAX_SUBJECT_CHARS);
  if (activity.currentStep !== void 0) projected.currentStep = boundedSafeHead(redactActivitySecrets(activity.currentStep), MAX_SUBJECT_CHARS);
  if (outputTail !== void 0) projected.outputTail = outputTail;
  if (body !== void 0) projected.body = body;
  if (activeTools && activeTools.length > 0) projected.activeTools = activeTools;
  if (summary !== void 0 || error !== void 0) {
    const resultSummary = {};
    if (summary !== void 0) resultSummary.summary = summary;
    if (error !== void 0) resultSummary.error = error;
    projected.result = resultSummary;
  }
  projected.ownerSessionId = ownerSessionId2;
  if (activity.createdAt !== void 0) projected.createdAt = activity.createdAt;
  if (activity.updatedAt !== void 0) projected.updatedAt = activity.updatedAt;
  if (activity.settledAt !== void 0) projected.settledAt = activity.settledAt;
  if (activity.model !== void 0) projected.model = boundedSafeHead(activity.model, 256);
  if (activity.thinking !== void 0) projected.thinking = boundedSafeHead(activity.thinking, 64);
  if (activity.metrics !== void 0) projected.metrics = { ...activity.metrics };
  return projected;
}
function parseActivityFeedDocument(value, expectedOwnerSessionId) {
  const record = recordOf2(value);
  if (!record || record.schemaVersion !== ACTIVITY_SCHEMA_VERSION || !isStringValue3(record.ownerSessionId) || !record.ownerSessionId || expectedOwnerSessionId !== void 0 && record.ownerSessionId !== expectedOwnerSessionId || !positiveInteger2(record.revision) || !positiveInteger2(record.updatedAt) || !Array.isArray(record.activities)) return void 0;
  const activities = [];
  for (const candidate of record.activities) {
    const activity = parseActivitySnapshot(candidate);
    if (!activity || activity.ownerSessionId !== record.ownerSessionId) return void 0;
    activities.push(sanitizeActivityForFeed(activity, record.ownerSessionId));
  }
  return {
    schemaVersion: ACTIVITY_SCHEMA_VERSION,
    ownerSessionId: record.ownerSessionId,
    revision: record.revision,
    updatedAt: record.updatedAt,
    activities
  };
}
function activityTime(activity) {
  return activity.settledAt ?? activity.updatedAt ?? activity.createdAt ?? 0;
}
function retainFeedActivities(activities, now = Date.now()) {
  const merged = /* @__PURE__ */ new Map();
  for (const activity of activities) {
    const existing = merged.get(activity.id);
    merged.set(activity.id, existing ? mergeActivitySnapshot(existing, activity) : activity);
  }
  const running = [...merged.values()].filter((activity) => !isSettledActivityStatus(activity.status));
  const settled = [...merged.values()].filter((activity) => isSettledActivityStatus(activity.status) && now - activityTime(activity) <= ACTIVITY_SETTLED_RETENTION_MS).sort((left, right) => activityTime(right) - activityTime(left)).slice(0, ACTIVITY_SETTLED_RETENTION_COUNT);
  return [...running, ...settled].sort((left, right) => {
    const time = (left.createdAt ?? 0) - (right.createdAt ?? 0);
    return time !== 0 ? time : left.id.localeCompare(right.id);
  });
}
function semanticActivities(activities) {
  return JSON.stringify(activities);
}
function feedDocumentBytes(document) {
  return Buffer.byteLength(`${JSON.stringify(document, null, 2)}
`, "utf8");
}
function budgetActivity(activity, maxOutputBytes, maxChildren, minimal = false) {
  const outputTail = maxOutputBytes > 0 && activity.outputTail ? boundedOutputTail(activity.outputTail, { maxBytes: maxOutputBytes }) : void 0;
  const activeTools = maxChildren > 0 ? activity.activeTools?.slice(0, maxChildren).map((child) => budgetActivity(child, maxOutputBytes, maxChildren, minimal)) : void 0;
  const leading = {};
  if (activity.sourceId) leading.sourceId = activity.sourceId;
  const budgeted = {
    id: activity.id,
    ...leading,
    kind: activity.kind,
    title: minimal ? boundedHead(activity.title, 128) : activity.title,
    status: activity.status
  };
  if (!minimal && activity.subject !== void 0) budgeted.subject = activity.subject;
  if (!minimal && activity.currentStep !== void 0) budgeted.currentStep = activity.currentStep;
  if (outputTail !== void 0) budgeted.outputTail = outputTail;
  if (activeTools && activeTools.length > 0) budgeted.activeTools = activeTools;
  if (!minimal && activity.result !== void 0) budgeted.result = activity.result;
  if (activity.ownerSessionId !== void 0) budgeted.ownerSessionId = activity.ownerSessionId;
  if (activity.createdAt !== void 0) budgeted.createdAt = activity.createdAt;
  if (activity.updatedAt !== void 0) budgeted.updatedAt = activity.updatedAt;
  if (activity.settledAt !== void 0) budgeted.settledAt = activity.settledAt;
  if (!minimal && activity.model !== void 0) budgeted.model = activity.model;
  if (!minimal && activity.thinking !== void 0) budgeted.thinking = activity.thinking;
  if (!minimal && activity.metrics !== void 0) budgeted.metrics = activity.metrics;
  return budgeted;
}
function fitFeedBudget(activities, ownerSessionId2, revision, updatedAt) {
  const fits = (candidate) => feedDocumentBytes({
    schemaVersion: ACTIVITY_SCHEMA_VERSION,
    ownerSessionId: ownerSessionId2,
    revision,
    updatedAt,
    activities: candidate
  }) <= ACTIVITY_DOCUMENT_MAX_BYTES;
  if (fits(activities)) return activities;
  for (const round2 of [
    { output: 8 * 1024, children: 8 },
    { output: 4 * 1024, children: 4 },
    { output: 2 * 1024, children: 2 },
    { output: 1 * 1024, children: 1 },
    { output: 256, children: 0 }
  ]) {
    const compacted = activities.map((activity) => budgetActivity(activity, round2.output, round2.children));
    if (fits(compacted)) return compacted;
  }
  const minimal = activities.map((activity) => budgetActivity(activity, 0, 0, true));
  if (fits(minimal)) return minimal;
  return minimal;
}
var ActivityFeedPublisher = class {
  constructor(ownerSessionId2, options = {}) {
    this.ownerSessionId = ownerSessionId2;
    this.rootDir = options.rootDir ?? defaultActivityStateRoot();
    this.now = options.now ?? Date.now;
    this.onDiagnostic = options.onDiagnostic;
    const paths = activityPaths(ownerSessionId2, this.rootDir);
    this.path = paths.feedFile;
    this.writerFile = paths.writerFile;
    this.writerIdentity = options.writerIdentity;
    this.unleasedWriterForTests = !this.writerIdentity && options.allowUnleasedWritesForTests === true;
    if (this.writerIdentity) {
      const claim = claimWriter(this.writerFile, this.writerIdentity, options.inspectWriter ?? (() => "unknown"));
      this.writerOwned = claim.owned;
      this.writerDeathProven = claim.writerDeathProven;
    } else {
      this.writerOwned = this.unleasedWriterForTests && !existsSync9(this.writerFile);
    }
    this.load();
    if (this.writerOwned && this.writerDeathProven) {
      for (const activity of this.activities) {
        if (activity.status === "queued" || activity.status === "running") this.abandonedRunningIds.add(activity.id);
      }
    }
  }
  ownerSessionId;
  rootDir;
  now;
  onDiagnostic;
  path;
  writerFile;
  writerIdentity;
  unleasedWriterForTests;
  writerOwned;
  writerDeathProven = false;
  abandonedRunningIds = /* @__PURE__ */ new Set();
  revision = 0;
  activities = [];
  publicationNeedsRepair = false;
  get hasWriterOwnership() {
    return this.writerOwned;
  }
  get canPublish() {
    return this.writerOwned;
  }
  /** Missing running records may be reconciled only after the former writer is proven dead. */
  get canReconcileAbandonedActivities() {
    return this.writerOwned && this.abandonedRunningIds.size > 0;
  }
  getAbandonedRunningIds() {
    return new Set(this.abandonedRunningIds);
  }
  /** Consume former-writer death proof only after replacement publication succeeds. */
  completeAbandonedReconciliation() {
    this.abandonedRunningIds.clear();
    this.writerDeathProven = false;
  }
  getSnapshot() {
    return this.activities.map((activity) => activity);
  }
  publish(activities) {
    if (this.writerIdentity && !existsSync9(this.writerFile)) recoverOwnTakeover(this.writerFile, this.writerIdentity);
    const currentWriter = this.writerIdentity ? readWriter(this.writerFile) : void 0;
    const fixtureLeaseWasClaimed = this.unleasedWriterForTests && existsSync9(this.writerFile);
    if (!this.writerOwned || fixtureLeaseWasClaimed || this.writerIdentity && (!currentWriter || !sameWriter(currentWriter, this.writerIdentity))) {
      this.writerOwned = false;
      throw new Error("Activity feed is owned by another live session writer");
    }
    const now = this.now();
    const retained = retainFeedActivities(
      activities.map((activity) => sanitizeActivityForFeed(activity, this.ownerSessionId)),
      now
    );
    const revision = this.revision + 1;
    const updatedAt = Math.max(1, Math.floor(now));
    const projected = fitFeedBudget(retained, this.ownerSessionId, revision, updatedAt);
    if (!this.publicationNeedsRepair && semanticActivities(projected) === semanticActivities(this.activities)) return false;
    const document = {
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      ownerSessionId: this.ownerSessionId,
      revision,
      updatedAt,
      activities: projected
    };
    if (feedDocumentBytes(document) > ACTIVITY_FEED_MAX_BYTES) {
      throw new Error(`Activity feed identity metadata exceeds ${ACTIVITY_FEED_MAX_BYTES} bytes`);
    }
    atomicWritePrivateJson(this.path, document);
    this.revision = revision;
    this.activities = projected;
    this.publicationNeedsRepair = false;
    return true;
  }
  load() {
    try {
      const value = readPrivateJson(this.path, ACTIVITY_FEED_MAX_BYTES);
      if (value === void 0) return;
      const record = recordOf2(value);
      if (record?.schemaVersion !== ACTIVITY_SCHEMA_VERSION) {
        this.publicationNeedsRepair = true;
        this.diagnostic("schema", `unknown activity feed schema ${String(record?.schemaVersion)}`);
        return;
      }
      const document = parseActivityFeedDocument(value, this.ownerSessionId);
      if (!document) {
        this.publicationNeedsRepair = true;
        this.diagnostic("corrupt", "invalid activity feed document");
        return;
      }
      this.revision = document.revision;
      this.activities = document.activities;
    } catch (error) {
      this.publicationNeedsRepair = true;
      this.diagnostic("io", error instanceof Error ? error.message : String(error));
    }
  }
  diagnostic(kind, message) {
    this.onDiagnostic?.({ kind, path: this.path, message });
  }
};

// src/activity/adapter-bounds.ts
function createAdapterTraversalBudget(options) {
  return {
    remainingNodes: Math.max(1, Math.floor(options.maxNodes)),
    remainingChars: Math.max(1, Math.floor(options.maxChars))
  };
}
function claimNode(budget) {
  if (budget.remainingNodes <= 0) return false;
  budget.remainingNodes -= 1;
  return true;
}
function isRecordLike3(value) {
  return typeof value === "object" && value !== null;
}
function boundedRecord(value, budget) {
  if (!isRecordLike3(value) || !claimNode(budget)) return void 0;
  return value;
}
function boundedPriorityArray(value, maxItems, budget, isPreferred) {
  if (!Array.isArray(value) || !claimNode(budget)) return [];
  const count = Math.max(0, Math.floor(maxItems));
  if (count === 0) return [];
  if (value.length <= count) return value.map((entry, originalIndex) => ({ value: entry, originalIndex }));
  const scanCount = count * 16;
  const headCount = Math.min(count, value.length);
  const tailStart = Math.max(headCount, value.length - Math.max(0, scanCount - headCount));
  const preferred = [];
  const settled = [];
  const inspect = (originalIndex) => {
    const entry = { value: value[originalIndex], originalIndex };
    const candidates = isPreferred(entry.value) ? preferred : settled;
    candidates.push(entry);
    if (candidates.length > count) candidates.shift();
  };
  for (let originalIndex = 0; originalIndex < headCount; originalIndex += 1) inspect(originalIndex);
  for (let originalIndex = tailStart; originalIndex < value.length; originalIndex += 1) inspect(originalIndex);
  const remaining = count - preferred.length;
  const selectedSettled = remaining > 0 ? settled.slice(-remaining).reverse() : [];
  return [...preferred, ...selectedSettled];
}
function isStringValue4(value) {
  return typeof value === "string";
}
function boundedAdapterText(value, maxChars, budget) {
  if (!isStringValue4(value) || budget.remainingChars <= 0) return void 0;
  const outputMax = Math.max(1, Math.floor(maxChars));
  const inspectedChars = Math.min(value.length, outputMax, budget.remainingChars);
  budget.remainingChars -= inspectedChars;
  const sanitized = sanitizeActivityText(value.slice(0, inspectedChars));
  const truncated = value.length > inspectedChars || sanitized.length > outputMax;
  if (!truncated) return sanitized;
  return `${sanitized.slice(0, Math.max(0, outputMax - 1))}\u2026`;
}
function firstBoundedAdapterString(budget, maxChars, ...values) {
  for (const value of values) {
    const text = boundedAdapterText(value, maxChars, budget)?.trim();
    if (text) return text;
  }
  return void 0;
}

// src/activity/pi-projector.ts
var MAX_SUBJECT_CHARS2 = 2 * 1024;
var MAX_COMMAND_CHARS = 4 * 1024;
var MAX_INVOCATION_CHARS = 4 * 1024;
var MAX_SOURCE_INSPECT_CHARS = ACTIVITY_OUTPUT_MAX_BYTES * 4;

// src/activity/subagent-adapter.ts
var TEXT_MAX = 16 * 1024;
var PROMPT_MAX = 8 * 1024;
var CHILD_PREVIEW_MAX = 1024;
var MAX_CHILD_TOOLS = 16;
var ADAPTER_MAX_NODES = 16384;
var ADAPTER_MAX_CHARS = 1024 * 1024;
var OPERATION_CORE_MAX_CHARS = 4 * 1024;
var OPERATION_OPTIONAL_MAX_CHARS = 8 * 1024;
var OPERATION_SNAPSHOT_MAX_CHARS = 32 * 1024;
function asRecord2(value, budget) {
  return boundedRecord(value, budget);
}
function boundedText2(value, maxChars = TEXT_MAX) {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}\u2026`;
}
function firstString(budget, ...values) {
  return firstBoundedAdapterString(budget, TEXT_MAX, ...values);
}
function isNumberValue3(value) {
  return typeof value === "number";
}
function numberFrom(value) {
  return isNumberValue3(value) && Number.isFinite(value) ? value : void 0;
}
function isRecordLike4(value) {
  return typeof value === "object" && value !== null;
}
function paneId(pane, budget) {
  return firstString(budget, pane?.paneId, pane?.tabId, pane?.workspaceId);
}
function isUnfinishedToolValue(value) {
  return isRecordLike4(value) && value.done !== true;
}
function subagentStatus(record, budget) {
  const status = firstString(budget, record.status)?.toLowerCase();
  const manifestExit = firstString(budget, asRecord2(record.manifest, budget)?.exit)?.toLowerCase();
  const error = firstString(budget, record.errorText)?.toLowerCase();
  if (manifestExit === "interrupted" || error === "interrupted" || status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "queued") return "queued";
  if (status === "done" || status === "completed" || status === "success" || status === "succeeded") return "succeeded";
  if (status === "error" || status === "failed" || manifestExit === "failed") return "failed";
  return "running";
}
function toolActivity(toolValue, budget, parentId, originalIndex) {
  const tool = asRecord2(toolValue, budget);
  if (!tool) return void 0;
  const name = firstString(budget, tool.name) ?? "tool";
  const id = firstString(budget, tool.id) ?? `${parentId}:tool:${name}:${originalIndex}`;
  const done = tool.done === true;
  const isError = tool.isError === true;
  const rawOutput = firstString(budget, tool.outputPreview);
  const rawArgs = firstString(budget, tool.argsPreview);
  const output = rawOutput ? boundedText2(rawOutput, CHILD_PREVIEW_MAX) : void 0;
  const args = rawArgs ? boundedText2(rawArgs, CHILD_PREVIEW_MAX) : void 0;
  const projected = {
    id,
    kind: "tool",
    title: name,
    status: done ? isError ? "failed" : "succeeded" : "running"
  };
  if (args) projected.invocation = args;
  if (output) projected.outputTail = output;
  if (done && (output || isError)) {
    const resultSummary = {};
    if (output) resultSummary.summary = output;
    if (isError) resultSummary.error = output ?? `${name} failed`;
    projected.result = resultSummary;
  }
  return projected;
}
function invocationFromSubagent(record, budget) {
  const pane = asRecord2(record.pane, budget);
  const worktree = asRecord2(record.worktree, budget);
  const prompt = firstString(budget, record.prompt) ?? "subagent";
  const cwd = firstString(budget, record.cwd);
  const baseRef = firstString(budget, record.baseRef);
  const agentName = firstString(budget, pane?.agentName);
  const workspaceId = firstString(budget, pane?.workspaceId);
  const tabId = firstString(budget, pane?.tabId);
  const paneRef = firstString(budget, pane?.paneId);
  const worktreePath = firstString(budget, worktree?.path);
  const worktreeBranch = firstString(budget, worktree?.branch);
  const worktreeBaseRef = firstString(budget, worktree?.baseRef);
  const invocation = { prompt: boundedText2(prompt, PROMPT_MAX) };
  if (cwd) invocation.cwd = cwd;
  if (baseRef) invocation.baseRef = baseRef;
  if (record.visible === true) invocation.visible = true;
  if (pane) {
    const projectedPane = {};
    if (agentName) projectedPane.agentName = agentName;
    if (workspaceId) projectedPane.workspaceId = workspaceId;
    if (tabId) projectedPane.tabId = tabId;
    if (paneRef) projectedPane.paneId = paneRef;
    invocation.pane = projectedPane;
  }
  if (worktree) {
    const projectedWorktree = {};
    if (worktreePath) projectedWorktree.path = worktreePath;
    if (worktreeBranch) projectedWorktree.branch = worktreeBranch;
    if (worktreeBaseRef) projectedWorktree.baseRef = worktreeBaseRef;
    invocation.worktree = projectedWorktree;
  }
  return invocation;
}
function activityFromSubagentRecord(record, budget) {
  const id = firstString(budget, record.id) ?? "unknown";
  const pane = asRecord2(record.pane, budget);
  const worktree = asRecord2(record.worktree, budget);
  const status = subagentStatus(record, budget);
  const liveText = firstString(budget, record.liveText);
  const finalText = firstString(budget, record.finalText);
  const output = status === "running" ? liveText ?? finalText : void 0;
  const error = status === "failed" || status === "cancelled" ? firstString(budget, record.errorText) : void 0;
  const summary = status === "succeeded" || status === "failed" || status === "cancelled" ? finalText : void 0;
  const liveTools = boundedPriorityArray(record.liveTools, MAX_CHILD_TOOLS, budget, isUnfinishedToolValue).map(({ value, originalIndex }) => toolActivity(value, budget, `subagent:${id}`, originalIndex)).filter((tool) => tool !== void 0);
  const usage = asRecord2(record.usage, budget);
  const manifest = asRecord2(record.manifest, budget);
  const createdAt = numberFrom(record.createdAt);
  const settledAt = numberFrom(record.settledAt);
  const explicitElapsed = numberFrom(manifest?.durationMs);
  const elapsedMs = explicitElapsed ?? (createdAt !== void 0 && settledAt !== void 0 ? Math.max(0, settledAt - createdAt) : void 0);
  const tokens = numberFrom(usage?.tokens);
  const contextWindow = numberFrom(usage?.contextWindow);
  const costUsd = numberFrom(usage?.costUsd);
  const turns = numberFrom(usage?.turns);
  let metrics;
  if ([tokens, contextWindow, costUsd, turns, elapsedMs].some((value) => value !== void 0 && value > 0)) {
    const parsedMetrics = {};
    if (tokens !== void 0 && tokens > 0) parsedMetrics.tokens = tokens;
    if (contextWindow !== void 0 && contextWindow > 0) parsedMetrics.contextWindow = contextWindow;
    if (costUsd !== void 0 && costUsd > 0) parsedMetrics.costUsd = costUsd;
    if (turns !== void 0 && turns > 0) parsedMetrics.turns = turns;
    if (elapsedMs !== void 0 && elapsedMs > 0) parsedMetrics.elapsedMs = elapsedMs;
    metrics = parsedMetrics;
  }
  const paneLabel = paneId(pane, budget);
  const branch = firstString(budget, worktree?.branch);
  const subject = [id, paneLabel ? `pane ${paneLabel}` : void 0, branch].filter((part) => !!part).join(" \xB7 ");
  const outputLastLine = output?.split("\n").filter((line) => line.trim().length > 0).at(-1);
  const currentStep = status === "running" ? outputLastLine ? boundedText2(outputLastLine.trim(), 256) : paneLabel ? `pane ${paneLabel} \xB7 running` : void 0 : void 0;
  const title = firstString(budget, record.title) ?? "subagent";
  const sourceId = firstString(budget, record.sourceId);
  const model = firstString(budget, record.modelLabel);
  const thinking2 = firstString(budget, record.thinkingLabel);
  const leadingOptionals = {};
  if (sourceId) leadingOptionals.sourceId = sourceId;
  const activity = {
    // Plan 082's canonical manager identity remains subagent:<sa-id>;
    // sourceId carries the spawn-call correlation through manager/feed updates.
    id: `subagent:${id}`,
    ...leadingOptionals,
    kind: "subagent",
    title,
    status,
    invocation: invocationFromSubagent(record, budget),
    subject
  };
  if (currentStep) activity.currentStep = currentStep;
  if (output) activity.outputTail = boundedText2(output);
  if (liveTools.length > 0) activity.activeTools = liveTools;
  if (summary || error) {
    const resultSummary = {};
    if (summary) resultSummary.summary = boundedText2(summary);
    if (error) resultSummary.error = boundedText2(error);
    activity.result = resultSummary;
  }
  if (createdAt !== void 0) activity.createdAt = createdAt;
  if (settledAt !== void 0) activity.settledAt = settledAt;
  if (model) activity.model = model;
  if (thinking2) activity.thinking = thinking2;
  if (metrics) activity.metrics = metrics;
  return activity;
}
function activityFromSubagentSnapshot(snapshot) {
  const budget = createAdapterTraversalBudget({ maxNodes: ADAPTER_MAX_NODES, maxChars: ADAPTER_MAX_CHARS });
  const loose = snapshot;
  return activityFromSubagentRecord(loose, budget);
}

// src/activity/manager-bridge.ts
var DEFAULT_SUBAGENT_DEBOUNCE_MS = 50;
var DEFAULT_TERMINAL_OUTPUT_POLL_MS = 250;
var DEFAULT_RETENTION_POLL_MS = 60 * 60 * 1e3;
var TERMINAL_REDACTION_CONTEXT_BYTES = 64 * 1024;
function ownerSessionId(ctx) {
  return ctx.sessionManager.getSessionId() || void 0;
}
function errorCode5(error) {
  const code = error.code;
  return code === void 0 || code === null ? void 0 : String(code);
}
function errorMatches4(cause, code) {
  return cause instanceof Error && errorCode5(cause) === code;
}
function inspectProcessWriter(writer) {
  try {
    process.kill(writer.pid, 0);
  } catch (error) {
    if (errorMatches4(error, "ESRCH")) return "dead";
    if (!errorMatches4(error, "EPERM")) return "unknown";
  }
  const actualStartTime = captureProcessBirthTime(writer.pid);
  if (actualStartTime === writer.processStartTime) return "alive";
  return actualStartTime === void 0 ? "unknown" : "dead";
}
function localSessionOwnership() {
  const owned = /* @__PURE__ */ new Set();
  const claims = /* @__PURE__ */ new Map();
  return {
    ownedSessionIds: () => [...owned],
    claim(owner, token) {
      const current = claims.get(owner);
      if (current !== void 0 && current !== token) return false;
      claims.set(owner, token);
      return true;
    },
    release(owner, token) {
      if (claims.get(owner) === token) claims.delete(owner);
    },
    noteOwnedSession: (owner) => owned.add(owner)
  };
}
var PROCESS_SESSION_OWNERSHIP = {
  ownedSessionIds: processOwnedTerminalSessionIds,
  claim: claimProcessActivitySession,
  release: releaseProcessActivitySession
};
function durableSubagentActivity(snapshot, retained) {
  const activity = activityFromSubagentSnapshot(snapshot);
  const established = retained.find((candidate) => candidate.kind === "subagent" && (activity.sourceId !== void 0 ? candidate.sourceId === activity.sourceId : candidate.sourceId === void 0 && activity.createdAt !== void 0 && candidate.createdAt === activity.createdAt));
  if (established) return { ...activity, id: established.id };
  const reused = retained.find((candidate) => candidate.id === activity.id && (candidate.createdAt !== void 0 && candidate.createdAt !== activity.createdAt || candidate.sourceId !== void 0 && activity.sourceId !== void 0 && candidate.sourceId !== activity.sourceId));
  if (!reused) return activity;
  const durableSuffix = activity.sourceId ? createHash2("sha256").update(activity.sourceId, "utf8").digest("hex").slice(0, 12) : Math.max(1, Math.floor(snapshot.createdAt)).toString(36);
  return { ...activity, id: `${activity.id}:${durableSuffix}` };
}
function lostActivity(activity, message, now) {
  return {
    ...activity,
    status: "lost",
    updatedAt: Math.max(activity.updatedAt ?? 0, now),
    settledAt: activity.settledAt ?? now,
    result: { ...activity.result, error: activity.result?.error ?? message }
  };
}
var ActivityManagerBridge = class {
  terminalManager;
  subagentManager;
  now;
  subagentDebounceMs;
  terminalOutputPollMs;
  retentionPollMs;
  onDiagnostic;
  publisherFactory;
  sessionOwnership;
  writerVerifiable;
  bridgeToken = randomUUID5();
  claimedOwners = /* @__PURE__ */ new Set();
  publishers = /* @__PURE__ */ new Map();
  terminalSnapshots = [];
  terminalOutputCache = /* @__PURE__ */ new Map();
  subagentOwnerSessionId;
  terminalUnsubscribe;
  subagentUnsubscribe;
  subagentTimer;
  terminalOutputTimer;
  retentionTimer;
  disposed = false;
  constructor(terminalManager, subagentManager, options = {}) {
    this.terminalManager = terminalManager;
    this.subagentManager = subagentManager;
    this.now = options.now ?? Date.now;
    this.subagentDebounceMs = Math.max(1, Math.floor(options.subagentDebounceMs ?? DEFAULT_SUBAGENT_DEBOUNCE_MS));
    this.terminalOutputPollMs = Math.max(10, Math.floor(options.terminalOutputPollMs ?? DEFAULT_TERMINAL_OUTPUT_POLL_MS));
    this.retentionPollMs = Math.max(10, Math.floor(options.retentionPollMs ?? DEFAULT_RETENTION_POLL_MS));
    this.onDiagnostic = options.onDiagnostic;
    this.sessionOwnership = options.sessionOwnership ?? localSessionOwnership();
    const processStartTime = captureProcessBirthTime(process.pid);
    const writerIdentity = options.writerIdentity ?? (processStartTime ? {
      token: this.bridgeToken,
      pid: process.pid,
      processStartTime
    } : void 0);
    this.writerVerifiable = writerIdentity !== void 0 || options.publisherFactory !== void 0;
    const publisherOptions = {
      rootDir: options.rootDir,
      now: this.now,
      onDiagnostic: options.onDiagnostic,
      writerIdentity,
      inspectWriter: options.inspectWriter ?? inspectProcessWriter
    };
    this.publisherFactory = options.publisherFactory ?? ((owner) => new ActivityFeedPublisher(owner, publisherOptions));
    if (!writerIdentity && !options.publisherFactory) {
      this.diagnostic({ kind: "io", path: "activity-writer", message: "current process start identity is not verifiable; feed publication disabled" });
    }
    this.terminalUnsubscribe = terminalManager.subscribeChanges((snapshots) => {
      if (this.disposed) return;
      this.adoptTerminalSnapshots(snapshots);
      this.publishAll();
      this.syncTerminalOutputPoll();
    });
    this.subagentUnsubscribe = subagentManager.addChangeListener(() => this.scheduleSubagentPublish());
    this.retentionTimer = setInterval(() => this.publishAll(), this.retentionPollMs);
    this.retentionTimer.unref?.();
  }
  bindSession(owner) {
    if (this.disposed) return;
    this.subagentOwnerSessionId = owner;
    if (owner) this.sessionOwnership.noteOwnedSession?.(owner);
    this.syncOwnedSessions();
    this.publishAll();
    logDiagnostic("activity_bridge_bound", { ownerSessionId: owner ?? null, claimedOwnerSessionIds: [...this.claimedOwners] });
  }
  /** Block execution only when another live process owns the feed writer name. */
  canProduceActivity(owner) {
    if (!owner || this.disposed) return false;
    this.syncOwnedSessions();
    const publisher = this.publishers.get(owner);
    return this.claimedOwners.has(owner) && publisher?.hasWriterOwnership === true;
  }
  /** Publish final non-reattachable subagent truth before this factory dies. */
  shutdownSession(owner) {
    if (this.disposed) return;
    if (owner) {
      this.subagentOwnerSessionId = owner;
      this.publishOwner(owner, true);
    }
    this.dispose();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.terminalUnsubscribe?.();
    this.terminalUnsubscribe = void 0;
    this.subagentUnsubscribe?.();
    this.subagentUnsubscribe = void 0;
    if (this.subagentTimer) clearTimeout(this.subagentTimer);
    this.subagentTimer = void 0;
    if (this.terminalOutputTimer) clearInterval(this.terminalOutputTimer);
    this.terminalOutputTimer = void 0;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = void 0;
    this.terminalOutputCache.clear();
    for (const owner of this.claimedOwners) this.sessionOwnership.release(owner, this.bridgeToken);
    this.claimedOwners.clear();
  }
  publisher(owner) {
    let publisher = this.publishers.get(owner);
    if (!publisher) {
      publisher = this.publisherFactory(owner);
      this.publishers.set(owner, publisher);
    }
    return publisher;
  }
  syncOwnedSessions() {
    if (!this.writerVerifiable) return;
    for (const owner of this.sessionOwnership.ownedSessionIds()) {
      if (this.claimedOwners.has(owner)) continue;
      if (!this.sessionOwnership.claim(owner, this.bridgeToken)) continue;
      const publisher = this.publisher(owner);
      if (publisher.hasWriterOwnership) {
        try {
          const refreshed = this.terminalManager.refreshSnapshotsFromStore?.();
          if (refreshed) this.adoptTerminalSnapshots(refreshed);
        } catch (error) {
          this.diagnostic({ kind: "io", path: owner, message: `terminal takeover refresh failed: ${error instanceof Error ? error.message : String(error)}` });
        }
        this.claimedOwners.add(owner);
      } else {
        this.publishers.delete(owner);
        this.sessionOwnership.release(owner, this.bridgeToken);
      }
    }
  }
  publishAll() {
    if (this.disposed) return;
    this.syncOwnedSessions();
    for (const owner of this.claimedOwners) this.publishOwner(owner, false);
  }
  publishRunningTerminalOwners() {
    if (this.disposed) return;
    this.syncOwnedSessions();
    const owners = new Set(this.terminalSnapshots.filter((task) => !isTerminalTaskSettled(task.status)).map((task) => task.ownerSessionId));
    for (const owner of owners) this.publishOwner(owner, false);
  }
  publishOwner(owner, shuttingDownSubagents) {
    if (!this.claimedOwners.has(owner)) return;
    const publisher = this.publisher(owner);
    if (!publisher.hasWriterOwnership) {
      this.claimedOwners.delete(owner);
      this.publishers.delete(owner);
      this.sessionOwnership.release(owner, this.bridgeToken);
      return;
    }
    const retained = publisher.getSnapshot();
    const current = [];
    const ownerTasks = this.terminalSnapshots.filter((task) => task.ownerSessionId === owner);
    const terminalTasks = [
      ...ownerTasks.filter((task) => !isTerminalTaskSettled(task.status)),
      ...ownerTasks.filter((task) => isTerminalTaskSettled(task.status) && this.now() - (task.settledAt ?? task.updatedAt ?? task.createdAt) <= ACTIVITY_SETTLED_RETENTION_MS).sort((left, right) => (right.settledAt ?? right.updatedAt) - (left.settledAt ?? left.updatedAt)).slice(0, ACTIVITY_SETTLED_RETENTION_COUNT)
    ];
    for (const task of terminalTasks) {
      const cacheKey2 = this.terminalCacheKey(task);
      const cached = this.terminalOutputCache.get(cacheKey2);
      let output = cached?.output ?? "";
      if (!isTerminalTaskSettled(task.status) || cached?.revision !== task.revision) {
        try {
          if (this.terminalManager.getOutputTailBytes || this.terminalManager.getOutputBytes) {
            const tail = this.terminalManager.getOutputTailBytes?.(task, TERMINAL_REDACTION_CONTEXT_BYTES);
            const bytes = tail?.bytes ?? this.terminalManager.getOutputBytes(task, TERMINAL_REDACTION_CONTEXT_BYTES);
            let raw = boundedOutputTail(bytes, {
              maxBytes: TERMINAL_REDACTION_CONTEXT_BYTES,
              maxLines: Number.MAX_SAFE_INTEGER
            });
            if (tail?.truncated) {
              const newline = raw.indexOf("\n");
              raw = newline === -1 ? "" : raw.slice(newline + 1);
            }
            output = boundedOutputTail(redactActivitySecrets(raw));
          } else {
            output = boundedOutputTail(redactActivitySecrets(this.terminalManager.getOutput(task)));
          }
          this.terminalOutputCache.set(cacheKey2, { revision: task.revision, output });
        } catch (error) {
          this.diagnostic({ kind: "io", path: task.logFile, message: error instanceof Error ? error.message : String(error) });
        }
      }
      current.push(terminalActivitySnapshot(task, output));
    }
    if (this.subagentOwnerSessionId === owner) {
      for (const snapshot of this.subagentManager.list()) {
        let activity = { ...durableSubagentActivity(snapshot, retained), ownerSessionId: owner };
        if (shuttingDownSubagents && !isSettledActivityStatus(activity.status)) {
          activity = lostActivity(activity, "subagent stopped with its owning session", this.now());
        }
        current.push(activity);
      }
    }
    const abandonedRunningIds = publisher.getAbandonedRunningIds();
    const merged = [];
    const currentById = new Map(current.map((activity) => [activity.id, activity]));
    const retainedById = new Map(retained.map((activity) => [activity.id, activity]));
    for (const activity of retained) {
      const update = currentById.get(activity.id);
      if (update) merged.push(mergeActivitySnapshot(activity, update));
      else if (!isSettledActivityStatus(activity.status) && activity.kind !== "terminal" && (abandonedRunningIds.has(activity.id) || shuttingDownSubagents && activity.kind === "subagent")) {
        merged.push(lostActivity(activity, `${activity.kind} producer is no longer recoverable`, this.now()));
      } else merged.push(activity);
    }
    for (const activity of current) {
      if (!retainedById.has(activity.id)) merged.push(activity);
    }
    try {
      publisher.publish(merged);
      if (abandonedRunningIds.size > 0) publisher.completeAbandonedReconciliation();
    } catch (error) {
      if (!publisher.hasWriterOwnership) {
        this.claimedOwners.delete(owner);
        this.publishers.delete(owner);
        this.sessionOwnership.release(owner, this.bridgeToken);
      }
      this.diagnostic({ kind: "io", path: owner, message: error instanceof Error ? error.message : String(error) });
    }
  }
  adoptTerminalSnapshots(snapshots) {
    this.terminalSnapshots = snapshots;
    const retainedKeys = new Set(snapshots.map((task) => this.terminalCacheKey(task)));
    for (const key of this.terminalOutputCache.keys()) {
      if (!retainedKeys.has(key)) this.terminalOutputCache.delete(key);
    }
  }
  terminalCacheKey(task) {
    return `${task.ownerSessionId}\0${task.id}`;
  }
  scheduleSubagentPublish() {
    if (this.disposed || this.subagentTimer) return;
    this.subagentTimer = setTimeout(() => {
      this.subagentTimer = void 0;
      this.publishAll();
    }, this.subagentDebounceMs);
    this.subagentTimer.unref?.();
  }
  syncTerminalOutputPoll() {
    const hasRunning = this.terminalSnapshots.some((task) => !isTerminalTaskSettled(task.status));
    if (!hasRunning) {
      if (this.terminalOutputTimer) clearInterval(this.terminalOutputTimer);
      this.terminalOutputTimer = void 0;
      return;
    }
    if (this.terminalOutputTimer) return;
    this.terminalOutputTimer = setInterval(() => this.publishRunningTerminalOwners(), this.terminalOutputPollMs);
    this.terminalOutputTimer.unref?.();
  }
  diagnostic(diagnostic) {
    this.onDiagnostic?.(diagnostic);
    logDiagnostic("activity_feed_diagnostic", { ...diagnostic });
  }
};
function installActivityManagerBridge(pi, terminalManager, subagentManager, options = {}) {
  const diagnostic = options.onDiagnostic ?? ((entry) => logDiagnostic("activity_feed_diagnostic", { ...entry }));
  const bridge = new ActivityManagerBridge(terminalManager, subagentManager, {
    ...options,
    onDiagnostic: diagnostic,
    sessionOwnership: options.sessionOwnership ?? PROCESS_SESSION_OWNERSHIP
  });
  pi.on("session_start", (_event, ctx) => bridge.bindSession(ownerSessionId(ctx)));
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "terminal_start" && event.toolName !== "subagent_spawn") return;
    if (bridge.canProduceActivity(ownerSessionId(ctx))) return;
    return {
      block: true,
      reason: "activity unavailable: another live Pi process owns this session's durable Activity feed"
    };
  });
  pi.on("session_shutdown", (_event, ctx) => bridge.shutdownSession(ownerSessionId(ctx)));
  return bridge;
}

// src/subagent-status-row.ts
var TITLE_PREFIX_MAX = 18;
var LEFT_PADDING = "  ";
function ageLabel(ageMs) {
  const seconds = Math.max(0, Math.floor(ageMs / 1e3));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}
function fallbackTitle(title) {
  const normalized = title.replace(/\s+/g, " ").trim() || "subagent";
  return normalized.length <= TITLE_PREFIX_MAX ? normalized : `${normalized.slice(0, TITLE_PREFIX_MAX - 1)}\u2026`;
}
function renderSubagentStatusRow(options) {
  const theme = getActiveTheme();
  const width = Math.max(0, Math.floor(options.width));
  const segments = [];
  if (options.running.length > 0) segments.push(`${options.running.length} running`);
  if (options.queuedCount > 0) segments.push(`${options.queuedCount} queued`);
  segments.push(
    ...options.running.map((subagent) => `${subagent.id} ${subagent.roleId ?? fallbackTitle(subagent.title)} ${ageLabel(subagent.ageMs)}`)
  );
  const suffix = segments.length > 0 ? ` \xB7 ${segments.join(" \xB7 ")}` : "";
  const row3 = textLine([
    span(LEFT_PADDING),
    span("\u25C8", { fg: theme.tokens.colors.accent }),
    span(` subagents${suffix}`, { fg: theme.tokens.colors.foregroundDim })
  ]);
  return [lineToAnsi(truncateLine(row3, width))];
}

// src/subagents/backend-pane.ts
import {
  existsSync as existsSync10,
  mkdirSync as mkdirSync9,
  readFileSync as readFileSync14,
  renameSync as renameSync6,
  writeFileSync as writeFileSync9
} from "node:fs";
import { dirname as dirname11, join as join17 } from "node:path";
var RESPONSE_POLL_INTERVAL_MS = 750;
var SEND_ACK_POLL_MS = 250;
var SEND_ACK_TIMEOUT_MS = 3e4;
var PRIVATE_DIR_MODE = 448;
var PRIVATE_FILE_MODE3 = 384;
var CLOSE_REQUEST_FILE = "close.request";
var ERROR_TEXT_MAX = 4096;
var nodeFs = {
  existsSync: existsSync10,
  mkdirSync: mkdirSync9,
  readFileSync: readFileSync14,
  renameSync: renameSync6,
  writeFileSync: writeFileSync9
};
var errorText2 = (error) => error instanceof Error ? error.message : String(error);
var createPaneChildSpawner = (dependencies = {}) => (options) => {
  const fs3 = dependencies.fs ?? nodeFs;
  const now = dependencies.now ?? Date.now;
  const baseDir = dependencies.baseDir ?? join17(process.env.TMPDIR ?? "/tmp", "sumocode-subagents");
  const paths = buildVisibleTaskPaths(options.id, now(), baseDir);
  fs3.mkdirSync(dirname11(paths.promptFile), { recursive: true, mode: PRIVATE_DIR_MODE });
  fs3.mkdirSync(paths.controlDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const prompt = options.appendSystemPrompt ? `role instructions (follow these for this entire session):
${options.appendSystemPrompt}
---
${options.prompt}` : options.prompt;
  fs3.writeFileSync(paths.promptFile, prompt, { mode: 384 });
  fs3.writeFileSync(paths.logFile, "");
  const commandOptions = {
    cwd: options.cwd,
    paths,
    model: options.model,
    thinking: options.thinking,
    tools: options.tools
  };
  const agentCommand = buildVisibleAgentCommand(commandOptions);
  const exitGuard = [
    `__sumo_exit_file=${shellEscape2(paths.exitFile)}`,
    `__sumo_finish() { [ -f "$__sumo_exit_file" ] || printf '%s' "$1" > "$__sumo_exit_file"; }`,
    `trap '__sumo_finish "$?"' EXIT`,
    `trap '__sumo_finish 129' HUP`,
    `trap '__sumo_finish 143' TERM`,
    `trap '__sumo_finish 130' INT`
  ].join("; ");
  const script = [
    "#!/usr/bin/env bash",
    "set -u",
    exitGuard,
    `( ${agentCommand} ) 2>> ${shellEscape2(paths.logFile)}`
  ].join("\n");
  fs3.writeFileSync(paths.scriptFile, script, { mode: 448 });
  const shellCommand = `exec ${shellEscape2(paths.scriptFile)}`;
  let emitEvent;
  let pane;
  let pollTimer;
  let interrupted = false;
  let settled = false;
  let steerSeq = 0;
  let markReady = () => void 0;
  const ready = new Promise((resolve10) => {
    markReady = resolve10;
  });
  const pendingSteeringAcks = /* @__PURE__ */ new Map();
  const clearWatcher = () => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = void 0;
  };
  const steeringSettlementError = () => new Error(
    `visible subagent ${options.id} has settled before steering consumption was acknowledged`
  );
  const finishPendingSteeringAck = (path2, error) => {
    const pending = pendingSteeringAcks.get(path2);
    if (!pending) return;
    pendingSteeringAcks.delete(path2);
    clearInterval(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  };
  const settlePendingSteeringAcks = () => {
    for (const path2 of pendingSteeringAcks.keys()) {
      finishPendingSteeringAck(path2, fs3.existsSync(path2) ? steeringSettlementError() : void 0);
    }
  };
  const settle = (event) => {
    if (settled) return;
    settled = true;
    clearWatcher();
    settlePendingSteeringAcks();
    options.signal?.removeEventListener("abort", interrupt);
    emitEvent?.(event);
  };
  const readText = (path2) => {
    try {
      return fs3.existsSync(path2) ? fs3.readFileSync(path2, "utf8") : "";
    } catch (error) {
      return `[unable to read ${path2}: ${errorText2(error)}]`;
    }
  };
  const poll = () => {
    if (settled || interrupted || !fs3.existsSync(paths.exitFile)) return;
    const marker = readText(paths.exitFile);
    if (!marker.trim()) return;
    const exitCode = readExitCodeFromFile(marker);
    if (exitCode === null) {
      settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `invalid visible child exit marker: ${marker.trim() || "<empty>"}` } });
      return;
    }
    if (exitCode === 0) {
      settle({ kind: "run-settled", outcome: { kind: "completed", finalText: readText(paths.responseFile) } });
      return;
    }
    const logTail = readText(paths.logFile).slice(-ERROR_TEXT_MAX).trim();
    settle({
      kind: "run-settled",
      outcome: {
        kind: "failed",
        errorText: logTail || `visible child exited with code ${exitCode}`,
        partialText: readText(paths.responseFile) || void 0
      }
    });
  };
  const closeInterruptedPane = async () => {
    if (!pane) return;
    try {
      const result = await options.host.closePane(options.pi, pane);
      if (!result.ok) {
        settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `failed to close visible child pane: ${result.error}` } });
        return;
      }
      settle({ kind: "run-settled", outcome: { kind: "interrupted" } });
    } catch (error) {
      settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `failed to close visible child pane: ${errorText2(error)}` } });
    }
  };
  function interrupt() {
    if (settled || interrupted) return;
    interrupted = true;
    clearWatcher();
    settlePendingSteeringAcks();
    void closeInterruptedPane();
  }
  const send = (text) => {
    if (settled || interrupted) return Promise.reject(steeringSettlementError());
    const seq = ++steerSeq;
    const finalPath = join17(paths.controlDir, `steer-${seq}.txt`);
    fs3.writeFileSync(`${finalPath}.tmp`, text, { mode: PRIVATE_FILE_MODE3 });
    fs3.renameSync(`${finalPath}.tmp`, finalPath);
    const ackPollMs = dependencies.sendAckPollMs ?? SEND_ACK_POLL_MS;
    const ackTimeoutMs = dependencies.sendAckTimeoutMs ?? SEND_ACK_TIMEOUT_MS;
    return new Promise((resolve10, reject) => {
      let elapsed2 = 0;
      const ackTimer = setInterval(() => {
        if (!fs3.existsSync(finalPath)) {
          finishPendingSteeringAck(finalPath);
          return;
        }
        elapsed2 += ackPollMs;
        if (fs3.existsSync(paths.exitFile) && readText(paths.exitFile).trim()) {
          poll();
        }
        if (elapsed2 >= ackTimeoutMs && pendingSteeringAcks.has(finalPath)) {
          finishPendingSteeringAck(
            finalPath,
            new Error(`steering consumption was not acknowledged within ${ackTimeoutMs}ms for ${options.id} \u2014 the file remains and the child may still consume it`)
          );
        }
      }, ackPollMs);
      pendingSteeringAcks.set(finalPath, { timer: ackTimer, resolve: resolve10, reject });
      ackTimer.unref?.();
    });
  };
  const requestClose = () => {
    fs3.writeFileSync(join17(paths.controlDir, CLOSE_REQUEST_FILE), "1", { mode: PRIVATE_FILE_MODE3 });
  };
  const events = (emit) => {
    emitEvent = emit;
    emit({ kind: "run-started" });
    void (async () => {
      const startAgentPane2 = options.host.startAgentPane;
      if (!startAgentPane2) {
        settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `terminal host ${options.host.kind} does not support visible agent panes` } });
        return;
      }
      try {
        const result = await startAgentPane2.call(options.host, options.pi, {
          name: options.name,
          cwd: options.cwd,
          shellCommand,
          placement: options.placement
        });
        if (!result.ok) {
          settle({ kind: "run-settled", outcome: { kind: "failed", errorText: result.error } });
          return;
        }
        pane = result.pane;
        emit({
          kind: "pane-attached",
          pane: {
            agentName: result.agentName,
            workspaceId: result.workspaceId,
            tabId: result.tabId,
            paneId: result.paneId
          }
        });
        if (interrupted) {
          await closeInterruptedPane();
          return;
        }
        pollTimer = setInterval(poll, dependencies.pollIntervalMs ?? RESPONSE_POLL_INTERVAL_MS);
        pollTimer.unref?.();
        poll();
      } catch (error) {
        settle({ kind: "run-settled", outcome: { kind: "failed", errorText: errorText2(error) } });
      }
    })().finally(markReady);
  };
  if (options.signal?.aborted) interrupted = true;
  else options.signal?.addEventListener("abort", interrupt, { once: true });
  return { events, interrupt, ready, send, requestClose };
};
var spawnPaneChild = createPaneChildSpawner();

// src/subagents/backend-pi.ts
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync as existsSync11, readFileSync as readFileSync15, statSync } from "node:fs";
import { homedir as homedir14 } from "node:os";
import { dirname as dirname12, isAbsolute as isAbsolute2, join as join18, resolve as resolve6 } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";

// src/subagents/pi-child-model-bootstrap.ts
var CHILD_MODEL_PROVIDER_ENV = "SUMOCODE_CHILD_MODEL_PROVIDER";
var CHILD_MODEL_ID_ENV = "SUMOCODE_CHILD_MODEL_ID";

// src/subagents/backend-pi.ts
var isString5 = (value) => typeof value === "string";
var DEFAULT_BUILT_IN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
var PREVIEW_MAX2 = 160;
var ERROR_MAX = 4096;
var CLAUDE_OAUTH_ADAPTER_PACKAGE = "pi-claude-oauth-adapter";
var MULTI_ACCOUNT_ADAPTER_SOURCE = "git:github.com/dhruvkelawala/pi-claude-oauth-adapter@multi-account";
var NUMBERED_ANTHROPIC_PROVIDER = /^anthropic-\d+$/;
function adapterEntryFromPackageDir(packageDir) {
  try {
    const manifest = JSON.parse(readFileSync15(join18(packageDir, "package.json"), "utf8"));
    const entries = manifest.pi?.extensions;
    const first = Array.isArray(entries) ? entries[0] : void 0;
    if (!isString5(first)) return void 0;
    const entryPath = join18(packageDir, first);
    return existsSync11(entryPath) ? entryPath : void 0;
  } catch {
    return void 0;
  }
}
function gitPackageDir(source, agentDir) {
  if (!source.startsWith("git:")) return void 0;
  const spec = source.slice("git:".length);
  let host;
  let repoPath;
  if (spec.startsWith("git@")) {
    const separator = spec.indexOf(":");
    if (separator < 0) return void 0;
    host = spec.slice("git@".length, separator);
    repoPath = spec.slice(separator + 1);
  } else {
    const separator = spec.indexOf("/");
    if (separator < 0) return void 0;
    host = spec.slice(0, separator);
    repoPath = spec.slice(separator + 1);
  }
  const refSeparator = repoPath.lastIndexOf("@");
  if (refSeparator >= 0) repoPath = repoPath.slice(0, refSeparator);
  if (repoPath.endsWith(".git")) repoPath = repoPath.slice(0, -".git".length);
  const segments = repoPath.split("/").filter(Boolean);
  if (!host || host === "." || host === ".." || host.includes("\\") || segments.length < 2 || segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) return void 0;
  return join18(agentDir, "git", host, ...segments);
}
function adapterPackageDirsFromSettings(settingsPath, agentDir) {
  try {
    const settings = JSON.parse(readFileSync15(settingsPath, "utf8"));
    if (!Array.isArray(settings.packages)) return [];
    const sources = settings.packages.map((entry) => isString5(entry) ? entry : entry?.source).filter((source) => isString5(source) && source.includes(CLAUDE_OAUTH_ADAPTER_PACKAGE)).sort((left, right) => Number(right.trim() === MULTI_ACCOUNT_ADAPTER_SOURCE) - Number(left.trim() === MULTI_ACCOUNT_ADAPTER_SOURCE));
    return sources.flatMap((source) => {
      const gitDir = gitPackageDir(source, agentDir);
      if (gitDir) return [gitDir];
      if (source.startsWith("npm:") || source.startsWith("http")) return [];
      if (source.startsWith("~/")) return [join18(homedir14(), source.slice(2))];
      return [isAbsolute2(source) ? source : resolve6(dirname12(settingsPath), source)];
    });
  } catch {
    return [];
  }
}
function resolveClaudeOauthAdapterEntry(env = process.env) {
  const override = env.SUMOCODE_CLAUDE_OAUTH_ADAPTER;
  if (override) {
    try {
      const stat = statSync(override);
      if (stat.isFile()) return override;
      if (stat.isDirectory()) return adapterEntryFromPackageDir(override);
    } catch {
    }
    return void 0;
  }
  const agentDir = env.PI_CODING_AGENT_DIR ?? join18(homedir14(), ".pi", "agent");
  const candidateDirs = [
    // Configured sources reflect the active package choice and must precede a
    // stale npm cache left behind after switching to the multi-account fork.
    ...adapterPackageDirsFromSettings(join18(agentDir, "settings.json"), agentDir),
    join18(agentDir, "npm", "node_modules", CLAUDE_OAUTH_ADAPTER_PACKAGE)
  ];
  for (const dir of candidateDirs) {
    const entry = adapterEntryFromPackageDir(dir);
    if (entry) return entry;
  }
  return void 0;
}
var sanitizePreview = (value, max = PREVIEW_MAX2) => {
  if (value === void 0) return void 0;
  let text;
  if (isString5(value)) text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const flattened = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\t\r\n]+/g, " ").trim();
  return flattened.length > max ? `${flattened.slice(0, max - 1)}\u2026` : flattened;
};
var safeToolArgumentsPreview = (value) => {
  if (value === void 0) return void 0;
  const preview = safeValuePreview(value, {
    maxChars: PREVIEW_MAX2,
    maxDepth: 4,
    maxEntries: 16,
    maxStringChars: PREVIEW_MAX2
  });
  return preview.replace(/[\t\r\n]+/g, " ").trim();
};
var stringifyToolOutput2 = (value) => {
  if (value === void 0) return void 0;
  if (isString5(value)) return value;
  if (isRecord(value)) {
    const content = value.content;
    if (Array.isArray(content)) {
      const text = content.map((part) => isRecord(part) && part.type === "text" && isString5(part.text) ? part.text : void 0).filter((part) => part !== void 0).join("\n");
      if (text.trim().length > 0) return text;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
var parseJsonLine2 = (line) => {
  if (!line.trim()) return void 0;
  try {
    const decoded = JSON.parse(line);
    if (!isRecord(decoded)) return void 0;
    return decoded;
  } catch {
    return void 0;
  }
};
var isMessage2 = (value) => {
  return isRecord(value) && (value.role === "assistant" || value.role === "user" || value.role === "toolResult");
};
var messageText2 = (message) => {
  if (isString5(message.text)) return message.text;
  if (isString5(message.content)) return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => isRecord(part) && isString5(part.text) ? part.text : "").join("");
  }
  return "";
};
var mapPiEvent = (event) => {
  const typeText = isString5(event.type) ? event.type : "";
  if (typeText === "message_update") {
    const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : void 0;
    if (assistantEvent?.type === "text_delta" && isString5(assistantEvent.delta)) {
      return [{ kind: "assistant-delta", delta: assistantEvent.delta }];
    }
  }
  if (typeText === "tool_execution_start") {
    return [{
      kind: "tool-start",
      toolId: isString5(event.toolCallId) ? event.toolCallId : `${event.toolName ?? "tool"}`,
      name: isString5(event.toolName) ? event.toolName : "tool",
      argsPreview: safeToolArgumentsPreview(event.args)
    }];
  }
  if (typeText === "tool_execution_update") {
    return [{
      kind: "tool-update",
      toolId: isString5(event.toolCallId) ? event.toolCallId : `${event.toolName ?? "tool"}`,
      outputPreview: sanitizePreview(stringifyToolOutput2(event.partialResult))
    }];
  }
  if (typeText === "tool_execution_end") {
    return [{
      kind: "tool-end",
      toolId: isString5(event.toolCallId) ? event.toolCallId : `${event.toolName ?? "tool"}`,
      name: isString5(event.toolName) ? event.toolName : "tool",
      isError: event.isError === true,
      outputPreview: sanitizePreview(stringifyToolOutput2(event.result))
    }];
  }
  const messageValue = event.message;
  if ((typeText === "message_end" || typeText === "tool_result_end") && isMessage2(messageValue)) {
    const events = [{ kind: "message-end", role: messageValue.role, text: messageText2(messageValue) }];
    if (messageValue.role === "assistant") {
      events.push({
        kind: "usage",
        // totalTokens is the child's cumulative context occupancy; the JSON
        // event stream does not carry the model's context-window capacity,
        // so leave contextWindow unset rather than mislabeling input tokens.
        tokens: messageValue.usage?.totalTokens,
        costUsd: messageValue.usage?.cost?.total
      });
    }
    return events;
  }
  return [];
};
var signalGroup = (proc, signal) => {
  if (process.platform !== "win32" && proc.pid != null) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
    }
  }
  try {
    proc.kill(signal);
  } catch {
  }
};
var attachAbortSignal2 = (proc, signal) => {
  let aborted = false;
  let exited = false;
  proc.once("close", () => {
    exited = true;
  });
  const interrupt = () => {
    aborted = true;
    signalGroup(proc, "SIGTERM");
    setTimeout(() => {
      if (!exited) signalGroup(proc, "SIGKILL");
    }, 5e3).unref?.();
  };
  if (signal?.aborted) interrupt();
  else signal?.addEventListener("abort", interrupt, { once: true });
  return { isAborted: () => aborted, interrupt };
};
function resolvePiBinary(env = process.env) {
  const configured = env.PI_BIN?.trim();
  if (!configured) return "pi";
  return configured.includes("/") || configured.includes("\\") ? resolve6(configured) : configured;
}
function resolvePiChildModelBootstrapEntry(env = process.env, moduleUrl = import.meta.url) {
  const override = env.SUMOCODE_CHILD_MODEL_BOOTSTRAP?.trim();
  const moduleDir = dirname12(fileURLToPath4(moduleUrl));
  const candidates = [
    override,
    env.SUMOCODE_ROOT_DIR ? join18(env.SUMOCODE_ROOT_DIR, "src", "subagents", "pi-child-model-bootstrap.ts") : void 0,
    join18(moduleDir, "pi-child-model-bootstrap.ts"),
    // The committed extension bundle lives at dist/extension/*.mjs while this
    // child-only entry remains executable TypeScript under src/subagents.
    resolve6(moduleDir, "..", "..", "src", "subagents", "pi-child-model-bootstrap.ts")
  ];
  return candidates.find((candidate) => !!candidate && existsSync11(candidate));
}
function childModelSelection(modelLabel) {
  if (!modelLabel) return void 0;
  const separator = modelLabel.indexOf("/");
  if (separator <= 0) return void 0;
  const provider = modelLabel.slice(0, separator);
  const modelId = modelLabel.slice(separator + 1);
  return NUMBERED_ANTHROPIC_PROVIDER.test(provider) && modelId ? { provider, modelId } : void 0;
}
function removeCliModelSelection(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--provider" || args[index] === "--model") {
      index += 1;
      continue;
    }
    result.push(args[index] ?? "");
  }
  return result;
}
var createPiChildSpawner = (spawnImpl = nodeSpawn, resolveAdapterEntry = resolveClaudeOauthAdapterEntry, resolveBinary = resolvePiBinary, resolveBootstrapEntry = resolvePiChildModelBootstrapEntry) => (options) => {
  const config = resolveTaskConfig({
    // SAFETY: options.thinking comes from the typed SpawnSubagentTask.thinking field.
    item: { prompt: options.prompt, model: options.model, thinking: options.thinking, fork: false },
    defaultModel: void 0,
    defaultThinking: "inherit",
    // SAFETY: inherited thinking strings are validated by resolveTaskConfig below.
    inheritedThinking: options.inherited.thinking ?? "low",
    ctxModel: options.inherited.model,
    // Children inherit the PARENT's active built-in tool set (mirroring
    // native-task-tool's getActiveTools threading) so a narrowed parent
    // session cannot spawn children with broader tool access.
    //
    // TRUST MODEL (conscious, documented — parity with native-task): children
    // run --no-extensions, so SumoCode's approval gate is NOT installed in
    // them. A headless child has no UI to prompt anyway; a child-side gate
    // would hang or fail-closed all bash including legitimate worktree git
    // work. The model-facing guidelines warn against delegating destructive
    // commands; a non-interactive child-side deny-list is a possible future
    // opt-in, tracked in plan 065's maintenance notes.
    builtInTools: [...options.builtInTools ?? DEFAULT_BUILT_IN_TOOLS]
  });
  if (!config.ok) {
    return {
      events: (emit) => emit({ kind: "run-settled", outcome: { kind: "failed", errorText: config.error } }),
      interrupt: () => void 0
    };
  }
  let interrupt = () => void 0;
  const events = (emit) => {
    emit({ kind: "run-started" });
    const adapterEntry = resolveAdapterEntry();
    const childModel = childModelSelection(config.modelLabel);
    const bootstrapEntry = childModel ? resolveBootstrapEntry() : void 0;
    if (childModel && (!adapterEntry || !bootstrapEntry)) {
      emit({
        kind: "run-settled",
        outcome: { kind: "failed", errorText: `Numbered Claude child startup unavailable: ${!adapterEntry ? "OAuth adapter not found" : "model bootstrap not found"}` }
      });
      return;
    }
    const roleArgs = options.appendSystemPrompt ? ["--append-system-prompt", options.appendSystemPrompt] : [];
    const adapterArgs = adapterEntry ? ["-e", adapterEntry] : [];
    const bootstrapArgs = bootstrapEntry ? ["-e", bootstrapEntry] : [];
    const subprocessArgs = childModel ? removeCliModelSelection(config.subprocessArgs) : config.subprocessArgs;
    const childEnv = childModel ? { ...process.env, [CHILD_MODEL_PROVIDER_ENV]: childModel.provider, [CHILD_MODEL_ID_ENV]: childModel.modelId } : process.env;
    const proc = spawnImpl(resolveBinary(), [...subprocessArgs, ...roleArgs, ...adapterArgs, ...bootstrapArgs, options.prompt], {
      cwd: options.cwd,
      env: childEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group on POSIX so interrupt/SIGKILL can signal the
      // whole tree (see signalGroup) instead of just the pi pid.
      detached: process.platform !== "win32"
    });
    proc.stdin.end();
    const abortState = attachAbortSignal2(proc, options.signal);
    interrupt = abortState.interrupt;
    let stdoutBuffer = "";
    let stderr = "";
    let finalAssistantText = "";
    let stopReason;
    let errorMessage2;
    const processLine = (line) => {
      const parsed = parseJsonLine2(line);
      if (!parsed) return;
      for (const event of mapPiEvent(parsed)) {
        if (event.kind === "message-end" && event.role === "assistant") finalAssistantText = event.text;
        emit(event);
      }
      const messageValue = parsed.message;
      if (isMessage2(messageValue) && messageValue.role === "assistant") {
        if (isString5(messageValue.stopReason)) stopReason = messageValue.stopReason;
        if (isString5(messageValue.errorMessage)) errorMessage2 = messageValue.errorMessage;
      }
    };
    proc.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code, closeSignal) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      if (abortState.isAborted()) {
        emit({ kind: "run-settled", outcome: { kind: "interrupted", partialText: finalAssistantText || void 0 } });
        return;
      }
      if (code === 0 && stopReason !== "error" && stopReason !== "aborted") {
        emit({ kind: "run-settled", outcome: { kind: "completed", finalText: finalAssistantText } });
        return;
      }
      emit({
        kind: "run-settled",
        outcome: {
          kind: "failed",
          errorText: (errorMessage2 || stderr || (closeSignal ? `pi killed by ${closeSignal}` : `pi exited with code ${code ?? "unknown"}`)).slice(0, ERROR_MAX),
          partialText: finalAssistantText || void 0
        }
      });
    });
    proc.on("error", (error) => {
      emit({ kind: "run-settled", outcome: { kind: "failed", errorText: error.message.slice(0, ERROR_MAX), partialText: finalAssistantText || void 0 } });
    });
  };
  return { events, interrupt: () => interrupt() };
};
var spawnPiChild = createPiChildSpawner();

// src/subagents/delivery.ts
function createDeferredResultDelivery() {
  const pending = /* @__PURE__ */ new Map();
  const consumed = /* @__PURE__ */ new Set();
  return {
    defer(id, build) {
      if (consumed.has(id) || pending.has(id)) return;
      pending.set(id, build());
    },
    consume(id) {
      consumed.add(id);
      pending.delete(id);
    },
    forget(id) {
      consumed.delete(id);
    },
    drain() {
      const payloads = [...pending.values()];
      pending.clear();
      return payloads;
    },
    clear() {
      pending.clear();
      consumed.clear();
    },
    get size() {
      return pending.size;
    }
  };
}

// src/subagents/manager.ts
import { execFile as execFile6 } from "node:child_process";
import { isAbsolute as isAbsolute3, join as join19, relative as relative2 } from "node:path";
import { promisify as promisify4 } from "node:util";

// src/subagents/domain.ts
var SUBAGENT_MAX_RUNNING = 10;
var SUBAGENT_MAX_QUEUED = 16;
var latestText = (snap) => snap.liveText || snap.finalText;

// src/subagents/layout.ts
var MAX_PANES_PER_TAB = 4;
var splitDirection = (paneCount) => paneCount % 2 === 0 ? "right" : "down";
function planPlacement(input) {
  if (input.hostKind !== "herdr") return { kind: "fallback-split", direction: "right" };
  if (!input.sessionTabId) {
    if (input.isolated) return { kind: "workspace" };
    const tabNumber = Math.floor(input.visiblePanes.length / MAX_PANES_PER_TAB) + 1;
    return { kind: "new-tab", label: tabNumber === 1 ? "subagents" : `subagents ${tabNumber}` };
  }
  const panesInSessionTab = input.visiblePanes.filter((pane) => pane.tabId === input.sessionTabId).length;
  if (panesInSessionTab < MAX_PANES_PER_TAB) {
    return {
      kind: "tab",
      tabId: input.sessionTabId,
      direction: splitDirection(panesInSessionTab)
    };
  }
  const nextTabNumber = Math.floor(input.visiblePanes.length / MAX_PANES_PER_TAB) + 1;
  return { kind: "new-tab", label: `subagents ${nextTabNumber}` };
}

// src/subagents/manifest.ts
import { execFile as execFile5 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var execFileAsync2 = promisify3(execFile5);
var GIT_TIMEOUT_MS = 4500;
async function git2(cwd, args) {
  try {
    const { stdout } = await execFileAsync2("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  } catch {
    return void 0;
  }
}
function statusPaths(output) {
  const records = output.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return paths;
}
var outcomeExit = (outcome) => outcome.kind;
async function buildCompletionManifest(options) {
  const [headOutput, statusOutput, diffOutput, commitsOutput] = await Promise.all([
    git2(options.cwd, ["rev-parse", "HEAD"]),
    git2(options.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    options.worktree ? git2(options.cwd, ["diff", "--name-only", "-z", `${options.baseRef}..HEAD`]) : void 0,
    git2(options.cwd, ["rev-list", "--count", `${options.baseRef}..HEAD`])
  ]);
  const statusChangedPaths = statusOutput === void 0 ? [] : statusPaths(statusOutput);
  const committedChangedPaths = diffOutput === void 0 ? [] : diffOutput.split("\0").filter(Boolean);
  const commits = commitsOutput === void 0 ? 0 : Number.parseInt(commitsOutput.trim(), 10);
  const changedPaths = options.worktree ? [.../* @__PURE__ */ new Set([...statusChangedPaths, ...committedChangedPaths])].sort() : [];
  return {
    baseRef: options.baseRef,
    headRef: headOutput?.trim() || void 0,
    branch: options.worktree?.branch,
    worktreePath: options.worktree?.path,
    changedPaths,
    // A failed/timed-out status read is NOT evidence of cleanliness — leave
    // dirty undefined ("unknown") rather than rendering "checkout clean".
    dirty: statusOutput === void 0 ? void 0 : statusOutput.length > 0,
    commits: Number.isFinite(commits) ? commits : 0,
    exit: outcomeExit(options.outcome),
    durationMs: Math.max(0, Date.now() - options.startedAt)
  };
}

// src/subagents/manager.ts
var execFileAsync3 = promisify4(execFile6);
var MAX_TRACKED = 64;
var ERROR_TEXT_MAX2 = 4096;
var CANCEL_WAIT_MS = 5500;
var CLOSE_WAIT_MS = 15e3;
var GIT_READ_TIMEOUT_MS = 5e3;
var MANIFEST_TIMEOUT_MS = 5e3;
async function gitRead(cwd, args) {
  try {
    const { stdout } = await execFileAsync3("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_READ_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout.trim() || void 0;
  } catch {
    return void 0;
  }
}
async function captureGitContext(cwd) {
  const [repoRoot, baseRef] = await Promise.all([
    gitRead(cwd, ["rev-parse", "--show-toplevel"]),
    gitRead(cwd, ["rev-parse", "HEAD"])
  ]);
  return { repoRoot, baseRef };
}
var isSettled = (snapshot) => snapshot.status !== "running" && snapshot.status !== "queued";
var makeInitialSnapshot = (task, id, createdAt, baseRef, cwd = task.cwd, worktree, sessionFilePath, status = "running") => {
  const snapshot = {
    id,
    title: task.title,
    prompt: task.prompt,
    cwd,
    baseRef,
    worktree,
    status,
    createdAt,
    modelLabel: task.model ?? (task.inherited?.model ? `${task.inherited.model.provider}/${task.inherited.model.id}` : void 0),
    thinkingLabel: task.thinking ?? task.inherited?.thinking,
    sessionFilePath,
    usage: { turns: 0 },
    transcript: [],
    liveText: "",
    liveTools: [],
    finalText: ""
  };
  if (task.sourceId !== void 0) snapshot.sourceId = task.sourceId;
  if (task.roleId !== void 0) snapshot.roleId = task.roleId;
  if (task.visible) snapshot.visible = true;
  return snapshot;
};
var upsertTool = (tools, next) => {
  const index = tools.findIndex((tool) => tool.id === next.id);
  if (index === -1) return [...tools, next];
  return tools.map((tool, toolIndex) => toolIndex === index ? { ...tool, ...next } : tool);
};
var SubagentManager = class {
  constructor(backendFactory, dependencies = {}) {
    this.backendFactory = backendFactory;
    this.createWorktreeImpl = dependencies.createWorktree ?? createWorktree;
    this.resolveWorktreeBaseRefImpl = dependencies.resolveWorktreeBaseRef ?? ((path2) => gitRead(path2, ["rev-parse", "HEAD"]));
    this.captureGitContextImpl = dependencies.captureGitContext ?? captureGitContext;
    this.buildCompletionManifestImpl = dependencies.buildCompletionManifest ?? buildCompletionManifest;
    this.terminalHost = dependencies.terminalHost;
    this.pi = dependencies.pi;
    this.initialVisibleTabId = dependencies.initialVisibleTabId;
    this.subagentsTabId = this.initialVisibleTabId;
  }
  backendFactory;
  nextId = 1;
  pendingSpawns = /* @__PURE__ */ new Map();
  queuedTasks = [];
  snapshots = /* @__PURE__ */ new Map();
  children = /* @__PURE__ */ new Map();
  waitInterest = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  createWorktreeImpl;
  resolveWorktreeBaseRefImpl;
  captureGitContextImpl;
  buildCompletionManifestImpl;
  terminalHost;
  pi;
  initialVisibleTabId;
  subagentsTabId;
  visibleSpawnTail = Promise.resolve();
  dequeueTail = Promise.resolve();
  settlingIds = /* @__PURE__ */ new Set();
  settlingPromises = /* @__PURE__ */ new Map();
  settlingOutcomes = /* @__PURE__ */ new Map();
  startedIds = /* @__PURE__ */ new Set();
  cancelledSetupIds = /* @__PURE__ */ new Set();
  workspacePlacedIds = /* @__PURE__ */ new Set();
  lifecycleGeneration = 0;
  consumedIds = /* @__PURE__ */ new Set();
  async spawn(task) {
    const generation = this.lifecycleGeneration;
    const runningSummaries = this.runningSummaries();
    if (runningSummaries.length >= SUBAGENT_MAX_RUNNING || this.queuedTasks.length > 0) {
      if (this.queuedTasks.length >= SUBAGENT_MAX_QUEUED) {
        return {
          status: "at_capacity",
          capacity: SUBAGENT_MAX_RUNNING,
          runningCount: runningSummaries.length,
          running: runningSummaries,
          retryHint: "queue is full \u2014 do NOT retry in a loop; cancel something or end your turn and respawn later"
        };
      }
      const id2 = `sa-${this.nextId++}`;
      const createdAt = Date.now();
      const snapshot2 = makeInitialSnapshot(task, id2, createdAt, "HEAD", task.cwd, void 0, void 0, "queued");
      this.queuedTasks.push({ task, id: id2, createdAt, generation });
      this.snapshots.set(id2, snapshot2);
      this.notify();
      this.prune();
      return snapshot2;
    }
    const id = `sa-${this.nextId++}`;
    const snapshot = await this.startTask(task, id, Date.now(), generation);
    if (snapshot.status !== "running" && generation === this.lifecycleGeneration) void this.scheduleDequeue();
    return snapshot;
  }
  runningSummaries() {
    const running = this.list().filter((snapshot) => snapshot.status === "running" && this.children.has(snapshot.id));
    const pending = [...this.pendingSpawns].map(([id, spawn2]) => ({ id, title: spawn2.title, status: "running", ageMs: Date.now() - spawn2.createdAt }));
    return [
      ...running.map((snapshot) => ({ id: snapshot.id, title: snapshot.title, status: snapshot.status, ageMs: Date.now() - snapshot.createdAt })),
      ...pending
    ];
  }
  async startTask(task, id, createdAt, generation) {
    this.pendingSpawns.set(id, { title: task.title, createdAt });
    let pending = true;
    let releaseVisibleSpawn;
    const releasePending = () => {
      if (!pending) return;
      pending = false;
      this.pendingSpawns.delete(id);
    };
    try {
      const gitContext = await this.captureGitContextImpl(task.cwd);
      const baseRef = gitContext.baseRef ?? "HEAD";
      if (this.setupInterrupted(id, generation)) {
        releasePending();
        return this.recordSetupInterruption(task, id, createdAt, baseRef, "interrupted during setup");
      }
      let manifestBaseRef = baseRef;
      if (task.branch && !task.worktree) {
        releasePending();
        return this.recordSpawnFailure(task, id, createdAt, baseRef, "branch requires worktree: true; refusing to ignore the isolation request");
      }
      let childCwd = task.cwd;
      let worktree;
      if (task.worktree) {
        if (!gitContext.repoRoot || !gitContext.baseRef) {
          releasePending();
          return this.recordSpawnFailure(task, id, createdAt, baseRef, "unable to create worktree: the spawn cwd is not a readable git checkout");
        }
        const resolved = resolveCreateOptions({
          repoRoot: gitContext.repoRoot,
          branch: task.branch,
          baseRef: task.baseRef ?? "HEAD",
          task: task.title
        });
        const created = await this.createWorktreeImpl({
          repoRoot: gitContext.repoRoot,
          branch: resolved.branch,
          baseRef: resolved.baseRef,
          path: resolved.path,
          task: task.title
        });
        if (!created.ok) {
          releasePending();
          return this.recordSpawnFailure(task, id, createdAt, baseRef, `unable to create worktree: ${created.message}`);
        }
        const subPath = relative2(gitContext.repoRoot, task.cwd);
        childCwd = subPath && !subPath.startsWith("..") && !isAbsolute3(subPath) ? join19(created.path, subPath) : created.path;
        const resolvedBaseRef = await this.resolveWorktreeBaseRefImpl(created.path);
        if (!resolvedBaseRef) {
          worktree = {
            path: created.path,
            branch: created.branch,
            baseRef: created.baseRef,
            repoRoot: gitContext.repoRoot
          };
          releasePending();
          return this.recordSpawnFailure(task, id, createdAt, baseRef, `unable to resolve worktree base commit. Worktree created at ${created.path} is preserved.`, created.path, worktree);
        }
        manifestBaseRef = resolvedBaseRef;
        worktree = {
          path: created.path,
          branch: created.branch,
          baseRef: manifestBaseRef,
          repoRoot: gitContext.repoRoot
        };
        if (this.setupInterrupted(id, generation)) {
          releasePending();
          return this.recordSetupInterruption(task, id, createdAt, manifestBaseRef, `interrupted during setup. Worktree created at ${created.path} is preserved.`, childCwd, worktree);
        }
      }
      let placement;
      if (task.visible) {
        releaseVisibleSpawn = await this.reserveVisibleSpawn();
        if (this.setupInterrupted(id, generation)) {
          releasePending();
          return this.recordSetupInterruption(task, id, createdAt, manifestBaseRef, "interrupted during setup", childCwd, worktree);
        }
        const host = this.terminalHost;
        if (!host || !this.pi || host.kind === "none") {
          releasePending();
          return this.recordSpawnFailure(task, id, createdAt, manifestBaseRef, "visible subagents require a running terminal host", childCwd, worktree);
        }
        const planned = planPlacement({
          hostKind: host.kind,
          isolated: worktree !== void 0,
          // Count every tracked pane in the tab, not just running ones: settled
          // panes stay open for inspection and still occupy tab real estate.
          // Over-counting an already-closed pane merely opens a fresh tab
          // earlier — the conservative failure mode.
          visiblePanes: this.list().flatMap((snapshot2) => snapshot2.visible && snapshot2.pane ? [snapshot2.pane] : []),
          sessionTabId: this.subagentsTabId
        });
        if (planned.kind === "workspace") {
          const openWorkspace = host.openExistingWorktreeWorkspace;
          let opened;
          try {
            opened = openWorkspace ? await openWorkspace(this.pi, { path: worktree?.path ?? childCwd, label: worktree?.branch.replace(/^sumo\//, "") ?? task.title, sourceCwd: gitContext.repoRoot ?? task.cwd, focus: false }) : { ok: false, error: `${host.kind} cannot open an existing worktree workspace` };
          } catch (error) {
            opened = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          if (this.setupInterrupted(id, generation)) {
            releasePending();
            return this.recordSetupInterruption(task, id, createdAt, manifestBaseRef, "interrupted during setup", childCwd, worktree);
          }
          const workspaceId = opened.ok ? opened.pane.workspaceId : void 0;
          if (!opened.ok || !workspaceId) {
            releasePending();
            const reason = opened.ok ? "terminal host returned no workspace id" : opened.error;
            return this.recordSpawnFailure(task, id, createdAt, manifestBaseRef, `unable to open worktree workspace: ${reason}. Worktree created at ${worktree?.path ?? childCwd} is preserved.`, childCwd, worktree);
          }
          placement = { kind: "workspace", workspaceId, paneId: opened.pane.paneId };
        } else if (planned.kind === "tab") placement = planned;
        else placement = { kind: "new-tab", label: planned.kind === "new-tab" ? planned.label : "subagents" };
      }
      if (this.setupInterrupted(id, generation)) {
        releasePending();
        return this.recordSetupInterruption(task, id, createdAt, manifestBaseRef, "interrupted during setup", childCwd, worktree);
      }
      const controller = new AbortController();
      if (placement?.kind === "workspace") this.workspacePlacedIds.add(id);
      let child;
      try {
        child = this.backendFactory({ ...task, cwd: childCwd, id, signal: controller.signal, placement });
      } catch (error) {
        this.workspacePlacedIds.delete(id);
        releasePending();
        const message = error instanceof Error ? error.message : String(error);
        const preservationNote = worktree ? ` Worktree created at ${worktree.path} is preserved.` : "";
        return this.recordSpawnFailure(task, id, createdAt, manifestBaseRef, `unable to spawn child: ${message}.${preservationNote}`, childCwd, worktree);
      }
      const snapshot = makeInitialSnapshot(task, id, createdAt, manifestBaseRef, childCwd, worktree, child.sessionFilePath);
      this.snapshots.set(id, snapshot);
      this.children.set(id, { child, controller });
      releasePending();
      this.consumeEvents(id, child.events);
      if (child.ready) await child.ready;
      this.notify();
      this.prune();
      const synchronousSettle = this.settlingPromises.get(id);
      if (synchronousSettle) await synchronousSettle;
      return this.snapshots.get(id) ?? snapshot;
    } finally {
      this.cancelledSetupIds.delete(id);
      releaseVisibleSpawn?.();
      releasePending();
    }
  }
  get(id) {
    return this.snapshots.get(id);
  }
  list() {
    return [...this.snapshots.values()];
  }
  addChangeListener(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  nextChange(signal) {
    if (signal?.aborted) return Promise.reject(new Error("Aborted"));
    return new Promise((resolve10, reject) => {
      let cleanup = () => void 0;
      const onAbort = () => {
        cleanup();
        reject(new Error("Aborted"));
      };
      const unsubscribe = this.addChangeListener(() => {
        cleanup();
        resolve10();
      });
      cleanup = () => {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  async waitFor(ids, signal, onPending) {
    const unknown = ids.filter((id) => !this.snapshots.has(id));
    if (unknown.length > 0) throw new Error(`Unknown subagent id(s): ${unknown.join(", ")}. Known ids: ${this.list().map((snapshot) => snapshot.id).join(", ") || "(none)"}`);
    for (const id of ids) this.waitInterest.set(id, (this.waitInterest.get(id) ?? 0) + 1);
    try {
      while (true) {
        const snapshots = ids.map((id) => this.snapshots.get(id)).filter((snapshot) => snapshot !== void 0);
        const pending = snapshots.filter((snapshot) => !isSettled(snapshot));
        if (pending.length === 0) {
          for (const snapshot of snapshots) this.consumedIds.add(snapshot.id);
          return snapshots;
        }
        onPending?.(pending);
        await this.nextChange(signal);
      }
    } finally {
      for (const id of ids) {
        const next = (this.waitInterest.get(id) ?? 1) - 1;
        if (next <= 0) this.waitInterest.delete(id);
        else this.waitInterest.set(id, next);
      }
      this.prune();
    }
  }
  async cancel(ids) {
    const lines = /* @__PURE__ */ new Map();
    const targets = [];
    for (const id of ids) {
      const snapshot = this.snapshots.get(id);
      if (!snapshot) {
        lines.set(id, `${id} is unknown`);
        continue;
      }
      const settlingOutcome = this.settlingOutcomes.get(id);
      if (settlingOutcome) {
        lines.set(id, `${id} was already ${settlingOutcome.kind === "completed" ? "done" : "settled"}`);
        continue;
      }
      this.consumedIds.add(id);
      if (isSettled(snapshot)) {
        lines.set(id, `${id} was already ${snapshot.status === "done" ? "done" : "settled"}`);
        continue;
      }
      if (snapshot.status === "queued") {
        const queueIndex = this.queuedTasks.findIndex((queued) => queued.id === id);
        if (queueIndex >= 0) this.queuedTasks.splice(queueIndex, 1);
        else if (this.pendingSpawns.has(id)) this.cancelledSetupIds.add(id);
        void this.startSettle(id, { kind: "interrupted" });
      } else {
        this.children.get(id)?.child.interrupt();
      }
      targets.push(id);
    }
    await Promise.allSettled(targets.map(async (id) => {
      try {
        await this.waitForSettle(id, CANCEL_WAIT_MS);
      } catch {
        await this.startSettle(id, { kind: "interrupted", partialText: this.snapshots.get(id)?.finalText || this.snapshots.get(id)?.liveText });
      }
      lines.set(id, `Cancelled ${id}`);
    }));
    void this.scheduleDequeue();
    return ids.map((id) => lines.get(id) ?? `${id} is unknown`);
  }
  /**
   * Wait until a running child's watcher consumes the steering control and
   * synchronously submits it to Pi. This is not a model-turn delivery ACK.
   * Throws with the same shapes the subagent tools surface directly.
   */
  async sendTo(id, text) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) {
      throw new Error(`Unknown subagent id: ${id}. Known ids: ${this.list().map((known) => known.id).join(", ") || "(none)"}`);
    }
    if (snapshot.status === "queued") {
      throw new Error(`Subagent ${id} is queued and cannot receive input until it starts`);
    }
    if (isSettled(snapshot)) {
      throw new Error(`Subagent ${id} is already settled (${snapshot.status}) and cannot receive input`);
    }
    const child = this.children.get(id)?.child;
    if (!child?.send) {
      throw new Error("headless children cannot receive input \u2014 respawn with visible: true");
    }
    await child.send(text);
    return this.snapshots.get(id) ?? snapshot;
  }
  /**
   * Gracefully close visible children: each child persists its response and
   * exits, settling with a normal completion manifest. Unlike cancel, a
   * close timeout never force-settles — the pane stays genuinely running
   * and the orchestrator can fall back to subagent_cancel.
   */
  async close(ids) {
    const lines = /* @__PURE__ */ new Map();
    const targets = [];
    for (const id of ids) {
      const snapshot = this.snapshots.get(id);
      if (!snapshot) {
        lines.set(id, `${id} is unknown`);
        continue;
      }
      const settlingOutcome = this.settlingOutcomes.get(id);
      if (settlingOutcome) {
        lines.set(id, `${id} was already ${settlingOutcome.kind === "completed" ? "done" : "settled"}`);
        continue;
      }
      if (isSettled(snapshot)) {
        lines.set(id, `${id} was already ${snapshot.status === "done" ? "done" : "settled"}`);
        continue;
      }
      if (snapshot.status === "queued") {
        const queueIndex = this.queuedTasks.findIndex((queued) => queued.id === id);
        if (queueIndex >= 0) this.queuedTasks.splice(queueIndex, 1);
        else if (this.pendingSpawns.has(id)) this.cancelledSetupIds.add(id);
        void this.startSettle(id, { kind: "interrupted" });
        lines.set(id, `Cancelled queued ${id}`);
        continue;
      }
      const child = this.children.get(id)?.child;
      if (!child?.requestClose) {
        lines.set(id, `${id} is headless \u2014 it settles on its own; use subagent_cancel to stop it`);
        continue;
      }
      try {
        child.requestClose();
      } catch (error) {
        lines.set(id, `unable to request close for ${id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      targets.push(id);
    }
    await Promise.allSettled(targets.map(async (id) => {
      try {
        await this.waitForSettle(id, CLOSE_WAIT_MS);
        this.consumedIds.add(id);
        lines.set(id, `Closed ${id}`);
      } catch {
        lines.set(id, `close requested for ${id}; still running \u2014 check the pane or use subagent_cancel`);
      }
    }));
    void this.scheduleDequeue();
    return ids.map((id) => lines.get(id) ?? `${id} is unknown`);
  }
  disposeAll() {
    this.lifecycleGeneration += 1;
    const queuedIds = this.queuedTasks.map((queued) => queued.id);
    this.queuedTasks.length = 0;
    for (const id of queuedIds) void this.startSettle(id, { kind: "interrupted" });
    for (const [id, entry] of this.children) {
      const snapshot = this.snapshots.get(id);
      if (snapshot?.status === "running") entry.child.interrupt();
    }
  }
  scheduleDequeue() {
    const next = this.dequeueTail.then(() => this.drainQueue());
    this.dequeueTail = next.catch(() => void 0);
    return next;
  }
  async drainQueue() {
    while (this.queuedTasks.length > 0 && this.runningSummaries().length < SUBAGENT_MAX_RUNNING) {
      const queued = this.queuedTasks.shift();
      if (!queued) return;
      try {
        await this.startTask(queued.task, queued.id, queued.createdAt, queued.generation);
      } catch (error) {
        const current = this.snapshots.get(queued.id);
        if (current?.status === "queued") {
          this.recordSpawnFailure(
            queued.task,
            queued.id,
            queued.createdAt,
            "HEAD",
            `unable to start queued child: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }
  setupInterrupted(id, generation) {
    return generation !== this.lifecycleGeneration || this.cancelledSetupIds.has(id);
  }
  recordSetupInterruption(task, id, createdAt, baseRef, errorText3, cwd = task.cwd, worktree) {
    const current = this.snapshots.get(id);
    if (current && isSettled(current)) return current;
    return this.recordSpawnFailure(task, id, createdAt, baseRef, errorText3, cwd, worktree);
  }
  async reserveVisibleSpawn() {
    const previous = this.visibleSpawnTail;
    let release = () => void 0;
    this.visibleSpawnTail = new Promise((resolve10) => {
      release = resolve10;
    });
    await previous;
    return release;
  }
  recordSpawnFailure(task, id, createdAt, baseRef, errorText3, cwd = task.cwd, worktree) {
    const snapshot = {
      ...makeInitialSnapshot(task, id, createdAt, baseRef, cwd, worktree),
      status: "error",
      settledAt: Date.now(),
      errorText: errorText3.slice(0, ERROR_TEXT_MAX2)
    };
    this.snapshots.set(id, snapshot);
    this.notify();
    this.prune();
    return snapshot;
  }
  consumeEvents(id, events) {
    const emit = (event) => this.fold(id, event);
    if (!(Symbol.asyncIterator in events)) {
      events(emit);
      return;
    }
    void (async () => {
      for await (const event of events) emit(event);
    })();
  }
  fold(id, event) {
    if (event.kind === "run-settled") {
      this.workspacePlacedIds.delete(id);
      const settling = this.snapshots.get(id);
      if (event.outcome.kind === "failed" && settling?.visible && !settling.pane && this.subagentsTabId !== void 0) {
        this.subagentsTabId = this.initialVisibleTabId;
      }
      void this.startSettle(id, event.outcome);
      return;
    }
    const current = this.snapshots.get(id);
    if (!current) return;
    if (event.kind === "pane-attached") {
      this.snapshots.set(id, { ...current, pane: event.pane });
      const workspacePlaced = this.workspacePlacedIds.delete(id);
      if (event.pane.tabId && !workspacePlaced) this.subagentsTabId = event.pane.tabId;
      this.notify();
      return;
    }
    if (event.kind === "run-started") this.startedIds.add(id);
    if (isSettled(current)) return;
    let next = current;
    if (event.kind === "assistant-delta") next = { ...current, liveText: `${current.liveText}${event.delta}` };
    else if (event.kind === "tool-start") next = { ...current, liveTools: upsertTool(current.liveTools, { id: event.toolId, name: event.name, argsPreview: event.argsPreview, done: false, isError: false }) };
    else if (event.kind === "tool-update") next = { ...current, liveTools: upsertTool(current.liveTools, { id: event.toolId, name: current.liveTools.find((tool) => tool.id === event.toolId)?.name ?? "tool", outputPreview: event.outputPreview, done: false, isError: false }) };
    else if (event.kind === "tool-end") next = { ...current, liveTools: upsertTool(current.liveTools, { id: event.toolId, name: event.name, outputPreview: event.outputPreview, done: true, isError: event.isError }) };
    else if (event.kind === "message-end") next = {
      ...current,
      transcript: [...current.transcript, { role: event.role, text: event.text, createdAt: Date.now() }],
      liveText: event.role === "assistant" ? "" : current.liveText,
      finalText: event.role === "assistant" ? event.text : current.finalText,
      usage: event.role === "assistant" ? { ...current.usage, turns: current.usage.turns + 1 } : current.usage
    };
    else if (event.kind === "usage") next = {
      ...current,
      // Preserve prior values when an event omits a field — an assistant
      // message without usage accounting must not clobber real numbers.
      usage: {
        ...current.usage,
        tokens: event.tokens ?? current.usage.tokens,
        contextWindow: event.contextWindow ?? current.usage.contextWindow,
        costUsd: event.costUsd ?? current.usage.costUsd
      }
    };
    this.snapshots.set(id, next);
    this.notify();
    this.prune();
  }
  startSettle(id, outcome) {
    const existing = this.settlingPromises.get(id);
    if (existing) return existing;
    this.settlingOutcomes.set(id, outcome);
    const promise = this.settle(id, outcome).finally(() => {
      if (this.settlingPromises.get(id) === promise) {
        this.settlingPromises.delete(id);
        this.settlingOutcomes.delete(id);
      }
    });
    this.settlingPromises.set(id, promise);
    return promise;
  }
  async settle(id, outcome) {
    const current = this.snapshots.get(id);
    if (!current || isSettled(current) || this.settlingIds.has(id)) return;
    this.settlingIds.add(id);
    this.children.delete(id);
    const settledAt = Date.now();
    try {
      if (current.status === "queued") {
        this.snapshots.set(id, {
          ...current,
          status: "error",
          settledAt,
          errorText: "interrupted",
          manifest: { exit: "interrupted", durationMs: Math.max(0, settledAt - current.createdAt) }
        });
        if ((this.waitInterest.get(id) ?? 0) > 0) this.consumedIds.add(id);
        this.notify();
        this.prune();
        return;
      }
      const manifest = outcome.kind === "failed" && !this.startedIds.has(id) ? { exit: outcome.kind, durationMs: Math.max(0, settledAt - current.createdAt) } : await this.collectManifest(current, outcome);
      const latest = this.snapshots.get(id);
      if (!latest || isSettled(latest)) return;
      let next;
      if (outcome.kind === "completed") next = { ...latest, status: "done", settledAt, finalText: outcome.finalText || latest.finalText, liveText: "", manifest };
      else if (outcome.kind === "failed") next = { ...latest, status: "error", settledAt, errorText: outcome.errorText.slice(0, ERROR_TEXT_MAX2), finalText: outcome.partialText ?? latest.finalText, liveText: "", manifest };
      else next = { ...latest, status: "error", settledAt, errorText: "interrupted", finalText: outcome.partialText ?? latest.finalText, liveText: "", manifest };
      this.snapshots.set(id, next);
      if ((this.waitInterest.get(id) ?? 0) > 0) this.consumedIds.add(id);
      this.notify();
      this.prune();
    } finally {
      this.settlingIds.delete(id);
      this.startedIds.delete(id);
      void this.scheduleDequeue();
    }
  }
  async collectManifest(snapshot, outcome) {
    const fallback = {
      exit: outcome.kind,
      durationMs: Math.max(0, Date.now() - snapshot.createdAt)
    };
    let timeout;
    try {
      return await Promise.race([
        this.buildCompletionManifestImpl({
          cwd: snapshot.cwd,
          baseRef: snapshot.baseRef,
          outcome,
          startedAt: snapshot.createdAt,
          worktree: snapshot.worktree
        }).catch(() => fallback),
        new Promise((resolve10) => {
          timeout = setTimeout(() => resolve10(fallback), MANIFEST_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  waitForSettle(id, timeoutMs) {
    if (isSettled(this.snapshots.get(id))) return Promise.resolve();
    return new Promise((resolve10, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("cancel timeout"));
      }, timeoutMs);
      const unsubscribe = this.addChangeListener(() => {
        const snapshot = this.snapshots.get(id);
        if (snapshot && isSettled(snapshot)) {
          clearTimeout(timeout);
          unsubscribe();
          resolve10();
        }
      });
    });
  }
  notify() {
    for (const listener of this.listeners) listener();
  }
  prune() {
    const pruneable = this.list().filter((snapshot) => isSettled(snapshot) && !this.waitInterest.has(snapshot.id));
    while (this.snapshots.size > MAX_TRACKED && pruneable.length > 0) {
      const oldest = pruneable.shift();
      if (!oldest) break;
      this.snapshots.delete(oldest.id);
      this.consumedIds.delete(oldest.id);
    }
  }
};

// src/subagents/prompt.ts
var RESULT_OUTPUT_MAX_CHARS = 24 * 1024;
var RESULT_OUTPUT_MAX_LINES = 600;
function boundedResultOutput(output) {
  const lineBounded = output.split("\n").slice(0, RESULT_OUTPUT_MAX_LINES).join("\n");
  return lineBounded.slice(0, RESULT_OUTPUT_MAX_CHARS);
}
var shortRef = (ref) => ref.slice(0, 7);
function dirtyLabel(dirty) {
  return dirty === void 0 ? "dirty unknown" : dirty ? "dirty" : "clean";
}
function formatCompletionManifestSummary(manifest) {
  if (!("baseRef" in manifest)) return `manifest unavailable \xB7 ${manifest.exit} \xB7 ${manifest.durationMs}ms`;
  if (!manifest.branch) return `shared checkout \xB7 base ${shortRef(manifest.baseRef)} \xB7 +${manifest.commits} checkout commits \xB7 changed paths suppressed \xB7 checkout ${dirtyLabel(manifest.dirty)}`;
  const files = `${manifest.changedPaths.length} ${manifest.changedPaths.length === 1 ? "file" : "files"} changed`;
  return `branch: ${manifest.branch} \xB7 base ${shortRef(manifest.baseRef)} \xB7 +${manifest.commits} commits \xB7 ${files} \xB7 ${dirtyLabel(manifest.dirty)}`;
}
function formatCompletionManifest(manifest) {
  const lines = [formatCompletionManifestSummary(manifest)];
  if (!("baseRef" in manifest)) return lines[0];
  if (manifest.changedPaths.length > 0) lines.push(`files: ${manifest.changedPaths.join(", ")}`);
  if (manifest.worktreePath) lines.push(`worktree: ${manifest.worktreePath} (preserved)`);
  return lines.join("\n");
}
function buildSubagentResultMessage(input) {
  const lines = [`Subagent ${input.id} "${input.title}" ${input.status === "done" ? "finished" : "failed"}.`];
  if (input.errorText) lines.push(`Error: ${input.errorText}`);
  const output = boundedResultOutput(input.output);
  if (output) lines.push(output);
  if (input.sessionFilePath) lines.push(`Full transcript: ${input.sessionFilePath}`);
  if (input.manifest) lines.push(`\`\`\`text
${formatCompletionManifest(input.manifest)}
\`\`\``);
  return lines.join("\n\n");
}
var SUBAGENT_PROMPT_GUIDELINES = [
  "Use subagent_spawn for independent research, review, or implementation slices that can proceed while you keep working.",
  "Use visible subagents for long or interactive work the human may want to watch or steer; use headless subagents for silent, bounded fan-out.",
  "All children have their own context, cannot see this conversation, and cannot spawn subagents; prompts must be self-contained with objective, paths, constraints, expected output, and stop conditions.",
  "Use subagent_send to steer a running visible child; success means the child runtime consumed the control and synchronously submitted it to Pi, and Pi exposes no post-acceptance acknowledgement. It does not prove the text was delivered as a Pi steering message or accepted into a model turn, and it is not typed into its terminal. Headless or settled children cannot receive input.",
  "visible children stay open while active and auto-close after 30s of silence; use subagent_close to end one deliberately.",
  "Visible Herdr children split beside the parent when its tab is available, including worktree-backed children; overflow falls back to subagent tabs/workspaces.",
  "delegation is fire-and-forget: after spawning, continue other work or end your turn. settled results arrive as automatic follow-up messages that wake you. do NOT call subagent_wait right after subagent_spawn.",
  "spawn with a role for recurring shapes: research, review, documentor, designer, implement-cheap, implement-smart. the role sets the child's system prompt, tool limits, and defaults; your prompt supplies the concrete objective and stop conditions. read the role list in the spawn tool for per-role defaults \u2014 research and review run in the shared checkout; documentor, designer, and the implement roles default to isolated worktrees.",
  "worktree children branch from committed HEAD \u2014 they cannot see the parent's dirty working tree. run checks of uncommitted edits in the parent, not in a worktree child.",
  "after a worktree child settles, read its completion manifest before acting: +0 commits means nothing to apply; +N commits means review the changed paths, then merge or cherry-pick its sumo/<branch> from the preserved worktree path. worktrees accumulate and are never auto-removed; removing one requires explicit user approval.",
  "if spawn returns status=queued, the child starts automatically when a slot frees \u2014 do not retry, do not wait.",
  `At most ${SUBAGENT_MAX_RUNNING} subagents can run concurrently. If spawn returns status=at_capacity, the queue is full; cancel something or end your turn and respawn later.`,
  "To delegate a self-contained coding task, spawn an isolated, watchable child: `subagent_spawn { visible: true, worktree: true, model, baseRef: 'origin/main' }`. It branches `sumo/<slug>` from baseRef, opens beside the parent when possible (otherwise in a Herdr workspace), and returns a completion manifest to review before acting on the result.",
  "Headless children run WITHOUT the dangerous-command approval gate (same trust model as the native task tool): they cannot prompt the user, so their bash executes directly. Do not delegate destructive commands against the user's checkout; use worktree isolation for write-heavy work. Isolated worktrees are preserved after completion and never auto-removed."
];
var SUBAGENT_PROMPT_SNIPPET = "Spawn, steer, check, wait for, cancel, and list headless or visible subagents with self-contained prompts.";
var SUBAGENT_TOOL_DESCRIPTIONS = {
  spawn: "Start one child subagent and return immediately with its id. Set visible=true for an interactive terminal-host pane, or omit it for silent headless execution. Optionally isolate it in a preserved git worktree. Its result is delivered automatically when it settles; no polling is needed.",
  send: "Submit a Pi steering message to a running visible subagent. Success confirms child-runtime control consumption and synchronous submission, not model-turn acceptance; text is not typed into its terminal.",
  close: "Gracefully close visible subagents: the child saves its final response and exits cleanly, settling with a normal completion manifest. Use subagent_cancel only to abort work.",
  check: "Peek at one subagent without consuming its eventual result.",
  wait: "Block until subagents settle. Last resort: results deliver automatically on settlement; prefer ending your turn. Use only when nothing can proceed without the result.",
  cancel: "Interrupt running subagents and mark their results consumed.",
  list: "List all tracked subagents and their current status."
};

// src/subagents/tools.ts
import { Type as Type5 } from "typebox";
var StringEnum2 = (values, options) => {
  const schema = { type: "string", enum: [...values] };
  return Type5.Unsafe(
    options?.description ? { ...schema, description: options.description } : schema
  );
};
var makeToolResult2 = (text, details) => ({ content: [{ type: "text", text }], details });
var activityEnvelope = (snapshot, sourceId) => {
  const activity = activityFromSubagentSnapshot(snapshot);
  return sourceId ? { ...activity, sourceId } : activity;
};
var isAtCapacity = (value) => "status" in value && value.status === "at_capacity";
var isSettledSnapshot = (snapshot) => snapshot.status !== "running" && snapshot.status !== "queued";
var formatAtCapacity = (details) => {
  const runningLines = details.running.length > 0 ? details.running.map((task) => `- ${task.id}${task.title ? ` \xB7 ${task.title}` : ""} \xB7 ${task.status} \xB7 ${Math.round(task.ageMs / 1e3)}s`).join("\n") : "- (no running subagents found)";
  return makeToolResult2([
    `status=at_capacity \u2014 this is expected, not a failure. ${details.runningCount}/${details.capacity} subagent slots are in use.`,
    "Running subagents:",
    runningLines,
    `Next action: ${details.retryHint}.`
  ].join("\n"), { action: "spawn", ...details });
};
var trimLines = (text, maxChars, maxLines) => {
  const lines = text.split("\n").slice(0, maxLines).join("\n");
  return lines.length > maxChars ? `${lines.slice(0, maxChars - 1)}\u2026` : lines;
};
var cancellationMetadata = (snapshot) => {
  const meta = {
    id: snapshot.id,
    title: trimLines(snapshot.title, 256, 1),
    status: snapshot.status,
    createdAt: snapshot.createdAt
  };
  if (snapshot.settledAt !== void 0) meta.settledAt = snapshot.settledAt;
  return meta;
};
var formatDuration = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1e3));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m${rest}s` : `${rest}s`;
};
var formatSnapshotLine = (snapshot, includeBranch = false) => {
  const model = snapshot.modelLabel ?? "inherit";
  const identity = [snapshot.roleId, model].filter((part) => part !== void 0).join(", ");
  const branch = includeBranch && snapshot.worktree ? ` \xB7 ${snapshot.worktree.branch}` : "";
  const pane = snapshot.pane ? ` \xB7 pane ${snapshot.pane.paneId ?? snapshot.pane.tabId ?? snapshot.pane.workspaceId ?? "unknown"} \xB7 agent ${snapshot.pane.agentName}` : "";
  return `${snapshot.id} [${snapshot.status}] "${snapshot.title}" (${identity}, ${formatDuration(Date.now() - snapshot.createdAt)}, ${snapshot.cwd})${branch}${pane}`;
};
var manifestSummary = (snapshot) => snapshot.manifest ? formatCompletionManifestSummary(snapshot.manifest) : void 0;
var boundedWaitText = (snapshots) => {
  let remaining = 48 * 1024;
  const chunks = [];
  for (const snapshot of snapshots) {
    const errorLine = snapshot.status === "error" && snapshot.errorText ? `error: ${snapshot.errorText}
` : "";
    const body = `${errorLine}${latestText(snapshot) || (errorLine ? "" : snapshot.errorText || "(no output)")}`;
    const perAgent = body.slice(0, 16 * 1024);
    const chunk = [`${snapshot.id} [${snapshot.status}] ${snapshot.title}`, manifestSummary(snapshot), perAgent].filter((line) => line !== void 0).join("\n");
    const bounded2 = chunk.slice(0, remaining);
    chunks.push(bounded2);
    remaining -= bounded2.length;
    if (remaining <= 0) break;
  }
  return chunks.join("\n\n---\n\n");
};
function registerSubagentTools(pi, manager, delivery, host = getTerminalHost(), roleLoader = loadRoles) {
  const registeredRoles = roleLoader().roles;
  const roleDescription = [
    "Optional role preset. Explicit spawn parameters override role defaults. Known roles:",
    ...registeredRoles.map((role) => `${role.id} \u2014 ${role.description}${role.defaultWorktree ? " (isolated worktree by default)" : ""}`)
  ].join("\n");
  pi.registerTool({
    name: "subagent_spawn",
    label: "Subagent Spawn",
    description: SUBAGENT_TOOL_DESCRIPTIONS.spawn,
    promptSnippet: SUBAGENT_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
    parameters: Type5.Object({
      prompt: Type5.String({ description: "Self-contained child subagent prompt." }),
      name: Type5.String({ description: "Short human-readable title for this subagent." }),
      role: Type5.Optional(Type5.String({ description: roleDescription })),
      model: Type5.Optional(Type5.String({ description: "Optional model override as provider/modelId." })),
      thinking: Type5.Optional(StringEnum2(["off", "minimal", "low", "medium", "high", "xhigh", "max"], { description: "Optional thinking level override." })),
      working_dir: Type5.Optional(Type5.String({ description: "Working directory for the child. Defaults to the current project cwd." })),
      worktree: Type5.Optional(Type5.Boolean({ description: "Run the child in an isolated git worktree on a new sumo/<slug> branch from HEAD by default. Its edits never touch your checkout. The worktree is preserved after completion; it is never auto-removed." })),
      branch: Type5.Optional(Type5.String({ description: "Optional branch override for an isolated worktree spawn." })),
      baseRef: Type5.Optional(Type5.String({ description: "Base git ref for the isolated worktree (only with worktree: true); defaults to HEAD. Use origin/main to branch from the pushed tip rather than your local checkout." })),
      visible: Type5.Optional(Type5.Boolean({ description: "Open the child as an interactive pane in the terminal host \u2014 watchable and steerable; requires a running terminal host." }))
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const loaded = roleLoader();
      const loadedRoles = loaded.roles;
      if (params.role && loaded.warnings.length > 0) {
        return makeToolResult2(`Unable to spawn role ${params.role}: roles.json has invalid configuration:
${loaded.warnings.map((warning) => `- ${warning}`).join("\n")}`, {
          action: "spawn",
          status: "invalid_role_config",
          role: params.role,
          warnings: loaded.warnings
        });
      }
      const role = params.role ? loadedRoles.find((candidate) => candidate.id === params.role) : void 0;
      if (params.role && !role) {
        const knownRoles = loadedRoles.map((candidate) => candidate.id);
        return makeToolResult2(`Unknown subagent role: ${params.role}. Known roles: ${knownRoles.join(", ") || "(none)"}.`, {
          action: "spawn",
          status: "unknown_role",
          role: params.role,
          knownRoles
        });
      }
      const visible = params.visible ?? role?.defaultVisible;
      if (visible === true && host.kind === "none") {
        throw new Error("visible subagents require a running herdr terminal host");
      }
      const activeTools = pi.getActiveTools();
      const builtInTools = role?.tools ? role.tools.filter((tool) => activeTools.includes(tool)) : activeTools;
      const spawned = await manager.spawn({
        sourceId: toolCallId,
        prompt: params.prompt,
        title: params.name,
        cwd: params.working_dir ?? ctx.cwd,
        roleId: role?.id,
        appendSystemPrompt: role?.systemPrompt,
        visible,
        worktree: params.worktree ?? role?.defaultWorktree,
        branch: params.branch,
        baseRef: params.baseRef,
        model: params.model ?? role?.model,
        thinking: params.thinking ?? role?.thinking,
        inherited: {
          model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : void 0,
          // Mirror native-task-tool.ts (`pi.getThinkingLevel()` at spawn time):
          // children inherit the parent session's thinking level unless the
          // call overrides it, instead of silently defaulting to "low".
          thinking: pi.getThinkingLevel()
        },
        builtInTools
      });
      if (isAtCapacity(spawned)) return formatAtCapacity(spawned);
      if (spawned.status === "queued") {
        const position = manager.list().filter((snapshot) => snapshot.status === "queued").findIndex((snapshot) => snapshot.id === spawned.id) + 1;
        return makeToolResult2(`Queued ${spawned.id} (${spawned.title}) at position ${position} \u2014 starts automatically when a slot frees. Do not retry or wait.`, {
          action: "spawn",
          subagent: spawned,
          activity: activityEnvelope(spawned, toolCallId)
        });
      }
      if (spawned.status !== "running") {
        delivery?.consume(spawned.id);
        return makeToolResult2(`Subagent ${spawned.id} (${spawned.title}) failed to start: ${spawned.errorText ?? "unknown error"}`, {
          action: "spawn",
          subagent: spawned,
          activity: activityEnvelope(spawned, toolCallId)
        });
      }
      return makeToolResult2(`Started ${spawned.id} (${spawned.title}). No polling needed \u2014 continue other work or END YOUR TURN; the result will be delivered to you and wake you automatically when it settles. Only call subagent_wait if you cannot take a single further step without this result.`, {
        action: "spawn",
        subagent: spawned,
        activity: activityEnvelope(spawned, toolCallId)
      });
    }
  });
  pi.registerTool({
    name: "subagent_send",
    label: "Subagent Send",
    description: SUBAGENT_TOOL_DESCRIPTIONS.send,
    promptSnippet: SUBAGENT_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
    parameters: Type5.Object({
      id: Type5.String({ description: "Running visible subagent id, e.g. sa-1." }),
      text: Type5.String({ minLength: 1, description: "Non-blank steering text to submit to the child runtime." })
    }),
    async execute(_toolCallId, params) {
      if (!params.text.trim()) {
        throw new Error("subagent_send text is required: blank or whitespace-only steering is rejected before submission");
      }
      const snapshot = await manager.sendTo(params.id, params.text);
      return makeToolResult2(`Steering submitted to the child runtime for ${params.id} (${snapshot.title}); Pi exposes no post-acceptance acknowledgement.`, { action: "send", id: params.id, pane: snapshot.pane });
    }
  });
  pi.registerTool({
    name: "subagent_check",
    label: "Subagent Check",
    description: SUBAGENT_TOOL_DESCRIPTIONS.check,
    promptSnippet: SUBAGENT_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
    parameters: Type5.Object({ id: Type5.String({ description: "Subagent id, e.g. sa-1." }) }),
    async execute(_toolCallId, params) {
      const snapshot = manager.get(params.id);
      if (!snapshot) throw new Error(`Unknown subagent id: ${params.id}`);
      const preview = trimLines(latestText(snapshot) || snapshot.errorText || "(no output yet)", 2048, 20);
      return makeToolResult2([formatSnapshotLine(snapshot), manifestSummary(snapshot), preview].filter((line) => line !== void 0).join("\n"), {
        action: "check",
        subagent: snapshot,
        activity: activityEnvelope(snapshot)
      });
    }
  });
  pi.registerTool({
    name: "subagent_wait",
    label: "Subagent Wait",
    description: SUBAGENT_TOOL_DESCRIPTIONS.wait,
    promptSnippet: SUBAGENT_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
    parameters: Type5.Object({ ids: Type5.Array(Type5.String(), { maxItems: 64, description: "Subagent ids to wait for." }) }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const snapshots = await manager.waitFor(params.ids, signal, (pending) => {
        onUpdate?.({
          content: [{ type: "text", text: `Waiting for ${pending.map((snapshot) => snapshot.id).join(", ")}\u2026` }],
          details: {
            action: "wait",
            pending: pending.map((snapshot) => snapshot.id),
            activity: pending.map((snapshot) => activityEnvelope(snapshot))
          }
        });
      });
      for (const snapshot of snapshots) delivery?.consume(snapshot.id);
      return makeToolResult2(boundedWaitText(snapshots), {
        action: "wait",
        subagents: snapshots,
        activity: snapshots.map((snapshot) => activityEnvelope(snapshot))
      });
    }
  });
  pi.registerTool({
    name: "subagent_cancel",
    label: "Subagent Cancel",
    description: SUBAGENT_TOOL_DESCRIPTIONS.cancel,
    promptSnippet: SUBAGENT_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
    parameters: Type5.Object({ ids: Type5.Array(Type5.String(), { maxItems: 64, description: "Subagent ids to cancel." }) }),
    async execute(_toolCallId, params) {
      const lines = await manager.cancel(params.ids);
      const snapshots = params.ids.map((id) => manager.get(id)).filter((snapshot) => snapshot !== void 0);
      for (const snapshot of snapshots) delivery?.consume(snapshot.id);
      return makeToolResult2(lines.join("\n"), {
        action: "cancel",
        ids: params.ids,
        subagents: snapshots.map(cancellationMetadata),
        activity: snapshots.map((snapshot) => activityEnvelope(snapshot))
      });
    }
  });
  pi.registerTool({
    name: "subagent_close",
    label: "Subagent Close",
    description: SUBAGENT_TOOL_DESCRIPTIONS.close,
    promptSnippet: SUBAGENT_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
    parameters: Type5.Object({
      ids: Type5.Array(Type5.String(), { maxItems: 64, description: "Visible subagent ids to close gracefully." })
    }),
    async execute(_toolCallId, params) {
      const lines = await manager.close(params.ids);
      const snapshots = params.ids.map((id) => manager.get(id)).filter((snapshot) => snapshot !== void 0);
      const settled = snapshots.filter(isSettledSnapshot);
      for (const snapshot of settled) delivery?.consume(snapshot.id);
      const text = settled.length > 0 ? `${lines.join("\n")}

${boundedWaitText(settled)}` : lines.join("\n");
      return makeToolResult2(text, {
        action: "close",
        ids: params.ids,
        subagents: settled.map(cancellationMetadata),
        activity: settled.map((snapshot) => activityEnvelope(snapshot))
      });
    }
  });
  pi.registerTool({
    name: "subagent_list",
    label: "Subagent List",
    description: SUBAGENT_TOOL_DESCRIPTIONS.list,
    promptSnippet: SUBAGENT_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
    parameters: Type5.Object({}),
    async execute() {
      const snapshots = manager.list();
      const text = snapshots.length > 0 ? snapshots.map((snapshot) => formatSnapshotLine(snapshot, true)).join("\n") : "No subagents tracked.";
      return makeToolResult2(text, { action: "list", subagents: snapshots });
    }
  });
}

// src/subagents/index.ts
var SUBAGENT_STATUS_WIDGET_KEY = "sumocode-subagents";
var settledPayload = (snapshot) => {
  const result = buildSubagentResultMessage({
    id: snapshot.id,
    title: snapshot.title,
    status: snapshot.status === "done" ? "done" : "error",
    errorText: snapshot.errorText,
    output: snapshot.finalText,
    sessionFilePath: snapshot.sessionFilePath,
    manifest: snapshot.manifest
  });
  const paneLine = snapshot.pane ? `Pane: ${snapshot.pane.paneId ?? snapshot.pane.tabId ?? snapshot.pane.workspaceId ?? "unknown"} \xB7 agent ${snapshot.pane.agentName}` : void 0;
  const roleLine = snapshot.roleId ? `Role: ${snapshot.roleId}` : void 0;
  const metadata = [roleLine, paneLine].filter((line) => line !== void 0).join("\n");
  const details = {
    id: snapshot.id,
    title: snapshot.title,
    status: snapshot.status,
    activity: activityFromSubagentSnapshot(snapshot),
    manifest: snapshot.manifest,
    pane: snapshot.pane
  };
  if (snapshot.roleId !== void 0) details.roleId = snapshot.roleId;
  return {
    id: snapshot.id,
    title: snapshot.title,
    status: snapshot.status,
    content: metadata ? `${result}

${metadata}` : result,
    details
  };
};
function installSubagents(pi, options = {}) {
  const host = options.terminalHost ?? getTerminalHost();
  const spawnPane = options.spawnPaneChild ?? spawnPaneChild;
  const spawnHeadless = options.spawnPiChild ?? spawnPiChild;
  const manager = new SubagentManager((task) => {
    if (task.visible) {
      if (!task.placement) {
        return {
          events: (emit) => emit({ kind: "run-settled", outcome: { kind: "failed", errorText: "visible subagent placement was not resolved" } }),
          interrupt: () => void 0
        };
      }
      const inheritedModel = task.inherited?.model ? `${task.inherited.model.provider}/${task.inherited.model.id}` : void 0;
      const paneBuiltIn = getBuiltInToolsFromActiveTools([...task.builtInTools ?? []]);
      const paneNarrowed = task.builtInTools !== void 0 && paneBuiltIn.length < BUILT_IN_TOOLS.length;
      return spawnPane({
        prompt: task.prompt,
        name: task.title,
        cwd: task.cwd,
        id: task.id,
        model: task.model ?? inheritedModel,
        thinking: task.thinking ?? task.inherited?.thinking,
        tools: paneNarrowed ? paneBuiltIn : void 0,
        appendSystemPrompt: task.appendSystemPrompt,
        signal: task.signal,
        host,
        pi,
        placement: task.placement
      });
    }
    return spawnHeadless({
      prompt: task.prompt,
      cwd: task.cwd,
      model: task.model,
      thinking: task.thinking,
      inherited: task.inherited ?? {},
      builtInTools: getBuiltInToolsFromActiveTools([...task.builtInTools ?? []]),
      appendSystemPrompt: task.appendSystemPrompt,
      signal: task.signal
    });
  }, {
    terminalHost: host,
    pi,
    // Herdr injects the caller tab into the RPC child. Seed visible placement
    // with it so the first child is actually beside the operator instead of
    // disappearing into a background `subagents` tab.
    initialVisibleTabId: host.kind === "herdr" ? process.env.HERDR_TAB_ID : void 0,
    ...options.managerDependencies
  });
  const delivery = createDeferredResultDelivery();
  const observedSettledIds = /* @__PURE__ */ new Set();
  let latestContext;
  let unsubscribe;
  let statusWidgetVisible = false;
  const publishStatusWidget = () => {
    const ctx = latestContext;
    if (!ctx?.hasUI) return;
    const snapshots = manager.list();
    const active = snapshots.filter((snapshot) => snapshot.status === "running" || snapshot.status === "queued");
    try {
      if (active.length === 0) {
        if (statusWidgetVisible) ctx.ui.setWidget(SUBAGENT_STATUS_WIDGET_KEY, void 0, { placement: "aboveEditor" });
        statusWidgetVisible = false;
        return;
      }
      const now = Date.now();
      const running = active.filter((snapshot) => snapshot.status === "running").map((snapshot) => {
        const entry = {
          id: snapshot.id,
          title: snapshot.title,
          ageMs: Math.max(0, now - snapshot.createdAt)
        };
        if (snapshot.roleId !== void 0) entry.roleId = snapshot.roleId;
        return entry;
      });
      const queuedCount = active.length - running.length;
      const render = (width) => renderSubagentStatusRow({ width, running, queuedCount });
      if (ctx.mode === "rpc") {
        ctx.ui.setWidget(SUBAGENT_STATUS_WIDGET_KEY, render(240), { placement: "aboveEditor" });
      } else {
        ctx.ui.setWidget(
          SUBAGENT_STATUS_WIDGET_KEY,
          () => ({ invalidate: () => void 0, render }),
          { placement: "aboveEditor" }
        );
      }
      statusWidgetVisible = true;
    } catch {
    }
  };
  const clearStatusWidget = (ctx) => {
    if (!ctx?.hasUI || !statusWidgetVisible) return;
    try {
      ctx.ui.setWidget(SUBAGENT_STATUS_WIDGET_KEY, void 0, { placement: "aboveEditor" });
    } catch {
    }
    statusWidgetVisible = false;
  };
  const flush = () => {
    for (const payload of delivery.drain()) {
      pi.sendMessage(
        {
          customType: "subagent-result",
          content: payload.content,
          display: true,
          details: payload.details
        },
        { deliverAs: "followUp", triggerTurn: true }
      );
    }
  };
  const onManagerChange = () => {
    for (const snapshot of manager.list()) {
      if (snapshot.status === "running" || snapshot.status === "queued" || observedSettledIds.has(snapshot.id)) continue;
      observedSettledIds.add(snapshot.id);
      if (manager.consumedIds.has(snapshot.id)) delivery.consume(snapshot.id);
      else delivery.defer(snapshot.id, () => settledPayload(snapshot));
    }
    const liveIds = new Set(manager.list().map((snapshot) => snapshot.id));
    for (const id of observedSettledIds) {
      if (!liveIds.has(id)) {
        observedSettledIds.delete(id);
        delivery.forget(id);
      }
    }
    publishStatusWidget();
    if (latestContext?.isIdle()) flush();
  };
  const armDelivery = () => {
    if (unsubscribe) return;
    for (const snapshot of manager.list()) {
      observedSettledIds.add(snapshot.id);
      delivery.consume(snapshot.id);
    }
    unsubscribe = manager.addChangeListener(onManagerChange);
  };
  armDelivery();
  registerSubagentTools(pi, manager, delivery, host);
  pi.on("session_start", (_event, ctx) => {
    latestContext = ctx;
    armDelivery();
    publishStatusWidget();
    if (ctx.isIdle()) flush();
  });
  pi.on("agent_start", (_event, ctx) => {
    latestContext = ctx;
  });
  pi.on("agent_end", (_event, ctx) => {
    latestContext = ctx;
    flush();
  });
  pi.on("session_shutdown", () => {
    clearStatusWidget(latestContext);
    latestContext = void 0;
    unsubscribe?.();
    unsubscribe = void 0;
    delivery.clear();
    manager.disposeAll();
  });
  return manager;
}

// src/task-mode.ts
import { appendFileSync as appendFileSync3, existsSync as existsSync12, readdirSync as readdirSync4, readFileSync as readFileSync16, unlinkSync as unlinkSync3, writeFileSync as writeFileSync10 } from "node:fs";
import { join as join20, resolve as resolve7 } from "node:path";
var TASK_MARKER_ENV_KEYS = [
  "SUMOCODE_TASK_RESPONSE_FILE",
  "SUMOCODE_TASK_EXIT_FILE",
  "SUMOCODE_TASK_STARTED_FILE",
  "SUMOCODE_TASK_DIAG_FILE",
  "SUMOCODE_TASK_CONTROL_DIR"
];
var capturedMarkerEnv;
function captureAndScrubTaskMarkerEnv(env = process.env) {
  const snapshot = { ...capturedMarkerEnv };
  for (const key of TASK_MARKER_ENV_KEYS) {
    const value = env[key];
    if (value !== void 0) {
      snapshot[key] = value;
      delete env[key];
    }
  }
  capturedMarkerEnv = snapshot;
  return snapshot;
}
function diagLog(event, detail) {
  const file = capturedMarkerEnv?.SUMOCODE_TASK_DIAG_FILE ?? process.env.SUMOCODE_TASK_DIAG_FILE;
  if (!file) return;
  try {
    appendFileSync3(
      file,
      `${JSON.stringify({ t: Date.now(), pid: process.pid, event, ...detail ?? void 0 })}
`
    );
  } catch {
  }
}
function isText(value) {
  return typeof value === "string";
}
function extractFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const parts = [];
    for (const block of msg.content) {
      if (block && block.type === "text" && isText(block.text)) {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) return parts.join("\n").trim();
  }
  return "";
}
function persistResponse(messages) {
  const file = capturedMarkerEnv?.SUMOCODE_TASK_RESPONSE_FILE ?? process.env.SUMOCODE_TASK_RESPONSE_FILE;
  if (!file) {
    diagLog("response_skipped", { reason: "no_env" });
    return;
  }
  const text = extractFinalAssistantText(messages);
  if (!text) {
    diagLog("response_skipped", { reason: "no_text" });
    return;
  }
  try {
    writeFileSync10(file, `${text}
`);
    diagLog("response_written", { file, bytes: text.length });
  } catch (error) {
    diagLog("response_write_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
function writeTaskExitMarker(code, env = process.env) {
  const file = env.SUMOCODE_TASK_EXIT_FILE;
  if (!file) return;
  try {
    writeFileSync10(file, `${code}
`);
    diagLog("exit_marker_written", { file, code });
  } catch (error) {
    diagLog("exit_marker_write_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
function writeTaskStartedMarker(env = process.env) {
  const file = env.SUMOCODE_TASK_STARTED_FILE;
  if (!file) return;
  try {
    writeFileSync10(file, `${process.pid}
`);
    diagLog("started_marker_written", { file });
  } catch (error) {
    diagLog("started_marker_write_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
function isNumber2(value) {
  return typeof value === "number";
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isErrnoException(error) {
  return error instanceof Error;
}
function isEnoent(error) {
  return isErrnoException(error) && error.code === "ENOENT";
}
function installTaskExitMarker(env = process.env) {
  if (!env.SUMOCODE_TASK_EXIT_FILE) return;
  process.once("exit", (code) => writeTaskExitMarker(isNumber2(code) ? code : 0, env));
}
var STATUS_KEY = "sumocode-task-auto-exit";
var DEFAULT_GRACE_MS = 3e4;
var TICK_MS2 = 1e3;
var CONTROL_POLL_MS = 500;
var CLOSE_REQUEST_FILE2 = "close.request";
var STEER_FILE_PATTERN = /^steer-(\d+)\.txt$/;
function isActive(env) {
  return env.SUMOCODE_TASK_MODE === "1";
}
function isKeepOpen(env) {
  return env.SUMOCODE_TASK_KEEP_OPEN === "1";
}
function shouldInstallTaskModeAutoExit(options = {}) {
  const env = options.env ?? process.env;
  return isActive(env) && !isKeepOpen(env);
}
var SUBMITTED_CONTROLS_REGISTRY = /* @__PURE__ */ Symbol.for("sumocode.task-mode.submittedControls");
function globalSubmittedControlsScope() {
  return globalThis;
}
function submittedControlsRegistry() {
  const scope = globalSubmittedControlsScope();
  return scope[SUBMITTED_CONTROLS_REGISTRY] ??= /* @__PURE__ */ new Map();
}
var submittedControlsFor = (canonicalControlDir) => {
  const registry = submittedControlsRegistry();
  let bucket = registry.get(canonicalControlDir);
  if (!bucket) {
    bucket = /* @__PURE__ */ new Set();
    registry.set(canonicalControlDir, bucket);
  }
  return bucket;
};
var clearSubmittedControl = (canonicalControlDir, file) => {
  const registry = submittedControlsRegistry();
  const bucket = registry.get(canonicalControlDir);
  if (!bucket?.delete(file)) return;
  if (bucket.size === 0) registry.delete(canonicalControlDir);
};
var isControlSubmitted = (canonicalControlDir, file) => submittedControlsRegistry().get(canonicalControlDir)?.has(file) ?? false;
function installControlWatcher(pi, controlDir, hooks, unlinkControl) {
  if (!controlDir) return () => void 0;
  let stopped = false;
  let timer;
  const canonicalControlDir = resolve7(controlDir);
  const stop = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = void 0;
    }
  };
  const discardSubmittedControl = (file) => {
    try {
      unlinkControl(file);
      clearSubmittedControl(canonicalControlDir, file);
      diagLog("steer_ack_unlinked", { file });
    } catch (error) {
      if (isEnoent(error)) {
        clearSubmittedControl(canonicalControlDir, file);
        diagLog("steer_ack_already_unlinked", { file });
        return;
      }
      diagLog("steer_ack_unlink_failed", { file, message: errorMessage(error) });
    }
  };
  const submitSteer = (file) => {
    if (isControlSubmitted(canonicalControlDir, file)) {
      discardSubmittedControl(file);
      return;
    }
    let text;
    try {
      text = readFileSync16(file, "utf8");
    } catch (error) {
      diagLog("steer_read_failed", { file, message: errorMessage(error) });
      return;
    }
    if (!text.trim()) {
      try {
        unlinkControl(file);
        diagLog("steer_blank_consumed", { file });
      } catch {
      }
      return;
    }
    hooks.cancelCountdown();
    try {
      pi.sendUserMessage(text, { deliverAs: "steer" });
    } catch (error) {
      diagLog("steer_submit_failed", { file, message: errorMessage(error) });
      return;
    }
    submittedControlsFor(canonicalControlDir).add(file);
    try {
      unlinkControl(file);
      clearSubmittedControl(canonicalControlDir, file);
      diagLog("steer_submitted", { file, bytes: text.length });
    } catch (error) {
      if (isEnoent(error)) {
        clearSubmittedControl(canonicalControlDir, file);
        diagLog("steer_ack_already_unlinked", { file, bytes: text.length });
        return;
      }
      diagLog("steer_ack_unlink_failed", { file, message: errorMessage(error) });
    }
  };
  const tick = () => {
    try {
      const ctx = hooks.getLatestCtx();
      if (!ctx) return;
      if (existsSync12(join20(canonicalControlDir, CLOSE_REQUEST_FILE2))) {
        diagLog("close_requested");
        hooks.cancelCountdown();
        stop();
        hooks.requestShutdown(ctx);
        return;
      }
      let entries;
      try {
        entries = readdirSync4(canonicalControlDir);
      } catch {
        return;
      }
      const seqOf = (name) => Number(name.match(STEER_FILE_PATTERN)?.[1] ?? Number.MAX_SAFE_INTEGER);
      const steerFiles = entries.filter((entry) => STEER_FILE_PATTERN.test(entry)).sort((a, b) => seqOf(a) - seqOf(b));
      for (const name of steerFiles) submitSteer(join20(canonicalControlDir, name));
    } catch (error) {
      diagLog("control_poll_failed", { message: errorMessage(error) });
    }
  };
  timer = setInterval(() => {
    if (!stopped) tick();
  }, CONTROL_POLL_MS);
  timer.unref?.();
  return stop;
}
function installTaskModeAutoExit(pi, options = {}) {
  const env = options.env ?? process.env;
  if (!isActive(env)) {
    diagLog("install_skipped", {
      taskMode: env.SUMOCODE_TASK_MODE,
      keepOpen: env.SUMOCODE_TASK_KEEP_OPEN
    });
    return;
  }
  const markers = captureAndScrubTaskMarkerEnv(env);
  writeTaskStartedMarker(markers);
  installTaskExitMarker(markers);
  const countdownEnabled = shouldInstallTaskModeAutoExit(options);
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  let latestCtx;
  let pending;
  let everArmed = false;
  let turnActive = false;
  let closeRequested = false;
  const cancelPending = (ctx) => {
    if (!pending) return;
    clearInterval(pending.tick);
    clearTimeout(pending.shutdown);
    pending = void 0;
    ctx.ui.setStatus(STATUS_KEY, void 0);
  };
  const armCountdown = (ctx) => {
    cancelPending(ctx);
    let remaining = Math.ceil(graceMs / 1e3);
    diagLog(everArmed ? "timer_rearmed" : "timer_armed", { graceMs, remaining });
    everArmed = true;
    ctx.ui.setStatus(STATUS_KEY, `task done \xB7 exiting in ${remaining}s \xB7 type or steer to extend`);
    const tick = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        ctx.ui.setStatus(STATUS_KEY, `task done \xB7 exiting in ${remaining}s \xB7 type or steer to extend`);
      }
    }, TICK_MS2);
    const shutdown = setTimeout(() => {
      diagLog("timer_fired");
      cancelPending(ctx);
      ctx.shutdown();
    }, graceMs);
    pending = { tick, shutdown };
  };
  const shutdownNow = (ctx) => {
    cancelPending(ctx);
    ctx.shutdown();
  };
  const stopWatcher = installControlWatcher(pi, markers.SUMOCODE_TASK_CONTROL_DIR, {
    getLatestCtx: () => latestCtx,
    cancelCountdown: () => {
      if (latestCtx) cancelPending(latestCtx);
    },
    requestShutdown: (ctx) => {
      if (turnActive) {
        closeRequested = true;
        diagLog("close_deferred_active_turn");
        return;
      }
      shutdownNow(ctx);
    }
  }, options.unlink ?? unlinkSync3);
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });
  pi.on("agent_start", (_event, ctx) => {
    latestCtx = ctx;
    turnActive = true;
    if (pending) {
      cancelPending(ctx);
      diagLog("timer_cancelled_agent_start");
    }
  });
  pi.on("agent_end", (event, ctx) => {
    latestCtx = ctx;
    turnActive = false;
    diagLog("agent_end", { pending: pending !== void 0 });
    persistResponse(
      // SAFETY: agent_end carries the completed turn's messages; non-array
      // payloads fall back to an empty list below.
      event.messages ?? []
    );
    if (closeRequested) {
      diagLog("close_completed_after_turn");
      shutdownNow(ctx);
      return;
    }
    if (countdownEnabled) armCountdown(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    diagLog("session_shutdown");
    stopWatcher();
    cancelPending(ctx);
  });
  if (!countdownEnabled) {
    diagLog("install_skipped", {
      taskMode: env.SUMOCODE_TASK_MODE,
      keepOpen: env.SUMOCODE_TASK_KEEP_OPEN
    });
    return;
  }
  diagLog("install", { graceMs });
  pi.on("input", (event, ctx) => {
    latestCtx = ctx;
    diagLog("input", { source: event.source, pending: pending !== void 0 });
    if (event.source !== "interactive") return;
    if (pending) {
      cancelPending(ctx);
      diagLog("timer_cancelled_input");
      ctx.ui.notify("task auto-exit deferred \u2014 the countdown re-arms after this turn", "info");
    }
  });
}

// src/sumo-tui/pi-compat/secret-input.ts
var AUTH_INPUT_PREFIX = "\uE000sumocode-auth-input\uE001";
var SECRET_INPUT_PREFIX = "\uE000sumocode-secret-input\uE001";
function authInputTitle(title, secret = false) {
  return `${secret ? SECRET_INPUT_PREFIX : AUTH_INPUT_PREFIX}${title}`;
}

// src/sumo-tui/pi-compat/login-command.ts
var activeLoginAbort;
var AUTH_LABELS = {
  oauth: "Sign in with an account",
  api_key: "Sign in with an API key"
};
function getRpcLoginRuntime(ctx) {
  const rawRuntime = Reflect.get(ctx.modelRegistry, "runtime");
  if (!isLoginRuntime(rawRuntime)) {
    throw new Error("Pi's authentication runtime is unavailable; update SumoCode's Pi compatibility adapter");
  }
  return rawRuntime;
  function isLoginRuntime(value) {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value;
    return typeof candidate.getAvailable === "function" && typeof candidate.getProviders === "function" && typeof candidate.login === "function";
  }
}
function loginMethods(runtime) {
  const methods = [];
  for (const provider of runtime.getProviders()) {
    if (provider.auth.oauth) methods.push({ provider, authType: "oauth" });
    if (provider.auth.apiKey) methods.push({ provider, authType: "api_key" });
  }
  return methods.sort((a, b) => a.provider.name.localeCompare(b.provider.name));
}
function authLabel(type, methods) {
  if (type === "oauth") {
    const providerLabel = methods.find((method) => method.authType === type)?.provider.auth.oauth?.loginLabel;
    if (providerLabel) return providerLabel;
  }
  return AUTH_LABELS[type];
}
async function chooseAuthType(ctx, methods, signal) {
  const available = ["oauth", "api_key"].filter((type) => methods.some((method) => method.authType === type));
  if (available.length === 1) return available[0];
  const labels = available.map((type) => authLabel(type, methods));
  const selected = await ctx.ui.select(authInputTitle("Select authentication method:"), labels, { signal });
  return available[labels.indexOf(selected ?? "")];
}
async function chooseProvider(ctx, methods, signal) {
  if (methods.length === 0) return void 0;
  if (methods.length === 1) return methods[0];
  const labels = methods.map(({ provider }) => provider.name === provider.id ? provider.id : `${provider.name} (${provider.id})`);
  const selected = await ctx.ui.select(authInputTitle("Select provider:"), labels, { signal });
  const index = labels.indexOf(selected ?? "");
  return index < 0 ? void 0 : methods[index];
}
async function resolveLoginMethod(args, ctx, methods, signal) {
  const providerRef = args.trim().toLowerCase();
  if (providerRef) {
    const matches = methods.filter(({ provider }) => provider.id.toLowerCase() === providerRef || provider.name.toLowerCase() === providerRef);
    if (matches.length === 0) {
      ctx.ui.notify(`Unknown login provider: ${args.trim()}`, "warning");
      return void 0;
    }
    const authType2 = await chooseAuthType(ctx, matches, signal);
    return matches.find((method) => method.authType === authType2);
  }
  const authType = await chooseAuthType(ctx, methods, signal);
  if (!authType) return void 0;
  return chooseProvider(ctx, methods.filter((method) => method.authType === authType), signal);
}
function cancelled() {
  return new Error("Login cancelled");
}
async function showPrompt(ctx, prompt, loginSignal) {
  const promptAbort = new AbortController();
  const signals = prompt.signal ? [loginSignal, prompt.signal] : [loginSignal];
  const abortPrompt = () => promptAbort.abort();
  for (const signal of signals) {
    if (signal.aborted) promptAbort.abort();
    else signal.addEventListener("abort", abortPrompt, { once: true });
  }
  try {
    if (prompt.type === "select") {
      const labels = prompt.options.map((option2) => option2.description ? `${option2.label} \u2014 ${option2.description}` : option2.label);
      const title2 = authInputTitle(prompt.message);
      const selected = await ctx.ui.select(title2, labels, { signal: promptAbort.signal });
      const index = labels.indexOf(selected ?? "");
      const option = prompt.options[index];
      if (!option) throw cancelled();
      return option.id;
    }
    const title = authInputTitle(prompt.message, prompt.type === "secret");
    const value = await ctx.ui.input(title, prompt.placeholder, { signal: promptAbort.signal });
    if (value === void 0) throw cancelled();
    return value;
  } finally {
    for (const signal of signals) signal.removeEventListener("abort", abortPrompt);
  }
}
function publishLoginDetails(ctx, lines) {
  ctx.ui.setWidget("sumocode.login", [...lines], { placement: "aboveEditor" });
  ctx.ui.notify(lines.join("\n"), "info");
}
function showEvent(ctx, event) {
  switch (event.type) {
    case "auth_url":
      publishLoginDetails(ctx, [event.instructions ?? "Open this URL to continue:", event.url]);
      return;
    case "device_code":
      publishLoginDetails(ctx, [`Open ${event.verificationUri}`, `Code: ${event.userCode}`]);
      return;
    case "info": {
      const links = event.links?.map((link) => `${link.label ? `${link.label}: ` : ""}${link.url}`) ?? [];
      publishLoginDetails(ctx, [event.message, ...links]);
      return;
    }
    case "progress":
      ctx.ui.setStatus("sumocode.login", event.message);
  }
}
function errorIdentity(error) {
  if (error instanceof DOMException) return error.name === "AbortError" ? "AbortError" : "DOMException";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof Error) return "Error";
  return "non_error_rejection";
}
function logLoginFailure(attempt, error) {
  logDiagnostic("rpc_login_failed", {
    provider: attempt?.provider.id ?? null,
    authType: attempt?.authType,
    errorName: errorIdentity(error)
  });
}
async function executeRpcLogin(args, ctx, runtime) {
  if (ctx.mode !== "rpc" || !ctx.hasUI) {
    ctx.ui.notify("/login compatibility command requires SumoCode RPC mode", "warning");
    return;
  }
  if (activeLoginAbort) {
    ctx.ui.notify("A login is already in progress", "warning");
    return;
  }
  const loginAbort = new AbortController();
  activeLoginAbort = loginAbort;
  let attempt;
  try {
    await runtime.getAvailable();
    if (loginAbort.signal.aborted) throw cancelled();
    const methods = loginMethods(runtime);
    logDiagnostic("rpc_login_methods", {
      providers: methods.map((entry) => `${entry.provider.id}:${entry.authType}`)
    });
    if (methods.length === 0) {
      ctx.ui.notify("No login providers available", "warning");
      return;
    }
    const method = await resolveLoginMethod(args, ctx, methods, loginAbort.signal);
    if (!method || loginAbort.signal.aborted) return;
    attempt = method;
    const apiKeyMethod = method.provider.auth.apiKey;
    if (method.authType === "api_key" && !apiKeyMethod?.login) {
      ctx.ui.notify(`${apiKeyMethod?.name ?? method.provider.name} is configured outside Pi`, "info");
      return;
    }
    await runtime.login(method.provider.id, method.authType, {
      signal: loginAbort.signal,
      prompt: (prompt) => showPrompt(ctx, prompt, loginAbort.signal),
      notify: (event) => showEvent(ctx, event)
    });
    ctx.ui.notify(`Logged in to ${method.provider.name}`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wasCancelled = loginAbort.signal.aborted || message === "Login cancelled";
    if (!wasCancelled) {
      logLoginFailure(attempt, error);
      ctx.ui.notify("Login failed", "error");
    }
  } finally {
    loginAbort.abort();
    if (activeLoginAbort === loginAbort) activeLoginAbort = void 0;
    ctx.ui.setStatus("sumocode.login", void 0);
    ctx.ui.setWidget("sumocode.login", void 0);
  }
}
function cancelActiveRpcLogin() {
  if (!activeLoginAbort) return false;
  activeLoginAbort.abort();
  return true;
}
function registerRpcLoginCommand(pi, deps = {}) {
  const getRuntime = deps.getRuntime ?? getRpcLoginRuntime;
  pi.registerCommand("login", {
    description: "Configure provider authentication",
    handler: async (args, ctx) => executeRpcLogin(args, ctx, getRuntime(ctx))
  });
  pi.registerCommand("sumo:login-cancel", {
    description: "Cancel the active SumoCode authentication flow",
    handler: async (_args, ctx) => {
      if (cancelActiveRpcLogin()) ctx.ui.notify("Login cancelled", "info");
    }
  });
}

// src/commands/accounts.ts
import { execFile as execFile7 } from "node:child_process";
import { existsSync as existsSync13, lstatSync as lstatSync4, mkdirSync as mkdirSync10, readFileSync as readFileSync17, readlinkSync, realpathSync as realpathSync4, renameSync as renameSync7, rmSync as rmSync4, symlinkSync as symlinkSync2, writeFileSync as writeFileSync11 } from "node:fs";
import { homedir as homedir15 } from "node:os";
import { dirname as dirname13, join as join21, resolve as resolve8 } from "node:path";
import { promisify as promisify5 } from "node:util";
var ACCOUNTS_CONFIG_FILE = "claude-accounts.json";
var LEGACY_CONFIG_FILE = "multi-pass.json";
var ADAPTER_PACKAGE_SOURCE = "git:github.com/dhruvkelawala/pi-claude-oauth-adapter@multi-account";
var execFileAsync4 = promisify5(execFile7);
var sessionPendingReloadProviders = /* @__PURE__ */ new Set();
function resolveAgentDir(deps) {
  return deps.agentDir ?? deps.env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join21(deps.homeDir ?? homedir15(), ".pi", "agent");
}
function resolveAccountsConfigPath(deps = {}) {
  return join21(resolveAgentDir(deps), ACCOUNTS_CONFIG_FILE);
}
function resolvePrivateAccountsPath(deps) {
  const privateConfigDir = resolve8(deps.env?.SUMOCODE_CONFIG_DIR ?? process.env.SUMOCODE_CONFIG_DIR ?? join21(deps.homeDir ?? homedir15(), ".config", "sumocode"));
  return join21(privateConfigDir, ACCOUNTS_CONFIG_FILE);
}
function accountPathsShareParent(targetPath, managedPath) {
  try {
    return realpathSync4(dirname13(targetPath)) === realpathSync4(dirname13(managedPath));
  } catch {
    return false;
  }
}
function ensurePrivateAccountsLink(deps, privatePath) {
  const targetPath = resolveAccountsConfigPath(deps);
  if (accountPathsShareParent(targetPath, privatePath)) return;
  const privateStat = lstatSync4(privatePath);
  if (privateStat.isSymbolicLink() || !privateStat.isFile()) throw new Error(`Expected a regular private accounts source: ${privatePath}`);
  let targetStat;
  try {
    targetStat = lstatSync4(targetPath);
  } catch {
  }
  if (targetStat?.isSymbolicLink()) {
    const linkTarget = resolve8(dirname13(targetPath), readlinkSync(targetPath));
    if (linkTarget !== privatePath) throw new Error(`Refusing to replace an unmanaged accounts symlink: ${targetPath}`);
    return;
  }
  if (targetStat) {
    if (!targetStat.isFile()) throw new Error(`Expected a regular accounts file or managed symlink: ${targetPath}`);
    const backup = `${targetPath}.pre-managed-backup-${Date.now()}`;
    renameSync7(targetPath, backup);
  }
  mkdirSync10(dirname13(targetPath), { recursive: true, mode: 448 });
  symlinkSync2(privatePath, targetPath);
}
function resolveAccountsReadPath(deps) {
  const privatePath = resolvePrivateAccountsPath(deps);
  if (existsSync13(privatePath)) {
    ensurePrivateAccountsLink(deps, privatePath);
    return privatePath;
  }
  return resolveAccountsConfigPath(deps);
}
function pathEntryExists(path2) {
  try {
    lstatSync4(path2);
    return true;
  } catch {
    return false;
  }
}
function resolveAccountsWriteDestination(deps) {
  const targetPath = resolveAccountsConfigPath(deps);
  const managedTarget = resolvePrivateAccountsPath(deps);
  const privateConfigDir = dirname13(managedTarget);
  if (accountPathsShareParent(targetPath, managedTarget)) return { writePath: managedTarget };
  if (pathEntryExists(managedTarget) && lstatSync4(managedTarget).isSymbolicLink()) {
    throw new Error(`Refusing to replace a symlinked private accounts source: ${managedTarget}`);
  }
  let targetStat;
  try {
    targetStat = lstatSync4(targetPath);
  } catch {
  }
  if (targetStat?.isSymbolicLink()) {
    const linkTarget = resolve8(dirname13(targetPath), readlinkSync(targetPath));
    if (linkTarget !== managedTarget) throw new Error(`Refusing to write accounts through an unmanaged symlink: ${targetPath}`);
    return { writePath: managedTarget };
  }
  if (existsSync13(join21(privateConfigDir, ".git"))) return { writePath: managedTarget, linkPath: targetPath };
  return { writePath: targetPath };
}
function resolveLegacyConfigPath(deps) {
  return join21(resolveAgentDir(deps), LEGACY_CONFIG_FILE);
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseSubscription(value) {
  if (!isRecord4(value) || typeof value.provider !== "string" || typeof value.index !== "number") return void 0;
  if (!Number.isInteger(value.index) || value.index < 2) return void 0;
  const label = typeof value.label === "string" ? value.label.trim() : "";
  const subscription = { provider: value.provider, index: value.index };
  if (label) return { ...subscription, label };
  return subscription;
}
function readDocument(path2) {
  if (!existsSync13(path2)) return {};
  try {
    const parsed = JSON.parse(readFileSync17(path2, "utf8"));
    return isRecord4(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function readDocumentForSave(path2) {
  if (!existsSync13(path2)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync17(path2, "utf8"));
  } catch {
    throw new Error(`Invalid accounts config; repair before saving: ${path2}`);
  }
  if (!isRecord4(parsed)) throw new Error(`Invalid accounts config; expected an object: ${path2}`);
  if (parsed.subscriptions !== void 0 && !Array.isArray(parsed.subscriptions)) {
    throw new Error(`Invalid accounts config subscriptions; expected an array: ${path2}`);
  }
  return parsed;
}
function claudeSubscriptionsFrom(document) {
  if (!Array.isArray(document.subscriptions)) return [];
  return document.subscriptions.map(parseSubscription).filter((entry) => entry?.provider === "anthropic").sort((left, right) => left.index - right.index);
}
function loadClaudeSubscriptions(deps = {}) {
  const primaryPath = resolveAccountsReadPath(deps);
  const primary = claudeSubscriptionsFrom(readDocument(primaryPath));
  if (primary.length > 0) return primary;
  if (existsSync13(primaryPath)) return primary;
  return claudeSubscriptionsFrom(readDocument(resolveLegacyConfigPath(deps)));
}
function saveClaudeSubscriptions(subscriptions, deps = {}) {
  const destination = resolveAccountsWriteDestination(deps);
  const primaryPath = resolveAccountsReadPath(deps);
  const document = readDocumentForSave(existsSync13(primaryPath) ? primaryPath : resolveLegacyConfigPath(deps));
  const existing = Array.isArray(document.subscriptions) ? document.subscriptions : [];
  const nonClaude = existing.filter((entry) => parseSubscription(entry)?.provider !== "anthropic");
  const next = {
    ...document,
    [CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
    subscriptions: [...nonClaude, ...subscriptions]
  };
  mkdirSync10(dirname13(destination.writePath), { recursive: true, mode: 448 });
  const temporary = `${destination.writePath}.${process.pid}.tmp`;
  writeFileSync11(temporary, `${JSON.stringify(next, null, 2)}
`, { encoding: "utf8", mode: 384 });
  renameSync7(temporary, destination.writePath);
  if (destination.linkPath) {
    if (pathEntryExists(destination.linkPath)) rmSync4(destination.linkPath, { force: true });
    mkdirSync10(dirname13(destination.linkPath), { recursive: true, mode: 448 });
    symlinkSync2(destination.writePath, destination.linkPath);
  }
}
function nextIndex(subscriptions) {
  const used = new Set(subscriptions.map((entry) => entry.index));
  let index = 2;
  while (used.has(index)) index += 1;
  return index;
}
function packageSource(value) {
  if (typeof value === "string") return value;
  if (isRecord4(value) && typeof value.source === "string") return value.source;
  return void 0;
}
function isAdapterInstalled(deps = {}) {
  const settingsPath = join21(resolveAgentDir(deps), "settings.json");
  if (!existsSync13(settingsPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync17(settingsPath, "utf8"));
    if (!isRecord4(parsed) || !Array.isArray(parsed.packages)) return false;
    return parsed.packages.some((entry) => packageSource(entry) === ADAPTER_PACKAGE_SOURCE);
  } catch {
    return false;
  }
}
async function defaultInstallAdapter() {
  const command = process.env.PI_BIN?.trim() || "pi";
  await execFileAsync4(command, ["install", ADAPTER_PACKAGE_SOURCE], {
    env: process.env,
    timeout: 12e4,
    maxBuffer: 1024 * 1024
  });
}
function accountProviderId(subscription) {
  return `${subscription.provider}-${subscription.index}`;
}
function authConfigured(ctx, providerId) {
  return ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
}
function accounts(ctx, deps) {
  const activeProvider = ctx.model?.provider;
  return [
    {
      providerId: "anthropic",
      label: "default account",
      configured: authConfigured(ctx, "anthropic"),
      active: activeProvider === "anthropic"
    },
    ...loadClaudeSubscriptions(deps).map((subscription) => ({
      providerId: accountProviderId(subscription),
      label: subscription.label ?? `Claude account ${subscription.index}`,
      subscription,
      configured: authConfigured(ctx, accountProviderId(subscription)),
      active: activeProvider === accountProviderId(subscription)
    }))
  ];
}
async function defaultLogin(providerId, ctx) {
  let runtime;
  try {
    runtime = getRpcLoginRuntime(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDiagnostic("accounts_login_runtime_unavailable", { provider: providerId, errorMessage: message });
    ctx.ui.notify(`Sign-in unavailable: ${message}`, "error");
    return;
  }
  logDiagnostic("accounts_login_start", { provider: providerId });
  await executeRpcLogin(providerId, ctx, runtime);
}
function accountState(account, hasActiveClaudeAccount) {
  if (account.active) return "in use";
  if (!account.configured) return "sign in required";
  return hasActiveClaudeAccount ? "signed in" : "inactive";
}
function accountRow(account, hasActiveClaudeAccount) {
  return `${account.label} \xB7 ${accountState(account, hasActiveClaudeAccount)}  ${account.providerId}`;
}
function pendingReloadProviders(deps) {
  return deps.pendingReloadProviders ?? sessionPendingReloadProviders;
}
async function installAdapterPackage(ctx, deps) {
  ctx.ui.setStatus("sumocode.accounts", "installing pi-claude-oauth-adapter\u2026");
  try {
    await (deps.installAdapter ?? defaultInstallAdapter)();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDiagnostic("accounts_install_adapter_failed", { errorMessage: message });
    ctx.ui.notify(`Unable to install pi-claude-oauth-adapter: ${message}`, "error");
    return false;
  } finally {
    ctx.ui.setStatus("sumocode.accounts", void 0);
  }
}
async function ensureAdapterInstalled(ctx, deps) {
  if (isAdapterInstalled(deps)) return true;
  const install = await ctx.ui.confirm(
    "SET UP MULTI-ACCOUNT CLAUDE",
    "/accounts needs the Claude OAuth adapter (pi-claude-oauth-adapter) to register and sign in extra accounts. Install it now?"
  );
  return install ? installAdapterPackage(ctx, deps) : false;
}
async function addAccount(ctx, deps) {
  if (!await ensureAdapterInstalled(ctx, deps)) return;
  const subscriptions = loadClaudeSubscriptions(deps);
  const index = nextIndex(subscriptions);
  const suggestedLabel = index === 2 ? "company" : `Claude account ${index}`;
  const label = await ctx.ui.input("ACCOUNT LABEL", suggestedLabel);
  if (label === void 0) return;
  const subscription = {
    provider: "anthropic",
    index,
    label: label.trim() || suggestedLabel
  };
  saveClaudeSubscriptions([...subscriptions, subscription], deps);
  pendingReloadProviders(deps).add(`anthropic-${index}`);
  ctx.ui.notify(`Added ${subscription.label} as anthropic-${index}`, "info");
  const reload = await ctx.ui.confirm(
    "RELOAD TO ACTIVATE ACCOUNT",
    "Reload SumoCode now? After reload, open /accounts and sign in to the new account."
  );
  if (reload) await (deps.reload ?? ((reloadCtx) => executeSumoReload(reloadCtx)))(ctx);
}
async function switchAccount(pi, ctx, account) {
  if (!account.configured) {
    ctx.ui.notify(`${account.label} must be signed in before it can be selected`, "warning");
    return;
  }
  const models = ctx.modelRegistry.getAll().filter((model) => model.provider === account.providerId);
  const target = models.find((model) => model.id === ctx.model?.id) ?? models[0];
  if (!target) {
    ctx.ui.notify(`${account.providerId} is not active; reload SumoCode after adding the account`, "warning");
    return;
  }
  const selected = await pi.setModel(target);
  ctx.ui.notify(selected ? `Using ${account.label} \xB7 ${target.id}` : `Unable to select ${account.label}`, selected ? "info" : "error");
}
async function renameAccount(ctx, account, deps) {
  if (!account.subscription) return;
  const label = await ctx.ui.input("ACCOUNT LABEL", account.label);
  if (label === void 0 || !label.trim()) return;
  const subscriptions = loadClaudeSubscriptions(deps).map(
    (entry) => entry.index === account.subscription?.index ? { ...entry, label: label.trim() } : entry
  );
  saveClaudeSubscriptions(subscriptions, deps);
  ctx.ui.notify(`Renamed ${account.providerId} to ${label.trim()}`, "info");
}
async function accountActions(pi, ctx, account, deps) {
  if (account.subscription) {
    if (!isAdapterInstalled(deps)) {
      if (!await ensureAdapterInstalled(ctx, deps)) return;
      ctx.ui.notify("pi-claude-oauth-adapter installed. Reload SumoCode, then re-open /accounts.", "info");
      await (deps.reload ?? ((reloadCtx) => executeSumoReload(reloadCtx)))(ctx);
      return;
    }
    const providerRegistered = ctx.modelRegistry.getAll().some((model) => model.provider === account.providerId);
    if (!providerRegistered) {
      if (pendingReloadProviders(deps).has(account.providerId)) {
        ctx.ui.notify(`${account.providerId} is not registered in this session. Reloading SumoCode\u2026`, "info");
        await (deps.reload ?? ((reloadCtx) => executeSumoReload(reloadCtx)))(ctx);
        return;
      }
      const repair = await ctx.ui.confirm(
        "REPAIR MULTI-ACCOUNT CLAUDE",
        `${account.providerId} failed to register during startup. Reinstall the adapter and reload?`
      );
      if (!repair) {
        ctx.ui.notify(`${account.providerId} remains unavailable until the adapter is repaired`, "warning");
        return;
      }
      if (!await installAdapterPackage(ctx, deps)) return;
      await (deps.reload ?? ((reloadCtx) => executeSumoReload(reloadCtx)))(ctx);
      return;
    }
  }
  const actions = [
    ...account.configured && !account.active ? ["use this account"] : [],
    account.configured ? "sign in again" : "sign in",
    ...account.subscription ? ["rename account"] : []
  ];
  const action = await ctx.ui.select(`${account.label.toUpperCase()} \xB7 ${account.providerId}`, actions);
  if (action === "use this account") await switchAccount(pi, ctx, account);
  else if (action === "sign in" || action === "sign in again") {
    await (deps.login ?? defaultLogin)(account.providerId, ctx);
  } else if (action === "rename account") await renameAccount(ctx, account, deps);
}
async function executeAccountsCommand(pi, ctx, deps = {}) {
  if (ctx.mode !== "rpc" || !ctx.hasUI) {
    ctx.ui.notify("/accounts requires the SumoCode RPC interface", "warning");
    return;
  }
  const accountList = accounts(ctx, deps);
  const hasActiveClaudeAccount = accountList.some((account2) => account2.active);
  const rows = accountList.map((account2) => accountRow(account2, hasActiveClaudeAccount));
  const addLabel = "add Claude account";
  const selected = await ctx.ui.select("CLAUDE ACCOUNTS", [...rows, addLabel]);
  if (selected === addLabel) {
    await addAccount(ctx, deps);
    return;
  }
  const account = accountList[rows.indexOf(selected ?? "")];
  if (account) await accountActions(pi, ctx, account, deps);
}
function registerAccountsCommand(pi, deps = {}) {
  pi.registerCommand("accounts", {
    description: "Manage and switch Claude subscription accounts",
    handler: async (_args, ctx) => executeAccountsCommand(pi, ctx, deps)
  });
}

// src/herdr-rpc-bridge.ts
import net from "node:net";
var SOURCE = "herdr:pi";
var AGENT = "pi";
var DISPLAY_SOURCE = "sumocode:display";
var DISPLAY_AGENT = "sumocode";
var STATE_RETRY_DELAY_MS = 2e3;
function socketEndpoint(path2) {
  return process.platform === "win32" ? `\\\\.\\pipe\\${path2}` : path2;
}
function sendSocketRequestAttempt(path2, request, timeoutMs) {
  return new Promise((resolve10) => {
    let settled = false;
    let timeout;
    const socket = net.createConnection(socketEndpoint(path2));
    const finish = (delivered) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      socket.destroy();
      resolve10(delivered);
    };
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}
`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}
async function sendRequest(attempt, request) {
  if (await attempt(request, 500)) return true;
  return attempt(request, 1500);
}
var isAbsolutePath = (value) => typeof value === "string" && value.startsWith("/");
var isNonEmptyString2 = (value) => typeof value === "string" && value.length > 0;
function sessionRef(ctx) {
  try {
    const path2 = ctx.sessionManager?.getSessionFile?.();
    if (isAbsolutePath(path2)) return { agent_session_path: path2 };
  } catch {
  }
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    if (isNonEmptyString2(id)) return { agent_session_id: id };
  } catch {
  }
  return {};
}
function installHerdrRpcBridge(pi, options = {}) {
  const env = options.env ?? process.env;
  const paneId2 = env.HERDR_PANE_ID;
  const path2 = env.HERDR_SOCKET_PATH;
  if (env.SUMOCODE_RPC_CHILD !== "1" || env.HERDR_ENV !== "1" || !paneId2 || !path2) return;
  const attempt = options.sendRequestAttempt ?? ((request, timeoutMs) => sendSocketRequestAttempt(path2, request, timeoutMs));
  const send = (request) => sendRequest(attempt, request);
  let seq = Date.now() * 1e3;
  let active = false;
  let blockedCount = 0;
  let blockedMessage;
  let currentContext;
  let lastState;
  let lastMessage;
  const nextSeq = () => ++seq;
  const requestId = (kind) => `${SOURCE}:${kind}:${Date.now()}:${nextSeq()}`;
  const reportSession = async (ctx, reason) => {
    const ref = sessionRef(ctx);
    if (!ref.agent_session_path && !ref.agent_session_id) return;
    await send({
      id: requestId("session"),
      method: "pane.report_agent_session",
      params: {
        pane_id: paneId2,
        source: SOURCE,
        agent: AGENT,
        seq: nextSeq(),
        session_start_source: reason,
        ...ref
      }
    });
  };
  let stopped = false;
  const buildDisplayNameRequest = () => ({
    id: requestId("display"),
    method: "pane.report_metadata",
    params: {
      pane_id: paneId2,
      source: DISPLAY_SOURCE,
      agent: AGENT,
      display_agent: DISPLAY_AGENT,
      seq: nextSeq()
    }
  });
  let displayRequest;
  let displaySendInFlight = false;
  let displayRetryTimer;
  const scheduleDisplayRetry = () => {
    if (stopped || displayRetryTimer !== void 0 || displayRequest === void 0) return;
    displayRetryTimer = setTimeout(() => {
      displayRetryTimer = void 0;
      void drainDisplayReport();
    }, STATE_RETRY_DELAY_MS);
    displayRetryTimer.unref?.();
  };
  const drainDisplayReport = async () => {
    if (stopped || displaySendInFlight || displayRetryTimer !== void 0 || displayRequest === void 0) return;
    displaySendInFlight = true;
    try {
      let delivered = false;
      try {
        delivered = await send(displayRequest);
      } catch {
      }
      if (delivered) displayRequest = void 0;
    } finally {
      displaySendInFlight = false;
      if (!stopped && displayRequest !== void 0) scheduleDisplayRetry();
    }
  };
  const reportDisplayName = async () => {
    displayRequest ??= buildDisplayNameRequest();
    await drainDisplayReport();
  };
  const queuedStates = [];
  let sendInFlight = false;
  let stateRetryTimer;
  const sendState = (state) => {
    const params = {
      pane_id: paneId2,
      source: SOURCE,
      agent: AGENT,
      state: state.state,
      message: state.message,
      seq: state.seq
    };
    if (currentContext) Object.assign(params, sessionRef(currentContext));
    return send({ id: requestId("state"), method: "pane.report_agent", params });
  };
  const scheduleStateRetry = () => {
    if (stopped || stateRetryTimer !== void 0 || queuedStates.length === 0) return;
    stateRetryTimer = setTimeout(() => {
      stateRetryTimer = void 0;
      void drainStateQueue();
    }, STATE_RETRY_DELAY_MS);
    stateRetryTimer.unref?.();
  };
  const drainStateQueue = async () => {
    if (stopped || sendInFlight || stateRetryTimer !== void 0) return;
    sendInFlight = true;
    try {
      while (!stopped) {
        const state = queuedStates[0];
        if (!state) return;
        let delivered = false;
        try {
          delivered = await sendState(state);
        } catch {
        }
        if (!delivered) return;
        queuedStates.shift();
      }
    } finally {
      sendInFlight = false;
      if (!stopped && queuedStates.length > 0) scheduleStateRetry();
    }
  };
  const publishState = (force = false) => {
    const state = blockedCount > 0 ? "blocked" : active ? "working" : "idle";
    const message = blockedCount > 0 ? blockedMessage : void 0;
    if (!force && state === lastState && message === lastMessage) return;
    lastState = state;
    lastMessage = message;
    queuedStates.push({ state, message, seq: nextSeq() });
    void drainStateQueue();
  };
  const eventBus = pi.events;
  eventBus?.on?.("herdr:blocked", (data) => {
    const report2 = typeof data === "object" && data !== null ? data : void 0;
    if (report2?.active) {
      blockedCount += 1;
      blockedMessage = report2.label;
    } else {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedMessage = void 0;
    }
    void publishState();
  });
  pi.on("session_start", async (event, ctx) => {
    currentContext = ctx;
    active = ctx.isIdle?.() === false;
    await reportSession(currentContext, event.reason);
    await reportDisplayName();
    publishState(true);
  });
  pi.on("agent_start", (_event, ctx) => {
    currentContext = ctx;
    active = true;
    void reportSession(currentContext);
    void publishState();
  });
  pi.on("agent_settled", (_event, ctx) => {
    currentContext = ctx;
    if (ctx.isIdle?.() !== true) return;
    active = false;
    void publishState();
  });
  pi.on("session_shutdown", (event) => {
    stopped = true;
    if (stateRetryTimer !== void 0) {
      clearTimeout(stateRetryTimer);
      stateRetryTimer = void 0;
    }
    if (displayRetryTimer !== void 0) {
      clearTimeout(displayRetryTimer);
      displayRetryTimer = void 0;
    }
    displayRequest = void 0;
    queuedStates.length = 0;
    if (event.reason !== "quit") return;
    void send({
      id: requestId("release"),
      method: "pane.release_agent",
      params: { pane_id: paneId2, source: SOURCE, agent: AGENT, seq: nextSeq() }
    });
  });
}

// src/sumo-tui/pi-compat/tree-navigation-command.ts
function isPayloadObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString6(value) {
  return typeof value === "string";
}
var RPC_TREE_NAVIGATION_COMMAND = "sumo:rpc-tree-navigate";
var RPC_TREE_NAVIGATION_RESULT_STATUS_KEY = "sumocode.rpc-tree-navigation-result";
var MAX_TREE_NAVIGATION_ENCODED_BYTES = 24576;
var MAX_TREE_NAVIGATION_JSON_BYTES = 18432;
var MAX_TREE_NAVIGATION_TARGET_BYTES = 256;
var MAX_TREE_NAVIGATION_INSTRUCTIONS_BYTES = 16384;
var MAX_TREE_NAVIGATION_EDITOR_TEXT_BYTES = 20480;
var MAX_TREE_NAVIGATION_OUTCOME_JSON_BYTES = 24576;
function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}
function isCanonicalUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
function isControlCharacter(character) {
  const code = character.codePointAt(0) ?? 0;
  return code <= 31 || code === 127;
}
function decodeBase64Url(encoded) {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("tree navigation payload is not canonical base64url");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== encoded) throw new Error("tree navigation payload is not canonical base64url");
  return decoded;
}
function exactKeys(value, allowed) {
  const keys = Object.keys(value).sort();
  const sortedAllowed = [...allowed].sort();
  return keys.length === sortedAllowed.length && keys.every((key, index) => key === sortedAllowed[index]);
}
function validateRpcTreeNavigationRequest(value) {
  if (!isPayloadObject2(value)) throw new Error("tree navigation request must be an object");
  const record = value;
  const allowed = record.summarize === true ? ["requestId", "targetId", "summarize", ...Object.hasOwn(record, "customInstructions") ? ["customInstructions"] : []] : ["requestId", "targetId", "summarize"];
  if (!exactKeys(record, allowed)) throw new Error("tree navigation request has unknown or invalid fields");
  if (!isCanonicalUuid(record.requestId)) throw new Error("tree navigation requestId must be a canonical UUID");
  if (typeof record.targetId !== "string") throw new Error("tree navigation targetId must be a string");
  const targetId = record.targetId.trim();
  if (utf8Bytes(targetId) < 1 || utf8Bytes(targetId) > MAX_TREE_NAVIGATION_TARGET_BYTES || [...targetId].some(isControlCharacter)) {
    throw new Error("tree navigation targetId is invalid");
  }
  if (typeof record.summarize !== "boolean") throw new Error("tree navigation summarize must be boolean");
  if (record.summarize === false && Object.hasOwn(record, "customInstructions")) throw new Error("customInstructions requires summarize");
  if (record.summarize === true && Object.hasOwn(record, "customInstructions") && (typeof record.customInstructions !== "string" || utf8Bytes(record.customInstructions) > MAX_TREE_NAVIGATION_INSTRUCTIONS_BYTES)) {
    throw new Error("tree navigation customInstructions is too large");
  }
}
function parseRequestJson(decoded) {
  if (decoded.byteLength > MAX_TREE_NAVIGATION_JSON_BYTES) throw new Error("tree navigation payload is too large");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(decoded).toString("utf8"));
  } catch {
    throw new Error("tree navigation payload is malformed JSON");
  }
  if (!isPayloadObject2(parsed)) throw new Error("tree navigation payload must be an object");
  validateRpcTreeNavigationRequest(parsed);
  if (isString6(parsed.customInstructions)) {
    return { requestId: parsed.requestId, targetId: parsed.targetId.trim(), summarize: parsed.summarize, customInstructions: parsed.customInstructions };
  }
  return { requestId: parsed.requestId, targetId: parsed.targetId.trim(), summarize: parsed.summarize };
}
function decodeRpcTreeNavigationPayload(encoded) {
  if (utf8Bytes(encoded) > MAX_TREE_NAVIGATION_ENCODED_BYTES) throw new Error("tree navigation payload is too large");
  return parseRequestJson(decodeBase64Url(encoded));
}
function boundedOutcome(outcome) {
  if (outcome.editorText !== void 0 && utf8Bytes(outcome.editorText) > MAX_TREE_NAVIGATION_EDITOR_TEXT_BYTES) {
    return { requestId: outcome.requestId, status: outcome.status, leafId: outcome.leafId };
  }
  return outcome;
}
function encodeRpcTreeNavigationOutcome(outcome) {
  const bounded2 = boundedOutcome(outcome);
  const json = JSON.stringify(bounded2);
  if (utf8Bytes(json) > MAX_TREE_NAVIGATION_OUTCOME_JSON_BYTES) throw new Error("tree navigation outcome is too large");
  return Buffer.from(json, "utf8").toString("base64url");
}
function entryEditorText(entry) {
  if (!isPayloadObject2(entry)) return void 0;
  const record = entry;
  if (record.type === "message") {
    if (!isPayloadObject2(record.message)) return void 0;
    const message = record.message;
    if (message.role !== "user") return void 0;
    const text = contentText(message.content);
    return utf8Bytes(text) <= MAX_TREE_NAVIGATION_EDITOR_TEXT_BYTES ? text : void 0;
  }
  if (record.type === "custom_message") {
    const text = contentText(record.content);
    return utf8Bytes(text) <= MAX_TREE_NAVIGATION_EDITOR_TEXT_BYTES ? text : void 0;
  }
  return void 0;
}
function isTextBlock(value) {
  return isPayloadObject2(value) && value.type === "text" && isString6(value.text);
}
function contentText(content) {
  if (isString6(content)) return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isTextBlock).map((block) => block.text).join("");
}
function recoverRequestId(encoded) {
  try {
    if (utf8Bytes(encoded) > MAX_TREE_NAVIGATION_ENCODED_BYTES) return void 0;
    const decoded = decodeBase64Url(encoded);
    const parsed = JSON.parse(Buffer.from(decoded).toString("utf8"));
    if (!isPayloadObject2(parsed)) return void 0;
    const requestId = parsed.requestId;
    return isCanonicalUuid(requestId) ? requestId : void 0;
  } catch {
    return void 0;
  }
}
function publishTreeNavigationError(ctx, requestId) {
  const outcome = { requestId, status: "error", leafId: ctx.sessionManager.getLeafId() };
  ctx.ui.setStatus(RPC_TREE_NAVIGATION_RESULT_STATUS_KEY, encodeRpcTreeNavigationOutcome(outcome));
  ctx.ui.notify("invalid tree navigation request", "warning");
}
async function executeRpcTreeNavigation(encoded, ctx) {
  if (ctx.mode !== "rpc" || !ctx.hasUI) {
    ctx.ui.notify("tree navigation requires SumoCode RPC mode", "warning");
    return;
  }
  let request;
  try {
    request = decodeRpcTreeNavigationPayload(encoded);
  } catch {
    const requestId = recoverRequestId(encoded);
    if (requestId) publishTreeNavigationError(ctx, requestId);
    else ctx.ui.notify("invalid tree navigation request", "warning");
    return;
  }
  let editorText;
  try {
    editorText = entryEditorText(ctx.sessionManager.getEntry(request.targetId));
    const navigateOptions = request.customInstructions === void 0 ? { summarize: request.summarize } : { summarize: request.summarize, customInstructions: request.customInstructions };
    const result = await ctx.navigateTree(request.targetId, navigateOptions);
    const leafId = ctx.sessionManager.getLeafId();
    const outcome = result.cancelled || editorText === void 0 ? { requestId: request.requestId, status: result.cancelled ? "cancelled" : "committed", leafId } : { requestId: request.requestId, status: "committed", leafId, editorText };
    ctx.ui.setStatus(RPC_TREE_NAVIGATION_RESULT_STATUS_KEY, encodeRpcTreeNavigationOutcome(outcome));
  } catch {
    const outcome = {
      requestId: request.requestId,
      status: "error",
      leafId: ctx.sessionManager.getLeafId()
    };
    ctx.ui.setStatus(RPC_TREE_NAVIGATION_RESULT_STATUS_KEY, encodeRpcTreeNavigationOutcome(outcome));
    ctx.ui.notify("tree navigation failed", "error");
  }
}
function registerRpcTreeNavigationCommand(pi) {
  pi.registerCommand(RPC_TREE_NAVIGATION_COMMAND, {
    description: "Navigate the current session tree",
    handler: async (args, ctx) => executeRpcTreeNavigation(args.trim(), ctx)
  });
}

// src/extension.ts
var SUMOCODE_PACKAGE_NAME = "@dhruvkelawala/sumocode";
var LEGACY_TASK_TOOL_EXTENSION_PATH = join22(".pi", "agent", "extensions", "task-tool", "index.ts");
function canonicalize(path2, realpath) {
  try {
    return realpath(path2);
  } catch {
    return resolve9(path2);
  }
}
function moduleUrlToPath2(moduleUrl) {
  try {
    return moduleUrl.startsWith("file:") ? fileURLToPath5(moduleUrl) : moduleUrl;
  } catch {
    return moduleUrl;
  }
}
function isInstalledPiAgentGitModule(moduleUrl, homeDir = homedir16()) {
  const modulePath = resolve9(moduleUrlToPath2(moduleUrl));
  const agentGitRoot = `${resolve9(homeDir, ".pi", "agent", "git")}${sep}`;
  return modulePath.startsWith(agentGitRoot);
}
function packageNameAt2(dir, exists, readFile) {
  const packagePath = join22(dir, "package.json");
  if (!exists(packagePath)) return void 0;
  try {
    const parsed = JSON.parse(readFile(packagePath, "utf8"));
    return asOptionalString(parsed.name) ? parsed.name : void 0;
  } catch {
    return void 0;
  }
}
function packageRootFromModulePath(modulePath, exists, readFile) {
  let current = dirname14(modulePath);
  for (let level = 0; level < 5; level += 1) {
    if (packageNameAt2(current, exists, readFile) === SUMOCODE_PACKAGE_NAME) return current;
    const parent = dirname14(current);
    if (parent === current) return void 0;
    current = parent;
  }
  return void 0;
}
function findActiveSumoDevTree2(cwd, options = {}) {
  const exists = options.exists ?? existsSync14;
  const readFile = options.readFile ?? ((path2, encoding) => readFileSync18(path2, encoding));
  let current = resolve9(cwd);
  while (true) {
    const isSumocodePackage = packageNameAt2(current, exists, readFile) === SUMOCODE_PACKAGE_NAME;
    const hasExtensionSource = exists(join22(current, "src", "extension.ts"));
    const hasGitMetadata = exists(join22(current, ".git"));
    if (isSumocodePackage && hasExtensionSource && hasGitMetadata) return current;
    const parent = dirname14(current);
    if (parent === current) return void 0;
    current = parent;
  }
}
function shouldNoopDuplicateInstalledExtension(options = {}) {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  if (!isInstalledPiAgentGitModule(moduleUrl, options.homeDir ?? homedir16())) return false;
  const env = options.env ?? process.env;
  const launcherRoot = env.SUMOCODE_ROOT_DIR;
  if (launcherRoot) {
    const realpath = options.realpath ?? ((path2) => realpathSync5(path2));
    const exists = options.exists ?? existsSync14;
    const readFile = options.readFile ?? ((path2, encoding) => readFileSync18(path2, encoding));
    const modulePath = canonicalize(moduleUrlToPath2(moduleUrl), realpath);
    const packageRoot = packageRootFromModulePath(modulePath, exists, readFile);
    const canonicalLauncherRoot = canonicalize(launcherRoot, realpath);
    if (packageRoot !== void 0 && canonicalize(packageRoot, realpath) === canonicalLauncherRoot) return false;
    const moduleDir = dirname14(modulePath);
    const grandparent = dirname14(moduleDir);
    if (grandparent === canonicalLauncherRoot) return false;
    return true;
  }
  if (env.SUMOCODE_LAUNCHER) return true;
  return findActiveSumoDevTree2(options.cwd ?? process.cwd(), options) !== void 0;
}
function hasLegacyTaskToolExtension(options = {}) {
  const exists = options.exists ?? existsSync14;
  return exists(join22(options.homeDir ?? homedir16(), LEGACY_TASK_TOOL_EXTENSION_PATH));
}
function shouldInstallNativeTaskTool(options = {}) {
  if (options.force === "1" || options.force === "true") return true;
  return !hasLegacyTaskToolExtension(options);
}
function shouldNoopHelperSubprocess(options = {}) {
  const env = options.env ?? process.env;
  return env.SUMOCODE_BG_CHILD === "1";
}
function isTaskMode(options = {}) {
  const env = options.env ?? process.env;
  return env.SUMOCODE_TASK_MODE === "1";
}
function isRpcChildProfile(options = {}) {
  const env = options.env ?? process.env;
  return env.SUMOCODE_RPC_CHILD === "1";
}
function installOrchestrationTools(pi) {
  const terminalTaskManager = installBackgroundTasks(pi);
  installTerminalTools(pi, terminalTaskManager);
  const subagentManager = installSubagents(pi);
  const activityBridge = installActivityManagerBridge(pi, terminalTaskManager, subagentManager);
  return { terminalTaskManager, subagentManager, activityBridge };
}
function installRpcChildProfile(pi) {
  installHerdrRpcBridge(pi);
  installSkillInlineExpansion(pi);
  registerRpcLoginCommand(pi);
  registerRpcTreeNavigationCommand(pi);
  installMemoryExtraction(pi);
  installFastMode(pi);
  if (shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK })) {
    taskTool({
      name: "task",
      label: "Task",
      description: [
        "Run isolated pi subprocess tasks (single, chain, or parallel).",
        "Optional model override (provider/modelId)."
      ].join(" "),
      maxParallelTasks: 8,
      maxConcurrency: 4,
      collapsedItemCount: 10,
      skillListLimit: 30,
      systemPromptPatches: [
        {
          match: /\n\s*\n\s*in addition to the tools above, you may have access to other custom tools depending on the project\./i,
          replace: "\n- task: only for skill runs. For delegation use subagent_spawn; for background commands use terminal_start."
        }
      ]
    })(pi);
  }
  installQuestionTool(pi);
  installAnswerTool(pi);
  const { subagentManager } = installOrchestrationTools(pi);
  installTaskModeAutoExit(pi);
  registerSumoReloadCommand(pi);
  registerRolesCommand(pi);
  registerAccountsCommand(pi);
  installSumoInteractions(pi, { subagentManager, includeUiSurfaces: false });
}
var PROCESS_INSTALL_LATCH = /* @__PURE__ */ Symbol.for("sumocode.extension.processInstallLatch");
var asOptionalString = (value) => typeof value === "string";
function globalLatchScope() {
  return globalThis;
}
function processInstallLatch(scope) {
  return scope[PROCESS_INSTALL_LATCH] ??= /* @__PURE__ */ new WeakSet();
}
function isSumocodeAlreadyInstalledInProcess(runtime, scope = globalLatchScope()) {
  return processInstallLatch(scope).has(runtime);
}
function markSumocodeInstalledInProcess(runtime, scope = globalLatchScope()) {
  processInstallLatch(scope).add(runtime);
}
function resetSumocodeProcessInstallLatchForTests(scope = globalLatchScope()) {
  delete scope[PROCESS_INSTALL_LATCH];
}
function sumocode(pi) {
  logDiagnostic("extension_activate_begin", {
    taskMode: isTaskMode(),
    sumoTui: process.env.SUMO_TUI ?? null,
    launcher: process.env.SUMOCODE_LAUNCHER ?? null
  });
  if (shouldNoopHelperSubprocess()) {
    return;
  }
  if (shouldNoopDuplicateInstalledExtension()) {
    console.warn("[sumocode] Skipping installed SumoCode extension because this session is already inside an active SumoCode dev checkout.");
    return;
  }
  if (isSumocodeAlreadyInstalledInProcess(pi)) {
    console.warn("[sumocode] Skipping duplicate SumoCode entry: this Pi runtime already installed SumoCode via another entry path.");
    logDiagnostic("extension_activate_skipped_duplicate_process_entry", {});
    return;
  }
  markSumocodeInstalledInProcess(pi);
  applyStartupTheme();
  if (isRpcChildProfile()) {
    installRpcChildProfile(pi);
    logDiagnostic("extension_activate_end", {
      profile: "rpc-child",
      nativeTaskInstalled: shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK })
    });
    return;
  }
  installRenderDiagnostics(pi);
  installSessionCache(pi);
  installAltscreen(pi);
  installTopChrome(pi);
  if (!isTaskMode()) {
    installSplash(pi);
  }
  let requestFooterRender;
  const fastModeState = installFastMode(pi, { onChange: () => requestFooterRender?.() });
  requestFooterRender = installFooter(pi, { fastModeState });
  installMemoryExtraction(pi);
  installCathedralEditor(pi);
  installInputHints(pi);
  installSkillInlineExpansion(pi);
  if (shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK })) {
    taskTool({
      name: "task",
      label: "Task",
      description: [
        "Run isolated pi subprocess tasks (single, chain, or parallel).",
        "Optional model override (provider/modelId)."
      ].join(" "),
      maxParallelTasks: 8,
      maxConcurrency: 4,
      collapsedItemCount: 10,
      skillListLimit: 30,
      systemPromptPatches: [
        {
          match: /\n\s*\n\s*in addition to the tools above, you may have access to other custom tools depending on the project\./i,
          replace: "\n- task: only for skill runs. For delegation use subagent_spawn; for background commands use terminal_start."
        }
      ]
    })(pi);
  }
  installQuestionTool(pi);
  installAnswerTool(pi);
  const { terminalTaskManager, subagentManager } = installOrchestrationTools(pi);
  installTaskModeAutoExit(pi);
  installWorkingIndicator(pi);
  installCompactionIndicator(pi);
  registerSumoReloadCommand(pi);
  registerRolesCommand(pi);
  registerAccountsCommand(pi);
  installSumoInteractions(pi, { subagentManager });
  logDiagnostic("extension_activate_end", {
    taskMode: isTaskMode(),
    nativeTaskInstalled: shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK }),
    hasBackgroundTasks: terminalTaskManager !== void 0,
    hasSubagents: subagentManager !== void 0
  });
}
export {
  sumocode as default,
  findActiveSumoDevTree2 as findActiveSumoDevTree,
  hasLegacyTaskToolExtension,
  isInstalledPiAgentGitModule,
  isRpcChildProfile,
  isSumocodeAlreadyInstalledInProcess,
  isTaskMode,
  markSumocodeInstalledInProcess,
  resetSumocodeProcessInstallLatchForTests,
  shouldInstallNativeTaskTool,
  shouldNoopDuplicateInstalledExtension,
  shouldNoopHelperSubprocess
};
//# sourceMappingURL=sumocode-extension.bundle.mjs.map
