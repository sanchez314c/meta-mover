import {
  CandidateEligibility,
  CandidateScore,
  DateCandidateInput,
  DatePrecision,
  DateResolutionRecord,
  MediaKind,
  ParsedDateValue,
  ResolveDateRequest,
  ResolutionTarget,
  ScoredDateCandidate,
  ScoreModifier,
} from './types';

export const DATE_RESOLUTION_POLICY_VERSION = 'date-resolution/1' as const;

const FORBIDDEN_SEMANTICS = new Set([
  'metadata-modified',
  'filesystem-modified',
  'filesystem-changed',
]);

const FORBIDDEN_TAG_FRAGMENTS = [
  'filemodifydate',
  'fileaccessdate',
  'fileinodechangedate',
  'metadatadate',
  'profiledatetime',
  'historywhen',
  'modifydate',
];

const PRECISION_ORDER: Record<DatePrecision, number> = {
  date: 0,
  minute: 1,
  second: 2,
  millisecond: 3,
  microsecond: 4,
  nanosecond: 5,
};

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  fraction?: string;
}

interface CandidateGroup {
  id: string;
  candidates: ScoredDateCandidate[];
  score: number;
  corroborated: boolean;
}

interface ExactTime {
  milliseconds: number;
  nanoseconds: bigint;
}

function targetForMedia(mediaKind: MediaKind): ResolutionTarget {
  if (mediaKind === 'audio') return 'recording-time';
  if (mediaKind === 'document' || mediaKind === 'art') return 'content-created-time';
  return 'capture-time';
}

function semanticCap(candidate: DateCandidateInput): number {
  switch (candidate.semantic) {
    case 'capture':
    case 'recording':
      return 100;
    case 'sidecar-claim':
      return 95;
    case 'content-created':
      return candidate.mediaKind === 'document' || candidate.mediaKind === 'art' ? 82 : 88;
    case 'container-created':
      return 84;
    case 'digitized':
      return 70;
    case 'filename-claim':
      return 70;
    case 'filesystem-birth':
      return 35;
    default:
      return 0;
  }
}

function baseScore(candidate: DateCandidateInput): number {
  if (candidate.sourceKind === 'user-override') return 100;
  if (candidate.sourceKind === 'filesystem') {
    return candidate.semantic === 'filesystem-birth' ? 25 : 0;
  }
  if (FORBIDDEN_SEMANTICS.has(candidate.semantic)) return 0;

  const tag = candidate.tag.toLowerCase();
  const isSidecar = candidate.sourceKind === 'sidecar';
  const isFilename = candidate.sourceKind === 'filename';

  if (candidate.mediaKind === 'image' || candidate.mediaKind === 'raw') {
    if (isSidecar) return 90;
    if (isFilename) return candidate.sourceFamily === 'screenshot-filename' ? 80 : 62;
    if (tag.includes('datetimeoriginal')) return 95;
    if (tag.includes('gpsdatestamp') && tag.includes('gpstimestamp')) return 93;
    if (candidate.sourceKind === 'embedded-xmp' && tag.includes('datecreated')) return 88;
    if (candidate.sourceKind === 'embedded-iptc' && tag.includes('datecreated')) return 88;
    if (tag.includes('datetime digitized') || tag.includes('datetimedigitized')) return 65;
    if (tag.endsWith(':createdate') || tag === 'createdate') return 65;
    return 0;
  }

  if (candidate.mediaKind === 'video') {
    if (isSidecar) return 90;
    if (isFilename) return 62;
    if (
      candidate.sourceKind === 'embedded-xmp' &&
      (tag.includes('datecreated') ||
        tag.includes('datetimeoriginal') ||
        tag.includes('contentcreatedate') ||
        tag.includes('content_create_date'))
    ) {
      return 90;
    }
    if (tag.includes('keys:creationdate') || tag.includes('com.apple.quicktime.creationdate'))
      return 96;
    if (tag.includes('datetimeoriginal')) return 94;
    if (tag.includes('contentcreatedate') || tag.includes('content_create_date')) return 82;
    if (tag.includes('mediacreatedate') || tag.includes('media_create_date')) return 78;
    if (tag.includes('trackcreatedate') || tag.includes('track_create_date')) return 76;
    if (tag.includes('creation_time')) return 72;
    return 0;
  }

  if (candidate.mediaKind === 'audio') {
    if (isSidecar) return 90;
    if (isFilename) return 62;
    if (tag.includes('bwf:origination')) return 95;
    if (tag.includes('ixml:')) return 92;
    if (tag.includes('contentcreatedate') || tag.includes('content_create_date')) return 82;
    if (tag.includes('tdrc')) return 60;
    return 0;
  }

  if (isSidecar) return 85;
  if (isFilename) return 62;
  if (
    candidate.semantic === 'content-created' &&
    (tag.includes('createdate') || tag.includes('creationdate') || tag.endsWith(':created'))
  ) {
    return 75;
  }
  return 0;
}

