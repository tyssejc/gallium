import { GtmClient } from "./client.ts";
import { filePacer } from "./pace.ts";

export function liveClient(token: string): GtmClient {
  const onWait = (ms: number) => console.error(`gallium: pacing — waiting ${Math.ceil(ms / 1000)}s for GTM quota window`);
  return new GtmClient(token, fetch, { pacer: filePacer({ onWait }) });
}
