// Lays out one HUD frame as the web's CSS does (src/ui/styles/{hud,reticle,scope,minimap,hud-extras,
// hud-grenade,hud-chat}.css at cbe0add): sizes in em of a base font that steps with the window height,
// corners kept inside a 2:1 frame. Pure: state + tracker + clocks in, a draw list out.
import Foundation
import simd

public struct HUDScene {
    /// What the frame drew, and the scene grade (CSS saturate() and the dead dim) for the pass before it.
    public var canvas: HUDCanvas
    public var saturation = 1.0
    public var dim = 0.0
    /// The minimap layout, when its raster should be bound.
    public var minimapVisible = false

    let c = HUDConstants.shared

    /// Base font size (`.iv-hud` font-size and its media queries).
    public static func em(width: Double, height: Double) -> Double {
        if width <= 720 { return 14 }
        if height >= 1500 { return 24 }
        if height >= 1200 { return 20 }
        if height >= 900 { return 18 }
        return 16
    }

    /// `--minimap-size` and its media queries.
    public static func minimapSize(height: Double) -> Double {
        if height <= 560 { return 120 }
        if height <= 760 { return 148 }
        if height >= 1200 { return 216 }
        return 180
    }

    public static func build(state: HUDState, tracker: HUDTracker, font: MSDFFont, layout: MinimapLayout?, wall: Double) -> HUDScene {
        tracker.step(state: state, wall: wall)
        var scene = HUDScene(canvas: HUDCanvas(font: font, pointScale: state.pointScale))
        guard state.visible else { return scene }
        scene.draw(state, tracker, layout, wall)
        return scene
    }

    private mutating func draw(_ s: HUDState, _ t: HUDTracker, _ layout: MinimapLayout?, _ wall: Double) {
        let em = Self.em(width: s.width, height: s.height)
        let safeWidth = min(s.width, 2 * s.height)
        let left = (s.width - safeWidth) / 2, right = left + safeWidth
        let health = min(100, max(0, s.health))
        let effects = HUDMath.healthEffects(health)
        saturation = effects.saturation
        dim = t.dim

        // Under everything: the vignette, then the scope mask.
        canvas.element = .vignette
        if t.vignette > 0.004 { canvas.fullscreen(.vignette, width: s.width, height: s.height, alpha: t.vignette) }
        if s.scopedIn && s.health > 0 { scope(s) }

        status(s, x: left + 1.5 * em, em: em)
        netBox(s, em: em)
        let mapSize = Self.minimapSize(height: s.height)
        minimapVisible = s.minimapSetting && layout != nil
        if minimapVisible, let layout { minimap(s, t, layout, x: right - 1.5 * em - mapSize, y: 1.5 * em, size: mapSize) }
        if s.chatEnabled { chat(s, x: left + 1.5 * em, em: em) }
        feed(s, t, right: right - 1.5 * em, top: 1.5 * em + (minimapVisible ? mapSize + em : 0), em: em, wall: wall)
        healthBlock(s, t, x: left + 1.5 * em, bottom: s.height - 1.5 * em, em: em)
        ammo(s, right: right - 1.5 * em, bottom: s.height - 1.5 * em, em: em)
        reticle(s, t, em: em, wall: wall)
        notes(s, t, em: em, wall: wall)
        extras(s, t, em: em, wall: wall)
        if s.perfVisible {
            canvas.element = .perf
            let size = 0.75 * em
            canvas.text(s.perfText, x: s.width / 2, baseline: canvas.baseline(top: 1.5 * em, face: .mono, size: size), face: .mono, size: size,
                        color: HUDPalette.dim, align: .center)
        }
        canvas.element = .grade
    }

    // MARK: Corners

    /// One `.iv-fig`: label over value. Returns its width.
    @discardableResult
    private mutating func figure(_ label: String, _ value: String, x: Double, top: Double, em: Double, valueColor: HUDColor = HUDPalette.ink,
                                 measureOnly: Bool = false) -> Double {
        let labelSize = 0.75 * em, valueSize = 1.75 * em
        let width = max(canvas.measure(label, face: .monoMedium, size: labelSize),
                        canvas.measure(value, face: .mono, size: valueSize, tracking: -0.02))
        if measureOnly { return width }
        canvas.text(label, x: x, baseline: canvas.baseline(top: top, face: .monoMedium, size: labelSize), face: .monoMedium, size: labelSize,
                    color: HUDPalette.dim)
        canvas.text(value, x: x, baseline: canvas.baseline(top: top + labelSize + 0.375 * em, face: .mono, size: valueSize), face: .mono,
                    size: valueSize, color: valueColor, tracking: -0.02)
        return width
    }

