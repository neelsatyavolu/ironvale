"""Unwraps the finished M7 mesh, bakes its texture sets and exports it.

The mesh carries its real bevels, so nothing is baked from a second,
denser model. What is baked is the surface: each face records a base colour,
roughness, metalness, how readily it wears and a relief pattern (m7_lib.finish),
and a Cycles material turns those into worn, dirty, grained textures:
base colour, a normal map of the fine relief, and occlusion / roughness /
metalness packed in one image the way glTF wants them.
"""
import math
import os
from collections.abc import Callable

import bmesh
import bpy
import numpy as np

from m7_lib import PARTS, SETS, G, join

TEXTURE_SIZE = {"m7_receiver": 2048, "m7_furniture": 1024, "m7_steel": 1024}
# Moving parts are pulled clear of the gun while baking so that occlusion does not
# shade the magazine as if it were always in its well, or the bolt as always in battery.
CLEAR = {"magazine": (0, -0.6, 0), "bolt": (0.6, 0, 0), "chargingHandle": (0, 0.6, 0), "trigger": (-0.6, 0, 0)}
BARE_METAL = (0.52, 0.53, 0.54)


def merge(objects: list[bpy.types.Object]) -> bpy.types.Object:
    """One triangulated mesh of everything, with a material slot per texture set."""
    gun = join(list(objects), "m7")
    # Joined objects linger by name until purged, and the part objects need those names.
    bpy.data.orphans_purge(do_recursive=True)
    mesh = gun.data
    # Joining leaves an empty slot behind.
    mesh.materials.clear()
    for name in SETS:
        mesh.materials.append(bpy.data.materials.new(name))
    sets = np.zeros(len(mesh.polygons), dtype=np.int32)
    mesh.attributes["texture_set"].data.foreach_get("value", sets)
    mesh.polygons.foreach_set("material_index", sets)
    triangulate = gun.modifiers.new("triangulate", "TRIANGULATE")
    triangulate.min_vertices = 4
    with bpy.context.temp_override(object=gun, active_object=gun, selected_objects=[gun], selected_editable_objects=[gun]):
        bpy.ops.object.modifier_apply(modifier=triangulate.name)
    return gun


