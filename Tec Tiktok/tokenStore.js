/**
 * tokenStore.js
 *
 * Persists TikTok OAuth tokens per Discord user, encrypted at rest with
 * AES-256-GCM using TOKEN_ENCRYPTION_KEY. This is a file-based store meant
 * for a single-instance bot. For production/multi-instance deployments,
 * swap `readAll`/`writeAll` for calls to a real secrets manager or an
 * encrypted database column instead of a local file.
 *
 * Per the security notes in the integration guide: raw Client Key / Client
 * Secret / user tokens must never be logged, printed to Discord, or emailed.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_PATH = path.join(__dirname, "..", "data", "tokens.enc.json");
const ALGO = "aes-256-gcm";

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars). Generate one with: openssl rand -hex 32"
    );
  }
  return Buffer.from(hex, "hex");
}

function encrypt(plainObj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(plainObj), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

function decrypt(blob) {
  const decipher = crypto.createDecipheriv(
    ALGO,
    getKey(),
    Buffer.from(blob.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(blob.authTag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(blob.data, "hex")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

function readAll() {
  if (!fs.existsSync(STORE_PATH)) return {};
  const raw = fs.readFileSync(STORE_PATH, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function writeAll(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), {
    mode: 0o600, // owner read/write only
  });
}

/**
 * @param {string} discordUserId
 * @param {{access_token:string, refresh_token:string, expires_at:number, refresh_expires_at:number, open_id:string}} tokenData
 */
function saveTokens(discordUserId, tokenData) {
  const store = readAll();
  store[discordUserId] = encrypt(tokenData);
  writeAll(store);
}

/**
 * @param {string} discordUserId
 * @returns {object|null}
 */
function getTokens(discordUserId) {
  const store = readAll();
  const blob = store[discordUserId];
  if (!blob) return null;
  try {
    return decrypt(blob);
  } catch (err) {
    console.error(`Failed to decrypt tokens for user ${discordUserId}:`, err.message);
    return null;
  }
}

function deleteTokens(discordUserId) {
  const store = readAll();
  delete store[discordUserId];
  writeAll(store);
}

module.exports = { saveTokens, getTokens, deleteTokens };
