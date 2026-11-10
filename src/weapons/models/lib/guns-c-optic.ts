/**
 * Holographic sight for the M4A1, modelled in code at true size (about
 * 92 x 46 x 60 mm, the class of an EOTech-style hooded sight). Origin is on
 * the rail top, under the rear face of the hood; the window looks along -Z
 * and its centre line is `HOLO_AXIS_HEIGHT` above the rail. The body runs from
 * `HOLO_BODY.front` to `HOLO_BODY.rear` along Z.
 *
 * The reticle is drawn the way a real one behaves: it is collimated, so it
 * sits where the view ray is parallel to the sight's axis instead of being
 * painted on the glass. Off-axis the dot slides across the window and leaves it.
 */
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { color, float, length, max, modelViewMatrix, positionView, smoothstep, vec4 } from 'three/tsl';
import { lensMaterial } from '../materials';
import { plainFinish } from './guns-c-materials';

/** Window centre above the rail top, in metres. */
export const HOLO_AXIS_HEIGHT = 0.0418;
/** Z extent of the sight body; the hood's rear face is at 0. */
export const HOLO_BODY = { front: -0.078, rear: 0.014 } as const;
/** Clear opening of the hood. */
export const HOLO_WINDOW = { width: 0.033, height: 0.024, corner: 0.003 } as const;

const BODY_LENGTH = HOLO_BODY.rear - HOLO_BODY.front;
const BODY_CENTRE = (HOLO_BODY.rear + HOLO_BODY.front) / 2;
const BODY = { width: 0.044, top: 0.0265, clampTop: 0.0075 };
const HOOD = { width: 0.046, height: 0.037, chamfer: 0.0075, front: -0.04 };
const EDGE = 0.0007;
/** Reticle sizes in radians: a 1 MOA-class dot drawn large enough to survive a 1080p screen, and a 68 MOA ring. */
const RETICLE = { dot: 0.0011, ring: 0.0099, ringWidth: 0.00055, color: 0xff2a14, gain: 6 };

type Point = readonly [number, number];

function roundedRect(path: THREE.Path, width: number, height: number, radius: number): void {
  const x = width / 2;
  const y = height / 2;
  path.moveTo(-x + radius, -y);
  path.lineTo(x - radius, -y);
  path.absarc(x - radius, -y + radius, radius, -Math.PI / 2, 0, false);
  path.lineTo(x, y - radius);
  path.absarc(x - radius, y - radius, radius, 0, Math.PI / 2, false);
  path.lineTo(-x + radius, y);
  path.absarc(-x + radius, y - radius, radius, Math.PI / 2, Math.PI, false);
  path.lineTo(-x, -y + radius);
  path.absarc(-x + radius, -y + radius, radius, Math.PI, Math.PI * 1.5, false);
}

function polygon(points: readonly Point[]): THREE.Shape {
  const shape = new THREE.Shape();
  points.forEach(([a, b], index) => (index === 0 ? shape.moveTo(a, b) : shape.lineTo(a, b)));
  shape.closePath();
  return shape;
}

/** Extrude with a small bevel that stays inside the outline, so the part keeps its drawn size. */
function extrude(shape: THREE.Shape, depth: number, edge = EDGE): THREE.BufferGeometry {
  return new THREE.ExtrudeGeometry(shape, {
    depth: depth - edge * 2,
    bevelEnabled: true,
    bevelThickness: edge,
    bevelSize: edge,
    bevelOffset: -edge,
    bevelSegments: 1,
    curveSegments: 6,
  }).translate(0, 0, edge);
}

/** A side profile drawn as (z, y) points, extruded across the sight's width and centred on X. */
function profile(points: readonly Point[], width: number, x = 0): THREE.BufferGeometry {
  return extrude(polygon(points), width)
    .translate(0, 0, -width / 2)
    .rotateY(-Math.PI / 2)
    .translate(x, 0, 0);
}

function box(width: number, height: number, depth: number, x: number, y: number, z: number, radius = EDGE): THREE.BufferGeometry {
  return new RoundedBoxGeometry(width, height, depth, 1, radius).translate(x, y, z);
}

