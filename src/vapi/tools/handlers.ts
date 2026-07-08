// Tool handlers: dispatched from the webhook route. Every handler returns a
// JSON-serializable object that becomes the tool result the assistant reads.
// Business errors are returned inside the result (never thrown to a non-200).

import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { attemptCapFor } from "@/core/attempts";
import {
  findSlots,
  parseSlotId,
  validateBooking,
  type BookedAppointment,
} from "@/core/scheduling/engine";
import {
  capacityGroupFor,
  getPrepScript,
  type AppointmentType,
  type AvailabilityRule,
  type LocationCode,
} from "@/core/scheduling/rules";
import { routeTopic } from "@/core/routing";
import { decideHandoff } from "@/core/escalation";
import { canBook, type ToolExecutionRecord } from "@/core/verification";
import { getPorts } from "@/ports";

type Args = Record<string, unknown>;
type ToolResult = Record<string, unknown>;
/** Live-call context: controlUrl lets a handler act on the call (e.g. transfer). */
export interface CallContext {
  controlUrl?: string;
  callType?: string;
}
type Handler = (args: Args, vapiCallId: string, ctx?: CallContext) => Promise<ToolResult>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function loadRules(
  type: AppointmentType,
  location?: LocationCode,
): Promise<AvailabilityRule[]> {
  const rows = await db()
    .select()
    .from(schema.availabilityRules)
    .where(
      and(
        eq(schema.availabilityRules.appointmentType, type),
        eq(schema.availabilityRules.active, true),
        ...(location ? [eq(schema.availabilityRules.location, location)] : []),
      ),
    );
  return rows.map((r) => ({
    appointmentType: r.appointmentType as AppointmentType,
    location: r.location as LocationCode,
    dayOfWeek: r.dayOfWeek,
    windowStart: r.windowStart.slice(0, 5),
    windowEnd: r.windowEnd.slice(0, 5),
    capacityPerDay: r.capacityPerDay,
    slotMinutes: r.slotMinutes,
    active: r.active,
  }));
}

async function loadBooked(
  type: AppointmentType,
  from: Date,
): Promise<BookedAppointment[]> {
  const group = capacityGroupFor(type);
  const rows = await db()
    .select({
      type: schema.appointments.type,
      location: schema.appointments.location,
      startsAt: schema.appointments.startsAt,
    })
    .from(schema.appointments)
    .where(
      and(
        inArray(schema.appointments.type, group),
        gte(schema.appointments.startsAt, from),
        inArray(schema.appointments.status, ["booked", "confirmed", "rescheduled"]),
      ),
    );
  return rows.map((r) => ({
    type: r.type as AppointmentType,
    location: r.location as LocationCode,
    startsAt: r.startsAt,
  }));
}

async function executionsForCall(vapiCallId: string): Promise<ToolExecutionRecord[]> {
  const rows = await db()
    .select()
    .from(schema.toolExecutions)
    .where(eq(schema.toolExecutions.vapiCallId, vapiCallId))
    .orderBy(asc(schema.toolExecutions.createdAt));
  return rows.map((r) => ({
    toolName: r.toolName,
    result: r.result,
    status: r.status as "ok" | "error",
  }));
}

