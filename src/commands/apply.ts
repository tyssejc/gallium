import type { Cmd } from "../command.ts";
import type { GtmClient } from "../gtm/client.ts";
import type { GtmWorkspace } from "../gtm/types.ts";
import { loadConfig, resolveContainer, type ResolvedContainer } from "../config/config.ts";
import { configPath } from "../paths.ts";
import { assertWriteAllowed, getUserToken } from "../auth/token.ts";
import { liveClient } from "../gtm/live.ts";
import { isQuotaError } from "../gtm/pace.ts";
import { loadSpec, type SpecEntry } from "../apply/spec.ts";
import { buildPlan, PlanError, type Op } from "../apply/plan.ts";
import { executePlan, type ExecResult } from "../apply/execute.ts";
import { fetchWorkspaceSnapshot } from "../pull/pull.ts";
import { requireWorkspaceAlias } from "./_shared.ts";

const USAGE = "usage: gallium apply <spec.json> -c <alias> --workspace <name|new:Title> [--commit]";
const NOT_PUBLISHED = "Not published. Preview and publish in the GTM UI.";
const CONFLICT_HINT = "The entity changed since it was read; re-run to plan against the current state.";
const PERMISSION_HINT = "If write access was revoked, run: gallium login --write";

export type WorkspaceTarget =
  | { mode: "existing"; workspaceId: string; name: string }
  | { mode: "new"; name: string };

const listed = (workspaces: GtmWorkspace[]) => workspaces.map((w) => `  ${w.name} (${w.workspaceId})`).join("\n");

// The alias's pinned workspace_id is deliberately never consulted: a write
// lands only in a workspace the user named on this command line.
export function resolveWorkspace(arg: string | undefined, workspaces: GtmWorkspace[]): WorkspaceTarget {
  if (!arg) throw new Error("apply requires --workspace <name> or --workspace new:<Title>; it never picks a workspace for you.");
  const isNew = arg.startsWith("new:");
  const name = isNew ? arg.slice("new:".length) : arg;
  if (!name) throw new Error("--workspace new: needs a title, e.g. --workspace new:GPC signal");
  const hits = workspaces.filter((w) => w.name === name);
  if (hits.length === 1) return { mode: "existing", workspaceId: hits[0]!.workspaceId, name };
  if (hits.length > 1) throw new Error(`${hits.length} workspaces are named "${name}"; rename one in the GTM UI. Workspaces:\n${listed(workspaces)}`);
  if (isNew) return { mode: "new", name };
  throw new Error(`No workspace named "${name}". Workspaces:\n${listed(workspaces)}\nTo create one, pass --workspace new:<Title>.`);
}

const opLine = (op: Op): string =>
  `${op.action.toUpperCase()} ${op.kind} "${op.name}"${op.changed?.length ? ` (${op.changed.join(", ")})` : ""}`;

// "GTM PUT <path> failed (409): <body>" → hint for the user, if any.
function failureHint(error: string): string | undefined {
  const m = error.match(/ failed \((\d{3})\): ([\s\S]*)$/);
  if (!m) return undefined;
  const status = Number(m[1]);
  const body = m[2]!;
  if (status === 409 || status === 412 || /fingerprint/i.test(body)) return CONFLICT_HINT;
  if (status === 403 && !isQuotaError(status, body)) return PERMISSION_HINT;
  return undefined;
}

// A new workspace is created from the latest version, which may hold changes
// nobody has published. Warns when that is the case; a failing live lookup
// (e.g. nothing ever published) is not worth stopping for.
async function warnIfLatestNotLive(client: GtmClient, c: ResolvedContainer, latest: string): Promise<void> {
  const live = await client.getLiveVersion(c.accountId, c.containerId).then((v) => v.containerVersionId, () => undefined);
  if (live !== undefined && live !== latest) {
    console.error(`warning: latest version v${latest} is not live (live is v${live}); a new workspace starts from v${latest}.`);
  }
}

// `error` is a failure after the target workspace exists and was not a write
// failure (that one is `exec.failed`): a verification read, or the first plan
// in a workspace this run just created.
interface Outcome { ops: Op[]; exec?: ExecResult; unverified?: Op[]; workspaceId?: string; error?: string; }

const errorText = (e: unknown): string =>
  e instanceof PlanError ? e.problems.join("; ") : e instanceof Error ? e.message : String(e);

