// Plays scripted matches against the bots in the running dev server and reports whether the game plays.
// Usage: node scripts/dev/review-play-run.mjs --mode survey [--maps railyard,harbor,pinewood] [--difficulty regular]
//        node scripts/dev/review-play-run.mjs --mode difficulty [--maps railyard] [--levels recruit,regular,veteran,elite]
//                                             [--scenarios still,strafe,cover] [--seconds 90]
//        node scripts/dev/review-play-run.mjs --mode fight [--maps railyard] [--levels recruit,elite] [--seconds 300]
//        node scripts/dev/review-play-run.mjs --mode rules
//        node scripts/dev/review-play-run.mjs --mode nav --maps railyard,harbor,pinewood
// survey: 8 bots, 90 s of game time (--scenario idle leaves the player at the spawn instead). The player (kept alive) walks toward the enemy for 45 s, then stands
//   and shoots what it can see. Writes shots/review-play-<map>.json and a top-down shots/review-play-<map>.png
//   with every bot's trail drawn on it.
// difficulty: the player (kept alive, never fires) stands still, strafes, or ducks behind cover in mid-map.
// fight: a mortal scripted player with human-like limits (reaction delay, turn rate, wobble) plays a whole match.
// nav: spawns on the navigation grid and connected to each other, cells under water, upper floors.
// rules: win on last kill, three lives then loss, Survival waves grow, respawn picks the safest spawn.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const mode = arg('mode', 'survey');
const maps = arg('maps', mode === 'survey' ? 'railyard,harbor,pinewood' : 'railyard').split(',');
const levels = arg('levels', mode === 'fight' ? 'recruit,elite' : 'recruit,regular,veteran,elite').split(',');
const scenarios = arg('scenarios', 'still,strafe,cover').split(',');
const seconds = Number(arg('seconds', mode === 'fight' ? '300' : '90'));
const botCount = Number(arg('bots', '8'));
const tier = arg('q', 'low');
const tag = arg('tag', '');
const [width, height] = arg('size', '1600x900').split('x').map(Number);
const base = `http://127.0.0.1:${arg('port', '5311')}/?botdebug&q=${tier}`;

// ---------------------------------------------------------------- in the page

