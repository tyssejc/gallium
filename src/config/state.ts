import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ensureDirFor } from "../util/fs.ts";

export interface State { default_container?: string; }

export async function loadState(path: string): Promise<State> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  return parseToml(await file.text()) as State;
}
export async function saveState(path: string, state: State): Promise<void> {
  await ensureDirFor(path);
  await Bun.write(path, stringifyToml(state as Record<string, unknown>));
}
