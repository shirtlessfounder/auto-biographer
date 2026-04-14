import { z } from 'zod';

const NonEmptyStringSchema = z.string().trim().min(1);
const NullableUrlSchema = z.union([z.url(), z.null()]);
const PositiveIntegerSchema = z.number().int().positive();

export const HermesSkipPayloadSchema = z
  .object({
    decision: z.literal('skip'),
    reason: NonEmptyStringSchema,
  })
  .strict();

export const HermesSelectorPayloadSchema = z
  .object({
    decision: z.literal('select'),
    candidate_type: NonEmptyStringSchema,
    angle: NonEmptyStringSchema,
    why_interesting: NonEmptyStringSchema,
    source_event_ids: z.array(PositiveIntegerSchema).min(1),
    artifact_ids: z.array(PositiveIntegerSchema),
    primary_anchor: NonEmptyStringSchema,
    supporting_points: z.array(NonEmptyStringSchema).min(1),
    quote_target: NullableUrlSchema,
    suggested_media_kind: z.union([NonEmptyStringSchema, z.null()]),
    suggested_media_request: z.union([NonEmptyStringSchema, z.null()]),
  })
  .strict();

export const HermesDrafterPayloadSchema = z
  .object({
    decision: z.literal('success'),
    delivery_kind: z.literal('single_post'),
    draft_text: NonEmptyStringSchema,
    candidate_type: NonEmptyStringSchema,
    quote_target_url: NullableUrlSchema,
    why_chosen: NonEmptyStringSchema,
    receipts: z.array(NonEmptyStringSchema).min(1),
    media_request: z.union([NonEmptyStringSchema, z.null()]),
    allowed_commands: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();

export const HermesSelectorResultSchema = z.discriminatedUnion('decision', [
  HermesSkipPayloadSchema,
  HermesSelectorPayloadSchema,
]);

export const HermesDrafterResultSchema = z.union([
  HermesSkipPayloadSchema,
  HermesDrafterPayloadSchema,
]);

export type HermesSkipPayload = z.infer<typeof HermesSkipPayloadSchema>;
export type HermesSelectorPayload = z.infer<typeof HermesSelectorPayloadSchema>;
export type HermesDrafterPayload = z.infer<typeof HermesDrafterPayloadSchema>;
export type HermesSelectorResult = z.infer<typeof HermesSelectorResultSchema>;
export type HermesDrafterResult = z.infer<typeof HermesDrafterResultSchema>;

export type HermesPayloadKind = 'selector' | 'drafter';

type HermesPayloadByKind = {
  selector: HermesSelectorResult;
  drafter: HermesDrafterResult;
};

const HermesPayloadSchemaByKind: {
  [Key in HermesPayloadKind]: z.ZodType<HermesPayloadByKind[Key]>;
} = {
  selector: HermesSelectorResultSchema,
  drafter: HermesDrafterResultSchema,
};

export function parseHermesPayload<Kind extends HermesPayloadKind>(
  kind: Kind,
  payload: unknown,
): HermesPayloadByKind[Kind] {
  return HermesPayloadSchemaByKind[kind].parse(payload);
}
