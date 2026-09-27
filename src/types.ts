export type Station = { id: string; code: string; name: string; region: string; elevationM: number; status: 'online' | 'maintenance' | 'offline'; lastSeenAt: string };

/** 规则可判定的三类问题代码 */
export type IssueCode = 'SAMPLE_COMPLETENESS' | 'CLIPPING' | 'TIMING_SYNC';

/** 一条质量规则的阈值配置（不同科研项目可使用不同标准） */
export type QualityThresholds = {
  /**
   * 采样完整性判定：minSamples > 0 时使用该绝对值；
   * 否则按 sampleRateHz × minWindowSeconds 动态换算
   */
  minSamples: number;
  minWindowSeconds: number;
  /** 削顶：峰值振幅上限（归一化振幅，超过即判定削顶风险） */
  maxPeakAmplitude: number;
  /** 时间同步：允许的最大偏差绝对值（毫秒） */
  maxAbsTimingOffsetMs: number;
  /** 评分参数：每类命中问题的扣分 */
  scorePenaltyPerIssue: number;
  /** 评分参数：时间偏差扣分封顶（毫秒） */
  maxTimingPenalty: number;
};

export type QualityRuleVersion = {
  id: string;
  /** 发布者指定的唯一版本号，如 1.0.0；发布后不可修改 */
  version: string;
  name: string;
  description?: string;
  /** 可选项目范围：不填表示全项目通用，填写后只对该项目生效 */
  project?: string;
  thresholds: QualityThresholds;
  /** 问题代码到标签文案的映射，随版本固化 */
  issueLabels: Record<IssueCode, string>;
  status: 'active' | 'disabled';
  publishedAt: string;
  disabledAt?: string;
};

/** 单项问题判定结果，扣分明细可在报告中解释评分依据 */
export type IssuePenalty = {
  code: IssueCode;
  label: string;
  penalty: number;
  detail: string;
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
  issues: string[];
  /** 评分所依据的规则版本号（发布后不可变，停用后历史记录仍可追溯） */
  ruleVersion: string;
  ruleVersionId: string;
  /** 评分时使用的规则阈值快照 */
  ruleThresholds: QualityThresholds;
  /** 逐项判定与扣分明细 */
  penalties: IssuePenalty[];
};

export type QualityReport = {
  id: string;
  stationId: string;
  windowStart: string;
  windowEnd: string;
  observationCount: number;
  averageScore: number;
  issues: string[];
  generatedAt: string;
  /** 本报告全部观测共同依据的规则版本号 */
  ruleVersion: string;
  ruleVersionId: string;
  /** 规则名称与阈值快照，报告可据此说明评分依据 */
  ruleName: string;
  ruleThresholds: QualityThresholds;
  issueLabels: Record<IssueCode, string>;
  /** 各问题代码命中的观测次数，便于报告分项统计 */
  issueBreakdown: { code: IssueCode; label: string; count: number }[];
  /** 窗口内但属于其他规则版本、未计入本报告的观测数 */
  excludedOtherVersionCount: number;
};
