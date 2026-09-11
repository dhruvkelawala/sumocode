import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const validator = fileURLToPath(new URL("./validate.mjs", import.meta.url));
const broken =
  '<Tabs tabs={[\n  { blocks: [\n    { type: "annotated-code", data: { code: `const title = "Lore";` }\n    ]\n  ] }\n]} />';

function check(t, mdx) {
  const directory = mkdtempSync(join(tmpdir(), "lore-recap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source.json");
  const reason = join(directory, "reason.txt");
  const contents = JSON.stringify({ mdx });
  writeFileSync(source, contents);
  writeFileSync(reason, "previous failure");
  const result = spawnSync(process.execPath, [validator, source, reason], {
    encoding: "utf8",
  });
  assert.equal(readFileSync(source, "utf8"), contents, "validation must never rewrite source");
  return { ...result, reason };
}

test("rejects the generated mismatched bracket with a located repair diagnostic", (t) => {
  const result = check(t, { "plan.mdx": broken });
  assert.equal(result.status, 1);
  assert.match(
    readFileSync(result.reason, "utf8"),
    /plan\.mdx:4:5: Could not parse expression with acorn/,
  );
});

test("accepts the bracket-only repair and clears a stale failure", (t) => {
  const result = check(t, { "plan.mdx": broken.replace("    ]", "    }") });
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => readFileSync(result.reason), { code: "ENOENT" });
});

test("checks additional MDX files as well as the plan", (t) => {
  const result = check(t, { "plan.mdx": "# Recap", "canvas.mdx": broken });
  assert.equal(result.status, 1);
  assert.match(readFileSync(result.reason, "utf8"), /canvas\.mdx:4:5:/);
});

test("validates expressions without executing them", (t) => {
  const result = check(t, { "plan.mdx": '{(() => { throw new Error("must not execute"); })()}' });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects missing or empty plan source", (t) => {
  for (const mdx of [{}, { "plan.mdx": " " }]) {
    const result = check(t, mdx);
    assert.equal(result.status, 1);
    assert.match(readFileSync(result.reason, "utf8"), /plan\.mdx must be non-empty/);
  }
});

test("rejects a wireframe caption that the hosted renderer would omit", (t) => {
  for (const caption of [
    `"${"x".repeat(401)}"`,
    `{${JSON.stringify("x".repeat(401))}}`,
    "{`" + "x".repeat(401) + "`}",
  ]) {
    const result = check(t, {
      "plan.mdx": `<WireframeBlock>\n<Screen caption=${caption} />\n</WireframeBlock>`,
    });
    assert.equal(result.status, 1);
    assert.match(
      readFileSync(result.reason, "utf8"),
      /plan\.mdx:2:9: Screen caption exceeds 400 characters/,
    );
  }
});

test("allows the caption boundary and ignores Screen markup inside code samples", (t) => {
  const result = check(t, {
    "plan.mdx": `<Screen caption=" ${"x".repeat(400)} " />\n\n\`\`\`jsx\n<Screen caption="${"x".repeat(401)}" />\n\`\`\``,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("accepts a static template caption at the hosted limit", (t) => {
  const result = check(t, { "plan.mdx": "<Screen caption={`" + "x".repeat(400) + "`} />" });
  assert.equal(result.status, 0, result.stderr);
});
