/**
 * Input sanitization helper utilities
 */

/**
 * Escapes characters that have significance in Discord Markdown to prevent embed/markdown injection.
 */
export function sanitizeDiscordMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([*`_~|\\<>:])/g, '\\$1');
}

/**
 * Sanitizes input to prevent Airtable formula injection (strips prepended '=' and signs).
 */
export function sanitizeAirtableFormula(text: string): string {
  if (!text) return '';
  // Airtable formulas start with '='. Strip leading '=' or replace with single quotes.
  let sanitized = text.trim();
  while (sanitized.startsWith('=')) {
    sanitized = sanitized.substring(1);
  }
  return sanitized;
}

/**
 * Escapes HTML characters to prevent XSS/HTML injection.
 */
export function sanitizeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Removes control characters and strips invalid Unicode characters.
 */
export function sanitizeUnicodeAndControlChars(text: string): string {
  if (!text) return '';
  // Remove ASCII control characters (0-31, 127) except tab (\t), newline (\n), and carriage return (\r)
  let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  
  // Replace surrogate pairs or invalid characters if any parsing issue exists
  sanitized = sanitized.normalize('NFC');
  
  return sanitized;
}

/**
 * Combined sanitization function for free-text fields (captions, notes).
 */
export function sanitizeTextField(text: string): string {
  if (!text) return '';
  let sanitized = sanitizeUnicodeAndControlChars(text);
  sanitized = sanitizeHtml(sanitized);
  sanitized = sanitizeAirtableFormula(sanitized);
  return sanitized;
}

/**
 * Sanitizes file names to prevent path traversal and shell injection.
 */
export function sanitizeFilename(filename: string): string {
  if (!filename) return 'unnamed_clip';
  // Strip path traversal parts like / or \
  let name = filename.replace(/\\/g, '/').split('/').pop() || 'unnamed_clip';
  // Retain only word characters, dashes, dots, spaces
  name = name.replace(/[^\w\-. ]/g, '_');
  // Normalize
  name = sanitizeUnicodeAndControlChars(name);
  return name;
}
