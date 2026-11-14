/**
 * TRAA fixture (M9post, PLAN.md 3.3): the values the native TRAA port (IronvaleRender/Post/PostTRAA.swift,
 * IronvaleApp/Shaders/PostTRAA.h) must match, written to native/Tools/m3-parity/fixtures/traa.json.
 * - The jitter sequence, from three's own computeHaltonOffsets(32) (TAAUtils.js), and the settings of a
 *   real TRAANode (depthThreshold, edgeDepthDiff, maxVelocityLength, useSubpixelCorrection) and of
 *   ColorManagement (the luminance coefficients flickerReduction uses).
 * - The per-pixel blend math at seeded inputs. TRAANode's resolve is a TSL node graph that only runs on
 *   a GPU, so its functions are transcribed below line by line from three r187
 *   examples/jsm/tsl/display/TRAANode.js (subpixelCorrection, the current weight, the variance gamma,
 *   the history test) and examples/jsm/tsl/utils/TAAUtils.js (clipAABB, flickerReduction), with the
 *   constants read from the node where it exposes them.
 * IronvaleRenderTests/TRAATests runs PostTRAA.h on the GPU against these cases.
 * With TRAA_CHECK=1 it regenerates in memory and fails on any difference.
 * Run: npx vitest run --config native/Tools/vitest.config.ts native/Tools/m3-parity/traa.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import TRAANode from 'three/addons/tsl/display/TRAANode.js';
// @ts-expect-error -- @types/three has no declarations for this private addon module.
import { computeHaltonOffsets } from 'three/addons/tsl/utils/TAAUtils.js';
import { expect, it } from 'vitest';
import { seededRandom } from '../../../src/core/random';

const out = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/traa.json');

type V4 = [number, number, number, number];
type V2 = [number, number];

const node = new TRAANode(
  texture(new THREE.Texture()),
  texture(new THREE.DepthTexture(1, 1)),
  texture(new THREE.Texture()),
  new THREE.PerspectiveCamera(),
);
const luminanceCoefficients = THREE.ColorManagement.getLuminanceCoefficients(new THREE.Vector3()).toArray();
const luminance = (c: V4): number =>
  c[0] * luminanceCoefficients[0]! + c[1] * luminanceCoefficients[1]! + c[2] * luminanceCoefficients[2]!;
const fract = (x: number): number => x - Math.floor(x);
const saturate = (x: number): number => Math.min(1, Math.max(0, x));

/** TAAUtils clipAABB. */
function clipAABB(current: V4, history: V4, min: V4, max: V4): V4 {
  const pClip = [0, 1, 2].map((i) => (max[i]! + min[i]!) * 0.5);
  const eClip = [0, 1, 2].map((i) => (max[i]! - min[i]!) * 0.5 + 1e-7);
  const vClip = [history[0] - pClip[0]!, history[1] - pClip[1]!, history[2] - pClip[2]!, history[3] - current[3]];
  const maxUnit = Math.max(...[0, 1, 2].map((i) => Math.abs(vClip[i]! / eClip[i]!)));
  if (!(maxUnit > 1)) return history;
  return [pClip[0]! + vClip[0]! / maxUnit, pClip[1]! + vClip[1]! / maxUnit, pClip[2]! + vClip[2]! / maxUnit,
    current[3] + vClip[3]! / maxUnit];
}

/** TAAUtils flickerReduction. */
function flickerReduction(current: V4, history: V4, currentWeight: number): V4 {
  const compress = (c: V4): V4 => {
    const k = 1 / (Math.max(c[0], c[1], c[2]) + 1);
    return [c[0] * k, c[1] * k, c[2] * k, c[3] * k];
  };
  const weightCurrent = currentWeight / (luminance(compress(current)) + 1);
  const weightHistory = (1 - currentWeight) / (luminance(compress(history)) + 1);
  const sum = Math.max(weightCurrent + weightHistory, 0.00001);
  return [0, 1, 2, 3].map((i) => (current[i]! * weightCurrent + history[i]! * weightHistory) / sum) as V4;
}

