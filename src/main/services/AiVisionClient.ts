import type { JsonValue } from '../core/date';

export type VisionAssessment =
  | { kind: 'visible-date'; date: string; visibleText: string; rationale: string }
  | { kind: 'context'; description: string }
  | { kind: 'abstain'; rationale: string };

export interface VisionRequest {
  apiKey: string;
  imageBytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
  metadata: JsonValue;
  signal?: AbortSignal;
}

export interface AiVisionClientOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

const ENDPOINT = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const MAX_IMAGE_BYTES = 4_999_999;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
}

export function parseVisionAssessment(content: string): VisionAssessment {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('Vision response is not plain JSON');
  }
  if (!record(value)) throw new Error('Vision response must be an object');
  const keys = Object.keys(value).sort().join(',');
  if (
    value.kind === 'visible-date' &&
    keys === 'date,kind,rationale,visibleText' &&
    typeof value.date === 'string' &&
    validDate(value.date) &&
    boundedText(value.visibleText) &&
    boundedText(value.rationale)
  ) {
    return {
      kind: 'visible-date',
      date: value.date,
      visibleText: value.visibleText,
      rationale: value.rationale,
    };
  }
  if (value.kind === 'context' && keys === 'description,kind' && boundedText(value.description))
    return { kind: 'context', description: value.description };
  if (value.kind === 'abstain' && keys === 'kind,rationale' && boundedText(value.rationale))
    return { kind: 'abstain', rationale: value.rationale };
  throw new Error('Vision response does not match the permitted schema');
}

function sanitizeMetadata(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (value && typeof value === 'object') {
    const clean: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        /path|filename|file.?name|gps|latitude|longitude|location|coordinate|secret|token|api.?key/i.test(
          key
        )
      )
        continue;
      clean[key] = sanitizeMetadata(entry);
    }
    return clean;
  }
  if (
    typeof value === 'string' &&
    (/^(?:\/|[A-Za-z]:\\|file:\/\/)/.test(value) || /(?:GPS|Latitude|Longitude):/i.test(value))
  )
    return '[redacted]';
  return value;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Vision request cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Vision request cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class AiVisionClient {
  constructor(private readonly options: AiVisionClientOptions = {}) {}

  async analyze(request: VisionRequest): Promise<VisionAssessment> {
    if (!request.apiKey.trim()) throw new Error('Vision API key is required');
    if (request.signal?.aborted) throw new Error('Vision request cancelled');
    if (
      (request.mimeType !== 'image/png' && request.mimeType !== 'image/jpeg') ||
      request.imageBytes.length === 0 ||
      request.imageBytes.length > MAX_IMAGE_BYTES
    )
      throw new Error('Vision image must be a nonempty PNG or JPEG smaller than 5 MB');
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const attempts = this.options.maxAttempts ?? 3;
    const retryDelayMs = this.options.retryDelayMs ?? 500;
    if (timeoutMs <= 0 || attempts < 1 || attempts > 5 || retryDelayMs < 0)
      throw new Error('Invalid Vision request options');
    const body = JSON.stringify({
      model: 'glm-4.6v',
      max_tokens: 32768,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Examine the image for a visibly written calendar date. Metadata is context, not visual proof. Return exactly one plain JSON object: {"kind":"visible-date","date":"YYYY-MM-DD","visibleText":"exact visible text","rationale":"why this text refers to the image"}, {"kind":"context","description":"short visual description without dates"}, or {"kind":"abstain","rationale":"why no reliable clue"}. Never infer a capture date from the scene, camera, fashion, filename, or metadata. A printed date may describe an event or screenshot content rather than image capture. Do not claim it is capture time.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                metadata: sanitizeMetadata(request.metadata),
                task: 'Report visible date text only, or context/abstain.',
              }),
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${request.mimeType};base64,${Buffer.from(request.imageBytes).toString('base64')}`,
              },
            },
          ],
        },
      ],
    });
    const fetchImpl = this.options.fetchImpl ?? fetch;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      try {
        if (request.signal?.aborted) throw new Error('Vision request cancelled');
        const response = await fetchImpl(this.options.endpoint ?? ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${request.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
            await delay(retryDelayMs * 2 ** (attempt - 1), request.signal);
            continue;
          }
          throw new Error(`Vision request failed with HTTP ${response.status}`);
        }
        const data: unknown = await response.json();
        const choice = record(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
        const message = record(choice) ? choice.message : undefined;
        if (
          !record(choice) ||
          choice.finish_reason !== 'stop' ||
          !record(message) ||
          typeof message.content !== 'string'
        )
          throw new Error('Vision response incomplete or malformed');
        return parseVisionAssessment(message.content);
      } catch (error) {
        if (request.signal?.aborted) throw new Error('Vision request cancelled');
        if (controller.signal.aborted) throw new Error('Vision request timed out');
        if (error instanceof Error && error.message.startsWith('Vision ')) throw error;
        if (attempt === attempts) throw new Error('Vision request failed');
        await delay(retryDelayMs * 2 ** (attempt - 1), request.signal);
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', abort);
      }
    }
    throw new Error('Vision request failed');
  }
}
