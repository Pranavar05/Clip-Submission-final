import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { logger } from './logger.js';
import path from 'path';

let pgPool: pg.Pool | null = null;
let sqliteDb: DatabaseSync | null = null;
const isMock = !config.databaseUrl;

interface Migration {
  name: string;
  pgSql: string;
  sqliteSql: string;
}

const MIGRATIONS: Migration[] = [
  {
    name: '001_initial_schema',
    pgSql: `
      CREATE SEQUENCE IF NOT EXISTS submission_id_seq START 1;
      
      CREATE TABLE IF NOT EXISTS creators (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS campaigns (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'Active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS upload_tokens (
        token UUID PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        discord_user VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        server_id VARCHAR(50) NOT NULL,
        channel_id VARCHAR(50) NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS submissions (
        id VARCHAR(50) PRIMARY KEY,
        token UUID REFERENCES upload_tokens(token) ON DELETE SET NULL,
        user_id VARCHAR(50) NOT NULL,
        discord_username VARCHAR(255) NOT NULL,
        creator_id VARCHAR(50) REFERENCES creators(id) ON DELETE RESTRICT,
        clip_type VARCHAR(50) NOT NULL,
        description TEXT,
        bucket VARCHAR(255) NOT NULL,
        object_key VARCHAR(255) NOT NULL,
        size_bytes BIGINT DEFAULT 0,
        original_filename VARCHAR(255),
        status VARCHAR(50) NOT NULL DEFAULT 'CREATED',
        server_id VARCHAR(50),
        channel_id VARCHAR(50),
        submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        action VARCHAR(255) NOT NULL,
        actor_id VARCHAR(50) NOT NULL,
        actor_username VARCHAR(255) NOT NULL,
        details TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS review_history (
        id SERIAL PRIMARY KEY,
        submission_id VARCHAR(50) REFERENCES submissions(id) ON DELETE CASCADE,
        reviewer_id VARCHAR(50) NOT NULL,
        action VARCHAR(50) NOT NULL,
        note TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `,
    sqliteSql: `
      CREATE TABLE IF NOT EXISTS creators (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Active',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS upload_tokens (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        discord_user TEXT NOT NULL,
        display_name TEXT NOT NULL,
        server_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        token TEXT,
        user_id TEXT NOT NULL,
        discord_username TEXT NOT NULL,
        creator_id TEXT,
        clip_type TEXT NOT NULL,
        description TEXT,
        bucket TEXT NOT NULL,
        object_key TEXT NOT NULL,
        size_bytes INTEGER DEFAULT 0,
        original_filename TEXT,
        status TEXT NOT NULL DEFAULT 'CREATED',
        server_id TEXT,
        channel_id TEXT,
        submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(creator_id) REFERENCES creators(id)
      );
      
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_username TEXT NOT NULL,
        details TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS review_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_id TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,
        action TEXT NOT NULL,
        note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(submission_id) REFERENCES submissions(id)
      );
    `
  },
  {
    name: '002_add_indexes',
    pgSql: `
      CREATE INDEX IF NOT EXISTS idx_review_history_submission_id ON review_history(submission_id);
      CREATE INDEX IF NOT EXISTS idx_upload_tokens_expires_at ON upload_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON submissions(submitted_at);
    `,
    sqliteSql: `
      CREATE INDEX IF NOT EXISTS idx_review_history_submission_id ON review_history(submission_id);
      CREATE INDEX IF NOT EXISTS idx_upload_tokens_expires_at ON upload_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON submissions(submitted_at);
    `
  },
  {
    name: '003_view_tracking',
    pgSql: `
      CREATE TABLE IF NOT EXISTS view_counts (
        submission_id VARCHAR(50) PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
        count BIGINT DEFAULT 0,
        last_viewed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_view_counts_count ON view_counts(count DESC);
    `,
    sqliteSql: `
      CREATE TABLE IF NOT EXISTS view_counts (
        submission_id TEXT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
        count INTEGER DEFAULT 0,
        last_viewed_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_view_counts_count ON view_counts(count DESC);
    `
  },
  {
    name: '004_tiktok_tokens',
    pgSql: `
      CREATE TABLE IF NOT EXISTS tiktok_tokens (
        user_id VARCHAR(50) PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        open_id VARCHAR(255) NOT NULL,
        expires_at BIGINT NOT NULL,
        refresh_expires_at BIGINT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `,
    sqliteSql: `
      CREATE TABLE IF NOT EXISTS tiktok_tokens (
        user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        open_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        refresh_expires_at INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `
  },
  {
    name: '005_manager_review',
    pgSql: `
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS manager_name VARCHAR(255);
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS flagged_by_manager_id VARCHAR(50);
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS rejection_note TEXT;
    `,
    sqliteSql: `
      ALTER TABLE submissions ADD COLUMN manager_name TEXT;
      ALTER TABLE submissions ADD COLUMN flagged_by_manager_id TEXT;
      ALTER TABLE submissions ADD COLUMN rejection_note TEXT;
    `
  },
  {
    name: '006_purge_legacy_test_data',
    pgSql: `
      DELETE FROM submissions WHERE id < 'SUB-000084';
    `,
    sqliteSql: `
      DELETE FROM submissions WHERE id < 'SUB-000084';
    `
  }
];

