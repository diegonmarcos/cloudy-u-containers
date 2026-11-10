import { describe, it, expect } from 'vitest';
import {
  classifyTagName,
  isMetaTagName,
  isProjectTagName,
  classifyTags,
  classifyTagIds,
} from '../keyword-classification';

describe('classifyTagName', () => {
  it('treats A*-Z* names as meta tags', () => {
    expect(classifyTagName('A*Important')).toBe('meta');
    expect(classifyTagName('Z*Archive')).toBe('meta');
    expect(classifyTagName('M*')).toBe('meta');
  });

  it('treats 1*-9* names as project tags', () => {
    expect(classifyTagName('1*Website')).toBe('project');
    expect(classifyTagName('9*Ops')).toBe('project');
    expect(classifyTagName('5*')).toBe('project');
  });

  it('excludes 0* from project tags (1-9 only)', () => {
    expect(classifyTagName('0*Zero')).toBe('other');
  });

  it('requires the * to follow immediately', () => {
    expect(classifyTagName('A Important')).toBe('other');
    expect(classifyTagName('AB*Important')).toBe('other');
    expect(classifyTagName('1 Website')).toBe('other');
    expect(classifyTagName('12*Website')).toBe('other');
  });

  it('is case sensitive: lowercase leading letters are not meta', () => {
    expect(classifyTagName('a*lower')).toBe('other');
  });

  it('classifies ordinary names as other', () => {
    expect(classifyTagName('Receipts')).toBe('other');
    expect(classifyTagName('')).toBe('other');
    expect(classifyTagName('Work/Clients/Acme')).toBe('other');
  });
});

describe('isMetaTagName / isProjectTagName', () => {
  it('agree with classifyTagName', () => {
    expect(isMetaTagName('A*x')).toBe(true);
    expect(isMetaTagName('1*x')).toBe(false);
    expect(isProjectTagName('1*x')).toBe(true);
    expect(isProjectTagName('A*x')).toBe(false);
    expect(isMetaTagName('plain')).toBe(false);
    expect(isProjectTagName('plain')).toBe(false);
  });
});

describe('classifyTags', () => {
  it('splits into meta/project/other preserving order within each group', () => {
    const items = [
      { id: 'b', name: 'B*Flagged' },
      { id: '2', name: '2*Backend' },
      { id: 'r', name: 'Receipts' },
      { id: 'a', name: 'A*Important' },
      { id: '1', name: '1*Frontend' },
      { id: 'w', name: 'Work' },
    ];
    const { meta, project, other } = classifyTags(items, (i) => i.name);
    expect(meta.map((i) => i.id)).toEqual(['b', 'a']);
    expect(project.map((i) => i.id)).toEqual(['2', '1']);
    expect(other.map((i) => i.id)).toEqual(['r', 'w']);
  });

  it('returns empty groups for empty input', () => {
    expect(classifyTags([], (x: string) => x)).toEqual({ meta: [], project: [], other: [] });
  });
});

describe('classifyTagIds', () => {
  it('classifies ids via a name resolver', () => {
    const names: Record<string, string> = {
      meta1: 'C*Context',
      proj1: '3*Infra',
      plain1: 'Newsletter',
    };
    const result = classifyTagIds(['meta1', 'proj1', 'plain1'], (id) => names[id] ?? id);
    expect(result.meta).toEqual(['meta1']);
    expect(result.project).toEqual(['proj1']);
    expect(result.other).toEqual(['plain1']);
  });
});