    private mutating func status(_ s: HUDState, x: Double, em: Double) {
        canvas.element = .status
        let duel = s.rules == .duel
        var figures: [(String, String)] = []
        if !duel { figures.append(("Enemies", "\(s.enemiesRemaining)")) }
        if s.wave > 0 { figures.append(("Wave", "\(s.wave)")) }
        if s.rules == .skirmish || (s.rules == .survival && s.net == nil) { figures.append(("Lives", "\(s.livesRemaining)")) }
        if duel, let net = s.net {
            figures += [(net.localName, "\(s.kills)"), (net.peerName, "\(net.peerKills)"), ("First to", "\(net.killTarget)")]
        }
        var pen = x
        for (label, value) in figures { pen += figure(label, value, x: pen, top: 1.5 * em, em: em) + 2 * em }
    }

    private mutating func netBox(_ s: HUDState, em: Double) {
        guard let net = s.net else { return }
        canvas.element = .net
        var top = 4.5 * em
        let cx = s.width / 2
        if net.countdown > 0 {
            let label = 0.75 * em, count = 3 * em
            canvas.text("Starting in", x: cx, baseline: canvas.baseline(top: top, face: .monoMedium, size: label), face: .monoMedium, size: label,
                        color: HUDPalette.dim, align: .center)
            top += label + 0.5 * em
            canvas.text("\(net.countdown)", x: cx, baseline: canvas.baseline(top: top, face: .mono, size: count), face: .mono, size: count,
                        color: HUDPalette.ink, align: .center, tracking: -0.04)
            top += count + em
        }
        if !net.notice.isEmpty {
            let size = 0.8125 * em
            canvas.text(net.notice, x: cx, baseline: canvas.baseline(top: top, face: .mono, size: size, lineHeight: 1.4), face: .mono, size: size,
                        color: HUDPalette.ink, align: .center)
        }
    }

    private mutating func healthBlock(_ s: HUDState, _ t: HUDTracker, x: Double, bottom: Double, em: Double) {
        canvas.element = .health
        let clamped = min(100, max(0, s.health))
        let low = clamped < c.lowHealth
        let barTop = bottom - 2
        let top = barTop - 0.125 * em - 0.375 * em - 1.75 * em - 0.375 * em - 0.75 * em
        // `String(clamped)`: health is whole in play; a fraction prints as JS would.
        let value = clamped == clamped.rounded() ? "\(Int(clamped))" : "\(clamped)"
        figure("Health", value, x: x, top: top, em: em, valueColor: low ? HUDPalette.warn : HUDPalette.ink)
        let barWidth = 7.5 * em
        canvas.outline(x, barTop, barWidth, 2, width: 1, HUDColor(9 / 255, 9 / 255, 8 / 255, 0.2))
        canvas.rect(x, barTop, barWidth, 2, HUDColor(9 / 255, 9 / 255, 8 / 255, 0.45))
        canvas.rect(x, barTop, barWidth * t.healthFill, 2, low ? HUDPalette.warn : HUDPalette.ink)
    }

