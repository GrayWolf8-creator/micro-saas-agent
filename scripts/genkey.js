// Prints a NEW Ed25519 keypair for response signing. Run it yourself: node scripts/genkey.js
// Put the PRIVATE base64 value into Render as env var SIGNING_KEY. Never commit or share it.
import crypto from 'crypto';
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
console.log('SIGNING_KEY (private, paste into Render env only):');
console.log(privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'));
console.log('\nPublic key (safe to share; also served at /api/proof/pubkey):');
console.log(publicKey.export({ type: 'spki', format: 'pem' }));
