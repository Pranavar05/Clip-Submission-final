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
      let activeCreators: { id: string; name: string }[] = [];

      logger.info(`Attempting to fetch creators from ${config.airtable.creatorsTable} table...`);
      const fetchCreatorsOp = () => new Promise<{ id: string; name: string }[]>((resolve, reject) => {
        const records: { id: string; name: string }[] = [];
        base(config.airtable.creatorsTable)
          .select({
            // Fetch if Status is not Inactive (includes empty/blank and Active)
            filterByFormula: `NOT({Status} = 'Inactive')`,
            fields: ['Streamer/Creator', 'Campaign Name']
          })
          .eachPage(
            (pageRecords, fetchNextPage) => {
              pageRecords.forEach(rec => {
                const name = (rec.get('Streamer/Creator') || rec.get('Campaign Name')) as string;
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

      activeCreators = await this.executeWithRetry(fetchCreatorsOp);
      logger.info(`Fetched ${activeCreators.length} creators from ${config.airtable.creatorsTable} table.`);

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
    } catch (error: any) {
      logger.error('Failed to fetch creators list from Airtable:', error.message);
      
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
      'Creator': [payload.creatorId],
      'Video URL': videoFileUrl,
    };

    // Attempt to link Clipper if the user's Discord ID is matched in Team Members
    try {
      const member = await this.getTeamMemberByDiscordId(payload.userId);
      if (member?.id) {
        fields['Clipper'] = [member.id];
      }
    } catch {
      // Ignore if Clipper lookup fails or column doesn't exist
    }

    logger.info(`Submitting record in Airtable for user ID: ${payload.userId}, Submission ID: ${payload.submissionId}`);
    logger.info(`Airtable write target table: "${config.airtable.submissionsTable}", fields: ${JSON.stringify(Object.keys(fields))}`);

    const writeOp = () => new Promise<string>((resolve, reject) => {
      base(config.airtable.submissionsTable).create([{ fields }], (err: any, records: any) => {
        if (err) {
          logger.error(`Airtable API create error: ${err.message}`, { statusCode: err.statusCode, error: err.error, type: err.type });
          // Handle unknown field errors by stripping the offending field and retrying
          const unknownFieldMatch = err.message?.match(/Unknown field name:\s*"([^"]+)"/);
          if (unknownFieldMatch) {
            const badField = unknownFieldMatch[1];
            logger.warn(`Airtable Submissions table is missing the "${badField}" field. Retrying without it...`);
            const retryFields = { ...fields };
            delete retryFields[badField];
            base(config.airtable.submissionsTable).create([{ fields: retryFields }], (err2: any, records2: any) => {
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
   * Updates review status and manager fields in Airtable.
   */
  static async updateSubmissionReviewStatus(
    submissionId: string,
    status: 'Completed' | 'Rejected',
    managerName: string,
    note?: string,
    postedUrl?: string,
    platform?: string
  ): Promise<void> {
    if (config.mockAirtable) {
      logger.info(`[MOCK AIRTABLE] Simulating update review status for ID: ${submissionId} to ${status} by ${managerName}`);
      return;
    }

    try {
      const base = this.getBase();
      
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
        logger.warn(`Could not update review status in Airtable: Submission ID ${submissionId} not found.`);
        return;
      }

      // Manager column is a Single line text field — write the name directly as a string
      const fields: Record<string, any> = {
        'Queue Status': status,
        'Manager': managerName
      };

      if (note) {
        fields['Note'] = note;
      }
      if (postedUrl) {
        fields['Posted URL'] = postedUrl;
      }
      if (platform) {
        fields['Platform'] = platform;
      }

      const updateOp = () => new Promise<void>((resolve, reject) => {
        base(config.airtable.submissionsTable).update(
          [{ id: recordId, fields }],
          (err: any) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      await this.executeWithRetry(updateOp);
      logger.info(`Successfully updated review status in Airtable for Submission ID: ${submissionId} to ${status} by ${managerName}`);
    } catch (error: any) {
      logger.error(`Failed to update review status in Airtable for Submission ID ${submissionId}:`, error);
    }
  }

  /**
   * Fetches leaderboard from Airtable View "Leaderboard" or sorted table.
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
        // Try querying the View "Leaderboard" first with valid fields
        base(config.airtable.submissionsTable)
          .select({
            view: 'Leaderboard',
            maxRecords: limit,
            fields: ['Submission ID', 'Views', 'Platform']
          })
          .firstPage((err, records) => {
            if (err) {
              logger.warn(`Failed to query view "Leaderboard" (${err.message}). Trying sorted table query...`);
              base(config.airtable.submissionsTable)
                .select({
                  maxRecords: limit,
                  sort: [{ field: 'Views', direction: 'desc' }],
                  fields: ['Submission ID', 'Views', 'Platform']
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
      
      // Fetch local DB details to join discord_username, user_id, clip_type
      const subIds = records.map(r => r.get('Submission ID') as string).filter(Boolean);
      let localMap = new Map<string, any>();
      if (subIds.length > 0) {
        const localRows = await query<any>(
          `SELECT id, discord_username, user_id, clip_type FROM submissions WHERE id = ANY($1::text[])`,
          [subIds]
        ).catch(() => []);
        localRows.forEach(row => localMap.set(row.id, row));
      }

      return records.map(r => {
        const subId = r.get('Submission ID') as string;
        const local = localMap.get(subId) || {};
        return {
          id: subId,
          discord_username: local.discord_username || 'Unknown Clipper',
          user_id: local.user_id || '',
          clip_type: local.clip_type || 'Clip',
          view_count: r.get('Views') as number || 0
        };
      });
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
   * Fetches active campaigns/creators with their rates and status.
   */
  static async getActiveCampaignsWithRates(): Promise<{ id: string; name: string; rate: number; status: string }[]> {
    if (config.mockAirtable) {
      logger.info('[MOCK AIRTABLE] Fetching active campaigns with rates');
      const rows = await query('SELECT id, name FROM creators WHERE active = true OR active = 1');
      return rows.map(r => ({ id: r.id, name: r.name, rate: 150, status: 'Active' }));
    }

    try {
      const base = this.getBase();
      let activeCampaigns: { id: string; name: string; rate: number; status: string }[] = [];

      logger.info(`Fetching active campaigns and rates from ${config.airtable.creatorsTable} table...`);
      const fetchOp = () => new Promise<{ id: string; name: string; rate: number; status: string }[]>((resolve, reject) => {
        const records: { id: string; name: string; rate: number; status: string }[] = [];
        base(config.airtable.creatorsTable)
          .select({
            filterByFormula: `NOT({Status} = 'Inactive')`,
            fields: ['Streamer/Creator', 'Campaign Name', 'Rate Per Million ($)', 'Status']
          })
          .eachPage(
            (pageRecords, fetchNextPage) => {
              pageRecords.forEach(rec => {
                const name = (rec.get('Streamer/Creator') || rec.get('Campaign Name')) as string;
                const rate = rec.get('Rate Per Million ($)') as number || 0;
                const status = rec.get('Status') as string || 'Active';
                if (name) records.push({ id: rec.id, name, rate, status });
              });
              fetchNextPage();
            },
            (err) => {
              if (err) reject(err);
              else resolve(records);
            }
          );
      });

      activeCampaigns = await this.executeWithRetry(fetchOp);
      return activeCampaigns;
    } catch (error: any) {
      logger.error('Failed to fetch active campaigns with rates:', error?.message || error);
      throw error;
    }
  }

  /**
   * Looks up a team member by their Discord User ID.
   */
  static async getTeamMemberByDiscordId(discordUserId: string): Promise<{ id: string; name: string } | null> {
    if (config.mockAirtable) {
      return null;
    }
    try {
      const base = this.getBase();
      const findOp = () => new Promise<{ id: string; name: string } | null>((resolve, reject) => {
        base(config.airtable.teamMembersTable)
          .select({
            filterByFormula: `{Discord User ID} = '${discordUserId}'`,
            maxRecords: 1
          })
          .firstPage((err, records) => {
            if (err) reject(err);
            else resolve(records && records.length > 0 ? { id: records[0].id, name: records[0].get('Name') as string } : null);
          });
      });
      return await this.executeWithRetry(findOp);
    } catch (err: any) {
      // Gracefully handle missing Discord User ID column in Team Members table
      logger.info(`Team Member lookup by Discord User ID skipped for ${discordUserId}`);
      return null;
    }
  }

  /**
   * Fetches a detailed payout and views summary for a user.
   */
  static async getUserPayoutSummary(discordUserId: string): Promise<{
    totalClipperPayout: number;
    totalAMPayout: number;
    totalPayout: number;
    totalViews: number;
    clipCount: number;
    clips: {
      id: string;
      creatorName: string;
      platform: string;
      clipType: string;
      views: number;
      clipperPayout: number;
      amPayout: number;
      totalPayout: number;
      rateUsed: number;
      submittedAt: string;
    }[];
  }> {
    const emptySummary = {
      totalClipperPayout: 0,
      totalAMPayout: 0,
      totalPayout: 0,
      totalViews: 0,
      clipCount: 0,
      clips: []
    };

    if (config.mockAirtable) {
      const dbClips = await query<any>(
        `SELECT c.id, c.clip_type, c.submitted_at, c.creator_id, cr.name as creator_name,
                COALESCE(v.count, 0) as view_count
         FROM submissions c
         LEFT JOIN view_counts v ON c.id = v.submission_id
         LEFT JOIN creators cr ON c.creator_id = cr.id
         WHERE c.user_id = $1
         ORDER BY c.submitted_at DESC`,
        [discordUserId]
      );

      const clips = dbClips.map(c => {
        const views = c.view_count || 0;
        const rateUsed = 150;
        const totalPayout = (views / 1_000_000) * rateUsed;
        const clipperPayout = totalPayout * 0.3;
        return {
          id: c.id,
          creatorName: c.creator_name || 'Creator Alpha',
          platform: 'YouTube',
          clipType: c.clip_type || 'Stolen',
          views,
          clipperPayout: Math.round(clipperPayout * 100) / 100,
          amPayout: 0,
          totalPayout: Math.round(totalPayout * 100) / 100,
          rateUsed,
          submittedAt: c.submitted_at
        };
      });

      const totalClipperPayout = clips.reduce((acc, c) => acc + c.clipperPayout, 0);
      const totalViews = clips.reduce((acc, c) => acc + c.views, 0);

      return {
        totalClipperPayout: Math.round(totalClipperPayout * 100) / 100,
        totalAMPayout: 0,
        totalPayout: Math.round(totalClipperPayout * 100) / 100,
        totalViews,
        clipCount: clips.length,
        clips
      };
    }

    try {
      // Fetch user's local submissions to get Submission IDs
      const dbSubmissions = await query<any>(
        `SELECT c.id, c.clip_type, c.submitted_at, c.creator_id, cr.name as creator_name,
                COALESCE(v.count, 0) as view_count
         FROM submissions c
         LEFT JOIN view_counts v ON c.id = v.submission_id
         LEFT JOIN creators cr ON c.creator_id = cr.id
         WHERE c.user_id = $1
         ORDER BY c.submitted_at DESC`,
        [discordUserId]
      ).catch(() => []);

      if (dbSubmissions.length === 0) {
        return emptySummary;
      }

      const subIds = dbSubmissions.map(s => s.id);
      const creatorMap = new Map<string, string>();
      dbSubmissions.forEach(s => {
        if (s.creator_name) creatorMap.set(s.id, s.creator_name);
      });

      const base = this.getBase();
      let airtableRecords: any[] = [];

      try {
        const formulaParts = subIds.map(id => `{Submission ID} = '${id}'`);
        const formula = formulaParts.length === 1 ? formulaParts[0] : `OR(${formulaParts.join(', ')})`;

        const fetchOp = () => new Promise<any[]>((resolve, reject) => {
          const records: any[] = [];
          base(config.airtable.submissionsTable)
            .select({ filterByFormula: formula })
            .eachPage(
              (pageRecords, fetchNextPage) => {
                records.push(...pageRecords);
                fetchNextPage();
              },
              (err) => {
                if (err) reject(err);
                else resolve(records);
              }
            );
        });
        airtableRecords = await this.executeWithRetry(fetchOp);
      } catch (airtableErr: any) {
        logger.warn(`Fetching user payout summary from Airtable failed, using local DB records:`, airtableErr.message);
      }

      const airtableMap = new Map<string, any>();
      airtableRecords.forEach(rec => {
        const subId = rec.get('Submission ID') as string;
        if (subId) airtableMap.set(subId, rec.fields);
      });

      let totalClipperPayout = 0;
      let totalAMPayout = 0;
      let totalViews = 0;

      const clips = dbSubmissions.map(sub => {
        const atFields = airtableMap.get(sub.id) || {};
        const views = atFields['Views'] !== undefined ? (atFields['Views'] as number) : (sub.view_count || 0);
        const clipperPayout = atFields['Clipper Payout ($)'] as number || 0;
        const amPayout = atFields['AM Payout ($)'] as number || 0;
        const totalPayout = atFields['Total Payout ($)'] as number || (clipperPayout + amPayout);
        const platform = atFields['Platform'] as string || 'YouTube';
        const clipType = sub.clip_type || 'Clip';
        const creatorName = sub.creator_name || 'Creator';
        const submittedAt = sub.submitted_at || new Date().toISOString();

        totalClipperPayout += clipperPayout;
        totalAMPayout += amPayout;
        totalViews += views;

        return {
          id: sub.id,
          creatorName,
          platform,
          clipType,
          views,
          clipperPayout: Math.round(clipperPayout * 100) / 100,
          amPayout: Math.round(amPayout * 100) / 100,
          totalPayout: Math.round(totalPayout * 100) / 100,
          rateUsed: 0,
          submittedAt
        };
      });

      return {
        totalClipperPayout: Math.round(totalClipperPayout * 100) / 100,
        totalAMPayout: Math.round(totalAMPayout * 100) / 100,
        totalPayout: Math.round((totalClipperPayout + totalAMPayout) * 100) / 100,
        totalViews,
        clipCount: clips.length,
        clips
      };
    } catch (error: any) {
      logger.error(`Failed to generate user payout summary for ${discordUserId}:`, error);
      return emptySummary;
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
        base(config.airtable.teamMembersTable)
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

