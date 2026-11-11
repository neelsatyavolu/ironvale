"""Mesh helpers for scripts/blender/build-m7.py.

Everything here takes gun-space coordinates (metres, barrel along -Z, up +Y,
ejection port on +X, origin at the centre of the pistol grip) and converts to
Blender's axes on the way in, so the glTF exporter's Y-up conversion brings
the model out in gun space again.
"""
import math

import bmesh
import bpy
from mathutils import Vector

PARTS = ("body", "magazine", "bolt", "chargingHandle", "trigger")
SETS = ("m7_receiver", "m7_furniture", "m7_steel")
PATTERNS = {"none": 0, "stipple": 1, "ribs": 2, "knurl": 3}

built: list[bpy.types.Object] = []


def G(p: tuple[float, float, float]) -> Vector:
    """Gun space to Blender space."""
    return Vector((p[0], -p[2], p[1]))


def srgb(hex_colour: int) -> tuple[float, float, float]:
    """A 0xRRGGBB sRGB colour as linear RGB."""
    def channel(v: float) -> float:
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return tuple(channel((hex_colour >> shift) & 255) for shift in (16, 8, 0))


def _object(name: str, bm: bmesh.types.BMesh) -> bpy.types.Object:
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def loft(name: str, loops: list[list[tuple[float, float, float]]], cap: bool = True) -> bpy.types.Object:
    """A skin over closed sections that all have the same number of points, capped at both ends."""
    bm = bmesh.new()
    rings = [[bm.verts.new(G(p)) for p in loop] for loop in loops]
    count = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for i in range(count):
            j = (i + 1) % count
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if cap:
        bm.faces.new(rings[0])
        bm.faces.new(list(reversed(rings[-1])))
    return _object(name, bm)


def side_prism(name: str, profile: list[tuple[float, float]], x0: float, x1: float) -> bpy.types.Object:
    """`profile` is (z, y) points in the side view, extruded across the gun from x0 to x1."""
    return loft(name, [[(x, y, z) for z, y in profile] for x in (x0, x1)])


def front_prism(name: str, section: list[tuple[float, float]], z0: float, z1: float) -> bpy.types.Object:
    """`section` is (x, y) points seen from the muzzle, extruded along the barrel from z0 to z1."""
    return loft(name, [[(x, y, z) for x, y in section] for z in (z0, z1)])


def top_prism(name: str, outline: list[tuple[float, float]], y0: float, y1: float) -> bpy.types.Object:
    """`outline` is (x, z) points seen from above, extruded from y0 up to y1."""
    return loft(name, [[(x, y, z) for x, z in outline] for y in (y0, y1)])