    private mutating func ammo(_ s: HUDState, right: Double, bottom: Double, em: Double) {
        // The grenade line, bottom up: its own em is 0.75 of the HUD's.
        canvas.element = .grenade
        let g = 0.75 * em
        let out = s.grenades == 0
        let base = out ? HUDColor(242 / 255, 240 / 255, 234 / 255, 0.45) : HUDPalette.dim
        let countSize = 1.5 * g
        let rowTop = bottom - countSize
        let baseline = canvas.baseline(top: rowTop, face: .mono, size: countSize)
        let hint = HUDMath.grenadeHint(count: s.grenades, aiming: s.grenadeAiming, key: s.grenadeKey)
        var pen = right
        let hintWidth = max(4.5 * g, canvas.measure(hint, face: .monoMedium, size: g))
        canvas.text(hint, x: pen, baseline: baseline, face: .monoMedium, size: g, color: s.grenadeAiming ? HUDPalette.accent : base, align: .right)
        pen -= hintWidth + 0.75 * g
        pen -= canvas.text("\(s.grenades)", x: pen, baseline: baseline, face: .mono, size: countSize, color: out ? base : HUDPalette.ink, align: .right)
        pen -= 0.75 * g
        pen -= canvas.text("Grenade", x: pen, baseline: baseline, face: .monoMedium, size: g, color: base, align: .right)
        let ruleY = rowTop - 0.625 * g - 1
        canvas.rect(pen, ruleY, right - pen, 1, HUDColor(242 / 255, 240 / 255, 234 / 255, 0.28))

        canvas.element = .ammo
        let weaponSize = 0.75 * em
        let weaponTop = ruleY - 0.25 * g - 0.5 * em - weaponSize
        let mode = c.fireModes[s.fireMode]
        let weapon = mode.map { "\(s.weaponName) · \($0)" } ?? s.weaponName
        canvas.text(weapon, x: right, baseline: canvas.baseline(top: weaponTop, face: .monoMedium, size: weaponSize), face: .monoMedium,
                    size: weaponSize, color: HUDPalette.dim, align: .right)
        let magSize = 3 * em, small = 1.125 * em
        let countTop = weaponTop - 0.5 * em - magSize
        let countBase = canvas.baseline(top: countTop, face: .mono, size: magSize)
        pen = right
        pen -= canvas.text("\(s.reserve)", x: pen, baseline: countBase, face: .mono, size: small, color: HUDPalette.dim, align: .right)
        pen -= 0.5 * em
        pen -= canvas.text("/", x: pen, baseline: countBase, face: .mono, size: small, color: HUDPalette.dim, align: .right) - 0.2 * small
        pen -= 0.5 * em
        canvas.text("\(s.magazine)", x: pen, baseline: countBase, face: .mono, size: magSize, color: s.magazine == 0 ? HUDPalette.warn : HUDPalette.ink,
                    align: .right, tracking: -0.04)
    }

    // MARK: Kill feed and chat

    private mutating func feed(_ s: HUDState, _ t: HUDTracker, right: Double, top: Double, em: Double, wall: Double) {
        canvas.element = .feed
        let size = 0.8125 * em
        let rows = HUDMath.trimKillFeed(t.feed, now: s.now, maxAge: c.feedAge, maxRows: c.feedRows)
        var y = top
        let who = { (name: String) in name == s.localName ? "You" : name }
        for entry in rows {
            let progress = min(1, (wall - t.feedStart(HUDMath.feedKey(entry), wall: wall)) / 0.2)
            let eased = Easing.ease(progress)
            let alpha = eased
            let dy = -6 * (1 - eased)
            let base = canvas.baseline(top: y + dy, face: .monoMedium, size: size)
            var pen = right
            pen -= canvas.text(who(entry.victim), x: pen, baseline: base, face: .monoMedium, size: size, color: HUDPalette.ink.alpha(alpha), align: .right)
            pen -= 0.75 * size
            let weapon = entry.headshot ? "\(entry.weapon), headshot" : entry.weapon
            pen -= canvas.text(weapon, x: pen, baseline: base, face: .mono, size: size, color: HUDPalette.ink.alpha(alpha), align: .right)
            pen -= 0.75 * size
            canvas.text(who(entry.killer), x: pen, baseline: base, face: .monoMedium, size: size, color: HUDPalette.ink.alpha(alpha), align: .right)
            y += size + 0.5 * size
        }
    }

