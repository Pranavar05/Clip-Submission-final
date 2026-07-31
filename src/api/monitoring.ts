import client from 'prom-client';
import { Request, Response } from 'express';
import { logger } from '../shared/logger.js';

// Initialize default system metrics
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'clip_system_' });

// Define custom metrics
export const uploadCounter = new client.Counter({
  name: 'clip_system_uploads_total',
  help: 'Total number of clip uploads attempted',
  labelNames: ['status', 'type']
});

export const uploadSizeHistogram = new client.Histogram({
  name: 'clip_system_upload_size_bytes',
  help: 'Histogram of uploaded clip sizes',
  buckets: [1e6, 10e6, 50e6, 100e6, 200e6, 500e6] // 1MB, 10MB, 50MB, 100MB, 200MB, 500MB
});

export const queueProcessingDuration = new client.Histogram({
  name: 'clip_system_queue_processing_duration_seconds',
  help: 'Duration of queue job processing in seconds',
  labelNames: ['job_name', 'status']
});

/**
 * Express handler to serve Prometheus metrics
 */
export async function handleMetrics(req: Request, res: Response): Promise<void> {
  try {
    res.set('Content-Type', client.register.contentType);
    const metrics = await client.register.metrics();
    res.end(metrics);
  } catch (err: any) {
    logger.error('Failed to generate Prometheus metrics', { error: err.message });
    res.status(500).end('Failed to generate metrics');
  }
}
