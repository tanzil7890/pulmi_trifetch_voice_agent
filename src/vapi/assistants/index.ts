// Assistant definitions (config as code). Synced to Vapi by scripts/vapi-sync.ts.
// NOTE: compliancePlan.hipaaEnabled stays true — required posture for PHI calls.

import { inboundSystemPrompt } from "../prompts/inbound.system";
import { outboundReferralSystemPrompt } from "../prompts/outbound-referral.system";
import { outboundSleepSystemPrompt } from "../prompts/outbound-sleep.system";

const INBOUND_STRUCTURED_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["resolved_scheduled", "denied_closed", "vm_left", "spoke_no_appt"],
      description: "Overall call outcome per practice classification",
    },
    callType: {
      type: "string",
      enum: [
        "general_qa",
        "new_appointment",
        "reschedule",
        "cancel",
        "confirmation_callback",
        "medication_refill",
        "copay_eligibility",
        "complaint_billing",
        "other",
      ],
    },
    patientName: { type: "string" },
    dob: { type: "string" },
    callbackNumber: { type: "string" },
    escalated: { type: "boolean" },
    flagReason: { type: "string" },
  },
  required: ["outcome", "callType"],
} as const;

const OUTBOUND_STRUCTURED_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: [
        "scheduled",
        "declined",
        "dnd",
        "other_pulm",
        "deceased",
        "not_interested",
        "unreachable",
        "out_of_service",
        "no_answer",
        "vm_left",
      ],
    },
    appointmentBooked: { type: "boolean" },
    patientPreferences: { type: "string", description: "Preferred days/times if mentioned" },
  },
  required: ["outcome"],
} as const;

export interface AssistantSpec {
  key: "inbound" | "outbound-sleep" | "outbound-referral";
  name: string;
  firstMessage: string;
  systemPrompt: () => string;
  structuredDataSchema: typeof INBOUND_STRUCTURED_SCHEMA | typeof OUTBOUND_STRUCTURED_SCHEMA;
  summaryPrompt: string;
  firstMessageMode?: string;
}

export const ASSISTANT_SPECS: AssistantSpec[] = [
  {
    key: "inbound",
    name: "pulm-inbound",
    firstMessage:
      "Thank you for calling The Pulmonology Group. This call may be recorded for quality. How can I help you today?",
    systemPrompt: inboundSystemPrompt,
    structuredDataSchema: INBOUND_STRUCTURED_SCHEMA,
    summaryPrompt:
      "Write a memo-to-record note for the patient chart: caller identity, reason for call, actions taken on the call, and the agreed next step. 2-4 sentences, plain factual prose.",
  },
  {
    key: "outbound-sleep",
    name: "pulm-outbound-sleep",
    firstMessage:
      "Hello, this is the scheduling assistant calling from The Pulmonology Group. May I speak with {{patientName}}?",
    systemPrompt: outboundSleepSystemPrompt,
    structuredDataSchema: OUTBOUND_STRUCTURED_SCHEMA,
    summaryPrompt:
      "Write a memo-to-record note: outbound sleep-study scheduling attempt, who was reached, outcome, anything booked, next step.",
  },
  {
    key: "outbound-referral",
    name: "pulm-outbound-referral",
    firstMessage:
      "Hi, this is the scheduling assistant calling from The Pulmonology Group — calling you back to get you scheduled. May I speak with {{patientName}}?",
    systemPrompt: outboundReferralSystemPrompt,
    structuredDataSchema: OUTBOUND_STRUCTURED_SCHEMA,
    summaryPrompt:
      "Write a memo-to-record note: outbound referral scheduling attempt, who was reached, outcome, anything booked, next step.",
  },
];

/** Full Vapi assistant payload for create/update. */
export function buildAssistantPayload(spec: AssistantSpec, serverUrl: string, secret: string) {
  return {
    name: spec.name,
    firstMessage: spec.firstMessage,
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: spec.systemPrompt() }],
      tools: undefined as unknown, // toolIds attached by sync script
    },
    voice: { provider: "vapi", voiceId: "Elliot" },
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    compliancePlan: { hipaaEnabled: true },
    server: {
      url: serverUrl,
      timeoutSeconds: 20,
      // Legacy-style shared-secret header; harmless alongside credential auth.
      headers: { "x-vapi-secret": secret },
      backoffPlan: { type: "exponential", maxRetries: 3, baseDelaySeconds: 1 },
    },
    serverMessages: [
      "tool-calls",
      "end-of-call-report",
      "status-update",
      "transfer-destination-request",
    ],
    analysisPlan: {
      summaryPlan: { enabled: true, messages: [{ role: "system", content: spec.summaryPrompt }] },
      structuredDataPlan: {
        enabled: true,
        schema: spec.structuredDataSchema,
        messages: [
          {
            role: "system",
            content:
              "Extract the structured call data per the schema from this transcript. Classify the outcome exactly per the enum. \n\nJson Schema:\n{{schema}}\n\nOnly respond with the JSON.",
          },
          { role: "user", content: "Transcript:\n{{transcript}}" },
        ],
      },
      successEvaluationPlan: { enabled: true, rubric: "PassFail" },
    },
  };
}
