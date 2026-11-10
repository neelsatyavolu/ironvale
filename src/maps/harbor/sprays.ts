import * as THREE from 'three/webgpu';

const CELL = 256;

/**
 * Two sprays of foliage on a transparent ground, side by side: plain leaves,
 * then leaves with magenta bracts. Each is thick in the middle and ragged at
 * the rim, so overlapping cards build a mass with a broken outline.
 */
function drawSprays(random: () => number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CELL * 2;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Harbor: 2D canvas is not available for the creepers');
  const blob = (cx: number, cy: number, rx: number, ry: number, turn: number, fill: string): void => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, turn, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const cell of [0, 1]) {
    const ox = cell * CELL + CELL / 2;
    const leaves = 520;
    for (let i = 0; i < leaves; i++) {
      const reach = Math.pow(random(), 0.7) * 118 * (0.5 + 0.5 * random());
      const angle = random() * Math.PI * 2;
      // Later leaves sit on top and catch more light.
      const light = 9 + (i / leaves) * 22 + random() * 8;
      blob(ox + Math.cos(angle) * reach, CELL / 2 + Math.sin(angle) * reach, 6 + random() * 7, 3 + random() * 3.5, random() * Math.PI, `hsl(${88 + random() * 34}, ${32 + random() * 22}%, ${light}%)`);
    }
    if (cell === 1) {
      for (let i = 0; i < 70; i++) {
        const reach = Math.pow(random(), 0.6) * 104;
        const angle = random() * Math.PI * 2;
        const cx = ox + Math.cos(angle) * reach;
        const cy = CELL / 2 + Math.sin(angle) * reach;
        for (let k = 0; k < 4; k++) {
          blob(cx + (random() - 0.5) * 12, cy + (random() - 0.5) * 12, 3 + random() * 3.5, 2.5 + random() * 2.5, random() * Math.PI, `hsl(${316 + random() * 20}, ${62 + random() * 20}%, ${36 + random() * 22}%)`);
        }
      }
    }
  }
  return canvas;
}

/** Cut-out foliage texture: plain leaves in the left half, leaves in flower in the right half. */
export function createSprayMap(random: () => number): THREE.CanvasTexture {
  const map = new THREE.CanvasTexture(drawSprays(random));
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  return map;
}
