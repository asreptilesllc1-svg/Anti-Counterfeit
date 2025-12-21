import crypto from 'crypto';
import fs from 'fs';

console.log('🔐 Generating RSA keypair...');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem'
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem'
  }
});

// Save keys to files
fs.writeFileSync('private.pem', privateKey);
fs.writeFileSync('public.pem', publicKey);

console.log('✅ Keys generated successfully!');
console.log('   - private.pem');
console.log('   - public.pem');
console.log('\n⚠️  IMPORTANT: Add these keys to Render environment variables');
console.log('   Do NOT commit private.pem to GitHub!');
