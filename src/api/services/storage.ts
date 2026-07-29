import { S3Client, HeadBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable, Transform, TransformCallback } from 'stream';
import fs from 'fs';
import path from 'path';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

export class R2StorageService {
  private static s3Client: S3Client;
  private static uploadsDir = path.join(process.cwd(), 'uploads');

  private static getClient(): S3Client {
    if (!this.s3Client) {
      const endpoint = `https://${config.r2.accountId}.r2.cloudflarestorage.com`;
      logger.info(`Initializing S3 client for R2 Endpoint: ${endpoint}`);
      this.s3Client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: {
          accessKeyId: config.r2.accessKeyId,
          secretAccessKey: config.r2.secretAccessKey,
        },
      });
    }
    return this.s3Client;
  }

  /**
   * Generates a secure, short-lived signed URL to access the private R2 object.
   */
  static async generatePresignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    if (config.mockStorage) {
      logger.info(`[MOCK STORAGE] Simulating presigned URL for key: ${key}`);
      const filename = path.basename(key);
      return `${config.apiBaseUrl}/uploads/${filename}`;
    }

    try {
      const client = this.getClient();
      const command = new GetObjectCommand({
        Bucket: config.r2.bucketName,
        Key: key,
      });
      const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
      logger.debug(`Generated presigned URL for key: ${key} (Expires in ${expiresInSeconds}s)`);
      return url;
    } catch (err: any) {
      logger.error(`Failed to generate R2 presigned URL for key: ${key}. Error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Streams a Readable stream directly to Cloudflare R2 bucket, or mock local disk directory if mock is active.
   */
  static async uploadStream(
    stream: Readable,
    key: string,
    contentType: string,
    maxBytes = 200 * 1024 * 1024 // 200MB limit
  ): Promise<{ fileUrl: string; sizeBytes: number }> {
    let bytesUploaded = 0;

    // Transform stream to count size and abort if it exceeds limit mid-stream
    const sizeTracker = new Transform({
      transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback) {
        bytesUploaded += chunk.length;
        if (bytesUploaded > maxBytes) {
          const limitMb = (maxBytes / (1024 * 1024)).toFixed(0);
          const err = new Error(`File size limit exceeded. Max size allowed is ${limitMb}MB.`);
          callback(err);
        } else {
          this.push(chunk);
          callback();
        }
      }
    });

    const uploadStreamSource = stream.pipe(sizeTracker);

    // MOCK STORAGE: Write straight to local file system
    if (config.mockStorage) {
      logger.info(`[MOCK STORAGE] Starting local file upload simulation for key: ${key}...`);
      
      // Ensure target folder exists
      if (!fs.existsSync(this.uploadsDir)) {
        fs.mkdirSync(this.uploadsDir, { recursive: true });
      }

      // Generate filename from key
      const filename = path.basename(key);
      const targetPath = path.join(this.uploadsDir, filename);
      const fileWriteStream = fs.createWriteStream(targetPath);

      return new Promise((resolve, reject) => {
        uploadStreamSource.pipe(fileWriteStream);

        fileWriteStream.on('finish', () => {
          const fileUrl = `${config.apiBaseUrl}/uploads/${filename}`;
          logger.info(`[MOCK STORAGE] Upload mock complete: ${filename}. URL: ${fileUrl} (${(bytesUploaded / (1024 * 1024)).toFixed(2)} MB)`);
          resolve({
            fileUrl,
            sizeBytes: bytesUploaded
          });
        });

        fileWriteStream.on('error', (err) => {
          logger.error(`[MOCK STORAGE] Write stream failed: ${err.message}`);
          reject(err);
        });

        uploadStreamSource.on('error', (err) => {
          fileWriteStream.destroy();
          reject(err);
        });
      });
    }

    // REAL R2 STORAGE
    logger.info(`Starting streaming R2 upload for key: ${key}...`);

    try {
      const client = this.getClient();
      const upload = new Upload({
        client,
        params: {
          Bucket: config.r2.bucketName,
          Key: key,
          Body: uploadStreamSource,
          ContentType: contentType,
        },
        queueSize: 4, // Concurrent upload parts
        partSize: 5 * 1024 * 1024, // 5MB part size
      });

      upload.on('httpUploadProgress', (progress) => {
        logger.debug(`R2 upload progress for ${key}: Loaded ${progress.loaded} bytes`);
      });

      await upload.done();
      
      const fileUrl = config.r2.publicUrl 
        ? `${config.r2.publicUrl.replace(/\/$/, '')}/${key}`
        : `https://${config.r2.bucketName}.r2.cloudflarestorage.com/${key}`;

      logger.info(`Streaming R2 upload complete: ${key}. URL: ${fileUrl} (${(bytesUploaded / (1024 * 1024)).toFixed(2)} MB)`);

      return {
        fileUrl,
        sizeBytes: bytesUploaded
      };
    } catch (err: any) {
      logger.error(`R2 upload stream failed for key: ${key}. Error: ${err.message}`);
      sizeTracker.destroy();
      stream.destroy();
      throw err;
    }
  }

  /**
   * Health check connectivity test for R2 bucket
   */
  static async testConnection(): Promise<boolean> {
    if (config.mockStorage) {
      logger.info('[MOCK STORAGE] Uptime connectivity check simulated - Success');
      return true;
    }

    try {
      const client = this.getClient();
      const command = new HeadBucketCommand({ Bucket: config.r2.bucketName });
      await client.send(command);
      return true;
    } catch (err) {
      logger.error('R2 connectivity check failed:', err);
      return false;
    }
  }
}

