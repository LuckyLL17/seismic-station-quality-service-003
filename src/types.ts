export type Station = { id: string; code: string; name: string; region: string; elevationM: number; status: 'online' | 'maintenance' | 'offline'; lastSeenAt: string };

export type IssueCode = 'completeness' | 'clipping' | 'timing';

export type IssueLabels = Record<IssueCode, string>;

export type RuleThresholds = {
  /** 采样窗口最少秒数：samples 需 >= sampleRateHz * minSampleWindowSec */
  minSampleWindowSec: number;
  /** 波形削顶判定阈值：peakAmplitude 高于该值视为削顶 */
  clippingAmplitude: number;
  /** 时间同步偏差容忍值（毫秒）：|timingOffsetMs| 高于该值视为不同步 */
  timingOffsetToleranceMs: number;
  /** 每个问题扣减的质量分 */
  scorePenaltyPerIssue: number;
  /** 时间同步偏差扣分上限 */
  maxTimingPenalty: number;
};

export type RuleStatus = 'active' | 'inactive';

export type QualityRuleVersion = {
  id: string;
  version: string;
  name: string;
  description: string;
  isDefault: boolean;
  status: RuleStatus;
  thresholds: RuleThresholds;
  issueLabels: IssueLabels;
  publishedAt: string;
  deactivatedAt: string | null;
};

export type Observation = {
  id: string;
  stationId: string;
  observedAt: string;
  samples: number;
  sampleRateHz: number;
  peakAmplitude: number;
  timingOffsetMs: number;
  qualityScore: number;
  issueCodes: IssueCode[];
  issues: string[];
  /** 评分时使用的规则版本（快照引用，规则停用后历史观测仍可追溯） */
  ruleVersionId: string;
  ruleVersion: string;
  ruleName: string;
};

export type ReportRuleBreakdown = {
  ruleVersionId: string;
  ruleVersion: string;
  ruleName: string;
  ruleStatus: RuleStatus | 'unknown';
  thresholds: RuleThresholds | null;
  issueLabels: IssueLabels | null;
  observationCount: number;
  averageScore: number;
  issueCodes: IssueCode[];
  issues: string[];
};

export type QualityReport = {
  id: string;
  stationId: string;
  windowStart: string;
  windowEnd: string;
  observationCount: number;
  averageScore: number;
  issueCodes: IssueCode[];
  issues: string[];
  /** 生成报告时指定的规则版本过滤；null 表示覆盖时间窗内全部版本 */
  ruleVersionId: string | null;
  ruleBreakdown: ReportRuleBreakdown[];
  generatedAt: string;
};