/** TRAANode subpixelCorrection. */
function subpixelCorrection(velocityUV: V2, size: V2): number {
  const weight = [0, 1].map((i) => {
    const phase = Math.abs(fract(velocityUV[i]! * size[i]!));
    return Math.max(phase, 1 - phase);
  });
  return (1 - weight[0]! * weight[1]!) / 0.75;
}

/** TRAANode resolve: the current frame's weight. */
function currentWeight(offsetUV: V2, size: V2, motionFactor: number, valid: boolean, subpixel: boolean): number {
  let weight = 0.05;
  if (subpixel) weight += subpixelCorrection(offsetUV, size) * 0.25;
  return valid ? saturate(weight + motionFactor) : 1;
}

/** TRAANode resolve: mix(0.5, 1, (1 - motionFactor)^2). */
const varianceGamma = (motionFactor: number): number => {
  const t = (1 - motionFactor) ** 2;
  return 0.5 * (1 - t) + t;
};

/** TRAANode resolve: hasValidHistory. */
function hasValidHistory(historyUV: V2, closest: number, farthest: number, previous: number): boolean {
  const isValidUV = historyUV.every((v) => v >= 0) && historyUV.every((v) => v <= 1);
  const isEdge = farthest - closest > node.edgeDepthDiff;
  const isDisocclusion = closest - previous > node.depthThreshold;
  return isValidUV && (isEdge || !isDisocclusion);
}

function makeCase(random: () => number, index: number) {
  const colour = (scale: number): V4 => [random() * scale, random() * scale, random() * scale, random()];
  const current = colour(3);
  const history = colour(4);
  const centre = colour(3);
  const extent = colour(index % 3 === 0 ? 3 : 0.4);
  const min: V4 = [0, 1, 2, 3].map((i) => centre[i]! - extent[i]!) as V4;
  const max: V4 = [0, 1, 2, 3].map((i) => centre[i]! + extent[i]!) as V4;
  const weight = random();
  const size: V2 = [1280 + Math.floor(random() * 2000), 720 + Math.floor(random() * 1300)];
  const velocityUV: V2 = [(random() - 0.5) * 0.02, (random() - 0.5) * 0.02];
  const motionFactor = index % 4 === 0 ? 0 : random();
  const historyUV: V2 = [random() * 1.2 - 0.1, random() * 1.2 - 0.1];
  const closest = 0.9 + random() * 0.1;
  const farthest = closest + (index % 2 === 0 ? random() * 0.002 : random() * 0.0004);
  const previous = closest - (random() - 0.3) * 0.002;
  const valid = hasValidHistory(historyUV, closest, farthest, previous);
  return {
    current, history, min, max, weight, size, velocityUV, motionFactor, historyUV, closest, farthest, previous,
    clipAABB: clipAABB(current, history, min, max),
    flickerReduction: flickerReduction(current, history, weight),
    subpixelCorrection: subpixelCorrection(velocityUV, size),
    currentWeight: currentWeight(velocityUV, size, motionFactor, valid, true),
    currentWeightNoSubpixel: currentWeight(velocityUV, size, motionFactor, valid, false),
    varianceGamma: varianceGamma(motionFactor),
    hasValidHistory: valid,
  };
}

it('writes the TRAA fixture', () => {
  const random = seededRandom(20261114);
  const fixture = {
    source: 'three r187 examples/jsm/tsl/display/TRAANode.js, examples/jsm/tsl/utils/TAAUtils.js',
    halton: computeHaltonOffsets(32) as number[][],
    depthThreshold: node.depthThreshold,
    edgeDepthDiff: node.edgeDepthDiff,
    maxVelocityLength: node.maxVelocityLength,
    useSubpixelCorrection: node.useSubpixelCorrection,
    luminanceCoefficients,
    cases: Array.from({ length: 64 }, (_, i) => makeCase(random, i)),
  };
  const text = JSON.stringify(fixture) + '\n';
  if (process.env.TRAA_CHECK === '1') {
    expect(existsSync(out) ? readFileSync(out, 'utf8') : '').toBe(text);
  } else {
    writeFileSync(out, text);
  }
  // The cases must exercise both branches of each test.
  expect(new Set(fixture.cases.map((c) => c.hasValidHistory)).size).toBe(2);
  expect(new Set(fixture.cases.map((c) => c.clipAABB === c.history)).size).toBe(2);
});
