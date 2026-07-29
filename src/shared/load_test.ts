import axios from 'axios';
import { logger } from './logger.js';
import { config } from './config.js';
import { encryptToken } from './token.js';

// Setup correlation UUID generator
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function runConcurrencyTest(numRequests: number) {
  logger.info(`====================================================`);
  logger.info(`STARTING LOAD TEST: Simulating ${numRequests} concurrent init+upload flows`);
  logger.info(`====================================================`);
  
  const startTime = Date.now();
  const initialMemory = process.memoryUsage().heapUsed / (1024 * 1024);
  logger.info(`Initial Heap Memory: ${initialMemory.toFixed(2)} MB`);

  // Dummy 50KB video file chunk with valid MP4 ftyp signature
  const dummyBuffer = Buffer.alloc(50 * 1024, 0);
  dummyBuffer.writeUInt32BE(24, 0);       // size: 24
  dummyBuffer.write('ftyp', 4, 'ascii');  // ftyp box
  dummyBuffer.write('mp42', 8, 'ascii');  // brand: mp42

  // Trigger parallel promises — each creates its own token (like a real clipper would)
  const promises = Array.from({ length: numRequests }).map(async (_, idx) => {
    try {
      // 1. Generate a unique token per simulated clipper session (await the async function)
      const validToken = await encryptToken({
        tokenId: generateUUID(),
        userId: `loadtest_user_${idx}`,
        discordUser: `load_tester_${idx}`,
        displayName: `Load Tester ${idx}`,
        serverId: '9876543210',
        channelId: '1527898093733806080',
        expiresAt: Date.now() + 15 * 60 * 1000
      });

      // 2. Step 1: POST /web-submissions/init
      const initResponse = await axios.post(
        `${config.apiBaseUrl}/api/web-submissions/init`,
        {
          creatorId: 'recCreatorAlpha',
          clipType: 'Raw',
          description: `Automated load test run ${idx}`
        },
        {
          headers: {
            'Authorization': `Bearer ${validToken}`,
            'Content-Type': 'application/json'
          },
          validateStatus: () => true
        }
      );

      if (initResponse.status !== 200 || !initResponse.data.submissionId) {
        return { success: false, status: initResponse.status, data: initResponse.data, step: 'init' };
      }

      const submissionId = initResponse.data.submissionId;

      // 3. Step 2: POST /web-submissions/upload/:submissionId
      const formData = new FormData();
      const blob = new Blob([dummyBuffer], { type: 'video/mp4' });
      formData.append('video', blob, `load_test_clip_${idx}.mp4`);

      const uploadResponse = await axios.post(
        `${config.apiBaseUrl}/api/web-submissions/upload/${submissionId}`,
        formData,
        {
          headers: {
            'Authorization': `Bearer ${validToken}`,
          },
          validateStatus: () => true
        }
      );

      return { success: uploadResponse.status === 200, status: uploadResponse.status, data: uploadResponse.data, step: 'upload' };
    } catch (err: any) {
      return { success: false, status: 500, error: err.message, step: 'exception' };
    }
  });

  const results = await Promise.all(promises);
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
  const finalMemory = process.memoryUsage().heapUsed / (1024 * 1024);

  const succeeded = results.filter(r => r.success).length;
  const failed = numRequests - succeeded;

  logger.info(`====================================================`);
  logger.info(`LOAD TEST COMPLETE: ${numRequests} Requests`);
  logger.info(`----------------------------------------------------`);
  logger.info(`Duration: ${elapsedSec} seconds`);
  logger.info(`Succeeded: ${succeeded}`);
  logger.info(`Failed: ${failed}`);
  logger.info(`Memory Delta: ${(finalMemory - initialMemory).toFixed(2)} MB (Final: ${finalMemory.toFixed(2)} MB)`);
  
  if (failed > 0) {
    logger.warn('Sample of failed request logs:', results.filter(r => !r.success).slice(0, 3));
  }
  logger.info(`====================================================\n`);
}

async function startTests() {
  logger.info('Starting Clip Submission System load tests in 3 seconds...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  try {
    // 1. Run 30 concurrent requests
    await runConcurrencyTest(30);

    // 2. Run 50 concurrent requests
    await runConcurrencyTest(50);

    // 3. Run 100 concurrent requests
    await runConcurrencyTest(100);
  } catch (error) {
    logger.error('Load testing suite execution failed:', error);
  }
}

startTests();
