/**
 * DateExtractor - Date extraction from filenames with century correction
 *
 * Ported from legacy media-organizer-enhanced-v2.3.0-safe-optimized.py
 * Includes all filename patterns, century correction, and date validation bounds.
 */

interface PatternResult {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export class DateExtractor {
  /**
   * Minimum valid date: 1990-01-01 (matches legacy min_past)
   */
  private static readonly MIN_YEAR = 1990;

  /**
   * Correct obvious century errors in dates.
   * Ported from legacy correct_century().
   *
   * - Years 1000-1999: use last 2 digits + 2000 (1515→2015, 1903→2003)
   * - Years 100-999: add 2000
   * - Years 1-99: add 2000
   */
  public correctCentury(date: Date): Date {
    const year = date.getFullYear();

    if (year >= 1000 && year <= 1999) {
      const lastTwo = year % 100;
      const newYear = 2000 + lastTwo;
      return new Date(
        Date.UTC(
          newYear,
          date.getUTCMonth(),
          date.getUTCDate(),
          date.getUTCHours(),
          date.getUTCMinutes(),
          date.getUTCSeconds()
        )
      );
    }

    if (year >= 100 && year <= 999) {
      return new Date(
        Date.UTC(
          year + 2000,
          date.getUTCMonth(),
          date.getUTCDate(),
          date.getUTCHours(),
          date.getUTCMinutes(),
          date.getUTCSeconds()
        )
      );
    }

    if (year >= 1 && year <= 99) {
      return new Date(
        Date.UTC(
          year + 2000,
          date.getUTCMonth(),
          date.getUTCDate(),
          date.getUTCHours(),
          date.getUTCMinutes(),
          date.getUTCSeconds()
        )
      );
    }

    return date;
  }

  /**
   * Validate that a date is within reasonable bounds.
   * Matches legacy: min_past = 1990-01-01, max_future = current year Dec 31
   */
  public isValidDate(date: Date): boolean {
    const now = new Date();
    const minPast = new Date(Date.UTC(DateExtractor.MIN_YEAR, 0, 1));
    const maxFuture = new Date(Date.UTC(now.getFullYear(), 11, 31, 23, 59, 59));

    return date >= minPast && date <= maxFuture;
  }

  /**
   * Extract date from filename using various patterns.
   * Ported from legacy extract_date_from_filename().
   *
   * Patterns:
   * 1. IMG_20210615_123045 / VID_20210615_123045 / PIC_ / PHOTO_
   * 2. 2021-06-15_12-30-45 / 2021-06-15_123045
   * 3. 20210615_123045 / 20210615123045
   * 4. Screenshot 2021-06-15 at 12.30.45
   */
  public extractDateFromFilename(filename: string): Date | null {
    const patterns: Array<{
      regex: RegExp;
      formatter: (match: RegExpMatchArray) => PatternResult | null;
    }> = [
      // IMG_20210615_123045.jpg or VID_20210615_123045.mp4
      {
        regex: /(IMG|VID|PIC|PHOTO)[-_](\d{4})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})/i,
        formatter: (m) => ({
          year: parseInt(m[2]),
          month: parseInt(m[3]),
          day: parseInt(m[4]),
          hour: parseInt(m[5]),
          minute: parseInt(m[6]),
          second: parseInt(m[7]),
        }),
      },
      // 2021-06-15_12-30-45 or 2021-06-15_123045
      {
        regex: /(\d{4})[-_](\d{2})[-_](\d{2})[-_ ](\d{2})[-_]?(\d{2})[-_]?(\d{2})/,
        formatter: (m) => ({
          year: parseInt(m[1]),
          month: parseInt(m[2]),
          day: parseInt(m[3]),
          hour: parseInt(m[4]),
          minute: parseInt(m[5]),
          second: parseInt(m[6]),
        }),
      },
      // 20210615_123045 or 20210615123045
      {
        regex: /(\d{4})(\d{2})(\d{2})[-_]?(\d{2})(\d{2})(\d{2})/,
        formatter: (m) => ({
          year: parseInt(m[1]),
          month: parseInt(m[2]),
          day: parseInt(m[3]),
          hour: parseInt(m[4]),
          minute: parseInt(m[5]),
          second: parseInt(m[6]),
        }),
      },
      // Screenshot 2021-06-15 at 12.30.45.png
      {
        regex: /Screenshot (\d{4})[-_](\d{2})[-_](\d{2}) at (\d{1,2})\.(\d{2})\.(\d{2})/i,
        formatter: (m) => ({
          year: parseInt(m[1]),
          month: parseInt(m[2]),
          day: parseInt(m[3]),
          hour: parseInt(m[4]),
          minute: parseInt(m[5]),
          second: parseInt(m[6]),
        }),
      },
    ];

