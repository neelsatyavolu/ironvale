// Ported from src/audio/catalog.ts at commit cbe0add.
// Maps weapons, surfaces, reload stages and ambience beds to sound-id groups. Nothing throws for
// a missing id: lookups return an empty list and the engine skips the sound.

import IronvaleWorld

public enum WeaponActionStage: String, Sendable, CaseIterable {
    case magOut, magIn, boltBack, boltForward, boltLift, boltClose, shellInsert, beltOpen, beltClose
}

public enum CasingKind: String, Sendable, CaseIterable {
    case pistol, rifle, shotgun
}

/// The fields of a WeaponDef the audio reads.
public struct AudioWeapon: Sendable, Equatable {
    public var id: String
    public var weaponClass: String
    public var loudness: Double
    public var muzzleVelocity: Double

    public init(id: String, weaponClass: String, loudness: Double, muzzleVelocity: Double) {
        self.id = id
        self.weaponClass = weaponClass
        self.loudness = loudness
        self.muzzleVelocity = muzzleVelocity
    }
}

public final class Catalog {
    public static let rainBed = "snd-amb-rain"
    public static let rainRoofBed = "snd-amb-rain-roof"
    public static let interfacePrefix = "snd-ui-"
    static let perMapPrefixes = ["snd-amb-", "snd-loop-", "snd-oneshot-"]

    static let classWeapon: [String: String] = [
        "carbine": "m4a1", "rifle": "m24", "smg": "mp5", "shotgun": "m24", "sniper": "m24", "lmg": "m249", "pistol": "mp5",
    ]
    static let classHandlingWeapon: [String: String] = ["rifle": "m4a1"]
    static let stageAliases: [WeaponActionStage: [WeaponActionStage]] = [
        .magOut: [.beltOpen], .magIn: [.shellInsert], .boltBack: [.boltLift], .boltForward: [.boltClose],
        .boltLift: [.boltBack], .boltClose: [.boltForward], .shellInsert: [.magIn], .beltOpen: [.magOut], .beltClose: [.magIn],
    ]
    static let stageOwner: [WeaponActionStage: String] = [
        .magOut: "m4a1", .magIn: "m4a1", .boltBack: "m4a1", .boltForward: "m4a1", .boltLift: "m24",
        .boltClose: "m24", .shellInsert: "m24", .beltOpen: "m249", .beltClose: "m249",
    ]
    static func stepSurface(_ s: Surface) -> String {
        switch s {
        case .concrete, .plaster, .glass: "concrete"
        case .cobble: "cobble"
        case .asphalt: "asphalt"
        case .gravel: "gravel"
        case .dirt, .flesh: "dirt"
        case .grass, .foliage: "grass"
        case .sand: "sand"
        case .wood: "wood"
        case .metal: "metal"
        case .water: "water"
        }
    }
    static func impactSurface(_ s: Surface) -> String {
        switch s {
        case .concrete, .cobble, .asphalt, .plaster: "concrete"
        case .gravel, .dirt, .grass, .sand, .foliage: "dirt"
        case .wood: "wood"
        case .metal: "metal"
        case .glass: "glass"
        case .water: "water"
        case .flesh: "flesh"
        }
    }
    static let ricochet: Set<Surface> = [.concrete, .cobble, .asphalt, .metal]
    static let softGround: Set<Surface> = [.dirt, .grass, .sand, .foliage, .water]
    static let bedOneShots: [String: [String]] = [
        "snd-amb-harbor": ["snd-oneshot-gull", "snd-oneshot-gull", "snd-oneshot-creak", "snd-oneshot-clang"],
        "snd-amb-forest": ["snd-oneshot-branch"],
        "snd-amb-industrial": ["snd-oneshot-clang", "snd-oneshot-creak", "snd-oneshot-fence"],
    ]

    private var groups: [String: [String]] = [:]
    /// Known ids in manifest order (the web iterates a Set built from sorted ids).
    private let ordered: [String]
    private let known: Set<String>

    /// `ids`: every sound id in the asset manifest.
    public init(ids: [String]) {
        // JS sort of strings compares UTF-16 code units; the ids are ASCII, so byte order is the same.
        let sorted = ids.filter { $0.hasPrefix("snd-") }.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
        ordered = sorted
        known = Set(sorted)
        for id in sorted {
            groups[Catalog.groupOf(id), default: []].append(id)
        }
    }

    /// Strip a trailing `-<digits>`.
    static func groupOf(_ id: String) -> String {
        guard let dash = id.lastIndex(of: "-") else { return id }
        let tail = id[id.index(after: dash)...]
        return !tail.isEmpty && tail.allSatisfy({ $0.isASCII && $0.isNumber }) ? String(id[..<dash]) : id
    }

