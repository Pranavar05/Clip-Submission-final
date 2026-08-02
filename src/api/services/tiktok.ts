import axios from 'axios';
import crypto from 'crypto';
import { config } from '../../shared/config.js';
import { query } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';

const AUTH_BASE = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const API_BASE = 'https://open.tiktokapis.com/v2';

// In-memory PKCE state cache (valid for 10 minutes)
const pendingLogins = new Map<string, { codeVerifier: string; discordUserId: string; createdAt: number }>();

// Cleanup stale pending logins every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingLogins.entries()) {
    if (now - data.createdAt > 10 * 60 * 1000) {
      pendingLogins.delete(state);
    }
  }
}, 5 * 60 * 1000);

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePkcePair() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

export class TikTokService {
  /**
   * Build authorization URL for TikTok OAuth
   */
  static buildAuthUrl(discordUserId: string, scopes: string[]): string {
    const clientKey = config.tiktok.clientKey;
    const redirectUri = config.tiktok.redirectUri || `${config.apiBaseUrl}/api/tiktok/callback`;
    
    if (!clientKey) {
      throw new Error('TIKTOK_CLIENT_KEY is not configured.');
    }

    const state = base64url(crypto.randomBytes(16));
    const { codeVerifier, codeChallenge } = generatePkcePair();

    pendingLogins.set(state, {
      codeVerifier,
      discordUserId,
      createdAt: Date.now()
    });

    const params = new URLSearchParams({
      client_key: clientKey,
      scope: scopes.join(','),
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });

    return `${AUTH_BASE}?${params.toString()}`;
  }

  /**
   * Exchange code from callback for access and refresh tokens
   */
  static async exchangeCodeForToken(code: string, state: string): Promise<string> {
    const pending = pendingLogins.get(state);
    if (!pending) {
      throw new Error('Unknown or expired state — please restart the connection flow.');
    }
    pendingLogins.delete(state);

    const clientKey = config.tiktok.clientKey;
    const clientSecret = config.tiktok.clientSecret;
    const redirectUri = config.tiktok.redirectUri || `${config.apiBaseUrl}/api/tiktok/callback`;

    if (!clientKey || !clientSecret) {
      throw new Error('TikTok clientKey or clientSecret is missing from configuration.');
    }

    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: pending.codeVerifier
    });

    const { data } = await axios.post(TOKEN_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (data.error) {
      throw new Error(`TikTok token exchange failed: ${data.error_description || data.error}`);
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + data.expires_in;
    const refreshExpiresAt = now + data.refresh_expires_in;

    // Save tokens in database
    await query(
      `INSERT INTO tiktok_tokens (user_id, access_token, refresh_token, open_id, expires_at, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET 
         access_token = EXCLUDED.access_token, 
         refresh_token = EXCLUDED.refresh_token, 
         open_id = EXCLUDED.open_id, 
         expires_at = EXCLUDED.expires_at, 
         refresh_expires_at = EXCLUDED.refresh_expires_at,
         created_at = CURRENT_TIMESTAMP`,
      [pending.discordUserId, data.access_token, data.refresh_token, data.open_id, expiresAt, refreshExpiresAt]
    );

    return pending.discordUserId;
  }

  /**
   * Refreshes access token if it's expired or close to expiry (within 2 minutes)
   */
  static async getValidAccessToken(discordUserId: string): Promise<string> {
    const rows = await query<any>(
      'SELECT access_token, refresh_token, expires_at, refresh_expires_at FROM tiktok_tokens WHERE user_id = $1',
      [discordUserId]
    );

    if (rows.length === 0) {
      throw new Error("This Discord account isn't linked to TikTok yet. Run /tiktok-connect first.");
    }

    const stored = rows[0];
    const now = Math.floor(Date.now() / 1000);

    // If access token is still valid (with a 2-minute margin)
    if (stored.expires_at - now > 120) {
      return stored.access_token;
    }

    if (stored.refresh_expires_at <= now) {
      throw new Error('Your TikTok connection has expired. Please run /tiktok-connect again.');
    }

    const clientKey = config.tiktok.clientKey;
    const clientSecret = config.tiktok.clientSecret;

    if (!clientKey || !clientSecret) {
      throw new Error('TikTok configuration is missing.');
    }

    logger.info(`Refreshing TikTok access token for user ${discordUserId}...`);

    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token
    });

    const { data } = await axios.post(TOKEN_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (data.error) {
      throw new Error(`TikTok token refresh failed: ${data.error_description || data.error}`);
    }

    const newExpiresAt = now + data.expires_in;
    const newRefreshExpiresAt = now + data.refresh_expires_in;

    // Update tokens in database
    await query(
      `UPDATE tiktok_tokens 
       SET access_token = $1, refresh_token = $2, open_id = $3, expires_at = $4, refresh_expires_at = $5, created_at = CURRENT_TIMESTAMP
       WHERE user_id = $6`,
      [data.access_token, data.refresh_token, data.open_id, newExpiresAt, newRefreshExpiresAt, discordUserId]
    );

    return data.access_token;
  }

  /**
   * Unlinks a user's TikTok account
   */
  static async unlinkAccount(discordUserId: string): Promise<void> {
    await query('DELETE FROM tiktok_tokens WHERE user_id = $1', [discordUserId]);
  }

  /**
   * Fetches basic profile info for the user
   */
  static async getUserProfile(discordUserId: string): Promise<{ display_name: string; avatar_url: string; follower_count?: number }> {
    const accessToken = await this.getValidAccessToken(discordUserId);
    const fields = ['open_id', 'display_name', 'avatar_url', 'follower_count'].join(',');

    const { data } = await axios.get(`${API_BASE}/user/info/`, {
      params: { fields },
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (data.error && data.error.code !== 'ok') {
      throw new Error(`TikTok API error: ${data.error.message}`);
    }

    return data.data.user;
  }

  /**
   * Fetches views count for a specific video using the user's access token
   */
  static async fetchVideoViews(videoId: string, discordUserId: string): Promise<number | null> {
    try {
      const accessToken = await this.getValidAccessToken(discordUserId);

      const { data } = await axios.post(
        `${API_BASE}/video/query/?fields=view_count`,
        {
          filters: {
            video_ids: [videoId]
          }
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8'
          }
        }
      );

      if (data.error && data.error.code !== 'ok') {
        logger.error(`TikTok video query API error: ${data.error.message}`);
        return null;
      }

      const video = data.data?.videos?.[0];
      if (video && typeof video.view_count === 'number') {
        return video.view_count;
      }
    } catch (err: any) {
      logger.error(`Failed to fetch TikTok views for video ${videoId} (user ${discordUserId}):`, err.message);
    }
    return null;
  }
}
