import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { CopayQuote, EligibilityPort, EligibilityResult } from "@/ports/eligibility";

export class DbStubEligibilityAdapter implements EligibilityPort {
  async checkInsurance(patientId: string): Promise<EligibilityResult> {
    const [p] = await db()
      .select()
      .from(schema.patients)
      .where(eq(schema.patients.id, patientId))
      .limit(1);
    if (!p) {
      return {
        active: false,
        isHmo: null,
        isMedicare: null,
        referralRequired: null,
        referralOnFile: null,
        verified: false,
      };
    }
    const known = p.insuranceStatus !== "unknown" && p.isHmo !== null;
    return {
      active: p.insuranceStatus === "active",
      isHmo: p.isHmo,
      isMedicare: p.isMedicare,
      // Stub heuristic: if a referral flag exists on the record, the plan
      // requires one. The eligibility partner will answer this properly.
      referralRequired: p.referralOnFile !== null ? true : null,
      referralOnFile: p.referralOnFile,
      verified: known,
    };
  }

  async quoteCopay(): Promise<CopayQuote> {
    // Real quotes arrive with the eligibility-partner integration. The agent
    // must not guess dollar amounts.
    return {
      available: false,
      message:
        "Copay information needs staff verification. Capture the request and escalate.",
    };
  }
}
