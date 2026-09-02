export interface GtmParameter {
  type: string; key?: string; value?: string;
  list?: GtmParameter[]; map?: GtmParameter[];
}
export interface GtmTag {
  tagId: string; name: string; type: string; parameter?: GtmParameter[];
  firingTriggerId?: string[]; blockingTriggerId?: string[];
  parentFolderId?: string; paused?: boolean; notes?: string;
}
export interface GtmCondition { type?: string; parameter?: GtmParameter[]; }
export interface GtmTrigger {
  triggerId: string; name: string; type: string;
  parameter?: GtmParameter[]; filter?: GtmCondition[]; customEventFilter?: GtmCondition[];
  autoEventFilter?: GtmCondition[];
  parentFolderId?: string; notes?: string;
}
export interface GtmVariable {
  variableId: string; name: string; type: string;
  parameter?: GtmParameter[]; parentFolderId?: string; notes?: string;
}
export interface GtmBuiltInVariable { type: string; name: string; }
export interface GtmFolder { folderId: string; name: string; }
export interface GtmTemplate { templateId: string; name: string; templateData?: string; }

export interface GtmAccount { accountId: string; name: string; }
export interface GtmContainer { accountId: string; containerId: string; name: string; publicId?: string; }
export interface GtmWorkspace { workspaceId: string; name: string; }

export interface WorkspaceChange {
  changeStatus: "added" | "deleted" | "updated" | "none" | string;
  tag?: GtmTag; trigger?: GtmTrigger; variable?: GtmVariable; folder?: GtmFolder;
  builtInVariable?: GtmBuiltInVariable; customTemplate?: GtmTemplate;
}
export interface WorkspaceStatus {
  workspaceChange?: WorkspaceChange[];
  mergeConflict?: unknown[];
}

export interface GtmEnvironment {
  environmentId: string; name: string; type: string;
  containerVersionId?: string; authorizationCode?: string; workspaceId?: string;
}
// NOTE: ContainerVersionHeader carries neither `fingerprint` nor `description`,
// so `gallium versions list` cannot date or describe rows without a full
// `versions.get` per row — which is what `--dates` opts into.
export interface GtmVersionHeader {
  containerVersionId: string; name?: string; deleted?: boolean;
  numMacros?: string; numRules?: string; numTags?: string;
  numTriggers?: string; numVariables?: string;
}
export interface GtmContainerVersion {
  // The API calls this `description`, not `notes` — `notes` is an entity-level
  // field. Typing it wrong meant it silently never populated.
  containerVersionId: string; name?: string; description?: string; deleted?: boolean;
  // Epoch millis, recomputed on every write to the version, so it is creation
  // (or last-modification) time — not necessarily publish time.
  fingerprint?: string;
  tag?: GtmTag[]; trigger?: GtmTrigger[]; variable?: GtmVariable[];
  builtInVariable?: GtmBuiltInVariable[]; folder?: GtmFolder[]; customTemplate?: GtmTemplate[];
}
