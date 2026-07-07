import { SECRET_VALUE_PATTERN } from "../policies/secret-patterns.js";

export class SecretScanner {
  hasSecretValue(text: string): boolean {
    SECRET_VALUE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SECRET_VALUE_PATTERN.exec(text)) !== null) {
      if (!isPlaceholderSecret(match[0])) {
        return true;
      }
    }
    return false;
  }

  hasSensitiveMatchCrossing(text: string, rangeStart: number, rangeEnd: number): boolean {
    SECRET_VALUE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SECRET_VALUE_PATTERN.exec(text)) !== null) {
      if (isPlaceholderSecret(match[0])) continue;
      const matchStart = match.index;
      const matchEnd = match.index + match[0].length;
      const crossesStart = matchStart < rangeStart && matchEnd > rangeStart;
      const crossesEnd = matchStart < rangeEnd && matchEnd > rangeEnd;
      if (crossesStart || crossesEnd) return true;
    }
    return false;
  }

  redact(text: string): string {
    SECRET_VALUE_PATTERN.lastIndex = 0;
    return text.replace(SECRET_VALUE_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]");
  }
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("[redacted_secret]") ||
    normalized.includes("replace-me") ||
    normalized.includes("your-api-key-here") ||
    normalized.includes("<openai_api_key>") ||
    normalized === "sk-..." ||
    normalized.endsWith("=sk-...")
  );
}
