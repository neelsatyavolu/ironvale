/**
 * Finishes for the M24. The code-built parts get a worn black anodise that
 * shows bare metal on its chamfers; the stock, butt pad, steel and bolt keep
 * the textures of the source mesh and gain paint flecks, stippled grip panels,
 * ribs and uneven gloss. Every function returns one shared material.
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  floor,
  fract,
  length,
  materialColor,
  materialNormal,
  materialRoughness,
  mix,
  mod,
  mx_noise_float,
  normalize,
  positionLocal,
  positionView,
  positionViewDirection,
  normalView,
  sign,
  smoothstep,
  step,
  uv,
  vec2,
  vec3,
} from 'three/tsl';

type FloatNode = THREE.Node<'float'>;

const cache = new Map<string, THREE.Material>();
const derived = new WeakMap<THREE.Material, THREE.MeshStandardNodeMaterial>();

function once<T extends THREE.Material>(key: string, make: () => T): T {
  const existing = cache.get(key);
  if (existing) return existing as T;
  const material = make();
  material.name = key;
  cache.set(key, material);
  return material;
}

/** Noise in 0 - 1 at `scale` cycles per metre of the part's own space. */
function grain(scale: number, offset = 0): FloatNode {
  return mx_noise_float(positionLocal.mul(scale).add(offset)).mul(0.5).add(0.5);
}

/** 1 between `low` and `high`, with edges `soft` wide. */
function band(value: FloatNode, low: number, high: number, soft = 0.0008): FloatNode {
  return smoothstep(low - soft, low, value).mul(smoothstep(high, high + soft, value).oneMinus());
}

/** View-space normal for a surface raised by `height` metres; fades out with distance so it never shimmers. */
function raised(height: FloatNode): THREE.Node<'vec3'> {
  const near = smoothstep(1.2, 3, positionView.z.negate()).oneMinus();
  const relief = height.mul(near);
  const across = dFdx(positionView);
  const down = dFdy(positionView);
  const r1 = cross(down, materialNormal);
  const r2 = cross(materialNormal, across);
  const area = dot(across, r1);
  const slope = sign(area).mul(dFdx(relief).mul(r1).add(dFdy(relief).mul(r2)));
  return normalize(abs(area).mul(materialNormal).sub(slope));
}

/** Black hard anodise for the scope, rings and bipod. Chamfers (`wear` = 1) rub through to bright metal. */
export function wornBlack(): THREE.MeshStandardNodeMaterial {
  return once('scope_black', () => {
    const material = new THREE.MeshStandardNodeMaterial({ color: 0x0c0d0e, roughness: 0.5, metalness: 0.7 });
    const coarse = grain(42);
    const fine = grain(430);
    const rubbed = attribute('wear', 'float').mul(fine.mul(0.8).add(coarse.mul(0.45))).clamp(0, 1);
    material.colorNode = mix(vec3(0.011, 0.0115, 0.013), vec3(0.3, 0.31, 0.33), rubbed.mul(0.75));
    material.roughnessNode = mix(mix(float(0.34), float(0.6), coarse.mul(0.6).add(fine.mul(0.4))), float(0.26), rubbed);
    material.metalnessNode = mix(float(0.65), float(1), rubbed);
    return material;
  });
}

/** Dark oiled steel for screws, springs and swivels: lighter than the anodise so the fasteners read. */
export function fastenerSteel(): THREE.MeshStandardNodeMaterial {
  return once('fastener_steel', () => {
    const material = new THREE.MeshStandardNodeMaterial({ color: 0x3a3d42, roughness: 0.36, metalness: 1 });
    material.roughnessNode = mix(float(0.24), float(0.5), grain(300));
    return material;
  });
}

/** Rubber and the blacked inside of the scope tube. */
export function matteBlack(): THREE.MeshStandardNodeMaterial {
  return once('matte_black', () => {
    const material = new THREE.MeshStandardNodeMaterial({ color: 0x060606, roughness: 0.9, metalness: 0 });
    material.roughnessNode = mix(float(0.78), float(0.96), grain(160));
    return material;
  });
}

/**
 * Engraved white scales. uv.x counts graduations around a dial (every fifth
 * is long) and uv.y runs from the foot of the scale to its top.
 */
export function engraving(): THREE.MeshStandardNodeMaterial {
  return once('scope_marks', () => {
    const material = new THREE.MeshStandardNodeMaterial({ color: 0x0c0d0e, roughness: 0.5, metalness: 0.7 });
    const count = uv().x;
    const up = uv().y;
    const long = step(mod(floor(count), 5), 0.5);
    const tick = step(abs(fract(count).sub(0.5)), 0.1)
      .mul(step(up, mix(float(0.5), float(0.9), long)))
      .mul(step(0.1, up));
    material.colorNode = mix(vec3(0.011, 0.0115, 0.013), vec3(0.72, 0.72, 0.66), tick);
    material.roughnessNode = mix(float(0.46), float(0.7), tick);
    material.metalnessNode = mix(float(0.65), float(0), tick);
    return material;
  });
}

/**
 * Multi-coated glass: a thin-film sheen `coating` strong (0 - 1) over film `film` nanometres thick, turning to a
 * mirror at a grazing angle.
 */
