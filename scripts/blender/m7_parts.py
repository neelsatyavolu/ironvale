"""Geometry of the M7 rifle, part by part, in gun space (see m7_lib.py).

Each major part starts from its side outline, measured in millimetres off a
side-on photograph of the issued rifle scaled to its published length with
the suppressor fitted (914 mm). The outline is extruded to the part's width
with its edges rolled over, and pockets, ports and slots are then cut out.
Bore axis 105 mm above the middle of the pistol grip, top of the rail 37 mm
above the bore. Nothing here is traced or copied from another model.
"""
import math

import bpy

from m7_lib import boolean, box, cylinder, finish, front_prism, join, lathe, loft, mm, octagon, rotate_about_x, rotate_about_z, rounded, rounded_prism, side_prism, stadium, top_prism
from m7_outlines import OUTLINE

BORE = 0.105
RAIL_BASE = 0.1335
RAIL_TOP = 0.142
RAIL_PITCH = 0.0100076
MUZZLE = -0.636
RECEIVER = (0.063, -0.18)
HANDGUARD = (-0.18, -0.463)
HANDGUARD_TOP = 0.137
SPLIT = 0.08

# Surfaces. Colours are sRGB; the bake adds wear, dirt and grain on top.
ANODISE = dict(texture_set="m7_receiver", colour=0x5B4731, roughness=0.5, metalness=0.55, wear=0.6, bump=0.5, pattern="none", bevel=0.0005, segments=3)
POLYMER = dict(texture_set="m7_furniture", colour=0x594631, roughness=0.82, metalness=0.0, wear=0.0, bump=1.0, pattern="stipple", bevel=0.0006, segments=2)
MAGAZINE = dict(texture_set="m7_furniture", colour=0x55432F, roughness=0.6, metalness=0.0, wear=0.0, bump=0.5, pattern="stipple", bevel=0.0005)
RUBBER = dict(texture_set="m7_furniture", colour=0x1C1C1D, roughness=0.9, metalness=0.0, wear=0.0, bump=1.0, pattern="ribs", bevel=0.0005)
BLACK = dict(texture_set="m7_steel", colour=0x2B2C2F, roughness=0.5, metalness=1.0, wear=0.5, bump=0.5, pattern="none", bevel=0.0004)
KNURLED = {**BLACK, "pattern": "knurl", "bump": 1.0}
BRIGHT = dict(texture_set="m7_steel", colour=0x5E6165, roughness=0.4, metalness=1.0, wear=0.15, bump=0.4, pattern="none", bevel=0.0004)
CERAKOTE = dict(texture_set="m7_steel", colour=0x654C33, roughness=0.72, metalness=0.25, wear=0.3, bump=0.7, pattern="none", bevel=0.0006)
BRASS = dict(texture_set="m7_steel", colour=0xB8934E, roughness=0.3, metalness=1.0, wear=0.0, bump=0.2, pattern="none", bevel=0.0)
COPPER = dict(texture_set="m7_steel", colour=0xA8633C, roughness=0.32, metalness=1.0, wear=0.0, bump=0.2, pattern="none", bevel=0.0)
PAINT = dict(texture_set="m7_receiver", colour=0xD9D3C2, roughness=0.7, metalness=0.0, wear=0.0, bump=0.0, pattern="none", bevel=0.0)


def span(side: int, inner: float, outer: float) -> tuple[float, float]:
    """The x range from `inner` to `outer` on one side of the gun, lowest first."""
    return (min(side * inner, side * outer), max(side * inner, side * outer))


def plate(name: str, outline: str, side: int, inner: float, outer: float, surface: dict, part: str = "body") -> bpy.types.Object:
    """A flat piece standing on one flank, from its outline."""
    return finish(side_prism(name, mm(OUTLINE[outline]), *span(side, inner, outer)), part, **surface)


def pin(name: str, y: float, z: float, radius: float, half: float) -> bpy.types.Object:
    """A cross pin whose heads stand a little proud of both sides."""
    return finish(cylinder(name, 0, (y, z), radius, -half, half, 14), "body", **{**BLACK, "bevel": 0.0003})


