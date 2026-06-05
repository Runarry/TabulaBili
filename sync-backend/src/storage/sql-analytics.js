import {
  TOP_ANALYTICS_LIMIT,
  buildReportAnalyticsFromSqlRows,
  filterReportAnalyticsSection,
  getAnalyticsEventWhere,
  normalizeAnalyticsOptions,
  normalizeAnalyticsSection
} from './helpers.js';

function metricColumns() {
  return `
    sum(case when event_kind = 'impression' then 1 else 0 end) as impressions,
    sum(case when event_kind = 'click' then 1 else 0 end) as clicks,
    sum(case when event_kind = 'feedback' then 1 else 0 end) as feedbacks,
    sum(case when event_kind = 'feedback' and feedback in ('dislike', 'blocked') then 1 else 0 end) as negativeFeedbacks,
    count(distinct nullif(sample_id, '')) as sampleCount,
    sum(case when event_kind = 'impression' and position > 0 then position else 0 end) as positionSum,
    sum(case when event_kind = 'impression' and position > 0 then 1 else 0 end) as positionCount
  `;
}

function appendWhereCondition(whereSql, condition) {
  return whereSql
    ? `${whereSql} and ${condition}`
    : `where ${condition}`;
}

function positionBucketSql() {
  return `case
    when position <= 0 then 'unknown'
    when position = 1 then '1'
    when position <= 3 then '2-3'
    when position <= 6 then '4-6'
    when position <= 10 then '7-10'
    else '11+'
  end`;
}

function localDateSql(tzOffsetMinutes) {
  const offset = Math.trunc(Number(tzOffsetMinutes || 0));
  if (!offset) return 'date(captured_at)';
  const sign = offset > 0 ? '+' : '';
  return `date(datetime(captured_at, '${sign}${offset} minutes'))`;
}

function canUseDailyMetrics(query) {
  return !query.feedback;
}

function dailyMetricWhere(query) {
  const where = ['date >= ?'];
  const args = [query.sinceIso.slice(0, 10)];
  const filters = [
    ['clientId', 'client_id'],
    ['mode', 'mode'],
    ['source', 'source'],
    ['category', 'category']
  ];

  for (const [key, column] of filters) {
    if (!query[key]) continue;
    where.push(`${column} = ?`);
    args.push(query[key]);
  }

  return {
    whereSql: `where ${where.join(' and ')}`,
    args
  };
}

function dailyMetricsQuery(whereSql, args) {
  return {
    sql: `
      select
        coalesce(sum(impressions), 0) as impressionCount,
        coalesce(sum(clicks), 0) as clickCount,
        coalesce(sum(feedbacks), 0) as feedbackCount,
        coalesce(sum(negative_feedbacks), 0) as negativeFeedbackCount,
        coalesce(sum(impressions + clicks + feedbacks), 0) as eventCount
      from daily_metrics ${whereSql}
    `,
    args
  };
}

function dailyTrendsQuery(whereSql, args) {
  return {
    sql: `
      select date,
        coalesce(sum(impressions), 0) as impressions,
        coalesce(sum(clicks), 0) as clicks,
        coalesce(sum(feedbacks), 0) as feedbacks,
        coalesce(sum(negative_feedbacks), 0) as negativeFeedbacks
      from daily_metrics ${whereSql}
      group by date
      order by date asc
    `,
    args
  };
}

function dimensionQuery(keySql, whereSql, args) {
  return {
    sql: `
      select ${keySql} as key, ${metricColumns()}
      from events ${whereSql}
      group by ${keySql}
      order by impressions desc, clicks desc, key asc
      limit ?
    `,
    args: [...args, TOP_ANALYTICS_LIMIT]
  };
}

function sampleTopQuery(whereSql, args, options = {}) {
  const havingSql = options.repeatedOnly ? 'having impressions > 1' : '';
  const orderSql = options.repeatedOnly
    ? 'impressions - 1 desc, impressions desc, key asc'
    : 'impressions desc, clicks desc, key asc';
  return {
    sql: `
      select sample_id as key, sample_id as sampleId,
        coalesce(max(nullif(bvid, '')), '') as bvid,
        coalesce(max(json_extract(raw_json, '$.title')), '') as title,
        coalesce(max(nullif(up_name, '')), '') as upName,
        coalesce(max(nullif(up_mid, '')), '') as upMid,
        coalesce(max(nullif(category, '')), '') as category,
        ${metricColumns()}
      from events ${whereSql}
      group by sample_id
      ${havingSql}
      order by ${orderSql}
      limit ?
    `,
    args: [...args, TOP_ANALYTICS_LIMIT]
  };
}

