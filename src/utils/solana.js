// utils/solana.js
import { Buffer } from 'buffer';

export const DEALER_PROGRAM = 'DEALERKFspSo5RoXNnKAhRPhTcvJeqeEgAgZsNSjCx5E';
export const PROGRAM_STATE = 'DEALVwKJrYswMvZAwPP5DpaN7epa6VXn16ondftGY1cB';
export const ROOM_ACCOUNT = '7b1VfRjNoCn7gPEQ7HFAg8wtjaLkrVrZTQNvkEdmrwsj';
export const VAULT_ACCOUNT = 'FQpAdBocBoxQpZh5P5S8fFuUbVDAAPgoqXvC3NJYReFL';
export const FEE_ACCOUNT = '9PKoSP4k2uzkCCWMi1x6iUzPPBsK5RZbVpEaz1CS2Vnk';
export const FEE_VAULT = 'i821bbVqQguuDLQp72gNWd52KBXBcEAQc4sVtZxWk4n';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export const GAME_ID = 2;
export const ROOM_ID = 1;
export const SOLANA_BUILD_STAMP = '2026-04-13-live-join-v1';

const JOIN_DISC = new Uint8Array([0xce, 0x37, 0x02, 0x6a, 0x71, 0xdc, 0x11, 0xa3]);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function bs58Decode(str) {
  if (!str) throw new Error('Empty base58 string');

  let leadingZeros = 0;
  for (const ch of str) {
    if (ch === '1') leadingZeros += 1;
    else break;
  }

  let bytes = [0];
  for (const ch of str) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error(`Invalid base58 character: ${ch}`);

    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  bytes.reverse();
  while (bytes.length > 0 && bytes[0] === 0) bytes.shift();

  const out = new Uint8Array(leadingZeros + bytes.length);
  out.set(bytes, leadingZeros);
  return out;
}

export function bs58Encode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (bytes.length === 0) return '';

  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '';
  for (const b of bytes) {
    if (b === 0) out += '1';
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]];
  return out;
}

const u16LE = v => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
const u32LE = v => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);

function u64LE(v) {
  const n = Number(v);
  const lo = n >>> 0;
  const hi = Math.floor(n / 0x100000000) >>> 0;
  return new Uint8Array([
    lo & 0xff, (lo >> 8) & 0xff, (lo >> 16) & 0xff, (lo >> 24) & 0xff,
    hi & 0xff, (hi >> 8) & 0xff, (hi >> 16) & 0xff, (hi >> 24) & 0xff,
  ]);
}

function compactU16(v) {
  if (v <= 0x7f) return new Uint8Array([v]);
  if (v <= 0x3fff) return new Uint8Array([(v & 0x7f) | 0x80, v >> 7]);
  return new Uint8Array([(v & 0x7f) | 0x80, ((v >> 7) & 0x7f) | 0x80, v >> 14]);
}

function concat(...arrs) {
  const total = arrs.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrs) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function deriveRoomPDA() {
  return bs58Decode(ROOM_ACCOUNT);
}

function deriveHouseVault() {
  return bs58Decode(VAULT_ACCOUNT);
}

function normalizeWalletPubkeyBytes(walletLike) {
  if (walletLike instanceof Uint8Array) {
    if (walletLike.length === 32) return walletLike;
    if (walletLike.length === 64) return walletLike.slice(32);
  }
  if (typeof walletLike === 'string' && walletLike.trim()) {
    return bs58Decode(walletLike.trim());
  }
  throw new Error('Wallet pubkey bytes unavailable');
}

function deriveFeeVault() {
  return bs58Decode(FEE_ACCOUNT);
}

function assertUniqueAccounts(allKeys, labels) {
  const seen = new Map();
  allKeys.forEach((key, index) => {
    const encoded = bs58Encode(key);
    if (seen.has(encoded)) {
      const firstIndex = seen.get(encoded);
      throw new Error(
        `Duplicate instruction accounts: ${labels[firstIndex]} and ${labels[index]} resolved to ${encoded}`
      );
    }
    seen.set(encoded, index);
  });
}

function buildInstructionDataLiveJoin(betLamports, roundId) {
  const sideLabel = new TextEncoder().encode('NA');
  return concat(
    JOIN_DISC,
    u16LE(GAME_ID),
    u16LE(ROOM_ID),
    u64LE(betLamports),
    u64LE(roundId),
    new Uint8Array([0x01]),
    u32LE(sideLabel.length),
    sideLabel
  );
}

function buildInstructionData(betLamports, roundId) {
  return buildInstructionDataLiveJoin(betLamports, roundId);
}

function resolveJoinAccounts(payerKeypairBytes) {
  const payerPub = payerKeypairBytes.slice(32);
  const feeVault = deriveFeeVault();
  const roomPda = deriveRoomPDA();
  const houseVault = deriveHouseVault();
  const coldHouse = bs58Decode(FEE_VAULT);
  const progState = bs58Decode(PROGRAM_STATE);
  const computeProg = bs58Decode(COMPUTE_BUDGET);
  const dealerProg = bs58Decode(DEALER_PROGRAM);
  const sysProg = bs58Decode(SYSTEM_PROGRAM);

  const allKeys = [payerPub, feeVault, roomPda, houseVault, coldHouse, progState, computeProg, dealerProg, sysProg];
  allKeys.forEach((key, index) => {
    if (key.length !== 32) throw new Error(`Account [${index}] decoded to ${key.length} bytes, expected 32`);
  });

  assertUniqueAccounts(allKeys, [
    'payer',
    'fee',
    'room',
    'house',
    'coldHouse',
    'programState',
    'computeBudget',
    'dealerProgram',
    'systemProgram',
  ]);

  return {
    payerPub,
    feeVault,
    roomPda,
    houseVault,
    coldHouse,
    progState,
    computeProg,
    dealerProg,
    sysProg,
    allKeys,
  };
}

