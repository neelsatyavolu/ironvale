/** Constants and small types shared by the binary messages (`protocol.ts`) and the JSON events (`events.ts`). */

export const PROTOCOL_VERSION = 2;
/** Ids on the wire: the two players, then the host's bots. */
export const WIRE_HOST = 0;
export const WIRE_GUEST = 1;
export const WIRE_BOT_BASE = 2;
export const MAX_WIRE_ID = 0xffff;
export const MAX_EVENT_CHARS = 2048;
export const MAX_PELLETS = 12;
export const MAX_BOTS_PER_SNAPSHOT = 48;
/** No map is this large; a position beyond it is a broken or hostile packet. */
export const MAX_COORDINATE = 5000;
export const MAX_TIME_MS = 1e12;


export type Vec3 = readonly [number, number, number];
