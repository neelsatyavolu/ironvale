// Measures foot sliding and rifle steadiness for each gait by stepping the soldier viewer in the page.
// Usage: node scripts/dev/characters-slide.mjs [state,state,...]
// For each state it prints, per foot: the share of the cycle the foot is planted, the mean and peak
// speed of the planted foot over the ground (m/s; 0 is a perfect plant), how far the foot sinks
// below or floats above the ground, and how much the muzzle and head move through the cycle.
import { chromium } from 'playwright';

const states = (process.argv[2] ?? 'walk,jog,run,crouchwalk,aimwalk').split(',');
const SPEEDS = { walk: 1.7, jog: 3.4, run: 5.2, crouchwalk: 1.8, aimwalk: 1.7, idle: 0, aim: 0, crouch: 0 };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
page.on('pageerror', (error) => process.stdout.write(`[pageerror] ${error.message}\n`));

for (const state of states) {
  await page.goto(`http://127.0.0.1:5311/?view=characters/soldier&floor=0&state=${state}&t=0&face=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
  const result = await page.evaluate(
    ({ speed, crouching, aiming }) => {
      const soldier = window.__soldiers[0].visual;
      const dt = 1 / 120;
      const input = { speed, crouching, aimPitch: 0, aiming, firing: false, reloading: false };
      const bone = (name) => soldier.root.getObjectByName(name);
      const names = ['LeftFoot', 'LeftToeBase', 'RightFoot', 'RightToeBase', 'Head', 'Hips'];
      const read = () => {
        soldier.root.updateWorldMatrix(true, true);
        const out = {};
        for (const name of names) out[name] = bone(name).matrixWorld.elements.slice(12, 15);
        out.muzzle = soldier.muzzleWorld(soldier.root.position.clone()).toArray();
        return out;
      };
      // Settle the blends, then record three seconds.
      for (let i = 0; i < 180; i++) {
        soldier.setState(input);
        soldier.update(dt);
      }
      const frames = [];
      for (let i = 0; i < 360; i++) {
        soldier.setState(input);
        soldier.update(dt);
        soldier.refresh();
        frames.push(read());
      }
      const report = {};
      for (const side of ['Left', 'Right']) {
        const ankle = `${side}Foot`;
        const toe = `${side}ToeBase`;
        const minAnkle = Math.min(...frames.map((f) => f[ankle][1]));
        const minToe = Math.min(...frames.map((f) => f[toe][1]));
        let planted = 0;
        let slide = 0;
        let peak = 0;
        for (let i = 1; i < frames.length; i++) {
          const now = frames[i];
          const before = frames[i - 1];
          // Planted: the ball of the foot is on the ground (the heel may already be peeling off).
          if (now[toe][1] > minToe + 0.012 || before[toe][1] > minToe + 0.012) continue;
          planted++;
          // The soldier faces -Z and would travel that way at `speed`; held in place, the ground runs +Z.
          const vx = (now[toe][0] - before[toe][0]) / dt;
          const vz = (now[toe][2] - before[toe][2]) / dt - speed;
          const v = Math.hypot(vx, vz);
          slide += v;
          peak = Math.max(peak, v);
        }
        report[side] = {
          plantedShare: +(planted / frames.length).toFixed(2),
          meanSlide: planted ? +(slide / planted).toFixed(3) : null,
          peakSlide: +peak.toFixed(3),
          minAnkleY: +minAnkle.toFixed(3),
          minToeY: +minToe.toFixed(3),
        };
      }
      const range = (key, axis) => +(Math.max(...frames.map((f) => f[key][axis])) - Math.min(...frames.map((f) => f[key][axis]))).toFixed(3);
      report.headRange = [range('Head', 0), range('Head', 1), range('Head', 2)];
      report.hipsRange = [range('Hips', 0), range('Hips', 1), range('Hips', 2)];
      report.muzzleRange = [range('muzzle', 0), range('muzzle', 1), range('muzzle', 2)];
      report.headMeanY = +(frames.reduce((sum, f) => sum + f.Head[1], 0) / frames.length).toFixed(3);
      return report;
    },
    { speed: SPEEDS[state] ?? 0, crouching: state.startsWith('crouch'), aiming: state.startsWith('aim') || state.startsWith('crouch') },
  );
  process.stdout.write(`${state} ${JSON.stringify(result)}\n`);
}
await browser.close();
