// Headless native net peer for interop tests (M5). M0: links the headless modules only.
import IronvaleAI
import IronvaleMapData
import IronvaleNet
import IronvaleSim
import IronvaleTransportWebRTC

let linked = [
    IronvaleNetModule.name, IronvaleTransportWebRTCModule.name,
    IronvaleSimModule.name, IronvaleAIModule.name, IronvaleMapDataModule.name,
]
print("ivpeer (M0 stub): linked \(linked.joined(separator: ", "))")
