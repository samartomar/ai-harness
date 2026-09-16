import { z } from "zod";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(240);

/** Historical reading material only; never an input to policy or evidence acceptance. */
export const WorkbenchReferenceReportV1Schema = z
  .object({
    kind: z.literal("previous-catalog-report"),
    authority: z.literal("none"),
    assetId: id,
    subject: z
      .object({ assetId: id, sourceId: id, sourceRevisionId: id, contentDigest: digest })
      .strict(),
    previousSourceContentDigest: digest,
    currentSourceContentDigest: digest,
    componentTreeDigest: digest,
    coveredPaths: z.array(z.string().min(1).max(1_000)).min(1).max(10_000),
    reportSignedAt: z.string().datetime(),
    publishedAt: z.string().datetime(),
    validUntil: z.string().datetime(),
    outcome: z.enum(["pass", "failed"]),
    analyzers: z
      .array(
        z
          .object({ name: z.string().min(1).max(240), version: z.string().min(1).max(240) })
          .strict(),
      )
      .max(100),
    findings: z.array(z.string().max(1_000)).max(50),
    publicationUrl: z
      .string()
      .regex(
        /^https:\/\/github\.com\/samartomar\/aih-scan\/releases\/download\/baseline-v1-[a-f0-9]{40}-[a-f0-9]{64}\/publication\.json$/,
      ),
    publicationDigest: digest,
    recordDigest: digest,
  })
  .strict();

export const WorkbenchReferenceReportsV1Schema = z
  .record(id, WorkbenchReferenceReportV1Schema)
  .superRefine((reports, ctx) => {
    if (Object.keys(reports).length > 1_000)
      ctx.addIssue({ code: "custom", message: "Too many previous reports." });
    for (const [key, report] of Object.entries(reports)) {
      if (
        key !== report.assetId ||
        key !== report.subject.assetId ||
        report.previousSourceContentDigest === report.currentSourceContentDigest
      )
        ctx.addIssue({ code: "custom", message: "Previous report identity mismatch." });
    }
  });

export type WorkbenchReferenceReportV1 = z.infer<typeof WorkbenchReferenceReportV1Schema>;
export type WorkbenchReferenceReportsV1 = z.infer<typeof WorkbenchReferenceReportsV1Schema>;
