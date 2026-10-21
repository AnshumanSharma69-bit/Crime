/** A failure worth retrying later (rate limit, server error, network). The document is left untouched, not marked as failed. */
export class LlmTransientError extends Error { constructor(message: string) { super(message); this.name = 'LlmTransientError'; } }
