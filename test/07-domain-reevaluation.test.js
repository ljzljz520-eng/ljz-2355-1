import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reevaluateWorkAfterRevision } from '../server/domain/reevaluation.js';
import { interpretFaultCode } from '../server/domain/faultSearch.js';

test('逐项继承判定：删除/未变/关键变更/非关键变更/新增 五类', () => {
  const items = [
    { id: 1, step_no: '01', title: 'A', state: 'done', completed_step_hash: 'hA', is_key_step: true },
    { id: 2, step_no: '02', title: 'B', state: 'done', completed_step_hash: 'hB', is_key_step: true },
    { id: 3, step_no: '03', title: 'C', state: 'done', completed_step_hash: 'hC', is_key_step: false },
    { id: 4, step_no: '04', title: 'D', state: 'pending', completed_step_hash: null, is_key_step: true },
  ];
  const newSteps = [
    { step_no: '01', title: 'A', step_hash: 'hA', is_key_step: true },
    { step_no: '02', title: 'B*', step_hash: 'hB2', is_key_step: true },
    { step_no: '03', title: 'C*', step_hash: 'hC2', is_key_step: false },
    { step_no: '04', title: 'D', step_hash: 'hD', is_key_step: true },
    { step_no: '05', title: 'E', step_hash: 'hE', is_key_step: false },
  ];
  const r = reevaluateWorkAfterRevision(items, newSteps);
  const by = Object.fromEntries(r.decisions.map((d) => [d.step_no, d]));
  assert.equal(by['01'].suggested, 'inheritable');
  assert.equal(by['02'].suggested, 'needs_redo');
  assert.equal(by['03'].suggested, 'review');
  assert.equal(by['04'].suggested, 'pending_new');
  assert.equal(by['05'].suggested, 'added');
  // 01/02/03 三项要求人工裁决；04 未做、05 新增不需要
  assert.equal(r.pendingDecisions, 3);
  assert.equal(r.canComplete, false);
  assert.match(r.warning, /不能完成/);
});

test('故障码纯函数：无任何匹配时不编造，跨机型不合并', () => {
  const rows = [
    { code: 'E1', model_code: 'X', meaning: 'mx', model_revision: null },
    { code: 'E1', model_code: 'Y', meaning: 'my', model_revision: null },
  ];
  assert.equal(interpretFaultCode(rows, 'E1', 'X').matches[0].meaning, 'mx');
  assert.equal(interpretFaultCode(rows, 'E1', 'Z').reason, 'WRONG_MODEL');
  assert.equal(interpretFaultCode(rows, 'E2', 'X').reason, 'NOT_FOUND');
  assert.equal(interpretFaultCode(rows, 'E1', null).reason, 'AMBIGUOUS_MODEL');
});
