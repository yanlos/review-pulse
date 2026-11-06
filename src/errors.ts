import { STATUS_CODES } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | undefined;
  // For the server log only. Never sent to the client.
  readonly reason: string | undefined;

  constructor(status: number, code: string, detail: string, retryAfter?: number, reason?: string) {
    super(detail);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.reason = reason;
  }
}

export type Problem = {
  type: "about:blank";
  title: string;
  status: number;
  detail: string;
  code: string;
  request_id: string;
};

export function problem(status: number, code: string, detail: string, requestId: string): Problem {
  return {
    type: "about:blank",
    title: STATUS_CODES[status] ?? "Error",
    status,
    detail,
    code,
    request_id: requestId,
  };
}

export function badRequest(detail: string): HttpError {
  return new HttpError(400, "invalid_parameter", detail);
}