def socket(name: str, side: int, y: float, z: float, surface: float) -> bpy.types.Object:
    """A quick-detach sling socket: a steel cup set into the side."""
    cup = cylinder(name, 0, (y, z), 0.0075, side * (surface - 0.004), side * (surface + 0.0008), 18)
    boolean(cup, cylinder("hole", 0, (y, z), 0.005, side * (surface - 0.0025), side * (surface + 0.002), 18))
    return finish(cup, "body", **BLACK)


def upper_receiver() -> None:
    # Flat flanks, a rounded shoulder up to the rail, in section.
    half = [(0.019, SPLIT), (0.019, 0.116), (0.0183, 0.1205), (0.0165, 0.125), (0.0145, 0.129), (0.0135, 0.1315), (0.0135, RAIL_BASE)]
    section = half + [(-x, y) for x, y in reversed(half)]
    upper = front_prism("upper", section, RECEIVER[0], RECEIVER[1])
    boolean(upper, side_prism("rearSlope", mm(OUTLINE["upper_rear_cut"]), -0.03, 0.03))
    # Bolt channel, the track of the rear charging handle above it, the ejection port and the top of the magazine well.
    boolean(upper, box("channel", (-0.0125, 0.089, -0.2), (0.0125, 0.1195, 0.05)))
    boolean(upper, box("track", (-0.0065, 0.1193, -0.12), (0.0065, 0.1305, 0.07)))
    boolean(upper, port_cutter())
    boolean(upper, box("well", (-0.0135, 0.07, -0.1625), (0.0135, 0.0895, -0.0885)))
    # Long slot for the left-side charging handle, along the upper edge of the flank.
    boolean(upper, box("slot", (-0.03, 0.1205, -0.165), (-0.0155, 0.1262, -0.06)))
    # Lightening window through the tail.
    boolean(upper, loft("tailWindow", [[(x, 0.1165 + v, 0.048 + u) for u, v in stadium(0.022, 0.007)] for x in (-0.03, 0.03)]))
    finish(upper, "body", **ANODISE)

    for side in (-1, 1):
        # Step where the flank meets the shoulder, running forward from the port.
        x0, x1 = span(side, 0.0186, 0.0197)
        finish(box("shelf", (x0, 0.1165, -0.176), (x1, 0.1195, -0.08)), "body", **ANODISE)
    # Raised lip round the ejection port, and the deflector hump behind it.
    plate("portLip", "port_lip", 1, 0.0186, 0.0198, ANODISE)
    hump = rounded_prism("deflector", mm(OUTLINE["deflector"]), 0.0185, 0.0252, 0.002)
    finish(hump, "body", **ANODISE)
    plate("deflectorFace", "deflector_face", 1, 0.0252, 0.0258, BLACK)
    # Dust cover, open and hanging from its hinge rod under the port.
    cover = rounded_prism("dustCover", mm(OUTLINE["dust_cover"]), 0.0194, 0.0212, 0.0006)
    finish(cover, "body", **BLACK)
    finish(box("dustCoverLatch", (0.0212, 0.071, -0.121), (0.0224, 0.078, -0.111)), "body", **BLACK)
    finish(cylinder("dustCoverRod", 2, (0.0203, 0.0918), 0.0019, -0.163, -0.07, 10), "body", **{**BLACK, "bevel": 0.0})


def port_cutter() -> bpy.types.Object:
    """The ejection port: a rounded opening in the right flank."""
    outline = [(-0.1168 + u, 0.1032 + v) for u, v in _rounded_rect(0.0843, 0.0204, 0.003)]
    return loft("port", [[(x, y, z) for z, y in outline] for x in (0.01, 0.03)])


def _rounded_rect(length: float, height: float, radius: float) -> list[tuple[float, float]]:
    return [(x, y) for x, y in rounded(length / 2, -height / 2, height / 2, radius)]


