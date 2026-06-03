import {
  TOP_ANALYTICS_LIMIT,
  buildReportAnalyticsFromSqlRows,
  getAnalyticsEventWhere,
  normalizeAnalyticsOptions
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
  const { whereSql, args } = getAnalyticsEventWhere(query);
  const feedbackWhereSql = appendWhereCondition(whereSql, "event_kind = 'feedback'");
  const sampleWhereSql = appendWhereCondition(whereSql, "sample_id <> ''");
  const repeatedWhereSql = appendWhereCondition(sampleWhereSql, "event_kind = 'impression'");
  const dateSql = localDateSql(query.tzOffsetMinutes);
  const upKeySql = "coalesce(nullif(up_mid, ''), nullif(up_name, ''), 'unknown')";

  return {
    range: query,
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

async function executeAnalyticsQueries(specs, runner) {
  const [
    metricsRow,
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
    runner.first(specs.metrics),
    runner.first(specs.repeat),
    runner.all(specs.trends),
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
    repeatRow,
    trends,
    dimensions: { modes, sources, categories, positions, feedback },
    top: { ups, samples, repeatedSamples }
  });
}

export {
  buildAnalyticsQuerySpecs,
  executeAnalyticsQueries
};
