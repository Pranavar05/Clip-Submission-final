# Production Deployment & Cloud Setup Guide

This guide is designed for developers and server administrators. It covers how to set up Cloudflare R2, deploy the codebase to Railway, configure a PostgreSQL database, manage backups, and run tests.

---

## 🏗️ 1. Architecture Overview (Why We Use a Database, Queue, & R2)

To ensure high performance and reliability for 50–100 active clippers, the system utilizes three specialized storage layers:

1. **PostgreSQL Database**: Used to store session and security tokens, and track submission metadata. Storing tokens here ensures they are used atomically (preventing replay attacks) and keeps the system responsive.
2. **Redis Queue (BullMQ)**: Manages heavy background tasks (like uploading metadata to Airtable or notifying Discord). If Airtable or Discord is down, the queue retries the task automatically without losing data.
3. **Cloudflare R2**: Used for storing large video files. R2 is an S3-compatible object storage service that charges **zero egress (download) fees**, making it highly cost-effective for streaming videos.

### How Backups are Managed
- **PostgreSQL Database**: Railway performs automatic daily backups of your database.
- **Videos (Cloudflare R2)**: Multi-region durability ensures uploaded videos are highly secure and redundant.
- **Airtable**: Acts as your persistent administrative dashboard where all finalized records are archived.

---

## ☁️ 2. Cloudflare R2 Storage Setup

Cloudflare R2 stores your clips.

### Step 1: Create your Cloudflare R2 Bucket
1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. In the left-hand menu, click **R2**.
3. Click **Create bucket**.
4. Name your bucket (e.g., `clip-submissions-bucket`).
5. Keep the bucket **Private** (we protect clips using temporary presigned URLs).
6. Click **Create bucket**.

### Step 2: Generate Access Keys
1. On the main **R2** dashboard page, click **Manage R2 API Tokens** in the right sidebar.
2. Click **Create API token**.
3. Configure the token:
   - **Token name**: `clip-submission-system-key`
   - **Permissions**: `Edit` (read/write access is required for uploads)
   - **Specify bucket**: Choose the bucket you created in Step 1.
4. Click **Create API Token**.
5. **Copy and save** the following values immediately (they will only be shown once):
   - **Access Key ID**
   - **Secret Access Key**
   - **Jurisdiction-specific Endpoint** (looks like `https://<account_id>.r2.cloudflarestorage.com`)

---

## 🔌 3. Local Verification of Cloudflare R2

Before deploying to production, verify your R2 configuration locally.

1. Open your local `.env` file and update the following variables with your Cloudflare keys:
   ```env
   # Turn off Mock Storage to test real R2 upload
   MOCK_STORAGE=false

   R2_ACCOUNT_ID=your_cloudflare_account_id_from_endpoint_url
   R2_ACCESS_KEY_ID=your_access_key_id
   R2_SECRET_ACCESS_KEY=your_secret_access_key
   R2_BUCKET_NAME=your-bucket-name
   ```
   > **Note**: The `R2_ACCOUNT_ID` is the hex string in your endpoint URL: `https://<account_id>.r2.cloudflarestorage.com`.

2. Start the local server:
   ```bash
   npm run dev
   ```
3. Use the Discord bot to generate a link, access the portal, and upload a clip. Verify that the video is uploaded to Cloudflare R2 and playing correctly inside Discord.

---

## 🚆 4. Production Deployment to Railway

Railway is a cloud platform that hosts your database, Redis queue, Discord bot, and REST API in one unified project.

### Step 1: Initialize Git Repository
If your project is not already tracked by Git:
```bash
git init
git add .
git commit -m "feat: production hardening completed"
```
Create a private repository on GitHub and push your code to it.

### Step 2: Create a New Project on Railway
1. Go to [Railway.app](https://railway.app/) and log in.
2. Click **New Project** → **Deploy from GitHub repo** and select your repository.
3. Once imported, click **+ New** on your Railway dashboard and add:
   - **PostgreSQL Database**
   - **Redis Database**

### Step 3: Add Monolithic Web Service
By default, Railway will start the main monolithic service which runs the REST API, the worker, and the Discord bot together inside a single process.
1. Click on your repository service block in the Railway canvas.
2. Navigate to the **Variables** tab.
3. Click **New Variable** or **Raw Editor** and copy all variables from your local `.env` file. Do **NOT** copy `PORT`, `DATABASE_URL`, or `REDIS_URL` directly; Railway overrides these automatically.
4. Set the following variables in the Railway console:
   ```env
   NODE_ENV=production
   API_BASE_URL=https://your-railway-app-url.up.railway.app
   MOCK_STORAGE=false
   MOCK_AIRTABLE=false
   
   # API Authorization (Generate a new secure random string)
   API_AUTH_TOKEN=your-randomly-generated-secure-token

   # Discord Bot credentials
   DISCORD_TOKEN=your_live_discord_token
   DISCORD_CLIENT_ID=your_discord_client_id
   CLIPPER_ROLE_ID=your_clipper_role_id

   # Airtable credentials
   AIRTABLE_API_KEY=your_airtable_api_key
   AIRTABLE_BASE_ID=your_airtable_base_id
   
   # Cloudflare R2 credentials
   R2_ACCOUNT_ID=your_r2_account_id
   R2_ACCESS_KEY_ID=your_r2_access_key_id
   R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
   R2_BUCKET_NAME=your_r2_bucket_name
   ```

### Step 4: Expose the Web Endpoint
1. Go to the **Settings** tab of your repository service block in Railway.
2. Under the **Networking** section, click **Generate Domain** (or attach a custom domain).
3. Copy the generated domain and update your `API_BASE_URL` variable to match it (e.g., `https://web-production-xxxx.up.railway.app`).

### Step 5: Start Command configuration
Railway automatically reads the `start` script from your `package.json`:
```json
"start": "node dist/index.js"
```
The startup migrations will run automatically on deploy. Once deployment completes, your production app will be live.