def lower_receiver() -> None:
    housing = rounded_prism("lower", mm(OUTLINE["housing"]), -0.0148, 0.0148, 0.002)
    boolean(housing, box("triggerSlot", (-0.0042, 0.03, -0.064), (0.0042, 0.064, -0.036)))
    finish(housing, "body", **ANODISE)
    well = rounded_prism("magazineWell", mm(OUTLINE["magazine_well"]), -0.0168, 0.0168, 0.0025)
    hole = box("wellHole", (-0.0135, 0.0, -0.1625), (0.0135, 0.09, -0.0885))
    boolean(well, hole)
    finish(well, "body", **ANODISE)
    flare = rounded_prism("wellFlare", mm(OUTLINE["well_flare"]), -0.019, 0.019, 0.003)
    boolean(flare, box("wellHole", (-0.0135, 0.0, -0.1625), (0.0135, 0.09, -0.0885)))
    finish(flare, "body", **ANODISE)
    finish(rounded_prism("pivotLug", mm(OUTLINE["pivot_lug"]), -0.0115, 0.0115, 0.002), "body", **ANODISE)
    finish(rounded_prism("triggerGuard", mm(OUTLINE["trigger_guard"]), -0.0068, 0.0068, 0.001), "body", **ANODISE)

    pin("takedownPin", 0.074, 0.0, 0.005, 0.0156)
    pin("pivotPin", 0.0765, -0.167, 0.0042, 0.0125)
    pin("triggerPin", 0.057, -0.047, 0.0021, 0.0154)
    pin("hammerPin", 0.065, -0.067, 0.0021, 0.0154)
    pin("selectorDetent", 0.076, -0.02, 0.0016, 0.0153)
    for side in (-1, 1):
        socket("lowerSocket", side, 0.0755, 0.038, 0.0148)
        # Raised panel on the magazine well.
        plate("wellPanel", "well_panel", side, 0.0165, 0.0176, ANODISE)
        # Safety selector: an axle with a lever hanging down, and two painted marks for its positions.
        finish(cylinder("selectorAxle", 0, (0.064, -0.02), 0.0052, side * 0.0148, side * 0.018, 16), "body", **BLACK)
        lever = box("selectorLever", (span(side, 0.0162, 0.0202)[0], 0.0615, -0.046), (span(side, 0.0162, 0.0202)[1], 0.0668, -0.018))
        finish(rotate_about_x(lever, 78, (0.064, -0.02)), "body", **BLACK)
        for name, y, z in (("markSafe", 0.062, -0.004), ("markFire", 0.062, -0.036)):
            finish(cylinder(name, 0, (y, z), 0.0013, side * 0.0146, side * 0.01495, 8), "body", **PAINT)
    # Right side: magazine release in its fence, and the bolt release paddle above it.
    fence = side_prism("releaseFence", mm(OUTLINE["release_fence"]), 0.0146, 0.0172)
    boolean(fence, cylinder("fenceHole", 0, (0.059, -0.08), 0.0064, 0.01, 0.03, 18))
    finish(fence, "body", **ANODISE)
    finish(cylinder("magRelease", 0, (0.059, -0.08), 0.0056, 0.0146, 0.0168, 16), "body", **KNURLED)
    plate("boltRelease", "bolt_release", 1, 0.0146, 0.0186, KNURLED)
    # Left side: magazine release lever and the bolt catch paddle above the magazine well.
    plate("magReleaseLever", "mag_lever", -1, 0.0166, 0.0196, BLACK)
    plate("boltCatch", "bolt_catch", -1, 0.0166, 0.0204, KNURLED)


def grip() -> None:
    body = rounded_prism("grip", mm(OUTLINE["grip"]), -0.014, 0.014, 0.008)
    finish(body, "body", **{**POLYMER, "bump": 0.6})
    finish(rounded_prism("gripTang", mm(OUTLINE["grip_tang"]), -0.0115, 0.0115, 0.003), "body", **{**POLYMER, "bump": 0.6})
    for side in (-1, 1):
        # Stippled panel on each flank, with the ribbed front and back straps beside it.
        plate("gripPanel", "grip_panel", side, 0.0136, 0.0145, {**POLYMER, "bump": 2.4})
    finish(side_prism("frontStrap", mm(OUTLINE["grip_front_strap"]), -0.0055, 0.0055), "body", **{**POLYMER, "pattern": "ribs", "bump": 0.5, "bevel": 0.0008})
    finish(side_prism("backStrap", mm(OUTLINE["grip_back_strap"]), -0.0055, 0.0055), "body", **{**POLYMER, "pattern": "ribs", "bump": 0.5, "bevel": 0.0008})