function buildAnalyticsQuerySpecs(options = {}) {
  const query = normalizeAnalyticsOptions(options);
  const section = normalizeAnalyticsSection(options.section);
  const { whereSql, args } = getAnalyticsEventWhere(query);
  const dailyWhere = canUseDailyMetrics(query) ? dailyMetricWhere(query) : null;
  const feedbackWhereSql = appendWhereCondition(whereSql, "event_kind = 'feedback'");
  const sampleWhereSql = appendWhereCondition(whereSql, "sample_id <> ''");
  const repeatedWhereSql = appendWhereCondition(sampleWhereSql, "event_kind = 'impression'");
  const dateSql = localDateSql(query.tzOffsetMinutes);
  const upKeySql = "coalesce(nullif(up_mid, ''), nullif(up_name, ''), 'unknown')";

  return {
    section,
    range: query,
    dailyMetrics: dailyWhere ? dailyMetricsQuery(dailyWhere.whereSql, dailyWhere.args) : null,
    metrics: {
      sql: `
        select
          count(distinct batch_id) as batchCount,
          count(*) as eventCount,
          count(distinct nullif(sample_id, '')) as sampleCount,
          count(distinct coalesce(nullif(up_mid, ''), nullif(up_name, ''))) as distinctUpCount,
          sum(case when event_kind = 'impression' then 1 else 0 end) as impressionCount,
          sum(case when event_kind = 'click' then 1 else 0 end) as clickCount,
          sum(case when event_kind = 'feedback' then 1 else 0 end) as feedbackCount,
          sum(case when event_kind = 'feedback' and feedback in ('dislike', 'blocked') then 1 else 0 end) as negativeFeedbackCount
        from events ${whereSql}
      `,
      args
    },
    repeat: {
      sql: `
        select count(*) as repeatSampleCount, coalesce(sum(impressions - 1), 0) as repeatImpressionCount
        from (
          select sample_id, count(*) as impressions
          from events ${repeatedWhereSql}
          group by sample_id
          having count(*) > 1
        )
      `,
      args
    },
    trends: {
      sql: `
        select ${dateSql} as date,
          sum(case when event_kind = 'impression' then 1 else 0 end) as impressions,
          sum(case when event_kind = 'click' then 1 else 0 end) as clicks,
          sum(case when event_kind = 'feedback' then 1 else 0 end) as feedbacks,
          sum(case when event_kind = 'feedback' and feedback in ('dislike', 'blocked') then 1 else 0 end) as negativeFeedbacks
        from events ${whereSql}
        group by ${dateSql}
        order by date asc
      `,
      args
    },
    dailyTrends: dailyWhere && !query.tzOffsetMinutes
      ? dailyTrendsQuery(dailyWhere.whereSql, dailyWhere.args)
      : null,
    dimensions: {
      modes: dimensionQuery("coalesce(nullif(mode, ''), 'unknown')", whereSql, args),
      sources: dimensionQuery("coalesce(nullif(source, ''), 'unknown')", whereSql, args),
      categories: dimensionQuery("coalesce(nullif(category, ''), 'unknown')", whereSql, args),
      positions: dimensionQuery(positionBucketSql(), whereSql, args),
      feedback: {
        sql: `
          select coalesce(nullif(feedback, ''), 'unset') as key, count(*) as count
          from events ${feedbackWhereSql}
          group by coalesce(nullif(feedback, ''), 'unset')
          order by count desc, key asc
        `,
        args
      }
    },
    top: {
      ups: {
        sql: `
          select ${upKeySql} as key,
            coalesce(max(nullif(up_name, '')), ${upKeySql}) as upName,
            ${metricColumns()}
          from events ${whereSql}
          group by ${upKeySql}
          order by impressions desc, clicks desc, key asc
          limit ?
        `,
        args: [...args, TOP_ANALYTICS_LIMIT]
      },
      samples: sampleTopQuery(sampleWhereSql, args),
      repeatedSamples: sampleTopQuery(sampleWhereSql, args, { repeatedOnly: true })
    }
  };
}

function canIgnoreOptionalError(runner, error) {
  return typeof runner.canIgnoreOptionalError === 'function'
    && runner.canIgnoreOptionalError(error);
}

async function optionalFirst(spec, runner) {
  if (!spec) return null;
  try {
    return await runner.first(spec);
  } catch (error) {
    if (canIgnoreOptionalError(runner, error)) return null;
    throw error;
  }
}

