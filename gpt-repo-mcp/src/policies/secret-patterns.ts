export const SECRET_FILE_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_ed25519",
  "**/secrets/**",
  "**/credentials/**",
  "*secret*",
  "*credential*"
] as const;

export const SECRET_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]+|[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Za-z0-9_]*\s*=\s*[^\s]+)/gi;
