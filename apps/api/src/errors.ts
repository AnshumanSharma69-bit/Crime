export class HttpError extends Error { constructor(public status: number, public code: string, public detail?: string, public extra?: object) { super(code); } }