async function optionalAll(spec, runner) {
  if (!spec) return null;
  try {
    return await runner.all(spec);
  } catch (error) {
    if (canIgnoreOptionalError(runner, error)) return null;
    throw error;
  }
}

function hasCompleteDailyMetrics(metricsRow, dailyMetricsRow) {
  if (!dailyMetricsRow) return false;
  return Number(dailyMetricsRow.eventCount || 0) === Number(metricsRow && metricsRow.eventCount || 0);
}

async function executeAnalyticsQueries(specs, runner) {
  const section = normalizeAnalyticsSection(specs.section);
  if (section === 'overview') return executeOverviewAnalyticsQueries(specs, runner);
  if (section === 'dimensions') return executeDimensionAnalyticsQueries(specs, runner);
  if (section === 'top') return executeTopAnalyticsQueries(specs, runner);

  const [metricsRow, dailyMetricsRow] = await Promise.all([
    runner.first(specs.metrics),
    optionalFirst(specs.dailyMetrics, runner)
  ]);
  const useDailyTrends = specs.dailyTrends && hasCompleteDailyMetrics(metricsRow, dailyMetricsRow);
  const trendsPromise = useDailyTrends
    ? optionalAll(specs.dailyTrends, runner).then((rows) => rows || runner.all(specs.trends))
    : runner.all(specs.trends);

  const [
    repeatRow,
    trends,
    modes,
    sources,
    categories,
    positions,
    feedback,
    ups,
    samples,
    repeatedSamples
  ] = await Promise.all([
    runner.first(specs.repeat),
    trendsPromise,
    runner.all(specs.dimensions.modes),
    runner.all(specs.dimensions.sources),
    runner.all(specs.dimensions.categories),
    runner.all(specs.dimensions.positions),
    runner.all(specs.dimensions.feedback),
    runner.all(specs.top.ups),
    runner.all(specs.top.samples),
    runner.all(specs.top.repeatedSamples)
  ]);

  return buildReportAnalyticsFromSqlRows({
    range: specs.range,
    metricsRow,
    dailyMetricsRow,
    repeatRow,
    trends,
    dimensions: { modes, sources, categories, positions, feedback },
    top: { ups, samples, repeatedSamples }
  });
}

async function executeOverviewAnalyticsQueries(specs, runner) {
  const [metricsRow, dailyMetricsRow] = await Promise.all([
    runner.first(specs.metrics),
    optionalFirst(specs.dailyMetrics, runner)
  ]);
  const useDailyTrends = specs.dailyTrends && hasCompleteDailyMetrics(metricsRow, dailyMetricsRow);
  const trends = useDailyTrends
    ? await optionalAll(specs.dailyTrends, runner).then((rows) => rows || runner.all(specs.trends))
    : await runner.all(specs.trends);
  const analytics = buildReportAnalyticsFromSqlRows({
    range: specs.range,
    metricsRow,
    dailyMetricsRow,
    repeatRow: null,
    trends,
    dimensions: {},
    top: {}
  });
  return filterReportAnalyticsSection(analytics, 'overview');
}

async function executeDimensionAnalyticsQueries(specs, runner) {
  const [modes, sources, categories, positions, feedback] = await Promise.all([
    runner.all(specs.dimensions.modes),
    runner.all(specs.dimensions.sources),
    runner.all(specs.dimensions.categories),
    runner.all(specs.dimensions.positions),
    runner.all(specs.dimensions.feedback)
  ]);
  const analytics = buildReportAnalyticsFromSqlRows({
    range: specs.range,
    metricsRow: null,
    dailyMetricsRow: null,
    repeatRow: null,
    trends: [],
    dimensions: { modes, sources, categories, positions, feedback },
    top: {}
  });
  return filterReportAnalyticsSection(analytics, 'dimensions');
}

async function executeTopAnalyticsQueries(specs, runner) {
  const [ups, samples, repeatedSamples] = await Promise.all([
    runner.all(specs.top.ups),
    runner.all(specs.top.samples),
    runner.all(specs.top.repeatedSamples)
  ]);
  const analytics = buildReportAnalyticsFromSqlRows({
    range: specs.range,
    metricsRow: null,
    dailyMetricsRow: null,
    repeatRow: null,
    trends: [],
    dimensions: {},
    top: { ups, samples, repeatedSamples }
  });
  return filterReportAnalyticsSection(analytics, 'top');
}

export {
  buildAnalyticsQuerySpecs,
  executeAnalyticsQueries
};
