import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeConfig, mergeConfig } from '../src/config-merge.js';

test('newer scalar fields win and older values are ignored', () => {
  const current = {
    fields: {
      bili_mode: { value: 'pure', updatedAt: '2026-01-01T00:00:00.000Z', clientId: 'a' }
    },
    rules: { items: [] }
  };
  const incoming = {
    fields: {
      bili_mode: { value: 'origin', updatedAt: '2025-01-01T00:00:00.000Z', clientId: 'b' },
      bili_fusion_clean_ratio: { value: 70, updatedAt: '2026-01-02T00:00:00.000Z', clientId: 'b' }
    },
    rules: { items: [] }
  };

  const merged = materializeConfig(mergeConfig(current, incoming));
  assert.equal(merged.bili_mode, 'pure');
  assert.equal(merged.bili_fusion_clean_ratio, 70);
});

test('rules merge by id and tombstones prevent deleted rules from materializing', () => {
  const current = {
    fields: {},
    rules: {
      items: [
        { id: 'r1', type: 'up_name_exact', pattern: 'A', enabled: true, updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }
  };
  const incoming = {
    fields: {},
    rules: {
      items: [
        { id: 'r1', type: 'up_name_exact', pattern: 'A', enabled: true, updatedAt: '2026-01-02T00:00:00.000Z', deletedAt: '2026-01-02T00:00:00.000Z' },
        { id: 'r2', type: 'title_regex', pattern: '抽奖', enabled: true, updatedAt: '2026-01-02T00:00:00.000Z' }
      ]
    }
  };

  const merged = mergeConfig(current, incoming);
  assert.deepEqual(materializeConfig(merged).bili_block_rules.map((rule) => rule.id), ['r2']);
});

test('merge preserves top-level updatedAt when values are unchanged', () => {
  const current = {
    updatedAt: '2026-01-03T00:00:00.000Z',
    fields: {
      bili_mode: { value: 'pure', updatedAt: '2026-01-01T00:00:00.000Z', clientId: 'a' }
    },
    rules: {
      items: [
        { id: 'r1', type: 'up_name_exact', pattern: 'A', enabled: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }
  };
  const incoming = {
    fields: {
      bili_mode: { value: 'pure', updatedAt: '2026-01-04T00:00:00.000Z', clientId: 'b' }
    },
    rules: {
      items: [
        { id: 'r1', type: 'up_name_exact', pattern: 'A', enabled: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z', clientId: 'b' }
      ]
    }
  };

  const unchanged = mergeConfig(current, incoming, '2026-01-05T00:00:00.000Z');
  assert.equal(unchanged.updatedAt, current.updatedAt);
  assert.equal(unchanged.fields.bili_mode.updatedAt, current.fields.bili_mode.updatedAt);

  const changed = mergeConfig(current, {
    fields: {
      bili_mode: { value: 'origin', updatedAt: '2026-01-04T00:00:00.000Z', clientId: 'b' }
    },
    rules: incoming.rules
  }, '2026-01-05T00:00:00.000Z');
  assert.equal(changed.updatedAt, '2026-01-05T00:00:00.000Z');
  assert.equal(materializeConfig(changed).bili_mode, 'origin');
});
