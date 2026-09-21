export interface DocumentationHeading {
  id: string;
  text: string;
  level: number;
}

export interface DocumentationMetadata {
  slug: string;
  title: string;
  description: string;
  group: string;
  source: string;
  updatedAt: string;
  status: 'current' | 'historical';
  headings: readonly DocumentationHeading[];
}

export interface DocumentationGroup {
  id: string;
  title: string;
  description: string;
}
