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
// NOTE: ContainerVersionHeader carries no timestamp and no notes — both are
// deliberately absent from `gallium versions` output for that reason.
export interface GtmVersionHeader {
  containerVersionId: string; name?: string; deleted?: boolean;
  numMacros?: string; numRules?: string; numTags?: string;
  numTriggers?: string; numVariables?: string;
}
export interface GtmContainerVersion {
  containerVersionId: string; name?: string; notes?: string; deleted?: boolean;
  tag?: GtmTag[]; trigger?: GtmTrigger[]; variable?: GtmVariable[];
  builtInVariable?: GtmBuiltInVariable[]; folder?: GtmFolder[]; customTemplate?: GtmTemplate[];
}