async function writeNote(
  patientId: string | null,
  vapiCallId: string,
  body: string,
): Promise<void> {
  if (patientId) {
    await getPorts().ehr.pushNote({
      patientId,
      vapiCallId,
      body,
      agentTag: "voice-agent",
    });
  } else {
    await db().insert(schema.notes).values({ vapiCallId, body });
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

const identify_patient: Handler = async (args) => {
  const firstName = str(args.firstName);
  const lastName = str(args.lastName);
  const dob = str(args.dob);
  const callbackNumber = str(args.callbackNumber);
  if (!firstName || !lastName || !dob) {
    return { error: "firstName, lastName, and dob are required" };
  }

  const candidates = await db()
    .select()
    .from(schema.patients)
    .where(and(eq(schema.patients.dob, dob)));
  const match = candidates.find(
    (p) =>
      p.firstName.toLowerCase() === firstName.toLowerCase() &&
      p.lastName.toLowerCase() === lastName.toLowerCase(),
  );

  const patient =
    match ??
    (
      await db()
        .insert(schema.patients)
        .values({ firstName, lastName, dob, phone: callbackNumber })
        .returning()
    )[0];

  if (!match && callbackNumber == null) {
    // brand-new shell record with no phone — still identified, but flag gap
  }

  const missingDemographics = (
    [
      ["email", patient.email],
      ["phone", patient.phone ?? callbackNumber],
      ["address", patient.address],
      ["insurance", patient.insurancePayer],
    ] as const
  )
    .filter(([, v]) => v == null)
    .map(([k]) => k);

  return {
    patientId: patient.id,
    knownPatient: Boolean(match),
    missingDemographics,
    note: missingDemographics.length
      ? `Missing on file: ${missingDemographics.join(", ")}. Do not book until obtained (spec §3.4.5) — collect what the caller can provide now.`
      : "Record complete.",
  };
};

const check_insurance: Handler = async (args) => {
  const patientId = str(args.patientId);
  if (!patientId) return { error: "patientId required" };
  const result = await getPorts().eligibility.checkInsurance(patientId);
  return {
    ...result,
    guidance: !result.verified
      ? "Insurance could not be verified right now. Do NOT book. Capture details and escalate_to_staff."
      : result.isHmo
        ? "HMO plan: a PCP/insurer referral is required before booking. Do NOT book; explain and escalate_to_staff with reason callback."
        : result.active
          ? "Insurance verified active."
          : "Insurance is not active. Do NOT book; the caller may self-pay or resolve coverage first.",
  };
};

const verify_study_auth: Handler = async (args) => {
  const patientId = str(args.patientId);
  const studyType = str(args.studyType);
  if (!patientId || !studyType) return { error: "patientId and studyType required" };
  const result = await getPorts().ehr.checkStudyAuth(patientId, studyType);
  return {
    ...result,
    guidance: result.authorized
      ? result.source === "medicare_exempt"
        ? "Medicare — no authorization needed."
        : "Active authorization on file."
      : "No active authorization. Do NOT schedule this study; escalate_to_staff with reason auth.",
  };
};

const find_slots: Handler = async (args) => {
  const type = str(args.appointmentType) as AppointmentType | null;
  if (!type) return { error: "appointmentType required" };
  const location = (str(args.location) ?? undefined) as LocationCode | undefined;
  const fromDate = str(args.fromDate);

  const from = fromDate ? new Date(`${fromDate}T00:00:00Z`) : new Date(Date.now() + 24 * 3600_000);
  const to = new Date(from.getTime() + 21 * 24 * 3600_000);

  const rules = await loadRules(type, location);
  if (rules.length === 0) {
    return {
      slots: [],
      message:
        "No bookable availability is configured for this appointment type yet. Do not offer times. Apologize and escalate_to_staff with reason callback, capturing the patient's preferred days.",
    };
  }
  const booked = await loadBooked(type, from);
  const slots = findSlots({ type, location, from, to, rules, booked, limit: 3 });
  return {
    slots: slots.map((s) => ({
      slotId: s.slotId,
      location: s.location,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      spoken: `${s.startsAt.toUTCString().slice(0, 22)} at our ${s.location === "NV" ? "Henderson" : "Summerlin"} office`,
    })),
    message: slots.length === 0 ? "No open slots in the next 3 weeks." : undefined,
  };
};

const book_appointment: Handler = async (args, vapiCallId) => {
  const patientId = str(args.patientId);
  const slotId = str(args.slotId);
  if (!patientId || !slotId) return { error: "patientId and slotId required" };

  const slot = parseSlotId(slotId);
  if (!slot) return { error: "Invalid slotId — use a slotId exactly as returned by find_slots" };

  // Checklist enforced in code (spec §3.4): derived from THIS call's tool runs.
  const gate = canBook(slot.type, await executionsForCall(vapiCallId));
  if (!gate.allowed) {
    return { booked: false, refused: true, reason: gate.reason, missingSteps: gate.missingSteps };
  }

  // Race-safe: re-validate against current bookings just before insert.
  const rules = await loadRules(slot.type, slot.location);
  const booked = await loadBooked(slot.type, new Date(slot.startsAt.getTime() - 24 * 3600_000));
  const validation = validateBooking(slot, rules, booked);
  if (!validation.ok) {
    return { booked: false, refused: true, reason: validation.violation, suggestion: "Offer a different slot from find_slots." };
  }

  const rule = rules.find(
    (r) => r.location === slot.location && r.dayOfWeek === slot.startsAt.getUTCDay(),
  );
  const endsAt = new Date(slot.startsAt.getTime() + (rule?.slotMinutes ?? 30) * 60_000);

  const [appt] = await db()
    .insert(schema.appointments)
    .values({
      patientId,
      type: slot.type,
      location: slot.location,
      startsAt: slot.startsAt,
      endsAt,
      bookedByVapiCallId: vapiCallId,
    })
    .returning();

  const prep = getPrepScript(slot.type);
  await writeNote(
    patientId,
    vapiCallId,
    `Booked ${slot.type} at ${slot.location} for ${slot.startsAt.toISOString()} (appt ${appt.id}).`,
  );

  return {
    booked: true,
    appointmentId: appt.id,
    startsAt: slot.startsAt.toISOString(),
    location: slot.location,
    prepInstructions: prep ?? "No special preparation needed.",
    readToCaller: prep != null,
  };
};

async function locateAppointment(patientId: string, appointmentId: string | null) {
  if (appointmentId) {
    const [a] = await db()
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId))
      .limit(1);
    return a ?? null;
  }
  const [next] = await db()
    .select()
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.patientId, patientId),
        gte(schema.appointments.startsAt, new Date()),
        inArray(schema.appointments.status, ["booked", "confirmed", "rescheduled"]),
      ),
    )
    .orderBy(asc(schema.appointments.startsAt))
    .limit(1);
  return next ?? null;
}

