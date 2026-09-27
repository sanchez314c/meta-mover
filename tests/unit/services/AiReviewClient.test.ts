import { AiReviewClient, parseAiReviewProposal } from '../../../src/main/services/AiReviewClient';

const request = {
  apiKey: 'secret',
  evidence: { dates: ['2020-01-02'] },
  candidateIds: ['a', 'b'],
};

describe('AI review proposal parser', () => {
  it('accepts a known candidate, valid date and abstention', () => {
    expect(
      parseAiReviewProposal('{"kind":"candidate","candidateId":"a","rationale":"EXIF"}', ['a'])
    ).toEqual({ kind: 'candidate', candidateId: 'a', rationale: 'EXIF' });
    expect(
      parseAiReviewProposal(
        '{"kind":"date","date":"2024-02-29","precision":"date","rationale":"record"}',
        []
      )
    ).toMatchObject({ kind: 'date', date: '2024-02-29' });
    expect(parseAiReviewProposal('{"kind":"abstain","rationale":"none"}', [])).toEqual({
      kind: 'abstain',
      rationale: 'none',
    });
  });

  it.each([
    '```json\n{"kind":"abstain","rationale":"x"}\n```',
    '{"kind":"candidate","candidateId":"unknown","rationale":"x"}',
    '{"kind":"date","date":"2023-02-29","precision":"date","rationale":"x"}',
    '{"kind":"date","date":"2024-01-01T00:00:00.001","precision":"second","rationale":"x"}',
    '{"kind":"date","date":"2024-01-01T00:00:00","precision":"date","rationale":"x"}',
    '{"kind":"abstain","rationale":"x","extra":true}',
    '{"kind":"abstain","rationale":""}',
  ])('rejects malformed or unsupported output', (value) => {
    expect(() => parseAiReviewProposal(value, ['a'])).toThrow();
  });
});

describe('AiReviewClient', () => {
  it('retries one timed-out proposal and then accepts a complete answer', async () => {
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            (init.signal as AbortSignal).addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true }
            )
          )
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"kind":"abstain","rationale":"uncertain"}' },
            },
          ],
        }),
      });
    const client = new AiReviewClient({
      fetchImpl,
      timeoutMs: 15,
      totalTimeoutMs: 80,
      retryDelayMs: 0,
      jitterMs: 0,
    });
    await expect(client.propose(request)).resolves.toMatchObject({ kind: 'abstain' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops after one timeout retry even when transport ignores abort', async () => {
    const fetchImpl = jest.fn(() => new Promise(() => undefined));
    const client = new AiReviewClient({
      fetchImpl,
      timeoutMs: 15,
      totalTimeoutMs: 40,
      retryDelayMs: 0,
      jitterMs: 0,
    });
    const started = Date.now();
    await expect(client.propose(request)).rejects.toThrow('timed out');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('does not retry after user cancellation or authentication rejection', async () => {
    const controller = new AbortController();
    const pending = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          (init.signal as AbortSignal).addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true }
          )
        )
    );
    const task = new AiReviewClient({
      fetchImpl: pending,
      timeoutMs: 50,
      totalTimeoutMs: 100,
      retryDelayMs: 0,
      jitterMs: 0,
    }).propose({ ...request, signal: controller.signal });
    controller.abort();
    await expect(task).rejects.toThrow('cancelled');
    expect(pending).toHaveBeenCalledTimes(1);
    const denied = jest.fn(async () => ({ ok: false, status: 401 }));
    await expect(
      new AiReviewClient({ fetchImpl: denied, timeoutMs: 50, totalTimeoutMs: 100 }).propose(request)
    ).rejects.toThrow('authentication');
    expect(denied).toHaveBeenCalledTimes(1);
  });
  it('sends only caller data, checks completion, and never exposes the key in errors', async () => {
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('glm-5.3');
      expect(body.max_tokens).toBe(32768);
      expect(body.messages[0].content).toContain('color profile');
      expect(body.messages[0].content).toContain('copied EXIF/XMP/IPTC');
      expect(body.messages[0].content).toContain('modification date');
      expect(JSON.stringify(body)).not.toContain('secret');
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"kind":"candidate","candidateId":"a","rationale":"EXIF"}' },
            },
          ],
        }),
      } as Response;
    });
    const client = new AiReviewClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.propose(request)).resolves.toMatchObject({ candidateId: 'a' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe(
      'Bearer secret'
    );
  });

  it('rejects truncated output and retries 429 before success', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
      });
    const client = new AiReviewClient({ fetchImpl, maxAttempts: 2, retryDelayMs: 0 });
    await expect(client.propose(request)).rejects.toThrow('incomplete');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honors cancellation before request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = jest.fn();
    await expect(
      new AiReviewClient({ fetchImpl }).propose({ ...request, signal: controller.signal })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
