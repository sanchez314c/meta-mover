import type { JsonValue } from '../core/date';

export type AiReviewProposal =
  | { kind: 'candidate'; candidateId: string; rationale: string }
  | { kind: 'date'; date: string; precision: 'date' | 'second'; rationale: string }
  | { kind: 'abstain'; rationale: string };

export interface AiReviewRequest {
  evidence: JsonValue;
  candidateIds: readonly string[];
  apiKey: string;
  signal?: AbortSignal;
}

export interface AiReviewClientOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  jitterMs?: number;
}

const DEFAULT_ENDPOINT = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

export class AiReviewAuthenticationError extends Error {
  constructor() {
    super('AI API authentication failed');
    this.name = 'AiReviewAuthenticationError';
  }
}

class RetryableHttpError extends Error {
  constructor(public readonly status: number) {
    super('AI request temporarily unavailable');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDate(date: string, precision: 'date' | 'second'): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/.exec(date);
  if (!match || (precision === 'date') !== (match[4] === undefined)) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    (precision === 'date' ||
      (Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59))
  );
}

export function parseAiReviewProposal(
  content: string,
  candidateIds: readonly string[]
): AiReviewProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('AI proposal is not plain JSON');
  }
  if (!isRecord(parsed)) throw new Error('AI proposal must be an object');
  const keys = Object.keys(parsed).sort();
  const rationale = parsed.rationale;
  if (typeof rationale !== 'string' || rationale.trim().length === 0 || rationale.length > 4000)
    throw new Error('AI proposal rationale is invalid');
  if (parsed.kind === 'abstain' && keys.join(',') === 'kind,rationale')
    return { kind: 'abstain', rationale };
  if (
    parsed.kind === 'candidate' &&
    keys.join(',') === 'candidateId,kind,rationale' &&
    typeof parsed.candidateId === 'string' &&
    candidateIds.includes(parsed.candidateId)
  )
    return { kind: 'candidate', candidateId: parsed.candidateId, rationale };
  if (
    parsed.kind === 'date' &&
    keys.join(',') === 'date,kind,precision,rationale' &&
    typeof parsed.date === 'string' &&
    (parsed.precision === 'date' || parsed.precision === 'second') &&
    validDate(parsed.date, parsed.precision)
  )
    return { kind: 'date', date: parsed.date, precision: parsed.precision, rationale };
  throw new Error('AI proposal does not match the permitted schema');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('AI request cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('AI request cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class AiReviewClient {
  constructor(private readonly options: AiReviewClientOptions = {}) {}

  async propose(request: AiReviewRequest): Promise<AiReviewProposal> {
    if (!request.apiKey.trim()) throw new Error('AI API key is required');
    if (request.signal?.aborted) throw new Error('AI request cancelled');
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const endpoint = this.options.endpoint ?? DEFAULT_ENDPOINT;
    const timeoutMs = this.options.timeoutMs ?? 240_000;
    const totalTimeoutMs = this.options.totalTimeoutMs ?? 480_000;
    const attempts = this.options.maxAttempts ?? 3;
    const retryDelayMs = this.options.retryDelayMs ?? 500;
    const jitterMs = this.options.jitterMs ?? 250;
    if (
      timeoutMs <= 0 ||
      timeoutMs > 240_000 ||
      totalTimeoutMs <= 0 ||
      totalTimeoutMs > 480_000 ||
      attempts < 1 ||
      attempts > 5 ||
      retryDelayMs < 0 ||
      jitterMs < 0 ||
      jitterMs > 1000
    )
      throw new Error('Invalid AI request options');
    const payload = JSON.stringify({
      model: 'glm-5.3',
      max_tokens: 32768,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Assess image creation date metadata. Return exactly one JSON object: {"kind":"candidate","candidateId":"...","rationale":"..."}, {"kind":"date","date":"YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss","precision":"date or second","rationale":"..."}, or {"kind":"abstain","rationale":"..."}. Never invent precision or a date absent from evidence. A color profile date describes the ICC profile, not image creation. A modification date may describe an edit or import, not capture. Repeated or copied EXIF/XMP/IPTC fields are not independent corroboration. Abstain when insufficient.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            evidence: request.evidence,
            candidateIds: request.candidateIds,
          }),
        },
      ],
    });
    const deadline = Date.now() + totalTimeoutMs;
    let timeoutRetries = 0;
    let ordinaryRetries = 0;
    while (true) {
      if (request.signal?.aborted) throw new Error('AI request cancelled');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('AI request timed out');
      const controller = new AbortController();
      let timedOut = false;
      let rejectInterrupt!: (reason: Error) => void;
      const interrupt = new Promise<never>((_resolve, reject) => {
        rejectInterrupt = reject;
      });
      const cancel = () => {
        controller.abort();
        rejectInterrupt(new Error('AI request cancelled'));
      };
      request.signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(
        () => {
          timedOut = true;
          controller.abort();
          rejectInterrupt(new Error('AI request timed out'));
        },
        Math.min(timeoutMs, remaining)
      );
      let retry = false;
      try {
        const response = await Promise.race([
          fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${request.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: payload,
            signal: controller.signal,
          }),
          interrupt,
        ]);
        if (!response.ok) {
          if (response.status === 401 || response.status === 403)
            throw new AiReviewAuthenticationError();
          if (response.status === 429 || response.status >= 500)
            throw new RetryableHttpError(response.status);
          throw new Error(`AI request failed with HTTP ${response.status}`);
        }
        const data: unknown = await Promise.race([response.json(), interrupt]);
        const choice = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
        const message = isRecord(choice) ? choice.message : undefined;
        if (
          !isRecord(choice) ||
          choice.finish_reason !== 'stop' ||
          !isRecord(message) ||
          typeof message.content !== 'string'
        )
          throw new Error('AI response incomplete or malformed');
        return parseAiReviewProposal(message.content, request.candidateIds);
      } catch (error) {
        if (request.signal?.aborted) throw new Error('AI request cancelled');
        if (timedOut) {
          timeoutRetries += 1;
          if (timeoutRetries > 1) throw new Error('AI request timed out');
          retry = true;
        } else if (error instanceof AiReviewAuthenticationError) {
          throw error;
        } else if (error instanceof RetryableHttpError) {
          ordinaryRetries += 1;
          if (ordinaryRetries >= attempts)
            throw new Error(`AI request failed with HTTP ${error.status}`);
          retry = true;
        } else if (error instanceof Error && error.message.startsWith('AI ')) {
          throw error;
        } else {
          ordinaryRetries += 1;
          if (ordinaryRetries >= attempts) throw new Error('AI request failed');
          retry = true;
        }
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', cancel);
      }
      if (retry) {
        const budget = deadline - Date.now();
        if (budget <= 0) throw new Error('AI request timed out');
        const pause =
          retryDelayMs * 2 ** Math.max(0, ordinaryRetries - 1) +
          Math.floor(Math.random() * (jitterMs + 1));
        await delay(Math.min(pause, Math.max(0, budget - 1)), request.signal);
      }
    }
  }
}
