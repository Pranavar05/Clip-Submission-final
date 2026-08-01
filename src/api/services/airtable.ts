import Airtable from 'airtable';
import { logger } from '../../shared/logger.js';
import { SubmissionPayload } from '../../shared/types.js';
import { config } from '../../shared/config.js';
import { query } from '../../shared/db.js';

// Cache structure for dynamic active creators list
interface CreatorsCache {
  data: { id: string; name: string }[];
  lastUpdated: number;
}

// In-memory sliding window rate limiter specifically for Airtable reads
class AirtableLimiter {
  private requestTimes: number[] = [];
  private maxRequests = 4; // Target 4 requests per second
  private intervalMs = 1000;

  public async acquire(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const now = Date.now();
        this.requestTimes = this.requestTimes.filter(t => now - t < this.intervalMs);

        if (this.requestTimes.length < this.maxRequests) {
          this.requestTimes.push(now);
          resolve();
        } else {
          const oldest = this.requestTimes[0];
          const wait = this.intervalMs - (now - oldest);
          setTimeout(check, Math.max(wait, 10));
        }
      };
      check();
    });
  }
}

export class AirtableService {
  private static baseInstance: Airtable.Base;
  private static limiter = new AirtableLimiter();
  private static creatorsCache: CreatorsCache | null = null;
  private static CACHE_TTL_MS = 10 * 1000; // 10 seconds cache TTL for responsive webpage updates
  private static lastSyncTime = 0;
  private static SYNC_COOLDOWN_MS = 30 * 1000; // 30 seconds

  private static getBase(): Airtable.Base {
    if (!this.baseInstance) {
      if (!config.airtable.apiKey || !config.airtable.baseId) {
        throw new Error('Airtable configuration missing (apiKey or baseId).');
      }
      this.baseInstance = new Airtable({ apiKey: config.airtable.apiKey }).base(config.airtable.baseId);
    }
    return this.baseInstance;
  }

