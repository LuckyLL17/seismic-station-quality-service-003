import type { IssueCode, IssueLabels, Observation, QualityRuleVersion, RuleThresholds } from './types.js';

export const DEFAULT_ISSUE_LABELS: IssueLabels = {
  completeness: '采样窗口不足',
  clipping: '波形削顶风险',
  timing: '时间同步偏差'
};

/** 内置初始版本：保持改造前散落在接入逻辑中的阈值，保证既有行为可追溯 */
export const DEFAULT_THRESHOLDS: RuleThresholds = {
  minSampleWindowSec: 30,
  clippingAmplitude: 0.95,
  timingOffsetToleranceMs: 5,
  scorePenaltyPerIssue: 22,
  maxTimingPenalty: 20
};

export type EvaluationInput = Pick<Observation, 'samples' | 'sampleRateHz' | 'peakAmplitude' | 'timingOffsetMs'>;

export type EvaluationResult = {
  qualityScore: number;
  issueCodes: IssueCode[];
  issues: string[];
};

/** 按指定规则版本评估观测数据；阈值与问题标签全部来自规则版本，不在调用方散落 */
export function evaluateQuality(input: EvaluationInput, rule: QualityRuleVersion): EvaluationResult {
  const { thresholds, issueLabels } = rule;
  const issueCodes: IssueCode[] = [];
  if (input.samples < input.sampleRateHz * thresholds.minSampleWindowSec) issueCodes.push('completeness');
  if (input.peakAmplitude > thresholds.clippingAmplitude) issueCodes.push('clipping');
  if (Math.abs(input.timingOffsetMs) > thresholds.timingOffsetToleranceMs) issueCodes.push('timing');

  const timingPenalty = Math.min(Math.abs(input.timingOffsetMs), thresholds.maxTimingPenalty);
  const qualityScore = Math.max(0, Math.round(100 - issueCodes.length * thresholds.scorePenaltyPerIssue - timingPenalty));

  return { qualityScore, issueCodes, issues: issueCodes.map(code => issueLabels[code]) };
}
