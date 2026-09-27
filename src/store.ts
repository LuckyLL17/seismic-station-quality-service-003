import { randomUUID } from 'node:crypto';
import { DEFAULT_ISSUE_LABELS, DEFAULT_THRESHOLDS } from './quality.js';
import type {
  IssueCode,
  Observation,
  QualityReport,
  QualityRuleVersion,
  ReportRuleBreakdown,
  RuleStatus,
  Station
} from './types.js';

export const stations: Station[] = [
  { id: 'st-001', code: 'QZ-A01', name: '青岚台站', region: '川西断裂带', elevationM: 1840, status: 'online', lastSeenAt: new Date().toISOString() },
  { id: 'st-002', code: 'QZ-B07', name: '白石台站', region: '龙门山南段', elevationM: 920, status: 'online', lastSeenAt: new Date().toISOString() },
  { id: 'st-003', code: 'QZ-C12', name: '岷江台站', region: '岷江河谷', elevationM: 2470, status: 'maintenance', lastSeenAt: new Date().toISOString() }
];

function seedDefaultRule(): QualityRuleVersion {
  const now = new Date().toISOString();
  return {
    id: 'rv-default-v1',
    version: 'v1.0',
    name: '基础质量规则',
    description: '内置初始版本：采样窗口 30 秒、削顶阈值 0.95、时间同步容忍 5ms，沿用服务上线时的评分口径。',
    isDefault: true,
    status: 'active',
    thresholds: { ...DEFAULT_THRESHOLDS },
    issueLabels: { ...DEFAULT_ISSUE_LABELS },
    publishedAt: now,
    deactivatedAt: null
  };
}

export const ruleVersions: QualityRuleVersion[] = [seedDefaultRule()];
export const observations: Observation[] = [];
export const reports: QualityReport[] = [];

export function findRuleById(id: string): QualityRuleVersion | undefined {
  return ruleVersions.find(rule => rule.id === id);
}

export function findRuleByVersion(version: string): QualityRuleVersion | undefined {
  return ruleVersions.find(rule => rule.version === version);
}

export function getDefaultActiveRule(): QualityRuleVersion | undefined {
  return ruleVersions.find(rule => rule.status === 'active' && rule.isDefault)
    ?? ruleVersions.find(rule => rule.status === 'active');
}

export function publishRule(input: {
  version: string;
  name: string;
  description: string;
  thresholds: QualityRuleVersion['thresholds'];
  issueLabels?: Partial<QualityRuleVersion['issueLabels']>;
  makeDefault?: boolean;
}): QualityRuleVersion {
  const rule: QualityRuleVersion = {
    id: randomUUID(),
    version: input.version,
    name: input.name,
    description: input.description,
    isDefault: false,
    status: 'active',
    thresholds: { ...input.thresholds },
    issueLabels: { ...DEFAULT_ISSUE_LABELS, ...input.issueLabels },
    publishedAt: new Date().toISOString(),
    deactivatedAt: null
  };
  // 首个启用版本自动成为默认；显式要求默认，或当前没有启用中的默认版本时同样置为默认
  const makeDefault = input.makeDefault ?? !ruleVersions.some(item => item.status === 'active' && item.isDefault);
  if (makeDefault) {
    rule.isDefault = true;
    for (const existing of ruleVersions) existing.isDefault = false;
  }
  ruleVersions.push(rule);
  return rule;
}

export function deactivateRule(rule: QualityRuleVersion): QualityRuleVersion {
  if (rule.status === 'active') {
    rule.status = 'inactive';
    rule.isDefault = false;
    rule.deactivatedAt = new Date().toISOString();
  }
  return rule;
}

export function setDefaultRule(rule: QualityRuleVersion): QualityRuleVersion {
  for (const existing of ruleVersions) existing.isDefault = false;
  rule.isDefault = true;
  return rule;
}

function averageScore(rows: Observation[]): number {
  return rows.length ? Math.round(rows.reduce((sum, item) => sum + item.qualityScore, 0) / rows.length) : 0;
}

export function createReport(stationId: string, start: string, end: string, ruleVersionId: string | null): QualityReport {
  const rows = observations.filter(item =>
    item.stationId === stationId
    && item.observedAt >= start
    && item.observedAt <= end
    && (ruleVersionId === null || item.ruleVersionId === ruleVersionId)
  );

  const groups = new Map<string, Observation[]>();
  for (const item of rows) {
    const group = groups.get(item.ruleVersionId);
    if (group) group.push(item);
    else groups.set(item.ruleVersionId, [item]);
  }

  const ruleBreakdown: ReportRuleBreakdown[] = [...groups.entries()].map(([versionId, groupRows]) => {
    const rule = findRuleById(versionId);
    const issueCodes = [...new Set(groupRows.flatMap(item => item.issueCodes))] as IssueCode[];
    const status: RuleStatus | 'unknown' = rule ? rule.status : 'unknown';
    return {
      ruleVersionId: versionId,
      ruleVersion: rule?.version ?? groupRows[0].ruleVersion,
      ruleName: rule?.name ?? groupRows[0].ruleName,
      ruleStatus: status,
      thresholds: rule ? { ...rule.thresholds } : null,
      issueLabels: rule ? { ...rule.issueLabels } : null,
      observationCount: groupRows.length,
      averageScore: averageScore(groupRows),
      issueCodes,
      // 标签以当前规则版本为准；版本缺失（如存储迁移）时回退到观测快照标签
      issues: rule ? issueCodes.map(code => rule.issueLabels[code]) : [...new Set(groupRows.flatMap(item => item.issues))]
    };
  }).sort((a, b) => a.ruleVersion.localeCompare(b.ruleVersion));

  const report: QualityReport = {
    id: randomUUID(),
    stationId,
    windowStart: start,
    windowEnd: end,
    observationCount: rows.length,
    averageScore: averageScore(rows),
    issueCodes: [...new Set(rows.flatMap(item => item.issueCodes))] as IssueCode[],
    issues: [...new Set(ruleBreakdown.flatMap(item => item.issues))],
    ruleVersionId,
    ruleBreakdown,
    generatedAt: new Date().toISOString()
  };
  reports.push(report);
  return report;
}