/** Installs the scripted player and the recorder. Runs in the page once a match is playing. */
function install(opts) {
  const game = window.__ironvale.game;
  const { player, world, map } = game;
  const mgr = game.bots;
  const grid = mgr.grid;
  const Vec = player.position.constructor;
  const va = new Vec();
  const vb = new Vec();
  const DIR_X = [1, 1, 0, -1, -1, -1, 0, 1];
  const DIR_Z = [0, 1, 1, 1, 0, -1, -1, -1];
  const DEG = Math.PI / 180;
  game.debugControl = true;

  const R = (window.__review = {
    opts,
    phase: 'playing',
    done: false,
    bots: {},
    playerTrail: [],
    damage: 0,
    hits: 0,
    firstSeen: null,
    firstShot: null,
    firstHurt: null,
    firstHundred: null,
    deathTimes: [],
    killTimes: [],
    botShots: 0,
    kills: 0,
    deaths: 0,
    pathFailures: [],
    stuck: [],
    frames: 0,
    wallStart: performance.now(),
    wallMs: 0,
    time: 0,
    snapshot: null,
    notes: [],
  });

  const centroid = map.enemySpawns.reduce((sum, s) => sum.add(s.position), new Vec()).divideScalar(map.enemySpawns.length);
  const start = player.position.clone();
  const nodeNear = (t) => {
    const x = start.x + (centroid.x - start.x) * t;
    const z = start.z + (centroid.z - start.z) * t;
    const node = grid.nearestNode(x, start.y + (centroid.y - start.y) * t, z, 12);
    return node < 0 ? null : new Vec(grid.nodeX(node), grid.nodeY[node], grid.nodeZ(node));
  };
  /** Nearest cell with low cover (not full-height) on the side facing the enemy spawns. */
  const coverNear = (point) => {
    let best = null;
    let bestScore = Infinity;
    for (let n = 0; n < grid.nodeCount; n++) {
      if (grid.edges[n] === 0 || grid.coverLow[n] === 0) continue;
      const x = grid.nodeX(n);
      const z = grid.nodeZ(n);
      const d = Math.hypot(x - point.x, z - point.z);
      if (d > 14 || Math.abs(grid.nodeY[n] - point.y) > 1) continue;
      const dx = centroid.x - x;
      const dz = centroid.z - z;
      let dir = 0;
      let dot = -Infinity;
      for (let i = 0; i < 8; i++) {
        const value = (DIR_X[i] * dx + DIR_Z[i] * dz) / Math.hypot(DIR_X[i], DIR_Z[i]);
        if (value > dot) {
          dot = value;
          dir = i;
        }
      }
      if (!(grid.coverLow[n] & (1 << dir))) continue;
      const score = d + (grid.coverHigh[n] & (1 << dir) ? 20 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = new Vec(x, grid.nodeY[n], z);
      }
    }
    return best;
  };

  // ---- keys
  const held = new Set();
  const key = (code, down) => {
    if (down === held.has(code)) return;
    if (down) held.add(code);
    else held.delete(code);
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
  };
  const releaseMove = () => ['KeyW', 'KeyA', 'KeyD', 'KeyS'].forEach((code) => key(code, false));
  const wrap = (angle) => {
    const w = (angle + Math.PI) % (Math.PI * 2);
    return (w < 0 ? w + Math.PI * 2 : w) - Math.PI;
  };
  const faceToward = (x, z) => {
    player.yaw = Math.atan2(-(x - player.position.x), -(z - player.position.z));
  };

  // ---- walking a route on the bots' own navigation grid
  let route = null;
  let routeGoal = null;
  let waypoint = 0;
  const walkTo = (goal) => {
    if (!routeGoal || routeGoal.distanceTo(goal) > 1.5 || !route || route.status === 'failed') {
      const Handle = mgr.bots[0]?.path.constructor;
      if (!Handle) return false;
      route = new Handle();
      routeGoal = goal.clone();
      waypoint = 0;
      const p = player.position;
      mgr.paths.request(route, p.x, p.y, p.z, goal.x, goal.y, goal.z);
    }
    if (route.status !== 'ready') {
      releaseMove();
      return false;
    }
    while (waypoint < route.count) {
      const dx = route.points[waypoint * 3] - player.position.x;
      const dz = route.points[waypoint * 3 + 2] - player.position.z;
      if (Math.hypot(dx, dz) > 0.5) break;
      waypoint++;
    }
    if (waypoint >= route.count) {
      releaseMove();
      const arrived = Math.hypot(goal.x - player.position.x, goal.z - player.position.z) < 2;
      if (!arrived) routeGoal = null;
      return arrived;
    }
    faceToward(route.points[waypoint * 3], route.points[waypoint * 3 + 2]);
    player.pitch = 0;
    key('KeyW', true);
    return false;
  };

  // ---- seeing and shooting, with the limits a person has
  const fogDensity = map.lighting.fog.density;
  const SEE_TRANSMITTANCE = 0.2;
  const canSee = (bot) => {
    va.set(player.position.x, player.position.y + 1.64, player.position.z);
    vb.copy(bot.position);
    vb.y += bot.crouching ? 0.75 : 1.2;
    const distance = va.distanceTo(vb);
    if (Math.exp(-((fogDensity * distance) ** 2)) < SEE_TRANSMITTANCE) return false;
    return world.lineOfSight(va, vb);
  };
  let aimTarget = null;
  let seenFor = 0;
  let burst = 0;
  const shootAtVisible = (dt, human) => {
    let best = null;
    let bestDistance = Infinity;
    for (const bot of mgr.bots) {
      if (!bot.alive || !canSee(bot)) continue;
      const distance = bot.position.distanceTo(player.position);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = bot;
      }
    }
    if (best !== aimTarget) {
      aimTarget = best;
      seenFor = 0;
    }
    const weapon = game.weapons.current;
    const reload = weapon.magazine === 0 && !weapon.reloading;
    if (!best) {
      game.weapons.debugInput = { fire: false, aim: false, reload };
      return false;
    }
    seenFor += dt;
    if (seenFor < (human ? 0.3 : 0.15)) {
      game.weapons.debugInput = { fire: false, aim: true, reload };
      return true;
    }
    player.eyePosition(va);
    vb.copy(best.position);
    vb.y += best.crouching ? 0.75 : 1.2;
    const dx = vb.x - va.x;
    const dy = vb.y - va.y;
    const dz = vb.z - va.z;
    const wobble = human ? 0.35 * DEG : 0;
    const wantYaw = Math.atan2(-dx, -dz) + Math.sin(game.time * 2.3) * wobble;
    const wantPitch = Math.atan2(dy, Math.hypot(dx, dz)) + Math.cos(game.time * 1.7) * wobble;
    const rate = (human ? 220 : 400) * DEG * dt;
    const yawError = wrap(wantYaw - player.yaw);
    const pitchError = wantPitch - player.pitch;
    player.yaw += Math.max(-rate, Math.min(rate, yawError));
    player.pitch += Math.max(-rate, Math.min(rate, pitchError));
    const onTarget = Math.abs(yawError) < 1.2 * DEG && Math.abs(pitchError) < 1.2 * DEG;
    // Short bursts: 0.35 s on, 0.2 s off. Semi-automatic guns get one press per burst.
    burst = (burst + dt) % 0.55;
    game.weapons.debugInput = { fire: onTarget && burst < 0.35, aim: true, reload };
    return true;
  };

  // ---- the scripted player, one behaviour per scenario
  const mid = nodeNear(0.45) ?? start;
  const cover = coverNear(opts.scenario === 'fight' ? (nodeNear(0.3) ?? start) : mid);
  R.notes.push(`start ${start.toArray().map((v) => v.toFixed(1))} mid ${mid.toArray().map((v) => v.toFixed(1))} cover ${cover ? cover.toArray().map((v) => v.toFixed(1)) : 'none'}`);
  const immortal = opts.scenario !== 'fight';
  if (opts.scenario === 'still' || opts.scenario === 'strafe') game.debugPose(mid.x, mid.y, mid.z, 0, 0);
  if (opts.scenario === 'cover') game.debugPose((cover ?? mid).x, (cover ?? mid).y, (cover ?? mid).z, 0, 0);
  let quiet = 0;
  let hurtHide = false;
  let atCover = false;
  const drive = (dt) => {
    const t = game.time;
    if (!player.alive) {
      releaseMove();
      game.weapons.debugInput = {};
      atCover = false;
      return;
    }
    switch (opts.scenario) {
      case 'survey':
        if (t < opts.walkSeconds) {
          game.weapons.debugInput = {};
          walkTo(nodeNear(0.6) ?? mid);
        } else {
          releaseMove();
          shootAtVisible(dt, false);
        }
        break;
      case 'still':
        game.weapons.debugInput = {};
        faceToward(centroid.x, centroid.z);
        break;
      case 'idle':
        // Stays at the spawn and does nothing: shows what a squad does when left alone.
        game.weapons.debugInput = {};
        break;
      case 'strafe':
        game.weapons.debugInput = {};
        faceToward(centroid.x, centroid.z);
        // 1.6 s each way, so the player stays within a few metres of the spot.
        key('KeyA', t % 3.2 < 1.6);
        key('KeyD', t % 3.2 >= 1.6);
        break;
      case 'cover':
        game.weapons.debugInput = {};
        faceToward(centroid.x, centroid.z);
        // Four seconds down behind the cover, two seconds up.
        key('KeyC', t % 6 < 4);
        break;
      case 'fight': {
        if (player.health < 45) hurtHide = true;
        else if (player.health > 80) hurtHide = false;
        if (hurtHide) {
          releaseMove();
          key('KeyC', true);
          game.weapons.debugInput = { fire: false, aim: false, reload: game.weapons.current.magazine < 10 && !game.weapons.current.reloading };
          break;
        }
        key('KeyC', false);
        const engaged = shootAtVisible(dt, true);
        if (engaged) {
          quiet = 0;
          releaseMove();
          break;
        }
        quiet += dt;
        if (!atCover && cover) atCover = walkTo(cover);
        else if (quiet > 10) {
          // Nothing to shoot at for a while: go and find the nearest enemy.
          let nearest = null;
          for (const bot of mgr.bots) {
            if (bot.alive && (!nearest || bot.position.distanceTo(player.position) < nearest.position.distanceTo(player.position))) nearest = bot;
          }
          if (nearest) walkTo(nearest.position);
        } else releaseMove();
        break;
      }
    }
  };

  // ---- recording
  const playerId = player.id;
  game.events.on('shotFired', (event) => {
    if (event.shooterId === playerId) return;
    R.botShots++;
    if (R.firstShot === null) R.firstShot = game.time;
    const rec = R.bots[event.shooterId];
    if (rec) rec.shots++;
  });
  game.events.on('playerHurt', (event) => {
    R.damage += event.amount;
    R.hits++;
    if (R.firstHundred === null && R.damage >= 100) R.firstHundred = game.time;
    if (R.firstHurt === null) R.firstHurt = game.time;
    if (immortal) player.health = 100;
  });
  game.events.on('died', (event) => {
    if (event.victimId === playerId) {
      R.deaths++;
      R.deathTimes.push(Math.round(game.time * 10) / 10);
    } else if (event.killerId === playerId) {
      R.kills++;
      R.killTimes.push(Math.round(game.time * 10) / 10);
    }
    const rec = R.bots[event.victimId];
    if (rec) rec.diedAt = Math.round(game.time * 10) / 10;
  });
  game.events.on('matchState', (snapshot) => {
    R.phase = snapshot.phase;
    R.snapshot = { phase: snapshot.phase, kills: snapshot.kills, deaths: snapshot.deaths, elapsed: snapshot.elapsed, shotsFired: snapshot.shotsFired, shotsHit: snapshot.shotsHit, lives: snapshot.livesRemaining };
  });

  const bounds = map.bounds;
  const SAMPLE = 0.25;
  const STUCK_WINDOW = 10;
  let nextSample = 0;
  const sample = (t) => {
    R.playerTrail.push(Math.round(player.position.x * 10) / 10, Math.round(player.position.z * 10) / 10);
    va.set(player.position.x, player.position.y + 1.2, player.position.z);
    for (const bot of mgr.bots) {
      let rec = R.bots[bot.id];
      if (!rec) {
        rec = R.bots[bot.id] = {
          id: bot.id, name: bot.name, role: bot.role, spawn: bot.position.toArray().map((v) => Math.round(v * 10) / 10), spawnedAt: Math.round(t * 10) / 10,
          trail: [], maxFromSpawn: 0, travelled: 0, lineOfSight: false, sawPlayer: false, shots: 0, minY: Infinity, water: false, outOfBounds: false,
          teleports: 0, pathFailures: 0, stuck: 0, diedAt: null, lastState: '', history: [], failed: false, stuckOpen: false,
        };
      }
      if (!bot.alive) continue;
      const p = bot.position;
      const last = rec.history[rec.history.length - 1];
      if (last) {
        const step = Math.hypot(p.x - last.x, p.z - last.z);
        rec.travelled += step;
        if (step > 6) rec.teleports++;
      }
      rec.trail.push(Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10);
      rec.maxFromSpawn = Math.max(rec.maxFromSpawn, Math.hypot(p.x - rec.spawn[0], p.z - rec.spawn[2]));
      rec.minY = Math.min(rec.minY, p.y);
      rec.lastState = bot.state;
      if (bot.surface === 'water') rec.water = true;
      if (opts.waterY !== null && p.y < opts.waterY) rec.water = true;
      if (p.x < bounds.min.x - 0.5 || p.x > bounds.max.x + 0.5 || p.z < bounds.min.z - 0.5 || p.z > bounds.max.z + 0.5 || p.y < bounds.min.y) rec.outOfBounds = true;
      if (bot.targetVisible) {
        rec.sawPlayer = true;
        if (R.firstSeen === null) R.firstSeen = t;
      }
      if (!rec.lineOfSight && player.alive) {
        bot.eyePosition(vb);
        if (vb.distanceTo(va) < 100 && world.lineOfSight(vb, va)) rec.lineOfSight = true;
      }
      rec.history.push({ t, x: p.x, z: p.z, state: bot.state, moving: bot.moving });
      while (rec.history.length > 0 && rec.history[0].t < t - STUCK_WINDOW - SAMPLE) rec.history.shift();
      // Stuck: under a metre in ten seconds, never in a hold or cover state during them.
      const first = rec.history[0];
      if (t - first.t >= STUCK_WINDOW) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, excused = false, moving = 0;
        for (const h of rec.history) {
          minX = Math.min(minX, h.x); maxX = Math.max(maxX, h.x); minZ = Math.min(minZ, h.z); maxZ = Math.max(maxZ, h.z);
          if (h.state === 'hold' || h.state === 'cover') excused = true;
          if (h.moving) moving++;
        }
        const still = Math.hypot(maxX - minX, maxZ - minZ) < 1 && !excused;
        if (still && !rec.stuckOpen) {
          rec.stuck++;
          const states = [...new Set(rec.history.map((h) => h.state))].join('/');
          R.stuck.push({ id: bot.id, t: Math.round(t * 10) / 10, at: [p.x, p.y, p.z].map((v) => Math.round(v * 10) / 10), states, movingShare: Math.round((moving / rec.history.length) * 100) / 100 });
        }
        rec.stuckOpen = still;
      }
    }
  };

  const update = mgr.update.bind(mgr);
  mgr.update = (dt) => {
    update(dt);
    const t = game.time;
    R.frames++;
    R.time = t;
    R.wallMs = performance.now() - R.wallStart;
    for (const bot of mgr.bots) {
      const rec = R.bots[bot.id];
      if (!rec || !bot.alive) continue;
      if (bot.pathFailed && !rec.failed) {
        rec.pathFailures++;
        if (R.pathFailures.length < 40) {
          R.pathFailures.push({ id: bot.id, t: Math.round(t * 10) / 10, state: bot.state, from: bot.position.toArray().map((v) => Math.round(v * 10) / 10), goal: bot.goal.toArray().map((v) => Math.round(v * 10) / 10), status: bot.path.status, partial: bot.path.partial });
        }
      }
      rec.failed = bot.pathFailed;
    }
    if (t >= nextSample) {
      nextSample = t + SAMPLE;
      sample(t);
    }
    if (t >= opts.seconds) {
      R.done = true;
      releaseMove();
      key('KeyC', false);
      game.weapons.debugInput = {};
      return;
    }
    drive(dt);
  };
  sample(0);
}

