/** Room codes: six characters that are easy to read aloud (no I, L, O, 0 or 1). */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

function secureRandom(): number {
  const word = new Uint32Array(1);
  crypto.getRandomValues(word);
  return (word[0] ?? 0) / 4294967296;
}

export function makeRoomCode(random: () => number = secureRandom): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)] ?? 'A';
  return code;
}

/** Upper-case what was typed and drop spaces and dashes. */
export function normalizeRoomCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const character of code) if (!ROOM_ALPHABET.includes(character)) return false;
  return true;
}

/** The query parameter an invite link carries the room code in. */
export const JOIN_PARAM = 'join';

/** The room code in what a guest typed or pasted: a bare code, or a whole invite link. */
export function roomCodeFrom(text: string): string {
  const linked = /[?&#]join=([A-Za-z0-9-]+)/.exec(text);
  return normalizeRoomCode(linked?.[1] ?? text);
}

/** The link a host sends: this page's address with the room code attached. */
export function inviteLink(code: string, page: string): string {
  const url = new URL(page);
  url.search = '';
  url.hash = '';
  url.searchParams.set(JOIN_PARAM, code);
  return url.toString();
}
