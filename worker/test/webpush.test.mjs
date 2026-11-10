import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, vapidAuthHeader, generateVapidKeys, b64urlDecode, b64urlEncode } from '../src/webpush.js';

test('aes128gcm 暗号化をブラウザ側と同じ手順で復号できる', async () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const msg = JSON.stringify({ title: '塾の迎え（火）', body: 'テスト 🔔' });
  const body = await encryptPayload(msg, b64urlEncode(ua.getPublicKey()), b64urlEncode(auth));
  const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: auth });
  assert.equal(plain.toString('utf8'), msg);
});

test('VAPID の JWT 署名が公開鍵で検証できる', async () => {
  const keys = await generateVapidKeys();
  const h = await vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc', { ...keys, subject: 'https://example.com/' });
  const m = h.match(/^vapid t=([^,]+), k=(.+)$/);
  const [hd, pl, sig] = m[1].split('.');
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(pl)));
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  const pub = await globalThis.crypto.subtle.importKey('raw', b64urlDecode(m[2]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(sig), new TextEncoder().encode(`${hd}.${pl}`));
  assert.ok(ok);
});