    private mutating func chat(_ s: HUDState, x: Double, em: Double) {
        canvas.element = .chat
        let size = 0.875 * em
        let width = min(26 * size, 0.4 * s.width)
        let nameSize = 0.8125 * size
        let bottom = s.height - 7.5 * size
        // Bottom up: the hint (or the open box's place, which the SwiftUI field covers), then the log.
        var y = bottom
        let hintSize = 0.75 * size
        if !s.chatInputOpen {
            canvas.text("T  Chat", x: x, baseline: canvas.baseline(top: y - hintSize, face: .mono, size: hintSize), face: .mono, size: hintSize,
                        color: HUDPalette.dim)
            y -= hintSize + 0.5 * size
        } else {
            y -= size * 2 + 2 + 0.5 * size
        }
        let lineHeight = 1.35 * size
        let shadow = HUDCanvas.Shadow(layers: [(1.0, 1, HUDColor(9 / 255, 9 / 255, 8 / 255, 0.9))])
        for line in s.chatLines.suffix(c.chatLines).reversed() {
            let nameWidth = canvas.measure(line.name, face: .mono, size: nameSize) + 0.625 * size
            let wrapped = Self.wrap(line.text, first: width - nameWidth, rest: width, measure: { canvas.measure($0, face: .sans, size: size) })
            y -= lineHeight * Double(wrapped.count)
            var top = y
            let firstBase = canvas.baseline(top: top, face: .sans, size: size, lineHeight: 1.35)
            canvas.text(line.name, x: x, baseline: firstBase, face: .mono, size: nameSize, color: line.mine ? HUDPalette.dim : HUDPalette.accent,
                        shadow: shadow)
            for (index, text) in wrapped.enumerated() {
                canvas.text(text, x: index == 0 ? x + nameWidth : x, baseline: canvas.baseline(top: top, face: .sans, size: size, lineHeight: 1.35),
                            face: .sans, size: size, color: HUDPalette.ink, shadow: shadow)
                top += lineHeight
            }
            y -= 0.25 * size
        }
    }

    /// Greedy word wrap; words longer than a line break anywhere (`overflow-wrap: anywhere`).
    static func wrap(_ text: String, first: Double, rest: Double, measure: (String) -> Double) -> [String] {
        var lines: [String] = []
        var current = ""
        func limit() -> Double { lines.isEmpty ? first : rest }
        for word in text.split(separator: " ", omittingEmptySubsequences: false).map(String.init) {
            let candidate = current.isEmpty ? word : current + " " + word
            if measure(candidate) <= limit() || current.isEmpty && measure(word) <= limit() {
                current = candidate
                continue
            }
            if !current.isEmpty { lines.append(current); current = "" }
            var piece = ""
            for ch in word {
                if measure(piece + String(ch)) > limit(), !piece.isEmpty { lines.append(piece); piece = "" }
                piece.append(ch)
            }
            current = piece
        }
        if !current.isEmpty || lines.isEmpty { lines.append(current) }
        return lines
    }

    // MARK: Centre

    private mutating func reticle(_ s: HUDState, _ t: HUDTracker, em: Double, wall: Double) {
        let cx = s.width / 2, cy = s.height / 2
        // Damage arcs: a 44 degree arc of a 22em ring (radius 48 of a 100 box), 3 px.
        canvas.element = .damageArcs
        let radius = 0.48 * 22 * em
        let half = atan2(18.0, 44.5)
        for arc in t.arcs where arc.until > wall {
            let progress = (wall - arc.start) / c.arcSeconds
            let alpha = Easing.keyframes([(0, 1), (0.35, 1), (1, 0)], progress)
            canvas.arc(cx: cx, cy: cy, radius: radius, width: 3, from: arc.shown - half, to: arc.shown + half, HUDPalette.danger.alpha(alpha))
        }
        // Crosshair: four 2x6 ticks, open centre, 1 px dark outline.
        canvas.element = .crosshair
        if t.cross > 0.004 {
            let ticks: [(Double, Double, Double, Double)] = [(-1, -11, 2, 6), (-1, 5, 2, 6), (-11, -1, 6, 2), (5, -1, 6, 2)]
            let edge = HUDColor(9 / 255, 9 / 255, 8 / 255, 0.4).alpha(t.cross)
            for (x, y, w, h) in ticks { canvas.outline(cx + x, cy + y, w, h, width: 1, edge) }
            for (x, y, w, h) in ticks { canvas.rect(cx + x, cy + y, w, h, HUDPalette.ink.alpha(t.cross)) }
        }
        // Hit marker: four strokes of an X, 240 ms (kill 460 ms, red, thicker, grows as it fades).
        canvas.element = .hitMarker
        if let marker = t.marker {
            let duration = marker.fatal ? c.killSeconds : c.hitSeconds
            let progress = (wall - marker.start) / duration
            if progress < 1 {
                let p = Easing.ease(max(0, progress))
                let alpha = Easing.keyframes([(0, 1), (0.3, 1), (1, 0)], p)
                let scale = Easing.keyframes([(0, 0.82), (0.3, 1), (1, marker.fatal ? 1.12 : 1)], p)
                let width = marker.fatal ? 2.25 : 1.75
                let color = marker.fatal ? HUDPalette.danger : HUDPalette.ink
                for (sx, sy) in [(-1.0, -1.0), (1, -1), (-1, 1), (1, 1)] {
                    let a = (cx + sx * 11 * scale, cy + sy * 11 * scale), b = (cx + sx * 5 * scale, cy + sy * 5 * scale)
                    canvas.segment(a.0, a.1, b.0, b.1, width: width + 2, HUDColor(9 / 255, 9 / 255, 8 / 255, 0.35).alpha(alpha), square: true)
                    canvas.segment(a.0, a.1, b.0, b.1, width: width, color.alpha(alpha), square: true)
                }
            }
        }
    }

