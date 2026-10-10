import { AppError } from './errors.js';

export interface ChecklistItem {
  id: string;
  label: string;
  isMandatory: boolean;
}

export type ChecklistResponses = Record<string, boolean> | string[] | undefined | null;

/**
 * Single implementation of the statutory verification gate (previously copy-pasted in two places).
 * There is deliberately NO wildcard: every mandatory item must be ticked by id or label.
 */
export class ChecklistGate {
  static parse(checklistJson: string | null | undefined): ChecklistItem[] {
    if (!checklistJson) return [];
    try {
      const parsed = JSON.parse(checklistJson);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item: any, idx: number) => {
        if (typeof item === 'string') {
          return { id: `check_${idx}`, label: item, isMandatory: true };
        }
        return {
          id: String(item.id || `check_${idx}`),
          label: String(item.label || item.title || `Verification check ${idx + 1}`),
          isMandatory: item.isMandatory !== false,
        };
      });
    } catch {
      return [];
    }
  }

  /** Returns the labels of mandatory checks that were not ticked. */
  static unverified(items: ChecklistItem[], responses: ChecklistResponses): string[] {
    const mandatory = items.filter(c => c.isMandatory);
    const missing: string[] = [];
    for (const chk of mandatory) {
      let ok = false;
      if (Array.isArray(responses)) {
        ok = responses.includes(chk.id) || responses.includes(chk.label);
      } else if (responses && typeof responses === 'object') {
        ok = responses[chk.id] === true || responses[chk.label] === true;
      }
      if (!ok) missing.push(chk.label);
    }
    return missing;
  }

  /** Throws 400 if any mandatory item is unverified. `action` is used in the error message. */
  static assertComplete(checklistJson: string | null | undefined, responses: ChecklistResponses, action: string) {
    const items = this.parse(checklistJson);
    const mandatory = items.filter(c => c.isMandatory);
    if (mandatory.length === 0) return;

    if (!responses || (typeof responses === 'object' && !Array.isArray(responses) && Object.keys(responses).length === 0)) {
      throw new AppError(
        `Cannot ${action}: All ${mandatory.length} mandatory verification checks must be completed by the reviewing officer first.`,
        400
      );
    }

    const missing = this.unverified(items, responses);
    if (missing.length > 0) {
      throw new AppError(
        `Cannot ${action}: ${missing.length} mandatory verification check(s) remain unverified: ${missing.join('; ')}`,
        400,
        { unverified: missing }
      );
    }
  }

  /** All ids (used by the simulation's virtual officers, who genuinely tick every box). */
  static allIds(checklistJson: string | null | undefined): string[] {
    return this.parse(checklistJson).map(c => c.id);
  }
}
