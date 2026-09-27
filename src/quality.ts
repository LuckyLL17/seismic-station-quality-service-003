import { randomUUID } from 'node:crypto';
import { observations, reports } from './store.js';
import type { IssueCode, IssuePenalty, Observation, QualityReport, QualityRuleVersion, QualityThresholds } from './types.js';

export const ISSUE_CODES: IssueCode[] = ['SAMPLE_COMPLETENESS', 'CLIPPING', 'TIMING_SYNC'];

export const DEFAULT_ISSUE_LABELS: Record<IssueCode, string> = {
  SAMPLE_COMPLETENESS: '采样窗口不足',
  CLIPPING: '波形削顶风险',
  TIMING_SYNC: '时间同步偏差'
};

/**
 * 规则版本错误：携带 HTTP 状态码与明确的机器可读错误码，
 * 用于“规则不存在 / 已停用 / 当前无可用版本”等场景的明确处理。
 */
export class QualityRuleError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'QualityRuleError';
  }
}

export const ruleVersions: QualityRuleVersion[] = [];

/** 内置规则 1.0.0：固化此前散落在接入逻辑中的阈值，保证服务开箱可用 */
const BUILTIN_THRESHOLDS: QualityThresholds = {
  minSamples: 0, // 0 表示按 sampleRateHz * minWindowSeconds 动态换算
  minWindowSeconds: 30,
  maxPeakAmplitude: 0.95,
  maxAbsTimingOffsetMs: 5,
  scorePenaltyPerIssue: 22,
  maxTimingPenalty: 20
};

type PublishInput = {
  version: string;
  name: string;
  description?: string;
  project?: string;
  thresholds: Partial<QualityThresholds>;
  issueLabels?: Partial<Record<IssueCode, string>>;
};

function normalizeThresholds(input: PublishInput['thresholds']): QualityThresholds {
  return {
    minSamples: input.minSamples ?? 0,
    minWindowSeconds: input.minWindowSeconds ?? 30,
    maxPeakAmplitude: input.maxPeakAmplitude ?? 0.95,
    maxAbsTimingOffsetMs: input.maxAbsTimingOffsetMs ?? 5,
    scorePenaltyPerIssue: input.scorePenaltyPerIssue ?? 22,
    maxTimingPenalty: input.maxTimingPenalty ?? 20
  };
}

/** 发布一条新的规则版本（立即生效）。版本号全局唯一，发布内容不可变 */
export function publishRuleVersion(input: PublishInput): QualityRuleVersion {
  if (ruleVersions.some(item => item.version === input.version)) {
    throw new QualityRuleError(409, 'RULE_VERSION_EXISTS', `规则版本 ${input.version} 已存在，已发布版本不可修改`);
  }
  const rule: QualityRuleVersion = {
    id: randomUUID(),
    version: input.version,
    name: input.name,
    description: input.description,
    project: input.project,
    thresholds: normalizeThresholds(input.thresholds),
    issueLabels: { ...DEFAULT_ISSUE_LABELS, ...input.issueLabels },
    status: 'active',
    publishedAt: new Date().toISOString()
  };
  ruleVersions.push(rule);
  return rule;
}

/** 停用规则版本：停用后不可用于新观测接入，但历史观测与报告仍可追溯。停用不可恢复 */
export function disableRuleVersion(version: string): QualityRuleVersion {
  const rule = getRuleVersion(version); // 不存在时抛出 RULE_VERSION_NOT_FOUND
  if (rule.status === 'active') {
    rule.status = 'disabled';
    rule.disabledAt = new Date().toISOString();
  }
  return rule;
}

/** 按版本号读取规则；不存在时抛出明确错误，绝不静默回退 */
export function getRuleVersion(version: string): QualityRuleVersion {
  const rule = ruleVersions.find(item => item.version === version);
  if (!rule) {
    throw new QualityRuleError(404, 'RULE_VERSION_NOT_FOUND', `规则版本 ${version} 不存在`);
  }
  return rule;
}

export function listRuleVersions(filter?: { status?: 'active' | 'disabled'; project?: string }): QualityRuleVersion[] {
  return ruleVersions.filter(
    item =>
      (!filter?.status || item.status === filter.status) &&
      (filter?.project === undefined || item.project === filter.project)
  );
}

/**
 * 观测接入时解析规则版本：
 * - 显式指定版本：必须存在且为 active，停用版本拒绝接入（历史数据仍保留）
 * - 指定项目：在“该项目专用规则 + 全项目通用规则”中取最新 active
 * - 未指定项目：仅在全项目通用规则中取最新 active（项目专用规则不外溢为全局默认）
 * - 不存在任何可用版本：抛出明确错误，拒绝接入而非使用隐式默认值
 */