def rail() -> None:
    base = [(-0.0106, 0.1392), (0.0106, 0.1392), (0.0079, 0.1365), (0.0079, 0.133), (-0.0079, 0.133), (-0.0079, 0.1365)]
    finish(front_prism("railBase", base, 0.032, -0.446), "body", **{**ANODISE, "bevel": 0.0003})
    tooth = [(-0.00784, RAIL_TOP), (0.00784, RAIL_TOP), (0.0106, 0.1392), (-0.0106, 0.1392)]
    teeth = []
    z = 0.03
    while z - 0.00478 > -0.446:
        teeth.append(front_prism("tooth", tooth, z, z - 0.00478))
        z -= RAIL_PITCH
    finish(join(teeth, "railTeeth"), "body", **{**ANODISE, "bevel": 0.0003, "wear": 0.9})


def window(side: int, z: float, y: float, kind: str) -> bpy.types.Object:
    """One opening in the handguard, as a block long enough to pass through its wall on one side."""
    if kind == "mlok":
        outline = stadium(0.032, 0.0062)
    else:
        # A lightening window: a parallelogram leaning forward at the top.
        width, height = (0.0135, 0.0088) if kind == "window" else (0.012, 0.0064)
        lean = 0.75
        corners = [(-width / 2, -height / 2), (width / 2, -height / 2), (width / 2, height / 2), (-width / 2, height / 2)]
        outline = [(u - v * lean, v) for u, v in corners]
    return loft("window", [[(x, y + v, z + u) for u, v in outline] for x in span(side, 0.012, 0.034)])


def handguard() -> None:
    middle = (0.085 + HANDGUARD_TOP) / 2
    outer = front_prism("handguard", octagon(0.0225, 0.085, HANDGUARD_TOP, 0.0085), HANDGUARD[0], HANDGUARD[1])
    boolean(outer, front_prism("inside", octagon(0.0202, 0.0873, HANDGUARD_TOP - 0.0023, 0.0078), -0.1, -0.5))
    # The front edge rakes back from the nose at bore height to the top.
    boolean(outer, side_prism("frontRake", mm(OUTLINE["handguard_front_cut"]), -0.03, 0.03))
    upper = math.degrees(math.atan2(HANDGUARD_TOP - 0.00425 - middle, 0.0225 - 0.00425))
    cutters = []
    for side in (-1, 1):
        turn = lambda cutter, degrees: rotate_about_z(cutter, side * degrees, (0, middle))  # noqa: E731
        # 3 o'clock and 9 o'clock: M-LOK slots low on the flank, lightening windows above them toward the receiver.
        for index in range(6):
            cutters.append(window(side, -0.208 - index * 0.04, 0.1, "mlok"))
        for index in range(8):
            cutters.append(window(side, -0.197 - index * 0.0183, 0.1165, "window"))
        # The shoulders: a row of small windows the whole length.
        for index in range(14):
            cutters.append(turn(window(side, -0.196 - index * 0.0183, middle, "small"), upper))
        # The lower shoulders: M-LOK slots ahead of the belly.
        for index in range(5):
            cutters.append(turn(window(side, -0.272 - index * 0.04, middle, "mlok"), -upper))
    # 6 o'clock.
    for index in range(5):
        cutters.append(rotate_about_z(window(1, -0.272 - index * 0.04, middle, "mlok"), -90, (0, middle)))
    boolean(outer, cutters)
    finish(outer, "body", **{**ANODISE, "bevel": 0.0007})

    # Deeper belly under the barrel nut, with its own windows.
    belly = rounded_prism("belly", mm(OUTLINE["handguard_belly"]), -0.0175, 0.0175, 0.003)
    boolean(belly, cylinder("bellyBore", 2, (0, BORE - 0.004), 0.0155, -0.26, -0.17, 20))
    openings = [window(side, z, 0.0795, "window") for side in (-1, 1) for z in (-0.197, -0.2153, -0.2336)]
    boolean(belly, openings)
    finish(belly, "body", **ANODISE)
    for side in (-1, 1):
        for z in (-0.187, -0.262, -0.342):
            finish(cylinder("handguardScrew", 0, (0.108, z), 0.0027, side * 0.022, side * 0.0232, 12), "body", **{**BLACK, "bevel": 0.0003})
        socket("handguardSocket", side, 0.1, -0.444, 0.0225)


