import { DIMENSIONS } from '../shared/day-contracts.ts';
import type { AdoptSuggestion, AiSettings, GenerateReport, ReportType } from '../shared/report-contracts.ts';
import { businessDate, dayText } from './day-validation.ts';
import { invalid } from './errors.ts';
import { integer, object, requestId } from './validation.ts';
export function reportType(value: unknown): ReportType { if (value !== 'plan' && value !== 'review') invalid('报告类型必须为计划建议或经营复盘。'); return value; }
export function generateInput(value: unknown): GenerateReport {
  const row = object(value, '生成报告', ['requestId', 'revision', 'input_hash', 'force']); if (typeof row.force !== 'boolean') invalid('重新生成标志无效。');
  return { requestId: requestId(row.requestId), revision: integer(row.revision, '日期版本', 0), input_hash: dayText(row.input_hash, '依据标识', 64), force: row.force };
}
export function aiSettingsInput(value: unknown) {
  const row = object(value, 'AI 设置', ['revision', 'settings', 'key', 'clear_key']);
  const fields = object(row.settings, '服务配置', ['mode', 'model', 'max_output_tokens', 'daily_call_limit']);
  if (fields.mode !== 'local' && fields.mode !== 'openai') invalid('暂支持本地摘要或 OpenAI 官方 API。');
  const model = dayText(fields.model, '模型名称', 160, true); if (model && !/^[A-Za-z0-9._:/-]+$/u.test(model)) invalid('模型名称格式不正确。');
  if (fields.mode === 'openai' && !model) invalid('在线模式需要填写模型名称。');
  if (typeof row.clear_key !== 'boolean') invalid('清除密钥标志无效。');
  const key = row.key === undefined ? undefined : dayText(row.key, '密钥', 1000); if (key && /\s/u.test(key)) invalid('密钥不能包含空白。'); if (key && row.clear_key) invalid('不能同时替换和清除密钥。');
  const settings: AiSettings = { mode: fields.mode, model, max_output_tokens: integer(fields.max_output_tokens, '单次输出上限', 800, 6000), daily_call_limit: integer(fields.daily_call_limit, '每日调用上限', 1, 100) };
  return { revision: integer(row.revision, '设置版本', 1), settings, key, clearKey: row.clear_key };
}
export function adoptionInput(value: unknown): AdoptSuggestion {
  const row = object(value, '采纳建议', ['requestId', 'target_date', 'target_revision', 'suggestion_index', 'action', 'acceptance', 'estimated_minutes', 'dimension', 'change_reason']);
  if (!DIMENSIONS.includes(row.dimension as any)) invalid('计分维度无效。');
  return { requestId: requestId(row.requestId), target_date: businessDate(row.target_date), target_revision: integer(row.target_revision, '目标日版本', 0), suggestion_index: integer(row.suggestion_index, '建议序号', 0, 5), action: dayText(row.action, '具体行动', 240), acceptance: dayText(row.acceptance, '验收条件', 2000), estimated_minutes: row.estimated_minutes === null ? null : integer(row.estimated_minutes, '预计分钟', 0, 1440), dimension: row.dimension as AdoptSuggestion['dimension'], change_reason: dayText(row.change_reason, '调整原因', 2000, true) };
}
