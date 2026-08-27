// Minimal bech32 encoder (BIP-173) just for turning a 32-byte hex pubkey into
// an `npub…` (NIP-19). Self-contained so the bridge needs no extra dependency.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i] as number;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    high.push(hrp.charCodeAt(i) >> 5);
    low.push(hrp.charCodeAt(i) & 31);
  }
  return [...high, 0, ...low];
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((mod >> (5 * (5 - i))) & 31);
  }
  return checksum;
}

function convertBits(
  bytes: number[],
  from: number,
  to: number,
  pad: boolean,
): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of bytes) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      result.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) result.push((acc << (to - bits)) & maxv);
  return result;
}

/** Encode a 32-byte hex public key as an `npub1…` string. */
export function npubEncode(pubkeyHex: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < pubkeyHex.length; i += 2) {
    bytes.push(parseInt(pubkeyHex.slice(i, i + 2), 16));
  }
  const data = convertBits(bytes, 8, 5, true);
  const combined = [...data, ...createChecksum("npub", data)];
  return `npub1${combined.map((d) => CHARSET[d] as string).join("")}`;
}