export function resolveRuleVersionForIngest(version?: string, project?: string): QualityRuleVersion {
  if (version) {
    const rule = getRuleVersion(version);
    if (rule.status !== 'active') {
      throw new QualityRuleError(409, 'RULE_VERSION_DISABLED', `规则版本 ${version} 已停用，不能用于新观测接入；历史观测仍可通过该版本追溯`);
    }
    return rule;
  }
  const candidates = ruleVersions
    .filter(item => item.status === 'active' && (project === undefined ? item.project === undefined : item.project === undefined || item.project === project))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (candidates.length === 0) {
    throw new QualityRuleError(
      409,
      'NO_ACTIVE_RULE_VERSION',
      project ? `项目 ${project} 当前没有可用的规则版本，请先发布规则` : '当前没有可用的规则版本，请先发布规则'
    );
  }
  return candidates[0];
}

function requiredSamples(rule: QualityRuleVersion, sampleRateHz: number): number {
  return rule.thresholds.minSamples > 0
    ? rule.thresholds.minSamples
    : sampleRateHz * rule.thresholds.minWindowSeconds;
}

/** 依据指定规则版本对一条观测做完整性/削顶/时间同步判定，返回分数与逐项扣分明细 */
export function evaluateQuality(
  input: Pick<Observation, 'samples' | 'sampleRateHz' | 'peakAmplitude' | 'timingOffsetMs'>,
  rule: QualityRuleVersion
): { qualityScore: number; issues: string[]; penalties: IssuePenalty[] } {
  const t = rule.thresholds;
  const penalties: IssuePenalty[] = [];
  const need = requiredSamples(rule, input.sampleRateHz);

  if (input.samples < need) {
    penalties.push({
      code: 'SAMPLE_COMPLETENESS',
      label: rule.issueLabels.SAMPLE_COMPLETENESS,
      penalty: t.scorePenaltyPerIssue,
      detail: `样本数 ${input.samples} 低于要求 ${need}`
    });
  }
  if (input.peakAmplitude > t.maxPeakAmplitude) {
    penalties.push({
      code: 'CLIPPING',
      label: rule.issueLabels.CLIPPING,
      penalty: t.scorePenaltyPerIssue,
      detail: `峰值振幅 ${input.peakAmplitude} 超过上限 ${t.maxPeakAmplitude}`
    });
  }
  const absOffset = Math.abs(input.timingOffsetMs);
  if (absOffset > t.maxAbsTimingOffsetMs) {
    penalties.push({
      code: 'TIMING_SYNC',
      label: rule.issueLabels.TIMING_SYNC,
      penalty: t.scorePenaltyPerIssue,
      detail: `时间偏差 ${input.timingOffsetMs}ms 超过 ±${t.maxAbsTimingOffsetMs}ms`
    });
  }

  const timingPenalty = Math.min(absOffset, t.maxTimingPenalty);
  const qualityScore = Math.max(
    0,
    Math.round(100 - penalties.reduce((sum, item) => sum + item.penalty, 0) - timingPenalty)
  );
  return { qualityScore, issues: penalties.map(item => item.label), penalties };
}

/**
 * 生成报告时解析规则版本：
 * - 显式指定：必须存在（停用版本允许使用，用于历史观测追溯）
 * - 未指定：使用当前 active 版本；不存在可用版本时明确报错
 */
export function resolveRuleVersionForReport(version?: string): QualityRuleVersion {
  if (version) return getRuleVersion(version);
  const active = ruleVersions
    .filter(item => item.status === 'active')
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (active.length === 0) {
    throw new QualityRuleError(409, 'NO_ACTIVE_RULE_VERSION', '当前没有可用的规则版本，请先发布规则或显式指定历史版本号');
  }
  return active[0];
}

/** 按规则版本生成时间窗口报告：只纳入同一版本的观测，并快照阈值与标签作为评分依据 */
export function createReport(stationId: string, start: string, end: string, rule: QualityRuleVersion): QualityReport {
  const inWindow = observations.filter(
    item => item.stationId === stationId && item.observedAt >= start && item.observedAt <= end
  );
  const rows = inWindow.filter(item => item.ruleVersionId === rule.id);
  const averageScore = rows.length
    ? Math.round(rows.reduce((sum, item) => sum + item.qualityScore, 0) / rows.length)
    : 0;
  const issueBreakdown = ISSUE_CODES.map(code => ({
    code,
    label: rule.issueLabels[code],
    count: rows.reduce((sum, item) => sum + (item.penalties.some(penalty => penalty.code === code) ? 1 : 0), 0)
  })).filter(item => item.count > 0);
  const issues = [...new Set(rows.flatMap(item => item.issues))];

  const report: QualityReport = {
    id: randomUUID(),
    stationId,
    windowStart: start,
    windowEnd: end,
    observationCount: rows.length,
    averageScore,
    issues,
    generatedAt: new Date().toISOString(),
    ruleVersion: rule.version,
    ruleVersionId: rule.id,
    ruleName: rule.name,
    ruleThresholds: rule.thresholds,
    issueLabels: rule.issueLabels,
    issueBreakdown,
    excludedOtherVersionCount: inWindow.length - rows.length
  };
  reports.push(report);
  return report;
}

// 初始化内置规则版本（仅一次）
publishRuleVersion({
  version: '1.0.0',
  name: '内置基础规则',
  description: '固化服务初版阈值：30 秒采样窗口、峰值 0.95、时间偏差 ±5ms',
  thresholds: BUILTIN_THRESHOLDS
});
