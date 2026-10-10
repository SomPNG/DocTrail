import { safeJsonParse } from '../common/utils.js';

/**
 * Services are stored with two different configJson shapes:
 *  - registered services (workflowConfig.ts): stages[].key, requiredDocuments: string[],
 *    compensationRatePerDayDelayINR
 *  - AI / admin-published services: stages[].stageKey, requiredDocuments: {documentType,...}[],
 *    compensationPerDay
 * These helpers read both so callers never have to care (previously they silently got nothing).
 */
export interface RequiredDoc {
  documentType: string;
  title: string;
  description: string;
  isMandatory: boolean;
}

const DEFAULT_COMPENSATION_PER_DAY = 200;

function humanize(slug: string): string {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export class ServiceConfig {
  static parse(configJson: string | null | undefined): any {
    return safeJsonParse<any>(configJson, {});
  }

  static compensationRatePerDay(configJson: string | null | undefined): number {
    const cfg = this.parse(configJson);
    const rate = cfg.compensationRatePerDayDelayINR ?? cfg.compensationPerDay ?? cfg.statutoryCompensationPerDay;
    return typeof rate === 'number' && rate > 0 ? rate : DEFAULT_COMPENSATION_PER_DAY;
  }

  static category(configJson: string | null | undefined): string {
    return this.parse(configJson).category || 'Public Services';
  }

  static stageConfig(configJson: string | null | undefined, stageKey: string): any | undefined {
    const cfg = this.parse(configJson);
    const stages: any[] = Array.isArray(cfg.stages) ? cfg.stages : [];
    return stages.find(s => s.stageKey === stageKey || s.key === stageKey);
  }

  static requiredDocuments(configJson: string | null | undefined, stageKey: string): RequiredDoc[] {
    const st = this.stageConfig(configJson, stageKey);
    const docs: any[] = Array.isArray(st?.requiredDocuments) ? st.requiredDocuments : [];
    return docs
      .map(d => {
        if (typeof d === 'string') {
          return {
            documentType: d.toLowerCase(),
            title: humanize(d),
            description: `Required for ${st?.name || stageKey}`,
            isMandatory: true,
          };
        }
        if (d && typeof d === 'object' && d.documentType) {
          return {
            documentType: String(d.documentType).toLowerCase(),
            title: d.title || humanize(String(d.documentType)),
            description: d.description || '',
            isMandatory: d.isMandatory !== false,
          };
        }
        return null;
      })
      .filter((d): d is RequiredDoc => d !== null);
  }
}
