/**
 * Where the router's metrics are copied to, in the POD's region (alarms.ts says why).
 */
export const BRIDGE_NAMESPACE = "Dilaya/RegionRouter";

/** One CloudFront metric the bridge copies: its us-east-1 name and dimensions, and the statistic. */
export interface BridgedMetric {
  /** The name it is published under in BRIDGE_NAMESPACE (no dimensions there: one router per account). */
  name: string;
  metricName: string;
  /** A value written `env:NAME` is read from the bridge's environment (the ids are deploy-time tokens). */
  dimensions: Record<string, string>;
  stat: "Sum" | "Average" | "Maximum";
  unit: "Count" | "Percent" | "None";
}

/** The bridge runs every STEP and reads the 5-minute bucket that closed between 5 and 10 minutes ago. */
export const BRIDGE_STEP_MS = 5 * 60 * 1000;

/**
 * The metrics bridge's SOURCE — what `Code.fromInline` ships (nodejs24.x carries the v3 SDK).
 *
 * Each run reads ONE closed 5-minute bucket of every metric from us-east-1 (Period 300, so each
 * comes back as at most one value, already aggregated by CloudWatch) and publishes it in the pod's
 * region, stamped NOW: a datapoint stamped with its own (old) bucket time could fall outside the
 * alarm's evaluation window, and a late breach would never be seen. The bucket is aligned on the
 * clock, so consecutive runs never read the same one twice (an EventBridge retry could: the rule
 * sends none). A metric with no datapoint in the bucket is NOT published — CloudFront emits no
 * FunctionExecutionErrors when there are none, and the alarms treat missing as not breaching.
 * Any failure throws: the bridge's own Errors alarm is what says the watch went blind.
 */
export function metricsBridgeSource(metrics: BridgedMetric[]): string {
  return `'use strict';
const { CloudWatchClient, GetMetricDataCommand, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const METRICS = ${JSON.stringify(metrics)};
const NS = ${JSON.stringify(BRIDGE_NAMESPACE)};
const STEP = ${BRIDGE_STEP_MS};
const src = new CloudWatchClient({ region: 'us-east-1' });
const dst = new CloudWatchClient({});
const val = (v) => (v.indexOf('env:') === 0 ? process.env[v.slice(4)] : v);
exports.bucketOf = (now) => {
  const end = Math.floor(now / STEP) * STEP - STEP;
  return { start: new Date(end - STEP), end: new Date(end) };
};
exports.handler = async () => {
  const now = Date.now();
  const b = exports.bucketOf(now);
  const r = await src.send(new GetMetricDataCommand({
    StartTime: b.start,
    EndTime: b.end,
    MetricDataQueries: METRICS.map((m, i) => ({
      Id: 'm' + i,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/CloudFront',
          MetricName: m.metricName,
          Dimensions: Object.keys(m.dimensions).map((k) => ({ Name: k, Value: val(m.dimensions[k]) })),
        },
        Period: STEP / 1000,
        Stat: m.stat,
      },
    })),
  }));
  const data = [];
  for (const res of r.MetricDataResults || []) {
    const m = METRICS[Number(String(res.Id).slice(1))];
    if (!m || !res.Values || res.Values.length === 0) continue;
    data.push({ MetricName: m.name, Value: res.Values[0], Unit: m.unit, Timestamp: new Date(now) });
  }
  if (data.length > 0) await dst.send(new PutMetricDataCommand({ Namespace: NS, MetricData: data }));
  return { bucket: b.start.toISOString(), published: data.map((d) => d.MetricName + '=' + d.Value) };
};
`;
}