const reschedule_appointment: Handler = async (args, vapiCallId) => {
  const patientId = str(args.patientId);
  const newSlotId = str(args.newSlotId);
  if (!patientId || !newSlotId) return { error: "patientId and newSlotId required" };

  const existing = await locateAppointment(patientId, str(args.appointmentId));
  if (!existing) return { error: "No upcoming appointment found for this patient." };

  const slot = parseSlotId(newSlotId);
  if (!slot) return { error: "Invalid newSlotId — use a slotId from find_slots" };

  const rules = await loadRules(slot.type, slot.location);
  const booked = await loadBooked(slot.type, new Date(slot.startsAt.getTime() - 24 * 3600_000));
  const validation = validateBooking(slot, rules, booked);
  if (!validation.ok) return { rescheduled: false, reason: validation.violation };

  const rule = rules.find(
    (r) => r.location === slot.location && r.dayOfWeek === slot.startsAt.getUTCDay(),
  );
  await db()
    .update(schema.appointments)
    .set({
      startsAt: slot.startsAt,
      endsAt: new Date(slot.startsAt.getTime() + (rule?.slotMinutes ?? 30) * 60_000),
      location: slot.location,
      status: "rescheduled",
    })
    .where(eq(schema.appointments.id, existing.id));

  await writeNote(
    patientId,
    vapiCallId,
    `Rescheduled appt ${existing.id} to ${slot.startsAt.toISOString()} at ${slot.location}.`,
  );
  return { rescheduled: true, appointmentId: existing.id, startsAt: slot.startsAt.toISOString() };
};

