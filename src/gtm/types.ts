export interface GtmParameter {
  type: string; key?: string; value?: string;
  list?: GtmParameter[]; map?: GtmParameter[];
}
export interface GtmTag {
  tagId: string; name: string; type: string; parameter?: GtmParameter[];
  firingTriggerId?: string[]; blockingTriggerId?: string[];
  parentFolderId?: string; paused?: boolean; notes?: string;
}
export interface GtmTrigger {
  triggerId: string; name: string; type: string;
  parameter?: GtmParameter[]; filter?: GtmParameter[]; customEventFilter?: GtmParameter[];
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