    private mutating func scope(_ s: HUDState) {
        canvas.element = .scope
        let cx = s.width / 2, cy = s.height / 2
        let lens = 0.46 * min(s.width, s.height)
        canvas.fullscreen(.scope, width: s.width, height: s.height, alpha: 1, p0: SIMD4(Float(cx), Float(cy), Float(lens), 0))
        let ink = HUDColor(hex: 0x040404)
        let px = 1 / s.pointScale
        // Fine wire across the lens, snapped to whole pixels; the post (3 px) beyond POST_START, below and to the sides.
        canvas.rect(cx - lens, (cy * s.pointScale).rounded(.down) / s.pointScale, lens * 2, px, ink)
        canvas.rect((cx * s.pointScale).rounded(.down) / s.pointScale, cy - lens, px, lens * 2, ink)
        let post = c.scopePostStart * lens, thick = 3 * px
        canvas.rect(cx - lens, cy - thick / 2, lens - post, thick, ink)
        canvas.rect(cx + post, cy - thick / 2, lens - post, thick, ink)
        canvas.rect(cx - thick / 2, cy + post, thick, lens - post, ink)
        let dot = c.scopeDotRadius / 100 * lens
        for d in c.scopeDots {
            for (x, y) in [(d, 0.0), (-d, 0), (0, d), (0, -d)] { canvas.disc(cx: cx + x * lens, cy: cy + y * lens, radius: dot, ink) }
        }
    }

    private mutating func notes(_ s: HUDState, _ t: HUDTracker, em: Double, wall: Double) {
        let cx = s.width / 2
        canvas.element = .reload
        if t.reload > 0.004 {
            let size = 0.75 * em
            canvas.text("Reloading", x: cx, baseline: canvas.baseline(top: s.height / 2 + 3 * em, face: .monoMedium, size: size), face: .monoMedium,
                        size: size, color: HUDPalette.ink.alpha(t.reload), align: .center)
        }
        canvas.element = .toast
        if let toast = t.toast, wall - toast.start < c.toastSeconds, s.health > 0 {
            let alpha = Easing.keyframes([(0, 1), (0.7, 1), (1, 0)], (wall - toast.start) / c.toastSeconds)
            let nameSize = 0.875 * em, classSize = 0.75 * em
            let gap = 0.75 * em
            let nameWidth = canvas.measure(toast.name, face: .monoMedium, size: nameSize)
            let classWidth = canvas.measure(toast.weaponClass, face: .mono, size: classSize)
            let x = cx - (nameWidth + gap + classWidth) / 2
            let base = canvas.baseline(top: s.height * 0.78 - nameSize, face: .monoMedium, size: nameSize)
            canvas.text(toast.name, x: x, baseline: base, face: .monoMedium, size: nameSize, color: HUDPalette.ink.alpha(alpha))
            canvas.text(toast.weaponClass, x: x + nameWidth + gap, baseline: base, face: .mono, size: classSize, color: HUDPalette.dim.alpha(alpha))
        }
        canvas.element = .death
        if t.dead {
            let alpha = Easing.ease(min(1, (wall - t.deadSince) / 0.2))
            var top = s.height * 0.36
            let title = 2.5 * em, small = 0.8125 * em
            canvas.text("You were hit", x: cx, baseline: canvas.baseline(top: top, face: .serif, size: title, lineHeight: 1.1), face: .serif, size: title,
                        color: HUDPalette.ink.alpha(alpha), align: .center, tracking: -0.01)
            top += title * 1.1 + 0.75 * em
            if !t.deathCause.isEmpty {
                canvas.text(t.deathCause, x: cx, baseline: canvas.baseline(top: top, face: .mono, size: small, lineHeight: 1.4), face: .mono, size: small,
                            color: HUDPalette.dim.alpha(alpha), align: .center)
                top += small * 1.4
            }
            top += 0.75 * em
            let next = Self.deathNext(s, diedAt: t.diedAt, delay: c.respawnSeconds)
            canvas.text(next, x: cx, baseline: canvas.baseline(top: top, face: .mono, size: small, lineHeight: 1.4), face: .mono, size: small,
                        color: HUDPalette.ink.alpha(alpha), align: .center)
        }
    }

