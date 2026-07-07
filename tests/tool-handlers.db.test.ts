// DB-backed tool-handler tests (guide Phase 11 "Tool handlers" row).
// Runs against the real Neon database from .env — skipped automatically when
// DATABASE_URL is absent (e.g. CI without the secret). All rows created here
// are tagged with a unique test prefix and deleted in afterAll.

import "dotenv/config";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// Unique per run so parallel/aborted runs never collide.
const RUN = crypto.randomUUID().slice(0, 8);
const LAST_NAME = `ZzTest${RUN}`;
const callId = (n: string) => `test-${RUN}-${n}`;

// next Sunday (NV PSG capacity = 3) — always in the future
function nextSunday(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7 || 7));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

describe.skipIf(!HAS_DB)("tool handlers against Neon", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let handlers: Record<string, (args: any, vapiCallId: string) => Promise<any>>;
  let db: any;
  let schema: any;
  let eq: any, like: any, inArray: any;
  const patientIds: string[] = [];

  beforeAll(async () => {
    ({ TOOL_HANDLERS: handlers } = await import("@/vapi/tools/handlers"));
    const dbmod = await import("@/db");
    db = dbmod.db;
    schema = dbmod.schema;
    ({ eq, like, inArray } = await import("drizzle-orm"));
  });

  afterAll(async () => {
    if (!HAS_DB || patientIds.length === 0) return;
    await db().delete(schema.notes).where(like(schema.notes.vapiCallId, `test-${RUN}-%`));
    await db().delete(schema.toolExecutions).where(like(schema.toolExecutions.vapiCallId, `test-${RUN}-%`));
    await db().delete(schema.flags).where(inArray(schema.flags.patientId, patientIds));
    await db().delete(schema.outboundQueue).where(inArray(schema.outboundQueue.patientId, patientIds));
    await db().delete(schema.appointments).where(inArray(schema.appointments.patientId, patientIds));
    await db().delete(schema.patients).where(eq(schema.patients.lastName, LAST_NAME));
  });

  async function recordExecution(vapiCallId: string, toolName: string, result: unknown) {
    // Mimic the webhook route: the checklist derives from tool_executions rows.
    await db().insert(schema.toolExecutions).values({
      vapiCallId,
      toolCallId: `tc-${RUN}-${toolName}-${vapiCallId}`,
      toolName,
      result,
      status: "ok",
    });
  }

  it("book_appointment refuses when checklist incomplete (spec §3.4)", async () => {
    const cid = callId("refusal");
    const identity = await handlers.identify_patient(
      { firstName: "Alice", lastName: LAST_NAME, dob: "1980-01-01", callbackNumber: "+17025550001" },
      cid,
    );
    patientIds.push(identity.patientId);
    await recordExecution(cid, "identify_patient", identity);

    const result = await handlers.book_appointment(
      { patientId: identity.patientId, slotId: `psg|NV|${nextSunday().toISOString().replace("00:00:00", "20:30:00")}` },
      cid,
    );
    expect(result.booked).toBe(false);
    expect(result.refused).toBe(true);
    expect(result.missingSteps.join(" ")).toMatch(/check_insurance/);
  });

  it("HMO patient is blocked from booking (spec §3.4.2)", async () => {
    const cid = callId("hmo");
    const identity = await handlers.identify_patient(
      { firstName: "Harry", lastName: LAST_NAME, dob: "1975-05-05", callbackNumber: "+17025550002" },
      cid,
    );
    patientIds.push(identity.patientId);
    await db()
      .update(schema.patients)
      .set({
        insuranceStatus: "active",
        isHmo: true,
        email: "h@test.invalid",
        address: "1 Test St",
        insurancePayer: "TestHMO",
      })
      .where(eq(schema.patients.id, identity.patientId));

    await recordExecution(cid, "identify_patient", { ...identity, missingDemographics: [] });
    const insurance = await handlers.check_insurance({ patientId: identity.patientId }, cid);
    expect(insurance.isHmo).toBe(true);
    expect(insurance.guidance).toMatch(/HMO/);
    await recordExecution(cid, "check_insurance", insurance);

    const result = await handlers.book_appointment(
      { patientId: identity.patientId, slotId: `psg|NV|${nextSunday().toISOString().replace("00:00:00", "20:30:00")}` },
      cid,
    );
    expect(result.booked).toBe(false);
    expect(result.missingSteps.join(" ")).toMatch(/HMO/);
  });

  it("happy path: verified Medicare patient books PSG; note + appointment rows land", async () => {
    const cid = callId("happy");
    const identity = await handlers.identify_patient(
      { firstName: "Mary", lastName: LAST_NAME, dob: "1960-03-03", callbackNumber: "+17025550003" },
      cid,
    );
    patientIds.push(identity.patientId);
    await db()
      .update(schema.patients)
      .set({
        insuranceStatus: "active",
        isHmo: false,
        isMedicare: true,
        referralOnFile: true,
        email: "m@test.invalid",
        address: "2 Test St",
        insurancePayer: "Medicare",
      })
      .where(eq(schema.patients.id, identity.patientId));
    await recordExecution(cid, "identify_patient", { ...identity, missingDemographics: [] });

    const insurance = await handlers.check_insurance({ patientId: identity.patientId }, cid);
    expect(insurance.active).toBe(true);
    await recordExecution(cid, "check_insurance", insurance);

    const auth = await handlers.verify_study_auth(
      { patientId: identity.patientId, studyType: "psg" },
      cid,
    );
    expect(auth.authorized).toBe(true);
    expect(auth.source).toBe("medicare_exempt");
    await recordExecution(cid, "verify_study_auth", auth);

    const slots = await handlers.find_slots({ appointmentType: "psg", location: "NV" }, cid);
    expect(slots.slots.length).toBeGreaterThan(0);

    const booking = await handlers.book_appointment(
      { patientId: identity.patientId, slotId: slots.slots[0].slotId },
      cid,
    );
    expect(booking.booked).toBe(true);
    expect(booking.prepInstructions).toMatch(/shower/i);

    const [appt] = await db()
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, booking.appointmentId));
    expect(appt).toBeDefined();
    expect(appt.type).toBe("psg");

    const notes = await db().select().from(schema.notes).where(eq(schema.notes.vapiCallId, cid));
    expect(notes.length).toBeGreaterThan(0);
  });

  it("cancel_appointment inserts ~1-week follow-up queue row (spec §3.2)", async () => {
    const cid = callId("cancel");
    // Mary (happy path) has an upcoming appointment.
    const [mary] = await db()
      .select()
      .from(schema.patients)
      .where(eq(schema.patients.firstName, "Mary"))
      .then((rows: any[]) => rows.filter((r) => r.lastName === LAST_NAME));
    expect(mary).toBeDefined();

    const result = await handlers.cancel_appointment(
      { patientId: mary.id, reason: "test cancellation" },
      cid,
    );
    expect(result.cancelled).toBe(true);
    expect(result.followUpQueued).toBe(true);

    const queueRows = await db()
      .select()
      .from(schema.outboundQueue)
      .where(eq(schema.outboundQueue.patientId, mary.id));
    expect(queueRows.length).toBe(1);
    expect(queueRows[0].workstream).toBe("follow_up");
    const days = (queueRows[0].nextAttemptAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(8);
  });

  it("capacity: 4th PSG on an NV Sunday is refused (cap 3)", async () => {
    const cid = callId("capacity");
    const identity = await handlers.identify_patient(
      { firstName: "Carl", lastName: LAST_NAME, dob: "1955-07-07", callbackNumber: "+17025550004" },
      cid,
    );
    patientIds.push(identity.patientId);
    await db()
      .update(schema.patients)
      .set({
        insuranceStatus: "active",
        isHmo: false,
        isMedicare: true,
        referralOnFile: true,
        email: "c@test.invalid",
        address: "3 Test St",
        insurancePayer: "Medicare",
      })
      .where(eq(schema.patients.id, identity.patientId));
    await recordExecution(cid, "identify_patient", { ...identity, missingDemographics: [] });
    await recordExecution(cid, "check_insurance", await handlers.check_insurance({ patientId: identity.patientId }, cid));
    await recordExecution(
      cid,
      "verify_study_auth",
      await handlers.verify_study_auth({ patientId: identity.patientId, studyType: "psg" }, cid),
    );

    // Fill Sunday NV to capacity (3) directly.
    const sunday = nextSunday();
    const at = (hhmm: string) => new Date(`${sunday.toISOString().slice(0, 10)}T${hhmm}:00Z`);
    for (const t of ["20:30", "21:00", "21:30"]) {
      await db().insert(schema.appointments).values({
        patientId: identity.patientId,
        type: "psg",
        location: "NV",
        startsAt: at(t),
        endsAt: new Date(at(t).getTime() + 30 * 60_000),
      });
    }

    const result = await handlers.book_appointment(
      { patientId: identity.patientId, slotId: `psg|NV|${at("21:00").toISOString()}` },
      cid,
    );
    expect(result.booked).toBe(false);
    expect(result.reason).toMatch(/capacity/i);
  });
});
