// Captures the visible level a map build() produced, for the native renderer (M3). The scene
// graph is flattened to world space; TSL node graphs cannot be exported, so each material keeps
// its name, scalar parameters, texture slots and the list of node slots it overrides, and the
// matching surface program is hand-ported in MSL (PLAN.md 3.4).
//
// render/scene.json   format "ironvale-map-render" version 1, described by the RenderScene type
// render/buffers.bin  every accessor, 16-byte aligned
// render/textures/    canvas and image textures as PNG (t<index>.png), data textures as raw bytes
import * as THREE from 'three/webgpu';
import { ByteWriter, json, writeFile } from './io';
import { aoProgramOf, instanceAttributeOf, nodeTexturesOf, programOf, type ProgramTable } from './programs';

type Vec = number[];

interface Accessor {
  offset: number;
  byteLength: number;
  count: number;
  itemSize: number;
  type: string;
  normalized: boolean;
}

interface RenderScene {
  format: 'ironvale-map-render';
  version: 1;
  mapId: string;
  detailDensity: number;
  buffer: { uri: string; byteLength: number };
  accessors: Accessor[];
  geometries: unknown[];
  textures: unknown[];
  materials: unknown[];
  meshes: unknown[];
  lights: unknown[];
  skipped: { type: string; name: string; path: string }[];
  /** Plan numbers the map's surface programs read (programs.ts); absent for maps without programs. */
  programParams?: Record<string, unknown>;
}

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
  'bumpMap',
  'displacementMap',
  'lightMap',
  'envMap',
] as const;

const SCALARS = [
  'roughness',
  'metalness',
  'opacity',
  'transparent',
  'alphaTest',
  'side',
  'depthWrite',
  'depthTest',
  'vertexColors',
  'flatShading',
  'fog',
  'toneMapped',
  'blending',
  'polygonOffset',
  'polygonOffsetFactor',
  'polygonOffsetUnits',
  'emissiveIntensity',
  'envMapIntensity',
  'aoMapIntensity',
  'normalMapType',
  'bumpScale',
  'displacementScale',
  'displacementBias',
  'wireframe',
  'visible',
  'colorWrite',
  'premultipliedAlpha',
  'alphaToCoverage',
] as const;

function typeName(array: ArrayLike<number>): string {
  if (array instanceof Float32Array) return 'f32';
  if (array instanceof Uint32Array) return 'u32';
  if (array instanceof Uint16Array) return 'u16';
  if (array instanceof Uint8Array || array instanceof Uint8ClampedArray) return 'u8';
  if (array instanceof Int32Array) return 'i32';
  if (array instanceof Int16Array) return 'i16';
  if (array instanceof Int8Array) return 'i8';
  throw new Error(`unsupported attribute array ${Object.prototype.toString.call(array)}`);
}

const colorHex = (c: THREE.Color | undefined) => (c ? c.getHex(THREE.LinearSRGBColorSpace) : undefined);
const vec = (v: THREE.Vector3): Vec => [v.x, v.y, v.z];

/** Ancestor names from the root down, for finding a mesh's builder. */
function pathOf(object: THREE.Object3D, root: THREE.Object3D): string {
  const names: string[] = [];
  for (let o: THREE.Object3D | null = object; o && o !== root; o = o.parent) names.push(o.name || o.type);
  return names.reverse().join('/');
}

