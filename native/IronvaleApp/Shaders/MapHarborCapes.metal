// Harbor horizon haze: the opacity node of hazeBand() in src/maps/harbor/capes.ts at commit
// 3ec2f09. Solid at the waterline, clear above HAZE_TOP (66 m); WGSL's smoothstep with its edges
// reversed. The colour is white under the scene fog.
#ifndef IRONVALE_MAP_HARBOR_CAPES
#define IRONVALE_MAP_HARBOR_CAPES
#include "MapSurface.h"

constant float HB_HAZE_TOP = 66.0;

IV_SHADER_FN void ivHarborHaze(thread IVSurface &s) { s.opacity = ivSmoothstep(HB_HAZE_TOP, 20.0, s.localP.y); }
#endif  // IRONVALE_MAP_HARBOR_CAPES
