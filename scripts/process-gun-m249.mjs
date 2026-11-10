// Builds public/assets/local/guns/m249.glb from "LMG" by DJMaesen (CC BY 4.0, Objaverse mirror).
// Usage: node scripts/process-gun-m249.mjs
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress, weld } from '@gltf-transform/functions';
import sharp from 'sharp';
import { download } from './lib/guns-c-download.mjs';
import { HALF_TURN_Y, buildPart, multiply, pick, replaceScene, report, translation } from './lib/guns-c-gltf.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public/assets/local/guns/m249.glb');
const SOURCE = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-129/8c24d7374ea64bdab1c30f49c69d5ed8.glb';
/** Gun-space offset applied after the half turn, so the pistol grip centre is the origin. */
const OFFSET = [0, 0.02, -0.015];
/** Source coordinates (barrel along +Z) to gun space (barrel along -Z, origin at the grip). */
const at = (x, y, z) => [-x + OFFSET[0], y + OFFSET[1], -z + OFFSET[2]];
/** Rear peep in gun space. The source hole is 3 mm across, too small to aim through on a screen. */
const APERTURE = { centre: at(0, 0.13875, -0.0175), sourceRadius: 0.002, radius: 0.0028, halfDepth: 0.004 };

const io = new NodeIO().registerExtensions([EXTTextureWebP]);
const doc = await io.read(await download(SOURCE, join(root, '.cache/guns-c/m249/lmg-bumstrum.glb')));

const toGun = multiply(translation(OFFSET), HALF_TURN_Y);
const gun = doc.createNode('m249');
buildPart(doc, gun, 'body', pick(doc, 'base', 'handle', 'ejector'), toGun);
buildPart(doc, gun, 'magazine', pick(doc, 'mag'), toGun, at(0.006, 0.03, 0.13));
buildPart(doc, gun, 'bolt', pick(doc, 'bolt'), toGun, at(0, 0.086, 0.04));
buildPart(doc, gun, 'chargingHandle', pick(doc, 'loader'), toGun, at(-0.03, 0.086, 0.12));
buildPart(doc, gun, 'trigger', pick(doc, 'trigger'), toGun, at(0, 0.035, 0.048));
// Hinge of the feed cover: its front lower edge.
const coverPivot = at(0, 0.108, 0.172);
const cover = buildPart(doc, gun, 'cover', pick(doc, 'cover'), toGun, coverPivot);
replaceScene(doc, gun);

// Open the rear peep up into a ghost ring.
const position = cover.getMesh().listPrimitives()[0].getAttribute('POSITION');
let widened = 0;
for (let i = 0; i < position.getCount(); i++) {
  const p = position.getElement(i, []);
  const dx = p[0] + coverPivot[0] - APERTURE.centre[0];
  const dy = p[1] + coverPivot[1] - APERTURE.centre[1];
  const dz = p[2] + coverPivot[2] - APERTURE.centre[2];
  const r = Math.hypot(dx, dy);
  if (r > APERTURE.sourceRadius || r < 1e-5 || Math.abs(dz) > APERTURE.halfDepth) continue;
  const k = APERTURE.radius / r;
  position.setElement(i, [p[0] + dx * (k - 1), p[1] + dy * (k - 1), p[2]]);
  widened++;
}
if (widened === 0) throw new Error('Rear aperture not found: the source model changed');

await doc.transform(weld(), dedup(), prune(), textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 90, resize: [1024, 1024] }));
await mkdir(dirname(out), { recursive: true });
await io.write(out, doc);
await report(out, doc);
process.stdout.write(`rear aperture vertices widened: ${widened}\n`);
