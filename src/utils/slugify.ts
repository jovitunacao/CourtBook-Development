/**
 * CourtBook / BookSuite — Slug Utility
 *
 * Provides slug generation and strict validation adhering to BookSuite database schema constraints:
 * - Length: 2 to 60 characters
 * - Format: Lowercase letters, numbers, and single hyphens: ^[a-z0-9]+(-[a-z0-9]+)*$
 * - No leading, trailing, or consecutive hyphens
 */

/**
 * Converts arbitrary input text into a clean, URL-safe slug.
 * - Decomposes diacritics/accents (e.g. é -> e)
 * - Converts to lowercase
 * - Replaces non-alphanumeric characters with hyphens
 * - Collapses consecutive hyphens into a single hyphen
 * - Trims hyphens from start and end
 * - Truncates to max 60 characters (ensuring trailing hyphen is removed if cut)
 */
export function slugify(text: string): string {
  if (!text || typeof text !== 'string') return '';

  const cleaned = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-_]/g, '') // Remove invalid chars
    .replace(/[\s_]+/g, '-') // Convert spaces & underscores to hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-+|-+$/g, '') // Trim leading/trailing hyphens
    .slice(0, 60)
    .replace(/-+$/, ''); // Clean any hyphen left by truncation

  return cleaned;
}

/**
 * Checks whether a given string strictly satisfies the BookSuite database slug constraints:
 * - Length between 2 and 60 characters
 * - Matches regex ^[a-z0-9]+(-[a-z0-9]+)*$
 */
export function isValidSlug(slug: string): boolean {
  if (!slug || typeof slug !== 'string') return false;
  const trimmed = slug.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed);
}

/**
 * Validates a slug against database constraints and returns an explicit, user-friendly error message if invalid.
 */
export function validateSlug(
  slug: string,
  fieldName: string = 'Slug'
): { isValid: boolean; error?: string } {
  if (!slug || typeof slug !== 'string' || slug.trim().length === 0) {
    return { isValid: false, error: `${fieldName} is required.` };
  }

  const clean = slug.trim();

  if (clean.length < 2) {
    return { isValid: false, error: `${fieldName} must be at least 2 characters long.` };
  }

  if (clean.length > 60) {
    return { isValid: false, error: `${fieldName} cannot exceed 60 characters.` };
  }

  if (/[A-Z]/.test(clean)) {
    return { isValid: false, error: `${fieldName} must be lowercase.` };
  }

  if (clean.startsWith('-')) {
    return { isValid: false, error: `${fieldName} cannot start with a hyphen.` };
  }

  if (clean.endsWith('-')) {
    return { isValid: false, error: `${fieldName} cannot end with a hyphen.` };
  }

  if (/--/.test(clean)) {
    return { isValid: false, error: `${fieldName} cannot contain consecutive hyphens.` };
  }

  if (!/^[a-z0-9-]+$/.test(clean)) {
    return {
      isValid: false,
      error: `${fieldName} can only contain lowercase letters, numbers, and hyphens.`,
    };
  }

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(clean)) {
    return {
      isValid: false,
      error: `${fieldName} must start and end with an alphanumeric character.`,
    };
  }

  return { isValid: true };
}
