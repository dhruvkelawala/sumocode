import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { ensureDir } from "./fs-utils.mjs";

export function readPng(path) {
	return PNG.sync.read(readFileSync(path));
}

export function writePng(path, png) {
	ensureDir(dirname(path));
	writeFileSync(path, PNG.sync.write(png));
}

export async function compareCropPair({ targetPath, runtimePath, goldenPath, targetCrop, runtimeCrop, threshold, outPaths, dimensions }) {
	const targetPng = readPng(targetPath);
	const runtimePng = readPng(runtimePath);
	const targetRect = cropRect(targetPng, targetCrop, dimensions);
	const runtimeRect = cropRect(runtimePng, runtimeCrop, dimensions);
	const target = cropPng(targetPng, targetRect);
	const runtime = cropPng(runtimePng, runtimeRect);
	writePng(outPaths.target, target);
	writePng(outPaths.runtime, runtime);

	const bible = await comparePngs(target, runtime, outPaths.bibleDiff, threshold);
	let golden = null;
	if (goldenPath && existsSync(goldenPath)) {
		const goldenPng = readPng(goldenPath);
		writePng(outPaths.golden, goldenPng);
		golden = await comparePngs(goldenPng, runtime, outPaths.goldenDiff, threshold);
	}

	return {
		target: imageSummary(target, targetRect),
		runtime: imageSummary(runtime, runtimeRect),
		bible,
		golden,
	};
}

function cropRect(png, crop, dimensions) {
	if (!crop || crop.kind === "full") return { x: 0, y: 0, width: png.width, height: png.height };
	const cellWidth = png.width / dimensions.cols;
	const rows = dimensions.rows ?? Math.max(1, Math.round(png.height / cellWidth));
	const cellHeight = png.height / rows;
	const rect = {
		x: Math.round(crop.x * cellWidth),
		y: Math.round(crop.y * cellHeight),
		width: Math.round(crop.cols * cellWidth),
		height: Math.round(crop.rows * cellHeight),
	};
	if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > png.width + 1 || rect.y + rect.height > png.height + 1) {
		throw new Error(`Crop out of bounds: ${JSON.stringify(crop)} for image ${png.width}x${png.height} with ${dimensions.cols}x${rows} cells -> ${JSON.stringify(rect)}`);
	}
	return {
		x: Math.max(0, rect.x),
		y: Math.max(0, rect.y),
		width: Math.min(rect.width, png.width - Math.max(0, rect.x)),
		height: Math.min(rect.height, png.height - Math.max(0, rect.y)),
	};
}

function cropPng(source, rect) {
	const out = new PNG({ width: rect.width, height: rect.height });
	for (let y = 0; y < rect.height; y += 1) {
		for (let x = 0; x < rect.width; x += 1) {
			const srcIdx = ((rect.y + y) * source.width + (rect.x + x)) * 4;
			const dstIdx = (y * rect.width + x) * 4;
			out.data[dstIdx] = source.data[srcIdx];
			out.data[dstIdx + 1] = source.data[srcIdx + 1];
			out.data[dstIdx + 2] = source.data[srcIdx + 2];
			out.data[dstIdx + 3] = source.data[srcIdx + 3];
		}
	}
	return out;
}

async function comparePngs(expected, actual, diffPath, threshold) {
	const width = Math.max(expected.width, actual.width);
	const height = Math.max(expected.height, actual.height);
	const paddedExpected = padPng(expected, width, height);
	const paddedActual = padPng(actual, width, height);
	const diff = new PNG({ width, height });
	const diffPixels = pixelmatch(paddedExpected.data, paddedActual.data, diff.data, width, height, {
		threshold: 0.1,
		includeAA: false,
		aaColor: [232, 179, 57],
		diffColor: [193, 68, 62],
	});
	writePng(diffPath, diff);
	const totalPixels = width * height;
	const diffRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
	return {
		width,
		height,
		diffPixels,
		totalPixels,
		diffRatio,
		threshold,
		passed: diffRatio <= threshold,
		dimensionMismatch: expected.width !== actual.width || expected.height !== actual.height,
	};
}

function padPng(source, width, height) {
	if (source.width === width && source.height === height) return source;
	const out = new PNG({ width, height });
	for (let i = 0; i < out.data.length; i += 4) {
		out.data[i] = 26;
		out.data[i + 1] = 21;
		out.data[i + 2] = 17;
		out.data[i + 3] = 255;
	}
	for (let y = 0; y < source.height; y += 1) {
		for (let x = 0; x < source.width; x += 1) {
			const srcIdx = (y * source.width + x) * 4;
			const dstIdx = (y * width + x) * 4;
			out.data[dstIdx] = source.data[srcIdx];
			out.data[dstIdx + 1] = source.data[srcIdx + 1];
			out.data[dstIdx + 2] = source.data[srcIdx + 2];
			out.data[dstIdx + 3] = source.data[srcIdx + 3];
		}
	}
	return out;
}

function imageSummary(png, rect) {
	return { width: png.width, height: png.height, rect };
}
