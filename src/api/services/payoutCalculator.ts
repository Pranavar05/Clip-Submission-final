import Airtable from 'airtable';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

// Load pure payout calculator engine
const payoutCalcEngine = require('../../../new-payout-cal/payout_calculator.js');

let isCalculating = false;

// Initialize Airtable base
function getBase(): Airtable.Base {
  if (!config.airtable.apiKey || !config.airtable.baseId) {
    throw new Error('Airtable configuration missing (apiKey or baseId).');
  }
  return new Airtable({ apiKey: config.airtable.apiKey }).base(config.airtable.baseId);
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
    let chunk = updates.slice(i, i + CHUNK_SIZE);
    let attempts = 0;
    while (chunk.length > 0 && attempts < 5) {
      try {
        await new Promise<void>((resolve, reject) => {
          base(table).update(chunk, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
        break; // Success
      } catch (err: any) {
        const unknownFieldMatch = err.message?.match(/Unknown field name:\s*"([^"]+)"/);
        if (unknownFieldMatch) {
          const badField = unknownFieldMatch[1];
          logger.warn(`Airtable ${table} table is missing field "${badField}". Retrying batch update without it...`);
          chunk = chunk.map(item => {
            const copy = { ...item.fields };
            delete copy[badField];
            return { id: item.id, fields: copy };
          });
          attempts++;
        } else {
          logger.error(`Airtable batch update failed: ${err.message}`);
          break;
        }
      }
    }
  }
}

// Diagnostic summary returned by calculatePayouts
export interface PayoutResult {
  totalRecords: number;
  skippedNoViews: number;
  skippedViewsUnchanged: number;
  skippedNoCreator: number;
  skippedNoClipType: number;
  errors: number;
  calculated: number;
  written: number;
  errorMessages: string[];
}

// Main payout calculation function
export async function calculatePayouts(): Promise<PayoutResult> {
  const result: PayoutResult = {
    totalRecords: 0,
    skippedNoViews: 0,
    skippedViewsUnchanged: 0,
    skippedNoCreator: 0,
    skippedNoClipType: 0,
    errors: 0,
    calculated: 0,
    written: 0,
    errorMessages: [],
  };

  if (isCalculating) {
    logger.info('Payout calculation is already in progress. Skipping this pass.');
    return result;
  }
  isCalculating = true;
  logger.info('Starting payout calculation pass...');

  // Validate split table definitions at startup
  const splitProblems = payoutCalcEngine.validateSplits();
  if (splitProblems.length > 0) {
    logger.error(`Split table configuration errors:\n${splitProblems.join('\n')}`);
  }

  try {
    const [submissions, creatorRecords] = await Promise.all([
      listAllAirtableRecords(config.airtable.submissionsTable),
      listAllAirtableRecords(config.airtable.creatorsTable),
    ]);

    result.totalRecords = submissions.length;
    logger.info(`Fetched ${submissions.length} submissions and ${creatorRecords.length} creator records from Airtable.`);

    // Create a lookup map for Creators and their rates from Creators table
    const rateMap = new Map<string, number>();
    for (const record of creatorRecords) {
      const rate = record.fields['Rate Per Million ($)'] as number || 0;
      const creatorName = record.fields['Streamer/Creator'] || record.fields['Name'] || 'Unknown';
      rateMap.set(record.id, rate);
      logger.info(`Creator ${record.id} (${creatorName}): Rate = $${rate}/mil`);
    }

    // Load local DB submissions to resolve clip_type if Clip Type column is missing in Airtable
    const { query: dbQuery } = require('../../shared/db.js');
    const localDbSubmissions = await dbQuery('SELECT id, clip_type FROM submissions').catch(() => []);
    const localClipTypeMap = new Map<string, string>();
    localDbSubmissions.forEach((s: any) => localClipTypeMap.set(s.id, s.clip_type));

    const updates: { id: string; fields: any }[] = [];

    for (const record of submissions) {
      const f = record.fields;
      const subId = f['Submission ID'] || record.id;
      const views = f['Views'] as number;

      // Skip if views are missing, undefined, null, 0, or NaN
      if (views === undefined || views === null || views === 0 || isNaN(views)) {
        result.skippedNoViews++;
        continue;
      }

      const lastCalculatedViews = f['Last Calculated Views'] as number;

      // Skip if views haven't changed since last calculation
      if (views === lastCalculatedViews) {
        result.skippedViewsUnchanged++;
        continue;
      }

      try {
        const creatorLinks = f['Creator'] as string[];
        if (!creatorLinks || creatorLinks.length === 0) {
          logger.warn(`Skipping submission ${subId}: No Creator linked.`);
          result.skippedNoCreator++;
          continue;
        }

        const ratePerMillion = rateMap.get(creatorLinks[0]) || 0;
        const platform = f['Platform'] as string || 'YouTube';
        const clipType = (f['Clip Type'] as string) || localClipTypeMap.get(subId) || 'Raw';
        const isAMOwnClip = f["Is AM's Own Clip"] === true;
        const editorLinks = f['Editor'] as string[];
        const clipperLinks = f['Clipper'] as string[];
        const hasEditor = !!(editorLinks && editorLinks.length > 0);
        const hasClipper = !!(clipperLinks && clipperLinks.length > 0);

        logger.info(`Processing ${subId}: Views=${views}, Creator=${creatorLinks[0]}, Rate=$${ratePerMillion}/mil, ClipType=${clipType}, Platform=${platform}`);

        // Execute pure payout engine calculation
        const payoutCalc = payoutCalcEngine.calculatePayout({
          views,
          ratePerMillion,
          clipType,
          platform,
          isAMOwnClip,
          hasEditor,
          hasClipper,
        });

        if (payoutCalc.warnings && payoutCalc.warnings.length > 0) {
          payoutCalc.warnings.forEach((w: string) => logger.warn(`Submission ${subId} warning: ${w}`));
        }

        updates.push({
          id: record.id,
          fields: {
            'Clipper %': payoutCalc.percentages.clipper,
            'Editor %': payoutCalc.percentages.editor,
            'AM %': payoutCalc.percentages.accountManager,
            'Owner %': payoutCalc.percentages.agency,
            'Clipper Payout ($)': payoutCalc.payouts.clipper,
            'Editor Payout ($)': payoutCalc.payouts.editor,
            'AM Payout ($)': payoutCalc.payouts.accountManager,
            'Owner Payout ($)': payoutCalc.payouts.agency,
            'Total Payout ($)': payoutCalc.total,
            'Last Calculated Views': views,
            'Rate Used ($/mil)': ratePerMillion,
          }
        });

        result.calculated++;
        logger.info(`Calculated payout for ${subId}: Total $${payoutCalc.total.toFixed(2)} (Clipper: $${payoutCalc.payouts.clipper.toFixed(2)}, AM: $${payoutCalc.payouts.accountManager.toFixed(2)}, Agency/Owner: $${payoutCalc.payouts.agency.toFixed(2)})`);
      } catch (err: any) {
        result.errors++;
        const errMsg = `${subId}: ${err.message}`;
        result.errorMessages.push(errMsg);
        logger.error(`Failed to calculate payout for submission ${subId}: ${err.message}`);
      }
    }

    if (updates.length > 0) {
      logger.info(`Writing ${updates.length} payout updates to Airtable...`);
      await updateAirtableRecordsBatched(config.airtable.submissionsTable, updates);
      result.written = updates.length;
      logger.info('Successfully updated payouts in Airtable.');
    } else {
      logger.info('No payouts needed calculation.');
    }

  } catch (err: any) {
    logger.error('Error during payout calculation pass:', err.message);
    result.errorMessages.push(err.message);
  } finally {
    isCalculating = false;
  }

  return result;
}

