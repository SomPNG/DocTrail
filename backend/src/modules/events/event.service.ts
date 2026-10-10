import { prisma, type Db } from '../../db/client.js';
import { SecurityEngine, CryptographicSeal } from '../../common/security.js';
import { Clock } from '../../common/clock.js';

export type EventType =
  | 'APPLICATION_CREATED'
  | 'STAGE_ENTERED'
  | 'STAGE_ASSIGNED'
  | 'STAGE_COMPLETED'
  | 'APPLICATION_FORWARDED'
  | 'DOCUMENT_REQUESTED'
  | 'DOCUMENT_SUBMITTED'
  | 'DOCUMENT_REMINDER_SENT'
  | 'SLA_PAUSED'
  | 'SLA_RESUMED'
  | 'SLA_WARNING'
  | 'SLA_BREACHED'
  | 'ESCALATED'
  | 'DECISION_RECORDED'
  | 'APPLICATION_HELD'
  | 'APPLICATION_RETURNED'
  | 'APPLICATION_RESUBMITTED'
  | 'APPLICATION_APPROVED'
  | 'APPLICATION_REJECTED'
  | 'COMPENSATION_ELIGIBLE'
  | 'EXTERNAL_UPDATE';

export interface CreateEventParams {
  applicationId: string;
  stageId?: string | null;
  eventType: EventType;
  actorId?: string | null;
  actorRole?: string | null;
  metadata?: Record<string, unknown>;
}

const GENESIS_HASH = '0'.repeat(64);

function sealPayload(evt: {
  applicationId: string;
  stageId: string | null;
  eventType: string;
  actorId: string | null;
  actorRole: string | null;
  seq: number;
  createdAt: Date;
  payload: unknown;
}) {
  return {
    applicationId: evt.applicationId,
    stageId: evt.stageId,
    eventType: evt.eventType,
    actorId: evt.actorId,
    actorRole: evt.actorRole,
    seq: evt.seq,
    createdAt: evt.createdAt.toISOString(),
    payload: evt.payload,
  };
}

export class EventService {
  /**
   * Append an immutable, hash-chained event. Pass the caller's transaction client so the
   * event commits atomically with the state change it describes and the chain can't fork.
   */
  static async record(db: Db, params: CreateEventParams) {
    const { applicationId, stageId = null, eventType, actorId = null, actorRole = null, metadata = {} } = params;

    const last = await db.stageEvent.findFirst({
      where: { applicationId },
      orderBy: [{ seq: 'desc' }, { createdAt: 'desc' }],
      select: { seq: true, chainHash: true, metadataJson: true },
    });

    let prevHash = GENESIS_HASH;
    if (last?.chainHash) {
      prevHash = last.chainHash;
    } else if (last) {
      try {
        prevHash = JSON.parse(last.metadataJson)?.cryptographicSeal?.chainHash || GENESIS_HASH;
      } catch {
        prevHash = GENESIS_HASH;
      }
    }

    const seq = (last?.seq ?? 0) + 1;
    const createdAt = Clock.now();
    // Normalise payload exactly as it will be stored (Dates -> ISO strings, undefined dropped)
    const payload = JSON.parse(JSON.stringify(metadata));
    const seal = SecurityEngine.createEventSeal(
      prevHash,
      sealPayload({ applicationId, stageId, eventType, actorId, actorRole, seq, createdAt, payload }),
      createdAt
    );

    return db.stageEvent.create({
      data: {
        applicationId,
        stageId,
        eventType,
        actorId,
        actorRole,
        seq,
        prevHash,
        chainHash: seal.chainHash,
        createdAt,
        metadataJson: JSON.stringify({ ...payload, cryptographicSeal: seal }),
      },
    });
  }

  /** Back-compat wrapper (outside a transaction). */
  static async recordEvent(params: CreateEventParams) {
    return this.record(prisma, params);
  }

