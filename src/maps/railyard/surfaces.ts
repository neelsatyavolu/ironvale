import * as THREE from 'three/webgpu';
import {
  abs,
  float,
  fract,
  max,
  mix,
  mx_noise_float,
  mx_noise_vec3,
  normalize,
  normalWorld,
  positionView,
  positionWorld,
  smoothstep,
  step,
  time,
  transformNormalToView,
  uv,
  vec2,
  vec3,
} from 'three/tsl';

/**
 * Procedural surfaces with no texture set behind them. TSL node graphs are
 * typed loosely upstream; they are treated as opaque values here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TslNode = any;

/** 0 - 1 noise fixed in world space; `scale` is cycles per metre. */
export const worldNoise = (scale: number): TslNode => mx_noise_float(positionWorld.mul(scale)).mul(0.5).add(0.5);

export function steelPaint(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, metalness: 0.15 });
  const p: TslNode = positionWorld;
  const upright: TslNode = smoothstep(0.5, 0.8, abs(normalWorld.y)).oneMinus();
  const top: TslNode = smoothstep(0.6, 0.9, normalWorld.y);
  // Broad curtains of dirt, thin dark drips, a splash band at the foot and standing wet on flat tops.
  const streak: TslNode = mx_noise_float(p.mul(vec3(1.7, 0.22, 1.7))).mul(0.5).add(0.5);
  const fine: TslNode = worldNoise(7);
  const grime: TslNode = smoothstep(0.35, 0.9, streak.mul(0.7).add(fine.mul(0.3)));
  const drip: TslNode = smoothstep(0.62, 0.8, mx_noise_float(p.mul(vec3(6.5, 0.3, 6.5))).mul(0.5).add(0.5)).mul(upright);
  const foot: TslNode = smoothstep(0.42, 0.9, smoothstep(0.02, 0.7, p.y).oneMinus().mul(0.75).add(fine.mul(0.35)));
  // Rust: soft blooms, plus chipped specks where the paint has been knocked.
  const bloom: TslNode = worldNoise(2.3).mul(0.6).add(fine.mul(0.4));
  const rust: TslNode = smoothstep(0.7, 0.84, bloom);
  const chips: TslNode = smoothstep(0.74, 0.8, worldNoise(16)).mul(smoothstep(0.45, 0.7, streak));
  const pooled: TslNode = smoothstep(0.45, 0.6, bloom).mul(top);
  const base: TslNode = mix(vec3(1, 1, 1), vec3(0.5, 0.47, 0.44), grime)
    .mul(mix(float(1), float(0.55), drip))
    .mul(mix(float(1), float(0.5), foot))
    .mul(mix(float(1), float(0.7), pooled));
  material.colorNode = mix(base, vec3(0.38, 0.17, 0.08), max(rust.mul(0.8), chips.mul(0.9)));
  material.roughnessNode = mix(mix(float(0.3), float(0.74), max(max(grime, rust), max(foot, chips))), float(0.07), pooled);
  material.vertexColors = true;
  return material;
}

export function hazardStripes(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.55 });
  const along: TslNode = positionWorld.x.add(positionWorld.y).add(positionWorld.z).div(0.36);
  const stripe: TslNode = step(0.5, fract(along));
  const wear: TslNode = mix(float(0.62), float(1), worldNoise(3.1));
  material.colorNode = mix(vec3(0.86, 0.6, 0.05), vec3(0.03, 0.03, 0.03), stripe).mul(wear);
  return material;
}

export function timber(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  const grain: TslNode = mx_noise_float(positionWorld.mul(vec3(22, 22, 2.4))).mul(0.5).add(0.5);
  const patch: TslNode = worldNoise(1.4);
  // Board edges every 14 cm up the upright faces, so a crate side reads as planks.
  const upright: TslNode = smoothstep(0.5, 0.7, abs(normalWorld.y)).oneMinus();
  const gap: TslNode = smoothstep(0.02, 0.06, abs(fract(positionWorld.y.div(0.14)).sub(0.5))).oneMinus().mul(upright);
  const damp: TslNode = smoothstep(0.45, 0.7, worldNoise(0.8));
  // Pale pine by default; vertex colour darkens it for sleepers and old boards.
  material.colorNode = vec3(0.52, 0.43, 0.32)
    .mul(mix(float(0.6), float(1.08), grain.mul(0.55).add(patch.mul(0.45))))
    .mul(mix(float(1), float(0.72), damp))
    .mul(mix(float(1), float(0.4), gap));
  material.roughnessNode = mix(float(0.78), float(0.5), damp);
  material.vertexColors = true;
  return material;
}

export function roadPaint(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.5 });
  const coarse: TslNode = mx_noise_float(positionWorld.xz.mul(1.6)).mul(0.5).add(0.5);
  const fine: TslNode = mx_noise_float(positionWorld.xz.mul(17)).mul(0.5).add(0.5);
  // Worn through in patches, the way yard markings chip under tyres.
  material.opacityNode = smoothstep(0.3, 0.36, coarse.mul(0.4).add(fine.mul(0.6)));
  material.alphaTest = 0.5;
  material.colorNode = vec3(mix(float(0.55), float(0.95), fine));
  material.vertexColors = true;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -8;
  return material;
}

