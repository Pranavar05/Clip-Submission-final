import Airtable from 'airtable';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

let isCalculating = false;

// Initialize Airtable base
function getBase(): Airtable.Base {
  if (!config.airtable.apiKey || !config.airtable.baseId) {
    throw new Error('Airtable configuration missing (apiKey or baseId).');
  }
  return new Airtable({ apiKey: config.airtable.apiKey }).base(config.airtable.baseId);
}

// Get the splits based on Clip Type, Platform, and AM ownership
function getSplit(clipType: string, platform: string, isAMOwnClip: boolean, hasEditor: boolean) {
  if (isAMOwnClip) {
    if (clipType === 'Stolen') return { clipper: 0, editor: 0, am: 0.7, owner: 0.3 };
    if (clipType === 'Original-Edited') return { clipper: 0, editor: 0, am: 0.8, owner: 0.2 };
    throw new Error(
      `"Is AM's Own Clip" is checked but Clip Type is "${clipType}" — only Stolen or Original-Edited apply.`
    );
  }

  if (clipType === 'Stolen') return { clipper: 0.3, editor: 0, am: 0.4, owner: 0.3 };
  if (clipType === 'Raw') return { clipper: 0.2, editor: 0, am: 0.6, owner: 0.2 };

  if (clipType === 'Raw-Split Edit') {
    if (!hasEditor) {
      throw new Error(
        `Clip Type is "Raw-Split Edit" but no Editor is linked. An Editor must be linked for this clip type.`
      );
    }
    if (platform === 'YouTube') return { clipper: 0.2, editor: 0.4, am: 0.2, owner: 0.2 };
    return { clipper: 0.2, editor: 0.35, am: 0.25, owner: 0.2 };
  }

  if (clipType === 'Original-Edited') {
    if (platform === 'YouTube') return { clipper: 0.6, editor: 0, am: 0.2, owner: 0.2 };
    return { clipper: 0.55, editor: 0, am: 0.25, owner: 0.2 };
  }

  throw new Error(`Unrecognized Clip Type: "${clipType}"`);
}

// Fetch all records from an Airtable table (handles pagination)
async function listAllAirtableRecords(table: string): Promise<any[]> {
  const base = getBase();
  return new Promise((resolve, reject) => {
    const records: any[] = [];
    base(table)
      .select({ pageSize: 100 })
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
}

// Batch update Airtable records (max 10 records per request)
async function updateAirtableRecordsBatched(table: string, updates: { id: string; fields: any }[]): Promise<void> {
  const base = getBase();
  const CHUNK_SIZE = 10;
  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    try {
      await new Promise<void>((resolve, reject) => {
        base(table).update(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err: any) {
      logger.error(`Airtable batch update failed: ${err.message}`);
    }
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Main payout calculation function
export async function calculatePayouts(): Promise<void> {
  if (isCalculating) {
    logger.info('Payout calculation is already in progress. Skipping this pass.');
    return;
  }
  isCalculating = true;
  logger.info('Starting payout calculation pass...');

  try {
    const [submissions, teamMembers] = await Promise.all([
      listAllAirtableRecords(config.airtable.submissionsTable),
      listAllAirtableRecords(config.airtable.teamMembersTable),
    ]);

    // Create a lookup map for Team Members (Campaigns) and their rates
    const rateMap = new Map<string, number>();
    for (const record of teamMembers) {
      const rate = record.fields['Rate Per Million ($)'] as number || 0;
      rateMap.set(record.id, rate);
    }

    const updates: { id: string; fields: any }[] = [];

    for (const record of submissions) {
      const f = record.fields;
      const views = f['Views'] as number || 0;
      const lastCalculatedViews = f['Last Calculated Views'] as number;

      // Skip if views haven't changed since last calculation
      if (views === lastCalculatedViews) {
        continue;
      }

      try {
        const campaignLinks = f['Campaign'] as string[];
        if (!campaignLinks || campaignLinks.length === 0) {
          logger.warn(`Skipping submission ${record.id} / ${f['Submission ID']}: No Campaign/Creator linked.`);
          continue;
        }

        const ratePerMillion = rateMap.get(campaignLinks[0]) || 0;
        const platform = f['Platform'] as string || 'YouTube';
        const clipType = f['Clip Type'] as string;
        const isAMOwnClip = f["Is AM's Own Clip"] === true;
        const editorLinks = f['Editor'] as string[];
        const hasEditor = !!(editorLinks && editorLinks.length > 0);

        if (!clipType) {
          logger.warn(`Skipping submission ${record.id}: Clip Type is missing.`);
          continue;
        }

        const split = getSplit(clipType, platform, isAMOwnClip, hasEditor);
        const totalPayout = (views / 1_000_000) * ratePerMillion;

        const clipperPayout = totalPayout * split.clipper;
        const editorPayout = totalPayout * split.editor;
        const amPayout = totalPayout * split.am;
        const ownerPayout = totalPayout * split.owner;

        updates.push({
          id: record.id,
          fields: {
            'Clipper %': split.clipper * 100,
            'Editor %': split.editor * 100,
            'AM %': split.am * 100,
            'Owner %': split.owner * 100,
            'Clipper Payout ($)': round2(clipperPayout),
            'Editor Payout ($)': round2(editorPayout),
            'AM Payout ($)': round2(amPayout),
            'Owner Payout ($)': round2(ownerPayout),
            'Total Payout ($)': round2(totalPayout),
            'Last Calculated Views': views,
            'Rate Used ($/mil)': ratePerMillion,
          }
        });

        logger.info(`Calculated payout for ${f['Submission ID'] || record.id}: Total $${totalPayout.toFixed(2)} (Clipper: $${clipperPayout.toFixed(2)}, AM: $${amPayout.toFixed(2)})`);
      } catch (err: any) {
        logger.error(`Failed to calculate payout for submission ${f['Submission ID'] || record.id}: ${err.message}`);
      }
    }

    if (updates.length > 0) {
      logger.info(`Writing ${updates.length} payout updates to Airtable...`);
      await updateAirtableRecordsBatched(config.airtable.submissionsTable, updates);
      logger.info('Successfully updated payouts in Airtable.');
    } else {
      logger.info('No payouts needed calculation.');
    }

  } catch (err: any) {
    logger.error('Error during payout calculation pass:', err.message);
  } finally {
    isCalculating = false;
  }
}
