import { ForbiddenError } from './errors.js';
import type { AuthUser } from './middleware.js';

/**
 * Central role-based access policy (previously each route did its own partial check).
 *
 *  CITIZEN     - only their own applications; never acts on workflow stages.
 *  OFFICER     - may VIEW applications whose workflow involves their department
 *                (past, current or upcoming stage); may ACT only on the currently active
 *                stage of their own department. Officers without a department can do nothing.
 *  SUPERVISOR  - view everything, act on any stage (escalation authority).
 *  ADMIN       - view everything; workflow configuration; no casework actions except via supervisor role.
 */
export interface AppAccessShape {
  citizenId: string;
  service?: { stages?: Array<{ departmentCode: string }> } | null;
  stageInstances?: Array<{ stage?: { departmentCode: string } | null }>;
  currentStage?: { departmentCode: string } | null;
}

export class AccessPolicy {
  static isStaff(actor: AuthUser): boolean {
    return actor.role === 'OFFICER' || actor.role === 'SUPERVISOR' || actor.role === 'ADMIN';
  }

  static isOversight(actor: AuthUser): boolean {
    return actor.role === 'SUPERVISOR' || actor.role === 'ADMIN';
  }

  static departmentsInvolved(app: AppAccessShape): Set<string> {
    const set = new Set<string>();
    app.service?.stages?.forEach(s => set.add(s.departmentCode));
    app.stageInstances?.forEach(i => i.stage && set.add(i.stage.departmentCode));
    if (app.currentStage) set.add(app.currentStage.departmentCode);
    return set;
  }

  static canView(actor: AuthUser, app: AppAccessShape): boolean {
    if (this.isOversight(actor)) return true;
    if (actor.role === 'CITIZEN') return app.citizenId === actor.id;
    if (actor.role === 'OFFICER') {
      if (!actor.departmentCode) return false;
      return this.departmentsInvolved(app).has(actor.departmentCode);
    }
    return false;
  }

  static assertCanView(actor: AuthUser, app: AppAccessShape) {
    if (!this.canView(actor, app)) {
      throw new ForbiddenError(
        actor.role === 'CITIZEN'
          ? 'You do not have permission to view this application'
          : 'This application is outside your department\'s jurisdiction'
      );
    }
  }

  /** May this actor take a workflow action (forward, hold, request docs, decide) on a stage of this department? */
  static assertCanActOnStage(actor: AuthUser, stageDepartmentCode: string) {
    if (actor.role === 'CITIZEN') {
      throw new ForbiddenError('Citizens cannot perform officer workflow actions');
    }
    if (actor.role === 'SUPERVISOR') return;
    if (actor.role === 'ADMIN') {
      throw new ForbiddenError('Administrators configure workflows; casework actions require an officer or supervisor account');
    }
    if (!actor.departmentCode) {
      throw new ForbiddenError('Your officer account is not linked to any department');
    }
    if (actor.departmentCode !== stageDepartmentCode) {
      throw new ForbiddenError(
        `Only officers from ${stageDepartmentCode} can process this stage. Your department is ${actor.departmentCode}.`
      );
    }
  }

  /** Whether citizen contact details should be masked for this viewer. */
  static shouldMaskCitizenContact(actor: AuthUser, app: { citizenId: string }): boolean {
    if (actor.role === 'CITIZEN' && actor.id === app.citizenId) return false;
    if (this.isOversight(actor)) return false;
    return true;
  }
}
