import type { Db } from './pool.ts';

/** Постоянные части КП: вёрстка живёт в шаблоне, здесь только значения. */
export interface KpConstants {
  sellerName?: string;
  sellerRequisites?: string;
  vatRate?: number;
  paymentTerms?: string;
  warranty?: string;
  delivery?: string;
  validDays?: number;
  coverLetter?: string;
  signature?: string;
}

export interface KpNumbering {
  prefix: string;
  year: number | null;
  counter: number;
}

export interface KpSettings {
  accountId: number;
  templatePath: string | null;
  templateName: string | null;
  templateMd5: string | null;
  templateUpdatedAt: Date | null;
  constants: KpConstants;
  certsDir: string | null;
  numbering: KpNumbering;
}

export type KpDraftStatus = 'draft' | 'built' | 'sent' | 'cancelled';

export interface KpDraft {
  id: number;
  accountId: number;
  leadId: number;
  status: KpDraftStatus;
  payload: Record<string, unknown>;
  docxPath: string | null;
  pdfPath: string | null;
  kpNo: string | null;
  createdAt: Date;
  builtAt: Date | null;
  sentAt: Date | null;
}

const DEFAULT_NUMBERING: KpNumbering = { prefix: 'КП', year: null, counter: 0 };

export class KpRepo {
  constructor(private readonly db: Db) {}

  async getSettings(accountId: number): Promise<KpSettings> {
    const { rows } = await this.db.query(
      `SELECT account_id, template_path, template_name, template_md5, template_updated_at,
              constants, certs_dir, numbering
         FROM kp_settings WHERE account_id = $1`,
      [accountId],
    );
    const r = rows[0];
    if (!r) {
      return {
        accountId,
        templatePath: null,
        templateName: null,
        templateMd5: null,
        templateUpdatedAt: null,
        constants: {},
        certsDir: null,
        numbering: { ...DEFAULT_NUMBERING },
      };
    }
    return {
      accountId,
      templatePath: r.template_path,
      templateName: r.template_name,
      templateMd5: r.template_md5,
      templateUpdatedAt: r.template_updated_at,
      constants: (r.constants ?? {}) as KpConstants,
      certsDir: r.certs_dir,
      numbering: { ...DEFAULT_NUMBERING, ...((r.numbering ?? {}) as Partial<KpNumbering>) },
    };
  }

  /** Частичное сохранение: пустые поля не затирают уже заданные. */
  async saveSettings(
    accountId: number,
    patch: { constants?: KpConstants; certsDir?: string | null; numbering?: Partial<KpNumbering> },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO kp_settings (account_id, constants, certs_dir, numbering, updated_at)
       VALUES ($1, COALESCE($2::jsonb, '{}'::jsonb), $3, COALESCE($4::jsonb, $5::jsonb), now())
       ON CONFLICT (account_id) DO UPDATE SET
         constants = COALESCE($2::jsonb, kp_settings.constants),
         certs_dir = COALESCE($3, kp_settings.certs_dir),
         numbering = kp_settings.numbering || COALESCE($4::jsonb, '{}'::jsonb),
         updated_at = now()`,
      [
        accountId,
        patch.constants ? JSON.stringify(patch.constants) : null,
        patch.certsDir ?? null,
        patch.numbering ? JSON.stringify(patch.numbering) : null,
        JSON.stringify(DEFAULT_NUMBERING),
      ],
    );
  }

  async setTemplate(
    accountId: number,
    t: { path: string; name: string; md5: string },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO kp_settings (account_id, template_path, template_name, template_md5, template_updated_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (account_id) DO UPDATE SET
         template_path = $2, template_name = $3, template_md5 = $4,
         template_updated_at = now(), updated_at = now()`,
      [accountId, t.path, t.name, t.md5],
    );
  }

  /**
   * Следующий номер КП: счётчик сбрасывается в новом году.
   * Выдаётся одним запросом, чтобы два менеджера не получили один номер.
   */
  async nextNumber(accountId: number, now = new Date()): Promise<string> {
    const year = now.getUTCFullYear();
    const { rows } = await this.db.query(
      `INSERT INTO kp_settings (account_id, numbering, updated_at)
       VALUES ($1, jsonb_build_object('prefix', 'КП', 'year', $2::int, 'counter', 1), now())
       ON CONFLICT (account_id) DO UPDATE SET
         numbering = kp_settings.numbering
           || jsonb_build_object('year', $2::int)
           || jsonb_build_object(
                'counter',
                CASE WHEN (kp_settings.numbering->>'year')::int IS DISTINCT FROM $2::int
                     THEN 1
                     ELSE COALESCE((kp_settings.numbering->>'counter')::int, 0) + 1 END),
         updated_at = now()
       RETURNING numbering`,
      [accountId, year],
    );
    const n = (rows[0]?.numbering ?? DEFAULT_NUMBERING) as KpNumbering;
    return `${n.prefix || 'КП'}-${year}-${n.counter}`;
  }

  async createDraft(
    accountId: number,
    leadId: number,
    payload: Record<string, unknown>,
    createdBy: number | null,
  ): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO kp_drafts (account_id, lead_id, payload, created_by)
       VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
      [accountId, leadId, JSON.stringify(payload), createdBy],
    );
    return Number(rows[0]?.id ?? 0);
  }

  async latestByLead(accountId: number, leadId: number): Promise<KpDraft | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM kp_drafts
         WHERE account_id = $1 AND lead_id = $2 AND status <> 'cancelled'
         ORDER BY created_at DESC LIMIT 1`,
      [accountId, leadId],
    );
    return rows[0] ? mapDraft(rows[0]) : null;
  }

  async byId(accountId: number, id: number): Promise<KpDraft | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM kp_drafts WHERE account_id = $1 AND id = $2',
      [accountId, id],
    );
    return rows[0] ? mapDraft(rows[0]) : null;
  }

  async setPayload(id: number, payload: Record<string, unknown>): Promise<void> {
    await this.db.query('UPDATE kp_drafts SET payload = $2::jsonb WHERE id = $1', [
      id,
      JSON.stringify(payload),
    ]);
  }

  async setBuilt(
    id: number,
    b: { docxPath: string; pdfPath: string | null; kpNo: string },
  ): Promise<void> {
    await this.db.query(
      `UPDATE kp_drafts
          SET status = 'built', docx_path = $2, pdf_path = $3,
              kp_no = COALESCE(kp_no, $4), built_at = now()
        WHERE id = $1`,
      [id, b.docxPath, b.pdfPath, b.kpNo],
    );
  }

  async setStatus(id: number, status: KpDraftStatus): Promise<void> {
    await this.db.query(
      `UPDATE kp_drafts
          SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
        WHERE id = $1`,
      [id, status],
    );
  }
}

function mapDraft(r: Record<string, unknown>): KpDraft {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    leadId: Number(r.lead_id),
    status: r.status as KpDraftStatus,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    docxPath: (r.docx_path ?? null) as string | null,
    pdfPath: (r.pdf_path ?? null) as string | null,
    kpNo: (r.kp_no ?? null) as string | null,
    createdAt: r.created_at as Date,
    builtAt: (r.built_at ?? null) as Date | null,
    sentAt: (r.sent_at ?? null) as Date | null,
  };
}