  /**
   * Safe execution wrapper utilizing retry-logic and concurrency controls
   */
  private static async executeWithRetry<T>(
    operation: () => Promise<T>,
    retries = 3,
    delayMs = 500
  ): Promise<T> {
    await this.limiter.acquire();
    try {
      return await operation();
    } catch (error: any) {
      const status = error.statusCode || error.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600) || !status;

      if (retries > 0 && isRetryable) {
        logger.warn(`Airtable request encountered retryable error (Status: ${status}). Retrying in ${delayMs}ms... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return this.executeWithRetry(operation, retries - 1, delayMs * 2);
      }
      throw error;
    }
  }

  /**
   * Fetches active creators list, using cache or stale fallback on error.
   */
  static async getActiveCreators(): Promise<{ id: string; name: string }[]> {
    // MOCK MODE: Pull creators from shared database table
    if (config.mockAirtable) {
      logger.info('[MOCK AIRTABLE] Fetching creators from shared DB creators table');
      const rows = await query('SELECT id, name FROM creators WHERE active = true OR active = 1');
      return rows.map(r => ({ id: r.id, name: r.name }));
    }

    // REAL AIRTABLE MODE
    const now = Date.now();
    if (this.creatorsCache && (now - this.creatorsCache.lastUpdated < this.CACHE_TTL_MS)) {
      return this.creatorsCache.data;
    }

    try {
      const base = this.getBase();
      
      // Strategy: Try dedicated Creators table first. If it doesn't exist (403/404),
      // fall back to pulling unique creator names from the Campaigns table.
      let activeCreators: { id: string; name: string }[] = [];

      try {
        logger.info('Attempting to fetch creators from dedicated Creators table...');
        const fetchCreatorsOp = (useFilter: boolean) => new Promise<{ id: string; name: string }[]>((resolve, reject) => {
          const records: { id: string; name: string }[] = [];
          const selectOptions: any = { fields: ['Name'] };
          if (useFilter) {
            selectOptions.filterByFormula = `{Status} = 'Active'`;
          }
          
          base(config.airtable.creatorsTable)
            .select(selectOptions)
            .eachPage(
              (pageRecords, fetchNextPage) => {
                pageRecords.forEach(rec => {
                  const name = rec.get('Name') as string;
                  if (name) records.push({ id: rec.id, name });
                });
                fetchNextPage();
              },
              (err) => {
                if (err) reject(err);
                else resolve(records);
              }
            );
        });

        try {
          activeCreators = await this.executeWithRetry(() => fetchCreatorsOp(true), 1);
        } catch (filterErr: any) {
          logger.warn(`Failed to fetch creators with Status filter (${filterErr.message}). Retrying without filter...`);
          activeCreators = await this.executeWithRetry(() => fetchCreatorsOp(false), 1);
        }
        logger.info(`Fetched ${activeCreators.length} creators from Creators table.`);
      } catch (creatorsErr: any) {
        // Creators table doesn't exist yet — fall back to Campaigns table
        logger.warn(`Creators table not available (${creatorsErr.statusCode || creatorsErr.message}). Falling back to Campaigns table...`);
        
        const fetchCampaignsOp = () => new Promise<{ id: string; name: string }[]>((resolve, reject) => {
          const records: { id: string; name: string }[] = [];
          const seenNames = new Set<string>();
          
          base('Campaigns')
            .select({
              filterByFormula: `{Status} = 'Active'`,
              fields: ['Streamer/Creator', 'Campaign Name']
            })
            .eachPage(
              (pageRecords, fetchNextPage) => {
                pageRecords.forEach(rec => {
                  const creatorName = (rec.get('Streamer/Creator') as string || '').trim();
                  if (creatorName && !seenNames.has(creatorName)) {
                    seenNames.add(creatorName);
                    records.push({ id: rec.id, name: creatorName });
                  }
                });
                fetchNextPage();
              },
              (err) => {
                if (err) reject(err);
                else resolve(records);
              }
            );
        });
        activeCreators = await this.executeWithRetry(fetchCampaignsOp);
        logger.info(`Fetched ${activeCreators.length} unique creators from Campaigns fallback.`);
      }
      
      // Sync fetched creators to local database to satisfy foreign key constraints
      for (const creator of activeCreators) {
        await query(
          `INSERT INTO creators (id, name, active) 
           VALUES ($1, $2, true) 
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = true`,
          [creator.id, creator.name]
        );
      }

      this.creatorsCache = {
        data: activeCreators,
        lastUpdated: now
      };

      logger.info(`Successfully cached ${activeCreators.length} active creators.`);
      return activeCreators;
    } catch (error) {
      logger.error('Failed to fetch creators list from Airtable:', error);
      
      if (this.creatorsCache) {
        logger.warn('Serving stale creators list cache from memory.');
        return this.creatorsCache.data;
      }
      throw new Error('Airtable creators registry is currently unreachable.');
    }
  }

  /**
   * Verifies if a submissionId (UUID/Short ID) already exists in Airtable/Mock DB
   */
  static async isDuplicateSubmission(submissionId: string): Promise<boolean> {
    // MOCK MODE: Check database submissions table
    if (config.mockAirtable) {
      const rows = await query('SELECT COUNT(*) as count FROM submissions WHERE id = $1', [submissionId]);
      const count = parseInt(rows[0].count, 10);
      return count > 0;
    }

    // REAL AIRTABLE MODE
    try {
      const base = this.getBase();
      
      const checkOp = () => new Promise<boolean>((resolve, reject) => {
        base(config.airtable.submissionsTable)
          .select({
            filterByFormula: `{Submission ID} = '${submissionId}'`,
            maxRecords: 1
          })
          .firstPage((err, records) => {
            if (err) reject(err);
            else resolve(records ? records.length > 0 : false);
          });
      });

      return await this.executeWithRetry(checkOp);
    } catch (error) {
      logger.error('Failed checking duplicate submissions in Airtable:', error);
      throw error;
    }
  }

  /**
   * Saves a new clip submission record in Airtable or simulates it.
   */
  static async saveSubmissionRecord(
    payload: SubmissionPayload,
    videoFileUrl: string,
    videoSizeBytes: number,
    videoFileName: string
  ): Promise<string> {
    // MOCK MODE: Simulation
    if (config.mockAirtable) {
      logger.info(`[MOCK AIRTABLE] Simulating record save. ID: ${payload.submissionId}`);
      // Make sure the row exists/is updated in database (e.g. status)
      await query(
        `UPDATE submissions 
         SET status = 'READY_FOR_REVIEW', updated_at = $1 
         WHERE id = $2`,
        [new Date(), payload.submissionId]
      );
      
      logger.info(`[MOCK AIRTABLE] Successfully simulated saving record for ID: ${payload.submissionId}`);
      return `recMock_${payload.submissionId.replace(/-/g, '').substring(0, 10)}`;
    }

    // REAL AIRTABLE MODE
    const base = this.getBase();
    const fields: Record<string, any> = {
      'Submission ID': payload.submissionId,
      'Clip Type': payload.clipType,
      'Discord User ID': payload.userId,
      'Discord Username': payload.discordUser,
      'Discord Channel ID': payload.channelId,
      'Creator': [payload.creatorId],
      'R2 File URL': videoFileUrl,
      'Original Filename': videoFileName,
      'File Size (MB)': Number((videoSizeBytes / (1024 * 1024)).toFixed(2)),
      'Description': payload.description || '',
      'Queue Status': 'Completed',
      'Created At': payload.submittedAt,
      'Updated At': new Date().toISOString()
    };

    logger.info(`Submitting record in Airtable for user ID: ${payload.userId}, Submission ID: ${payload.submissionId}`);
    logger.info(`Airtable write target table: "${config.airtable.submissionsTable}", fields: ${JSON.stringify(Object.keys(fields))}`);

    const writeOp = () => new Promise<string>((resolve, reject) => {
      base(config.airtable.submissionsTable).create([{ fields }], (err: any, records: any) => {
        if (err) {
          logger.error(`Airtable API create error: ${err.message}`, { statusCode: err.statusCode, error: err.error, type: err.type });
          if (err.message && err.message.includes('Unknown field name: "Description"')) {
            logger.warn('Airtable Submissions table is missing the "Description" field. Retrying without Description field...');
            const { Description, ...fieldsWithoutDesc } = fields;
            base(config.airtable.submissionsTable).create([{ fields: fieldsWithoutDesc }], (err2: any, records2: any) => {
              if (err2) {
                reject(err2);
              } else if (!records2 || records2.length === 0) {
                reject(new Error('Airtable write succeeded but returned no record.'));
              } else {
                resolve(records2[0].id);
              }
            });
          } else {
            reject(err);
          }
        } else if (!records || records.length === 0) {
          reject(new Error('Airtable write succeeded but returned no record.'));
        } else {
          resolve(records[0].id);
        }
      });
    });

    const recordId = await this.executeWithRetry(writeOp);
    logger.info(`Successfully created Airtable submission record. ID: ${recordId}`);
    return recordId;
  }

  /**
   * Updates the Views field for a specific submission in Airtable.
   */
  static async updateSubmissionViews(submissionId: string, views: number): Promise<void> {
    if (config.mockAirtable) {
      logger.info(`[MOCK AIRTABLE] Simulating update views for ID: ${submissionId} to ${views}`);
      return;
    }

    try {
      const base = this.getBase();
      
      // Find the record by Submission ID
      const findOp = () => new Promise<string | null>((resolve, reject) => {
        base(config.airtable.submissionsTable)
          .select({
            filterByFormula: `{Submission ID} = '${submissionId}'`,
            maxRecords: 1
          })
          .firstPage((err, records) => {
            if (err) reject(err);
            else resolve(records && records.length > 0 ? records[0].id : null);
          });
      });

      const recordId = await this.executeWithRetry(findOp);
      if (!recordId) {
        logger.warn(`Could not update views in Airtable: Submission ID ${submissionId} not found.`);
        return;
      }

      // Update the record with new view count
      const updateOp = () => new Promise<void>((resolve, reject) => {
        base(config.airtable.submissionsTable).update(
          [{ id: recordId, fields: { 'Views': views } }],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      await this.executeWithRetry(updateOp);
      logger.info(`Successfully updated views in Airtable for Submission ID: ${submissionId} to ${views}`);
    } catch (error: any) {
      logger.error(`Failed to update views in Airtable for Submission ID ${submissionId}:`, error);
    }
  }

  /**
   * Fetches leaderboard from Airtable View "Leaderboard"
   */
  static async getLeaderboard(limit: number = 10): Promise<any[]> {
    const dbFallback = async () => {
      logger.info('Falling back to database for leaderboard query...');
      return query<any>(
        `SELECT c.id, c.discord_username, c.user_id, c.clip_type, c.description, c.submitted_at,
                COALESCE(v.count, 0) as view_count
         FROM submissions c
         LEFT JOIN view_counts v ON c.id = v.submission_id
         ORDER BY view_count DESC, c.submitted_at ASC
         LIMIT $1`,
        [limit]
      );
    };

    if (config.mockAirtable) {
      return dbFallback();
    }

    try {
      const base = this.getBase();
      const fetchOp = () => new Promise<any[]>((resolve, reject) => {
        // Try querying the View "Leaderboard" first
        base(config.airtable.submissionsTable)
          .select({
            view: 'Leaderboard',
            maxRecords: limit,
            fields: ['Submission ID', 'Discord Username', 'Discord User ID', 'Clip Type', 'Views']
          })
          .firstPage((err, records) => {
            if (err) {
              logger.warn(`Failed to query view "Leaderboard" (${err.message}). Trying sorted table query...`);
              // Try querying the table directly and sorting by Views DESC
              base(config.airtable.submissionsTable)
                .select({
                  maxRecords: limit,
                  sort: [{ field: 'Views', direction: 'desc' }],
                  fields: ['Submission ID', 'Discord Username', 'Discord User ID', 'Clip Type', 'Views']
                })
                .firstPage((err2, records2) => {
                  if (err2) {
                    reject(err2);
                  } else {
                    resolve(records2 ? Array.from(records2) : []);
                  }
                });
            } else {
              resolve(records ? Array.from(records) : []);
            }
          });
      });

      const records = await this.executeWithRetry(fetchOp);
      return records.map(r => ({
        id: r.get('Submission ID') as string,
        discord_username: r.get('Discord Username') as string,
        user_id: r.get('Discord User ID') as string,
        clip_type: r.get('Clip Type') as string,
        view_count: r.get('Views') as number || 0
      }));
    } catch (error: any) {
      logger.error(`Failed to fetch leaderboard from Airtable: ${error.message}`);
      return dbFallback();
    }
  }

  /**
   * Periodically syncs views from Airtable to the local database view_counts table.
   */
  static async syncViewsToDb(): Promise<void> {
    if (config.mockAirtable) {
      return;
    }

    const now = Date.now();
    if (now - this.lastSyncTime < this.SYNC_COOLDOWN_MS) {
      logger.info('Skipping views sync from Airtable (cooldown active)');
      return;
    }
    this.lastSyncTime = now;

    try {
      const base = this.getBase();
      const recordsToSync: { id: string; views: number }[] = [];

      const fetchOp = () => new Promise<void>((resolve, reject) => {
        base(config.airtable.submissionsTable)
          .select({
            fields: ['Submission ID', 'Views']
          })
          .eachPage(
            (pageRecords, fetchNextPage) => {
              pageRecords.forEach(rec => {
                const subId = rec.get('Submission ID') as string;
                const views = rec.get('Views') as number || 0;
                if (subId) {
                  recordsToSync.push({ id: subId, views });
                }
              });
              fetchNextPage();
            },
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
      });

      await this.executeWithRetry(fetchOp);

      logger.info(`Fetched ${recordsToSync.length} submission views from Airtable.`);

      // Get local submissions to prevent foreign key errors
      const localSubmissions = await query<{ id: string }>('SELECT id FROM submissions');
      const localIds = new Set(localSubmissions.map(s => s.id));

      const filteredRecords = recordsToSync.filter(r => localIds.has(r.id));
      logger.info(`Syncing ${filteredRecords.length} views to local DB...`);

      for (const record of filteredRecords) {
        await query(
          `INSERT INTO view_counts (submission_id, count, last_viewed_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT(submission_id) DO UPDATE SET count = EXCLUDED.count, last_viewed_at = CURRENT_TIMESTAMP`,
          [record.id, record.views]
        );
      }
      logger.info('Successfully synced Airtable views to database.');
    } catch (error: any) {
      logger.error('Failed to sync Airtable views to database:', error);
    }
  }

  /**
   * Runs a cheap query to verify database connectivity.
   */
  static async testConnection(): Promise<boolean> {
    if (config.mockAirtable) {
      logger.info('[MOCK AIRTABLE] Database connectivity check simulated - Success');
      return true;
    }

    try {
      const base = this.getBase();
      const testOp = () => new Promise<boolean>((resolve, reject) => {
        base(config.airtable.creatorsTable)
          .select({ maxRecords: 1 })
          .firstPage((err, records) => {
            if (err) reject(err);
            else resolve(true);
          });
      });
      return await this.executeWithRetry(testOp, 1);
    } catch (err) {
      logger.error('Airtable connectivity check failed:', err);
      return false;
    }
  }
}
