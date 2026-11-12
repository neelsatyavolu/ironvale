// Finds surfaces that will z-fight (flicker): same-facing triangles from the map that overlap in area and lie
// within GAP metres of each other. Also lists meshes whose material uses polygonOffset (decals), which are
// skipped as the intended way to layer coplanar surfaces.
// Usage: node scripts/dev/map-zfight.mjs <map> [--port 5311] [--gap 0.015] [--json out.json]
//   (needs npm run dev). Exit code 1 when anything overlaps.
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const mapId = process.argv[2];
if (!mapId || mapId.startsWith('--')) {
  process.stderr.write('usage: node scripts/dev/map-zfight.mjs <railyard|harbor|headworks> [--gap 0.015]\n');
  process.exit(2);
}
const port = arg('--port', '5311');
const gap = Number(arg('--gap', '0.015'));
const jsonOut = arg('--json', null);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
await page.goto(`http://127.0.0.1:${port}/?autostart&map=${mapId}&bots=0&q=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 180000 });

/** Runs inside the page. */
function scan(GAP) {
  const root = window.__ironvale.game.map.root;
  const MIN_AREA = 0.004;
  const MIN_OVERLAP = 0.002;
  const NQ = 40; // normal quantisation steps per axis
  const tris = []; // {owner, n:[x,y,z], d, a:[...], b:[...], c:[...], area}
  const owners = [];
  const skippedOffset = new Set();
  const m4 = root.matrixWorld.clone();
  root.updateMatrixWorld(true);

  const nameOf = (o) => {
    const parts = [];
    for (let p = o; p && p !== root && parts.length < 4; p = p.parent) if (p.name) parts.push(p.name);
    return parts.join(' < ') || o.type;
  };
  const matName = (m) => (Array.isArray(m) ? m.map((x) => x.name || x.type).join('+') : m.name || m.type);

  root.traverse((o) => {
    if (!o.isMesh || !o.visible || o.isSkinnedMesh) return;
    let hidden = false;
    for (let p = o.parent; p; p = p.parent) if (!p.visible) hidden = true;
    if (hidden) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.every((m) => m.polygonOffset || m.transparent || m.depthWrite === false || m.colorWrite === false)) {
      if (mats.some((m) => m.polygonOffset)) skippedOffset.add(nameOf(o));
      return;
    }
    const g = o.geometry;
    const pos = g.attributes.position;
    if (!pos) return;
    const index = g.index;
    const count = index ? index.count : pos.count;
    const instances = o.isInstancedMesh ? o.count : 1;
    const local = new m4.constructor();
    const world = new m4.constructor();
    const P = (i, M) => {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const e = M.elements;
      return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
    };
    for (let k = 0; k < instances; k++) {
      if (o.isInstancedMesh) {
        o.getMatrixAt(k, local);
        world.multiplyMatrices(o.matrixWorld, local);
      } else world.copy(o.matrixWorld);
      const owner = owners.length;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox.clone().applyMatrix4(world);
      const col = mats[0].color ? mats[0].color.getHexString() : '-';
      const tri = Math.round(count / 3);
      const size = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].map((x) => x.toFixed(1)).join('x');
      owners.push({
        name: `${nameOf(o)} ${tri}t #${col}${mats[0].map ? ' tex' : ''} ${size}${o.isInstancedMesh ? ` inst${k}/${o.count}` : ''}`,
        mat: matName(o.material),
        instance: o.isInstancedMesh ? k : -1,
        geometry: g,
        materials: mats,
      });
      for (let t = 0; t + 2 < count; t += 3) {
        const ia = index ? index.getX(t) : t, ib = index ? index.getX(t + 1) : t + 1, ic = index ? index.getX(t + 2) : t + 2;
        const a = P(ia, world), b = P(ib, world), c = P(ic, world);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        const area = len / 2;
        if (area < MIN_AREA) continue;
        n[0] /= len; n[1] /= len; n[2] /= len;
        const group = g.groups.find((gr) => t >= gr.start && t < gr.start + gr.count);
        const material = mats[group?.materialIndex ?? 0] ?? mats[0];
        if (material.polygonOffset || material.transparent || material.depthWrite === false) continue;
        tris.push({ owner, n, d: n[0] * a[0] + n[1] * a[1] + n[2] * a[2], a, b, c, area, ix: [ia, ib, ic], material });
      }
    }
  });

  // Bucket by quantised normal and plane distance (each triangle also goes in the next distance bucket up).
  const buckets = new Map();
  const put = (key, i) => {
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(i);
  };
  tris.forEach((t, i) => {
    const nk = t.n.map((x) => Math.round(x * NQ)).join(',');
    const db = Math.floor(t.d / GAP);
    put(`${nk}|${db}`, i);
    put(`${nk}|${db + 1}`, i);
  });

  const basis = (n) => {
    const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = [ref[1] * n[2] - ref[2] * n[1], ref[2] * n[0] - ref[0] * n[2], ref[0] * n[1] - ref[1] * n[0]];
    const l = Math.hypot(...u);
    const uu = u.map((x) => x / l);
    const vv = [n[1] * uu[2] - n[2] * uu[1], n[2] * uu[0] - n[0] * uu[2], n[0] * uu[1] - n[1] * uu[0]];
    return [uu, vv];
  };
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const area2 = (poly) => {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      s += p[0] * q[1] - q[0] * p[1];
    }
    return s / 2;
  };
  const clip = (subject, clipper) => {
    // Sutherland-Hodgman; both counter-clockwise.
    let out = subject;
    for (let i = 0; i < clipper.length && out.length; i++) {
      const A = clipper[i], B = clipper[(i + 1) % clipper.length];
      const inside = (p) => (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]) >= -1e-9;
      const cut = (p, q) => {
        const d1 = (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]);
        const d2 = (B[0] - A[0]) * (q[1] - A[1]) - (B[1] - A[1]) * (q[0] - A[0]);
        const t = d1 / (d1 - d2);
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      };
      const input = out;
      out = [];
      for (let j = 0; j < input.length; j++) {
        const P = input[j], Q = input[(j + 1) % input.length];
        if (inside(Q)) {
          if (!inside(P)) out.push(cut(P, Q));
          out.push(Q);
        } else if (inside(P)) out.push(cut(P, Q));
      }
    }
    return out;
  };

  /** uv and vertex colour of a triangle at a point on its plane (barycentric). */
  const shadeAt = (t, p) => {
    const v0 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]], v1 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
    const v2 = [p[0] - t.a[0], p[1] - t.a[1], p[2] - t.a[2]];
    const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
    const den = d00 * d11 - d01 * d01;
    const wv = (d11 * d20 - d01 * d21) / den, ww = (d00 * d21 - d01 * d20) / den, wu = 1 - wv - ww;
    const g = owners[t.owner].geometry;
    const out = [];
    for (const name of ['uv', 'color']) {
      const attr = g.attributes[name];
      if (!attr) continue;
      for (let j = 0; j < attr.itemSize && j < 3; j++) {
        const get = (i) => attr.getComponent(i, j);
        out.push(wu * get(t.ix[0]) + wv * get(t.ix[1]) + ww * get(t.ix[2]));
      }
    }
    return out;
  };
  /** true when two overlapping triangles would draw the same pixels, so a depth tie cannot be seen. */
  const looksSame = (t1, t2, p) => {
    if (t1.material !== t2.material) return false;
    if (owners[t1.owner].geometry !== owners[t2.owner].geometry) return false;
    const s1 = shadeAt(t1, p), s2 = shadeAt(t2, p);
    return s1.length === s2.length && s1.every((x, i) => Math.abs(x - s2[i]) < 2e-3);
  };
  const seen = new Set();
  const pairs = new Map(); // ownerA|ownerB -> summary
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const first = tris[list[0]];
    const [U, V] = basis(first.n);
    const proj = (p) => [dot(p, U), dot(p, V)];
    // 2D grid inside the bucket so large flat buckets (ground) stay cheap.
    const CELL = 2;
    const grid = new Map();
    const boxes = list.map((i) => {
      const t = tris[i];
      const pts = [proj(t.a), proj(t.b), proj(t.c)];
      if (area2(pts) < 0) pts.reverse();
      const box = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
      return { i, pts, box };
    });
    boxes.forEach((e, k) => {
      for (let x = Math.floor(e.box[0] / CELL); x <= Math.floor(e.box[2] / CELL); x++)
        for (let y = Math.floor(e.box[1] / CELL); y <= Math.floor(e.box[3] / CELL); y++) {
          const key = x * 100003 + y;
          let l = grid.get(key);
          if (!l) grid.set(key, (l = []));
          l.push(k);
        }
    });
    for (const cell of grid.values()) {
      for (let x = 0; x < cell.length; x++)
        for (let y = x + 1; y < cell.length; y++) {
          const e1 = boxes[cell[x]], e2 = boxes[cell[y]];
          const t1 = tris[e1.i], t2 = tris[e2.i];
          const pk = e1.i < e2.i ? `${e1.i}:${e2.i}` : `${e2.i}:${e1.i}`;
          if (seen.has(pk)) continue;
          seen.add(pk);
          if (Math.abs(t1.d - t2.d) > GAP) continue;
          // Faces pointing down at ground level cannot be seen.
          if (t1.n[1] < -0.9 && Math.max(t1.a[1], t1.b[1], t1.c[1]) < 0.2) continue;
          if (t1.n[0] * t2.n[0] + t1.n[1] * t2.n[1] + t1.n[2] * t2.n[2] < 0.998) continue;
          const b1 = e1.box, b2 = e2.box;
          if (b1[0] >= b2[2] || b2[0] >= b1[2] || b1[1] >= b2[3] || b2[1] >= b1[3]) continue;
          const inter = clip(e1.pts, e2.pts);
          if (inter.length < 3) continue;
          const ov = Math.abs(area2(inter));
          if (ov < MIN_OVERLAP) continue;
          const icx = inter.reduce((q, p) => q + p[0], 0) / inter.length, icy = inter.reduce((q, p) => q + p[1], 0) / inter.length;
          const mid = [0, 1, 2].map((j) => U[j] * icx + V[j] * icy + first.n[j] * t1.d);
          if (Math.abs(t1.d - t2.d) < 1e-4 && looksSame(t1, t2, mid)) continue;
          const oa = Math.min(t1.owner, t2.owner), ob = Math.max(t1.owner, t2.owner);
          const nameA = owners[oa], nameB = owners[ob];
          const key = `${oa}|${ob}`;
          const cx = inter.reduce((s, p) => s + p[0], 0) / inter.length, cy = inter.reduce((s, p) => s + p[1], 0) / inter.length;
          const centre = [0, 1, 2].map((j) => U[j] * cx + V[j] * cy + first.n[j] * t1.d).map((x) => Number(x.toFixed(2)));
          const prev = pairs.get(key);
          if (prev) {
            prev.area += ov;
            prev.count++;
            prev.gap = Math.min(prev.gap, Math.abs(t1.d - t2.d));
            if (prev.where.length < 4) prev.where.push(centre);
          } else
            pairs.set(key, {
              a: `${nameA.name} [${nameA.mat}]`,
              b: `${nameB.name} [${nameB.mat}]`,
              same: oa === ob,
              area: ov,
              count: 1,
              gap: Math.abs(t1.d - t2.d),
              normal: first.n.map((x) => Number(x.toFixed(2))),
              where: [centre],
            });
        }
    }
  }
  const list = [...pairs.values()].sort((p, q) => q.area - p.area);
  for (const o of owners) { delete o.geometry; delete o.materials; }
  return { triangles: tris.length, owners: owners.length, decals: [...skippedOffset].slice(0, 30), pairs: list };
}

const result = await page.evaluate(scan, gap);
await browser.close();
if (jsonOut) await writeFile(jsonOut, JSON.stringify(result, null, 1));
process.stdout.write(`${mapId}: ${result.triangles} triangles in ${result.owners} mesh instances, ${result.pairs.length} overlapping pairs (gap <= ${gap} m)\n`);
for (const p of result.pairs.slice(0, 60))
  process.stdout.write(
    `${p.area.toFixed(3).padStart(8)} m2 x${String(p.count).padEnd(4)} gap ${p.gap.toFixed(4)} n[${p.normal}] ${p.same ? '(self) ' : ''}${p.a}  <>  ${p.b}  at ${p.where.map((w) => `(${w})`).join(' ')}\n`,
  );
process.exit(result.pairs.length ? 1 : 0);
