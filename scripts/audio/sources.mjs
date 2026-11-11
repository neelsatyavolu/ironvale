// Every third-party recording the sound set is built from. All are CC0 unless a
// `by` licence is given; those need the credit line that is copied into the manifest.
// Freesound rows: [key, soundId, uploaderId, author, title]. The file fetched is the
// public HQ MP3 preview (full-quality downloads need a login). Titles, uploaders and
// licences were read from each sound's own page with scripts/audio/verify-licences.mjs.

export const FFSL = {
  url: 'https://opengameart.org/sites/default/files/Prepared%20SFX%20Library.7z',
  archive: 'ffsl.7z',
  bytes: 193954738,
  page: 'https://opengameart.org/content/the-free-firearm-sound-library',
  author: 'Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney',
  title: 'The Free Firearm Sound Library',
  dir: 'Prepared SFX Library',
};

/** Free Firearm Sound Library takes: key -> path inside the archive. */
export const FFSL_FILES = {
  'ffsl-ar15-near': 'AR-15/D_32P.wav',
  'ffsl-ar15-mid': 'AR-15/D_24P.wav',
  'ffsl-m45-near': 'Carl Gustav M45/G_31P.wav',
  'ffsl-m45-mid': 'Carl Gustav M45/G_20P.wav',
  'ffsl-tikka-near': 'Tikka/W_29P.wav',
  'ffsl-tikka-mid': 'Tikka/W_24P.wav',
  'ffsl-mosin-near': 'Mosin Nagant/M_21P.wav',
  'ffsl-ppq-near': 'Walther PPQ/X_39P.wav',
};

const CC_BY_4 = 'CC-BY 4.0';

