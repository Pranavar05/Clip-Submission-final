/**
 * tiktokAuth.js
 *
 * Implements the TikTok OAuth 2.0 authorization-code flow with PKCE.
 * - buildAuthUrl(): generates the URL a user visits to authorize the app.
 * - exchangeCodeForToken(): swaps the authorization code for access/refresh tokens.
 * - refreshAccessToken(): uses a refresh token to mint a new access token.
 *
 * Access tokens last 24h; refresh tokens last 365 days (per TikTok docs).
 * Client Key / Client Secret are read from env vars only — never hardcode
 * or pass them through Discord messages.
 */
const axios = require("axios");
const crypto = require("crypto");

const AUTH_BASE = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

// In-memory PKCE + state cache (short-lived, per pending login attempt).
// For a multi-instance bot, move this to Redis or similar.
const pendingLogins = new Map(); // state -> { codeVerifier, discordUserId, createdAt }

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePkcePair() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

/**
 * Builds the URL to send a Discord user to for TikTok authorization.
 * @param {string} discordUserId
 * @param {string[]} scopes e.g. ["user.info.basic", "video.publish"]
 */
function buildAuthUrl(discordUserId, scopes) {
  const state = base64url(crypto.randomBytes(16));
  const { codeVerifier, codeChallenge } = generatePkcePair();

  pendingLogins.set(state, {
    codeVerifier,
    discordUserId,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    scope: scopes.join(","),
    response_type: "code",
    redirect_uri: process.env.TIKTOK_REDIRECT_URI,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `${AUTH_BASE}?${params.toString()}`;
}

/**
 * Called from the /callback route once TikTok redirects back with a code + state.
 */
async function exchangeCodeForToken(code, state) {
  const pending = pendingLogins.get(state);
  if (!pending) {
    throw new Error("Unknown or expired state — please restart the /tiktok-connect flow.");
  }
  pendingLogins.delete(state);

  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: process.env.TIKTOK_REDIRECT_URI,
    code_verifier: pending.codeVerifier,
  });

  const { data } = await axios.post(TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (data.error) {
    throw new Error(`TikTok token exchange failed: ${data.error_description || data.error}`);
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    discordUserId: pending.discordUserId,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    open_id: data.open_id,
    expires_at: now + data.expires_in,
    refresh_expires_at: now + data.refresh_expires_in,
  };
}

/**
 * Refreshes an access token using a stored refresh token.
 */
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const { data } = await axios.post(TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (data.error) {
    throw new Error(`TikTok token refresh failed: ${data.error_description || data.error}`);
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    open_id: data.open_id,
    expires_at: now + data.expires_in,
    refresh_expires_at: now + data.refresh_expires_in,
  };
}

module.exports = { buildAuthUrl, exchangeCodeForToken, refreshAccessToken };
