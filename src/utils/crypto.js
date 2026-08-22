const CryptoJS = require('crypto-js');
require('dotenv').config();

const secret = process.env.TOKEN_ENCRYPTION_KEY;
if (!secret) {
  throw new Error('TOKEN_ENCRYPTION_KEY not set in .env');
}

function encrypt(text) {
  return CryptoJS.AES.encrypt(text, secret).toString();
}

function decrypt(cipher) {
  const bytes = CryptoJS.AES.decrypt(cipher, secret);
  return bytes.toString(CryptoJS.enc.Utf8);
}

module.exports = { encrypt, decrypt };