def barrel() -> None:
    profile = [(-0.165, 0.0125), (-0.2, 0.0125), (-0.203, 0.0098), (-0.462, 0.0098), (-0.464, 0.0086), (-0.48, 0.0086)]
    finish(lathe("barrel", profile, (0, BORE), 32), "body", **BLACK)
    finish(lathe("barrelNut", [(-0.181, 0.0165), (-0.198, 0.0165)], (0, BORE), 24), "body", **KNURLED)
    # Gas block with the two-position valve showing at the front of the handguard, and the operating rod above the barrel.
    finish(lathe("gasBlock", [(-0.409, 0.0135), (-0.439, 0.0135)], (0, BORE), 24), "body", **BLACK)
    finish(box("gasBlockTower", (-0.0075, BORE, -0.437), (0.0075, 0.1245, -0.411)), "body", **BLACK)
    valve = [(-0.399, 0.0056), (-0.447, 0.0056), (-0.448, 0.0068), (-0.456, 0.0068), (-0.457, 0.0045), (-0.46, 0.0045)]
    finish(lathe("gasValve", valve, (0, 0.1225), 16), "body", **KNURLED)
    finish(lathe("operatingRod", [(-0.19, 0.004), (-0.399, 0.004)], (0, 0.1225), 12), "body", **{**BRIGHT, "bevel": 0.0})


def fluted(name: str, profile: list[tuple[float, float]], centre: tuple[float, float], flutes: int, depth: float, between: tuple[float, float]) -> bpy.types.Object:
    """A lathe scalloped along its length between two stations, for a ring that is turned by hand."""
    segments = flutes * 4
    loops = []
    for z, r in profile:
        ring = []
        for i in range(segments):
            angle = 2 * math.pi * i / segments
            radius = r * (1 - depth) if i % 4 == 0 and between[1] <= z <= between[0] and r > 0.019 else r
            ring.append((centre[0] + radius * math.cos(angle), centre[1] + radius * math.sin(angle), z))
        loops.append(ring)
    obj = loft(name, loops)
    obj["curved"] = True
    return obj


def suppressor() -> None:
    centre = (0, BORE)
    finish(lathe("muzzleMount", [(-0.464, 0.0105), (-0.4655, 0.0125), (-0.469, 0.0125)], centre, 24), "body", **BLACK)
    # Locking ring: a scalloped grip with a plain band ahead of it.
    ring = [(-0.4665, 0.0135), (-0.468, 0.0185), (-0.471, 0.0204), (-0.499, 0.0204), (-0.5, 0.0196), (-0.5015, 0.0196), (-0.5025, 0.0205), (-0.511, 0.0205), (-0.5125, 0.019)]
    finish(fluted("lockingRing", ring, centre, 18, 0.05, (-0.471, -0.499)), "body", **{**BLACK, "wear": 0.7})
    body = [
        (-0.511, 0.016), (-0.5125, 0.0188), (-0.52, 0.0188), (-0.5208, 0.0195), (-0.548, 0.0195), (-0.5486, 0.0189), (-0.551, 0.0189), (-0.5516, 0.0195),
        (-0.612, 0.0195), (-0.6126, 0.019), (-0.6138, 0.019), (-0.6144, 0.0195), (-0.629, 0.0195), (-0.6345, 0.0172), (MUZZLE, 0.0172), (MUZZLE, 0.0146),
        (-0.631, 0.0146), (-0.631, 0.0046), (-0.6, 0.0046),
    ]
    can = lathe("suppressor", body, centre, 72)
    vents = []
    for i in range(8):
        angle = 2 * math.pi * (i + 0.5) / 8
        vents.append(cylinder("vent", 2, (0.0098 * math.cos(angle), BORE + 0.0098 * math.sin(angle)), 0.002, -0.64, -0.624, 10))
    boolean(can, vents)
    finish(can, "body", **CERAKOTE)


