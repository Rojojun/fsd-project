import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseRequirement } from '../src/catalog.ts';

const file = (front: string, body = '액션 아이템 목록을 생성일 기준으로 정렬한다.\n') => `---\n${front}\n---\n${body}`;
const valid = file('id: TASK-01\ntitle: 액션 아이템 정렬\npriority: P0\ndepends: [AUTH-01]\npolicies: [newest-first]');

test('머리말과 본문을 읽어 요구사항 문서를 만든다', () => {
  const r = parseRequirement('TASK-01.md', valid);
  assert.ok(r.ok);
  assert.equal(r.doc.id, 'TASK-01');
  assert.equal(r.doc.title, '액션 아이템 정렬');
  assert.equal(r.doc.priority, 'P0');
  assert.deepEqual(r.doc.depends, ['AUTH-01']);
  assert.deepEqual(r.doc.policies, ['newest-first']);
  assert.equal(r.doc.deprecated, false);
  assert.equal(r.doc.body, '액션 아이템 목록을 생성일 기준으로 정렬한다.');
});

test('선택 항목은 기본값을 쓴다', () => {
  const r = parseRequirement('A-1.md', file('id: A-1\ntitle: 제목\npriority: P2'));
  assert.ok(r.ok);
  assert.deepEqual([r.doc.depends, r.doc.policies, r.doc.deprecated], [[], [], false]);
});

test('지문은 파일 내용이 바뀌면 달라지고 같으면 같다', () => {
  const a = parseRequirement('TASK-01.md', valid);
  const b = parseRequirement('TASK-01.md', valid);
  const c = parseRequirement('TASK-01.md', valid.replace('정렬한다', '최신순으로 정렬한다'));
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(a.doc.hash, b.doc.hash);
  assert.notEqual(a.doc.hash, c.doc.hash);
});

test('줄바꿈 방식(CRLF)만 다르면 같은 지문이다', () => {
  const a = parseRequirement('TASK-01.md', valid);
  const b = parseRequirement('TASK-01.md', valid.replaceAll('\n', '\r\n'));
  assert.ok(a.ok && b.ok);
  assert.equal(a.doc.hash, b.doc.hash);
});

test('머리말이 없으면 오류', () => {
  const r = parseRequirement('X.md', '그냥 본문');
  assert.ok(!r.ok);
  assert.match(r.errors.join(), /머리말/);
});

test('필수 항목과 형식을 검사해 오류를 모두 모은다', () => {
  const r = parseRequirement('TASK-02.md', file('id: TASK-01\npriority: P9\ndepends: AUTH-01', ''));
  assert.ok(!r.ok);
  const all = r.errors.join('\n');
  assert.match(all, /파일 이름/);
  assert.match(all, /title/);
  assert.match(all, /priority/);
  assert.match(all, /depends/);
  assert.match(all, /본문/);
});

test('자기 자신을 선행 요구사항으로 둘 수 없다', () => {
  const r = parseRequirement('A-1.md', file('id: A-1\ntitle: t\npriority: P1\ndepends: [A-1]'));
  assert.ok(!r.ok);
  assert.match(r.errors.join(), /자기 자신/);
});

test('내용 지문은 선행 관계(depends)만 바뀌면 같고, 내용이 바뀌면 달라진다', () => {
  const base = file('id: A-1\ntitle: 제목\npriority: P1\ndepends: []');
  const relinked = file('id: A-1\ntitle: 제목\npriority: P1\ndepends:\n  - B-1');
  const retitled = file('id: A-1\ntitle: 바뀐 제목\npriority: P1\ndepends: []');
  const rewritten = file('id: A-1\ntitle: 제목\npriority: P1\ndepends: []', '다른 본문\n');
  const [a, b, c, d] = [base, relinked, retitled, rewritten].map(t => parseRequirement('A-1.md', t));
  assert.ok(a.ok && b.ok && c.ok && d.ok);
  assert.notEqual(a.doc.hash, b.doc.hash, '파일 지문은 다르다');
  assert.equal(a.doc.contentHash, b.doc.contentHash, '내용 지문은 같다');
  assert.notEqual(a.doc.contentHash, c.doc.contentHash);
  assert.notEqual(a.doc.contentHash, d.doc.contentHash);
});

test('내용 지문은 마크다운 이스케이프 표기만 다르면 같고, 글자가 바뀌면 달라진다', () => {
  const front = 'id: A-1\ntitle: 제목\npriority: P1';
  const single = file(front, '인용 번호(\\[1\\], \\[C1\\])를 지운다. 1\\. 첫째\n');
  const doubled = file(front, '인용 번호(\\\\[1\\\\], \\\\[C1\\\\])를 지운다. 1\\\\. 첫째\n');
  const plain = file(front, '인용 번호([1], [C1])를 지운다. 1. 첫째\n');
  const changed = file(front, '인용 번호(\\[2\\], \\[C1\\])를 지운다. 1\\. 첫째\n');
  const [s, d, p, c] = [single, doubled, plain, changed].map(t => parseRequirement('A-1.md', t));
  assert.ok(s.ok && d.ok && p.ok && c.ok);
  assert.notEqual(s.doc.hash, d.doc.hash, '파일 지문은 다르다');
  assert.equal(s.doc.contentHash, d.doc.contentHash, '\\[ 와 \\\\[ 는 같은 내용');
  assert.equal(s.doc.contentHash, p.doc.contentHash, '이스케이프 없는 표기와도 같은 내용');
  assert.notEqual(s.doc.contentHash, c.doc.contentHash, '글자가 바뀌면 다르다');
});

test('백슬래시가 없는 본문은 내용 지문 계산이 예전과 같다', () => {
  const r = parseRequirement('A-1.md', file('id: A-1\ntitle: 제목\npriority: P1'));
  assert.ok(r.ok);
  const expected = createHash('sha256')
    .update(JSON.stringify({ front: { id: 'A-1', title: '제목', priority: 'P1' }, body: r.doc.body }))
    .digest('hex');
  assert.equal(r.doc.contentHash, expected);
});
