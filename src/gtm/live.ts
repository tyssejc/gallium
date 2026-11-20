import { GtmClient } from "./client.ts";
import { filePacer } from "./pace.ts";

export function liveClient(token: string): GtmClient {
  return new GtmClient(token, fetch, { pacer: filePacer() });
}
