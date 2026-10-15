const DEFAULT_MAX_LENGTH = 240;

/**
 * Background-task fields such as `name` and `error` originate from arbitrary
 * subprocess output. They end up inside wake messages that the model reads as
 * plain text, so a task that prints instruction-shaped output would otherwise be
 * able to steer the next turn.
 *
 * This does not make the text trusted. It removes control characters, collapses
 * it to one line, bounds its length, and fences it so the model can see where
 * untrusted content starts and stops.
 */
export function sanitizeUntrustedText(
  value: unknown,
  maxLength = DEFAULT_MAX_LENGTH,
): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  // eslint-disable-next-line no-control-regex
  const flattened = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  if (flattened.length === 0) return "";
  if (flattened.length <= maxLength) return flattened;
  return `${flattened.slice(0, maxLength)}… [truncated ${flattened.length - maxLength} chars]`;
}

/** Sanitize and fence a field, marking it as untrusted subprocess output. */
export function fenceUntrustedField(
  label: string,
  value: unknown,
  maxLength = DEFAULT_MAX_LENGTH,
): string | undefined {
  const text = sanitizeUntrustedText(value, maxLength);
  if (!text) return undefined;
  return `${label}=<<untrusted:${label}|${text}>>`;
}