const cancel_appointment: Handler = async (args, vapiCallId) => {
  const patientId = str(args.patientId);
  if (!patientId) return { error: "patientId required" };
  const existing = await locateAppointment(patientId, str(args.appointmentId));
  if (!existing) return { error: "No upcoming appointment found for this patient." };

  await db()
    .update(schema.appointments)
    .set({ status: "cancelled" })
    .where(eq(schema.appointments.id, existing.id));

  // Cancellation feeds outbound follow-up ~1 week out (spec §3.2).
  await db().insert(schema.outboundQueue).values({
    workstream: "follow_up",
    patientId,
    authVerified: true,
    attemptCap: attemptCapFor("follow_up"),
    nextAttemptAt: new Date(Date.now() + 7 * 24 * 3600_000),
    sourceRef: `cancelled:${existing.id}`,
  });

  await writeNote(
    patientId,
    vapiCallId,
    `Cancelled appt ${existing.id} (${str(args.reason) ?? "no reason given"}). Follow-up queued ~1 week.`,
  );
  return { cancelled: true, appointmentId: existing.id, followUpQueued: true };
};

const confirm_appointment: Handler = async (args, vapiCallId) => {
  const patientId = str(args.patientId);
  const status = str(args.status);
  if (!patientId || !status || !["confirmed", "rescheduled", "cancelled"].includes(status)) {
    return { error: "patientId and status (confirmed|rescheduled|cancelled) required" };
  }
  const existing = await locateAppointment(patientId, str(args.appointmentId));
  if (!existing) return { error: "No upcoming appointment found for this patient." };

  await db()
    .update(schema.appointments)
    .set({ status: status as "confirmed" | "rescheduled" | "cancelled" })
    .where(eq(schema.appointments.id, existing.id));
  await writeNote(patientId, vapiCallId, `Confirmation callback: appt ${existing.id} → ${status}.`);
  return { updated: true, appointmentId: existing.id, status };
};

const capture_refill: Handler = async (args, vapiCallId) => {
  const patientId = str(args.patientId);
  const drug = str(args.drug);
  const pharmacy = str(args.pharmacy);
  if (!drug || !pharmacy) return { error: "drug and pharmacy required" };

  const [flag] = await db()
    .insert(schema.flags)
    .values({
      vapiCallId,
      patientId,
      reason: "refill",
      intake: { drug, pharmacy, capturedAt: new Date().toISOString() },
    })
    .returning();
  await getPorts().notify.notifyStaff({
    reason: "refill",
    routedToExt: null,
    summary: `Refill request: ${drug} → ${pharmacy}`,
    flagId: flag.id,
  });
  return {
    captured: true,
    flagId: flag.id,
    tellCaller: "The clinical team handles refills and will follow up. Do not promise the refill itself.",
  };
};

const quote_copay: Handler = async (args) => {
  const patientId = str(args.patientId);
  if (!patientId) return { error: "patientId required" };
  return { ...(await getPorts().eligibility.quoteCopay(patientId)) };
};

const classify_and_route: Handler = async (args) => {
  const topic = str(args.topic) ?? "incoming_general";
  const owner = routeTopic(topic);
  return { ext: owner.ext, ownerName: owner.ownerName, owns: owner.owns };
};