def mm(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Outline points measured in millimetres, in metres."""
    return [(a / 1000, b / 1000) for a, b in points]


def inset(outline: list[tuple[float, float]], distance: float) -> list[tuple[float, float]]:
    """The outline moved inward by `distance`, corners mitred (and the mitre capped where a corner is sharp)."""
    count = len(outline)
    area = sum(outline[i][0] * outline[(i + 1) % count][1] - outline[(i + 1) % count][0] * outline[i][1] for i in range(count))
    turn = 1.0 if area > 0 else -1.0
    moved = []
    for i in range(count):
        before, here, after = outline[i - 1], outline[i], outline[(i + 1) % count]
        normals = []
        for a, b in ((before, here), (here, after)):
            length = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
            normals.append((-(b[1] - a[1]) / length * turn, (b[0] - a[0]) / length * turn))
        scale = distance / max(0.35, 1 + normals[0][0] * normals[1][0] + normals[0][1] * normals[1][1])
        moved.append((here[0] + (normals[0][0] + normals[1][0]) * scale, here[1] + (normals[0][1] + normals[1][1]) * scale))
    return moved


def rounded_prism(name: str, profile: list[tuple[float, float]], x0: float, x1: float, radius: float) -> bpy.types.Object:
    """
    A side-view outline (z, y) extruded across the gun from x0 to x1, with the
    edges round its two faces rolled over at `radius`, the way a forging or a
    moulding is. The rolled edge is a row of strips narrow enough for
    `flat_normals` to shade as one curve.
    """
    steps = max(3, math.ceil(radius * math.pi / 2 / 0.001))
    stations = []
    for step in range(steps + 1):
        angle = math.pi / 2 * step / steps
        stations.append((radius * (1 - math.sin(angle)), radius * (1 - math.cos(angle))))
    loops = []
    for depth, shrink in reversed(stations):
        loops.append([(x0 + depth, y, z) for z, y in inset(profile, shrink)])
    for depth, shrink in stations:
        loops.append([(x1 - depth, y, z) for z, y in inset(profile, shrink)])
    return loft(name, loops)


def box(name: str, lo: tuple[float, float, float], hi: tuple[float, float, float]) -> bpy.types.Object:
    return front_prism(name, [(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])], lo[2], hi[2])


def lathe(name: str, profile: list[tuple[float, float]], centre: tuple[float, float], segments: int = 32) -> bpy.types.Object:
    """Revolves (z, radius) points about the line through `centre` (x, y) parallel to the barrel."""
    loops = []
    for z, r in profile:
        loops.append([(centre[0] + r * math.cos(2 * math.pi * i / segments), centre[1] + r * math.sin(2 * math.pi * i / segments), z) for i in range(segments)])
    obj = loft(name, loops)
    obj["curved"] = True
    return obj


def cylinder(name: str, axis: int, centre: tuple[float, float], radius: float, a0: float, a1: float, segments: int = 16) -> bpy.types.Object:
    """A cylinder along gun axis 0, 1 or 2. `centre` gives the other two coordinates in axis order."""
    def point(a: float, u: float, v: float) -> tuple[float, float, float]:
        p = [0.0, 0.0, 0.0]
        p[axis] = a
        others = [k for k in range(3) if k != axis]
        p[others[0]] = u
        p[others[1]] = v
        return tuple(p)
    loops = []
    for a in (a0, a1):
        loops.append([point(a, centre[0] + radius * math.cos(2 * math.pi * i / segments), centre[1] + radius * math.sin(2 * math.pi * i / segments)) for i in range(segments)])
    obj = loft(name, loops)
    obj["curved"] = True
    return obj


def rounded(hw: float, y0: float, y1: float, radius: float, steps: int = 4) -> list[tuple[float, float]]:
    """A rounded rectangle section (x, y), `hw` half wide."""
    points = []
    for cx, cy, start in ((hw - radius, y1 - radius, 0), (-hw + radius, y1 - radius, 90), (-hw + radius, y0 + radius, 180), (hw - radius, y0 + radius, 270)):
        for i in range(steps + 1):
            angle = math.radians(start + 90 * i / steps)
            points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return points


def octagon(hw: float, y0: float, y1: float, chamfer: float) -> list[tuple[float, float]]:
    return [(hw, y0 + chamfer), (hw, y1 - chamfer), (hw - chamfer, y1), (-hw + chamfer, y1), (-hw, y1 - chamfer), (-hw, y0 + chamfer), (-hw + chamfer, y0), (hw - chamfer, y0)]


def stadium(length: float, width: float, steps: int = 5) -> list[tuple[float, float]]:
    """A slot outline (u along its length, v across), centred on the origin."""
    r = width / 2
    points = []
    for cu, start in ((length / 2 - r, -90), (-length / 2 + r, 90)):
        for i in range(steps + 1):
            angle = math.radians(start + 180 * i / steps)
            points.append((cu + r * math.cos(angle), r * math.sin(angle)))
    return points


def _apply(obj: bpy.types.Object, modifier: bpy.types.Modifier) -> None:
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj], selected_editable_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier=modifier.name)


def join(objects: list[bpy.types.Object], name: str | None = None) -> bpy.types.Object:
    target = objects[0]
    if len(objects) > 1:
        with bpy.context.temp_override(object=target, active_object=target, selected_objects=objects, selected_editable_objects=objects):
            bpy.ops.object.join()
    if name:
        target.name = name
    return target


def boolean(obj: bpy.types.Object, cutters: bpy.types.Object | list[bpy.types.Object], operation: str = "DIFFERENCE") -> bpy.types.Object:
    """Cuts (or adds) `cutters` out of `obj` and deletes them."""
    cutter = join(list(cutters)) if isinstance(cutters, (list, tuple)) else cutters
    modifier = obj.modifiers.new("boolean", "BOOLEAN")
    modifier.object = cutter
    modifier.operation = operation
    modifier.solver = "EXACT"
    _apply(obj, modifier)
    bpy.data.objects.remove(cutter, do_unlink=True)
    return obj


def rotate_about_z(obj: bpy.types.Object, degrees: float, centre: tuple[float, float]) -> bpy.types.Object:
    """Turns an object about the line through `centre` (x, y) parallel to the barrel."""
    c = math.cos(math.radians(degrees))
    s = math.sin(math.radians(degrees))
    for vertex in obj.data.vertices:
        x = vertex.co.x - centre[0]
        y = vertex.co.z - centre[1]
        vertex.co.x = centre[0] + x * c - y * s
        vertex.co.z = centre[1] + x * s + y * c
    return obj


def rotate_about_x(obj: bpy.types.Object, degrees: float, centre: tuple[float, float]) -> bpy.types.Object:
    """Turns an object about the line through `centre` (y, z) across the gun."""
    c = math.cos(math.radians(degrees))
    s = math.sin(math.radians(degrees))
    for vertex in obj.data.vertices:
        y = vertex.co.z - centre[0]
        z = -vertex.co.y - centre[1]
        vertex.co.z = centre[0] + y * c - z * s
        vertex.co.y = -(centre[1] + y * s + z * c)
    return obj


def flat_normals(mesh: bpy.types.Mesh) -> None:
    """
    Shading normals for a part made of flat faces with rounded edges: every
    flat face is lit as one plane, and the narrow strips of a rounded edge
    blend between the faces they join. A face counts as a strip when it is
    under 1.2 mm across.
    """
    positions = [vertex.co for vertex in mesh.vertices]
    flat = []
    summed = [Vector() for _ in positions]
    around = [Vector() for _ in positions]
    for polygon in mesh.polygons:
        corners = [positions[index] for index in polygon.vertices]
        longest = max((corners[i] - corners[i - 1]).length for i in range(len(corners)))
        is_flat = longest > 0 and polygon.area / longest > 0.0012
        flat.append(is_flat)
        for index in polygon.vertices:
            around[index] += polygon.normal * polygon.area
            if is_flat:
                summed[index] += polygon.normal * polygon.area
    normals = [None] * len(mesh.loops)
    for polygon in mesh.polygons:
        for loop in polygon.loop_indices:
            vertex = mesh.loops[loop].vertex_index
            # A strip vertex takes the flat faces it touches; one in the middle of a rounded edge, everything round it.
            blended = summed[vertex] if summed[vertex].length > 1e-12 else around[vertex]
            normals[loop] = polygon.normal if flat[polygon.index] or blended.length < 1e-12 else blended.normalized()
    mesh.normals_split_custom_set(normals)


def finish(
    obj: bpy.types.Object,
    part: str,
    texture_set: str,
    colour: int,
    roughness: float,
    metalness: float,
    wear: float = 0.5,
    bump: float = 1.0,
    pattern: str = "none",
    bevel: float = 0.0005,
    segments: int = 2,
    angle: float = 32,
) -> bpy.types.Object:
    """
    Rounds the edges, sets the shading normals and records how the part is to
    be textured: its node, its texture set and the surface the bake paints.
    `wear` is how readily edges rub through to bare metal (0: never).
    """
    mesh = obj.data
    if bevel > 0:
        modifier = obj.modifiers.new("bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = segments
        modifier.limit_method = "ANGLE"
        modifier.angle_limit = math.radians(angle)
        modifier.harden_normals = True
        modifier.miter_outer = "MITER_ARC"
        _apply(obj, modifier)
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    if obj.get("curved"):
        mesh.set_sharp_from_angle(angle=math.radians(40))
        weighted = obj.modifiers.new("weighted", "WEIGHTED_NORMAL")
        weighted.keep_sharp = True
        weighted.weight = 60
        _apply(obj, weighted)
    else:
        flat_normals(mesh)
    faces = len(mesh.polygons)
    for name, kind, value in (
        ("part", "INT", PARTS.index(part)),
        ("texture_set", "INT", SETS.index(texture_set)),
        ("pattern", "FLOAT", float(PATTERNS[pattern])),
        ("rough", "FLOAT", roughness),
        ("metal", "FLOAT", metalness),
        ("wear", "FLOAT", wear),
        ("bump", "FLOAT", bump),
    ):
        attribute = mesh.attributes.new(name, kind, "FACE")
        attribute.data.foreach_set("value", [value] * faces)
    base = mesh.attributes.new("base", "FLOAT_COLOR", "FACE")
    base.data.foreach_set("color", [*srgb(colour), 1.0] * faces)
    built.append(obj)
    return obj