    /// The death panel's last line (`update` in hud.ts).
    public static func deathNext(_ s: HUDState, diedAt: Double, delay: Double) -> String {
        let seconds = HUDMath.respawnCountdown(diedAt: diedAt, now: s.now, delay: delay)
        if s.rules == .duel { return "Back in \(seconds)" }
        let left = s.livesRemaining
        if left == 0 {
            let partnerFighting = s.coop && s.net?.peerConnected == true
            return s.rules == .skirmish ? "No lives left" : partnerFighting ? "Back when the next wave starts" : ""
        }
        return "\(left == 1 ? "1 life" : "\(left) lives") left · back in \(seconds)"
    }

    private mutating func extras(_ s: HUDState, _ t: HUDTracker, em: Double, wall: Double) {
        canvas.element = .killNote
        if let note = t.killNote, wall - note.start < c.killNoteSeconds {
            let p = Easing.easeOut((wall - note.start) / c.killNoteSeconds)
            let alpha = Easing.keyframes([(0, 0), (0.1, 1), (0.75, 1), (1, 0)], p)
            let dy = Easing.keyframes([(0, 6), (0.1, 0), (1, 0)], p)
            let size = 1.124 * em
            let shadow = HUDCanvas.Shadow(layers: [(1.5, 0, HUDPalette.shade)])
            canvas.text(note.text, x: s.width / 2, baseline: canvas.baseline(top: s.height / 2 + 4 * em + dy, face: .monoMedium, size: size),
                        face: .monoMedium, size: size, color: HUDPalette.ink.alpha(alpha), align: .center, shadow: shadow)
        }
        canvas.element = .enemyBars
        for bar in s.enemyBars.prefix(c.barPool) {
            let x = bar.x - 22, y = bar.y - 3
            canvas.rect(x, y, 44, 3, HUDColor(9 / 255, 9 / 255, 8 / 255, 0.6))
            canvas.rect(x, y, 44 * max(0, min(1, bar.health / 100)), 3, HUDColor(hex: 0xF2F0EA))
        }
    }

    // MARK: Minimap

