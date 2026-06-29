import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  LastWriteResultSchema,
  OperationReceiptSchema,
  type LastWriteResult,
  type OperationReceipt,
  type OperationReceiptRef
} from "../contracts/operation-receipt.contract.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";
import { validateRepoPath } from "./path-sandbox.js";

export const LAST_WRITE_RECEIPT_PATH = ".chatgpt/operations/last-write.json";

type WriteLastWriteInput = Omit<OperationReceipt, "schema_version" | "operation_id" | "timestamp">;

export class OperationReceiptService {
  constructor(private readonly root: string) {}

  async writeLastWrite(input: WriteLastWriteInput): Promise<{
    ok: boolean;
    operation_receipt?: OperationReceiptRef;
    warnings: string[];
  }> {
    try {
      const receipt: OperationReceipt = {
        schema_version: 1,
        operation_id: createOperationId(),
        timestamp: new Date().toISOString(),
        ...sanitizeWriteInput(input)
      };
      const parsed = OperationReceiptSchema.parse(receipt);
      const absolutePath = join(this.root, LAST_WRITE_RECEIPT_PATH);
      await mkdir(dirname(absolutePath), { recursive: true });
      await atomicWriteJson(absolutePath, parsed);
      return {
        ok: true,
        operation_receipt: {
          operation_id: parsed.operation_id,
          path: LAST_WRITE_RECEIPT_PATH
        },
        warnings: []
      };
    } catch {
      return { ok: false, warnings: ["OPERATION_RECEIPT_WRITE_FAILED"] };
    }
  }

  async readLastWrite(repoId: string): Promise<LastWriteResult> {
    try {
      const raw = await readFile(join(this.root, LAST_WRITE_RECEIPT_PATH), "utf8");
      const parsed = OperationReceiptSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.repo_id !== repoId || !isSafeReceipt(parsed.data)) {
        return missing("INVALID_LAST_WRITE_RECEIPT");
      }
      return LastWriteResultSchema.parse({
        ok: true,
        found: true,
        receipt: parsed.data,
        next_tool_payloads: {
          repo_git_review: { repo_id: repoId }
        },
        warnings: []
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        return missing("NO_LAST_WRITE_RECEIPT");
      }
      return missing("INVALID_LAST_WRITE_RECEIPT");
    }
  }
}

function sanitizeWriteInput(input: WriteLastWriteInput): WriteLastWriteInput {
  return {
    ...input,
    touched_paths: uniqueSafePaths(input.touched_paths),
    changed_paths: uniqueSafePaths(input.changed_paths),
    created_paths: uniqueSafePaths(input.created_paths),
    modified_paths: uniqueSafePaths(input.modified_paths)
  };
}

function isSafeReceipt(receipt: OperationReceipt): boolean {
  const paths = [
    ...receipt.touched_paths,
    ...receipt.changed_paths,
    ...receipt.created_paths,
    ...receipt.modified_paths
  ];
  return (
    paths.every(isSafeRepoPath)
    && redactSensitiveText(receipt.summary) === receipt.summary
  );
}

function uniqueSafePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => validateRepoPath(path)))];
}

function isSafeRepoPath(path: string): boolean {
  try {
    return validateRepoPath(path) === path && !path.startsWith("/");
  } catch {
    return false;
  }
}

function missing(warning: "NO_LAST_WRITE_RECEIPT" | "INVALID_LAST_WRITE_RECEIPT"): LastWriteResult {
  return {
    ok: true,
    found: false,
    next_tool_payloads: {},
    warnings: [warning]
  };
}

async function atomicWriteJson(path: string, value: OperationReceipt): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function createOperationId(): string {
  return `write-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT"
  );
}
