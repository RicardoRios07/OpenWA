import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';
import { ImportDataDto } from './import-data.dto';
import { TABLE_IMPORTERS } from '../table-importers';

// The REAL pipe, built from the SAME options object production uses — not a restatement of them.
// This spec exists because a regression reached main through a layer nothing exercised: the
// round-trip specs call the handler directly and never touch validation at all. Reproducing the
// pipe's options by hand would have repeated that mistake one level up, asserting against a mirror
// that can drift from what the app actually installs.
//
// Two behaviours only the pipe has: `toEmptyIfNil` turns a null/undefined body into `{}` before
// validation, and refusals arrive as a BadRequestException whose `message` is the string array a
// client actually receives. Neither is visible through plainToInstance + validate.
const pipe = new ValidationPipe(GLOBAL_VALIDATION_OPTIONS);
const BODY = { type: 'body' as const, metatype: ImportDataDto };

/** Push a payload through the pipe. `errors` holds the messages a client would receive. */
async function run(payload: unknown): Promise<{ instance: ImportDataDto; errors: string[] }> {
  try {
    return { instance: (await pipe.transform(payload, BODY)) as ImportDataDto, errors: [] };
  } catch (error) {
    const body = (error as BadRequestException).getResponse() as { message?: string | string[] };
    return { instance: {} as ImportDataDto, errors: [body.message ?? []].flat() };
  }
}

/** A minimal but complete payload: every table the importer registry knows, each empty. */
function fullTables(): Record<string, unknown[]> {
  return Object.fromEntries(TABLE_IMPORTERS.map(importer => [importer.key, []]));
}

/** Top-level property names of a published schema, read from the committed contract. */
function publishedProperties(schema: string): string[] {
  const snapshot = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'openapi.json'), 'utf8')) as {
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };
  return Object.keys(snapshot.components.schemas[schema]?.properties ?? {});
}

/** The export file exactly as GET /api/infra/export-data returns it, tables filled in. */
function exportEnvelope(): Record<string, unknown> {
  return {
    exportedAt: '2026-08-12T00:00:00.000Z',
    dataDbType: 'sqlite',
    tables: { ...fullTables(), sessions: [{ id: 's1', name: 'main' }] },
    counts: { sessions: 1 },
    skippedTables: [],
    omittedInlineMedia: { messages: 0, messageBatches: 0 },
  };
}

describe('ImportDataDto', () => {
  it('rejects a body with no tables, naming the field', async () => {
    const { errors } = await run({ force: true });
    // Before this DTO the inline `@Body()` type erased, so this body reached the restore and threw
    // from inside it — a 500 on the replace-all route, with nothing pointing at the missing field.
    // Asserted on the field name the client is handed, not the sentence around it.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('tables');
  });

  it('rejects an unknown key', async () => {
    const { errors } = await run({ tables: fullTables(), stopOrphan: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('stopOrphan');
  });

  it('accepts the export file posted back verbatim', async () => {
    // docs/14 tells the operator to post the whole backup (`-d @data-backup.json`), and the export
    // wraps `tables` in five metadata fields. When this DTO named only `tables`, forbidNonWhitelisted
    // rejected all five and the documented restore answered 400 — a bare "Bad Request" in production,
    // where field-level detail is suppressed. Nothing caught it: the round-trip specs call
    // controller.importData({ tables }) directly and never reach the pipe.
    const { instance, errors } = await run(exportEnvelope());
    expect(errors).toEqual([]);
    expect(Object.keys(instance.tables as object)).toHaveLength(TABLE_IMPORTERS.length);
  });

  it('accepts every top-level field the export publishes', async () => {
    // The real gate: bind the accepted set to the export contract instead of trusting that whoever
    // adds a field to the export remembers this file. A new export field fails here, naming itself,
    // rather than 400ing an operator's restore.
    //
    // It probes ACCEPTANCE, one field at a time, rather than comparing the two published schemas.
    // Publication and acceptance are different mechanisms — @ApiPropertyOptional puts a field in the
    // contract, @Allow is what makes forbidNonWhitelisted admit it — so a field carrying only the
    // former would pass a schema-to-schema comparison while still 400ing the restore.
    const exported = publishedProperties('InfraExportDataResponseDto');
    expect(exported.length).toBeGreaterThanOrEqual(6); // non-vacuous: the contract was really read
    const rejected: string[] = [];
    for (const field of exported) {
      if (field === 'tables') continue; // carries its own constraints, covered above
      const { errors } = await run({ tables: fullTables(), [field]: exportEnvelope()[field] });
      if (errors.length) rejected.push(field);
    }
    expect(rejected).toEqual([]);
  });

  it('accepts a valid body and leaves every table array intact', async () => {
    // Load-bearing: whitelist strips undecorated properties from the object it validates, and every
    // table key omitted from a restore is written EMPTY. If validation reached inside `tables`, a
    // restore would silently blank the database instead of restoring it.
    const tables = { ...fullTables(), sessions: [{ id: 's1', name: 'main' }], messages: [{ id: 'm1' }] };
    const { instance, errors } = await run({ tables, force: false, stopOrphans: false });
    expect(errors).toEqual([]);
    expect(instance.tables).toEqual(tables);
    expect(Object.keys(instance.tables as object)).toHaveLength(TABLE_IMPORTERS.length);
  });

  it.each(['force', 'stopOrphans'] as const)("maps a form-encoded 'false' on %s to a real false", async flag => {
    // Both flags only ever OPEN the escape from the orphan-engine refusal. Under implicit conversion
    // a plain boolean property casts 'false' to true, which would open that escape for a caller who
    // spelled the opposite — the one direction this change must not introduce.
    const { instance, errors } = await run({ tables: fullTables(), [flag]: 'false' });
    expect(errors).toEqual([]);
    expect(instance[flag]).toBe(false);
  });

  it.each(['force', 'stopOrphans'] as const)('rejects an ambiguous spelling on %s', async flag => {
    const { errors } = await run({ tables: fullTables(), [flag]: 'yes' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(flag);
  });

  it('turns a null body into a refusal rather than a crash', async () => {
    // Only the pipe does this: `toEmptyIfNil` replaces a null/undefined body with `{}` before
    // validation, so the route answers 400 on the missing `tables` instead of dereferencing null
    // somewhere downstream. A spec that mirrored the options instead of running the pipe could not
    // see this path at all.
    for (const body of [null, undefined]) {
      const { errors } = await run(body);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('tables');
    }
  });

  it('leaves an omitted flag absent, so the default orphan refusal still applies', async () => {
    const { instance, errors } = await run({ tables: fullTables() });
    expect(errors).toEqual([]);
    expect(instance.force).toBeUndefined();
    expect(instance.stopOrphans).toBeUndefined();
  });
});