def unwrap(gun: bpy.types.Object) -> None:
    """Each texture set gets its own 0 - 1 square, islands sized by their area."""
    mesh = gun.data
    mesh.uv_layers.new(name="UVMap")
    bpy.context.view_layer.objects.active = gun
    gun.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_mode(type="FACE")
    for index in range(len(SETS)):
        edit = bmesh.from_edit_mesh(mesh)
        for face in edit.faces:
            face.select_set(face.material_index == index)
        edit.select_flush_mode()
        bmesh.update_edit_mesh(mesh)
        bpy.ops.uv.smart_project(angle_limit=math.radians(80), island_margin=0.003, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    uv = np.zeros(len(mesh.loops) * 2, dtype=np.float32)
    mesh.uv_layers.active.data.foreach_get("uv", uv)
    if uv.min() < -1e-4 or uv.max() > 1 + 1e-4:
        raise RuntimeError(f"UV layout left the unit square: {uv.min()} to {uv.max()}")


def shift_parts(gun: bpy.types.Object, sign: int) -> None:
    mesh = gun.data
    part_of_face = np.zeros(len(mesh.polygons), dtype=np.int32)
    mesh.attributes["part"].data.foreach_get("value", part_of_face)
    moved = set()
    for polygon in mesh.polygons:
        offset = CLEAR.get(PARTS[part_of_face[polygon.index]])
        if not offset:
            continue
        for vertex in polygon.vertices:
            if vertex in moved:
                continue
            moved.add(vertex)
            mesh.vertices[vertex].co += G(offset) * sign
    mesh.update()


class Graph:
    """Shorthand for wiring shader nodes."""

    def __init__(self, tree: bpy.types.NodeTree) -> None:
        self.tree = tree
        self.nodes = tree.nodes
        self.links = tree.links

    def plug(self, socket: bpy.types.NodeSocket, value: object) -> None:
        if isinstance(value, bpy.types.NodeSocket):
            self.links.new(value, socket)
        else:
            socket.default_value = value

    def math(self, operation: str, a: object, b: object = 0.0, c: object = 0.0, clamp: bool = False) -> bpy.types.NodeSocket:
        node = self.nodes.new("ShaderNodeMath")
        node.operation = operation
        node.use_clamp = clamp
        for socket, value in zip(node.inputs, (a, b, c)):
            self.plug(socket, value)
        return node.outputs[0]

    def mix(self, factor: object, a: object, b: object) -> bpy.types.NodeSocket:
        node = self.nodes.new("ShaderNodeMix")
        node.data_type = "RGBA"
        self.plug(node.inputs[0], factor)
        self.plug(node.inputs[6], a)
        self.plug(node.inputs[7], b)
        return node.outputs[2]

    def attribute(self, name: str, output: str = "Fac") -> bpy.types.NodeSocket:
        node = self.nodes.new("ShaderNodeAttribute")
        node.attribute_name = name
        return node.outputs[output]

    def noise(self, vector: bpy.types.NodeSocket, scale: float, detail: float) -> bpy.types.NodeSocket:
        node = self.nodes.new("ShaderNodeTexNoise")
        self.links.new(vector, node.inputs["Vector"])
        node.inputs["Scale"].default_value = scale
        node.inputs["Detail"].default_value = detail
        return node.outputs["Fac"]

    def ramp(self, value: object, low: float, high: float) -> bpy.types.NodeSocket:
        """0 below `low`, 1 above `high`, straight in between."""
        node = self.nodes.new("ShaderNodeMapRange")
        node.clamp = True
        self.plug(node.inputs["Value"], value)
        node.inputs["From Min"].default_value = low
        node.inputs["From Max"].default_value = high
        return node.outputs[0]


def surface_material(material: bpy.types.Material) -> tuple[bpy.types.Node, Callable[[str], None]]:
    """
    The baking material. Returns the image node the bake writes to and a
    function that chooses what the surface emits for the two EMIT passes.
    """
    try:
        material.use_nodes = True
    except Exception:
        pass
    tree = material.node_tree
    tree.nodes.clear()
    g = Graph(tree)
    geometry = tree.nodes.new("ShaderNodeNewGeometry")
    position = geometry.outputs["Position"]
    separate = tree.nodes.new("ShaderNodeSeparateXYZ")
    tree.links.new(position, separate.inputs[0])

    # Edges: where the surface normal and the same normal rounded over 1.5 mm disagree.
    bevel = tree.nodes.new("ShaderNodeBevel")
    bevel.samples = 6
    bevel.inputs["Radius"].default_value = 0.0015
    dot = tree.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    tree.links.new(geometry.outputs["Normal"], dot.inputs[0])
    tree.links.new(bevel.outputs["Normal"], dot.inputs[1])
    edge = g.ramp(dot.outputs["Value"], 0.995, 0.86)
    # Crevices: corners and recesses within a centimetre of other surfaces.
    occlusion = tree.nodes.new("ShaderNodeAmbientOcclusion")
    occlusion.samples = 8
    occlusion.inputs["Distance"].default_value = 0.01
    open_surface = occlusion.outputs["AO"]

    blotch = g.noise(position, 16, 3)
    grain = g.noise(position, 140, 4)
    speckle = g.noise(position, 1100, 2)
    wear_amount = g.attribute("wear")

    # Wear: rubbed edges that are not tucked into a corner, broken up by the grain, plus the odd scuff on a flat.
    rubbed = g.math("MULTIPLY", edge, g.math("ADD", grain, 0.35))
    rubbed = g.math("MULTIPLY", rubbed, g.ramp(open_surface, 0.55, 0.8))
    scuffs = g.math("MULTIPLY", g.ramp(g.math("MULTIPLY", blotch, grain), 0.36, 0.42), 0.5)
    wear = g.ramp(g.math("MULTIPLY", g.math("ADD", rubbed, scuffs), wear_amount), 0.3, 0.5)

    base = g.attribute("base", "Color")
    shade = g.math("MULTIPLY", g.math("ADD", g.math("MULTIPLY", blotch, 0.16), 0.92), g.math("ADD", g.math("MULTIPLY", open_surface, 0.6), 0.4))
    dirty = tree.nodes.new("ShaderNodeVectorMath")
    dirty.operation = "SCALE"
    tree.links.new(base, dirty.inputs[0])
    tree.links.new(shade, dirty.inputs["Scale"])
    colour = g.mix(wear, dirty.outputs[0], (*BARE_METAL, 1))

    roughness = g.math("ADD", g.attribute("rough"), g.math("MULTIPLY", g.math("SUBTRACT", grain, 0.5), 0.22))
    roughness = g.math("ADD", roughness, g.math("MULTIPLY", g.math("SUBTRACT", 1.0, open_surface), 0.12))
    roughness = g.math("ADD", g.math("MULTIPLY", roughness, g.math("SUBTRACT", 1.0, wear)), g.math("MULTIPLY", wear, 0.3), clamp=True)
    metalness = g.math("MAXIMUM", g.attribute("metal"), wear)

    # Relief, in metres: fine grain everywhere, and one pattern per kind of surface.
    pattern = g.attribute("pattern")
    amount = g.attribute("bump")

    def only(kind: int, height: bpy.types.NodeSocket) -> bpy.types.NodeSocket:
        return g.math("MULTIPLY", g.math("COMPARE", pattern, float(kind), 0.25), height)

    def waves(coordinate: bpy.types.NodeSocket, pitch: float) -> bpy.types.NodeSocket:
        return g.math("SINE", g.math("MULTIPLY", coordinate, 2 * math.pi / pitch))

    voronoi = tree.nodes.new("ShaderNodeTexVoronoi")
    tree.links.new(position, voronoi.inputs["Vector"])
    voronoi.inputs["Scale"].default_value = 700
    height = g.math("MULTIPLY", g.math("SUBTRACT", speckle, 0.5), 0.00004)
    height = g.math("ADD", height, only(1, g.math("MULTIPLY", voronoi.outputs["Distance"], -0.00016)))
    height = g.math("ADD", height, only(2, g.math("MULTIPLY", waves(separate.outputs["Z"], 0.0042), 0.0005)))
    height = g.math("ADD", height, only(3, g.math("MULTIPLY", waves(separate.outputs["Y"], 0.0016), 0.00018)))
    height = g.math("MULTIPLY", height, amount)
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 1.0
    bump.inputs["Distance"].default_value = 1.0
    tree.links.new(height, bump.inputs["Height"])

    shader = tree.nodes.new("ShaderNodeBsdfPrincipled")
    tree.links.new(colour, shader.inputs["Base Color"])
    tree.links.new(roughness, shader.inputs["Roughness"])
    tree.links.new(metalness, shader.inputs["Metallic"])
    tree.links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    packed = tree.nodes.new("ShaderNodeCombineColor")
    packed.inputs[0].default_value = 0
    tree.links.new(roughness, packed.inputs[1])
    tree.links.new(metalness, packed.inputs[2])
    emission = tree.nodes.new("ShaderNodeEmission")
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    image = tree.nodes.new("ShaderNodeTexImage")
    tree.nodes.active = image

    def show(what: str) -> None:
        for link in list(output.inputs["Surface"].links):
            tree.links.remove(link)
        if what == "surface":
            tree.links.new(shader.outputs[0], output.inputs["Surface"])
            return
        tree.links.new(colour if what == "colour" else packed.outputs[0], emission.inputs["Color"])
        tree.links.new(emission.outputs[0], output.inputs["Surface"])

    return image, show


def bake(gun: bpy.types.Object, folder: str, scale: float) -> None:
    """Bakes every texture set and writes <set>_color.png, <set>_normal.png and <set>_orm.png into `folder`."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.use_denoising = False
    scene.render.bake.margin = 6
    scene.render.bake.use_clear = True
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.normal_space = "TANGENT"
    for other in scene.objects:
        other.select_set(other == gun)
    bpy.context.view_layer.objects.active = gun

    materials = {name: surface_material(gun.data.materials[index]) for index, name in enumerate(SETS)}
    shift_parts(gun, 1)
    results = {}
    passes = (("normal", "NORMAL", "surface", 1, True), ("ao", "AO", "surface", 16, True), ("color", "EMIT", "colour", 12, False), ("rm", "EMIT", "packed", 12, True))
    for label, kind, what, samples, data in passes:
        scene.cycles.samples = samples
        for name, (node, show) in materials.items():
            size = max(64, int(TEXTURE_SIZE[name] * scale))
            image = bpy.data.images.new(f"{name}_{label}", size, size, alpha=False, is_data=data)
            node.image = image
            show(what)
            results[(name, label)] = image
        bpy.ops.object.bake(type=kind)
    shift_parts(gun, -1)

    os.makedirs(folder, exist_ok=True)
    for name in SETS:
        size = results[(name, "ao")].size[0]
        pixels = {}
        for label in ("ao", "rm"):
            buffer = np.empty(size * size * 4, dtype=np.float32)
            results[(name, label)].pixels.foreach_get(buffer)
            pixels[label] = buffer.reshape(-1, 4)
        packed = pixels["rm"].copy()
        packed[:, 0] = pixels["ao"][:, 0]
        packed[:, 3] = 1
        results[(name, "rm")].pixels.foreach_set(packed.ravel())
        for label, suffix in (("color", "color"), ("normal", "normal"), ("rm", "orm")):
            image = results[(name, label)]
            image.filepath_raw = os.path.join(folder, f"{name}_{suffix}.png")
            image.file_format = "PNG"
            image.save()


def export(gun: bpy.types.Object, pivots: dict[str, tuple[float, float, float]], path: str) -> dict[str, int]:
    """Splits the mesh into one object per moving part, each with its origin at its pivot, and writes a GLB."""
    # Plain materials under the set names: the textures are attached by scripts/process-gun-m7.mjs.
    for index, name in enumerate(SETS):
        gun.data.materials[index].name = f"{name}_bake"
        gun.data.materials[index] = bpy.data.materials.new(name)
    exported = []
    for index, part in enumerate(PARTS):
        obj = gun.copy()
        obj.data = gun.data.copy()
        obj.name = part
        obj.data.name = part
        bpy.context.scene.collection.objects.link(obj)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        layer = bm.faces.layers.int["part"]
        bmesh.ops.delete(bm, geom=[face for face in bm.faces if face[layer] != index], context="FACES")
        origin = G(pivots[part])
        bmesh.ops.translate(bm, verts=bm.verts, vec=-origin)
        bm.to_mesh(obj.data)
        bm.free()
        obj.location = origin
        exported.append(obj)
    for obj in bpy.context.scene.objects:
        obj.select_set(obj in exported)
    bpy.context.view_layer.objects.active = exported[0]
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        # No tangents: the normal maps hold fine relief only, which the renderer orients well enough by itself.
        export_tangents=False,
        export_materials="EXPORT",
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )
    return {obj.name: len(obj.data.polygons) for obj in exported}
