import { prisma } from '../../db/client.js';
import { env } from '../../config/env.js';
import { Clock } from '../../common/clock.js';
import { SecurityEngine } from '../../common/security.js';
import { renderTemplate, type TemplateKey, type TemplateVars } from './notification.templates.js';

type OutboundChannel = 'SMS' | 'WHATSAPP' | 'EMAIL';

export interface SendNotificationParams {
  recipientUserId: string;
  applicationId?: string;
  type: string;
  title: string;
  message: string;
  templateKey?: string;
  channel?: 'SYSTEM' | 'EMAIL' | 'SMS' | 'WHATSAPP';
  metadata?: Record<string, unknown>;
  /** Outbound mock channels in addition to the in-app inbox */
  outbound?: OutboundChannel[];
  smsText?: string;
  emailSubject?: string;
}

/**
 * Notification dispatcher.
 * Every notification lands in the in-app inbox (one row). Outbound SMS / WhatsApp / Email are
 * mocked: each "send" is stored as a NotificationDelivery (masked destination + exact text) and
 * logged, so the demo can show precisely what the citizen would have received.
 */
export class NotificationService {
  static async send(params: SendNotificationParams) {
    const {
      recipientUserId,
      applicationId,
      type,
      title,
      message,
      templateKey,
      channel = 'SYSTEM',
      metadata = {},
      outbound = [],
    } = params;

    const now = Clock.now();
    const notification = await prisma.notification.create({
      data: {
        recipientUserId,
        applicationId,
        type,
        templateKey,
        title,
        message,
        channel,
        metadataJson: JSON.stringify(metadata),
        createdAt: now,
      },
    });

    if (outbound.length > 0) {
      const user = await prisma.user.findUnique({
        where: { id: recipientUserId },
        select: { phone: true, email: true },
      });

      for (const ch of outbound) {
        const isEmail = ch === 'EMAIL';
        const contact = isEmail ? user?.email : user?.phone;
        const destination = isEmail ? SecurityEngine.maskEmail(contact) : SecurityEngine.maskPii(contact);
        const body = isEmail ? message : params.smsText || message.slice(0, 160);

        await prisma.notificationDelivery.create({
          data: {
            notificationId: notification.id,
            channel: ch,
            destination: destination || 'n/a',
            subject: isEmail ? params.emailSubject || title : null,
            body,
            status: contact ? 'DELIVERED_MOCK' : 'SKIPPED_NO_CONTACT',
            createdAt: now,
          },
        });

        if (env.NODE_ENV !== 'test' && contact) {
          console.log(`[MOCK ${ch} -> ${destination}] ${isEmail ? `(${params.emailSubject || title}) ` : ''}${body}`);
        }
      }
    }

    return notification;
  }

  /**
   * Render a plain-language template and send it. Citizens get outbound channels
   * (configurable via NOTIFY_CHANNELS); staff get in-app + email.
   */
  static async notify(
    templateKey: TemplateKey,
    params: { recipientUserId: string; applicationId?: string; vars: TemplateVars; audience?: 'CITIZEN' | 'STAFF'; metadata?: Record<string, unknown> }
  ) {
    const rendered = renderTemplate(templateKey, params.vars);
    const outbound: OutboundChannel[] = params.audience === 'STAFF' ? ['EMAIL'] : env.NOTIFY_CHANNEL_LIST;
    return this.send({
      recipientUserId: params.recipientUserId,
      applicationId: params.applicationId,
      type: rendered.type,
      templateKey,
      title: rendered.title,
      message: rendered.message,
      smsText: rendered.sms,
      emailSubject: rendered.emailSubject,
      outbound,
      metadata: params.metadata,
    });
  }

  /** Notify every officer of a department (e.g. "new file in your queue"). */
  static async notifyDepartment(departmentCode: string, templateKey: TemplateKey, applicationId: string, vars: TemplateVars) {
    const officers = await prisma.user.findMany({
      where: { role: 'OFFICER', department: { code: departmentCode } },
      select: { id: true },
    });
    for (const o of officers) {
      await this.notify(templateKey, { recipientUserId: o.id, applicationId, vars, audience: 'STAFF' });
    }
    return officers.length;
  }

  static async notifySupervisors(templateKey: TemplateKey, applicationId: string, vars: TemplateVars) {
    const sups = await prisma.user.findMany({ where: { role: 'SUPERVISOR' }, select: { id: true } });
    for (const s of sups) {
      await this.notify(templateKey, { recipientUserId: s.id, applicationId, vars, audience: 'STAFF' });
    }
    return sups.length;
  }

  static async getUserNotifications(userId: string) {
    return prisma.notification.findMany({
      where: { recipientUserId: userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { deliveries: { select: { channel: true, destination: true, status: true, body: true } } },
    });
  }

  static async markAsRead(notificationId: string, userId: string) {
    return prisma.notification.updateMany({
      where: { id: notificationId, recipientUserId: userId },
      data: { isRead: true },
    });
  }

  /** Recent mocked outbound messages (demo "outbox" for supervisors). */
  static async getOutbox(params: { applicationId?: string; channel?: string; limit?: number }) {
    return prisma.notificationDelivery.findMany({
      where: {
        ...(params.channel ? { channel: params.channel } : {}),
        ...(params.applicationId ? { notification: { applicationId: params.applicationId } } : {}),
      },
      include: { notification: { select: { applicationId: true, type: true, title: true, recipientUserId: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(params.limit ?? 50, 200),
    });
  }
}
