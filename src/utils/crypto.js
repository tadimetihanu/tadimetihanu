const CryptoJS = require('crypto-js');
require('dotenv').config();

const secret = process.env.TOKEN_ENCRYPTION_KEY || 'default_super_secure_token_encryption_key_2026_cloudobjectiq';

function encrypt(text) {
  return CryptoJS.AES.encrypt(text, secret).toString();
}

function decrypt(cipher) {
  const bytes = CryptoJS.AES.decrypt(cipher, secret);
  return bytes.toString(CryptoJS.enc.Utf8);
}

module.exports = { encrypt, decrypt };

