// @vitest-environment node
// #1590 field-parity guard: the reading-panel redesign (Project/Meta tag
// sections, subject-tap metadata, Copy all) only REARRANGES data. Every field
// the panel showed before must still be present, and the Copy-all dump must
// carry every metadata field. Source-level, so it needs no JMAP fixtures.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { classifyTagIds } from '@/lib/keyword-classification';

const dir = path.resolve(__dirname, '..');
const viewer = fs.readFileSync(path.join(dir, 'email-viewer.tsx'), 'utf-8');
const sections = fs.readFileSync(path.join(dir, 'mail-tag-sections.tsx'), 'utf-8');

describe('tag partition is lossless', () => {
  it('project + other + meta always equals the input ids', () => {
    const names: Record<string, string> = { a: 'A*x', b: '1*y', c: 'plain', d: '0*z', e: 'a*low' };
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const { meta, project, other } = classifyTagIds(ids, (i) => names[i]);
    expect([...project, ...other, ...meta].sort()).toEqual([...ids].sort());
  });
});

describe('MailTagSections keeps the old flat-row behaviour', () => {
  it('still renders a TagBadge per tag with remove support and the variant', () => {
    expect(sections).toContain('<TagBadge');
    expect(sections).toContain('onRemove');
    expect(sections).toContain('variant={variant}');
    // unclassified tags ride with Project so none disappear
    expect(sections).toMatch(/\[\.\.\.project, \.\.\.other\]/);
  });
});

describe('email-viewer keeps every pre-redesign field', () => {
  const copyAll = viewer.slice(viewer.indexOf('const buildMetadataText'), viewer.indexOf('const handleCopyAllMetadata'));
  it('subject, no_subject fallback and star remain in the header', () => {
    expect(viewer).toContain("t('no_subject')");
    expect(viewer).toContain('headerTagsRef');
  });
  it.each([
    "t('subject')", "t('from')", "t('to')", "t('cc')", "t('bcc')",
    "t('details.sent')", "t('details.received')", "t('details.size')", "t('details.mime_type')",
    "t('project_tags')", "t('meta_tags')", "'SPF'", "'DKIM'", "'DMARC'", "t('details.iprev')",
    "t('authentication.spam_score')", "t('headers.message_id')", "t('details.thread_id')",
    "t('details.references')", "t('details.list_id')", "t('details.list_unsubscribe')", "t('details.account')",
  ])('Copy all dump includes %s', (needle) => {
    expect(copyAll).toContain(needle);
  });
  it('detail panel still shows the recipients/routing section', () => {
    expect(viewer).toContain("t('details.recipients_routing')");
  });
});
