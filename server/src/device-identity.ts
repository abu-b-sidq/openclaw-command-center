// Ed25519 device identity for gateways that aren't on loopback. The gateway pairs this identity once
// (`openclaw devices approve <requestId>`); after that the signed connect is accepted like any paired device.
// Format follows OpenClaw's gateway client: id = sha256(raw public key) hex, public key and signature base64url,
// signature over the v3 payload "v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily".
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

function rawPublicKey(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (
    der.length !== SPKI_PREFIX.length + 32 ||
    !der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)
  )
    throw new Error('not an Ed25519 public key');
  return der.subarray(SPKI_PREFIX.length);
}

export const deviceIdOf = (publicKeyPem: string): string =>
  createHash('sha256').update(rawPublicKey(publicKeyPem)).digest('hex');

export function loadOrCreateDeviceIdentity(file: string): DeviceIdentity {
  if (existsSync(file)) {
    const d = JSON.parse(readFileSync(file, 'utf8')) as DeviceIdentity;
    if (d.deviceId !== deviceIdOf(d.publicKeyPem))
      throw new Error(`${file}: deviceId doesn't match its public key`);
    createPrivateKey(d.privateKeyPem);
    return d;
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const d: DeviceIdentity = {
    deviceId: deviceIdOf(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now(),
  };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return d;
}

const norm = (v: string | undefined): string => (v ?? '').trim().toLowerCase();

export interface SignParams {
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string;
  deviceFamily?: string;
}

export function buildPayloadV3(deviceId: string, p: SignParams): string {
  return [
    'v3',
    deviceId,
    p.clientId,
    p.clientMode,
    p.role,
    p.scopes.join(','),
    String(p.signedAtMs),
    p.token ?? '',
    p.nonce,
    norm(p.platform),
    norm(p.deviceFamily),
  ].join('|');
}

/** The `device` block of a connect request. */
export function signConnect(d: DeviceIdentity, p: SignParams) {
  const payload = buildPayloadV3(d.deviceId, p);
  return {
    id: d.deviceId,
    publicKey: rawPublicKey(d.publicKeyPem).toString('base64url'),
    signature: sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(d.privateKeyPem)).toString(
      'base64url',
    ),
    signedAt: p.signedAtMs,
    nonce: p.nonce,
  };
}
