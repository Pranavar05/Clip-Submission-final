# Clip Submission System v2

A production-grade, highly-scalable Discord Bot and Express REST API architecture for streaming video clip submissions directly to Cloudflare R2, using Redis (BullMQ) for queuing and Neon PostgreSQL for structured storage.

## Architecture Diagram

```mermaid
graph TD
    subgraph Client ["Browser / Client-side"]
        Portal["Web Portal UI (portal.html + portal.js)"]
    end

    subgraph Infrastructure ["Ingress & Load Balancer"]
        LB["API Load Balancer / Railway Ingress"]
    end

    subgraph API ["Railway API Cluster (Scaled)"]
        Express["Express App (Helmet, CORS Origin Lock, Sentry)"]
        PrometheusEndpoint["/api/metrics (Prometheus)"]
        BullBoard["/admin/queue (Bull Board Dashboard)"]
    end

    subgraph Bot ["Railway Bot Service (Single Instance)"]
        DiscordClient["Discord Bot (discord.js v14)"]
    end

    subgraph Worker ["Railway Queue Workers (Scaled)"]
        BullWorker["BullMQ Job Processor"]
    end

    subgraph Data ["Database & Storage Services"]
        Postgres[("Neon PostgreSQL (Connection Pooling + SSL)")]
        Redis[("Redis (Auth Cache & BullMQ Store)")]
        R2["Cloudflare R2 Storage (Direct Browser PUT)"]
        Airtable["Airtable API (Idempotent Sync)"]
    end

    %% Client Interactions
    Portal -->|1. Get Presigned URL| LB
    LB --> Express
    Portal -->|2. Direct PUT Upload| R2
    Portal -->|3. Finalize Upload| LB

    %% Express Server Operations
    Express -->|Authenticate & Check Cooldown| Postgres
    Express -->|Redis Auth Cache lookup| Redis
    Express -->|Enqueue Job| Redis
    Express -->|Check health| Data

    %% Discord Bot Operations
    DiscordClient -->|Create token & Validate roles| Postgres
    DiscordClient -->|Cache roles| Redis

    %% Worker Operations
    BullWorker -->|Poll jobs| Redis
    BullWorker -->|Sync records| Airtable
    BullWorker -->|Trigger embeds| DiscordClient
```

---

## Features

- **Direct Browser Uploads**: Files stream directly from the clipper's browser to Cloudflare R2 using pre-signed PUT URLs. Saves API server bandwidth and prevents Out-Of-Memory (OOM) crashes.
- **Neon PostgreSQL Connection Pool**: Integrated with transaction-level connection pooling and SSL connection negotiation.
- **Redis Auth & Role Caching**: Caches Discord role-gates and upload-token validation states to minimize database roundtrips.
- **Durable Queue Worker**: Powered by BullMQ (Redis-backed) with auto-retries, backoff, and concurrency management to respect Airtable's 5 req/s rate limits.
- **Prometheus Monitoring**: Exposes a `/api/metrics` endpoint tracking uploads attempts, file size histograms, and job execution times.
- **BullMQ Admin Dashboard**: Secure queue management portal exposed at `/admin/queue` (protected by Basic Authentication).
- **Graceful Shutdowns**: Clear termination handlers across API and Worker processes to drain outstanding requests and close connections clean.

---

## Environment Configuration

Create a `.env` file in the root directory based on `.env.example`:

```ini
# Server Setup
PORT=3000
ALLOWED_ORIGIN=https://your-frontend-domain.com
API_BASE_URL=http://localhost:3000

# Security Auth Token
API_AUTH_TOKEN=your-secure-internal-communication-token

# Databases
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
REDIS_URL=redis://default:password@host:port

# Discord Integration
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-client-id
DISCORD_GUILD_ID=your-guild-id
CLIPPER_ROLE_ID=role-snowflake-id

# Airtable Configuration
AIRTABLE_API_KEY=pat-token-here
AIRTABLE_BASE_ID=appBaseId
AIRTABLE_SUBMISSIONS_TABLE=Submissions
AIRTABLE_CREATORS_TABLE=Creators

# Cloudflare R2
R2_ACCOUNT_ID=account-id-hex
R2_ACCESS_KEY_ID=access-key-id
R2_SECRET_ACCESS_KEY=secret-key
R2_BUCKET_NAME=bucket-name
R2_PUBLIC_URL=https://pub-url.r2.dev

# Sentry Monitoring (Optional)
SENTRY_DSN=

# Admin Dashboard Auth
ADMIN_USER=admin
ADMIN_PASS=securepassword
```

---

## Operations & Processes

This codebase supports three decoupled service processes suitable for cloud platforms (e.g. Railway):

1. **REST API Server**
   ```bash
   npm run start:api
   ```
2. **Discord Bot Listener**
   ```bash
   npm run start:bot
   ```
3. **Queue Worker Service**
   ```bash
   npm run start:worker
   ```

*Note: For local development, running `npm run dev` spawns the monolith process (incorporating all three services).*