function expectedSemantics(
  candidate: DateCandidateInput
): ReadonlySet<DateCandidateInput['semantic']> | null {
  if (candidate.sourceKind === 'user-override') return null;
  if (candidate.sourceKind === 'filesystem') {
    return new Set(['filesystem-birth', 'filesystem-modified', 'filesystem-changed']);
  }
  if (candidate.sourceKind === 'sidecar') return new Set(['sidecar-claim']);
  if (candidate.sourceKind === 'filename') return new Set(['filename-claim']);

  const tag = candidate.tag.toLowerCase();
  if (candidate.mediaKind === 'image' || candidate.mediaKind === 'raw') {
    if (tag.includes('datetimeoriginal') || tag.includes('gpsdatestamp')) {
      return new Set(['capture']);
    }
    if (
      (candidate.sourceKind === 'embedded-xmp' || candidate.sourceKind === 'embedded-iptc') &&
      tag.includes('datecreated')
    ) {
      return new Set(['capture', 'content-created']);
    }
    if (
      tag.includes('datetime digitized') ||
      tag.includes('datetimedigitized') ||
      tag.endsWith(':createdate') ||
      tag === 'createdate'
    ) {
      return new Set(['digitized']);
    }
    return null;
  }

  if (candidate.mediaKind === 'video') {
    if (
      candidate.sourceKind === 'embedded-xmp' &&
      (tag.includes('datecreated') || tag.includes('datetimeoriginal'))
    ) {
      return new Set(['capture', 'content-created']);
    }
    if (
      tag.includes('keys:creationdate') ||
      tag.includes('com.apple.quicktime.creationdate') ||
      tag.includes('datetimeoriginal')
    ) {
      return new Set(['capture']);
    }
    if (tag.includes('contentcreatedate') || tag.includes('content_create_date')) {
      return new Set(['content-created']);
    }
    if (
      tag.includes('mediacreatedate') ||
      tag.includes('media_create_date') ||
      tag.includes('trackcreatedate') ||
      tag.includes('track_create_date') ||
      tag.includes('creation_time')
    ) {
      return new Set(['container-created']);
    }
    return null;
  }

  if (candidate.mediaKind === 'audio') {
    if (tag.includes('bwf:origination') || tag.includes('ixml:') || tag.includes('tdrc')) {
      return new Set(['recording']);
    }
    if (tag.includes('contentcreatedate') || tag.includes('content_create_date')) {
      return new Set(['content-created']);
    }
    return null;
  }

  if (tag.includes('createdate') || tag.includes('creationdate') || tag.endsWith(':created')) {
    return new Set(['content-created']);
  }
  return null;
}

function parseLocalIso(localIso: string): CalendarParts | null {
  const match = localIso.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/
  );
  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: match[4] === undefined ? undefined : Number(match[4]),
    minute: match[5] === undefined ? undefined : Number(match[5]),
    second: match[6] === undefined ? undefined : Number(match[6]),
    fraction: match[7],
  };
}

function calendarMilliseconds(parts: CalendarParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, 0);
  if (parts.fraction) {
    date.setUTCMilliseconds(Number(`0.${parts.fraction}`) * 1000);
  }
  return date.getTime();
}

function isCalendarValid(parts: CalendarParts): boolean {
  if (parts.year === 0 || parts.month < 1 || parts.month > 12 || parts.day < 1) return false;
  if ((parts.hour ?? 0) > 23 || (parts.minute ?? 0) > 59 || (parts.second ?? 0) > 59) {
    return false;
  }

  const date = new Date(calendarMilliseconds(parts));
  return (
    date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() === parts.month - 1 &&
    date.getUTCDate() === parts.day &&
    date.getUTCHours() === (parts.hour ?? 0) &&
    date.getUTCMinutes() === (parts.minute ?? 0) &&
    date.getUTCSeconds() === (parts.second ?? 0)
  );
}

