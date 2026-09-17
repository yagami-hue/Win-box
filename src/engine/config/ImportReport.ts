// src/engine/config/ImportReport.ts
// 汇总导入诊断。对齐 SiteReportItem / ImportReport DTO。
import type { ImportReport, SiteReportItem } from '../../shared/types';

export function buildImportReport(items: SiteReportItem[]): ImportReport {
  let ok = 0,
    skipped = 0,
    degraded = 0;
  for (const it of items) {
    if (it.status === 'OK') ok++;
    else if (it.status === 'SKIP') skipped++;
    else if (it.status === 'DEGRADE') degraded++;
  }
  return { total: items.length, ok, skipped, degraded, items };
}
