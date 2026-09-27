import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { evaluateQuality } from './quality.js';
import {
  createReport,
  deactivateRule,
  findRuleById,
  findRuleByVersion,
  getDefaultActiveRule,
  observations,
  publishRule,
  reports,
  ruleVersions,
  setDefaultRule,
  stations
} from './store.js';
import type { IssueLabels } from './types.js';

const thresholdsSchema = z.object({
  minSampleWindowSec: z.number().positive(),
  clippingAmplitude: z.number().positive(),
  timingOffsetToleranceMs: z.number().nonnegative(),
  scorePenaltyPerIssue: z.number().nonnegative(),
  maxTimingPenalty: z.number().nonnegative()
});

const publishRuleSchema = z.object({
  version: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().default(''),
  thresholds: thresholdsSchema,
  issueLabels: z.object({
    completeness: z.string().min(1).optional(),
    clipping: z.string().min(1).optional(),
    timing: z.string().min(1).optional()
  }).optional(),
  makeDefault: z.boolean().optional()
});

const ingestSchema = z.object({
  stationId: z.string(),
  observedAt: z.string().datetime().optional(),
  ruleVersionId: z.string().optional(),
  samples: z.number().int().nonnegative(),
  sampleRateHz: z.number().positive(),
  peakAmplitude: z.number().nonnegative(),
  timingOffsetMs: z.number()
});

const reportSchema = z.object({
  stationId: z.string(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  ruleVersionId: z.string().nullable().optional()
});

export async function registerRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'seismic-station-quality-service',
    workflow: '接收台站数据 → 按规则版本检测完整性 → 计算质量分 → 生成可追溯质量报告',
    defaultRuleVersion: getDefaultActiveRule()?.version ?? null
  }));

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

  // ---- 质量规则版本 ----

  app.get('/api/quality/rules', async (request) => {
    const query = request.query as { status?: 'active' | 'inactive' };
    return ruleVersions
      .filter(rule => !query.status || rule.status === query.status)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  });

  app.get('/api/quality/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const rule = findRuleById(id) ?? findRuleByVersion(id);
    if (!rule) return reply.code(404).send({ error: '质量规则版本不存在', ruleVersionId: id });
    return rule;
  });

  app.post('/api/quality/rules', async (request, reply) => {
    const parsed = publishRuleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    const input = parsed.data;
    if (findRuleByVersion(input.version)) {
      return reply.code(409).send({ error: '质量规则版本号已存在，已发布版本不可修改，请使用新版本号', version: input.version });
    }
    const rule = publishRule({
      version: input.version,
      name: input.name ?? `质量规则 ${input.version}`,
      description: input.description,
      thresholds: input.thresholds,
      issueLabels: input.issueLabels as Partial<IssueLabels> | undefined,
      makeDefault: input.makeDefault
    });
    return reply.code(201).send(rule);
  });

  app.post('/api/quality/rules/:id/deactivate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const rule = findRuleById(id) ?? findRuleByVersion(id);
    if (!rule) return reply.code(404).send({ error: '质量规则版本不存在', ruleVersionId: id });
    if (rule.status === 'active' && !ruleVersions.some(item => item.status === 'active' && item.id !== rule.id)) {
      return reply.code(409).send({ error: '不能停用最后一个启用中的规则版本，请先发布新版本', ruleVersionId: rule.id });
    }
    return deactivateRule(rule);
  });

  app.post('/api/quality/rules/:id/default', async (request, reply) => {
    const { id } = request.params as { id: string };
    const rule = findRuleById(id) ?? findRuleByVersion(id);
    if (!rule) return reply.code(404).send({ error: '质量规则版本不存在', ruleVersionId: id });
    if (rule.status !== 'active') return reply.code(409).send({ error: '只有启用中的规则版本可以设为默认', ruleVersionId: rule.id, status: rule.status });
    return setDefaultRule(rule);
  });

  // ---- 观测接入 ----

  app.post('/api/observations/ingest', async (request, reply) => {
    const parsed = ingestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    const input = parsed.data;

    const station = stations.find(item => item.id === input.stationId);
    if (!station) return reply.code(404).send({ error: '台站不存在' });

    let rule;
    if (input.ruleVersionId) {
      rule = findRuleById(input.ruleVersionId) ?? findRuleByVersion(input.ruleVersionId);
      if (!rule) {
        return reply.code(404).send({ error: '指定的质量规则版本不存在，无法接入', ruleVersionId: input.ruleVersionId });
      }
      if (rule.status !== 'active') {
        return reply.code(409).send({ error: '该质量规则版本已停用，不能用于新观测接入，请改用启用中的版本', ruleVersionId: rule.id, version: rule.version, status: rule.status });
      }
    } else {
      rule = getDefaultActiveRule();
      if (!rule) {
        return reply.code(409).send({ error: '当前没有启用中的质量规则版本，请先发布规则（POST /api/quality/rules）或在请求中指定 ruleVersionId' });
      }
    }

    const result = evaluateQuality(input, rule);
    const observedAt = input.observedAt ?? new Date().toISOString();
    const observation = {
      id: randomUUID(),
      stationId: input.stationId,
      observedAt,
      samples: input.samples,
      sampleRateHz: input.sampleRateHz,
      peakAmplitude: input.peakAmplitude,
      timingOffsetMs: input.timingOffsetMs,
      qualityScore: result.qualityScore,
      issueCodes: result.issueCodes,
      issues: result.issues,
      ruleVersionId: rule.id,
      ruleVersion: rule.version,
      ruleName: rule.name
    };
    observations.push(observation);
    station.lastSeenAt = observedAt;
    station.status = 'online';
    return reply.code(201).send(observation);
  });

  app.get('/api/observations', async (request) => {
    const query = request.query as { stationId?: string; minScore?: string; ruleVersionId?: string };
    return observations.filter(item =>
      (!query.stationId || item.stationId === query.stationId)
      && (!query.minScore || item.qualityScore >= Number(query.minScore))
      && (!query.ruleVersionId || item.ruleVersionId === query.ruleVersionId || item.ruleVersion === query.ruleVersionId)
    );
  });

  // ---- 质量报告 ----

  app.post('/api/quality/reports/run', async (request, reply) => {
    const parsed = reportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数校验失败', details: parsed.error.flatten() });
    const { stationId, windowStart, windowEnd, ruleVersionId } = parsed.data;
    if (!stations.some(item => item.id === stationId)) return reply.code(404).send({ error: '台站不存在' });
    // 报告支持按任意版本（含已停用）追溯；版本必须真实存在
    if (ruleVersionId) {
      const rule = findRuleById(ruleVersionId) ?? findRuleByVersion(ruleVersionId);
      if (!rule) return reply.code(404).send({ error: '质量规则版本不存在，无法生成报告', ruleVersionId });
      return reply.code(201).send(createReport(stationId, windowStart, windowEnd, rule.id));
    }
    return reply.code(201).send(createReport(stationId, windowStart, windowEnd, null));
  });

  app.get('/api/quality/reports', async (request) => {
    const query = request.query as { stationId?: string; ruleVersionId?: string };
    return reports.filter(item =>
      (!query.stationId || item.stationId === query.stationId)
      && (!query.ruleVersionId || item.ruleVersionId === query.ruleVersionId || item.ruleBreakdown.some(rule => rule.ruleVersionId === query.ruleVersionId || rule.ruleVersion === query.ruleVersionId))
    );
  });
}