function calendarNanoseconds(parts: CalendarParts): bigint {
  const wholeSecondMilliseconds = calendarMilliseconds({ ...parts, fraction: undefined });
  const fractionalNanoseconds = BigInt((parts.fraction ?? '').padEnd(9, '0') || '0');
  return BigInt(wholeSecondMilliseconds) * 1_000_000n + fractionalNanoseconds;
}

function parseUtcInstant(instantUtc: string): ExactTime | null {
  const match = instantUtc.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/);
  if (!match) return null;

  const parts = parseLocalIso(`${match[1]}${match[2] === undefined ? '' : `.${match[2]}`}`);
  if (!parts || !isCalendarValid(parts)) return null;
  return {
    milliseconds: calendarMilliseconds(parts),
    nanoseconds: calendarNanoseconds(parts),
  };
}

function precisionMatchesValue(precision: DatePrecision, parts: CalendarParts): boolean {
  const hasTime = parts.hour !== undefined;
  const hasSeconds = parts.second !== undefined;
  const fractionLength = parts.fraction?.length ?? 0;

  switch (precision) {
    case 'date':
      return !hasTime && fractionLength === 0;
    case 'minute':
      return hasTime && !hasSeconds && fractionLength === 0;
    case 'second':
      return hasSeconds && fractionLength === 0;
    case 'millisecond':
      return hasSeconds && fractionLength >= 1 && fractionLength <= 3;
    case 'microsecond':
      return hasSeconds && fractionLength >= 4 && fractionLength <= 6;
    case 'nanosecond':
      return hasSeconds && fractionLength >= 7 && fractionLength <= 9;
  }
}

function validateValue(value: ParsedDateValue, evaluationTime: ExactTime): string[] {
  const issues: string[] = [];
  const parts = parseLocalIso(value.localIso);
  if (!parts || !isCalendarValid(parts)) return ['INVALID_CALENDAR_VALUE'];

  if (!precisionMatchesValue(value.precision, parts)) {
    issues.push('PRECISION_FRACTION_MISMATCH');
  }
  if (
    value.fractionalDigits !== undefined &&
    (typeof value.fractionalDigits !== 'string' || !/^\d{1,9}$/.test(value.fractionalDigits))
  ) {
    issues.push('INVALID_FRACTIONAL_DIGITS');
  }
  if (value.fractionalDigits !== undefined && value.fractionalDigits !== parts.fraction) {
    issues.push('FRACTIONAL_DIGITS_MISMATCH');
  }

  const offsetIsValid =
    value.offsetMinutes === undefined ||
    (Number.isFinite(value.offsetMinutes) &&
      Number.isInteger(value.offsetMinutes) &&
      Math.abs(value.offsetMinutes) <= 14 * 60);
  if (!offsetIsValid) issues.push('INVALID_OFFSET_MINUTES');

  const futureLimit = evaluationTime.nanoseconds + 24n * 60n * 60n * 1_000_000_000n;
  let parsedInstant: ExactTime | null = null;
  if (value.instantUtc !== undefined) {
    parsedInstant = parseUtcInstant(value.instantUtc);
    if (parsedInstant === null) {
      issues.push('INVALID_UTC_INSTANT');
    } else {
      if (parsedInstant.nanoseconds > futureLimit) issues.push('FUTURE_VALUE');
      if (
        value.zoneBasis === 'spec-defined-utc' &&
        calendarNanoseconds(parts) !== parsedInstant.nanoseconds
      ) {
        issues.push('UTC_LOCAL_MISMATCH');
      }
      if (
        value.zoneBasis === 'explicit-offset' &&
        value.offsetMinutes !== undefined &&
        offsetIsValid
      ) {
        const expected =
          calendarNanoseconds(parts) - BigInt(value.offsetMinutes) * 60n * 1_000_000_000n;
        if (expected !== parsedInstant.nanoseconds) issues.push('OFFSET_INSTANT_MISMATCH');
      }
    }
  } else if (calendarNanoseconds(parts) > futureLimit) {
    issues.push('FUTURE_VALUE');
  }

  if (value.zoneBasis === 'explicit-offset') {
    if (value.offsetMinutes === undefined || value.instantUtc === undefined) {
      issues.push('INCOMPLETE_EXPLICIT_OFFSET');
    }
  }
  if (value.zoneBasis === 'spec-defined-utc' && value.instantUtc === undefined) {
    issues.push('MISSING_SPEC_UTC_INSTANT');
  }
  if (
    (value.zoneBasis === 'floating-local' || value.zoneBasis === 'date-only') &&
    value.instantUtc !== undefined
  ) {
    issues.push('FLOATING_VALUE_HAS_INSTANT');
  }

  return [...new Set(issues)].sort();
}

