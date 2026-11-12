// Lists the map meshes whose world bounds contain a point, with triangle count, material, colour and size.
// Usage: node scripts/dev/map-probe.mjs <map> x,y,z [x,y,z ...] [--port 5311]   (needs npm run dev)
import { chromium } from 'playwright';

const port = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '5311';
const [mapId, ...rest] = process.argv.slice(2).filter((a, i, all) => a !== '--port' && all[i - 1] !== '--port');
const points = rest.map((p) => p.split(',').map(Number));

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
await page.goto(`http://127.0.0.1:${port}/?autostart&map=${mapId}&bots=0&q=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 180000 });
const out = await page.evaluate((pts) => {
  const root = window.__ironvale.game.map.root;
  const Box = root.position.constructor; // Vector3
  const lines = [];
  for (const [x, y, z] of pts) {
    lines.push(`-- (${x}, ${y}, ${z})`);
    root.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const inst = o.isInstancedMesh ? o.count : 1;
      const m = new o.matrixWorld.constructor();
      for (let k = 0; k < inst; k++) {
        if (o.isInstancedMesh) {
          o.getMatrixAt(k, m);
          m.premultiply(o.matrixWorld);
        } else m.copy(o.matrixWorld);
        const b = g.boundingBox.clone().applyMatrix4(m);
        const pad = 0.05;
        if (x < b.min.x - pad || x > b.max.x + pad || y < b.min.y - pad || y > b.max.y + pad || z < b.min.z - pad || z > b.max.z + pad) continue;
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        const tri = (g.index ? g.index.count : g.attributes.position.count) / 3;
        const size = new Box();
        b.getSize(size);
        lines.push(
          `${o.isInstancedMesh ? `inst ${k}/${inst}` : 'mesh'} name="${o.name}" parent="${o.parent?.name}" tris=${tri} mat=${mat.type} color=#${mat.color?.getHexString?.()} map=${!!mat.map} side=${mat.side} offset=${mat.polygonOffset} transparent=${mat.transparent} min=(${b.min.toArray().map((v) => v.toFixed(2))}) size=(${size.toArray().map((v) => v.toFixed(2))}) attrs=${Object.keys(g.attributes).join(',')}`,
        );
      }
    });
  }
  return lines;
}, points);
await browser.close();
process.stdout.write(out.join('\n') + '\n');
