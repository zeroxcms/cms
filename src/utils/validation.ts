// Validation helpers for admin page forms.

const SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * Validates the shared name/slug fields used by both page create and update.
 * Returns a list of human-readable error messages (empty when valid).
 */
export function validatePageBasics(name: string, slug: string): string[] {
  const errors: string[] = [];
  if (!name) errors.push('Page name is required.');
  if (!slug) errors.push('Slug is required.');
  if (slug && !SLUG_PATTERN.test(slug)) {
    errors.push('Slug may only contain lowercase letters, numbers and hyphens.');
  }
  return errors;
}
