import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDirFor(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
