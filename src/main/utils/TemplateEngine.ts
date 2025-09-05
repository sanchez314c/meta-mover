import * as path from 'path';
import * as fs from 'fs';

export interface TemplateVariables {
  YYYY: string;
  MM: string;
  DD: string;
  hh: string;
  mm: string;
  ss: string;
  original: string;
  sequence?: string;
  camera?: string;
  event?: string;
  country?: string;
  city?: string;
}

export class TemplateEngine {
  /**
   * Process a filename template with variables
   */
  static processTemplate(template: string, variables: Record<string, string | undefined>): string {
    let result = template;

    // Replace all template variables
    Object.entries(variables).forEach(([key, value]) => {
      if (value !== undefined) {
        const regex = new RegExp(`\\{${key}\\}`, 'g');
        result = result.replace(regex, value);
      }
    });

    return result;
  }

  /**
   * Generate a unique filename if the target already exists
   */
  static generateUniqueFilename(basePath: string, filename: string): string {
    const ext = path.extname(filename);
    const nameWithoutExt = path.basename(filename, ext);
    let counter = 1;
    let uniqueName = filename;

    while (fs.existsSync(path.join(basePath, uniqueName))) {
      uniqueName = `${nameWithoutExt}_${counter}${ext}`;
      counter++;
    }

    return uniqueName;
  }

  /**
   * Validate template syntax
   */
  static validateTemplate(template: string): { isValid: boolean; error?: string } {
    // Check for balanced braces
    const openBraces = (template.match(/\{/g) || []).length;
    const closeBraces = (template.match(/\}/g) || []).length;

    if (openBraces !== closeBraces) {
      return { isValid: false, error: 'Unbalanced braces in template' };
    }

    // Check for empty variables
    const emptyVars = template.match(/\{\}/g);
    if (emptyVars) {
      return { isValid: false, error: 'Empty template variables found' };
    }

    return { isValid: true };
  }

  /**
   * Render template with variables (alias for processTemplate)
   */
  static render(template: string, variables: Record<string, string | undefined>): string {
    return this.processTemplate(template, variables);
  }

  /**
   * Extract template variables from a processed path
   */
  static extractVariablesFromPath(filePath: string, _template: string): Record<string, string> {
    const variables: Partial<TemplateVariables> = {};
    const filename = path.basename(filePath);

    // Extract date components if present
    const dateMatch = filename.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
    if (dateMatch) {
      variables.YYYY = dateMatch[1];
      variables.MM = dateMatch[2];
      variables.DD = dateMatch[3];
    }

    // Extract time components if present
    const timeMatch = filename.match(/(\d{2})[-_](\d{2})[-_](\d{2})/);
    if (timeMatch) {
      variables.hh = timeMatch[1];
      variables.mm = timeMatch[2];
      variables.ss = timeMatch[3];
    }

    // Extract original filename (remove date/time prefixes)
    const cleanName = filename.replace(
      /^(\d{4}[-_]\d{2}[-_]\d{2}[_-]?)?(\d{2}[-_]\d{2}[-_]\d{2}[_-]?)?/,
      ''
    );
    variables.original = cleanName;

    return variables;
  }
}
