import groups from './generated/groups.json';
import metadata from './generated/metadata.json';
import content from './generated/content.json';

export interface DocumentationGroup {
  id: string;
  title: string;
  description: string;
}

export interface DocumentationHeading {
  id: string;
  text: string;
  level: number;
}

export interface DocumentationDocumentMetadata {
  slug: string;
  title: string;
  description: string;
  group: string;
  source: string;
  updatedAt: string;
  status: 'current' | 'historical';
  headings: DocumentationHeading[];
}

export type DocumentationBlock =
  | { type: 'html'; html: string }
  | { type: 'mermaid'; code: string; id: string };

export interface DocumentationDocument extends DocumentationDocumentMetadata {
  blocks: DocumentationBlock[];
}

export const documentationGroups: DocumentationGroup[] = groups;
export const documentationDocuments = metadata as DocumentationDocumentMetadata[];

const documentationContent = content as Record<string, DocumentationBlock[]>;

/** Only generated, allowlisted documents can be served; no runtime file reads. */
export function getDocumentation(slug: string): DocumentationDocument | undefined {
  const document = documentationDocuments.find((entry) => entry.slug === slug);
  if (!document) return undefined;
  return { ...document, blocks: documentationContent[document.slug] };
}
