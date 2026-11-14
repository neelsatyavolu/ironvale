// IVM writer (PLAN.md 3.5). The Swift reader is native/IronvaleKit/Sources/IronvaleAssets/IVM.swift;
// the layout is documented there and must change in both places together (bump IVM_VERSION).

export const IVM_MAGIC = 0x314d5649; // "IVM1" little-endian
export const IVM_VERSION = 1;

export const ATTR = { normal: 1, uv: 2, tangent: 4, joints: 8, weights: 16 };
const PATHS = { translation: 0, rotation: 1, scale: 2, weights: 3 };
const INTERPOLATION = { LINEAR: 0, STEP: 1, CUBICSPLINE: 2 };

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    const pad = (4 - (bytes.byteLength % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
  }
  u32(...values) { this.push(new Uint8Array(new Uint32Array(values).buffer)); }
  i32(...values) { this.push(new Uint8Array(new Int32Array(values).buffer)); }
  f32(values) { this.push(new Uint8Array(Float32Array.from(values).buffer)); }
  f64(values) { this.push(new Uint8Array(Float64Array.from(values).buffer)); }
  str(text) {
    const bytes = new TextEncoder().encode(text);
    this.u32(bytes.byteLength);
    this.push(bytes);
  }
  bytes() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

/** Nodes of the default scene in depth-first order, so every parent comes before its children. */
function orderedNodes(root) {
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const out = [];
  const parents = new Map();
  const visit = (node, parent) => {
    parents.set(node, parent);
    out.push(node);
    for (const child of node.listChildren()) visit(child, node);
  };
  for (const node of scene.listChildren()) visit(node, null);
  return { nodes: out, parents };
}

/**
 * Encodes a glTF-Transform document. `textureFiles` maps each Texture to `{uri, colorSpace, width, height}`
 * for the image the caller has written next to the .ivm.
 */
export function encodeIVM(doc, textureFiles) {
  const root = doc.getRoot();
  const textures = root.listTextures();
  const materials = root.listMaterials();
  const meshes = root.listMeshes();
  const skins = root.listSkins();
  const animations = root.listAnimations();
  const { nodes, parents } = orderedNodes(root);
  const nodeIndex = new Map(nodes.map((node, i) => [node, i]));
  const index = (list, item) => (item ? list.indexOf(item) : -1);

  const w = new Writer();
  w.u32(IVM_MAGIC, IVM_VERSION, nodes.length, meshes.length, skins.length, materials.length, textures.length, animations.length);

  for (const texture of textures) {
    const file = textureFiles.get(texture);
    if (!file) throw new Error(`texture ${texture.getName()} has no baked file`);
    w.str(texture.getName());
    w.str(file.uri);
    w.u32(file.colorSpace === 'srgb' ? 1 : 0, file.width, file.height);
  }

  for (const material of materials) {
    w.str(material.getName());
    w.f32(material.getBaseColorFactor());
    w.f32([material.getMetallicFactor(), material.getRoughnessFactor(), material.getNormalScale()]);
    w.f32(material.getEmissiveFactor());
    const alphaMode = { OPAQUE: 0, MASK: 1, BLEND: 2 }[material.getAlphaMode()];
    w.u32((material.getDoubleSided() ? 1 : 0) | (alphaMode << 1));
    w.f32([material.getAlphaCutoff()]);
    w.i32(
      index(textures, material.getBaseColorTexture()),
      index(textures, material.getNormalTexture()),
      index(textures, material.getMetallicRoughnessTexture()),
      index(textures, material.getOcclusionTexture()),
      index(textures, material.getEmissiveTexture()),
    );
  }

  for (const mesh of meshes) {
    w.str(mesh.getName());
    const primitives = mesh.listPrimitives();
    w.u32(primitives.length);
    for (const primitive of primitives) {
      if (primitive.getMode() !== 4) throw new Error(`mesh ${mesh.getName()}: only triangle lists are supported`);
      const position = primitive.getAttribute('POSITION');
      const streams = {
        normal: primitive.getAttribute('NORMAL'),
        uv: primitive.getAttribute('TEXCOORD_0'),
        tangent: primitive.getAttribute('TANGENT'),
        joints: primitive.getAttribute('JOINTS_0'),
        weights: primitive.getAttribute('WEIGHTS_0'),
      };
      const count = position.getCount();
      let mask = 0;
      for (const [name, accessor] of Object.entries(streams)) if (accessor) mask |= ATTR[name];
      w.i32(index(materials, primitive.getMaterial()));
      w.u32(count, mask);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      const p = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        position.getElement(i, p);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k]);
          max[k] = Math.max(max[k], p[k]);
        }
      }
      w.f32([...min, ...max]);
      const floats = (accessor, size) => {
        const out = new Float32Array(count * size);
        const e = new Array(size);
        for (let i = 0; i < count; i++) {
          accessor.getElement(i, e); // getElement denormalises normalized integer data
          for (let k = 0; k < size; k++) out[i * size + k] = e[k];
        }
        return out;
      };
      w.f32(floats(position, 3));
      if (streams.normal) w.f32(floats(streams.normal, 3));
      if (streams.uv) w.f32(floats(streams.uv, 2));
      if (streams.tangent) w.f32(floats(streams.tangent, 4));
      if (streams.joints) {
        const out = new Uint16Array(count * 4);
        const e = [0, 0, 0, 0];
        for (let i = 0; i < count; i++) {
          streams.joints.getElement(i, e);
          for (let k = 0; k < 4; k++) out[i * 4 + k] = e[k];
        }
        w.push(new Uint8Array(out.buffer));
      }
      if (streams.weights) {
        // three normalises skin weights on load (SkinnedMesh.normalizeSkinWeights); so does the bake.
        const out = floats(streams.weights, 4);
        for (let i = 0; i < count; i++) {
          const sum = out[i * 4] + out[i * 4 + 1] + out[i * 4 + 2] + out[i * 4 + 3];
          if (sum > 0) for (let k = 0; k < 4; k++) out[i * 4 + k] /= sum;
        }
        w.f32(out);
      }
      const indices = primitive.getIndices();
      if (indices) {
        const array = indices.getArray();
        const wide = array instanceof Uint32Array || count > 65535;
        w.u32(array.length, wide ? 4 : 2);
        w.push(new Uint8Array((wide ? Uint32Array.from(array) : Uint16Array.from(array)).buffer));
      } else {
        w.u32(0, 2);
      }
    }
  }

  for (const node of nodes) {
    w.str(node.getName());
    const parent = parents.get(node);
    w.i32(parent ? nodeIndex.get(parent) : -1, index(meshes, node.getMesh()), index(skins, node.getSkin()));
    // glTF node transforms are JSON numbers: kept as f64 so the rig matches the web's exactly.
    w.f64([...node.getTranslation(), ...node.getRotation(), ...node.getScale()]);
  }

  for (const skin of skins) {
    w.str(skin.getName());
    const joints = skin.listJoints();
    w.i32(skin.getSkeleton() ? nodeIndex.get(skin.getSkeleton()) : -1);
    w.u32(joints.length);
    w.i32(...joints.map((joint) => {
      if (!nodeIndex.has(joint)) throw new Error(`skin joint ${joint.getName()} is not in the scene`);
      return nodeIndex.get(joint);
    }));
    const ibm = skin.getInverseBindMatrices();
    const matrices = new Float32Array(joints.length * 16);
    for (let i = 0; i < joints.length; i++) {
      const m = ibm ? ibm.getElement(i, new Array(16)) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      matrices.set(m, i * 16);
    }
    w.f32(matrices);
  }

  for (const animation of animations) {
    w.str(animation.getName());
    const channels = animation.listChannels();
    w.u32(channels.length);
    for (const channel of channels) {
      const sampler = channel.getSampler();
      const input = sampler.getInput().getArray();
      const output = sampler.getOutput();
      const components = output.getElementSize();
      w.i32(nodeIndex.get(channel.getTargetNode()));
      w.u32(PATHS[channel.getTargetPath()], INTERPOLATION[sampler.getInterpolation()], input.length, components);
      w.f32(input);
      const values = new Float32Array(output.getCount() * components);
      const e = new Array(components);
      for (let i = 0; i < output.getCount(); i++) {
        output.getElement(i, e);
        values.set(e, i * components);
      }
      w.f32(values);
    }
  }
  return w.bytes();
}