async function runMigrations(): Promise<void> {
  if (pgPool) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const res = await pgPool.query('SELECT name FROM schema_migrations');
    const applied = new Set(res.rows.map(r => r.name));
    for (const m of MIGRATIONS) {
      if (!applied.has(m.name)) {
        logger.info(`Applying database migration (PostgreSQL): ${m.name}`);
        const client = await pgPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(m.pgSql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
          await client.query('COMMIT');
          logger.info(`Migration ${m.name} completed successfully.`);
        } catch (err) {
          await client.query('ROLLBACK');
          logger.error(`Migration ${m.name} failed! Rolling back. Error:`, err);
          throw err;
        } finally {
          client.release();
        }
      }
    }
  } else if (sqliteDb) {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const stmt = sqliteDb.prepare('SELECT name FROM schema_migrations');
    const rows = stmt.all() as any[];
    const applied = new Set(rows.map(r => r.name));
    for (const m of MIGRATIONS) {
      if (!applied.has(m.name)) {
        logger.info(`Applying database migration (SQLite): ${m.name}`);
        try {
          sqliteDb.exec('BEGIN TRANSACTION');
          sqliteDb.exec(m.sqliteSql);
          const insertStmt = sqliteDb.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
          insertStmt.run(m.name);
          sqliteDb.exec('COMMIT');
          logger.info(`Migration ${m.name} completed successfully.`);
        } catch (err) {
          sqliteDb.exec('ROLLBACK');
          logger.error(`Migration ${m.name} failed! Rolling back. Error:`, err);
          throw err;
        }
      }
    }
  }
}