/** Freezes the match, looks straight down at the whole map with fog off and draws the trails over it. */
function overview() {
  const game = window.__ironvale.game;
  const R = window.__review;
  const camera = game.engine.camera;
  const scene = game.engine.scene;
  const bounds = game.map.bounds;
  game.pause();
  for (const child of camera.children) child.visible = false;
  scene.fogNode = null;
  scene.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const material of materials) material.needsUpdate = true;
  });
  for (const element of document.body.children) {
    if (element.tagName !== 'CANVAS' && !element.querySelector?.('canvas')) element.style.display = 'none';
  }
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  const fov = 40;
  const tan = Math.tan((fov / 2) * (Math.PI / 180));
  const aspect = innerWidth / innerHeight;
  const up = Math.max((bounds.max.z - bounds.min.z) / 2 / tan, (bounds.max.x - bounds.min.x) / 2 / (tan * aspect)) * 1.06;
  camera.fov = fov;
  camera.far = Math.max(camera.far, up + 100);
  camera.updateProjectionMatrix();
  camera.position.set(cx, up, cz);
  camera.up.set(0, 0, -1);
  camera.lookAt(cx, 0, cz);
  camera.updateMatrixWorld(true);

  const canvas = document.createElement('canvas');
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none';
  document.body.appendChild(canvas);
  const g = canvas.getContext('2d');
  const v = game.player.position.clone();
  const project = (x, z) => {
    v.set(x, 0, z).project(camera);
    return [(v.x * 0.5 + 0.5) * canvas.width, (1 - (v.y * 0.5 + 0.5)) * canvas.height];
  };
  const line = (trail, color, lineWidth) => {
    g.strokeStyle = color;
    g.lineWidth = lineWidth;
    g.beginPath();
    for (let i = 0; i < trail.length; i += 2) {
      const [x, y] = project(trail[i], trail[i + 1]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  };
  const colors = ['#ff5a4d', '#ffb02e', '#ffe14d', '#7be36a', '#48dbfb', '#5f8dff', '#e056fd', '#ff8fd0', '#b6ff00', '#00ffc8', '#ffffff', '#c9a36b'];
  g.font = '600 13px ui-monospace, Menlo, monospace';
  line(R.playerTrail, '#ffffff', 3);
  Object.values(R.bots).forEach((bot, index) => {
    const color = colors[index % colors.length];
    line(bot.trail, color, 2);
    const [sx, sy] = project(bot.spawn[0], bot.spawn[2]);
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(sx, sy, 7, 0, Math.PI * 2);
    g.stroke();
    const [ex, ey] = project(bot.trail[bot.trail.length - 2] ?? bot.spawn[0], bot.trail[bot.trail.length - 1] ?? bot.spawn[2]);
    g.fillStyle = color;
    if (bot.diedAt === null) g.fillRect(ex - 4, ey - 4, 8, 8);
    else {
      g.beginPath();
      g.moveTo(ex - 6, ey - 6); g.lineTo(ex + 6, ey + 6); g.moveTo(ex + 6, ey - 6); g.lineTo(ex - 6, ey + 6);
      g.stroke();
    }
    g.fillText(`#${bot.id}`, ex + 8, ey + 4);
  });
  for (const stuck of R.stuck) {
    const [x, y] = project(stuck.at[0], stuck.at[2]);
    g.strokeStyle = '#ff0000';
    g.lineWidth = 3;
    g.strokeRect(x - 10, y - 10, 20, 20);
  }
  const [px, py] = project(R.playerTrail[R.playerTrail.length - 2], R.playerTrail[R.playerTrail.length - 1]);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(px, py, 6, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(14,14,13,0.8)';
  g.fillRect(8, 8, 520, 46);
  g.fillStyle = '#f7f5ef';
  g.fillText(`${R.opts.map} ${R.opts.difficulty}: ring = spawn, square = alive at end, cross = killed`, 16, 26);
  g.fillText('white = player, red box = stuck (under 1 m in 10 s outside hold/cover)', 16, 44);
}

// ---------------------------------------------------------------- driver

const WATER_Y = { harbor: -0.85 };
const round = (value, digits = 1) => (value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
await mkdir(join(root, 'shots'), { recursive: true });

/** Opens the game, starts a match and hands back the page. Starts over if a hot reload gets through. */
async function open(config) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}\n${error.stack ?? ''}`));
  await page.routeWebSocket(/.*/, () => undefined);
  await page.goto(base, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
  await page.evaluate((match) => window.__ironvale.game.startMatch(match), config);
  problems.length = 0;
  return { page, problems };
}

function summarize(report, problems) {
  const bots = Object.values(report.bots);
  const minutes = Math.max(report.time, 1) / 60;
  const contact = [report.firstSeen, report.firstShot, report.firstHurt].filter((v) => v !== null);
  const firstContact = contact.length ? Math.min(...contact) : null;
  return {
    map: report.opts.map,
    difficulty: report.opts.difficulty,
    scenario: report.opts.scenario,
    gameSeconds: round(report.time),
    fps: round(report.frames / (report.wallMs / 1000)),
    phase: report.phase,
    bots: bots.length,
    leftSpawn15m: bots.filter((b) => b.maxFromSpawn > 15).length,
    leftSpawn5m: bots.filter((b) => b.maxFromSpawn > 5).length,
    reachedLineOfSight: bots.filter((b) => b.lineOfSight).length,
    sawPlayer: bots.filter((b) => b.sawPlayer).length,
    fired: bots.filter((b) => b.shots > 0).length,
    botShots: report.botShots,
    // Stuck proper: tried to move for most of the ten seconds. A sentry pausing on patrol is listed apart.
    stuckBots: new Set(report.stuck.filter((entry) => entry.movingShare >= 0.5).map((entry) => entry.id)).size,
    idleTenSeconds: new Set(report.stuck.filter((entry) => entry.movingShare < 0.5).map((entry) => entry.id)).size,
    stuck: report.stuck,
    outOfBounds: bots.filter((b) => b.outOfBounds).map((b) => b.id),
    inWater: bots.filter((b) => b.water).map((b) => b.id),
    teleported: bots.filter((b) => b.teleports > 0).map((b) => b.id),
    lowestY: round(Math.min(...bots.map((b) => b.minY)), 2),
    pathFailures: bots.reduce((sum, b) => sum + b.pathFailures, 0),
    firstSeen: round(report.firstSeen),
    firstContact: round(firstContact),
    damage: round(report.damage),
    damagePerMinute: round(report.damage / minutes),
    damagePerMinuteAfterContact: firstContact === null ? 0 : round(report.damage / (Math.max(1, report.time - firstContact) / 60)),
    hitsTaken: report.hits,
    // Seconds from the first hit to a full health bar's worth of damage (regeneration ignored).
    secondsToLoseALife: report.firstHundred === null || report.firstHurt === null ? null : round(report.firstHundred - report.firstHurt),
    deathTimes: report.deathTimes,
    killTimes: report.killTimes,
    kills: report.kills,
    deaths: report.deaths,
    snapshot: report.snapshot,
    notes: report.notes,
    pageProblems: [...new Set(problems)].slice(0, 6).map((line) => line.slice(0, 300)),
  };
}

async function play(map, difficulty, scenario, matchSeconds, shot) {
  const { page, problems } = await open({ mapId: map, mode: 'skirmish', difficulty, botCount });
  await page.evaluate(install, { map, difficulty, scenario, seconds: matchSeconds, walkSeconds: 45, waterY: WATER_Y[map] ?? null });
  await page.waitForFunction(() => window.__review.done || window.__review.phase === 'won' || window.__review.phase === 'lost', null, {
    timeout: (matchSeconds * 4 + 120) * 1000,
    polling: 500,
  });
  const report = await page.evaluate(() => ({ ...window.__review, log: window.__ironvaleBots?.log ?? [], stats: { ...window.__ironvale.game.bots.stats } }));
  const summary = summarize(report, problems);
  if (shot) {
    await writeFile(join(root, 'shots', `${shot}.json`), JSON.stringify({ summary, stats: report.stats, pathFailures: report.pathFailures, bots: report.bots, log: report.log }, null, 1));
    try {
      await page.evaluate(overview);
      // Every material recompiles without fog; wait until frames are flowing again.
      await page.waitForTimeout(2500);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: join(root, 'shots', `${shot}.png`), timeout: 120000 });
    } catch (error) {
      summary.pageProblems.push(`overview shot failed: ${String(error.message).split('\n')[0]}`);
    }
  }
  await page.close();
  return { summary, report };
}

/** Kills with the game's own damage path, so the rules see what they would in play. */
const pageKill = (who) => {
  const game = window.__ironvale.game;
  const player = game.player;
  const bots = game.bots.bots.filter((bot) => bot.alive);
  const info = (attackerId, at) => ({ amount: 1000, zone: 'torso', attackerId, weaponId: 'm4a1', point: at.clone(), direction: at.clone().set(0, 0, -1) });
  if (who === 'player') player.applyDamage(info(bots[0]?.id ?? -1, player.position));
  else if (who === 'bot') bots[0]?.applyDamage(info(player.id, bots[0].position));
  else for (const bot of bots) bot.applyDamage(info(player.id, bot.position));
};
const pageState = () => {
  const game = window.__ironvale.game;
  const snapshot = window.__state;
  const player = game.player;
  const alive = game.bots.bots.filter((bot) => bot.alive);
  const spawns = game.map.playerSpawns.map((spawn) => ({
    at: spawn.position.toArray().map((v) => Math.round(v * 10) / 10),
    nearestEnemy: Math.round(Math.min(...alive.map((bot) => bot.position.distanceTo(spawn.position))) * 10) / 10,
    here: spawn.position.distanceTo(player.position) < 1.5,
  }));
  const eye = player.position.clone();
  eye.y += 1.64;
  const watchers = alive.filter((bot) => game.world.lineOfSight(bot.eyePosition(bot.position.clone()), eye)).length;
  return { phase: snapshot.phase, kills: snapshot.kills, deaths: snapshot.deaths, lives: snapshot.livesRemaining, wave: snapshot.wave, enemies: snapshot.enemiesRemaining, alive: player.alive, spawns, watchers };
};

async function rules() {
  const results = {};
  const watch = (page) => page.evaluate(() => window.__ironvale.game.events.on('matchState', (snapshot) => (window.__state = snapshot)));
  const settle = (page, ms = 400) => page.waitForTimeout(ms);

  // Win on the last kill, and not before.
  {
    const { page } = await open({ mapId: 'railyard', mode: 'skirmish', difficulty: 'regular', botCount: 3 });
    await watch(page);
    const phases = [];
    for (let i = 0; i < 3; i++) {
      await page.evaluate(pageKill, 'bot');
      // The first frames after loading can be slow; give the rules a moment to run.
      if (i === 2) await page.waitForFunction(() => window.__state.phase !== 'playing', null, { timeout: 5000 }).catch(() => undefined);
      else await settle(page, 1000);
      const state = await page.evaluate(pageState);
      phases.push(`${state.kills} kills -> ${state.phase}`);
    }
    results.winOnLastKill = { phases, pass: phases[1]?.endsWith('playing') && phases[2]?.endsWith('won') };
    await page.close();
  }

  // Three lives, then the match is lost. Each respawn should be the spawn furthest from the enemy.
  {
    const { page } = await open({ mapId: 'railyard', mode: 'skirmish', difficulty: 'recruit', botCount: 8 });
    await watch(page);
    await page.evaluate(() => setInterval(() => (window.__ironvale.game.debugControl = true), 100));
    // Let the squad spread out so the spawns differ in safety.
    await page.waitForFunction(() => window.__ironvale.game.time > 25, null, { timeout: 120000 });
    const steps = [];
    for (let life = 1; life <= 3; life++) {
      await page.evaluate(pageKill, 'player');
      await settle(page);
      const dead = await page.evaluate(pageState);
      await page.waitForFunction(() => window.__ironvale.game.player.alive || window.__state.phase === 'lost', null, { timeout: 20000 });
      const after = await page.evaluate(pageState);
      const safest = Math.max(...after.spawns.map((spawn) => spawn.nearestEnemy));
      const chosen = after.spawns.find((spawn) => spawn.here);
      steps.push({
        death: life,
        livesAfterDeath: dead.lives,
        phase: after.phase,
        respawned: after.alive,
        spawnNearestEnemy: chosen?.nearestEnemy ?? null,
        safestAvailable: safest,
        botsWithLineOfSight: after.alive ? after.watchers : null,
      });
    }
    results.threeLives = {
      steps,
      pass:
        steps[0]?.respawned && steps[1]?.respawned && steps[2]?.phase === 'lost' && !steps[2]?.respawned &&
        steps.slice(0, 2).every((step) => step.spawnNearestEnemy === step.safestAvailable),
    };
    await page.close();
  }

  // Survival: each wave is two larger than the last, and one death ends it.
  {
    const { page } = await open({ mapId: 'railyard', mode: 'survival', difficulty: 'recruit', botCount: 2 });
    await watch(page);
    const waves = [];
    for (let wave = 1; wave <= 3; wave++) {
      await page.waitForFunction((n) => window.__state?.wave === n && window.__state.enemiesRemaining > 0, wave, { timeout: 30000 });
      const state = await page.evaluate(pageState);
      waves.push({ wave: state.wave, enemies: state.enemies });
      await page.evaluate(pageKill, 'all');
    }
    await page.waitForFunction(() => window.__state?.wave === 4 && window.__state.enemiesRemaining > 0, null, { timeout: 30000 });
    await page.evaluate(pageKill, 'player');
    await page.waitForFunction(() => window.__state.phase !== 'playing', null, { timeout: 20000 }).catch(() => undefined);
    const end = await page.evaluate(pageState);
    results.survival = { waves, afterOneDeath: end.phase, pass: waves.map((w) => w.enemies).join() === '2,4,6' && end.phase === 'lost' };
    await page.close();
  }
  return results;
}

/** Static checks on the navigation grid: spawns on it and connected, cells under water, upper floors reached. */
const pageNav = (waterY) => {
  const game = window.__ironvale.game;
  const grid = game.bots.grid;
  const map = game.map;
  const label = new Int32Array(grid.nodeCount).fill(-1);
  const sizes = [];
  for (let n = 0; n < grid.nodeCount; n++) {
    if (grid.edges[n] === 0 || label[n] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [n];
    label[n] = id;
    while (stack.length) {
      const at = stack.pop();
      size++;
      for (let d = 0; d < 8; d++) {
        const m = grid.neighbor(at, d);
        if (m >= 0 && label[m] < 0) {
          label[m] = id;
          stack.push(m);
        }
      }
    }
    sizes.push(size);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  const check = (spawn) => {
    const p = spawn.position;
    const node = grid.nearestNode(p.x, p.y, p.z);
    const offset = node < 0 ? null : Math.hypot(grid.nodeX(node) - p.x, grid.nodeZ(node) - p.z, grid.nodeY[node] - p.y);
    return { at: p.toArray().map((v) => Math.round(v * 10) / 10), offset: offset === null ? null : Math.round(offset * 100) / 100, onMain: node >= 0 && label[node] === main, fits: game.world.capsuleFits(p.clone().setY(p.y + 0.2), 0.34, 1.6) };
  };
  let live = 0, wet = 0, upper = 0, lowest = Infinity, highest = -Infinity;
  for (let n = 0; n < grid.nodeCount; n++) {
    if (grid.edges[n] === 0) continue;
    live++;
    const y = grid.nodeY[n];
    lowest = Math.min(lowest, y);
    highest = Math.max(highest, y);
    if (waterY !== null && y < waterY) wet++;
    const col = grid.nodeCol[n];
    if (grid.colStart[col + 1] - grid.colStart[col] > 1 && n === grid.colStart[col]) upper++;
  }
  // Share of patrol picks (4 to 12 m round each enemy spawn, as brain.ts makes them) that land on a water cell.
  let picks = 0, wetPicks = 0;
  for (const spawn of map.enemySpawns) {
    for (let i = 0; i < 200; i++) {
      const angle = (i / 200) * Math.PI * 2;
      const radius = 4 + ((i * 7) % 8);
      const node = grid.nearestNode(spawn.position.x + Math.cos(angle) * radius, spawn.position.y, spawn.position.z + Math.sin(angle) * radius, 4);
      if (node < 0) continue;
      picks++;
      if (grid.wet?.[node] || (waterY !== null && grid.nodeY[node] < waterY)) wetPicks++;
    }
  }
  // Player spawns an enemy spawn can see: eye to chest, within the furthest any bot sees on this map.
  const sightRange = Math.min(90, 0.9 / map.lighting.fog.density);
  const exposed = [];
  map.playerSpawns.forEach((mine, i) => {
    map.enemySpawns.forEach((theirs, j) => {
      const eye = theirs.position.clone();
      eye.y += 1.64;
      const chest = mine.position.clone();
      chest.y += 1.2;
      const distance = eye.distanceTo(chest);
      if (distance <= sightRange && game.world.lineOfSight(eye, chest)) exposed.push({ playerSpawn: i, enemySpawn: j, metres: Math.round(distance) });
    });
  });
  const bad = (list) => list.filter((spawn) => !spawn.onMain || spawn.offset === null || spawn.offset > 0.6 || !spawn.fits);
  const enemy = map.enemySpawns.map(check);
  const mine = map.playerSpawns.map(check);
  return {
    nodes: live, islands: sizes.length, mainShare: Math.round((sizes[main] / live) * 1000) / 1000, otherIslands: sizes.filter((_, i) => i !== main).sort((a, b) => b - a).slice(0, 5),
    underWater: wet, flaggedWet: grid.wet ? grid.wet.reduce((sum, v) => sum + v, 0) : null, patrolPicksInWater: Math.round((wetPicks / Math.max(1, picks)) * 1000) / 1000, stackedUpperCells: upper, lowest: Math.round(lowest * 100) / 100, highest: Math.round(highest * 100) / 100,
    enemySpawns: enemy.length, playerSpawns: mine.length, badEnemySpawns: bad(enemy), badPlayerSpawns: bad(mine),
    navBuildMs: Math.round(game.bots.stats.navBuildMs),
    botSightRange: Math.round(sightRange), playerSpawnsSeenFromEnemySpawns: exposed,
  };
};

const output = [];
try {
  if (mode === 'nav') {
    for (const map of maps) {
      const { page, problems } = await open({ mapId: map, mode: 'skirmish', difficulty: 'regular', botCount: 1 });
      output.push({ map, ...(await page.evaluate(pageNav, WATER_Y[map] ?? null)), pageProblems: [...new Set(problems)].slice(0, 5) });
      await page.close();
    }
  } else if (mode === 'rules') {
    output.push(await rules());
  } else if (mode === 'survey') {
    for (const map of maps) {
      const { summary } = await play(map, arg('difficulty', 'regular'), arg('scenario', 'survey'), seconds, `review-play-${map}${tag}`);
      output.push(summary);
      process.stderr.write(`${map} done\n`);
    }
  } else if (mode === 'difficulty') {
    for (const map of maps) {
      for (const level of levels) {
        for (const scenario of scenarios) {
          const { summary } = await play(map, level, scenario, seconds, null);
          const { stuck, notes, snapshot, pageProblems, ...brief } = summary;
          output.push({ ...brief, notes: level === levels[0] ? notes : undefined, pageProblems });
          process.stderr.write(`${map} ${level} ${scenario}: ${summary.damagePerMinute}/min, ${summary.damagePerMinuteAfterContact}/min after contact at ${summary.firstContact}s, ${summary.secondsToLoseALife}s from first hit to 100 damage\n`);
        }
      }
    }
  } else if (mode === 'fight') {
    for (const map of maps) {
      for (const level of levels) {
        const { summary } = await play(map, level, 'fight', seconds, `review-play-fight-${map}-${level}${tag}`);
        output.push(summary);
        process.stderr.write(`${map} ${level} fight: ${summary.phase} in ${summary.gameSeconds}s, kills at ${summary.killTimes.join(' ')}, deaths at ${summary.deathTimes.join(' ')}, first contact ${summary.firstContact}s, accuracy ${summary.snapshot?.shotsHit}/${summary.snapshot?.shotsFired}\n`);
      }
    }
  } else {
    throw new Error(`Unknown mode ${mode}`);
  }
} finally {
  await browser.close();
}
process.stdout.write(`${JSON.stringify(output, null, 1)}\n`);
