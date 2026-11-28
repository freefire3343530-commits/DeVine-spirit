// FILE PATH: lib/tonAddr.js
// TON wallet address helper (pure JS, no dependency).
// WHY: the SAME wallet can be written two ways: EQ... (bounceable) and UQ... (non-bounceable). Both are valid and both pass the old
// regex, but as strings they differ, so "one wallet = one account" (the unique index + the duplicate check) could be beaten by writing
// the same wallet once as EQ and once as UQ. Here every address is checked (length + CRC16) and turned into ONE canonical form (UQ...).
const crc16 = (buf) => {
  let crc = 0;
  for (const b of buf) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
};

// -> { hash: Buffer(32) } for a valid mainnet basechain address in friendly form, otherwise null
export function parseTonAddress(input) {
  const s = String(input ?? '').trim();
  if (!/^[A-Za-z0-9_-]{48}$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64url');
  if (buf.length !== 36) return null;
  const crc = crc16(buf.subarray(0, 34));
  if (buf[34] !== (crc >> 8) || buf[35] !== (crc & 255)) return null;   // wrong checksum = typo / not a real address
  const flag = buf[0];
  if (flag & 0x80) return null;                                           // testnet-only address
  if ((flag & ~0x40) !== 0x11) return null;                               // 0x11 bounceable (EQ) / 0x51 non-bounceable (UQ)
  if (buf[1] !== 0) return null;                                          // basechain (workchain 0) only
  return { hash: buf.subarray(2, 34) };
}

const friendly = (flag, hash) => {
  const body = Buffer.concat([Buffer.from([flag, 0]), hash]);
  const c = crc16(body);
  return Buffer.concat([body, Buffer.from([c >> 8, c & 255])]).toString('base64url');
};

// the ONE form we store for new wallets (UQ..., what Tonkeeper shows)
export function canonicalTonAddress(input) {
  const p = parseTonAddress(input);
  return p ? friendly(0x51, p.hash) : null;
}
// every spelling of the same wallet (used to search the database): [UQ..., EQ...]. Empty array when the input is not a valid address.
export function tonAddressVariants(input) {
  const p = parseTonAddress(input);
  return p ? [friendly(0x51, p.hash), friendly(0x11, p.hash)] : [];
}