export async function exportRender(root: THREE.Object3D, mapId: string, dir: string, programs: ProgramTable | null = null): Promise<{ meshes: number; textures: number; bytes: number }> {
  root.updateMatrixWorld(true);
  const bin = new ByteWriter();
  const scene: RenderScene = {
    format: 'ironvale-map-render',
    version: 1,
    mapId,
    detailDensity: 1,
    buffer: { uri: 'buffers.bin', byteLength: 0 },
    accessors: [],
    geometries: [],
    textures: [],
    materials: [],
    meshes: [],
    lights: [],
    skipped: [],
    ...(programs ? { programParams: programs.params } : {}),
  };
  const geometryIds = new Map<THREE.BufferGeometry, number>();
  const materialIds = new Map<THREE.Material, number>();
  const textureIds = new Map<THREE.Texture, number>();
  const pending: Promise<void>[] = [];

  const accessor = (array: ArrayLike<number> & ArrayBufferView, itemSize: number, normalized: boolean): number => {
    bin.align(16);
    const entry = { offset: bin.length, byteLength: array.byteLength, count: array.length / itemSize, itemSize, type: typeName(array), normalized };
    bin.raw(array);
    scene.accessors.push(entry);
    return scene.accessors.length - 1;
  };

  const geometry = (g: THREE.BufferGeometry): number => {
    const known = geometryIds.get(g);
    if (known !== undefined) return known;
    const attributes: Record<string, number> = {};
    for (const [name, attr] of Object.entries(g.attributes)) {
      if ((attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
        const ia = attr as THREE.InterleavedBufferAttribute;
        const flat = new Float32Array(ia.count * ia.itemSize);
        for (let i = 0; i < ia.count; i++) for (let k = 0; k < ia.itemSize; k++) flat[i * ia.itemSize + k] = ia.getComponent(i, k);
        attributes[name] = accessor(flat, ia.itemSize, ia.normalized);
      } else {
        const a = attr as THREE.BufferAttribute;
        attributes[name] = accessor(a.array as Float32Array, a.itemSize, a.normalized);
      }
    }
    const entry = {
      name: g.name,
      attributes,
      index: g.index ? accessor(g.index.array as Uint32Array, 1, false) : null,
      groups: g.groups.map((group) => ({ start: group.start, count: Number.isFinite(group.count) ? group.count : -1, materialIndex: group.materialIndex ?? 0 })),
      drawRange: { start: g.drawRange.start, count: Number.isFinite(g.drawRange.count) ? g.drawRange.count : -1 },
    };
    scene.geometries.push(entry);
    geometryIds.set(g, scene.geometries.length - 1);
    return scene.geometries.length - 1;
  };

  const texture = (t: THREE.Texture): number => {
    const known = textureIds.get(t);
    if (known !== undefined) return known;
    const index = scene.textures.length;
    textureIds.set(t, index);
    const base = {
      name: t.name,
      wrapS: t.wrapS,
      wrapT: t.wrapT,
      repeat: [t.repeat.x, t.repeat.y],
      offset: [t.offset.x, t.offset.y],
      center: [t.center.x, t.center.y],
      rotation: t.rotation,
      colorSpace: t.colorSpace,
      flipY: t.flipY,
      magFilter: t.magFilter,
      minFilter: t.minFilter,
      generateMipmaps: t.generateMipmaps,
      anisotropy: t.anisotropy,
      channel: t.channel,
      format: t.format,
      type: t.type,
    };
    const image = t.image as unknown;
    const data = image as { data?: ArrayBufferView; width?: number; height?: number; depth?: number };
    if ((t as THREE.DataTexture).isDataTexture || (data && data.data && ArrayBuffer.isView(data.data))) {
      const uri = `textures/t${index}.bin`;
      const view = data.data as ArrayBufferView;
      pending.push(writeFile(`${dir}/${uri}`, new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()));
      scene.textures.push({ ...base, kind: 'raw', uri, width: data.width, height: data.height, depth: data.depth ?? 1, dataType: typeName(view as unknown as Float32Array) });
    } else if (image instanceof HTMLImageElement && image.src && !image.src.startsWith('data:') && !image.src.startsWith('blob:')) {
      const url = new URL(image.src);
      scene.textures.push({ ...base, kind: 'url', uri: url.pathname.replace(/^\//, ''), width: image.naturalWidth, height: image.naturalHeight });
    } else if (image && typeof image === 'object' && 'width' in (image as object)) {
      const source = image as CanvasImageSource & { width: number; height: number };
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.getContext('2d')!.drawImage(source, 0, 0);
      const uri = `textures/t${index}.png`;
      pending.push(
        new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'))
          .then((blob) => blob.arrayBuffer())
          .then((buffer) => writeFile(`${dir}/${uri}`, buffer)),
      );
      scene.textures.push({ ...base, kind: 'png', uri, width: source.width, height: source.height });
    } else {
      scene.textures.push({ ...base, kind: 'none' });
    }
    return index;
  };

  const material = (m: THREE.Material): number => {
    const known = materialIds.get(m);
    if (known !== undefined) return known;
    const record: Record<string, unknown> = { type: m.type, name: m.name };
    const any = m as unknown as Record<string, unknown>;
    for (const key of SCALARS) if (key in any && typeof any[key] !== 'object') record[key] = any[key];
    for (const key of ['color', 'emissive', 'sheenColor', 'specularColor', 'attenuationColor'] as const) {
      if (any[key] instanceof THREE.Color) record[key] = colorHex(any[key] as THREE.Color);
    }
    for (const key of ['normalScale'] as const) if (any[key] instanceof THREE.Vector2) record[key] = [(any[key] as THREE.Vector2).x, (any[key] as THREE.Vector2).y];
    const maps: Record<string, number> = {};
    for (const slot of TEXTURE_SLOTS) {
      const t = any[slot];
      if (t instanceof THREE.Texture) maps[slot] = texture(t);
    }
    record.maps = maps;
    record.nodes = Object.keys(any)
      .filter((key) => key.endsWith('Node') && any[key] != null)
      .sort();
    // Hand-ported surface program (programs.ts); null when the node graph matches no reference.
    if (programs) {
      record.program = programOf(programs, m);
      record.aoProgram = aoProgramOf(programs, m);
      const nodeMaps: Record<string, number> = {};
      for (const [slot, t] of Object.entries(nodeTexturesOf(m))) nodeMaps[slot] = texture(t);
      record.nodeMaps = nodeMaps;
    }
    if (m.userData && Object.keys(m.userData).length) record.userData = JSON.parse(JSON.stringify(m.userData));
    scene.materials.push(record);
    materialIds.set(m, scene.materials.length - 1);
    return scene.materials.length - 1;
  };

  root.traverse((object) => {
    if (!object.visible) return;
    const path = pathOf(object, root);
    if ((object as THREE.Light).isLight) {
      const light = object as THREE.Light & Partial<THREE.PointLight & THREE.SpotLight & THREE.HemisphereLight>;
      const position = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
      const entry: Record<string, unknown> = {
        type: light.type,
        name: light.name,
        path,
        color: colorHex(light.color),
        intensity: light.intensity,
        position: vec(position),
        castShadow: light.castShadow,
      };
      if (light.distance !== undefined) entry.distance = light.distance;
      if (light.decay !== undefined) entry.decay = light.decay;
      if (light.angle !== undefined) entry.angle = light.angle;
      if (light.penumbra !== undefined) entry.penumbra = light.penumbra;
      if (light.groundColor) entry.groundColor = colorHex(light.groundColor);
      const target = (light as THREE.SpotLight).target;
      if (target) {
        target.updateMatrixWorld(true);
        entry.target = vec(new THREE.Vector3().setFromMatrixPosition(target.matrixWorld));
      }
      scene.lights.push(entry);
      return;
    }
    if (!(object as THREE.Mesh).isMesh) {
      if (object.type !== 'Group' && object.type !== 'Object3D' && object.type !== 'Scene') {
        scene.skipped.push({ type: object.type, name: object.name, path });
      }
      return;
    }
    const mesh = object as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material.map(material) : material(mesh.material);
    const entry: Record<string, unknown> = {
      name: mesh.name,
      path,
      type: mesh.type,
      geometry: geometry(mesh.geometry),
      material: materials,
      matrixWorld: mesh.matrixWorld.toArray(),
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      renderOrder: mesh.renderOrder,
      frustumCulled: mesh.frustumCulled,
    };
    if (mesh.userData && Object.keys(mesh.userData).length) entry.userData = JSON.parse(JSON.stringify(mesh.userData));
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const inst = mesh as THREE.InstancedMesh;
      entry.instances = {
        count: inst.count,
        matrices: accessor(inst.instanceMatrix.array.slice(0, inst.count * 16) as Float32Array, 16, false),
        colors: inst.instanceColor ? accessor(inst.instanceColor.array.slice(0, inst.count * 3) as Float32Array, 3, false) : null,
      };
      // Per-instance attributes read by the colour node (the container livery), named by role.
      const own = Array.isArray(mesh.material) ? null : instanceAttributeOf(mesh.material);
      if (own) {
        (entry.instances as Record<string, unknown>).attributes = {
          livery: accessor((own.array as Float32Array).slice(0, inst.count * own.itemSize), own.itemSize, false),
        };
      }
    }
    scene.meshes.push(entry);
  });

  const bytes = bin.finish();
  scene.buffer.byteLength = bytes.byteLength;
  pending.push(writeFile(`${dir}/buffers.bin`, bytes));
  pending.push(writeFile(`${dir}/scene.json`, json(scene)));
  await Promise.all(pending);
  return { meshes: scene.meshes.length, textures: scene.textures.length, bytes: bytes.byteLength };
}
