import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

// ─── Centralized Named Constants ─────────────────────────────────────────
export const MAX_UPLOAD_SIZE = 200 * 1024 * 1024; // 200MB
export const MAX_UPLOADS_PER_HOUR = 3;
export const TOKEN_EXPIRY = 10 * 60 * 1000; // 10 minutes in ms
export const SIGNED_URL_EXPIRY = 3600; // 1 hour in seconds
export const WORKER_CONCURRENCY = 1;

export const config = {
  isDev,
  port: parseInt(process.env.PORT || '3000', 10),
  apiBaseUrl: (process.env.API_BASE_URL || '').trim() || 'http://localhost:3000',
  apiAuthToken: (process.env.API_AUTH_TOKEN || '').trim(), // No default fallback for security
  allowedOrigin: (process.env.ALLOWED_ORIGIN || '*').trim(),
  sentryDsn: (process.env.SENTRY_DSN || '').trim(),
  databaseUrl: (process.env.DATABASE_URL || '').trim(),
  redisUrl: (process.env.REDIS_URL || '').trim(),

  mockAirtable: process.env.MOCK_AIRTABLE === 'true' || (isDev && (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID)),
  mockStorage: process.env.MOCK_STORAGE === 'true' || (isDev && (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY)),

  discord: {
    token: (process.env.DISCORD_TOKEN || '').trim(),
    clientId: (process.env.DISCORD_CLIENT_ID || '').trim(),
    guildId: (process.env.DISCORD_GUILD_ID || '').trim(),
    clipperRoleId: (process.env.CLIPPER_ROLE_ID || '').trim(),
  },

  limits: {
    maxFileSizeBytes: MAX_UPLOAD_SIZE,
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '3600000', 10), // Default: 1 hour
    rateLimitMaxSubmissions: MAX_UPLOADS_PER_HOUR,
  },

  airtable: {
    apiKey: (process.env.AIRTABLE_API_KEY || '').trim(),
    baseId: (process.env.AIRTABLE_BASE_ID || '').trim(),
    submissionsTable: (process.env.AIRTABLE_SUBMISSIONS_TABLE || 'Submissions').trim(),
    creatorsTable: (process.env.AIRTABLE_CREATORS_TABLE || 'Creators').trim(),
  },

  r2: {
    accountId: (process.env.R2_ACCOUNT_ID || '').trim(),
    accessKeyId: (process.env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (process.env.R2_SECRET_ACCESS_KEY || '').trim(),
    bucketName: (process.env.R2_BUCKET_NAME || '').trim(),
    publicUrl: (process.env.R2_PUBLIC_URL || '').trim(),
  }
};

// Complete configuration validation
export function validateConfig(): void {
  // 1. CLIPPER_ROLE_ID check (Fail loudly on startup)
  if (!config.discord.clipperRoleId) {
    throw new Error('CRITICAL CONFIGURATION ERROR: CLIPPER_ROLE_ID environment variable is missing or empty. The system cannot start without role gating enabled.');
  }

  // 2. API_AUTH_TOKEN check
  if (!config.apiAuthToken) {
    throw new Error('CRITICAL CONFIGURATION ERROR: API_AUTH_TOKEN environment variable is missing or empty. A secure token must be provided.');
  }

  // 3. Discord Bot tokens validation
  const missingBotConfigs: string[] = [];
  if (!config.discord.token) missingBotConfigs.push('DISCORD_TOKEN');
  if (!config.discord.clientId) missingBotConfigs.push('DISCORD_CLIENT_ID');
  
  if (missingBotConfigs.length > 0) {
    throw new Error(`CRITICAL CONFIGURATION ERROR: Missing bot credentials: ${missingBotConfigs.join(', ')}.`);
  }

  // 4. Production specific environment checks
  if (process.env.NODE_ENV === 'production') {
    if (config.apiAuthToken === 'super-secret-auth-token-between-bot-and-api') {
      throw new Error('CRITICAL CONFIGURATION ERROR: API_AUTH_TOKEN is using the default development fallback secret in production. Replace it with a secure token.');
    }
    const missingProductionConfigs: string[] = [];
    if (!config.databaseUrl) missingProductionConfigs.push('DATABASE_URL');
    if (!config.redisUrl) missingProductionConfigs.push('REDIS_URL');
    if (!config.mockAirtable) {
      if (!config.airtable.apiKey) missingProductionConfigs.push('AIRTABLE_API_KEY');
      if (!config.airtable.baseId) missingProductionConfigs.push('AIRTABLE_BASE_ID');
    }
    if (!config.mockStorage) {
      if (!config.r2.accountId) missingProductionConfigs.push('R2_ACCOUNT_ID');
      if (!config.r2.accessKeyId) missingProductionConfigs.push('R2_ACCESS_KEY_ID');
      if (!config.r2.secretAccessKey) missingProductionConfigs.push('R2_SECRET_ACCESS_KEY');
      if (!config.r2.bucketName) missingProductionConfigs.push('R2_BUCKET_NAME');
    }
    if (missingProductionConfigs.length > 0) {
      throw new Error(`CRITICAL CONFIGURATION ERROR: Missing required production credentials: ${missingProductionConfigs.join(', ')}.`);
    }
  } else {
    // Development checks (Bypassed if mock mode active)
    if (!config.mockAirtable) {
      const missingAirtableConfigs: string[] = [];
      if (!config.airtable.apiKey) missingAirtableConfigs.push('AIRTABLE_API_KEY');
      if (!config.airtable.baseId) missingAirtableConfigs.push('AIRTABLE_BASE_ID');

      if (missingAirtableConfigs.length > 0) {
        throw new Error(`CRITICAL CONFIGURATION ERROR: Missing Airtable credentials: ${missingAirtableConfigs.join(', ')}.`);
      }
    }

    if (!config.mockStorage) {
      const missingR2Configs: string[] = [];
      if (!config.r2.accountId) missingR2Configs.push('R2_ACCOUNT_ID');
      if (!config.r2.accessKeyId) missingR2Configs.push('R2_ACCESS_KEY_ID');
      if (!config.r2.secretAccessKey) missingR2Configs.push('R2_SECRET_ACCESS_KEY');
      if (!config.r2.bucketName) missingR2Configs.push('R2_BUCKET_NAME');

      if (missingR2Configs.length > 0) {
        throw new Error(`CRITICAL CONFIGURATION ERROR: Missing R2 storage credentials: ${missingR2Configs.join(', ')}.`);
      }
    }
  }
}

