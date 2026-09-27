// utils/solana.js
export const DEALER_PROGRAM   = 'DEALERKFspSo5RoXNnKAhRPhTcvJeqeEgAgZsNSjCx5E';
export const PROGRAM_STATE    = 'DEALVwKJrYswMvZAwPP5DpaN7epa6VXn16ondftGY1cB';
export const ROOM_ACCOUNT     = '7b1VfRjNoCn7gPEQ7HFAg8wtjaLkrVrZTQNvkEdmrwsj';
export const VAULT_ACCOUNT    = 'FQpAdBocBoxQpZh5P5S8fFuUbVDAAPgoqXvC3NJYReFL';
export const FEE_VAULT        = 'i821bbVqQguuDLQp72gNWd52KBXBcEAQc4sVtZxWk4n';
export const COMPUTE_BUDGET   = 'ComputeBudget111111111111111111111111111111';
export const SYSTEM_PROGRAM   = '11111111111111111111111111111111';
export const GAME_ID = 2;
export const ROOM_ID = 1;

const JOIN_DISC = new Uint8Array([0xce,0x37,0x02,0x6a,0x71,0xdc,0x11,0xa3]);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function bs58Decode(str) {
  let leadingZeros = 0;
  for (const c of str) { if (c === '1') leadingZeros++; else break; }

  let bytes = [0];
  for (const c of str) {
    let carry = B58.indexOf(c);
    if (carry < 0) throw new Error('Invalid base58: ' + c);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  bytes.reverse();

  while (bytes.length > 0 && bytes[0] === 0) bytes.shift();
  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
}

export function bs58Encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const byte of bytes) { if (byte === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function u16LE(v) {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

function u32LE(v) {
  return new Uint8Array([v&0xff,(v>>8)&0xff,(v>>16)&0xff,(v>>24)&0xff]);
}

function u64LE(v) {
  const lo = v >>> 0;
  const hi = Math.floor(v / 0x100000000) >>> 0;
  return new Uint8Array([
    lo&0xff,(lo>>8)&0xff,(lo>>16)&0xff,(lo>>24)&0xff,
    hi&0xff,(hi>>8)&0xff,(hi>>16)&0xff,(hi>>24)&0xff,
  ]);
}

function compactU16(v) {
  if (v <= 0x7f) return new Uint8Array([v]);
  if (v <= 0x3fff) return new Uint8Array([(v & 0x7f) | 0x80, v >> 7]);
  return new Uint8Array([(v & 0x7f) | 0x80, ((v >> 7) & 0x7f) | 0x80, v >> 14]);
}

function concat(...arrs) {
  const len = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function buildInstructionData(betLamports, cashoutMultiplier, roundId) {
  // Scale confirmed from decoded TX: multiplier * 100 (e.g. 2x → 200)
  const cashoutBasisPoints = Math.round(cashoutMultiplier * 100);

  return concat(
    JOIN_DISC,
    u16LE(GAME_ID),
    u16LE(ROOM_ID),
    u64LE(betLamports),
    u64LE(roundId),
    new Uint8Array([0x01]),
    u32LE(2),
    u32LE(cashoutBasisPoints)
  );
}

export function buildAndSignTransaction(
  payerKeypairBytes,
  playerAccountPDA,
  betLamports,
  cashoutMultiplier,
  recentBlockhash,
  roundId
) {
  const nacl = window.nacl;
  if (!nacl) throw new Error('TweetNaCl not loaded — check index.html');

  const payerPub   = payerKeypairBytes.slice(32);
  const playerPDA  = bs58Decode(playerAccountPDA);
  const room       = bs58Decode(ROOM_ACCOUNT);
  const vault      = bs58Decode(VAULT_ACCOUNT);
  const feeVault   = bs58Decode(FEE_VAULT);
  const progState  = bs58Decode(PROGRAM_STATE);
  const computeProg= bs58Decode(COMPUTE_BUDGET);
  const dealerProg = bs58Decode(DEALER_PROGRAM);
  const sysProg    = bs58Decode(SYSTEM_PROGRAM);

  const allKeys = [payerPub, playerPDA, room, vault, feeVault, progState, computeProg, dealerProg, sysProg];
  allKeys.forEach((k, i) => {
    if (k.length !== 32) throw new Error(`Account [${i}] decoded to ${k.length} bytes, expected 32`);
  });

  const header = new Uint8Array([1, 0, 3]);

  const joinData    = buildInstructionData(betLamports, cashoutMultiplier, roundId);
  const cuLimitData = new Uint8Array([0x02, 0xC0, 0xD4, 0x01, 0x00]);
  const cuPriceData = new Uint8Array([0x03, 0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

  const ix0 = concat(
    new Uint8Array([6]), compactU16(0),
    compactU16(cuLimitData.length), cuLimitData
  );
  const ix1 = concat(
    new Uint8Array([6]), compactU16(0),
    compactU16(cuPriceData.length), cuPriceData
  );

  const joinAccIdxs = new Uint8Array([1, 2, 3, 4, 5, 0, 8, 7]);

  const ix2 = concat(
    new Uint8Array([7]),
    compactU16(joinAccIdxs.length), joinAccIdxs,
    compactU16(joinData.length), joinData
  );

  const blockhashBytes = bs58Decode(recentBlockhash);

  const message = concat(
    header,
    compactU16(allKeys.length), ...allKeys,
    blockhashBytes,
    compactU16(3),
    ix0, ix1, ix2
  );

  const signature = nacl.sign.detached(message, payerKeypairBytes);
  return concat(compactU16(1), signature, message);
}

export async function getRecentBlockhash(rpcUrl) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'confirmed' }]
    })
  });
  const json = await res.json();
  if (json.error) throw new Error('getLatestBlockhash: ' + json.error.message);
  return json.result.value.blockhash;
}

export async function getBalance(rpcUrl, pubkey) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getBalance',
      params: [pubkey, { commitment: 'confirmed' }]
    })
  });
  const json = await res.json();
  return json.result?.value ?? 0;
}

export async function sendRawTransaction(rpcUrl, txBytes) {
  let b64 = '';
  const chunk = 8192;
  for (let i = 0; i < txBytes.length; i += chunk) {
    b64 += String.fromCharCode(...txBytes.slice(i, i + chunk));
  }
  b64 = btoa(b64);

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'sendTransaction',
      params: [b64, {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3
      }]
    })
  });
  const json = await res.json();
  if (json.error) {
    const msg = json.error.data?.logs?.join('\n') || json.error.message || JSON.stringify(json.error);
    throw new Error(msg);
  }
  return json.result;
}
