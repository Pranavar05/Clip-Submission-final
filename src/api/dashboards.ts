import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import basicAuth from 'express-basic-auth';
import { queue } from './services/queue.js';
import { config } from '../shared/config.js';

export function setupDashboards(app: any) {
  if (config.isDev) {
    // In development, you might not want basic auth
  }

  // Basic auth middleware for /admin routes
  const adminAuth = basicAuth({
    users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'admin123' },
    challenge: true,
    realm: 'Admin Area'
  });

  // Setup BullMQ Dashboard
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queue');

  const queues: any[] = [];
  if (queue.bullQueue) {
    queues.push(new BullMQAdapter(queue.bullQueue));
  }

  createBullBoard({
    queues,
    serverAdapter: serverAdapter,
  });

  // Apply basic auth to the dashboard
  app.use('/admin/queue', adminAuth, serverAdapter.getRouter());
}
