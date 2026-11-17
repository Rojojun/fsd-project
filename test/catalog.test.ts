import { test } from 'node:test';
import assert from 'node:assert/strict';
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
