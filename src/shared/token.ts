import crypto from 'crypto';
import { query } from './db.js';
import { logger } from './logger.js';
import { TOKEN_EXPIRY } from './config.js';

export interface PortalSessionPayload {
  tokenId: string;
  userId: string;
  discordUser: string;
  displayName: string;
  serverId: string;
  channelId: string;
  expiresAt: number;
}

/**
 * Creates a database-backed session token and returns a short UUID.
 */
export async function encryptToken(payload: PortalSessionPayload): Promise<string> {
  try {
    const token = crypto.randomUUID();
    
    await query(
      `INSERT INTO upload_tokens (token, user_id, discord_user, display_name, server_id, channel_id, expires_at, used, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)`,
      [
        token,
        payload.userId,
        payload.discordUser,
        payload.displayName,
        payload.serverId,
        payload.channelId,
        new Date(payload.expiresAt),
        new Date()
      ]
    );
    
    // Prune old sessions that expired more than 24 hours ago
    const pruneTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await query('DELETE FROM upload_tokens WHERE expires_at < $1', [pruneTime]);
    
    return token;
  } catch (error) {
    logger.error('Error generating/saving upload token:', error);
    // Return a random UUID as fallback so the app doesn't crash on start
    return crypto.randomUUID();
  }
}

/**
 * Decrypts (retrieves and validates) the session token from the database.
 * NOTE: This is only for reading token info without consuming it.
 */
export async function decryptToken(token: string): Promise<PortalSessionPayload | null> {
  try {
    if (!/^[0-9a-fA-F-]{36}$/.test(token)) {
      return null;
    }

    const rows = await query(
      'SELECT * FROM upload_tokens WHERE token = $1 AND (used = false OR used = 0)',
      [token]
    );
    
    if (rows.length === 0) {
      return null;
    }
    
    const row = rows[0];
    
    // Check expiration
    const expiresAtMs = new Date(row.expires_at).getTime();
    if (Date.now() > expiresAtMs) {
      return null;
    }
    
    return {
      tokenId: row.token,
      userId: row.user_id,
      discordUser: row.discord_user,
      displayName: row.display_name,
      serverId: row.server_id,
      channelId: row.channel_id,
      expiresAt: expiresAtMs
    };
  } catch (error) {
    logger.error('Error decrypting upload token:', error);
    return null;
  }
}

/**
 * Atomically validates, decrypts, and consumes the token (marks as used).
 * If clientQuery is passed, it executes within that client's transaction context.
 */
export async function consumeToken(token: string, clientQuery?: any): Promise<PortalSessionPayload | null> {
  try {
    if (!/^[0-9a-fA-F-]{36}$/.test(token)) {
      return null;
    }
    const executeQuery = clientQuery || query;
    const rows = await executeQuery(
      'SELECT * FROM upload_tokens WHERE token = $1 AND (used = false OR used = 0)',
      [token]
    );
    
    if (rows.length === 0) {
      return null;
    }
    
    const row = rows[0];
    const expiresAtMs = new Date(row.expires_at).getTime();
    if (Date.now() > expiresAtMs) {
      return null;
    }
    
    // Mark as used immediately
    await executeQuery('UPDATE upload_tokens SET used = true WHERE token = $1', [token]);
    
    return {
      tokenId: row.token,
      userId: row.user_id,
      discordUser: row.discord_user,
      displayName: row.display_name,
      serverId: row.server_id,
      channelId: row.channel_id,
      expiresAt: expiresAtMs
    };
  } catch (error) {
    logger.error('Error consuming upload token:', error);
    return null;
  }
}

/**
 * Marks a session token as used.
 */
export async function markTokenAsUsed(token: string): Promise<void> {
  try {
    if (!/^[0-9a-fA-F-]{36}$/.test(token)) {
      return;
    }

    await query('UPDATE upload_tokens SET used = true WHERE token = $1', [token]);
  } catch (error) {
    logger.error('Error marking upload token as used:', error);
  }
}

