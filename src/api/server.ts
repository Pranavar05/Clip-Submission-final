import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import helmet from 'helmet';
import * as Sentry from '@sentry/node';
import router from './routes.js';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

export function createApiServer(): Express {
  const app: Express = express();

  // 1. Initialize Sentry (if DSN configuration is provided)
  if (config.sentryDsn) {
    logger.info('Initializing Sentry exception monitoring...');
    Sentry.init({
      dsn: config.sentryDsn,
      environment: process.env.NODE_ENV || 'development'
    });
  }

  // 2. HTTP Security Hardening (Helmet)
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Strict CSP: Allow scripts only from self-origin, prevent inline script execution
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"], // unsafe-inline allowed for Google Fonts stylesheet loading
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "media-src": ["'self'", "*"], // Allow video preview from any origin
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'", "https://*.r2.cloudflarestorage.com"]
      }
    }
  }));

  // 3. CORS origin restriction
  app.use(cors({
    origin: config.allowedOrigin === '*' ? '*' : config.allowedOrigin.split(',').map(o => o.trim()),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve static files from /public
  const publicDir = path.join(process.cwd(), 'public');
  app.use(express.static(publicDir));
  logger.debug(`Serving static files from: ${publicDir}`);

  // Expose mock uploads directory if running in mock mode
  const uploadsDir = path.join(process.cwd(), 'uploads');
  app.use('/uploads', express.static(uploadsDir));

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    // Store request ID in request context for controller tracking
    (req as any).requestId = requestId;
    logger.info(`[API Request] ${req.method} ${req.path}`, { requestId });
    next();
  });

  // Mount routes
  app.use('/api', router);

  // 4. Safe Global Error Handler (never leaks internal paths or stack traces)
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    const requestId = (req as any).requestId || 'unknown';
    
    // Log detailed errors only on the server
    logger.error('Unhandled API error context:', {
      requestId,
      message: err.message,
      stack: err.stack,
      statusCode: err.statusCode || err.status
    });

    // Capture exception in Sentry if enabled
    if (config.sentryDsn) {
      Sentry.captureException(err, {
        extra: { requestId }
      });
    }

    res.status(err.statusCode || err.status || 500).json({
      success: false,
      message: err.userFacingMessage || 'An unexpected error occurred. Please try again.',
      requestId
    });
  });

  return app;
}

import http from 'http';

export function startApiServer(): http.Server {
  const app = createApiServer();
  return app.listen(config.port, () => {
    logger.info(`REST API server running successfully on port ${config.port}`);
  });
}