export function getDealerDerivedAccounts(walletLike) {
  normalizeWalletPubkeyBytes(walletLike);
  return {
    boss: PROGRAM_STATE,
    coldHouse: FEE_VAULT,
    fee: bs58Encode(deriveFeeVault()),
    room: bs58Encode(deriveRoomPDA()),
    house: bs58Encode(deriveHouseVault()),
    programState: PROGRAM_STATE,
  };
}

export function getWalletTrackingAddresses(walletLike, configuredPlayerPda = '') {
  const walletBytes = normalizeWalletPubkeyBytes(walletLike);
  const walletPubkey = bs58Encode(walletBytes);
  const legacy = String(configuredPlayerPda || '').trim();
  return [...new Set([walletPubkey, legacy].filter(Boolean))];
}

export function getJoinBuildPreview(keypair, playerPDA, betLamports, cashoutMultiplier, roundId) {
  if (!keypair || keypair.length !== 64) throw new Error('Invalid keypair in preview');
  const accounts = resolveJoinAccounts(keypair);
  const preview = {
    stamp: SOLANA_BUILD_STAMP,
    fee: bs58Encode(accounts.feeVault),
    room: bs58Encode(accounts.roomPda),
    house: bs58Encode(accounts.houseVault),
    coldHouse: bs58Encode(accounts.coldHouse),
    programState: bs58Encode(accounts.progState),
  };

  const joinLive = buildInstructionDataLiveJoin(betLamports, roundId);
  preview.joinLiveLength = joinLive.length;
  preview.joinLiveBase58 = bs58Encode(joinLive);

  return preview;
}

export function buildAndSignTransaction(
  payerKeypairBytes,
  playerAccountPDA,
  betLamports,
  cashoutMultiplier,
  recentBlockhash,
  roundId,
  layout = 'joinLive'
) {
  const nacl = window.nacl;
  if (!nacl?.sign?.detached) throw new Error('TweetNaCl not loaded - check index.html');
  if (!payerKeypairBytes || payerKeypairBytes.length !== 64) {
    throw new Error('Invalid keypair (must be 64 bytes)');
  }

  const { allKeys } = resolveJoinAccounts(payerKeypairBytes);
  const header = new Uint8Array([1, 0, 3]);
  const joinData = buildInstructionData(betLamports, roundId);
  const betSol = Number(betLamports) / 1e9;
  const cuPrice = betSol < 0.01 ? 1000 : Math.round(105000 + 50 * Math.round(betSol * 100));
  const cuLimitData = new Uint8Array([0x02, 0xC0, 0xD4, 0x01, 0x00]);
  const cuPriceData = concat(new Uint8Array([0x03]), u64LE(cuPrice));

  const ix0 = concat(new Uint8Array([6]), compactU16(0), compactU16(cuPriceData.length), cuPriceData);
  const ix1 = concat(new Uint8Array([6]), compactU16(0), compactU16(cuLimitData.length), cuLimitData);

  // Confirmed from a successful live Join transaction:
  // [fee, room, house, coldHouse, boss/programState, player, systemProgram]
  const joinAccIdxs = new Uint8Array([1, 2, 3, 4, 5, 0, 8]);
  const ix2 = concat(
    new Uint8Array([7]),
    compactU16(joinAccIdxs.length),
    joinAccIdxs,
    compactU16(joinData.length),
    joinData
  );

  const blockhashBytes = bs58Decode(recentBlockhash || '');
  if (blockhashBytes.length !== 32) {
    throw new Error(`Invalid blockhash bytes: ${blockhashBytes.length}`);
  }

  const message = concat(
    header,
    compactU16(allKeys.length),
    ...allKeys,
    blockhashBytes,
    compactU16(3),
    ix0,
    ix1,
    ix2
  );

  const signature = nacl.sign.detached(message, payerKeypairBytes);
  return concat(compactU16(1), signature, message);
}

export async function getRecentBlockhash(rpcUrl) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'confirmed' }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`getLatestBlockhash failed: ${json.error.message}`);
  return json.result?.value?.blockhash;
}

export async function getBalance(rpcUrl, pubkey) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [pubkey, { commitment: 'confirmed' }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`getBalance failed: ${json.error.message}`);
  return json.result?.value ?? 0;
}

export async function sendRawTransaction(rpcUrl, txBytes) {
  const b64 = Buffer.from(txBytes).toString('base64');

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [
        b64,
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        },
      ],
    }),
  });

  const json = await res.json();
  if (json.error) {
    const msg =
      json.error?.data?.logs?.join('\n') ||
      json.error?.message ||
      JSON.stringify(json.error);
    throw new Error(msg);
  }
  return json.result;
}