function scoreCandidate(
  candidate: DateCandidateInput,
  request: ResolveDateRequest,
  evaluationTime: ExactTime
): ScoredDateCandidate {
  const resolutionIssues: string[] = [];
  let eligibility: CandidateEligibility = 'eligible';

  if (candidate.fileId !== request.fileId) resolutionIssues.push('FILE_ID_MISMATCH');
  if (candidate.mediaKind !== request.mediaKind) resolutionIssues.push('MEDIA_KIND_MISMATCH');
  if (resolutionIssues.length > 0) eligibility = 'invalid';

  const tag = candidate.tag.toLowerCase();
  const semanticRule = expectedSemantics(candidate);
  if (semanticRule !== null && !semanticRule.has(candidate.semantic)) {
    eligibility = 'invalid';
    resolutionIssues.push('SEMANTIC_TARGET_MISMATCH');
  }
  if (
    FORBIDDEN_SEMANTICS.has(candidate.semantic) ||
    FORBIDDEN_TAG_FRAGMENTS.some((fragment) => tag.includes(fragment))
  ) {
    eligibility = 'forbidden';
    resolutionIssues.push('FORBIDDEN_EVIDENCE');
  }

  const valueIssues = validateValue(candidate.value, evaluationTime);
  if (valueIssues.length > 0) {
    eligibility = 'invalid';
    resolutionIssues.push(...valueIssues);
  }

  const base = baseScore(candidate);
  const cap = semanticCap(candidate);
  if (eligibility === 'eligible' && (base === 0 || cap === 0)) {
    eligibility = 'corroboration-only';
    resolutionIssues.push('NO_SELECTION_RULE');
  }

  const modifiers: ScoreModifier[] = [];
  if (
    candidate.value.zoneBasis === 'explicit-offset' ||
    candidate.value.zoneBasis === 'spec-defined-utc'
  ) {
    modifiers.push({ code: 'TRUSTED_ZONE', delta: 4 });
  } else if (candidate.value.zoneBasis === 'gps-inferred') {
    modifiers.push({ code: 'GPS_ZONE_INFERENCE', delta: -10 });
  } else if (candidate.value.zoneBasis === 'device-zone-inferred') {
    modifiers.push({ code: 'DEVICE_ZONE_INFERENCE', delta: -15 });
  }

  if (candidate.value.fractionalDigits !== undefined) {
    modifiers.push({ code: 'SOURCE_SUBSECONDS', delta: 2 });
  }
  if (candidate.value.precision === 'date') {
    modifiers.push({ code: 'DATE_ONLY', delta: -25 });
  } else if (candidate.value.precision === 'minute') {
    modifiers.push({ code: 'MINUTE_ONLY', delta: -5 });
  }
  if (candidate.issues?.includes('KNOWN_EXPORT_OR_TRANSCODE')) {
    modifiers.push({ code: 'KNOWN_EXPORT_OR_TRANSCODE', delta: -20 });
  }

  const modifierTotal = modifiers.reduce((sum, modifier) => sum + modifier.delta, 0);
  const final = eligibility === 'eligible' ? Math.max(0, Math.min(cap, base + modifierTotal)) : 0;
  const score: CandidateScore = { base, modifiers, semanticCap: cap, final };

  return {
    ...candidate,
    ...(candidate.issues === undefined ? {} : { issues: [...candidate.issues] }),
    value: { ...candidate.value },
    eligibility,
    score,
    resolutionIssues: [...new Set(resolutionIssues)].sort(),
  };
}

function precisionUnitNanoseconds(precision: DatePrecision): bigint {
  switch (precision) {
    case 'date':
      return 24n * 60n * 60n * 1_000_000_000n;
    case 'minute':
      return 60n * 1_000_000_000n;
    case 'second':
      return 1_000_000_000n;
    case 'millisecond':
      return 1_000_000n;
    case 'microsecond':
      return 1_000n;
    case 'nanosecond':
      return 1n;
  }
}

function comparableNanoseconds(value: ParsedDateValue): bigint | null {
  if (value.instantUtc !== undefined) return parseUtcInstant(value.instantUtc)?.nanoseconds ?? null;
  const parts = parseLocalIso(value.localIso);
  return parts ? calendarNanoseconds(parts) : null;
}

function floorDivide(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value < 0n && value % divisor !== 0n ? quotient - 1n : quotient;
}