const FREESOUND_ROWS = [
  // ---- gunshots
  ['m4a1-shot', 737569, 15072041, 'areniporgen', 'Colt M4A1 SOCOM'],
  ['ar15-shot', 427596, 3094998, 'michorvath', 'AR15 rifle shot'],
  ['ar15-shot-distant', 427597, 3094998, 'michorvath', 'AR15 rifle shot from 50 yards away'],
  ['sniper-shot', 692209, 15072041, 'areniporgen', 'Blaser Tactical 2'],
  ['lmg-556', 693856, 15072041, 'areniporgen', 'KAC LAMG.wav'],
  ['m249-single', 568007, 12768240, 'Baelphazoar', '249 single shot.wav', CC_BY_4],
  // ---- weapon handling
  ['garand-clip-eject', 460848, 4986614, 'MPierluissi', 'GUNMech_M1 GARAND CLIP EJECT_MP.wav'],
  ['garand-dryfire', 460852, 4986614, 'MPierluissi', 'GUNRif_M1 GARAND DRY FIRE_MP.wav'],
  ['garand-handling', 460850, 4986614, 'MPierluissi', 'GUNMech_M1 GARAND HANDLING_MP.wav'],
  ['m4-reload-sequence', 725397, 7157894, 'serøutōnin--deprivəd', 'An M16 Rifle being reloaded while empty; full sequence'],
  ['ar15-various', 263513, 4675419, 'wadaltmon', 'AR15 Various Sounds'],
  ['rifle-dryfire', 725402, 7157894, 'serøutōnin--deprivəd', 'A rifle being dry fired once'],
  ['mp5-mag-out', 842995, 5287430, 'Sadiquecat', 'Airsoft MP5 Mag removal - Rode NT5 Omni Split mono'],
  ['mp5-mag-in', 842993, 5287430, 'Sadiquecat', 'Airsoft MP5 Mag insertion handling noise - NT5 Split mono'],
  ['shell-drop', 773860, 15468302, 'MrGungus', '12 guage shotgun shell drop'],
  ['mosin-bolt', 370345, 2558531, 'Zott820', 'Mosin Nagant Bolt Action Cycle'],
  ['bolt-rifle-reload', 508747, 1934171, 'AugustSandberg', 'Bolt Action Rifle Reload'],
  ['mg-reload', 386777, 5768130, 'ken788', 'Machine_Gun_Reload.wav'],
  // ---- impacts
  ['flesh-1', 138478, 758593, 'JustInvoke', 'Bullet Blood 1'],
  ['flesh-2', 138479, 758593, 'JustInvoke', 'Bullet Blood 2'],
  ['flesh-3', 138480, 758593, 'JustInvoke', 'Bullet Blood 3'],
  ['flesh-4', 138481, 758593, 'JustInvoke', 'Bullet Blood 4'],
  ['impact-metal', 182240, 84709, 'martian', 'Foley bullet hit metal.wav'],
  ['impact-metal-pipe', 182262, 84709, 'martian', 'Foley bullet hit metal pipe.wav'],
  ['rock-1', 489918, 10570192, 'falcospizaetus', 'MetalImpactAgainstRock01'],
  ['rock-2', 489919, 10570192, 'falcospizaetus', 'MetalImpactAgainstRock02'],
  ['rock-3', 489920, 10570192, 'falcospizaetus', 'MetalImpactAgainstRock03'],
  ['rock-4', 489921, 10570192, 'falcospizaetus', 'MetalImpactAgainstRock04'],
  ['rock-5', 489922, 10570192, 'falcospizaetus', 'MetalImpactAgainstRock05'],
  ['concrete-debris', 843339, 16682330, 'loganzsound', 'Concrete Breaks Several Denoised'],
  ['wood-hit-1', 319226, 3443504, 'worthahep88', 'Single rock hitting wood.wav'],
  ['wood-hit-2', 319227, 3443504, 'worthahep88', 'Single Rock hitting wood 4.wav'],
  ['wood-hit-3', 319228, 3443504, 'worthahep88', 'Single Rock hitting wood 2.wav'],
  ['wood-hit-4', 319223, 3443504, 'worthahep88', 'Single Rock Hitting wood 3.wav'],
  ['wood-crack', 351422, 5690194, 'Diramus', 'Wood crack'],
  ['dirt-hit-1', 319229, 3443504, 'worthahep88', 'Single Rock hit dirt 2.wav'],
  ['dirt-hit-2', 319222, 3443504, 'worthahep88', 'Single Rock hit Dirt.wav'],
  ['ricochet-1', 523403, 8956746, 'C-V', '22 caliber with ricochet.wav'],
  ['ricochet-2', 523404, 8956746, 'C-V', '22 caliber gunfire with ricochet.wav'],
  ['glass-1', 221528, 1038806, 'unfa', 'Glass Break'],
  ['glass-2', 686849, 14918565, 'ccen18', 'glass shatter'],
  ['glass-3', 758207, 16236894, 'LukaCafuka', 'Glass panel shattering'],
  ['glass-4', 465946, 5855051, 'AlterKartoffelsack', 'Glass Breaking'],
  ['water-splashes', 50623, 333536, 'vibe_crc', 'water_splash_10shots.wav'],
  ['water-rocks', 737644, 9268998, 'Kraftaggregat', 'Rocks Thrown in Water'],
  // ---- casings
  ['casing-concrete', 210102, 3278936, 'GrayJoy', 'Brass bullet shell casing drop onto concrete, multiple takes'],
  ['casing-tile', 318964, 5421667, 'GryffDavid', 'Bouncing Shell Casings (Various Sizes)'],
  ['casing-30cal', 460859, 4986614, 'MPierluissi', 'BLLTShel_30CAL BULLET DROP_MP.wav'],
  // ---- footsteps
  ['step-concrete-1', 166509, 2792951, 'Yoyodaman234', 'concrete footstep 1'],
  ['step-concrete-2', 166508, 2792951, 'Yoyodaman234', 'concrete footstep 2'],
  ['step-concrete-3', 166507, 2792951, 'Yoyodaman234', 'concrete footstep 3'],
  ['step-concrete-4', 166506, 2792951, 'Yoyodaman234', 'concrete footstep 4'],
  ['steps-concrete-walk', 459964, 6253486, 'florianreichelt', 'Footsteps on concrete'],
  ['steps-cobblestone', 322565, 4415905, 'YleArkisto', 'Askeleet kadulla, mukulakivet / Footsteps, sedate, a man walking on cobblestones, a close sound', CC_BY_4],
  ['steps-stone-boots', 521590, 9395330, 'Fission9', 'Hiking Boot Footsteps on Stone'],
  ['steps-asphalt-walk', 637556, 612689, 'kyles', 'footsteps shoes walk road asphalt hard.flac'],
  ['steps-asphalt-walk-2', 648336, 11944544, 'Rimmer', 'Walking asphalt.wav'],
  ['step-gravel-l1', 384873, 984733, 'Ali_6868', 'Left Gravel Footstep 1'],
  ['step-gravel-l2', 384871, 984733, 'Ali_6868', 'Left Gravel Footstep 2'],
  ['step-gravel-l3', 384872, 984733, 'Ali_6868', 'Left Gravel Footstep 3'],
  ['step-gravel-l4', 384875, 984733, 'Ali_6868', 'Left Gravel Footstep 4'],
  ['step-gravel-r3', 384879, 984733, 'Ali_6868', 'Right Gravel Footstep 3'],
  ['step-gravel-r4', 384878, 984733, 'Ali_6868', 'Right Gravel Footstep 4'],
  ['steps-gravel-run', 456038, 6253486, 'florianreichelt', 'Footsteps of a runner on gravel'],
  ['step-dirt-1', 166511, 2792951, 'Yoyodaman234', 'dirt/gravel footstep 1'],
  ['step-dirt-2', 166510, 2792951, 'Yoyodaman234', 'dirt/gravel footstep 2'],
  ['step-dirt-3', 223154, 2792951, 'Yoyodaman234', 'dirt/gravel footstep 3'],
  ['step-dirt-4', 223153, 2792951, 'Yoyodaman234', 'dirt/gravel footstep 4'],
  ['steps-dirt-run', 319225, 3443504, 'worthahep88', 'Running Dirt Tennis Shoes.wav'],
  ['steps-forest-moss', 770095, 13973196, 'Vrymaa', 'Footsteps Moss - Forest, walk, jog & run'],
  ['steps-forest-bark', 530383, 9250976, 'Nox_Sound', 'Footsteps_Boots_Gritty_Ground_Woods_Barks_Mono.wav'],
  ['steps-sand-dry', 705743, 1661766, 'felix.blume', 'Footsteps wearing sneakers and jeans walking on dry sand in the desert'],
  ['steps-wood-boots', 533044, 9250976, 'Nox_Sound', 'Footsteps_Boots_Wood_Mono.wav'],
  ['steps-metal-boots', 463665, 6551032, 'alec_mackay', 'footsteps boots metal.wav'],
  ['steps-metal-grate-run', 786977, 15749354, 'Oilcan03', 'Metal Grate Running'],
  ['steps-water', 861369, 8154783, 'ChristopherJngs', 'Splashing Footsteps Shallow Water'],
  ['land-1', 646658, 13085623, 'SoundDesignForYou', 'Landing On The Ground [4]'],
  ['land-2', 646660, 13085623, 'SoundDesignForYou', 'Landing On The Ground [2]'],
  ['land-3', 646662, 13085623, 'SoundDesignForYou', 'Landing On The Ground [7]'],
  ['land-4', 646664, 13085623, 'SoundDesignForYou', 'Landing On The Ground [5]'],
  ['land-gravel', 819656, 189858, 'DeqstersLab', 'Human jumping down to gravel w/ impact'],
  ['land-wood', 422857, 6613468, 'IPaddeh', 'Jump_Landing_Wood_01.wav'],
  // ---- body and gear
  ['gear-friction', 517150, 2056159, 'isbeorn', 'gear-friction.wav'],
  ['cloth-rustle', 19291, 84709, 'martian', 'foley cloth rustle.wav'],
  ['rifle-canvas', 620935, 13743365, 'moneybags-anon', 'SVT40 (canvas backpack)'],
  ['grunt-1', 547208, 129727, 'MrFossy', 'Voice_AdultMale_PainGrunts_10.wav'],
  ['grunt-2', 547191, 129727, 'MrFossy', 'Voice_AdultMale_PainGrunts_19.wav'],
  ['grunt-3', 547195, 129727, 'MrFossy', 'Voice_AdultMale_PainGrunts_12.wav'],
  ['grunt-4', 547199, 129727, 'MrFossy', 'Voice_AdultMale_PainGrunts_16.wav'],
  ['grunt-5', 547203, 129727, 'MrFossy', 'Voice_AdultMale_PainGrunts_01.wav'],
  ['grunt-6', 547206, 129727, 'MrFossy', 'Voice_AdultMale_PainGrunts_06.wav'],
  ['heartbeat', 43621, 211893, 'kathol', 'real heartbeat.wav'],
  ['breath-fast', 554907, 9250976, 'Nox_Sound', 'Male_Breath_Fast_Loop_Stereo.wav'],
  ['bodyfall', 504626, 4437257, 'leonelmail', 'BODY FALL - V HVY - DIRT'],
  // ---- ambience
  ['amb-harbor-dock', 254125, 3530854, 'clif_creates', 'Harbor Ambience 1'],
  ['amb-sea-ionian', 861755, 15636277, 'bassimat', 'Sea, Rocks, Shoreline, Water, Crickets and Seaguls in front of the Ionian Sea at Early Morning'],
  ['amb-pine-wind-birds', 636425, 2061858, 'Garuda1982', 'windy pine forest with birds atmo'],
  ['amb-forest-morning', 776075, 10924423, 'soundandmelodies', 'AMB-Morning,Forest,Birds,Wind1-Otepaa-Estonia-22Mar2021,0547H'],
  ['amb-factory-night', 475688, 2337290, 'ecfike', 'Factory Exterior, Night'],
  ['amb-industrial-harbor', 413334, 7723777, 'flood-mix', 'Baltimore Harbor with Distant Industrial Ambience'],
  ['amb-wind-calm', 506910, 9250976, 'Nox_Sound', 'Ambiance_Wind_Forest_Calm_Loop_Stereo.wav'],
  ['amb-rain-city', 217236, 4054839, 'roofusj', 'steady rain in the city.wav'],
  ['amb-rain-tin-roof', 521773, 129727, 'MrFossy', 'Indoors_Shed_RainOnTinRoof_01.wav'],
  ['generator', 516759, 3874107, 'jameswrowles', 'Small Diesel Generator'],
  ['water-lap', 528067, 3713344, 'laughatlantic', 'Water lapping on lake Pukaki,South Island,New Zealand.mp3'],
  ['metal-creak', 172411, 2915633, 'EagleStealthTeam', 'Creaking Metal - Slow'],
  ['gull', 263786, 1474204, 'steaq', 'Seagull single call'],
  ['fence-rattle', 189219, 3263431, 'Starvolt', 'Fence Rattle 1 Rear.wav'],
  ['twig-1', 452570, 612689, 'kyles', 'branch breaking forest twig snap crunch.wav'],
  ['twig-2', 251464, 84709, 'martian', 'twig snap classic.wav'],
  ['twig-3', 364699, 2531187, 'alegemaate', 'Twig Snap'],
];

/** key -> { url, file, license, author, title, page, credit? } */
export const FREESOUND = Object.fromEntries(
  FREESOUND_ROWS.map(([key, id, uploader, author, title, by]) => {
    const page = `https://freesound.org/s/${id}/`;
    const license = by ?? 'CC0';
    return [
      key,
      {
        url: `https://cdn.freesound.org/previews/${Math.floor(id / 1000)}/${id}_${uploader}-hq.mp3`,
        file: `fs-${id}.mp3`,
        license,
        author,
        title,
        page,
        ...(by ? { credit: `"${title}" by ${author}, ${page}, ${by}` } : {}),
      },
    ];
  }),
);

export function ffslSource(key) {
  return { license: 'CC0', author: FFSL.author, title: `${FFSL.title}: ${FFSL_FILES[key]}`, page: FFSL.page };
}
