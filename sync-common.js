globalThis.TabulaBiliSync = (() => {
  const ENDPOINT_KEY = 'tabulabili_sync_endpoint';
  const SECRET_KEY = 'tabulabili_sync_secret';
  const ENABLED_KEY = 'tabulabili_sync_enabled';
  const CLIENT_ID_KEY = 'tabulabili_sync_client_id';
  const CONFIG_ENVELOPE_KEY = 'tabulabili_sync_config_envelope_v1';
  const REPORT_QUEUE_KEY = 'tabulabili_report_queue_v1';
  const REPORT_FREQUENCY_KEY = 'tabulabili_report_frequency_minutes';
  const LAST_STATUS_KEY = 'tabulabili_sync_last_status_v1';
  const RETRY_STATE_KEY = 'tabulabili_sync_retry_state_v1';
  const MAX_REPORT_BATCHES = 200;

  const CONFIG_FIELD_KEYS = [
    'bili_mode',
    'bili_fusion_clean_ratio',
    'bili_blocker_enabled',
    'bili_analysis_enabled',
    'bili_analysis_settings_v1',
    REPORT_FREQUENCY_KEY
  ];

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeEndpoint(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.replace(/\/+$/, '');
  }

  function getStableClientId(value) {
    if (typeof value === 'string' && value) return value;
    const random = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `tabulabili-${random}`;
  }

  function normalizeFrequency(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 30;
    return Math.min(1440, Math.max(5, parsed));
  }

  function makeStatus(ok, message, extra = {}) {
    return {
      ok,
      message,
      at: nowIso(),
      ...extra
    };
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function sameValue(left, right) {
    return stableStringify(left) === stableStringify(right);
  }

  function normalizeRules(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((rule) => rule && (rule.type === 'up_name_exact' || rule.type === 'title_regex'))
      .map((rule) => ({
        id: typeof rule.id === 'string' && rule.id ? rule.id : hashString(`${rule.type}:${rule.pattern || ''}`),
        type: rule.type,
        pattern: typeof rule.pattern === 'string' ? rule.pattern.trim() : '',
        enabled: rule.enabled !== false,
        createdAt: typeof rule.createdAt === 'string' ? rule.createdAt : nowIso(),
        source: typeof rule.source === 'string' ? rule.source : ''
      }))
      .filter((rule) => rule.pattern);
  }

  function buildConfigEnvelope(values, previousEnvelope, clientId, changedKeys = CONFIG_FIELD_KEYS) {
    const previous = previousEnvelope && typeof previousEnvelope === 'object' ? previousEnvelope : {};
    const previousFields = previous.fields && typeof previous.fields === 'object' ? previous.fields : {};
    const changeSet = new Set(changedKeys || []);
    const timestamp = nowIso();
    const fields = {};

    for (const key of CONFIG_FIELD_KEYS) {
      const previousField = previousFields[key];
      const hasValue = Object.prototype.hasOwnProperty.call(values || {}, key);
      if (!hasValue && previousField) {
        fields[key] = previousField;
        continue;
      }
      if (!hasValue) continue;

      const value = key === REPORT_FREQUENCY_KEY ? normalizeFrequency(values[key]) : values[key];
      if (previousField && !changeSet.has(key) && sameValue(previousField.value, value)) {
        fields[key] = previousField;
      } else {
        fields[key] = { value, updatedAt: timestamp, clientId };
      }
    }

    const rulesChanged = changeSet.has('bili_block_rules') || !previous.rules;
    const previousItems = previous.rules && Array.isArray(previous.rules.items) ? previous.rules.items : [];
    const ruleItems = rulesChanged
      ? mergeRuleEnvelopeItems(previousItems, normalizeRules(values && values.bili_block_rules), clientId, timestamp)
      : previousItems;

    return {
      version: 1,
      clientId,
      updatedAt: timestamp,
      fields,
      rules: { items: ruleItems }
    };
  }

  function mergeRuleEnvelopeItems(previousItems, activeRules, clientId, timestamp) {
    const byId = new Map();
    for (const item of previousItems) {
      if (item && typeof item.id === 'string') byId.set(item.id, item);
    }

    const activeIds = new Set();
    for (const rule of activeRules) {
      activeIds.add(rule.id);
      const previous = byId.get(rule.id);
      if (previous && sameValue(stripRuleSyncFields(previous), rule) && !previous.deletedAt) {
        byId.set(rule.id, previous);
      } else {
        byId.set(rule.id, {
          ...rule,
          updatedAt: timestamp,
          clientId
        });
      }
    }

    for (const item of [...byId.values()]) {
      if (!item.deletedAt && !activeIds.has(item.id)) {
        byId.set(item.id, {
          ...item,
          deletedAt: timestamp,
          updatedAt: timestamp,
          clientId
        });
      }
    }

    return [...byId.values()];
  }

  function stripRuleSyncFields(rule) {
    return {
      id: rule.id,
      type: rule.type,
      pattern: rule.pattern,
      enabled: rule.enabled !== false,
      createdAt: rule.createdAt,
      source: rule.source || ''
    };
  }

  function materializeConfig(envelope) {
    const source = envelope && typeof envelope === 'object' ? envelope : {};
    const fields = source.fields && typeof source.fields === 'object' ? source.fields : {};
    const values = {};
    for (const key of CONFIG_FIELD_KEYS) {
      if (fields[key] && Object.prototype.hasOwnProperty.call(fields[key], 'value')) {
        values[key] = fields[key].value;
      }
    }
    values.bili_block_rules = source.rules && Array.isArray(source.rules.items)
      ? source.rules.items
        .filter((rule) => !rule.deletedAt)
        .map(stripRuleSyncFields)
      : [];
    return values;
  }

  function buildReportBatch(payload, clientId) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const samples = Array.isArray(source.samples) ? source.samples : [];
    const capturedAt = typeof source.capturedAt === 'string' ? source.capturedAt : nowIso();
    const url = typeof source.url === 'string' ? source.url : '';
    const seed = stableStringify({
      clientId,
      capturedAt,
      url,
      ids: samples.map((sample) => sample && sample.id)
    });
    const batchId = `${clientId}:${hashString(seed)}`;
    const events = samples
      .filter((sample) => sample && typeof sample === 'object' && sample.id)
      .map((sample) => {
        const eventSeed = stableStringify({
          clientId,
          capturedAt: sample.capturedAt || capturedAt,
          eventKind: sample.eventKind || 'impression',
          id: sample.id,
          mode: sample.mode,
          source: sample.source,
          position: sample.position,
          feedback: sample.feedback
        });
        return {
          ...sample,
          eventId: `${clientId}:${hashString(eventSeed)}`,
          batchId,
          clientId,
          capturedAt: sample.capturedAt || capturedAt
        };
      });

    return {
      batchId,
      clientId,
      capturedAt,
      url,
      queuedAt: nowIso(),
      events
    };
  }

  return {
    ENDPOINT_KEY,
    SECRET_KEY,
    ENABLED_KEY,
    CLIENT_ID_KEY,
    CONFIG_ENVELOPE_KEY,
    REPORT_QUEUE_KEY,
    REPORT_FREQUENCY_KEY,
    LAST_STATUS_KEY,
    RETRY_STATE_KEY,
    MAX_REPORT_BATCHES,
    CONFIG_FIELD_KEYS,
    buildConfigEnvelope,
    buildReportBatch,
    getStableClientId,
    makeStatus,
    materializeConfig,
    normalizeEndpoint,
    normalizeFrequency
  };
})();