function valuesAgree(left: ParsedDateValue, right: ParsedDateValue): boolean {
  const coarserPrecision =
    PRECISION_ORDER[left.precision] <= PRECISION_ORDER[right.precision]
      ? left.precision
      : right.precision;

  if ((left.instantUtc === undefined) !== (right.instantUtc === undefined)) return false;
  const leftTime = comparableNanoseconds(left);
  const rightTime = comparableNanoseconds(right);
  if (leftTime === null || rightTime === null) return false;
  const unit = precisionUnitNanoseconds(coarserPrecision);
  return floorDivide(leftTime, unit) === floorDivide(rightTime, unit);
}

function compareCandidateStrength(left: ScoredDateCandidate, right: ScoredDateCandidate): number {
  if (left.score.final !== right.score.final) return right.score.final - left.score.final;

  const zoneRank = (value: ParsedDateValue): number => {
    if (value.zoneBasis === 'explicit-offset' || value.zoneBasis === 'spec-defined-utc') return 2;
    if (value.zoneBasis === 'gps-inferred' || value.zoneBasis === 'device-zone-inferred') return 1;
    return 0;
  };
  const zoneDifference = zoneRank(right.value) - zoneRank(left.value);
  if (zoneDifference !== 0) return zoneDifference;

  const precisionDifference =
    PRECISION_ORDER[right.value.precision] - PRECISION_ORDER[left.value.precision];
  if (precisionDifference !== 0) return precisionDifference;
  return left.id.localeCompare(right.id);
}

function createGroups(candidates: ScoredDateCandidate[]): CandidateGroup[] {
  const membershipSets = new Map<string, ScoredDateCandidate[]>();
  const orderedAnchors = [...candidates].sort((left, right) => {
    const precisionDifference =
      PRECISION_ORDER[right.value.precision] - PRECISION_ORDER[left.value.precision];
    if (precisionDifference !== 0) return precisionDifference;
    const leftTime = comparableNanoseconds(left.value);
    const rightTime = comparableNanoseconds(right.value);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return leftTime < rightTime ? -1 : 1;
    }
    return compareCandidateStrength(left, right);
  });

  for (const anchor of orderedAnchors) {
    const alreadyRepresented = [...membershipSets.values()].some((members) =>
      members.includes(anchor)
    );
    if (alreadyRepresented) continue;
    const members = candidates.filter((candidate) => valuesAgree(anchor.value, candidate.value));
    const membershipKey = JSON.stringify(members.map((candidate) => candidate.id).sort());
    membershipSets.set(membershipKey, members);
  }

  return [...membershipSets.values()]
    .map((members) => {
      const sortedMembers = [...members].sort(compareCandidateStrength);
      const families = new Set(sortedMembers.map((candidate) => candidate.sourceKind));
      const corroborationBonus = families.size >= 3 ? 12 : families.size >= 2 ? 8 : 0;
      const score = Math.min(100, sortedMembers[0].score.final + corroborationBonus);
      const ids = sortedMembers.map((candidate) => candidate.id).sort();
      return {
        id: `group:${JSON.stringify(ids)}`,
        candidates: sortedMembers,
        score,
        corroborated: corroborationBonus > 0,
      };
    })
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const candidateDifference = compareCandidateStrength(left.candidates[0], right.candidates[0]);
      if (candidateDifference !== 0) return candidateDifference;
      return left.id.localeCompare(right.id);
    });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isJsonSafe(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length) return false;
    if (
      keys.some((key) => {
        const index = Number(key);
        return (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key
        );
      })
    ) {
      return false;
    }
  }

  ancestors.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  const safe = entries.every((entry) => isJsonSafe(entry, ancestors));
  ancestors.delete(value);
  return safe;
}

function assertCandidateInput(candidate: DateCandidateInput): void {
  if (!isJsonSafe(candidate.rawValue)) {
    throw new TypeError('candidate rawValue must be JSON-safe');
  }
  if (!isJsonSafe(candidate)) {
    throw new TypeError('candidate must be JSON-safe');
  }
  const requiredStrings = [
    candidate.id,
    candidate.fileId,
    candidate.mediaKind,
    candidate.semantic,
    candidate.sourceKind,
    candidate.sourceFamily,
    candidate.tag,
  ];
  if (requiredStrings.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('candidate required fields must be non-empty strings');
  }
  if (
    typeof candidate.value !== 'object' ||
    candidate.value === null ||
    typeof candidate.value.localIso !== 'string' ||
    typeof candidate.value.zoneBasis !== 'string' ||
    typeof candidate.value.precision !== 'string'
  ) {
    throw new TypeError('candidate value must contain date provenance fields');
  }
}

