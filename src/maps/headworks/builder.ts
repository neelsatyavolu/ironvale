import * as THREE from 'three/webgpu';

const WHITE = 0xffffff;
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/**
 * Accumulates geometries, each baked through a matrix and given one vertex
 * colour, and merges them into a single non-indexed BufferGeometry. Used both
 * for the per-material level batches and for instanced prototypes such as a
 * shipping container.
 */
export class MeshBuilder {
  private readonly positions: Float32Array[] = [];
  private readonly normals: Float32Array[] = [];
  private readonly uvs: Float32Array[] = [];
  private readonly colors: Float32Array[] = [];
  private vertexCount = 0;
  private readonly normalMatrix = new THREE.Matrix3();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly color = new THREE.Color();
  private readonly v = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();

  get empty(): boolean {
    return this.vertexCount === 0;
  }

  /** The geometry is read, not kept, so one geometry can be added many times. */
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, color: number = WHITE): this {
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    const positions = source.getAttribute('position');
    const normals = source.getAttribute('normal');
    const uvs = source.getAttribute('uv');
    // A geometry that was itself built here keeps its per-part colours; `color` multiplies them.
    const tints = source.getAttribute('color');
    const count = positions.count;
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const colors = new Float32Array(count * 3);
    this.normalMatrix.getNormalMatrix(matrix);
    this.color.setHex(color);
    const v = this.v;
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(positions, i).applyMatrix4(matrix);
      position[i * 3] = v.x;
      position[i * 3 + 1] = v.y;
      position[i * 3 + 2] = v.z;
      v.fromBufferAttribute(normals, i).applyMatrix3(this.normalMatrix).normalize();
      normal[i * 3] = v.x;
      normal[i * 3 + 1] = v.y;
      normal[i * 3 + 2] = v.z;
      if (uvs) {
        uv[i * 2] = uvs.getX(i);
        uv[i * 2 + 1] = uvs.getY(i);
      }
      colors[i * 3] = this.color.r * (tints ? tints.getX(i) : 1);
      colors[i * 3 + 1] = this.color.g * (tints ? tints.getY(i) : 1);
      colors[i * 3 + 2] = this.color.b * (tints ? tints.getZ(i) : 1);
    }
    if (source !== geometry) source.dispose();
    this.positions.push(position);
    this.normals.push(normal);
    this.uvs.push(uv);
    this.colors.push(colors);
    this.vertexCount += count;
    return this;
  }

  /** Box centred on (x, y, z), optionally rotated (Euler XYZ, radians). */
  box(
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    color: number = WHITE,
    rotation: readonly [number, number, number] = [0, 0, 0],
  ): this {
    this.quaternion.setFromEuler(this.euler.set(rotation[0], rotation[1], rotation[2]));
    this.matrix.compose(this.v.set(x, y, z), this.quaternion, this.scale.set(width, height, depth));
    return this.add(UNIT_BOX, this.matrix, color);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(concat(this.positions, this.vertexCount * 3), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(concat(this.normals, this.vertexCount * 3), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(concat(this.uvs, this.vertexCount * 2), 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(concat(this.colors, this.vertexCount * 3), 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function concat(parts: readonly Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
