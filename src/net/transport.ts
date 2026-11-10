/**
 * One peer connection with two data channels:
 * - `state`: unordered, never retransmitted. Positions and pings; a lost one is replaced by the next.
 * - `events`: ordered and reliable. Hits, deaths, shots, lobby and match messages.
 */
import type { SignalMessage } from './signaling';

/** How long to wait for candidate gathering before sending what there is (copy-and-paste codes only). */
const GATHER_TIMEOUT_MS = 4000;
/** Stop sending state when this much is already queued: the link is stalled and newer state is on its way. */
const STATE_BACKLOG_BYTES = 16_384;
/** Past this the reliable channel is not draining at all. */
const EVENT_BACKLOG_BYTES = 1_000_000;
const MAX_INCOMING_BYTES = 8192;

export interface PeerLinkHandlers {
  /** Both channels are open. */
  onOpen(): void;
  onState(data: ArrayBuffer): void;
  onEvent(data: string | ArrayBuffer): void;
  /** The connection ended or could not be made. Called once. */
  onClosed(): void;
  /** Something for the other side: pass it through the signaling in use. */
  onSignal(message: SignalMessage): void;
}

export interface PeerLinkOptions {
  readonly iceServers: RTCIceServer[];
  /** true: send candidates as they are found. false: wait and send one description that carries them. */
  readonly trickle: boolean;
}

export class PeerLink {
  private readonly connection: RTCPeerConnection;
  private readonly state: RTCDataChannel;
  private readonly events: RTCDataChannel;
  private opened = false;
  private closed = false;
  /** While false a failed connection attempt is not final: the other side may not have our answer yet. */
  private failFast = true;
  /** Candidates that arrived before the description they belong to. */
  private queued: RTCIceCandidateInit[] = [];
  private remoteSet = false;

  constructor(
    private readonly options: PeerLinkOptions,
    private readonly handlers: PeerLinkHandlers,
  ) {
    const connection = new RTCPeerConnection({ iceServers: options.iceServers });
    this.connection = connection;
    // Both sides create the same two channels by id, so neither waits for the other to announce them.
    this.state = connection.createDataChannel('state', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    this.events = connection.createDataChannel('events', { negotiated: true, id: 1, ordered: true });
    this.state.binaryType = 'arraybuffer';
    this.events.binaryType = 'arraybuffer';

    const maybeOpen = (): void => {
      if (this.opened || this.closed || this.state.readyState !== 'open' || this.events.readyState !== 'open') return;
      this.opened = true;
      handlers.onOpen();
    };
    this.state.addEventListener('open', maybeOpen);
    this.events.addEventListener('open', maybeOpen);
    this.state.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (data instanceof ArrayBuffer && data.byteLength <= MAX_INCOMING_BYTES) handlers.onState(data);
    });
    this.events.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === 'string' ? data.length <= MAX_INCOMING_BYTES : data instanceof ArrayBuffer && data.byteLength <= MAX_INCOMING_BYTES) {
        handlers.onEvent(data as string | ArrayBuffer);
      }
    });
    this.events.addEventListener('close', () => this.finish());
    connection.addEventListener('icecandidate', (event) => {
      if (!options.trickle || !event.candidate) return;
      handlers.onSignal({ type: 'candidate', candidate: event.candidate.toJSON() });
    });
    connection.addEventListener('connectionstatechange', () => {
      const state = connection.connectionState;
      if (state === 'closed' || (state === 'failed' && (this.failFast || this.opened))) this.finish();
    });
  }

  get open(): boolean {
    return this.opened && !this.closed;
  }

  /** Host: create the offer and hand it to signaling. */
  async makeOffer(): Promise<void> {
    await this.connection.setLocalDescription(await this.connection.createOffer());
    await this.sendLocalDescription('offer');
  }

  /** Guest: take the host's offer and answer it. */
  async acceptOffer(sdp: string, patient: boolean): Promise<void> {
    // A copy-and-paste answer can sit in a chat window for minutes before the host uses it.
    this.failFast = !patient;
    await this.connection.setRemoteDescription({ type: 'offer', sdp });
    await this.flushCandidates();
    await this.connection.setLocalDescription(await this.connection.createAnswer());
    await this.sendLocalDescription('answer');
  }

  /** Host: take the guest's answer. */
  async acceptAnswer(sdp: string): Promise<void> {
    await this.connection.setRemoteDescription({ type: 'answer', sdp });
    await this.flushCandidates();
  }

  async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteSet) {
      this.queued = [...this.queued, candidate].slice(-64);
      return;
    }
    try {
      await this.connection.addIceCandidate(candidate);
    } catch (error) {
      console.warn('A connection candidate was not usable', error);
    }
  }

  /** Send on the unreliable channel. Dropped silently when the link is not ready or is backed up. */
  sendState(data: ArrayBuffer): void {
    if (!this.open || this.state.readyState !== 'open' || this.state.bufferedAmount > STATE_BACKLOG_BYTES) return;
    try {
      this.state.send(data);
    } catch {
      // The channel closed between the check and the send; the close handler deals with it.
    }
  }

  /** Send on the reliable channel. Returns false when it could not be queued. */
  sendEvent(data: string | ArrayBuffer): boolean {
    if (!this.open || this.events.readyState !== 'open' || this.events.bufferedAmount > EVENT_BACKLOG_BYTES) return false;
    try {
      if (typeof data === 'string') this.events.send(data);
      else this.events.send(data);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.state.close();
      this.events.close();
      this.connection.close();
    } catch {
      // Already closed.
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.close();
    this.handlers.onClosed();
  }

  private async flushCandidates(): Promise<void> {
    this.remoteSet = true;
    const queued = this.queued;
    this.queued = [];
    for (const candidate of queued) await this.addCandidate(candidate);
  }

  private async sendLocalDescription(type: 'offer' | 'answer'): Promise<void> {
    if (!this.options.trickle) await this.gathered();
    const sdp = this.connection.localDescription?.sdp;
    if (!sdp || this.closed) return;
    this.handlers.onSignal({ type, sdp });
  }

  /** Resolves when candidate gathering is complete, or after a few seconds with whatever was found. */
  private gathered(): Promise<void> {
    const connection = this.connection;
    if (connection.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        connection.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = (): void => {
        if (connection.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, GATHER_TIMEOUT_MS);
      connection.addEventListener('icegatheringstatechange', check);
    });
  }
}
