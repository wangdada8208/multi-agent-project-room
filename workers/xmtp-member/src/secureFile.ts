import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename } from "node:fs/promises";
import path from "node:path";

const writeChains = new Map<string, Promise<void>>();

async function writeSnapshot(file: string, serialized: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  const dirHandle = await open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

/** 0700/0600 + 原子 rename + file/dir fsync；同文件串行写并在调用时快照。 */
export async function writeJsonSecure(file: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  const key = path.resolve(file);
  const previous = writeChains.get(key) ?? Promise.resolve();
  const run = previous.then(() => writeSnapshot(file, serialized));
  const tail = run.catch(() => {});
  writeChains.set(key, tail);
  try {
    await run;
  } finally {
    if (writeChains.get(key) === tail) writeChains.delete(key);
  }
}
