import type { ParsedDateValue } from '../date';

export interface NormalizeDateMetadataRequest {
  filePath: string;
  selectedDate: ParsedDateValue;
  signal?: AbortSignal;
}

export interface MetadataNormalizationReceipt {
  family: 'jpeg' | 'heic' | 'png' | 'quicktime' | 'audio';
  idempotent: boolean;
  verified: true;
  before: Readonly<Record<string, unknown>>;
  after: Readonly<Record<string, unknown>>;
  normalizedTags: readonly string[];
}

export interface MetadataDateWriterPort {
  normalizeDateMetadata(
    request: Readonly<NormalizeDateMetadataRequest>
  ): Promise<MetadataNormalizationReceipt>;
  close(): Promise<void>;
}