export async function runApply(
  args: { specPath: string; alias: string; workspace: string | undefined; commit: boolean; json: boolean },
  deps: { client: GtmClient; container: ResolvedContainer; assertWriteAllowed: () => Promise<void> },
): Promise<number> {
  const { client, container: c } = deps;
  requireWorkspaceAlias(args.alias);
  let entries: SpecEntry[];
  try {
    entries = await loadSpec(args.specPath);
  } catch (e) {
    // loadSpec puts one problem per line under a header line.
    console.error((e as Error).message.split("\n").map((l) => l.trim()).join("\n"));
    return 1;
  }
  try {
    if (args.commit) await deps.assertWriteAllowed();
    const target = resolveWorkspace(args.workspace, await client.listWorkspaces(c.accountId, c.containerId));

    let latest: string | undefined;
    if (target.mode === "new") {
      latest = (await client.getLatestVersionHeader(c.accountId, c.containerId)).containerVersionId;
      await warnIfLatestNotLive(client, c, latest);
    }

    let outcome: Outcome;
    if (!args.commit) {
      const snap = target.mode === "existing"
        ? await fetchWorkspaceSnapshot(client, client.wsPath(c.accountId, c.containerId, target.workspaceId))
        : await client.getVersion(c.accountId, c.containerId, latest!);
      outcome = { ops: buildPlan(entries, snap), workspaceId: target.mode === "existing" ? target.workspaceId : undefined };
    } else {
      const workspaceId = target.mode === "existing"
        ? target.workspaceId
        : (await client.createWorkspace(c.accountId, c.containerId, target.name)).workspaceId;
      const ws = client.wsPath(c.accountId, c.containerId, workspaceId);
      let ops: Op[];
      try {
        ops = buildPlan(entries, await fetchWorkspaceSnapshot(client, ws));
      } catch (e) {
        // A workspace created this run exists now; never leave it unreported.
        if (target.mode === "existing") throw e;
        outcome = { ops: [], workspaceId, error: errorText(e) };
        report(args, target.name, outcome, c);
        return 1;
      }
      // Progress goes to stderr as each write lands: a paced commit can take
      // minutes, and stdout must stay the report (parseable under --json).
      const exec = await executePlan(ops, client, ws, {
        onOp: (op, result, error) => console.error(result === "applied" ? opLine(op) : `FAILED ${opLine(op)}: ${error}`),
      });
      outcome = { ops, exec, workspaceId };
      // Re-read and re-plan: every planned change must now be present, so the
      // same spec plans to nothing but UNCHANGED. A failure here must not hide
      // the report of the writes that were sent.
      if (!exec.failed) {
        try {
          outcome.unverified = buildPlan(entries, await fetchWorkspaceSnapshot(client, ws)).filter((op) => op.action !== "unchanged");
        } catch (e) {
          outcome.error = errorText(e);
        }
      }
    }

    report(args, target.name, outcome, c);
    return outcome.exec?.failed || outcome.unverified?.length || outcome.error ? 1 : 0;
  } catch (e) {
    if (e instanceof PlanError) {
      for (const p of e.problems) console.error(p);
      return 1;
    }
    throw e;
  }
}

function report(
  args: { alias: string; commit: boolean; json: boolean }, name: string, { ops, exec, unverified, workspaceId, error }: Outcome,
  c: ResolvedContainer,
): void {
  const url = workspaceId
    ? `https://tagmanager.google.com/#/container/accounts/${c.accountId}/containers/${c.containerId}/workspaces/${workspaceId}`
    : undefined;

  if (args.json) {
    console.log(JSON.stringify({
      container: args.alias,
      workspace: { name, id: workspaceId ?? null, ...(url && { url }) },
      committed: args.commit,
      ops,
      ...(exec?.failed && { failed: exec.failed, pending: exec.pending }),
      ...(unverified?.length && { unverified }),
      ...(error && { error }),
    }, null, 2));
    return;
  }

  // Names the target first, so it can be read back before a commit.
  const lines: string[] = [`Target: ${args.alias} — workspace "${name}" (${workspaceId ?? "will be created"})`];
  if (!args.commit) {
    lines.push("DRY RUN — nothing sent. Re-run with --commit to apply.", ...ops.map(opLine));
  } else if (exec?.failed) {
    lines.push(...exec.applied.map(opLine), `FAILED ${opLine(exec.failed.op)}: ${exec.failed.error}`,
      ...exec.pending.map((op) => `NOT APPLIED ${opLine(op)}`));
    const hint = failureHint(exec.failed.error);
    if (hint) lines.push(hint);
  } else if (!exec) {
    lines.push(`CREATED workspace "${name}" (${workspaceId}); no entity writes were sent.`, `FAILED: ${error}`);
  } else {
    lines.push(`APPLIED to workspace "${name}" (${workspaceId})`, ...ops.map(opLine),
      ...(unverified ?? []).map((op) => `NOT VERIFIED ${opLine(op)}`),
      ...(error ? [`VERIFY FAILED: ${error}`] : []));
  }
  if (url) lines.push(url);
  if (args.commit) lines.push(NOT_PUBLISHED);
  console.log(lines.join("\n"));
}

// gallium apply <spec.json> -c <alias> --workspace <name|new:Title> [--commit] [--json]
export const cmdApply: Cmd = async (positionals, flags) => {
  const specPath = positionals[0];
  if (!specPath) throw new Error(USAGE);
  // Deliberately not resolveAlias: a write never falls back to the default container.
  const raw = flags.container;
  if (typeof raw !== "string" || !raw) throw new Error(`apply requires -c <alias>; it never uses the default container.\n${USAGE}`);
  const cfg = await loadConfig(configPath());
  const container = resolveContainer(cfg, requireWorkspaceAlias(raw));
  const client = liveClient(await getUserToken(cfg));
  return runApply(
    { specPath, alias: raw, workspace: flags.workspace as string | undefined, commit: !!flags.commit, json: !!flags.json },
    { client, container, assertWriteAllowed },
  );
};