/** Cylinder lying along X. */
function crossPin(radius: number, lengthX: number, x: number, y: number, z: number, sides = 20): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius, radius, lengthX, sides).rotateZ(Math.PI / 2).translate(x, y, z).toNonIndexed();
}

/** Cylinder lying along Z. */
function axialPin(radius: number, lengthZ: number, x: number, y: number, z: number, sides = 6): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius, radius, lengthZ, sides).rotateX(Math.PI / 2).translate(x, y, z).toNonIndexed();
}

/** The protective hood: an eight-sided ring around the window, bevelled at both mouths. */
function hoodGeometry(): THREE.BufferGeometry {
  const x = HOOD.width / 2;
  const y = HOOD.height / 2;
  const c = HOOD.chamfer;
  const shape = polygon([[-x + c, -y], [x - c, -y], [x, -y + c], [x, y - c], [x - c, y], [-x + c, y], [-x, y - c], [-x, -y + c]]);
  const hole = new THREE.Path();
  roundedRect(hole, HOLO_WINDOW.width, HOLO_WINDOW.height, HOLO_WINDOW.corner);
  shape.holes.push(hole);
  return extrude(shape, -HOOD.front, 0.0012).translate(0, HOLO_AXIS_HEIGHT, HOOD.front);
}

function bodyGeometry(): THREE.BufferGeometry {
  const { front, rear } = HOLO_BODY;
  const top = BODY.top;
  const hoodSide = HOOD.width / 2;
  const rib = (x: number, z: number): THREE.BufferGeometry => box(0.0022, 0.021, 0.005, x, HOLO_AXIS_HEIGHT, z);
  return mergeGeometries([
    // Electronics housing: chamfered at the rear, sloped down to the battery cap at the front.
    profile(
      [[rear, BODY.clampTop], [rear, top - 0.006], [rear - 0.005, top], [HOOD.front - 0.004, top], [front + 0.004, top - 0.008], [front, top - 0.012], [front, BODY.clampTop]],
      BODY.width,
    ),
    // Rail clamp: a narrower foot with a lip each side, a clamp bar on the left and its cross bolt.
    profile([[rear - 0.004, 0], [rear - 0.004, BODY.clampTop], [front + 0.004, BODY.clampTop], [front + 0.004, 0]], 0.03),
    box(0.005, 0.011, 0.05, -0.0185, 0.0055, BODY_CENTRE),
    box(0.004, 0.006, BODY_LENGTH - 0.012, 0.017, 0.0045, BODY_CENTRE),
    hoodGeometry(),
    // Ribs down each side of the hood, a raised bar along its top and the lens bezel inside it.
    rib(-hoodSide, -0.03),
    rib(hoodSide, -0.03),
    rib(-hoodSide, -0.01),
    rib(hoodSide, -0.01),
    box(0.022, 0.002, 0.03, 0, HOLO_AXIS_HEIGHT + HOOD.height / 2, -0.02),
    // Recessed control panel on the rear face and the battery housing across the front.
    box(0.036, 0.0125, 0.0016, 0, 0.0145, rear),
    crossPin(0.0082, BODY.width + 0.002, 0, 0.0165, front + 0.009, 24),
  ]);
}

function hardwareGeometry(): THREE.BufferGeometry {
  const hoodSide = HOOD.width / 2 + 0.0004;
  const { front, rear } = HOLO_BODY;
  const screw = (x: number, y: number, z: number): THREE.BufferGeometry => crossPin(0.002, 0.0016, x, y, z, 6);
  return mergeGeometries([
    // Clamp bolt with its thumb nut on the left, and the knurled battery cap on the right.
    crossPin(0.0032, 0.046, 0, 0.0055, BODY_CENTRE, 10),
    crossPin(0.0068, 0.006, -0.0235, 0.0055, BODY_CENTRE, 8),
    crossPin(0.0092, 0.005, BODY.width / 2 + 0.003, 0.0165, front + 0.009, 18),
    // Hood screws, housing screws and the four that hold the rear panel.
    screw(hoodSide, HOLO_AXIS_HEIGHT + 0.012, -0.03),
    screw(hoodSide, HOLO_AXIS_HEIGHT + 0.012, -0.01),
    screw(-hoodSide, HOLO_AXIS_HEIGHT + 0.012, -0.03),
    screw(-hoodSide, HOLO_AXIS_HEIGHT + 0.012, -0.01),
    screw(BODY.width / 2, 0.02, -0.02),
    screw(-BODY.width / 2, 0.02, -0.02),
    axialPin(0.0014, 0.0014, -0.0195, 0.0235, rear),
    axialPin(0.0014, 0.0014, 0.0195, 0.0235, rear),
    axialPin(0.0014, 0.0014, -0.0195, 0.0095, rear),
    axialPin(0.0014, 0.0014, 0.0195, 0.0095, rear),
  ]);
}

