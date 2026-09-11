import { compile } from "@mdx-js/mdx";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import * as v from "valibot";

const sourceSchema = v.object({ mdx: v.record(v.string(), v.string()) });

async function validate(sourcePath) {
  const source = v.parse(sourceSchema, JSON.parse(readFileSync(sourcePath, "utf8")));
  if (!source.mdx["plan.mdx"]?.trim()) throw new Error("plan.mdx must be non-empty");
  for (const [filename, content] of Object.entries(source.mdx)) {
    try {
      // Compile only: recap expressions are untrusted and must never execute in CI.
      await compile(content, { remarkPlugins: [screenCaptions] });
    } catch (error) {
      throw new Error(
        `${filename}:${error.line ?? 1}:${error.column ?? 1}: ${error.reason ?? error.message}`,
        { cause: error },
      );
    }
  }
}

function screenCaptions() {
  return function visit(node, file) {
    if (node.name === "Screen") checkCaption(node, file);
    for (const child of node.children ?? []) visit(child, file);
  };
}

function checkCaption(node, file) {
  const caption = node.attributes.find((attribute) => attribute.name === "caption");
  if (!caption) return;
  const text = captionValue(caption);
  // Match the hosted wireframe schema's trimmed caption limit.
  // https://github.com/BuilderIO/agent-native/blob/main/packages/core/src/client/blocks/library/wireframe.config.ts
  if (v.is(v.string(), text) && text.trim().length > 400) {
    file.fail("Screen caption exceeds 400 characters; move detail into adjacent prose.", caption);
  }
}

function captionValue(attribute) {
  if (attribute.value?.type !== "mdxJsxAttributeValueExpression") return attribute.value;
  const expression = attribute.value.data.estree.body[0]?.expression;
  if (expression?.type === "TemplateLiteral" && expression.expressions.length === 0) {
    return expression.quasis[0].value.cooked ?? "";
  }
  return expression?.value;
}

const [sourcePath, reasonPath] = process.argv.slice(2);
if (!sourcePath || !reasonPath) throw new Error("Usage: validate.mjs SOURCE REASON_FILE");
try {
  await validate(sourcePath);
  rmSync(reasonPath, { force: true });
  console.log("Recap MDX syntax and wireframe captions are valid.");
} catch (error) {
  writeFileSync(reasonPath, `${error.message}\n`);
  console.error(error.message);
  process.exitCode = 1;
}