  /**
   * Full chronological timeline (staff view) with cryptographic seal info.
   */
  static async getApplicationTimeline(applicationId: string) {
    const events = await prisma.stageEvent.findMany({
      where: { applicationId },
      orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }],
    });

    return events.map(evt => {
      let parsedMeta: Record<string, unknown> = {};
      try {
        parsedMeta = JSON.parse(evt.metadataJson);
      } catch {
        parsedMeta = { raw: evt.metadataJson };
      }

      return {
        id: evt.id,
        applicationId: evt.applicationId,
        stageId: evt.stageId,
        seq: evt.seq,
        eventType: evt.eventType,
        actorId: evt.actorId,
        actorRole: evt.actorRole,
        timestamp: evt.createdAt,
        metadata: parsedMeta,
        cryptographicSeal: parsedMeta.cryptographicSeal as CryptographicSeal | undefined,
      };
    });
  }

  /**
   * Verify the cryptographic chain. Every sealed event's hash is RECOMPUTED from its stored
   * content, so editing any field (not just the link) is detected.
   */
  static async verifyAuditChain(applicationId: string) {
    const events = await prisma.stageEvent.findMany({
      where: { applicationId },
      orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }],
    });

    if (events.length === 0) {
      return {
        isChainValid: true,
        chainLength: 0,
        algorithm: 'SHA-256',
        message: 'No events found for application',
        verifiedAt: new Date().toISOString(),
      };
    }

    let expectedPrev: string | null = null;
    let sealedCount = 0;
    let legacyCount = 0;

    for (const evt of events) {
      let meta: any;
      try {
        meta = JSON.parse(evt.metadataJson);
      } catch {
        return { isChainValid: false, algorithm: 'SHA-256', compromisedEventId: evt.id, reason: 'Unparseable event metadata (corrupted)' };
      }

      const seal = meta?.cryptographicSeal as CryptographicSeal | undefined;
      if (!seal?.chainHash || evt.seq === 0) {
        // Pre-chain legacy event: cannot be verified, but must not be silently counted as sealed
        legacyCount++;
        if (seal?.chainHash) expectedPrev = seal.chainHash;
        continue;
      }

      if (expectedPrev !== null && seal.prevHash !== expectedPrev) {
        return {
          isChainValid: false,
          algorithm: 'SHA-256',
          compromisedEventId: evt.id,
          reason: 'Broken linkage: prevHash does not match the previous event seal (event inserted or deleted)',
          expectedPrevHash: expectedPrev,
          actualPrevHash: seal.prevHash,
        };
      }

      const { cryptographicSeal: _omit, ...payload } = meta;
      const recomputed = SecurityEngine.computeChainHash(
        seal.prevHash,
        sealPayload({
          applicationId: evt.applicationId,
          stageId: evt.stageId,
          eventType: evt.eventType,
          actorId: evt.actorId,
          actorRole: evt.actorRole,
          seq: evt.seq,
          createdAt: evt.createdAt,
          payload,
        })
      );

      if (recomputed !== seal.chainHash || (evt.chainHash && evt.chainHash !== seal.chainHash)) {
        return {
          isChainValid: false,
          algorithm: 'SHA-256',
          compromisedEventId: evt.id,
          reason: 'Content tampered: recomputed hash does not match the stored seal',
        };
      }

      expectedPrev = seal.chainHash;
      sealedCount++;
    }

    const first = events.find(e => e.chainHash);
    const last = [...events].reverse().find(e => e.chainHash);

    return {
      isChainValid: true,
      chainLength: events.length,
      sealedEvents: sealedCount,
      legacyUnsealedEvents: legacyCount,
      genesisHash: first?.chainHash ?? 'GENESIS',
      headHash: last?.chainHash ?? 'HEAD',
      algorithm: 'SHA-256',
      message:
        legacyCount === 0
          ? 'Audit chain verified: every event hash recomputed and linked correctly'
          : `Audit chain verified for ${sealedCount} sealed events (${legacyCount} legacy events pre-date sealing)`,
      verifiedAt: new Date().toISOString(),
    };
  }
}
