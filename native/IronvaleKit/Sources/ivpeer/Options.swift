// Command line of the headless native peer (PLAN.md 5.4 layer 3).
import Foundation
import IronvaleNet

struct PeerOptions {
    var role: PeerRole = .host
    var method: SignalMethod = .room
    var signal: String?
    var origin = RelayDefaults.origin
    var name = "Native"
    /// Where this peer writes the code to pass on: room code, invite or reply.
    var codeOut: String?
    /// Where this peer waits for the code it is given: room code or invite (guest), reply (host).
    var codeIn: String?
    var log: String?
    var scenario: String?
    var relayOnly = false
    /// Negative scenarios: succeed only when the session fails with this error.
    var expectError: NetFailure?
    var timeoutSeconds: Double = 90
    var iceServers: String?

    static let usage = """
    usage: ivpeer --role host|guest --method room|manual [--signal URL] [--origin ORIGIN]
                  [--code-out FILE] [--code-in FILE] [--log FILE] [--scenario FILE] [--name NAME]
                  [--relay-only] [--ice-servers JSON] [--expect-error CODE] [--timeout SECONDS]
    Connects to one peer through the relay (room) or pasted codes (manual), runs the lobby and the
    scripted match in --scenario, and logs every frame as JSON lines. Exit 0 when the script
    completed with no rejected message (or the expected error happened).
    """

    static func parse(_ arguments: [String]) throws -> PeerOptions {
        var options = PeerOptions()
        var rest = arguments[...]
        func value(_ flag: String) throws -> String {
            guard let next = rest.popFirst() else { throw OptionError("\(flag) needs a value") }
            return next
        }
        while let flag = rest.popFirst() {
            switch flag {
            case "--role":
                guard let role = PeerRole(rawValue: try value(flag)) else { throw OptionError("--role is host or guest") }
                options.role = role
            case "--method":
                guard let method = SignalMethod(rawValue: try value(flag)) else { throw OptionError("--method is room or manual") }
                options.method = method
            case "--signal": options.signal = try value(flag)
            case "--origin": options.origin = try value(flag)
            case "--name": options.name = try value(flag)
            case "--code-out": options.codeOut = try value(flag)
            case "--code-in": options.codeIn = try value(flag)
            case "--log": options.log = try value(flag)
            case "--scenario": options.scenario = try value(flag)
            case "--relay-only": options.relayOnly = true
            case "--ice-servers": options.iceServers = try value(flag)
            case "--expect-error":
                let code = try value(flag)
                guard let error = NetFailure(rawValue: code) else { throw OptionError("unknown error code \(code)") }
                options.expectError = error
            case "--timeout":
                guard let seconds = Double(try value(flag)), seconds > 0 else { throw OptionError("--timeout takes seconds") }
                options.timeoutSeconds = seconds
            case "--help", "-h":
                print(usage)
                exit(0)
            default:
                throw OptionError("unknown argument \(flag)")
            }
        }
        if options.method == .room, options.signal == nil { throw OptionError("--method room needs --signal") }
        return options
    }
}

struct OptionError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