def stock() -> None:
    # Compact folding hinge on the rear of the receiver, its knuckle on the left where the stock swings.
    finish(rounded_prism("hinge", mm(OUTLINE["hinge"]), -0.0125, 0.0125, 0.002), "body", **BLACK)
    finish(cylinder("hingeKnuckle", 1, (-0.013, 0.0735), 0.0052, 0.084, 0.121, 14), "body", **BLACK)
    finish(cylinder("hingeScrew", 0, (0.11, 0.074), 0.0034, 0.0125, 0.0138, 12), "body", **KNURLED)
    # The strut the butt slides on: a slim neck out of the hinge, then the deeper housing of the latch.
    finish(front_prism("strutNeck", rounded(0.0105, 0.102, 0.122, 0.006), 0.0836, 0.111), "body", **ANODISE)
    finish(front_prism("strutHousing", rounded(0.012, 0.089, 0.1225, 0.006), 0.109, 0.15), "body", **ANODISE)
    plate("strutButton", "strut_button", 1, 0.0103, 0.0116, ANODISE)

    butt = rounded_prism("stock", mm(OUTLINE["stock"]), -0.0155, 0.0155, 0.004)
    for side in (-1, 1):
        # Recess on each side that the length-adjustment lever lies in.
        boolean(butt, side_prism("stockRecess", mm(OUTLINE["stock_recess"]), *span(side, 0.0125, 0.03)))
    boolean(butt, side_prism("slingSlot", mm(OUTLINE["sling_slot"]), -0.03, 0.03))
    finish(butt, "body", **{**POLYMER, "bevel": 0.0008})
    finish(rounded_prism("stockLever", mm(OUTLINE["stock_lever"]), -0.0147, 0.0147, 0.0012), "body", **{**POLYMER, "pattern": "ribs", "bump": 0.4})
    # The butt is wider than the cheek section.
    finish(rounded_prism("buttPlate", mm(OUTLINE["butt_plate"]), -0.0185, 0.0185, 0.003), "body", **POLYMER)
    for side in (-1, 1):
        socket("stockSocket", side, 0.108, 0.2, 0.0155)
    finish(rounded_prism("buttPad", mm(OUTLINE["butt_pad"]), -0.0185, 0.0185, 0.003), "body", **RUBBER)


def side_charging_handle() -> None:
    """Left-side charging handle: a slider in its slot, and the handle folded forward beside the handguard."""
    finish(box("sideSlider", (-0.0208, 0.1208, -0.165), (-0.0155, 0.126, -0.128)), "body", **BLACK)
    finish(box("sideLink", (-0.024, 0.104, -0.204), (-0.019, 0.126, -0.15)), "body", **BLACK)
    finish(rounded_prism("sideHandle", mm(OUTLINE["side_handle"]), -0.0305, -0.0232, 0.0015), "body", **KNURLED)


def folded_sights() -> None:
    """Back-up sights, folded flat on the rail at each end."""
    for name, z in (("rearSight", 0.012), ("frontSight", -0.42)):
        finish(box(f"{name}Base", (-0.0125, 0.1385, z - 0.016), (0.0125, 0.1462, z + 0.016)), "body", **BLACK)
        finish(box(f"{name}Arm", (-0.0075, 0.1462, z - 0.02), (0.0075, 0.1512, z + 0.014)), "body", **{**BLACK, "bevel": 0.0008})
        finish(cylinder(f"{name}Bolt", 0, (0.1422, z), 0.003, -0.0142, 0.0142, 12), "body", **KNURLED)
        finish(cylinder(f"{name}Pivot", 0, (0.1487, z + 0.012), 0.0026, -0.0092, 0.0092, 10), "body", **BLACK)


