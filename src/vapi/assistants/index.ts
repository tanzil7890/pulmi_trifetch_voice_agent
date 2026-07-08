// Assistant definitions (config as code). Synced to Vapi by scripts/vapi-sync.ts.
// NOTE: compliancePlan.hipaaEnabled stays true — required posture for PHI calls.

import { inboundSystemPrompt } from "../prompts/inbound.system";
import { frontDeskSystemPrompt } from "../prompts/frontdesk.system";
import { schedulerSystemPrompt } from "../prompts/scheduler.system";
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
  key: "inbound" | "front-desk" | "scheduler" | "outbound-sleep" | "outbound-referral";
  name: string;
  firstMessage: string;
  systemPrompt: () => string;
  structuredDataSchema: typeof INBOUND_STRUCTURED_SCHEMA | typeof OUTBOUND_STRUCTURED_SCHEMA;
  summaryPrompt: string;
  firstMessageMode?: string;
  /** Subset of tool names to attach; undefined = all function tools. */
  toolNames?: string[];
  /** Outbound: detect answering machines and leave the generic no-PHI message. */
  voicemail?: boolean;
}

// Generic, PHI-free voicemail script (spec §4 voicemail rule). Vapi speaks this
// automatically when voicemailDetection fires — prompt rules stay as backup.
const GENERIC_VOICEMAIL_MESSAGE =
  "Hello, this is the scheduling team at The Pulmonology Group. Please call us back at 702-780-0300. Thank you.";

// Deepgram nova-3 keyterm boosting: domain vocabulary that STT otherwise
// mangles — provider names, sites, streets, meds, study types
// (Voice_Agent_STT_Edge_Cases.md case 10).
const TRANSCRIBER_KEYTERMS = [
  "pulmonology",
  "Sayal",
  "Przybylski",
  "Henderson",
  "Summerlin",
  "Horizon Ridge",
  "Fire Mesa",
  "Sahara",
  "Symbicort",
  "albuterol",
  "Spiriva",
  "Trelegy",
  "CPAP",
  "sleep study",
  "PFT",
  "HST",
  "PSG",
  "titration",
  "copay",
  "deductible",
  "Medicare",
  "Aetna",
  "Cigna",
];

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
  // ── Inbound squad members (spec: front-desk triage + scheduling specialist) ──
  {
    key: "front-desk",
    name: "pulm-front-desk",
    firstMessage:
      "Thank you for calling The Pulmonology Group. This call may be recorded for quality. How can I help you today?",
    systemPrompt: frontDeskSystemPrompt,
    structuredDataSchema: INBOUND_STRUCTURED_SCHEMA,
    summaryPrompt:
      "Write a memo-to-record note for the patient chart: caller identity, reason for call, actions taken on the call, and the agreed next step. 2-4 sentences, plain factual prose.",
    toolNames: [
      "identify_patient",
      "capture_refill",
      "quote_copay",
      "classify_and_route",
      "transfer_to_staff",
      "escalate_to_staff",
      "flag_emergency",
    ],
  },
  {
    key: "scheduler",
    name: "pulm-scheduler",
    firstMessage: "Hi, I'm the scheduling assistant — I can get that set up for you.",
    systemPrompt: schedulerSystemPrompt,
    structuredDataSchema: INBOUND_STRUCTURED_SCHEMA,
    summaryPrompt:
      "Write a memo-to-record note for the patient chart: caller identity, scheduling action requested, verification results, what was booked or blocked and why, and the agreed next step. 2-4 sentences, plain factual prose.",
    toolNames: [
      "identify_patient",
      "check_insurance",
      "verify_study_auth",
      "find_slots",
      "book_appointment",
      "reschedule_appointment",
      "cancel_appointment",
      "confirm_appointment",
      "escalate_to_staff",
      "flag_emergency",
    ],
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
    toolNames: [
      "identify_patient",
      "check_insurance",
      "verify_study_auth",
      "find_slots",
      "book_appointment",
      "reschedule_appointment",
      "escalate_to_staff",
      "flag_emergency",
    ],
    voicemail: true,
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
    toolNames: [
      "identify_patient",
      "check_insurance",
      "verify_study_auth",
      "find_slots",
      "book_appointment",
      "reschedule_appointment",
      "escalate_to_staff",
      "flag_emergency",
    ],
    voicemail: true,
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
    // "multi" (nova-3 multilingual) so Spanish/code-switched speech transcribes
    // as real Spanish instead of English garbage — the agent must RECOGNIZE the
    // language barrier to run the escalate-for-Spanish-assistance path.
    transcriber: {
      provider: "deepgram",
      model: "nova-3",
      language: "multi",
      keyterm: TRANSCRIBER_KEYTERMS,
    },
    compliancePlan: { hipaaEnabled: true },
    // Call quality: fast-but-smart turn taking, noise robustness, silence handling.
    startSpeakingPlan: {
      waitSeconds: 0.4,
      smartEndpointingPlan: { provider: "livekit" },
    },
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.2, backoffSeconds: 1 },
    backgroundDenoisingEnabled: true,
    silenceTimeoutSeconds: 45,
    maxDurationSeconds: 900,
    messagePlan: {
      idleMessages: ["Are you still there?", "I'm still here whenever you're ready."],
      idleTimeoutSeconds: 12,
      idleMessageMaxSpokenCount: 2,
    },
    ...(spec.voicemail
      ? {
          voicemailDetection: { provider: "google" },
          voicemailMessage: GENERIC_VOICEMAIL_MESSAGE,
        }
      : {}),
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
