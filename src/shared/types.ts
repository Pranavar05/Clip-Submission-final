export type ClipType = 'Raw' | 'Edited' | 'Stolen';

export interface SubmissionPayload {
  submissionId: string; // Client-supplied UUID for idempotency
  discordUser: string;
  displayName: string;
  userId: string;
  creatorId: string;    // Selected creator record ID in Airtable
  clipType: ClipType;
  description?: string;
  submittedAt: string;
  serverId: string;
  channelId: string;
}

export interface SubmissionResponse {
  success: boolean;
  message: string;
  submissionId?: string;
  requestId?: string; // Request ID / Correlation ID for error tracing
}