function buttonGeometry(): THREE.BufferGeometry {
  const z = HOLO_BODY.rear + 0.0012;
  return mergeGeometries([
    box(0.0085, 0.0075, 0.002, -0.0105, 0.0145, z),
    box(0.0085, 0.0075, 0.002, 0.0105, 0.0145, z),
    box(0.005, 0.0045, 0.002, 0, 0.0145, z),
  ]);
}

function reticleMaterial(): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  // Angle between this pixel's view ray and the sight's own axis, both in view space.
  const axis = modelViewMatrix.mul(vec4(0, 0, -1, 0)).xyz.normalize();
  const offAxis = length(positionView.normalize().sub(axis));
  // smoothstep needs its edges in ascending order, so each falloff is written as one minus a rise.
  const fade = (inner: number, outer: number, value: typeof offAxis) => smoothstep(float(inner), float(outer), value).oneMinus();
  const dot = fade(RETICLE.dot * 0.6, RETICLE.dot * 1.5, offAxis);
  const ring = fade(RETICLE.ringWidth * 0.5, RETICLE.ringWidth * 1.6, offAxis.sub(RETICLE.ring).abs()).mul(0.8);
  const glow = fade(0, RETICLE.dot * 5, offAxis).mul(0.18);
  const reticle = max(max(dot, ring), glow);
  material.colorNode = color(RETICLE.color).mul(RETICLE.gain);
  material.opacityNode = reticle;
  return material;
}

interface HoloParts {
  readonly body: THREE.BufferGeometry;
  readonly hardware: THREE.BufferGeometry;
  readonly buttons: THREE.BufferGeometry;
  readonly pane: THREE.BufferGeometry;
  readonly glass: THREE.Material;
  readonly reticle: THREE.Material;
}

let shared: HoloParts | null = null;

function parts(): HoloParts {
  if (shared) return shared;
  const glass = lensMaterial(0x2c4a5a);
  glass.opacity = 0.16;
  shared = {
    body: bodyGeometry(),
    hardware: hardwareGeometry(),
    buttons: buttonGeometry(),
    pane: new THREE.PlaneGeometry(HOLO_WINDOW.width + 0.002, HOLO_WINDOW.height + 0.002),
    glass,
    reticle: reticleMaterial(),
  };
  return shared;
}

/** A holographic sight. Geometry and materials are shared between calls. */
export function buildHoloSight(): THREE.Group {
  const { body, hardware, buttons, pane, glass, reticle } = parts();
  const group = new THREE.Group();
  group.name = 'holo_sight';
  const solid = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const frontGlass = new THREE.Mesh(pane, glass);
  frontGlass.name = 'holo_glass';
  frontGlass.position.set(0, HOLO_AXIS_HEIGHT, HOOD.front + 0.004);
  const reticlePane = new THREE.Mesh(pane, reticle);
  reticlePane.name = 'holo_reticle';
  reticlePane.position.set(0, HOLO_AXIS_HEIGHT, -0.003);
  reticlePane.renderOrder = 2;
  group.add(
    solid(body, plainFinish('holo_body', 0x1d1e20, 0.52, 0.6), 'holo_body'),
    solid(hardware, plainFinish('holo_hardware', 0x34363a, 0.42, 0.9), 'holo_hardware'),
    solid(buttons, plainFinish('holo_buttons', 0x0c0c0d, 0.85, 0), 'holo_buttons'),
    frontGlass,
    reticlePane,
  );
  return group;
}
