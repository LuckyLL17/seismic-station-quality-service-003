import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  QualityRuleError,
  createReport,
  disableRuleVersion,
  evaluateQuality,
  getRuleVersion,
  listRuleVersions,
  publishRuleVersion,
  resolveRuleVersionForIngest,
  resolveRuleVersionForReport
} from './quality.js';
import { observations, reports, stations } from './store.js';

const ingestSchema = z.object({
  stationId: z.string(),
  observedAt: z.string().datetime().optional(),
  samples: z.number().int().nonnegative(),
  sampleRateHz: z.number().positive(),
  peakAmplitude: z.number().nonnegative(),
  timingOffsetMs: z.number(),
  /** 显式指定评分规则版本；缺省时使用当前 active 版本 */
  ruleVersion: z.string().min(1).optional(),
  project: z.string().min(1).optional()
});

const reportSchema = z.object({
  stationId: z.string(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  /** 报告依据的规则版本；缺省使用 active 版本，可指定已停用版本做历史追溯 */
  ruleVersion: z.string().min(1).optional()
});

const rulePublishSchema = z.object({
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  project: z.string().optional(),
  thresholds: z
    .object({
      minSamples: z.number().int().nonnegative(),
      minWindowSeconds: z.number().positive(),
      maxPeakAmplitude: z.number().nonnegative(),
      maxAbsTimingOffsetMs: z.number().nonnegative(),
      scorePenaltyPerIssue: z.number().nonnegative(),
      maxTimingPenalty: z.number().nonnegative()
    })
    .partial(),
  issueLabels: z
    .object({
      SAMPLE_COMPLETENESS: z.string().min(1).optional(),
      CLIPPING: z.string().min(1).optional(),
      TIMING_SYNC: z.string().min(1).optional()
    })
    .optional()
});

export async function registerRoutes(app: FastifyInstance) {
  // 统一处理规则版本领域错误：版本不存在 / 已停用 / 无可用版本等
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof QualityRuleError) {
      return reply.code(error.statusCode).send({ error: error.message, errorCode: error.code });
    }
    app.log.error(error);
    return reply.code(500).send({ error: '服务内部错误' });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'seismic-station-quality-service',
    workflow: '发布规则版本 → 接收台站数据 → 按版本检测完整性 → 计算质量分 → 生成带版本依据的质量报告'
  }));

  // ---------- 台站 ----------
  app.get('/api/stations', async () => stations);
  app.post('/api/stations', async (request, reply) => {
    const body = request.body as Partial<(typeof stations)[number]>;
    const station = {
      id: randomUUID(),
      code: body.code ?? `QZ-${stations.length + 1}`,
      name: body.name ?? '未命名台站',
      region: body.region ?? '未设置',
      elevationM: body.elevationM ?? 0,
      status: body.status ?? 'offline',
      lastSeenAt: new Date().toISOString()
    } as (typeof stations)[number];
    stations.push(station);
    return reply.code(201).send(station);
  });

  // ---------- 质量规则版本 ----------
  app.get('/api/quality/rules', async (request, reply) => {
    const query = request.query as { status?: 'active' | 'disabled'; project?: string };
    if (query.status && query.status !== 'active' && query.status !== 'disabled') {
      return reply.code(400).send({ error: 'status 仅支持 active 或 disabled' });
    }
    return listRuleVersions({ status: query.status, project: query.project });
  });

  app.get('/api/quality/rules/:version', async (request, reply) => {
    const { version } = request.params as { version: string };
    return getRuleVersion(version);
  });

  app.post('/api/quality/rules', async (request, reply) => {
    const parsed = rulePublishSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    }
    const rule = publishRuleVersion(parsed.data);
    return reply.code(201).send(rule);
  });

  app.post('/api/quality/rules/:version/disable', async (request, reply) => {
    const { version } = request.params as { version: string };
    const rule = disableRuleVersion(version);
    return reply.send({ ...rule, message: `规则版本 ${version} 已停用，历史观测与报告仍可追溯` });
  });

  // ---------- 观测接入与查询 ----------
  app.post('/api/observations/ingest', async (request, reply) => {
    const parsed = ingestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    }
    const input = parsed.data;
    const station = stations.find(item => item.id === input.stationId);
    if (!station) return reply.code(404).send({ error: '台站不存在' });

    const rule = resolveRuleVersionForIngest(input.ruleVersion, input.project);
    const { qualityScore, issues, penalties } = evaluateQuality(input, rule);

    const observation = {
      id: randomUUID(),
      stationId: input.stationId,
      observedAt: input.observedAt ?? new Date().toISOString(),
      samples: input.samples,
      sampleRateHz: input.sampleRateHz,
      peakAmplitude: input.peakAmplitude,
      timingOffsetMs: input.timingOffsetMs,
      qualityScore,
      issues,
      ruleVersion: rule.version,
      ruleVersionId: rule.id,
      ruleThresholds: rule.thresholds,
      penalties
    };
    observations.push(observation);
    station.lastSeenAt = observation.observedAt;
    station.status = 'online';
    return reply.code(201).send(observation);
  });

  app.get('/api/observations', async (request) => {
    const query = request.query as { stationId?: string; minScore?: string; ruleVersion?: string };
    return observations.filter(
      item =>
        (!query.stationId || item.stationId === query.stationId) &&
        (!query.minScore || item.qualityScore >= Number(query.minScore)) &&
        (!query.ruleVersion || item.ruleVersion === query.ruleVersion)
    );
  });

  // ---------- 质量报告 ----------
  app.post('/api/quality/reports/run', async (request, reply) => {
    const parsed = reportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    }
    if (!stations.some(item => item.id === parsed.data.stationId)) {
      return reply.code(404).send({ error: '台站不存在' });
    }
    const rule = resolveRuleVersionForReport(parsed.data.ruleVersion);
    return reply.code(201).send(createReport(parsed.data.stationId, parsed.data.windowStart, parsed.data.windowEnd, rule));
  });

  app.get('/api/quality/reports', async (request) => {
    const query = request.query as { stationId?: string; ruleVersion?: string };
    return reports.filter(
      item =>
        (!query.stationId || item.stationId === query.stationId) &&
        (!query.ruleVersion || item.ruleVersion === query.ruleVersion)
    );
  });
}