export function oilStain(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0x0b0a09,
    roughness: 0.22,
    transparent: true,
    depthWrite: false,
  });
  const fromCentre: TslNode = uv().sub(0.5).length().mul(2);
  const shape: TslNode = mx_noise_float(positionWorld.xz.mul(2.2)).mul(0.5).add(0.5);
  const speckle: TslNode = mx_noise_float(positionWorld.xz.mul(14)).mul(0.5).add(0.5);
  const body: TslNode = smoothstep(0.35, 1.0, fromCentre.add(shape.sub(0.5).mul(0.7))).oneMinus();
  material.opacityNode = body.mul(mix(float(0.45), float(0.9), speckle)).mul(0.78);
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -6;
  return material;
}

/** Diamond wire mesh. UVs are in metres. Fades to an even veil with distance so it does not shimmer. */
export function chainlinkMesh(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0x9aa0a3,
    roughness: 0.45,
    metalness: 0.7,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const pitch = 0.06;
  const wire = 0.09;
  const p: TslNode = uv().div(pitch);
  const a: TslNode = abs(fract(p.x.add(p.y)).sub(0.5));
  const b: TslNode = abs(fract(p.x.sub(p.y)).sub(0.5));
  // Edges are always given low to high: a reversed smoothstep is undefined in WGSL.
  const lines: TslNode = max(smoothstep(wire, wire + 0.06, a).oneMinus(), smoothstep(wire, wire + 0.06, b).oneMinus());
  const distance: TslNode = positionView.z.negate();
  material.opacityNode = mix(lines, float(0.3), smoothstep(5, 16, distance));
  return material;
}

export function seaWater(): THREE.MeshStandardNodeMaterial {
  // No scene fog: at a grazing angle the water mirrors the sky above the horizon, which is what joins sea to sky.
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x122a31, roughness: 0.16, metalness: 0, fog: false });
  const p: TslNode = positionWorld.xz;
  const swell: TslNode = mx_noise_vec3(vec3(p.mul(0.3).add(vec2(time.mul(0.1), time.mul(0.04))), time.mul(0.16)));
  const chop: TslNode = mx_noise_vec3(vec3(p.mul(1.7).add(vec2(time.mul(-0.22), time.mul(0.17))), time.mul(0.4)));
  const ripple: TslNode = mx_noise_vec3(vec3(p.mul(6.5).add(vec2(time.mul(0.3), time.mul(-0.2))), time.mul(0.8)));
  // Rain-flattened harbour water: low swell, fine ripples, fading out with distance so the far water stays calm.
  const near: TslNode = smoothstep(20, 260, positionView.z.negate()).oneMinus();
  const tilt: TslNode = swell.xy.mul(0.05).add(chop.xy.mul(0.035)).add(ripple.xy.mul(0.02)).mul(near.mul(0.75).add(0.25));
  material.normalNode = transformNormalToView(normalize(vec3(tilt.x, 1, tilt.y)));
  return material;
}

/**
 * Corrugated cardboard for unit boxes (UVs 0 - 1 on every face): fibre mottle,
 * a strip of parcel tape, a printed label on the upright faces and scuffed
 * edges. Vertex colour picks the board shade.
 */
export function cardboard(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, metalness: 0 });
  const st: TslNode = uv();
  const fibre: TslNode = mix(float(0.84), float(1.06), worldNoise(23).mul(0.5).add(worldNoise(3.1).mul(0.5)));
  const fromEdge: TslNode = abs(st.sub(0.5)).mul(2);
  const edge: TslNode = smoothstep(0.9, 1.0, max(fromEdge.x, fromEdge.y));
  const tape: TslNode = smoothstep(0.075, 0.085, abs(st.x.sub(0.5))).oneMinus();
  const upright: TslNode = smoothstep(0.5, 0.7, abs(normalWorld.y)).oneMinus();
  const inLabel: TslNode = step(0.1, st.x).mul(step(st.x, 0.36)).mul(step(0.5, st.y)).mul(step(st.y, 0.78)).mul(upright);
  const bars: TslNode = step(0.5, fract(st.x.mul(64))).mul(step(st.y, 0.62)).mul(step(0.14, st.x)).mul(step(st.x, 0.32));
  const board: TslNode = vec3(fibre).mul(mix(float(1), float(0.7), edge));
  const taped: TslNode = mix(board, vec3(1.18, 1.1, 0.92), tape.mul(0.55));
  material.colorNode = mix(taped, mix(vec3(1.5, 1.52, 1.5), vec3(0.2, 0.2, 0.22), bars), inLabel);
  material.roughnessNode = mix(float(0.86), float(0.34), max(tape, inLabel.mul(0.5)));
  material.vertexColors = true;
  return material;
}

/** Stretch film over a pallet load: milky, glossy, with the load showing through in blocks. */
export function shrinkWrap(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, metalness: 0 });
  const load: TslNode = worldNoise(2.1);
  const contents: TslNode = mix(vec3(0.42, 0.34, 0.24), vec3(0.62, 0.66, 0.68), smoothstep(0.42, 0.58, load));
  const bands: TslNode = mx_noise_float(positionWorld.mul(vec3(0.6, 34, 0.6))).mul(0.5).add(0.5);
  material.colorNode = mix(contents, vec3(0.74, 0.77, 0.78), mix(float(0.45), float(0.75), bands));
  material.roughnessNode = mix(float(0.16), float(0.5), bands);
  material.vertexColors = true;
  return material;
}