    public func has(_ id: String) -> Bool { known.contains(id) }

    public func takes(_ group: String) -> [String] { groups[group] ?? [] }

    public func weaponKey(_ weapon: AudioWeapon) -> String {
        groups["snd-\(weapon.id)-shot"] != nil ? weapon.id : (Catalog.classWeapon[weapon.weaponClass] ?? "undefined")
    }

    private func handlingKey(_ weapon: AudioWeapon) -> String {
        let key = weaponKey(weapon)
        return key == weapon.id ? key : (Catalog.classHandlingWeapon[weapon.weaponClass] ?? key)
    }

    public enum Layer: String { case shot, tail, dist, dry, mech }

    public func weaponGroup(_ weapon: AudioWeapon, _ layer: Layer) -> String {
        let key = layer == .dry || layer == .mech ? handlingKey(weapon) : weaponKey(weapon)
        return "snd-\(key)-\(layer.rawValue)"
    }

    public func actionGroup(_ weapon: AudioWeapon, _ stage: WeaponActionStage) -> String? {
        let key = handlingKey(weapon)
        let own = "snd-\(key)-\(stage.rawValue)"
        if groups[own] != nil { return own }
        for alias in Catalog.stageAliases[stage] ?? [] {
            let group = "snd-\(key)-\(alias.rawValue)"
            if groups[group] != nil { return group }
        }
        let shared = "snd-\(Catalog.stageOwner[stage]!)-\(stage.rawValue)"
        return groups[shared] != nil ? shared : nil
    }

    public func stepGroup(_ surface: Surface, running: Bool) -> String {
        let base = "snd-step-\(Catalog.stepSurface(surface))"
        let wanted = "\(base)-\(running ? "run" : "walk")"
        return groups[wanted] != nil ? wanted : "\(base)-walk"
    }

    public func impactGroup(_ surface: Surface) -> String { "snd-impact-\(Catalog.impactSurface(surface))" }

    public func ricochets(_ surface: Surface) -> Bool { Catalog.ricochet.contains(surface) }

    public func casingGroup(_ kind: CasingKind, _ surface: Surface) -> String {
        "snd-casing-\(kind.rawValue)-\(Catalog.softGround.contains(surface) ? "soft" : "hard")"
    }

    public func landGroup(_ surface: Surface) -> String {
        if surface == .wood { return "snd-land-wood" }
        if surface == .gravel { return "snd-land-gravel" }
        return Catalog.softGround.contains(surface) ? "snd-land-soft" : "snd-land-hard"
    }

    public func oneShotGroups(_ bedIds: [String]) -> [String] {
        bedIds.flatMap { Catalog.bedOneShots[$0] ?? [] }.filter { groups[$0] != nil }
    }

    public func bedIds(_ map: MapAudio) -> [String] {
        var ids = map.ambience.filter { $0.position == nil }.map(\.sound)
        if map.weather == "rain" && !ids.contains(Catalog.rainBed) { ids.append(Catalog.rainBed) }
        return ids
    }

    public func shared() -> [String] {
        ordered.filter { id in !Catalog.perMapPrefixes.contains { id.hasPrefix($0) } }
    }

    public func interfaceIds() -> [String] { ordered.filter { $0.hasPrefix(Catalog.interfacePrefix) } }

    /// Everything to preload for a map, in the web's order, without duplicates.
    public func required(_ map: MapAudio) -> [String] {
        let beds = bedIds(map)
        var ids = shared() + map.ambience.map(\.sound) + beds
        if beds.contains(Catalog.rainBed) { ids.append(Catalog.rainRoofBed) }
        ids += oneShotGroups(beds).flatMap { takes($0) }
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted && known.contains($0) }
    }
}

/// The audio-relevant part of a MapInstance.
public struct MapAudio: Sendable {
    public struct Layer: Sendable {
        public var sound: String
        public var volume: Double
        public var position: Vec3?
        public var radius: Double?
        public init(sound: String, volume: Double, position: Vec3? = nil, radius: Double? = nil) {
            self.sound = sound
            self.volume = volume
            self.position = position
            self.radius = radius
        }
    }

    public struct Interior: Sendable {
        public var min: Vec3
        public var max: Vec3
        public var reverb: ReverbPreset
        public init(min: Vec3, max: Vec3, reverb: ReverbPreset) {
            self.min = min
            self.max = max
            self.reverb = reverb
        }
    }

    public var reverb: ReverbPreset
    public var weather: String
    public var ambience: [Layer]
    public var interiors: [Interior]

    public init(reverb: ReverbPreset, weather: String, ambience: [Layer], interiors: [Interior]) {
        self.reverb = reverb
        self.weather = weather
        self.ambience = ambience
        self.interiors = interiors
    }
}