export async function initDb(): Promise<void> {
  if (!isMock) {
    logger.info('Initializing PostgreSQL connection pool...');
    pgPool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 20,
      idleTimeoutMillis: process.env.DB_IDLE_TIMEOUT ? parseInt(process.env.DB_IDLE_TIMEOUT, 10) : 30000,
      connectionTimeoutMillis: 5000,
      ssl: config.databaseUrl.includes('neon.tech') || (config.databaseUrl.startsWith('postgres') && !config.databaseUrl.includes('localhost') && !config.databaseUrl.includes('127.0.0.1'))
        ? { rejectUnauthorized: false }
        : undefined,
    });
    await runMigrations();
    logger.info('PostgreSQL tables and migrations initialized successfully.');
  } else {
    logger.info('[MOCK DB] DATABASE_URL not set. Falling back to local SQLite database (submit_button.db).');
    const dbPath = path.join(process.cwd(), 'submit_button.db');
    sqliteDb = new DatabaseSync(dbPath);
    await runMigrations();
    
    // Seed creators if empty
    const checkCreators = sqliteDb.prepare(`SELECT COUNT(*) as count FROM creators`);
    const row = checkCreators.get() as any;
    if (row && row.count === 0) {
      logger.info('[MOCK DB] Seeding initial creators list for development mode...');
      const seedQuery = sqliteDb.prepare(`INSERT INTO creators (id, name, active) VALUES (?, ?, 1)`);
      seedQuery.run('recCreatorAlpha', 'Creator Alpha');
      seedQuery.run('recCreatorBeta', 'Creator Beta');
      seedQuery.run('recCreatorGamma', 'Creator Gamma');
    }
    
    logger.info('SQLite tables and migrations initialized and seeded.');
  }
}

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  if (!pgPool && !sqliteDb) {
    await initDb();
  }
  
  if (pgPool) {
    const res = await pgPool.query(sql, params);
    return res.rows;
  } else if (sqliteDb) {
    const translatedSql = sql.replace(/\$\d+/g, '?');
    const cleanParams = params.map(p => {
      if (p instanceof Date) {
        return p.toISOString();
      }
      if (typeof p === 'boolean') {
        return p ? 1 : 0;
      }
      return p;
    });

    const isSelect = translatedSql.trim().toLowerCase().startsWith('select');
    if (isSelect) {
      const stmt = sqliteDb.prepare(translatedSql);
      const rows = stmt.all(...cleanParams) as T[];
      return rows;
    } else {
      const stmt = sqliteDb.prepare(translatedSql);
      stmt.run(...cleanParams);
      return [] as T[];
    }
  }
  throw new Error('Database connection is not initialized');
}

export async function runTransaction<T>(
  callback: (clientQuery: <R = any>(sql: string, params?: any[]) => Promise<R[]>) => Promise<T>
): Promise<T> {
  if (!pgPool && !sqliteDb) {
    await initDb();
  }
  
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const clientQuery = async <R = any>(sql: string, params: any[] = []): Promise<R[]> => {
        const res = await client.query(sql, params);
        return res.rows;
      };
      const result = await callback(clientQuery);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else if (sqliteDb) {
    try {
      sqliteDb.exec('BEGIN TRANSACTION');
      const clientQuery = async <R = any>(sql: string, params: any[] = []): Promise<R[]> => {
        const translatedSql = sql.replace(/\$\d+/g, '?');
        const cleanParams = params.map(p => {
          if (p instanceof Date) return p.toISOString();
          if (typeof p === 'boolean') return p ? 1 : 0;
          return p;
        });
        const isSelect = translatedSql.trim().toLowerCase().startsWith('select');
        const stmt = sqliteDb!.prepare(translatedSql);
        if (isSelect) {
          return stmt.all(...cleanParams) as R[];
        } else {
          stmt.run(...cleanParams);
          return [] as R[];
        }
      };
      const result = await callback(clientQuery);
      sqliteDb.exec('COMMIT');
      return result;
    } catch (err) {
      sqliteDb.exec('ROLLBACK');
      throw err;
    }
  }
  throw new Error('Database connection is not initialized');
}

export async function generateSubmissionId(): Promise<string> {
  if (pgPool) {
    const res = await pgPool.query("SELECT nextval('submission_id_seq') as seq");
    const seqNum = res.rows[0].seq;
    return `SUB-${String(seqNum).padStart(6, '0')}`;
  } else {
    // SQLite fallback using high-resolution timestamp suffix to prevent parallel write collisions
    const countRows = await query("SELECT COUNT(*) as count FROM submissions");
    const count = (countRows[0] as any).count || 0;
    const nextSeq = count + 1;
    return `SUB-${String(nextSeq).padStart(6, '0')}`;
  }
}

export async function closeDb(): Promise<void> {
  if (pgPool) {
    logger.info('Closing PostgreSQL connection pool...');
    await pgPool.end();
    pgPool = null;
  }
  if (sqliteDb) {
    logger.info('Closing SQLite database...');
    try {
      sqliteDb.close();
    } catch (err) {
      // ignore
    }
    sqliteDb = null;
  }
}