def charging_handle() -> None:
    wings = [(-0.027, 0.063), (0.027, 0.063), (0.027, 0.07), (0.02, 0.077), (-0.02, 0.077), (-0.027, 0.07)]
    finish(top_prism("chargingHandleHead", wings, 0.1195, 0.1312), "chargingHandle", **{**BLACK, "bevel": 0.001})
    finish(box("chargingHandleBar", (-0.006, 0.1222, -0.11), (0.006, 0.13, 0.065)), "chargingHandle", **BLACK)
    for side in (-1, 1):
        finish(box("chargingHandleLatch", (span(side, 0.012, 0.026)[0], 0.1312, 0.0645), (span(side, 0.012, 0.026)[1], 0.1322, 0.0755)), "chargingHandle", **KNURLED)


def bolt() -> None:
    carrier = [(-0.166, 0.0082), (-0.16, 0.0094), (-0.118, 0.0094), (-0.117, 0.0088), (-0.114, 0.0088), (-0.113, 0.0094), (-0.058, 0.0094), (-0.056, 0.0085), (-0.03, 0.0085)]
    finish(lathe("boltCarrier", carrier, (0, BORE), 24), "bolt", **BRIGHT)
    finish(box("extractor", (0.0075, 0.101, -0.158), (0.0101, 0.109, -0.128)), "bolt", **BLACK)


def magazine() -> None:
    finish(rounded_prism("magazineBody", mm(OUTLINE["magazine"]), -0.0128, 0.0128, 0.003), "magazine", **MAGAZINE)
    finish(rounded_prism("floorPlate", mm(OUTLINE["floor_plate"]), -0.0142, 0.0142, 0.0012), "magazine", **MAGAZINE)
    for side in (-1, 1):
        plate("magazinePanel", "magazine_panel", side, 0.0124, 0.0134, MAGAZINE, "magazine")
        finish(box("feedLip", (span(side, 0.0068, 0.0125)[0], 0.0885, -0.136), (span(side, 0.0068, 0.0125)[1], 0.0935, -0.093)), "magazine", **MAGAZINE)
    for y in (0.012, -0.014):
        # Witness holes on the right.
        finish(cylinder("witnessHole", 0, (y, -0.113), 0.0016, 0.0128, 0.01292, 10), "magazine", **{**BLACK, "bevel": 0.0, "wear": 0.0})
    # Top cartridge, 6.8 x 51 mm.
    case = [(-0.0925, 0.0052), (-0.0935, 0.006), (-0.131, 0.006), (-0.1355, 0.0042), (-0.1435, 0.0042)]
    finish(lathe("cartridgeCase", case, (0.0025, 0.0905), 16), "magazine", **BRASS)
    bullet = [(-0.1435, 0.0035), (-0.151, 0.0033), (-0.158, 0.0021), (-0.1615, 0.0007)]
    finish(lathe("cartridgeBullet", bullet, (0.0025, 0.0905), 16), "magazine", **COPPER)


def trigger() -> None:
    finish(rounded_prism("trigger", mm(OUTLINE["trigger"]), -0.0036, 0.0036, 0.0008), "trigger", **{**BLACK, "bevel": 0.0})


# Where each moving part's node sits: the point it slides from or turns about.
PIVOTS = {
    "body": (0.0, 0.0, 0.0),
    "magazine": (0.0, 0.03, -0.126),
    "bolt": (0.0, BORE, -0.1),
    "chargingHandle": (0.0, 0.126, 0.07),
    "trigger": (0.0, 0.058, -0.051),
}


def build_all() -> None:
    upper_receiver()
    lower_receiver()
    grip()
    rail()
    handguard()
    barrel()
    suppressor()
    stock()
    side_charging_handle()
    folded_sights()
    charging_handle()
    bolt()
    magazine()
    trigger()
