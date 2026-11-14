#!/usr/bin/env node
// Frame-time summary for the M3 flythrough.
//   frames.csv (frame,timestamp_s,dt_ms)  from the app's --frame-log: presentation-to-presentation
//   gpu.csv    (frame,gpu_ms)             from the app's --gpu-log: GPU execution per frame
// "1% low" here is the strict form: the mean frame time of the slowest 1% of frames, as fps.
// The 99th-percentile frame time is printed too. Frame 0 has no predecessor and is left out.
//
// Usage: node native/Tools/m3-parity/frame-stats.mjs frames.csv [gpu.csv] [--json OUT]
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const jsonOut = jsonIndex >= 0 ? args[jsonIndex + 1] : null;
const [framesPath, gpuPath] = args.filter((a, i) => a !== '--json' && args[i - 1] !== '--json');

function column(path, name) {
  const [header, ...rows] = readFileSync(path, 'utf8').trim().split('\n');
  const index = header.split(',').indexOf(name);
  if (index < 0) throw new Error(`${path} has no ${name} column`);
  return rows.map((row) => Number(row.split(',')[index]));
}

function summary(ms) {
  const sorted = [...ms].sort((a, b) => a - b);
  const n = sorted.length;
  const worst = sorted.slice(n - Math.max(1, Math.ceil(n * 0.01)));
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const onePercentLowMs = worst.reduce((s, v) => s + v, 0) / worst.length;
  const p99 = sorted[Math.min(n - 1, Math.ceil(n * 0.99) - 1)];
  return {
    frames: n,
    meanMs: mean,
    meanFps: 1000 / mean,
    p99Ms: p99,
    p99Fps: 1000 / p99,
    onePercentLowMs,
    onePercentLowFps: 1000 / onePercentLowMs,
    worstMs: sorted[n - 1],
  };
}

const present = summary(column(framesPath, 'dt_ms').slice(1));
const result = { present };
const line = (label, s) =>
  `${label}: ${s.frames} frames, mean ${s.meanMs.toFixed(3)} ms (${s.meanFps.toFixed(1)} fps), ` +
  `p99 ${s.p99Ms.toFixed(3)} ms (${s.p99Fps.toFixed(1)} fps), 1% low ${s.onePercentLowMs.toFixed(3)} ms ` +
  `(${s.onePercentLowFps.toFixed(1)} fps), worst ${s.worstMs.toFixed(3)} ms`;
console.log(line('presented', present));
if (gpuPath) {
  result.gpu = summary(column(gpuPath, 'gpu_ms').slice(1));
  console.log(line('gpu', result.gpu));
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2) + '\n');
