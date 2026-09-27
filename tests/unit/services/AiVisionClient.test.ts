import { AiVisionClient, parseVisionAssessment } from '../../../src/main/services/AiVisionClient';

const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const request = {
  apiKey: 'private-test-key',
  imageBytes,
  mimeType: 'image/png' as const,
  metadata: { candidateDates: ['2019-01-02'], GPSLatitude: 42, sourcePath: '/private/image.png' },
};

describe('vision assessment parser', () => {
  it('accepts only a visible date, context without a date, or abstention', () => {
    expect(
      parseVisionAssessment(
        '{"kind":"visible-date","date":"2020-02-29","visibleText":"29 FEB 2020","rationale":"Printed on the poster"}'
      )
    ).toMatchObject({ kind: 'visible-date', date: '2020-02-29' });
    expect(parseVisionAssessment('{"kind":"context","description":"A concert stage"}')).toEqual({
      kind: 'context',
      description: 'A concert stage',
    });
    expect(parseVisionAssessment('{"kind":"abstain","rationale":"No date visible"}')).toEqual({
      kind: 'abstain',
      rationale: 'No date visible',
    });
  });

  it.each([
    '{"kind":"visible-date","date":"2023-02-29","visibleText":"x","rationale":"x"}',
    '{"kind":"visible-date","date":"2020-01-01T02:03:04","visibleText":"x","rationale":"x"}',
    '{"kind":"visible-date","date":"2020-01-01","visibleText":"","rationale":"x"}',
    '{"kind":"context","date":"2010-01-01","description":"Looks old"}',
    '{"kind":"abstain","rationale":"x","date":"2020-01-01"}',
    '```json\n{"kind":"abstain","rationale":"x"}\n```',
  ])('rejects unsupported claims and malformed JSON', (value) => {
    expect(() => parseVisionAssessment(value)).toThrow();
  });
});

describe('AiVisionClient', () => {
  it('sends GLM-4.6V a data URL while removing paths and GPS from metadata', async () => {
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('glm-4.6v');
      expect(body.messages[1].content[1]).toEqual({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${Buffer.from(imageBytes).toString('base64')}` },
      });
      const text = JSON.stringify(body.messages[1].content[0]);
      expect(text).toContain('2019-01-02');
      expect(text).not.toMatch(/GPS|Latitude|sourcePath|\/private|private-test-key/);
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"kind":"abstain","rationale":"No date visible"}' },
            },
          ],
        }),
      } as Response;
    });
    await expect(
      new AiVisionClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).analyze(request)
    ).resolves.toEqual({ kind: 'abstain', rationale: 'No date visible' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe(
      'Bearer private-test-key'
    );
  });

  it('rejects unsupported image formats, oversized images, and incomplete responses', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
    })) as unknown as typeof fetch;
    const client = new AiVisionClient({ fetchImpl });
    await expect(
      client.analyze({ ...request, mimeType: 'image/webp' as 'image/png' })
    ).rejects.toThrow();
    await expect(
      client.analyze({ ...request, imageBytes: new Uint8Array(5_000_000) })
    ).rejects.toThrow();
    await expect(client.analyze(request)).rejects.toThrow('incomplete');
  });
});