    private mutating func minimap(_ s: HUDState, _ t: HUDTracker, _ layout: MinimapLayout, x: Double, y: Double, size: Double) {
        canvas.element = .minimap
        let cx = x + size / 2, cy = y + size / 2
        canvas.disc(cx: cx, cy: cy, radius: size / 2, HUDColor(14 / 255, 14 / 255, 13 / 255, 0.6))
        // Border on top of the background: 1px rgba(242,240,234,.32), inside the box.
        canvas.ring(cx: cx, cy: cy, radius: size / 2 - 0.5, width: 1, HUDColor(242 / 255, 240 / 255, 234 / 255, 0.32))
        let half = size / 2 - 1
        let scale = half / c.minimapRange
        let limit = half - c.minimapInset
        let p = s.position, yaw = s.yaw
        // Screen point -> texture: undo the turn and the scale, then place the layout.
        let cosY = cos(yaw), sinY = sin(yaw)
        let spanX = Double(layout.nx) * layout.cell, spanZ = Double(layout.nz) * layout.cell
        let ux = SIMD2(cosY / scale / spanX, sinY / scale / spanX)
        let vz = SIMD2(-sinY / scale / spanZ, cosY / scale / spanZ)
        let u0 = (p.x - layout.originX) / spanX - ux.x * cx - ux.y * cy
        let v0 = (p.z - layout.originZ) / spanZ - vz.x * cx - vz.y * cy
        canvas.minimap(cx: cx, cy: cy, radius: half, toTexture: simd_double3x2(SIMD2(ux.x, vz.x), SIMD2(ux.y, vz.y), SIMD2(u0, v0)), alpha: 1)

        let ink = HUDColor(css: c.minimapInk), edge = HUDColor(css: c.minimapEdge)
        let spread = HUDMath.horizontalHalfFov(verticalDegrees: s.fovDegrees, aspect: s.aspect)
        canvas.arc(cx: cx, cy: cy, radius: half / 2, width: half, from: -spread, to: spread, HUDColor(css: c.minimapCone))

        func dot(_ x: Double, _ y: Double, _ color: HUDColor, hollow: Bool, alpha: Double) {
            if hollow {
                canvas.ring(cx: cx + x, cy: cy + y, radius: c.minimapDot - 0.75, width: 3.5, edge.alpha(alpha))
                canvas.ring(cx: cx + x, cy: cy + y, radius: c.minimapDot - 0.75, width: 1.5, color.alpha(alpha))
            } else {
                canvas.disc(cx: cx + x, cy: cy + y, radius: c.minimapDot, color.alpha(alpha))
                canvas.ring(cx: cx + x, cy: cy + y, radius: c.minimapDot, width: 1, edge.alpha(alpha))
            }
        }
        func tick(_ x: Double, _ y: Double, _ color: HUDColor, alpha: Double) {
            let inner = (limit - c.minimapTick) / limit
            canvas.segment(cx + x * inner, cy + y * inner, cx + x, cy + y, width: 4.5, edge.alpha(alpha))
            canvas.segment(cx + x * inner, cy + y * inner, cx + x, cy + y, width: 2.5, color.alpha(alpha))
        }
        func ripple(_ x: Double, _ y: Double, age: Double, alpha: Double) {
            let phase = fmod(age, c.rippleSeconds) / c.rippleSeconds
            canvas.ring(cx: cx + x, cy: cy + y, radius: c.minimapDot + 1 + phase * c.rippleGrowth, width: 1.5, ink.alpha(alpha * (1 - phase)))
        }
        func mark(_ at: SIMD3<Double>, _ color: HUDColor, alpha: Double) -> HUDMath.MapPoint {
            let point = HUDMath.toMap(dx: at.x - p.x, dz: at.z - p.z, yaw: yaw, scale: scale, limit: limit)
            if point.outside { tick(point.x, point.y, color, alpha: alpha) } else {
                dot(point.x, point.y, color, hollow: abs(at.y - p.y) > c.floorGap, alpha: alpha)
            }
            return point
        }

        for enemy in s.enemies {
            let shot = t.shots[enemy.id]
            let age = HUDMath.shotAge(firedAt: shot?.time, now: s.now)
            let fresh = age < c.shotSeconds
            let reveal = s.duel ? HUDMath.revealAge(now: s.now, every: c.revealEvery, hold: c.revealSeconds) : .infinity
            if reveal < c.revealSeconds {
                let alpha = min(1, 2 * (1 - reveal / c.revealSeconds))
                let point = mark(enemy.position, ink, alpha: alpha)
                if !point.outside { ripple(point.x, point.y, age: reveal, alpha: alpha) }
                continue
            }
            var point: HUDMath.MapPoint
            var alpha = 1.0
            if s.duel {
                guard fresh, let shot else { continue }
                alpha = 1 - age / c.shotSeconds
                point = mark(shot.position, ink, alpha: alpha)
            } else {
                point = mark(enemy.position, ink, alpha: 1)
            }
            if fresh && !point.outside { ripple(point.x, point.y, age: age, alpha: alpha) }
        }
        if let partner = s.partner { _ = mark(partner.position, HUDColor(css: c.minimapPartner), alpha: 1) }

        // The player: an arrowhead at the centre, pointing up (two triangles of the concave outline).
        let a = SIMD2(cx, cy - 6), b = SIMD2(cx + 4.5, cy + 4.5), m = SIMD2(cx, cy + 2), d = SIMD2(cx - 4.5, cy + 4.5)
        canvas.triangle(a, b, m, outset: 0.5, edge)
        canvas.triangle(a, m, d, outset: 0.5, edge)
        canvas.triangle(a, b, m, ink)
        canvas.triangle(a, m, d, ink)
    }
}
