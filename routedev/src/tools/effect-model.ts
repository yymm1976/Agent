/** A small, tool-agnostic description of observable side effects. */
export type EffectKind =
  | 'fs.read'
  | 'fs.write'
  | 'fs.create'
  | 'fs.delete'
  | 'fs.move'
  | 'git.read'
  | 'git.mutate'
  | 'process.exec'
  | 'network'
  | 'opaque_may_write';

export type EffectClassification = 'PROVEN_READ_ONLY' | 'KNOWN_EFFECTS' | 'OPAQUE_MAY_WRITE';

export interface ResourceEffect {
  kind: EffectKind;
  /** Resource as supplied by the tool/command, when one can be recovered. */
  resource?: string;
  /** Stable identity after resolving aliases and existing filesystem links. */
  canonicalResource?: string;
  /** Canonical workspace-relative form, always using forward slashes. */
  relativeResource?: string;
}

export interface EffectResolution {
  classification: EffectClassification;
  effects: ResourceEffect[];
}

export interface EffectResolveContext {
  workingDirectory: string;
  /** Stable workspace identity when a tool executes from a nested working directory. */
  workspaceRoot?: string;
}