export function coatedLens(key: string, tint: number, opacity: number, film: readonly [number, number], coating: number): THREE.MeshPhysicalNodeMaterial {
  return once(key, () => {
    const material = new THREE.MeshPhysicalNodeMaterial({
      color: tint,
      roughness: 0.02,
      metalness: 0,
      clearcoat: coating,
      clearcoatRoughness: 0.02,
      iridescence: coating,
      iridescenceIOR: 1.9,
      iridescenceThicknessMinimum: film[0],
      iridescenceThicknessMaximum: film[1],
      transparent: true,
      opacity,
      depthWrite: false,
    });
    const grazing = float(1).sub(abs(dot(normalView, positionViewDirection))).pow(3);
    material.opacityNode = mix(float(opacity), float(1), grazing);
    return material;
  });
}

/** A node material that keeps the maps of a loaded glTF material, so its look can be extended. */
function derive(source: THREE.Material, dress: (material: THREE.MeshStandardNodeMaterial) => void): THREE.MeshStandardNodeMaterial {
  const existing = derived.get(source);
  if (existing) return existing;
  const from = source as THREE.MeshStandardMaterial;
  const material = new THREE.MeshStandardNodeMaterial({
    color: from.color,
    roughness: from.roughness ?? 1,
    metalness: from.metalness ?? 0,
    map: from.map ?? null,
    normalMap: from.normalMap ?? null,
    roughnessMap: from.roughnessMap ?? null,
    metalnessMap: from.metalnessMap ?? null,
    aoMap: from.aoMap ?? null,
  });
  if (from.normalScale) material.normalScale.copy(from.normalScale);
  material.name = source.name;
  dress(material);
  derived.set(source, material);
  return material;
}

/** Underside of the fore-end in mesh space: it rises toward the tip. */
const FORE_END = { tipZ: -0.475, tipY: 0.0273, slope: -0.0519 };
const STIPPLE = { pitch: 560, height: 0.00011 };

/** Fibreglass stock: olive paint with dark and sand flecks, and stippled panels at the wrist and fore-end. */
export function stockFinish(source: THREE.Material): THREE.Material {
  return derive(source, (material) => {
    const p = positionLocal;
    const side = smoothstep(0.009, 0.0115, abs(p.x));
    const foreBottom = p.z.sub(FORE_END.tipZ).mul(FORE_END.slope).add(FORE_END.tipY);
    const fore = band(p.z, -0.41, -0.19).mul(band(p.y.sub(foreBottom), 0.0055, 0.019));
    const wrist = band(p.z.add(p.y.mul(0.35)), -0.012, 0.044).mul(band(p.y, -0.036, 0.014));
    const panel = fore.add(wrist).clamp(0, 1).mul(side);

    const mottle = grain(26);
    const dark = smoothstep(0.27, 0.39, mx_noise_float(p.mul(720)));
    const sand = smoothstep(0.4, 0.5, mx_noise_float(p.mul(840).add(31.7)));
    const paint = materialColor.rgb.mul(mix(float(0.6), float(0.9), mottle));
    const flecked = mix(mix(paint, vec3(0.01, 0.011, 0.009), dark.mul(0.8)), vec3(0.09, 0.088, 0.06), sand.mul(0.35));
    material.colorNode = flecked.mul(mix(float(1), float(0.55), panel));

    const gloss = materialRoughness.mul(mix(float(0.78), float(1.02), mottle)).sub(dark.mul(0.12));
    material.roughnessNode = mix(gloss, float(0.92), panel);

    const cell = fract(vec2(p.z, p.y).mul(STIPPLE.pitch)).sub(0.5);
    const dome = smoothstep(0.18, 0.44, length(cell)).oneMinus();
    material.normalNode = raised(dome.mul(panel).mul(STIPPLE.height));
  });
}

const PAD_RIB = { pitch: 240, depth: 0.0003 };

/** Rubber recoil pad with moulded ribs. */
export function padFinish(source: THREE.Material): THREE.Material {
  return derive(source, (material) => {
    const wave = abs(fract(positionLocal.y.mul(PAD_RIB.pitch)).sub(0.5)).mul(2);
    const groove = smoothstep(0.7, 0.95, wave);
    material.colorNode = vec3(0.016, 0.016, 0.017).mul(mix(float(1), float(0.45), groove));
    material.roughnessNode = mix(float(0.8), float(0.95), grain(180));
    material.metalnessNode = float(0);
    material.normalNode = raised(groove.mul(-PAD_RIB.depth));
  });
}

/** Barrel, receiver and rail: the source finish with handling gloss broken up along the steel. */
export function steelFinish(source: THREE.Material): THREE.Material {
  return derive(source, (material) => {
    const streak = mx_noise_float(positionLocal.mul(vec3(380, 380, 34))).mul(0.5).add(0.5);
    material.roughnessNode = materialRoughness.mul(mix(float(0.72), float(1.12), streak.mul(0.6).add(grain(60).mul(0.4)))).clamp(0.12, 1);
  });
}

/** Polished bolt body with fine turning marks around it. */
export function boltFinish(source: THREE.Material): THREE.Material {
  return derive(source, (material) => {
    const turning = mx_noise_float(vec2(positionLocal.z.mul(2600), 0)).mul(0.5).add(0.5);
    material.colorNode = vec3(0.2, 0.205, 0.215).mul(mix(float(0.8), float(1), turning));
    material.roughnessNode = mix(float(0.36), float(0.58), turning.mul(0.7).add(grain(90).mul(0.3)));
    material.metalnessNode = float(1);
  });
}