    for (const { regex, formatter } of patterns) {
      const match = filename.match(regex);
      if (match) {
        try {
          const result = formatter(match);
          if (!result) continue;

          // Basic validation before creating date
          if (result.month < 1 || result.month > 12) continue;
          if (result.day < 1 || result.day > 31) continue;
          if (result.hour > 23 || result.minute > 59 || result.second > 59) continue;

          let date = new Date(
            Date.UTC(
              result.year,
              result.month - 1,
              result.day,
              result.hour,
              result.minute,
              result.second
            )
          );

          // Verify the date components match (catches invalid dates like Feb 30)
          if (
            date.getUTCFullYear() !== result.year ||
            date.getUTCMonth() !== result.month - 1 ||
            date.getUTCDate() !== result.day
          ) {
            continue;
          }

          // Apply century correction
          const corrected = this.correctCentury(date);
          if (corrected.getTime() !== date.getTime()) {
            date = corrected;
          }

          // Validate date is reasonable
          if (!this.isValidDate(date)) {
            continue;
          }

          return date;
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  /**
   * Get file modification date as fallback, with century correction and validation.
   * Ported from legacy get_fallback_date().
   */
  public getFallbackDate(mtime: Date): Date {
    let fileDate = new Date(mtime);

    // Apply century correction
    const corrected = this.correctCentury(fileDate);
    if (corrected.getTime() !== fileDate.getTime()) {
      fileDate = corrected;
    }

    // Validate
    if (!this.isValidDate(fileDate)) {
      return new Date(); // Use current time as last resort
    }

    return fileDate;
  }

  /**
   * Check if a filename already matches our processed naming pattern.
   * Ported from legacy is_already_processed().
   *
   * Pattern: YYYY-MM-DD_HH-MM-SS[.ssssss][_##].ext
   * Note: Files with all-zero subseconds are NOT considered processed.
   */
  public isAlreadyProcessed(filename: string): boolean {
    const baseName = filename.replace(/\.[^.]+$/, ''); // Remove extension

    // Check basic pattern
    const basicPattern = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:\.\d+)?(?:_\d{2})?$/;
    if (!basicPattern.test(baseName)) {
      return false;
    }

    // Extract subsecond part if present
    const subsecondMatch = baseName.match(/_(\d{2})-(\d{2})-(\d{2})(?:\.(\d+))?/);
    if (subsecondMatch && subsecondMatch[4]) {
      // Check if subsecond is all zeros
      try {
        if (parseInt(subsecondMatch[4]) === 0) {
          return false; // Bad format with all-zero subsecond
        }
      } catch {
        return false;
      }
    }

    return true;
  }

  /**
   * Format a date into the legacy filename format.
   * Ported from legacy format_filename_with_date().
   *
   * Format: YYYY-MM-DD_HH-MM-SS[.sss].ext
   */
  public formatFilenameWithDate(
    originalFilename: string,
    date: Date,
    subsecond: string = ''
  ): string {
    const ext = originalFilename.substring(originalFilename.lastIndexOf('.'));

    const year = date.getUTCFullYear().toString();
    const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = date.getUTCDate().toString().padStart(2, '0');
    const hour = date.getUTCHours().toString().padStart(2, '0');
    const minute = date.getUTCMinutes().toString().padStart(2, '0');
    const second = date.getUTCSeconds().toString().padStart(2, '0');

    let dateStr = `${year}-${month}-${day}_${hour}-${minute}-${second}`;

    // Add subsecond precision from EXIF only if it has meaningful (non-zero) digits
    if (subsecond) {
      try {
        const subsecondInt = parseInt(subsecond);
        if (subsecondInt > 0) {
          dateStr += `.${subsecond}`;
        }
      } catch {
        // Skip invalid subsecond
      }
    }

    return `${dateStr}${ext}`;
  }
}