export function resolveDateCandidates(request: ResolveDateRequest): DateResolutionRecord {
  const evaluationTime = parseUtcInstant(request.evaluationTimeUtc);
  if (evaluationTime === null) {
    throw new TypeError('evaluationTimeUtc must be a valid UTC timestamp');
  }

  request.candidates.forEach(assertCandidateInput);
  const candidateIds = request.candidates.map((candidate) => candidate.id);
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new TypeError('candidate ids must be unique');
  }

  const candidates = [...request.candidates]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((candidate) => {
      const detachedCandidate: DateCandidateInput = {
        ...candidate,
        rawValue: JSON.parse(JSON.stringify(candidate.rawValue)),
        value: { ...candidate.value },
        ...(candidate.issues === undefined ? {} : { issues: [...candidate.issues] }),
      };
      return scoreCandidate(detachedCandidate, request, evaluationTime);
    });

  const selectable = candidates.filter(
    (candidate) => candidate.eligibility === 'eligible' && candidate.score.final > 0
  );
  const groups = createGroups(selectable);
  const rejected = candidates
    .filter((candidate) => candidate.eligibility !== 'eligible')
    .map((candidate) => ({
      candidateId: candidate.id,
      reasons: [...candidate.resolutionIssues],
    }));

  const baseRecord = {
    policyVersion: DATE_RESOLUTION_POLICY_VERSION,
    fileId: request.fileId,
    mediaKind: request.mediaKind,
    target: targetForMedia(request.mediaKind),
    evaluationTimeUtc: request.evaluationTimeUtc,
    rejected,
    candidates,
  };

  if (groups.length === 0) {
    return {
      ...baseRecord,
      status: 'unresolved',
      confidence: 'none',
      contenderIds: [],
      reasonCodes: ['NO_ELIGIBLE_CANDIDATES'],
    };
  }

  const top = groups[0];
  const second = groups[1];
  const lead = second ? top.score - second.score : 100;
  const reasonCodes: string[] = [];
  if (top.corroborated) reasonCodes.push('INDEPENDENT_CORROBORATION');

  if (second && second.score >= 75 && lead < 15) {
    reasonCodes.push('STRONG_CONFLICT');
    return {
      ...baseRecord,
      status: 'ambiguous',
      confidence: 'none',
      contenderIds: uniqueSorted([
        ...top.candidates.map((candidate) => candidate.id),
        ...second.candidates.map((candidate) => candidate.id),
      ]),
      reasonCodes: uniqueSorted(reasonCodes),
    };
  }

  const selected = top.candidates[0];
  if (top.score >= 90 && lead >= 15) {
    reasonCodes.push('RESOLVED_HIGH_CONFIDENCE');
    return {
      ...baseRecord,
      status: 'resolved',
      confidence: 'high',
      selectedCandidateId: selected.id,
      selectedGroupId: top.id,
      selectedGroupScore: top.score,
      selectedValue: { ...selected.value },
      contenderIds: top.candidates.map((candidate) => candidate.id).sort(),
      reasonCodes: uniqueSorted(reasonCodes),
    };
  }

  if (top.score >= 75 && lead >= 10) {
    reasonCodes.push('RESOLVED_MEDIUM_CONFIDENCE');
    return {
      ...baseRecord,
      status: 'resolved',
      confidence: 'medium',
      selectedCandidateId: selected.id,
      selectedGroupId: top.id,
      selectedGroupScore: top.score,
      selectedValue: { ...selected.value },
      contenderIds: top.candidates.map((candidate) => candidate.id).sort(),
      reasonCodes: uniqueSorted(reasonCodes),
    };
  }

  if (top.score >= 60) {
    reasonCodes.push('REVIEW_REQUIRED_LOW_CONFIDENCE');
    return {
      ...baseRecord,
      status: 'review-required',
      confidence: 'low',
      selectedCandidateId: selected.id,
      selectedGroupId: top.id,
      selectedGroupScore: top.score,
      selectedValue: { ...selected.value },
      contenderIds: top.candidates.map((candidate) => candidate.id).sort(),
      reasonCodes: uniqueSorted(reasonCodes),
    };
  }

  return {
    ...baseRecord,
    status: 'unresolved',
    confidence: 'none',
    contenderIds: top.candidates.map((candidate) => candidate.id).sort(),
    reasonCodes: ['INSUFFICIENT_CONFIDENCE'],
  };
}