// Dynamic staff transfer (spec §3.3): route the topic, check availability, and
// execute the transfer by POSTing to the live call's control URL (Vapi dynamic
// transfer pattern). Refuses off-hours, for unavailable staff, and for calls
// with no PSTN leg (web/simulation) — the assistant then falls back to
// escalate_to_staff per its prompt.
const transfer_to_staff: Handler = async (args, vapiCallId, ctx) => {
  const topic = str(args.topic) ?? "incoming_general";
  const owner = routeTopic(topic);
  const staffRows = await db().select().from(schema.staffAvailability);
  const decision = decideHandoff(
    owner.ext,
    new Date(),
    staffRows.map((s) => ({
      ext: s.ext,
      ownerName: s.ownerName,
      phoneNumber: s.phoneNumber,
      available: s.available,
    })),
  );

  const unavailable = {
    transferred: false,
    tellCaller:
      "No staff member is reachable for a live transfer right now. Capture full intake (name, date of birth, callback number, reason, actions taken) and use escalate_to_staff. Do not mention voicemail.",
  };

  if (decision.action === "flag") return unavailable;
  const isPhoneCall = (ctx?.callType ?? "").toLowerCase().includes("phone");
  if (!isPhoneCall || !ctx?.controlUrl) return unavailable;

  try {
    const response = await fetch(ctx.controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "transfer",
        destination: {
          type: "number",
          number: decision.phoneNumber,
          extension: decision.ext,
        },
        content: `Transferring you to ${decision.ownerName} now.`,
      }),
    });
    if (!response.ok) {
      console.error(`[transfer_to_staff] control URL ${response.status}`);
      return unavailable;
    }
  } catch (err) {
    console.error("[transfer_to_staff] control URL failed", err);
    return unavailable;
  }

  await writeNote(
    null,
    vapiCallId,
    `Transferred caller to ${decision.ownerName} (ext ${decision.ext}) for ${owner.owns}.`,
  );
  return {
    transferred: true,
    ownerName: decision.ownerName,
    tellCaller: `The caller is being transferred to ${decision.ownerName} now.`,
  };
};

const escalate_to_staff: Handler = async (args, vapiCallId) => {
  const reason = str(args.reason) ?? "low_confidence";
  const intake = (args.intake ?? {}) as Record<string, unknown>;
  const routeTopicArg = str(args.routeTopic);
  const owner = routeTopicArg ? routeTopic(routeTopicArg) : null;

  const validReasons = [
    "refill",
    "signature",
    "clinical",
    "auth",
    "billing_complaint",
    "low_confidence",
    "callback",
  ] as const;
  const flagReason = (validReasons as readonly string[]).includes(reason)
    ? (reason as (typeof validReasons)[number])
    : "low_confidence";

  const [flag] = await db()
    .insert(schema.flags)
    .values({
      vapiCallId,
      patientId: str(args.patientId),
      reason: flagReason,
      intake,
      routedToExt: owner?.ext ?? null,
    })
    .returning();

  await getPorts().notify.notifyStaff({
    reason: flagReason,
    routedToExt: owner?.ext ?? null,
    summary: String(intake.reason ?? "escalation"),
    flagId: flag.id,
  });

  return {
    flagged: true,
    flagId: flag.id,
    tellCaller:
      "Someone from the team will follow up. Everything has been written down — the caller will not need to repeat the basics.",
  };
};

const flag_emergency: Handler = async (args, vapiCallId) => {
  const description = str(args.description) ?? "unspecified emergency";
  const callbackNumber = str(args.callbackNumber);

  const [flag] = await db()
    .insert(schema.flags)
    .values({
      vapiCallId,
      reason: "emergency_followup",
      intake: {
        description,
        callbackNumber,
        callerName: str(args.callerName),
        capturedAt: new Date().toISOString(),
      },
    })
    .returning();

  // Spec §3.6: emergencies page a live human even off-hours — never only a flag.
  const page = await getPorts().notify.pageHuman(
    `Caller reported: ${description}`,
    callbackNumber,
  );

  return {
    flagged: true,
    flagId: flag.id,
    humanPaged: page.paged,
    pagedVia: page.via,
    tellCaller: page.paged
      ? "Direct the caller to call 911 or go to the nearest ER immediately. Confirm the on-call team has been alerted."
      : "Direct the caller to call 911 or go to the nearest ER immediately. Do not say the on-call team was alerted; say the emergency follow-up was documented for staff.",
  };
};

export const TOOL_HANDLERS: Record<string, Handler> = {
  identify_patient,
  check_insurance,
  verify_study_auth,
  find_slots,
  book_appointment,
  reschedule_appointment,
  cancel_appointment,
  confirm_appointment,
  capture_refill,
  quote_copay,
  classify_and_route,
  transfer_to_staff,
  escalate_to_staff,
  flag_emergency,
};
