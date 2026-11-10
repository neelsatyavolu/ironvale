import { describe, expect, it } from 'vitest';
import { readDemoConfig } from '../../src/fx/demo-config';

describe('readDemoConfig', () => {
  it('is inert without the parameter', () => {
    const config = readDemoConfig('?map=range&bots=0');
    expect(config.names.size).toBe(0);
    expect(config.weather).toBeNull();
    expect(config.timeScale).toBe(1);
  });

  it('reads a list of demos and ignores unknown names', () => {
    const config = readDemoConfig('?fxdemo=impacts,flash,bogus');
    expect([...config.names].sort()).toEqual(['flash', 'impacts']);
  });

  it('expands "all" to every event demo but leaves the weather alone', () => {
    const config = readDemoConfig('?fxdemo=all');
    expect(config.names.has('gun')).toBe(true);
    expect(config.names.has('casings')).toBe(true);
    expect(config.weather).toBeNull();
  });

  it('turns rain and mist into a weather override', () => {
    expect(readDemoConfig('?fxdemo=rain').weather).toBe('rain');
    expect(readDemoConfig('?fxdemo=mist,impacts').weather).toBe('mist');
    expect(readDemoConfig('?fxdemo=mist,impacts').names.has('impacts')).toBe(true);
  });

  it('reads the weapon class and clamps the slow-motion factor', () => {
    expect(readDemoConfig('?fxdemo=gun&fxweapon=shotgun').weaponClass).toBe('shotgun');
    expect(readDemoConfig('?fxdemo=gun&fxweapon=cannon').weaponClass).toBe('carbine');
    expect(readDemoConfig('?fxslow=0.1').timeScale).toBeCloseTo(0.1);
    expect(readDemoConfig('?fxslow=0').timeScale).toBe(1);
    expect(readDemoConfig('?fxslow=abc').timeScale).toBe(1);
    expect(readDemoConfig('?fxslow=50').timeScale).toBe(4);
  });
});
