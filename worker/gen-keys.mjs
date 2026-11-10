// VAPID鍵と家族キーを作って JSON で出力する（setup.ps1 から呼ばれる）
import { generateVapidKeys, b64urlEncode } from './src/webpush.js';
const v = await generateVapidKeys();
const familyKey = b64urlEncode(crypto.getRandomValues(new Uint8Array(18)));
console.log(JSON.stringify({ ...v, familyKey }));
