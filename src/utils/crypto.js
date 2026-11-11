const CryptoJS = require('crypto-js');
require('dotenv').config();

const secret = process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || 'ciq_enterprise_encryption_key_v2';
const ENC_PREFIX = 'enc:';

function encrypt(text) {
  if (text === null || text === undefined) return '';
  return CryptoJS.AES.encrypt(String(text), secret).toString();
}

function decrypt(cipher) {
  if (!cipher) return '';
  const bytes = CryptoJS.AES.decrypt(String(cipher), secret);
  return bytes.toString(CryptoJS.enc.Utf8);
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

function encryptSecret(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return plainText || '';
  const str = String(plainText);
  if (isEncrypted(str)) return str;
  return ENC_PREFIX + encrypt(str);
}

function decryptSecret(storedValue) {
  if (storedValue === null || storedValue === undefined || storedValue === '') return storedValue || '';
  const str = String(storedValue);
  if (isEncrypted(str)) {
    try {
      const decrypted = decrypt(str.slice(ENC_PREFIX.length));
      if (decrypted) return decrypted;
    } catch (e) {
      // Fallback
    }
  }
  return str;
}

function maskSecret(secretValue) {
  const plain = decryptSecret(secretValue);
  if (!plain || typeof plain !== 'string') return '';
  const trimmed = plain.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 6) return '••••••••';
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-3)}`;
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  encryptSecret,
  decryptSecret,
  maskSecret
};

