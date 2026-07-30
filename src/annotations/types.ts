export type ReviewAnnotationStatus = "pending" | "resolved" | "wont-fix";
export type ReviewAnnotationTarget = "version" | "block";
export type ReviewAnnotationSource = "local" | "git-notes";

export interface ReviewAnnotationBlockAnchor {
  fingerprint: string;
  kind: "heading" | "paragraph" | "list" | "code" | "frontmatter";
  headingPath: string[];
  startLine: number;
  endLine: number;
  originalContent: string;
}

export interface ReviewAnnotation {
  id: string;
  repositoryRoot: string;
  filePath: string;
  historicalPath: string;
  commitHash: string;
  versionLabel: string;
  target: ReviewAnnotationTarget;
  block?: ReviewAnnotationBlockAnchor;
  comment: string;
  status: ReviewAnnotationStatus;
  source: ReviewAnnotationSource;
  createdAt: string;
  updatedAt: string;
}

export interface LocatedReviewAnnotation {
  annotation: ReviewAnnotation;
  relocated: boolean;
  unresolved: boolean;
  currentBlock?: ReviewAnnotationBlockAnchor;
}
