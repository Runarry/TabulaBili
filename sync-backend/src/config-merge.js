const CONFIG_FIELD_KEYS = [
  'bili_mode',
  'bili_fusion_clean_ratio',
  'bili_blocker_enabled',
  'bili_analysis_enabled',
  'bili_analysis_settings_v1',
  'tabulabili_report_frequency_minutes'
];

function toTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isNewer(left, right) {
  return toTime(left && left.updatedAt) >= toTime(right && right.updatedAt);
}

function normalizeField(entry, fallbackClientId = '') {
  if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'value')) return null;
  return {
    value: entry.value,
    updatedAt: cleanString(entry.updatedAt) || new Date(0).toISOString(),
    clientId: cleanString(entry.clientId) || fallbackClientId
  };
}

function normalizeRule(rule, fallbackClientId = '') {
  if (!rule || typeof rule !== 'object') return null;

  const type = cleanString(rule.type);
  const pattern = cleanString(rule.pattern);
  const deletedAt = cleanString(rule.deletedAt);
  if (!deletedAt && !['up_name_exact', 'title_regex'].includes(type)) return null;
  if (!deletedAt && !pattern) return null;

  const id = cleanString(rule.id) || makeRuleNaturalKey(type, pattern);
  if (!id) return null;

  return {
    id,
    type,
    pattern,
    enabled: rule.enabled !== false,
    createdAt: cleanString(rule.createdAt) || cleanString(rule.updatedAt) || new Date(0).toISOString(),
    updatedAt: cleanString(rule.updatedAt) || cleanString(rule.createdAt) || new Date(0).toISOString(),
    deletedAt,
    clientId: cleanString(rule.clientId) || fallbackClientId,
    source: cleanString(rule.source)
  };
}

function makeRuleNaturalKey(type, pattern) {
  return type && pattern ? `${type}:${pattern.toLowerCase()}` : '';
}

function normalizeEnvelope(value) {
  const source = value && typeof value === 'object' ? value : {};
  const clientId = cleanString(source.clientId);
  const fields = {};

  for (const key of CONFIG_FIELD_KEYS) {
    const field = normalizeField(source.fields && source.fields[key], clientId);
    if (field) fields[key] = field;
  }

  const rules = [];
  const rawRules = source.rules && Array.isArray(source.rules.items)
    ? source.rules.items
    : [];
  for (const rawRule of rawRules) {
    const rule = normalizeRule(rawRule, clientId);
    if (rule) rules.push(rule);
  }

  return {
    version: 1,
    clientId,
    updatedAt: cleanString(source.updatedAt) || new Date().toISOString(),
    fields,
    rules: { items: rules }
  };
}

function mergeConfig(currentValue, incomingValue, now = new Date().toISOString()) {
  const current = normalizeEnvelope(currentValue);
  const incoming = normalizeEnvelope(incomingValue);
  const fields = { ...current.fields };

  for (const key of CONFIG_FIELD_KEYS) {
    const next = incoming.fields[key];
    if (!next) continue;
    const existing = fields[key];
    if (!existing || isNewer(next, existing)) fields[key] = next;
  }

  const rulesById = new Map();
  for (const rule of current.rules.items) rulesById.set(rule.id, rule);
  for (const rule of incoming.rules.items) {
    const existing = rulesById.get(rule.id);
    if (!existing || isNewer(rule, existing)) rulesById.set(rule.id, rule);
  }

  const naturalKeyToId = new Map();
  const mergedRules = [];
  for (const rule of [...rulesById.values()].sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt))) {
    if (rule.deletedAt) {
      mergedRules.push(rule);
      continue;
    }

    const naturalKey = makeRuleNaturalKey(rule.type, rule.pattern);
    const existingId = naturalKeyToId.get(naturalKey);
    if (!existingId) {
      naturalKeyToId.set(naturalKey, rule.id);
      mergedRules.push(rule);
      continue;
    }

    const existingIndex = mergedRules.findIndex((item) => item.id === existingId);
    if (existingIndex >= 0 && isNewer(rule, mergedRules[existingIndex])) {
      mergedRules[existingIndex] = { ...rule, id: existingId };
    }
  }

  return {
    version: 1,
    updatedAt: now,
    fields,
    rules: { items: mergedRules }
  };
}

function materializeConfig(envelopeValue) {
  const envelope = normalizeEnvelope(envelopeValue);
  const values = {};
  for (const [key, field] of Object.entries(envelope.fields)) values[key] = field.value;
  values.bili_block_rules = envelope.rules.items
    .filter((rule) => !rule.deletedAt)
    .map(({ deletedAt, clientId, updatedAt, ...rule }) => rule);
  return values;
}

export {
  CONFIG_FIELD_KEYS,
  makeRuleNaturalKey,
  materializeConfig,
  mergeConfig,
  normalizeEnvelope
};
